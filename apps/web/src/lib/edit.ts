'use client';
/**
 * Valence-aware editing shared by the 2D editor, the 3D kit canvas, the keyboard and the tutor.
 * Impossible actions never throw a generic error: they leave a ghost at the boundary, ring the
 * saturated atom and explain in the inspector (spec §7 "Invalid-action behavior").
 */
import {
  MolView, allowedValences, bondBetweenIds, explainValence, wouldExceedValence, bondLength, v3,
  type AtomId, type BondId, type BondOrder, type MoleculeDocument, type Vec2, type Vec3,
} from '@orbital/chem';
import { track } from './analytics';
import { haptic } from './events';
import { studio, useStudio } from './store';

const BOND2D = 1.5;

/** Direction (radians) for a new 2D neighbour of `atomId`, continuing zig-zags and filling gaps. */
export function newBondAngle2D(doc: MoleculeDocument, atomId: AtomId, prefer?: number): number {
  const p = doc.layout2d[atomId];
  if (!p) return Math.PI / 6;
  const nbrs = doc.bonds.filter((b) => b.a1 === atomId || b.a2 === atomId).map((b) => (b.a1 === atomId ? b.a2 : b.a1));
  const angles = nbrs.map((n) => doc.layout2d[n]).filter(Boolean).map((q) => Math.atan2(q![1] - p[1], q![0] - p[0]));
  if (prefer !== undefined) {
    // Snap a drag direction to 30° steps (120° / 109.5° / 180° families are all multiples).
    const step = Math.PI / 6;
    return Math.round(prefer / step) * step;
  }
  if (!angles.length) return Math.PI / 6;
  if (angles.length === 1) {
    // Zig-zag: go 120° away from the existing bond, on the side that keeps the chain alternating.
    const a = angles[0];
    const n = nbrs[0];
    const nn = doc.bonds.filter((b) => (b.a1 === n || b.a2 === n) && b.a1 !== atomId && b.a2 !== atomId).map((b) => (b.a1 === n ? b.a2 : b.a1));
    const q = doc.layout2d[n];
    const r = nn.length && doc.layout2d[nn[0]] ? doc.layout2d[nn[0]] : undefined;
    const tripleLike = doc.bonds.some((b) => (b.a1 === atomId || b.a2 === atomId) && b.order === 3);
    if (tripleLike) return a + Math.PI;
    let turn = (2 * Math.PI) / 3;
    if (q && r) {
      const cross = (q[0] - r[0]) * (p[1] - q[1]) - (q[1] - r[1]) * (p[0] - q[0]);
      turn = cross > 0 ? -(2 * Math.PI) / 3 : (2 * Math.PI) / 3;
    }
    return a + turn;
  }
  // Largest angular gap.
  const sorted = [...angles].sort((x, y) => x - y);
  let best = 0;
  let bestGap = -1;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 2 * Math.PI;
    if (b - a > bestGap) {
      bestGap = b - a;
      best = a + (b - a) / 2;
    }
  }
  return best;
}

export function point2D(doc: MoleculeDocument, from: AtomId, angle: number, length = BOND2D): Vec2 {
  const p = doc.layout2d[from] ?? [0, 0];
  return [p[0] + Math.cos(angle) * length, p[1] + Math.sin(angle) * length];
}

function currentCoords(doc: MoleculeDocument): Record<string, Vec3> {
  const c = doc.conformers.find((x) => x.id === doc.selectedConformerId) ?? doc.conformers[0];
  return c?.coordinates ?? {};
}

export function reportInvalid(atomId: AtomId, title: string, message: string, ghostTo?: Vec3, extraFixes: Array<{ label: string; run: () => void }> = []) {
  const s = studio();
  const view = new MolView(s.doc);
  const a = s.doc.atoms.find((x) => x.id === atomId);
  const fixes = [...extraFixes];
  if (a && a.formalCharge === 0 && (a.element === 'N' || a.element === 'O')) {
    const vals = allowedValences(a.element, 1);
    if (vals && view.bondOrderSum(view.idx(atomId)) < Math.max(...vals)) {
      fixes.push({ label: `Make it ${a.element}⁺ (${a.element === 'O' ? 'oxonium' : 'ammonium'})`, run: () => studio().apply({ type: 'setCharge', atomId, charge: 1 }) });
    }
  }
  useStudio.setState({ invalid: { atomId, title, message, fixes, ghostTo, at: Date.now() }, panel: 'facts' });
  haptic('boundary');
  track('invalid_edit_attempted', { element: a?.element ?? '?' });
}

/** Add a new atom bonded to `parent`. 3D goes to the given port (or the first free one). */
export function addAtomTo(parent: AtomId, element: string, order: BondOrder = 1, opts: { portKey?: string; angle2d?: number; direction3d?: Vec3 } = {}): AtomId | null {
  const s = studio();
  const doc = s.doc;
  const check = wouldExceedValence(doc, parent, order);
  const coords = currentCoords(doc);
  if (check.exceeds || (check.hypervalentOnly && !['S', 'P', 'Se', 'I', 'Cl', 'Br'].includes(doc.atoms.find((a) => a.id === parent)!.element))) {
    const pp = coords[parent];
    const ghost: Vec3 | undefined = pp ? v3.add(pp, v3.scale(opts.direction3d ? v3.norm(opts.direction3d) : [1, 0.6, 0.2], 1.5)) : undefined;
    reportInvalid(parent, check.title, check.message, ghost);
    return null;
  }
  const newEl = element;
  const newCheckVals = allowedValences(newEl, 0);
  if (newCheckVals && order > Math.max(...newCheckVals)) {
    reportInvalid(parent, `${newEl} cannot form a ${order === 3 ? 'triple' : 'double'} bond`, explainValence(newEl, 0, order).message);
    return null;
  }
  const angle = opts.angle2d ?? newBondAngle2D(doc, parent);
  const at = point2D(doc, parent, angle);
  let at3d: Vec3 | undefined;
  const pp = coords[parent];
  if (pp) {
    let dir = opts.direction3d;
    if (!dir && opts.portKey && coords[opts.portKey]) dir = v3.sub(coords[opts.portKey], pp);
    if (!dir) {
      const firstH = [1, 2, 3, 4].map((k) => coords[`${parent}.h${k}`]).find(Boolean);
      if (firstH) dir = v3.sub(firstH, pp);
    }
    if (dir) at3d = v3.add(pp, v3.scale(v3.norm(dir), bondLength(doc.atoms.find((a) => a.id === parent)!.element, newEl, order)));
  }
  const next = s.apply({ type: 'addAtom', element: newEl, at, at3d, bondTo: { atomId: parent, order } }, { label: `Add ${newEl}`, select: 'created' });
  if (!next) return null;
  haptic('snap');
  track('atom_added', { element: newEl });
  return next.atoms[next.atoms.length - 1].id;
}

/** Bond two existing atoms (ring closure / connection) with valence checks. */
export function connectAtoms(a: AtomId, b: AtomId, order: BondOrder = 1): boolean {
  const s = studio();
  if (a === b) return false;
  const existing = bondBetweenIds(s.doc, a, b);
  if (existing) return cycleBondOrder(existing.id);
  for (const x of [a, b]) {
    const check = wouldExceedValence(s.doc, x, order);
    if (check.exceeds || (check.hypervalentOnly && !['S', 'P'].includes(s.doc.atoms.find((q) => q.id === x)!.element))) {
      const coords = currentCoords(s.doc);
      reportInvalid(x, check.title, check.message, coords[x === a ? b : a]);
      return false;
    }
  }
  const r = s.apply({ type: 'addBond', a1: a, a2: b, order }, { label: 'Connect atoms' });
  if (r) {
    haptic('snap');
    track('bond_changed', { kind: 'connect' });
  }
  return !!r;
}

/** Next bond order that is compatible with both atoms' valence (spec §7 bond editing). */
export function cycleBondOrder(bondId: BondId): boolean {
  const s = studio();
  const b = s.doc.bonds.find((x) => x.id === bondId);
  if (!b) return false;
  for (const step of [1, 2]) {
    const next = (((b.order - 1 + step) % 3) + 1) as BondOrder;
    const delta = next - b.order;
    if (delta <= 0) return setBondOrder(bondId, next);
    const ok = [b.a1, b.a2].every((x) => !wouldExceedValence(s.doc, x, delta).exceeds && !wouldExceedValence(s.doc, x, delta).hypervalentOnly);
    if (ok) return setBondOrder(bondId, next);
  }
  return setBondOrder(bondId, 1);
}

export function setBondOrder(bondId: BondId, order: BondOrder): boolean {
  const s = studio();
  const b = s.doc.bonds.find((x) => x.id === bondId);
  if (!b || b.order === order) return false;
  const delta = order - b.order;
  if (delta > 0) {
    for (const x of [b.a1, b.a2]) {
      const check = wouldExceedValence(s.doc, x, delta);
      if (check.exceeds || (check.hypervalentOnly && !['S', 'P'].includes(s.doc.atoms.find((q) => q.id === x)!.element))) {
        reportInvalid(x, check.title, check.message);
        return false;
      }
    }
  }
  const r = s.apply({ type: 'setBondOrder', bondId, order });
  if (r) track('bond_changed', { order });
  return !!r;
}

export function setElement(atomId: AtomId, element: string): boolean {
  const s = studio();
  const view = new MolView(s.doc);
  const i = view.idx(atomId);
  const a = s.doc.atoms[i];
  if (a.element === element) return false;
  const vals = allowedValences(element, a.formalCharge);
  const used = view.bondOrderSum(i);
  if (vals && used > Math.max(...vals)) {
    const e = explainValence(element, a.formalCharge, used);
    reportInvalid(atomId, `${element} cannot replace this atom`, `This atom has ${used} bonds. ${e.message}`);
    return false;
  }
  return !!s.apply({ type: 'setElement', atomId, element });
}

export function deleteSelection(): void {
  const s = studio();
  const { atoms, bonds } = s.selection;
  if (atoms.length) s.apply({ type: 'removeAtoms', atomIds: atoms }, { select: 'none' });
  else if (bonds.length) s.apply({ type: 'removeBonds', bondIds: bonds }, { select: 'none' });
}

/** Attach a fragment (SMILES) to an atom — used by the tutor and the fragment rail. */
export async function attachSmiles(atomId: AtomId, smiles: string): Promise<boolean> {
  const { parseSmiles } = await import('@orbital/chem');
  const s = studio();
  const frag = parseSmiles(smiles).doc;
  const check = wouldExceedValence(s.doc, atomId, 1);
  if (check.exceeds) {
    reportInvalid(atomId, check.title, check.message);
    return false;
  }
  const angle = newBondAngle2D(s.doc, atomId);
  const base = point2D(s.doc, atomId, angle);
  // Lay the fragment out along the bond direction.
  frag.atoms.forEach((a, k) => (frag.layout2d[a.id] = [base[0] + Math.cos(angle) * 1.5 * k, base[1] + Math.sin(angle) * 1.5 * k]));
  return !!s.apply({ type: 'addFragment', fragment: frag, bondFrom: { atomId, fragmentAtomId: frag.atoms[0].id, order: 1 } }, { label: 'Add group' });
}
