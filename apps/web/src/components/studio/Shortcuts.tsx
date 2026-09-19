'use client';
import { useEffect, useRef } from 'react';
import { useStudio, studio } from '@/lib/store';
import { bus } from '@/lib/events';
import * as THREE from 'three';
import { bondBetweenIds, neighbourIds, type AtomId, type MoleculeDocument } from '@orbital/chem';
import { addAtomTo, deleteSelection, setBondOrder, setElement } from '@/lib/edit';

/** Screen-space position of each atom: projected 3D coordinates in 3D, the 2D layout otherwise. */
function screenPositions(doc: MoleculeDocument, view: string): Map<AtomId, [number, number]> {
  const out = new Map<AtomId, [number, number]>();
  const cam = (window as unknown as { __orbitalCam?: { camera?: THREE.Camera } }).__orbitalCam?.camera;
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  if (view === '3d' && cam && conf) {
    const v = new THREE.Vector3();
    for (const a of doc.atoms) {
      const p = conf.coordinates[a.id];
      if (!p) continue;
      v.set(p[0], p[1], p[2]).project(cam);
      out.set(a.id, [v.x, v.y]);
    }
    if (out.size) return out;
  }
  for (const a of doc.atoms) if (doc.layout2d[a.id]) out.set(a.id, doc.layout2d[a.id] as [number, number]);
  return out;
}

/** The atom reached by pressing an arrow key from `from`: nearest in that direction, bonded neighbours preferred. */
function atomInDirection(doc: MoleculeDocument, view: string, from: AtomId, dir: [number, number]): AtomId | null {
  const pos = screenPositions(doc, view);
  const p = pos.get(from);
  if (!p) return null;
  const bonded = new Set(neighbourIds(doc, from));
  let best: AtomId | null = null;
  let bestScore = Infinity;
  for (const [id, q] of pos) {
    if (id === from) continue;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    const cos = (dx * dir[0] + dy * dir[1]) / d;
    if (cos < 0.35) continue;
    const score = (d / (cos * cos)) * (bonded.has(id) ? 0.55 : 1);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

const ARROWS: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/** Keys like Enter and the arrows belong to the canvas only when focus is on the page or the canvas. */
function canvasHasFocus(t: HTMLElement | null): boolean {
  return !t || t === document.body || !!t.closest('[data-testid=canvas-area]');
}

const SINGLE: Record<string, string> = { c: 'C', n: 'N', o: 'O', s: 'S', p: 'P', f: 'F', i: 'I' };

/** Keyboard model (spec §6): every pointer action has a keyboard equivalent. */
export function Shortcuts() {
  const pendingTwoKey = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      const s = studio();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if ((meta && e.key.toLowerCase() === 'k') || (e.key === '/' && !meta)) {
        e.preventDefault();
        useStudio.setState({ paletteOpen: true });
        return;
      }
      if (meta) return;
      if (e.key === 'Escape') {
        s.clearSelection();
        useStudio.setState({ invalid: null, paletteOpen: false });
        bus.emit('palette:close');
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === ' ' && canvasHasFocus(t)) {
        e.preventDefault();
        bus.emit('fit');
        return;
      }
      // Keyboard building (spec §15 "full keyboard build/edit path").
      if (ARROWS[e.key] && canvasHasFocus(t)) {
        e.preventDefault();
        const cur = s.selection.atoms[0] ?? (s.selection.bonds[0] ? s.doc.bonds.find((b) => b.id === s.selection.bonds[0])?.a1 : undefined);
        if (!cur) {
          if (s.doc.atoms.length) s.select([s.doc.atoms[0].id]);
          return;
        }
        const next = atomInDirection(s.doc, s.view, cur, ARROWS[e.key]);
        if (!next) return;
        if (e.shiftKey) {
          const b = bondBetweenIds(s.doc, cur, next);
          if (b) s.select([], [b.id]);
        } else s.select([next]);
        return;
      }
      if (e.key === 'Enter' && canvasHasFocus(t)) {
        e.preventDefault();
        if (!s.doc.atoms.length) {
          s.apply({ type: 'addAtom', element: s.armedElement, at: [0, 0] }, { label: `Add ${s.armedElement}`, select: 'created' });
          useStudio.setState({ landing: false });
          return;
        }
        const at = s.selection.atoms[0];
        if (at) addAtomTo(at, s.armedElement);
        else s.notify({ kind: 'info', text: 'Select an atom first (arrow keys move between atoms), then press Enter to bond a new one to it.' });
        return;
      }
      if ((e.key === '+' || e.key === '=' || e.key === '-') && s.selection.atoms.length === 1) {
        const id = s.selection.atoms[0];
        const a = s.doc.atoms.find((x) => x.id === id);
        if (a) s.apply({ type: 'setCharge', atomId: id, charge: a.formalCharge + (e.key === '-' ? -1 : 1) }, { label: 'Change charge' });
        return;
      }
      const k = e.key.toLowerCase();
      // Two-key halogens: C then l → Cl, B then r → Br.
      const pend = pendingTwoKey.current;
      if (pend && Date.now() - pend.at < 700) {
        const combo = pend.key + k;
        if (combo === 'cl' || combo === 'br') {
          pendingTwoKey.current = null;
          const el = combo === 'cl' ? 'Cl' : 'Br';
          if (s.selection.atoms.length === 1) setElement(s.selection.atoms[0], el);
          useStudio.setState({ armedElement: el });
          return;
        }
      }
      if (k === 'b') {
        pendingTwoKey.current = { key: 'b', at: Date.now() };
        if (s.view !== '3d') useStudio.setState({ tool2d: 'draw' });
        return;
      }
      if (SINGLE[k] && !e.shiftKey) {
        pendingTwoKey.current = { key: k, at: Date.now() };
        const el = SINGLE[k];
        useStudio.setState({ armedElement: el });
        if (s.selection.atoms.length === 1) setElement(s.selection.atoms[0], el);
        return;
      }
      if (k === 'h') {
        s.setSettings({ showHydrogens: !s.settings.showHydrogens });
        return;
      }
      if (k === 'm') {
        useStudio.setState({ mode3d: s.mode3d === 'measure' ? 'build' : 'measure', measure: [] });
        return;
      }
      if (['1', '2', '3'].includes(k) && s.selection.bonds.length === 1) {
        setBondOrder(s.selection.bonds[0], Number(k) as 1 | 2 | 3);
        return;
      }
      if (k === 'r') {
        useStudio.setState({ tool2d: 'ring', view: s.view === '3d' ? 'split' : s.view });
        return;
      }
      if (k === 'w' || k === 'd') {
        useStudio.setState({ tool2d: k === 'w' ? 'wedge' : 'hash', view: s.view === '3d' ? 'split' : s.view });
        return;
      }
      if (k === 'v') {
        useStudio.setState({ tool2d: 'select' });
        return;
      }
      if (k === 'e') {
        useStudio.setState({ panel: s.panel === 'explain' ? 'facts' : 'explain' });
        return;
      }
      if (k === '?') bus.emit('open:help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
