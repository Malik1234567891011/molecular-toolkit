'use client';
import { DocBuilder, type AtomId, type BondId, type MoleculeDocument, type Vec2 } from '@orbital/chem';

const L = 1.5;

/** Regular ring polygon centred at `c`, optionally aligned so vertex 0 sits at `start`. */
export function ringTemplate(size: number, aromatic: boolean, center: Vec2, rotation = Math.PI / 2): MoleculeDocument {
  const b = new DocBuilder();
  const r = L / (2 * Math.sin(Math.PI / size));
  const ids: AtomId[] = [];
  for (let k = 0; k < size; k++) {
    const ang = rotation + (2 * Math.PI * k) / size;
    ids.push(b.addAtom('C', {}, [center[0] + r * Math.cos(ang), center[1] + r * Math.sin(ang)]));
  }
  for (let k = 0; k < size; k++) {
    const order = aromatic && size === 6 && k % 2 === 0 ? 2 : 1;
    b.addBond(ids[k], ids[(k + 1) % size], order as 1 | 2);
  }
  return b.doc;
}

/** Ring fused onto an existing bond (shares both atoms), placed on the side away from `awayFrom`. */
export function fusedRingTemplate(size: number, aromatic: boolean, p1: Vec2, p2: Vec2, awayFrom?: Vec2): { doc: MoleculeDocument; shared: [AtomId, AtomId] } {
  const mid: Vec2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (awayFrom) {
    const side = (awayFrom[0] - mid[0]) * nx + (awayFrom[1] - mid[1]) * ny;
    if (side > 0) {
      nx = -nx;
      ny = -ny;
    }
  }
  const apothem = L / (2 * Math.tan(Math.PI / size));
  const center: Vec2 = [mid[0] + nx * apothem, mid[1] + ny * apothem];
  const r = L / (2 * Math.sin(Math.PI / size));
  const a1 = Math.atan2(p1[1] - center[1], p1[0] - center[0]);
  const a2 = Math.atan2(p2[1] - center[1], p2[0] - center[0]);
  let dir = a2 - a1;
  while (dir > Math.PI) dir -= 2 * Math.PI;
  while (dir < -Math.PI) dir += 2 * Math.PI;
  const step = dir > 0 ? (2 * Math.PI) / size : -(2 * Math.PI) / size;
  const b = new DocBuilder();
  const ids: AtomId[] = [];
  for (let k = 0; k < size; k++) {
    const ang = a1 + step * k;
    ids.push(b.addAtom('C', {}, [center[0] + r * Math.cos(ang), center[1] + r * Math.sin(ang)]));
  }
  for (let k = 0; k < size; k++) {
    const order = aromatic && size === 6 && k % 2 === 1 ? 2 : 1;
    b.addBond(ids[k], ids[(k + 1) % size], order as 1 | 2);
  }
  return { doc: b.doc, shared: [ids[0], ids[1]] };
}

/** Ring hanging off an atom through a new single bond (e.g. phenyl), pointing along `angle`. */
export function pendantRing(size: number, aromatic: boolean, anchor: Vec2, angle: number): MoleculeDocument {
  const r = L / (2 * Math.sin(Math.PI / size));
  const first: Vec2 = [anchor[0] + Math.cos(angle) * L, anchor[1] + Math.sin(angle) * L];
  const center: Vec2 = [first[0] + Math.cos(angle) * r, first[1] + Math.sin(angle) * r];
  return ringTemplate(size, aromatic, center, angle + Math.PI);
}

/** Zig-zag chain of `n` carbons starting at `start`, heading roughly toward `angle`. */
export function chainPoints(start: Vec2, angle: number, n: number, flip = false): Vec2[] {
  const pts: Vec2[] = [];
  let cur = start;
  for (let k = 0; k < n; k++) {
    const turn = (k % 2 === 0) !== flip ? Math.PI / 6 : -Math.PI / 6;
    const a = angle + turn;
    cur = [cur[0] + Math.cos(a) * L, cur[1] + Math.sin(a) * L];
    pts.push(cur);
  }
  return pts;
}

export interface RingButton {
  size: number;
  aromatic: boolean;
  label: string;
}

export const RING_BUTTONS: RingButton[] = [
  { size: 6, aromatic: true, label: 'benzene' },
  { size: 6, aromatic: false, label: 'cyclohexane' },
  { size: 5, aromatic: false, label: 'cyclopentane' },
  { size: 3, aromatic: false, label: 'cyclopropane' },
  { size: 4, aromatic: false, label: 'cyclobutane' },
  { size: 7, aromatic: false, label: 'cycloheptane' },
];

export const FRAGMENTS: Array<{ label: string; smiles: string; hint: string }> = [
  { label: 'OH', smiles: 'O', hint: 'hydroxy' },
  { label: 'NH₂', smiles: 'N', hint: 'amino' },
  { label: 'CH₃', smiles: 'C', hint: 'methyl' },
  { label: 'COOH', smiles: 'C(=O)O', hint: 'carboxylic acid' },
  { label: 'CHO', smiles: 'C=O', hint: 'aldehyde' },
  { label: 'C≡N', smiles: 'C#N', hint: 'nitrile' },
  { label: 'NO₂', smiles: '[N+](=O)[O-]', hint: 'nitro' },
  { label: 'OCH₃', smiles: 'OC', hint: 'methoxy' },
  { label: 'Ph', smiles: 'c1ccccc1', hint: 'phenyl' },
];

export type { BondId };
