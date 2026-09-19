'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MolView, perceiveRings, stereoNeighbourList, kekulizeBonds, wouldExceedValence, bondBetweenIds,
  type AtomId, type BondId, type EditCommand, type MoleculeDocument, type Vec2,
} from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { addAtomTo, connectAtoms, cycleBondOrder, newBondAngle2D, point2D, reportInvalid, setElement } from '@/lib/edit';
import { atomColor, subColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { chainPoints, fusedRingTemplate, pendantRing, ringTemplate } from '@/lib/templates';
import { bus } from '@/lib/events';

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const SUP: Record<string, string> = { '+': '⁺', '-': '⁻', '2': '²', '3': '³' };
const TONE: Record<string, string> = { accent: '#8b7cff', amber: '#f2b34c', danger: '#ff5f6d', good: '#3ecf8e', faint: '#9aa3b2' };

interface View2D {
  scale: number;
  cx: number; // world x at view centre
  cy: number;
}

interface Drag {
  kind: 'bond' | 'chain' | 'move' | 'rect' | 'pan' | 'new';
  from?: AtomId;
  startWorld: Vec2;
  startScreen: Vec2;
  moved: boolean;
  current: Vec2;
  moveOrigin?: Record<AtomId, Vec2>;
}

function chargeText(q: number): string {
  if (!q) return '';
  const n = Math.abs(q) > 1 ? String(Math.abs(q)).split('').map((d) => SUP[d] ?? d).join('') : '';
  return n + (q > 0 ? '⁺' : '⁻');
}

export default function Canvas2D() {
  const doc = useStudio((s) => s.doc);
  const tool = useStudio((s) => s.tool2d);
  const armed = useStudio((s) => s.armedElement);
  const ringSize = useStudio((s) => s.ringSize);
  const ringAromatic = useStudio((s) => s.ringAromatic);
  const selection = useStudio((s) => s.selection);
  const hoverAtom = useStudio((s) => s.hoverAtom);
  const hoverBond = useStudio((s) => s.hoverBond);
  const highlights = useStudio((s) => s.highlights);
  const underlay = useStudio((s) => s.underlay);
  const analysis = useStudio((s) => s.analysis);
  const invalid = useStudio((s) => s.invalid);
  const showLabels = useStudio((s) => s.settings.showLabels);
  const showLonePairs = useStudio((s) => s.settings.showLonePairs);
  const cvd = useStudio((s) => s.settings.colorBlindSafe);
  const theme = useResolvedTheme();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View2D>({ scale: 40, cx: 0, cy: 0 });
  const [drag, setDragState] = useState<Drag | null>(null);
  // Pointer up can arrive before React re-renders after pointer down (fast taps, stylus, tests):
  // the handlers read the live gesture from a ref, the state only drives the preview.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const fitDone = useRef(false);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const pts = doc.atoms.map((a) => doc.layout2d[a.id]).filter(Boolean) as Vec2[];
    if (!pts.length) {
      setView((v) => ({ ...v, cx: 0, cy: 0 }));
      return;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 3;
    const h = Math.max(...ys) - Math.min(...ys) + 3;
    const scale = Math.max(18, Math.min(56, Math.min(size.w / w, size.h / h)));
    setView({ scale, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 });
  }, [doc, size]);

  useEffect(() => bus.on('fit', () => fit()), [fit]);
  useEffect(() => {
    if (!fitDone.current && doc.atoms.length && doc.atoms.every((a) => doc.layout2d[a.id])) {
      fitDone.current = true;
      fit();
    }
    if (!doc.atoms.length) fitDone.current = false;
  }, [doc, fit]);
  useEffect(() => bus.on('loaded', () => (fitDone.current = false)), []);

  const toScreen = useCallback((p: Vec2): Vec2 => [size.w / 2 + (p[0] - view.cx) * view.scale, size.h / 2 - (p[1] - view.cy) * view.scale], [size, view]);
  const toWorld = useCallback((x: number, y: number): Vec2 => [(x - size.w / 2) / view.scale + view.cx, -(y - size.h / 2) / view.scale + view.cy], [size, view]);

  const mv = useMemo(() => new MolView(doc), [doc]);
  const rings = useMemo(() => perceiveRings(mv), [mv]);
  const pos = (id: AtomId): Vec2 => (drag?.kind === 'move' && drag.moveOrigin?.[id] ? [drag.moveOrigin[id][0] + drag.current[0] - drag.startWorld[0], drag.moveOrigin[id][1] + drag.current[1] - drag.startWorld[1]] : doc.layout2d[id]) ?? [0, 0];

  const labelled = useMemo(() => {
    const out = new Map<AtomId, { text: string; hLeft: boolean; charge: string }>();
    doc.atoms.forEach((a, i) => {
      const deg = mv.nbrs[i].length;
      const show = a.element !== 'C' || a.formalCharge !== 0 || a.isotope || a.radicalElectrons || deg === 0 || showLabels;
      if (!show) return;
      const h = mv.implicitH(i);
      const p = doc.layout2d[a.id] ?? [0, 0];
      const avgDx = mv.nbrs[i].reduce((s, j) => s + ((doc.layout2d[doc.atoms[j].id]?.[0] ?? p[0]) - p[0]), 0);
      const hLeft = deg > 0 && avgDx > 0.2;
      const hText = h ? 'H' + (h > 1 ? String(h).split('').map((d) => SUB[+d]).join('') : '') : '';
      const iso = a.isotope ? String(a.isotope).split('').map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]).join('') : '';
      out.set(a.id, { text: hLeft ? `${hText}${iso}${a.element}` : `${iso}${a.element}${hText}`, hLeft, charge: chargeText(a.formalCharge) });
    });
    return out;
  }, [doc, mv, showLabels]);

  const hlAtom = useMemo(() => {
    const m = new Map<AtomId, string>();
    for (const h of Object.values(highlights)) {
      const c = h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : TONE[h.tone];
      for (const id of h.atoms) m.set(id, c);
    }
    return m;
  }, [highlights]);
  const hlBond = useMemo(() => {
    const m = new Map<BondId, string>();
    for (const h of Object.values(highlights)) {
      const c = h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : TONE[h.tone];
      for (const id of h.bonds) m.set(id, c);
    }
    return m;
  }, [highlights]);
  const badges = useMemo(() => {
    const out: Array<{ id: AtomId; text: string; color: string }> = [];
    for (const h of Object.values(highlights)) {
      if (!h.labels) continue;
      for (const [id, text] of Object.entries(h.labels)) out.push({ id, text, color: h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : h.tone === 'amber' ? '#f2b34c' : h.tone === 'faint' ? '#9aa3b2' : '#a597ff' });
    }
    return out;
  }, [highlights]);

  // --------------------------------------------------------------------------------------------
  // Hit testing (world units)
  const atomAt = (w: Vec2, radius = 0.45): AtomId | null => {
    let best: AtomId | null = null;
    let bd = radius;
    for (const a of doc.atoms) {
      const p = pos(a.id);
      const d = Math.hypot(p[0] - w[0], p[1] - w[1]);
      if (d < bd) {
        bd = d;
        best = a.id;
      }
    }
    return best;
  };
  const bondAt = (w: Vec2): BondId | null => {
    let best: BondId | null = null;
    let bd = 0.28;
    for (const b of doc.bonds) {
      const p = pos(b.a1);
      const q = pos(b.a2);
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0.15, Math.min(0.85, ((w[0] - p[0]) * dx + (w[1] - p[1]) * dy) / len2));
      const d = Math.hypot(p[0] + t * dx - w[0], p[1] + t * dy - w[1]);
      if (d < bd) {
        bd = d;
        best = b.id;
      }
    }
    return best;
  };

  // --------------------------------------------------------------------------------------------
  // Editing helpers (each is one undo step)
  const doubleBondsNear = (d: MoleculeDocument, ids: AtomId[]): BondId[] => d.bonds.filter((b) => b.order === 2 && (ids.includes(b.a1) || ids.includes(b.a2) || d.bonds.some((x) => (ids.includes(x.a1) || ids.includes(x.a2)) && (x.a1 === b.a1 || x.a2 === b.a1 || x.a1 === b.a2 || x.a2 === b.a2)))).map((b) => b.id);
  const derive = (ids: AtomId[]) => {
    const s = studio();
    const bonds = doubleBondsNear(s.doc, ids);
    if (!bonds.length) return;
    // Merge into the previous history entry so undo stays a single step.
    const before = s.past[s.past.length - 1]?.before;
    const r = s.apply({ type: 'deriveStereo2D', bondIds: bonds }, { label: 'Read E/Z from drawing' });
    if (r && before) {
      const past = studio().past;
      const merged = { ...past[past.length - 1], before, label: past[past.length - 2]?.label ?? 'Edit' };
      useStudio.setState({ past: [...past.slice(0, -2), merged] });
    }
  };

  const placeRing = (w: Vec2, onAtom: AtomId | null, onBond: BondId | null, spiro: boolean) => {
    const s = studio();
    let cmd: EditCommand;
    if (onBond) {
      const b = s.doc.bonds.find((x) => x.id === onBond)!;
      const p1 = pos(b.a1);
      const p2 = pos(b.a2);
      const nbrs = [...mv.nbrs[mv.idx(b.a1)], ...mv.nbrs[mv.idx(b.a2)]].map((j) => doc.atoms[j].id).filter((x) => x !== b.a1 && x !== b.a2);
      const away = nbrs.length ? nbrs.map(pos).reduce<Vec2>((acc, p) => [acc[0] + p[0] / nbrs.length, acc[1] + p[1] / nbrs.length], [0, 0]) : undefined;
      const { doc: frag, shared } = fusedRingTemplate(ringSize, ringAromatic, p1, p2, away);
      cmd = { type: 'addFragment', fragment: frag, fuse: { existing: [b.a1, b.a2], fragment: shared } };
    } else if (onAtom && spiro) {
      const angle = newBondAngle2D(s.doc, onAtom);
      const p = pos(onAtom);
      const r = 1.5 / (2 * Math.sin(Math.PI / ringSize));
      const center: Vec2 = [p[0] + Math.cos(angle) * r, p[1] + Math.sin(angle) * r];
      const frag = ringTemplate(ringSize, ringAromatic, center, angle + Math.PI);
      cmd = { type: 'addFragment', fragment: frag, fuse: { existing: [onAtom], fragment: [frag.atoms[0].id] } };
    } else if (onAtom) {
      if (wouldExceedValence(s.doc, onAtom, 1).exceeds) {
        const chk = wouldExceedValence(s.doc, onAtom, 1);
        reportInvalid(onAtom, chk.title, chk.message);
        return;
      }
      const frag = pendantRing(ringSize, ringAromatic, pos(onAtom), newBondAngle2D(s.doc, onAtom));
      cmd = { type: 'addFragment', fragment: frag, bondFrom: { atomId: onAtom, fragmentAtomId: frag.atoms[0].id, order: 1 } };
    } else {
      cmd = { type: 'addFragment', fragment: ringTemplate(ringSize, ringAromatic, w) };
    }
    const next = s.apply(cmd, { label: `Add ${ringAromatic && ringSize === 6 ? 'benzene ring' : `${ringSize}-ring`}` });
    if (next && ringAromatic && onBond) {
      // Re-kekulize the fused aromatic system so no carbon ends up with five bonds.
      const ringBonds = perceiveRings(new MolView(next)).rings.filter((r) => r.atoms.length === 6).flatMap((r) => r.bonds.map((bi) => next.bonds[bi]));
      const aromaticIds = ringBonds.filter((b) => b.aromatic || next.bonds.some((x) => x.id === b.id)).map((b) => b.id);
      const fixed = kekulizeBonds(next, [...new Set(aromaticIds)].filter((id) => {
        const b = next.bonds.find((x) => x.id === id)!;
        return next.atoms.find((a) => a.id === b.a1)?.element === 'C' && next.atoms.find((a) => a.id === b.a2)?.element === 'C';
      }));
      const bad = next.atoms.some((_, i) => new MolView(next).bondOrderSum(i) > 4);
      if (fixed && bad) useStudio.setState({ doc: fixed, version: studio().version + 1 });
    }
  };

  const addChain = (from: AtomId | null, start: Vec2, end: Vec2) => {
    const s = studio();
    const dist = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const n = Math.max(1, Math.min(12, Math.round(dist / 1.3)));
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const pts = chainPoints(start, angle, n);
    const cmds: EditCommand[] = [];
    let nextId = s.doc.nextAtom;
    let prev: AtomId | null = from;
    if (!from) {
      cmds.push({ type: 'addAtom', element: 'C', at: start });
      prev = `a${nextId++}`;
    } else if (wouldExceedValence(s.doc, from, 1).exceeds) {
      const chk = wouldExceedValence(s.doc, from, 1);
      reportInvalid(from, chk.title, chk.message);
      return;
    }
    for (const p of pts) {
      cmds.push({ type: 'addAtom', element: 'C', at: p, bondTo: { atomId: prev!, order: 1 } });
      prev = `a${nextId++}`;
    }
    s.apply({ type: 'batch', commands: cmds, label: `Add ${n}-carbon chain` }, { select: 'none' });
  };

  const setWedge = (bondId: BondId, kind: 'up' | 'down' | 'either', near: Vec2) => {
    const s = studio();
    const b = s.doc.bonds.find((x) => x.id === bondId)!;
    if (b.order !== 1) {
      s.notify({ kind: 'info', text: 'Only single bonds can be drawn as wedges or hashes.' });
      return;
    }
    const isCentre = (id: AtomId) => !!stereoNeighbourList(mv, mv.idx(id));
    const d1 = Math.hypot(pos(b.a1)[0] - near[0], pos(b.a1)[1] - near[1]);
    const d2 = Math.hypot(pos(b.a2)[0] - near[0], pos(b.a2)[1] - near[1]);
    let from = isCentre(b.a1) && !isCentre(b.a2) ? b.a1 : isCentre(b.a2) && !isCentre(b.a1) ? b.a2 : d1 <= d2 ? b.a1 : b.a2;
    if (b.wedge === kind && b.a1 === from) from = from === b.a1 ? b.a2 : b.a1; // second click flips direction
    s.apply({ type: 'setWedge', bondId, from, wedge: b.wedge === kind && b.a1 !== from && !isCentre(from) ? null : kind });
  };

  // --------------------------------------------------------------------------------------------
  // Pointer handling
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    // Once the student is drawing, never re-fit under their cursor (loads still fit).
    fitDone.current = true;
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = toWorld(sx, sy);
    const atom = atomAt(w);
    const bond = atom ? null : bondAt(w);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    bus.emit('palette:close');
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setDrag({ kind: 'pan', startWorld: w, startScreen: [sx, sy], moved: false, current: w });
      return;
    }
    const s = studio();
    if (tool === 'select') {
      if (atom) {
        if (e.shiftKey) s.select([atom], [], true);
        else if (!s.selection.atoms.includes(atom)) s.select([atom]);
        const moving = s.selection.atoms.includes(atom) || !e.shiftKey ? (studio().selection.atoms.length ? studio().selection.atoms : [atom]) : [atom];
        const origin: Record<AtomId, Vec2> = {};
        for (const id of moving) origin[id] = doc.layout2d[id] ?? [0, 0];
        setDrag({ kind: 'move', from: atom, startWorld: w, startScreen: [sx, sy], moved: false, current: w, moveOrigin: origin });
      } else if (bond) {
        s.select([], [bond], e.shiftKey);
      } else setDrag({ kind: 'rect', startWorld: w, startScreen: [sx, sy], moved: false, current: w });
      return;
    }
    if (tool === 'erase') {
      if (atom) s.apply({ type: 'removeAtoms', atomIds: [atom] }, { select: 'none' });
      else if (bond) s.apply({ type: 'removeBonds', bondIds: [bond] }, { select: 'none' });
      return;
    }
    if (tool === 'charge+' || tool === 'charge-') {
      if (atom) {
        const a = doc.atoms.find((x) => x.id === atom)!;
        s.apply({ type: 'setCharge', atomId: atom, charge: a.formalCharge + (tool === 'charge+' ? 1 : -1) });
      }
      return;
    }
    if (tool === 'wedge' || tool === 'hash' || tool === 'wavy') {
      if (bond) setWedge(bond, tool === 'wedge' ? 'up' : tool === 'hash' ? 'down' : 'either', w);
      return;
    }
    if (tool === 'ring') {
      placeRing(w, atom, bond, e.shiftKey);
      return;
    }
    if (tool === 'chain') {
      setDrag({ kind: 'chain', from: atom ?? undefined, startWorld: atom ? pos(atom) : w, startScreen: [sx, sy], moved: false, current: w });
      return;
    }
    // draw
    if (bond && !atom) {
      cycleBondOrder(bond);
      derive([doc.bonds.find((b) => b.id === bond)!.a1]);
      return;
    }
    setDrag({ kind: atom ? 'bond' : 'new', from: atom ?? undefined, startWorld: atom ? pos(atom) : w, startScreen: [sx, sy], moved: false, current: w });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const w = toWorld(sx, sy);
    const drag = dragRef.current;
    if (!drag) {
      const a = atomAt(w);
      const b = a ? null : bondAt(w);
      const s = studio();
      if (s.hoverAtom !== a || s.hoverBond !== b) s.setHover(a, b);
      return;
    }
    const moved = drag.moved || Math.hypot(sx - drag.startScreen[0], sy - drag.startScreen[1]) > 5;
    if (drag.kind === 'pan') {
      setView((v) => ({ ...v, cx: v.cx - (w[0] - drag.startWorld[0]), cy: v.cy - (w[1] - drag.startWorld[1]) }));
      return;
    }
    setDrag({ ...drag, moved, current: w });
    const a = atomAt(w);
    if (studio().hoverAtom !== a) studio().setHover(a, null);
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    const s = studio();
    const w = d.current;
    const target = atomAt(w);
    if (d.kind === 'move') {
      if (d.moved && d.moveOrigin) {
        const positions: Record<AtomId, Vec2> = {};
        for (const [id, p] of Object.entries(d.moveOrigin)) positions[id] = [p[0] + w[0] - d.startWorld[0], p[1] + w[1] - d.startWorld[1]];
        s.apply({ type: 'moveAtoms2D', positions }, { label: 'Move' });
      }
      return;
    }
    if (d.kind === 'rect') {
      if (!d.moved) {
        s.clearSelection();
        return;
      }
      const [x1, x2] = [Math.min(d.startWorld[0], w[0]), Math.max(d.startWorld[0], w[0])];
      const [y1, y2] = [Math.min(d.startWorld[1], w[1]), Math.max(d.startWorld[1], w[1])];
      const atoms = doc.atoms.filter((a) => {
        const p = pos(a.id);
        return p[0] >= x1 && p[0] <= x2 && p[1] >= y1 && p[1] <= y2;
      }).map((a) => a.id);
      const bonds = doc.bonds.filter((b) => atoms.includes(b.a1) && atoms.includes(b.a2)).map((b) => b.id);
      s.select(atoms, bonds);
      return;
    }
    if (d.kind === 'chain') {
      if (d.moved) addChain(d.from ?? null, d.startWorld, w);
      else if (d.from) addAtomTo(d.from, 'C', 1);
      return;
    }
    if (d.kind === 'new') {
      if (!doc.atoms.length || !d.moved) {
        const next = s.apply({ type: 'addAtom', element: armed, at: d.startWorld }, { label: `Add ${armed}`, select: 'created' });
        if (next && d.moved) {
          const id = next.atoms[next.atoms.length - 1].id;
          addAtomTo(id, 'C', 1, { angle2d: snapAngle(d.startWorld, w) });
        }
        return;
      }
      const next = s.apply({ type: 'addAtom', element: armed, at: d.startWorld }, { label: `Add ${armed}`, select: 'created' });
      if (next) addAtomTo(next.atoms[next.atoms.length - 1].id, 'C', 1, { angle2d: snapAngle(d.startWorld, w) });
      return;
    }
    if (d.kind === 'bond' && d.from) {
      if (!d.moved) {
        const a = doc.atoms.find((x) => x.id === d.from)!;
        if (a.element !== armed) {
          setElement(d.from, armed);
        } else {
          const id = addAtomTo(d.from, 'C', 1);
          if (id) derive([d.from, id]);
        }
        return;
      }
      if (target && target !== d.from) {
        const existing = bondBetweenIds(doc, d.from, target);
        if (existing) cycleBondOrder(existing.id);
        else connectAtoms(d.from, target, 1);
        derive([d.from, target]);
        return;
      }
      const id = addAtomTo(d.from, armed === 'H' ? 'C' : armed, 1, { angle2d: snapAngle(d.startWorld, w) });
      if (id) derive([d.from, id]);
    }
  };

  const snapAngle = (from: Vec2, to: Vec2) => {
    const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const step = Math.PI / 6;
    return Math.round(a / step) * step;
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = toWorld(sx, sy);
    const k = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const scale = Math.max(10, Math.min(120, v.scale * k));
      const cx = before[0] - (sx - size.w / 2) / scale;
      const cy = before[1] + (sy - size.h / 2) / scale;
      return { scale, cx, cy };
    });
  };

  // --------------------------------------------------------------------------------------------
  // Render
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const bg = theme === 'dark' ? '#0f131b' : '#f7f5f0';
  const sel = new Set(selection.atoms);
  const selB = new Set(selection.bonds);
  const lw = Math.max(1.3, view.scale * 0.045);

  const bondEls = doc.bonds.map((b) => {
    let p = toScreen(pos(b.a1));
    let q = toScreen(pos(b.a2));
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const shrink = view.scale * 0.34;
    if (labelled.has(b.a1)) p = [p[0] + ux * shrink, p[1] + uy * shrink];
    if (labelled.has(b.a2)) q = [q[0] - ux * shrink, q[1] - uy * shrink];
    const color = hlBond.get(b.id) ?? ink;
    const parts: React.ReactNode[] = [];
    const glow = selB.has(b.id) || hoverBond === b.id;
    if (glow) parts.push(<line key="g" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#8b7cff" strokeOpacity={selB.has(b.id) ? 0.45 : 0.25} strokeWidth={lw * 5} strokeLinecap="round" />);
    if (hlBond.has(b.id)) parts.push(<line key="h" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={hlBond.get(b.id)} strokeOpacity={0.3} strokeWidth={lw * 6} strokeLinecap="round" />);
    if (b.order === 1 && b.wedge === 'up') {
      const w = view.scale * 0.13;
      parts.push(<polygon key="w" points={`${p[0]},${p[1]} ${q[0] + nx * w},${q[1] + ny * w} ${q[0] - nx * w},${q[1] - ny * w}`} fill={color} />);
    } else if (b.order === 1 && b.wedge === 'down') {
      const n = 7;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const w = view.scale * 0.13 * t;
        const x = p[0] + (q[0] - p[0]) * t;
        const y = p[1] + (q[1] - p[1]) * t;
        parts.push(<line key={`h${k}`} x1={x + nx * w} y1={y + ny * w} x2={x - nx * w} y2={y - ny * w} stroke={color} strokeWidth={lw * 0.9} />);
      }
    } else if (b.order === 1 && b.wedge === 'either') {
      const n = 8;
      let d = `M ${p[0]} ${p[1]}`;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const amp = (k % 2 ? 1 : -1) * view.scale * 0.08;
        d += ` Q ${p[0] + (q[0] - p[0]) * (t - 0.5 / n) + nx * amp} ${p[1] + (q[1] - p[1]) * (t - 0.5 / n) + ny * amp} ${p[0] + (q[0] - p[0]) * t} ${p[1] + (q[1] - p[1]) * t}`;
      }
      parts.push(<path key="wv" d={d} fill="none" stroke={color} strokeWidth={lw} />);
    } else if (b.order === 1) {
      parts.push(<line key="s" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
    } else if (b.order === 2) {
      const bi = mv.bondIndex.get(b.id)!;
      const ringIdx = rings.bondRings[bi]?.[0];
      const off = view.scale * 0.18;
      if (ringIdx !== undefined) {
        const r = rings.rings[ringIdx];
        const c = r.atoms.map((i) => toScreen(pos(doc.atoms[i].id))).reduce<Vec2>((acc, x) => [acc[0] + x[0] / r.atoms.length, acc[1] + x[1] / r.atoms.length], [0, 0]);
        const side = (c[0] - p[0]) * nx + (c[1] - p[1]) * ny > 0 ? 1 : -1;
        const trim = 0.14 * len;
        parts.push(<line key="d1" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
        parts.push(<line key="d2" x1={p[0] + nx * off * side + ux * trim} y1={p[1] + ny * off * side + uy * trim} x2={q[0] + nx * off * side - ux * trim} y2={q[1] + ny * off * side - uy * trim} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
      } else {
        parts.push(<line key="d1" x1={p[0] + (nx * off) / 2} y1={p[1] + (ny * off) / 2} x2={q[0] + (nx * off) / 2} y2={q[1] + (ny * off) / 2} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
        parts.push(<line key="d2" x1={p[0] - (nx * off) / 2} y1={p[1] - (ny * off) / 2} x2={q[0] - (nx * off) / 2} y2={q[1] - (ny * off) / 2} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
      }
    } else {
      const off = view.scale * 0.17;
      for (const k of [-1, 0, 1]) parts.push(<line key={`t${k}`} x1={p[0] + nx * off * k} y1={p[1] + ny * off * k} x2={q[0] + nx * off * k} y2={q[1] + ny * off * k} stroke={color} strokeWidth={lw} strokeLinecap="round" />);
    }
    return <g key={b.id} data-bond={b.id}>{parts}</g>;
  });

  const fontSize = Math.max(10, view.scale * 0.42);
  const atomEls = doc.atoms.map((a) => {
    const p = toScreen(pos(a.id));
    const lab = labelled.get(a.id);
    const hl = hlAtom.get(a.id);
    const r = view.scale * 0.36;
    return (
      <g key={a.id} data-atom={a.id}>
        {hl && <circle cx={p[0]} cy={p[1]} r={r * 1.25} fill={hl} fillOpacity={0.28} />}
        {sel.has(a.id) && <circle cx={p[0]} cy={p[1]} r={r * 1.1} fill="#8b7cff" fillOpacity={0.22} stroke="#8b7cff" strokeWidth={1.5} />}
        {hoverAtom === a.id && !sel.has(a.id) && <circle cx={p[0]} cy={p[1]} r={r} fill="#8b7cff" fillOpacity={0.12} />}
        {invalid?.atomId === a.id && <circle cx={p[0]} cy={p[1]} r={r * 1.2} fill="none" stroke="#ff5f6d" strokeWidth={2.2} />}
        {lab && (
          <>
            <circle cx={p[0]} cy={p[1]} r={fontSize * 0.62} fill={bg} />
            <text x={p[0]} y={p[1]} textAnchor="middle" dominantBaseline="central" fontSize={fontSize} fontWeight={600} fill={a.element === 'C' ? ink : atomColor(a.element, theme, cvd)} style={{ fontFamily: 'var(--font-geist)' }}>
              {lab.hLeft ? (
                <tspan dx={-fontSize * 0.3 * (lab.text.length - 1)}>{lab.text}</tspan>
              ) : (
                <tspan dx={fontSize * 0.3 * (lab.text.length - a.element.length)}>{lab.text}</tspan>
              )}
              {lab.charge && <tspan dy={-fontSize * 0.45} fontSize={fontSize * 0.7}>{lab.charge}</tspan>}
            </text>
          </>
        )}
        {!lab && a.formalCharge !== 0 && <text x={p[0] + fontSize * 0.5} y={p[1] - fontSize * 0.5} fontSize={fontSize * 0.7} fill={ink}>{chargeText(a.formalCharge)}</text>}
        {showLonePairs && lab && analysis?.geometry[a.id]?.lonePairs ? <LonePairs p={p} n={analysis.geometry[a.id].lonePairs} r={fontSize * 0.95} color={ink} /> : null}
      </g>
    );
  });

  const cipEls = analysis?.stereo.centres.filter((c) => c.descriptor).map((c) => {
    const p = toScreen(pos(c.atomId));
    return (
      <text key={`cip-${c.atomId}`} x={p[0] + view.scale * 0.3} y={p[1] + view.scale * 0.55} fontSize={Math.max(10, view.scale * 0.3)} fontStyle="italic" fontWeight={700} fill="#a597ff">
        ({c.descriptor})
      </text>
    );
  });

  let preview: React.ReactNode = null;
  if (drag && drag.moved && (drag.kind === 'bond' || drag.kind === 'new')) {
    const tgt = atomAt(drag.current);
    const from = drag.startWorld;
    const end = tgt && tgt !== drag.from ? pos(tgt) : point2D({ ...doc, layout2d: { ...doc.layout2d, __p: from } }, '__p', snapAngle(from, drag.current));
    const a = toScreen(from);
    const b = toScreen(end);
    preview = <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#8b7cff" strokeWidth={lw * 1.4} strokeDasharray="5 4" strokeLinecap="round" />;
  } else if (drag && drag.moved && drag.kind === 'chain') {
    const dist = Math.hypot(drag.current[0] - drag.startWorld[0], drag.current[1] - drag.startWorld[1]);
    const n = Math.max(1, Math.min(12, Math.round(dist / 1.3)));
    const pts = [drag.startWorld, ...chainPoints(drag.startWorld, Math.atan2(drag.current[1] - drag.startWorld[1], drag.current[0] - drag.startWorld[0]), n)].map(toScreen);
    const last = pts[pts.length - 1];
    preview = (
      <g>
        <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#8b7cff" strokeWidth={lw * 1.3} strokeDasharray="5 4" />
        <text x={last[0] + 10} y={last[1] - 10} fontSize={12} fill="#a597ff">{n} C</text>
      </g>
    );
  } else if (drag && drag.moved && drag.kind === 'rect') {
    const a = toScreen(drag.startWorld);
    const b = toScreen(drag.current);
    preview = <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(a[0] - b[0])} height={Math.abs(a[1] - b[1])} fill="#8b7cff" fillOpacity={0.08} stroke="#8b7cff" strokeDasharray="4 3" />;
  }

  const ghost = invalid?.atomId && doc.layout2d[invalid.atomId] ? (() => {
    const p = toScreen(pos(invalid.atomId));
    const ang = newBondAngle2D(doc, invalid.atomId);
    const q: Vec2 = [p[0] + Math.cos(ang) * view.scale * 1.5, p[1] - Math.sin(ang) * view.scale * 1.5];
    return (
      <g>
        <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#ff5f6d" strokeWidth={lw * 1.3} strokeDasharray="4 4" />
        <circle cx={q[0]} cy={q[1]} r={view.scale * 0.22} fill="#ff5f6d" fillOpacity={0.25} stroke="#ff5f6d" strokeDasharray="3 3" />
      </g>
    );
  })() : null;

  return (
    <div className="relative h-full w-full" data-testid="canvas-2d">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        className="block touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => studio().setHover(null, null)}
        onWheel={onWheel}
        role="application"
        aria-label="2D structure editor"
        style={{ cursor: tool === 'select' ? 'default' : tool === 'erase' ? 'not-allowed' : 'crosshair' }}
      >
        <defs>
          <pattern id="grid2d" width={view.scale * 1.5} height={view.scale * 1.5} patternUnits="userSpaceOnUse" x={(size.w / 2 - view.cx * view.scale) % (view.scale * 1.5)} y={(size.h / 2 + view.cy * view.scale) % (view.scale * 1.5)}>
            <circle cx={0} cy={0} r={0.9} fill="var(--grid-line)" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#grid2d)" />
        {underlay && (() => {
          const tl = toScreen([underlay.x, underlay.y + underlay.h]);
          return <image href={underlay.url} x={tl[0]} y={tl[1]} width={underlay.w * view.scale} height={underlay.h * view.scale} opacity={underlay.opacity} preserveAspectRatio="none" pointerEvents="none" data-testid="underlay" />;
        })()}
        {bondEls}
        {preview}
        {ghost}
        {atomEls}
        {cipEls}
        {badges.map((bd) => {
          const p = toScreen(pos(bd.id));
          return (
            <g key={`b-${bd.id}-${bd.text}`} transform={`translate(${p[0] - view.scale * 0.42},${p[1] - view.scale * 0.52})`}>
              <circle r={9} fill={bd.color} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={700} fill="#0b0e14">{bd.text}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LonePairs({ p, n, r, color }: { p: Vec2; n: number; r: number; color: string }) {
  const angles = n === 1 ? [90] : n === 2 ? [90, 270] : [90, 210, 330];
  return (
    <g>
      {angles.map((a) => {
        const rad = (a * Math.PI) / 180;
        const cx = p[0] + Math.cos(rad) * r;
        const cy = p[1] - Math.sin(rad) * r;
        const tx = -Math.sin(rad) * 3;
        const ty = -Math.cos(rad) * 3;
        return (
          <g key={a}>
            <circle cx={cx + tx} cy={cy + ty} r={1.6} fill={color} />
            <circle cx={cx - tx} cy={cy - ty} r={1.6} fill={color} />
          </g>
        );
      })}
    </g>
  );
}
