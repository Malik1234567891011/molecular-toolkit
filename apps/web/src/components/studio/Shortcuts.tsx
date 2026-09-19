'use client';
import { useEffect, useRef } from 'react';
import { useStudio, studio } from '@/lib/store';
import { bus } from '@/lib/events';
import { deleteSelection, setBondOrder, setElement } from '@/lib/edit';

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
      if (e.key === ' ') {
        e.preventDefault();
        bus.emit('fit');
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
