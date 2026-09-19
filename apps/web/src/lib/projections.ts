'use client';
/**
 * Projection geometry for the projection lab (spec §8). Fischer and wedge/dash drawings are
 * placed from the stored configuration (not from pixels), so they always agree with the graph,
 * the name and the 3D model.
 */
import { MolView, parityFromPositions, type AtomId, type MoleculeDocument, type StereoCentre, type StereoNeighbour, type Vec3, naming } from '@orbital/chem';

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
export const sub = (n: number) => (n > 1 ? String(n).split('').map((d) => SUBSCRIPT[+d]).join('') : '');

/** Condensed formula for the branch reached from `fromId` through `atomId` (CH3, CH2CH3, OH, COOH…). */
export function condensed(doc: MoleculeDocument, atomId: StereoNeighbour, fromId: AtomId, depth = 0): string {
  if (atomId === 'H') return 'H';
  if (atomId === 'LP') return '••';
  const view = new MolView(doc);
  const i = view.idx(atomId);
  const a = doc.atoms[i];
  const h = view.implicitH(i);
  const kids = view.nbrs[i].filter((j) => doc.atoms[j].id !== fromId);
  const bondTo = (j: number) => doc.bonds.find((b) => (b.a1 === a.id && b.a2 === doc.atoms[j].id) || (b.a2 === a.id && b.a1 === doc.atoms[j].id))!;
  const charge = a.formalCharge ? (a.formalCharge > 0 ? '⁺' : '⁻') : '';
  const hs = h ? `H${sub(h)}` : '';
  if (!kids.length) return a.element === 'C' || a.element === 'N' || a.element === 'O' || a.element === 'S' ? `${a.element}${hs}${charge}` : `${a.element}${charge}`;
  if (a.element === 'C') {
    const dbO = kids.find((j) => doc.atoms[j].element === 'O' && bondTo(j).order === 2);
    const triN = kids.find((j) => doc.atoms[j].element === 'N' && bondTo(j).order === 3);
    if (triN !== undefined && kids.length === 1) return 'C≡N';
    if (dbO !== undefined) {
      const rest = kids.filter((j) => j !== dbO);
      if (!rest.length) return 'CHO';
      if (rest.length === 1) {
        const r = doc.atoms[rest[0]];
        const rh = view.implicitH(rest[0]);
        const rk = view.nbrs[rest[0]].filter((j) => j !== i);
        if (r.element === 'O' && rh === 1) return 'COOH';
        if (r.element === 'O' && r.formalCharge === -1) return 'COO⁻';
        if (r.element === 'N' && rh === 2) return 'CONH₂';
        if (r.element === 'O' && rk.length === 1 && depth < 2) return `COO${condensed(doc, doc.atoms[rk[0]].id, r.id, depth + 1)}`;
        if (['Cl', 'Br', 'F', 'I'].includes(r.element)) return `CO${r.element}`;
        if (r.element === 'C' && depth < 2) return `CO${condensed(doc, r.id, a.id, depth + 1)}`;
      }
    }
    if (kids.every((j) => bondTo(j).order === 1) && depth < 3) {
      const parts = kids.map((j) => condensed(doc, doc.atoms[j].id, a.id, depth + 1));
      const heavy = kids.reduce((n, j) => n + branchSize(view, j, i), 0);
      if (heavy <= 5) {
        if (parts.length === 1) return `C${hs}${parts[0]}`;
        const counts = new Map<string, number>();
        for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
        const inner = [...counts.entries()].map(([p, n]) => (n > 1 ? `(${p})${sub(n)}` : `(${p})`)).join('');
        return `C${hs}${inner}`;
      }
    }
  }
  if (a.element === 'O' && kids.length === 1 && depth < 2) return `O${condensed(doc, doc.atoms[kids[0]].id, a.id, depth + 1)}`;
  if (a.element === 'N' && kids.length === 1 && depth < 2) return `N${hs}${condensed(doc, doc.atoms[kids[0]].id, a.id, depth + 1)}`;
  const aromatic = a.aromatic && kids.length >= 2;
  if (aromatic) return 'Ph';
  return `R`;
}

function branchSize(view: MolView, start: number, from: number): number {
  const seen = new Set([from, start]);
  const st = [start];
  while (st.length) {
    const x = st.pop()!;
    for (const y of view.nbrs[x]) if (!seen.has(y)) {
      seen.add(y);
      st.push(y);
    }
  }
  return seen.size - 1;
}

/** Choose which of two slots gets which ligand so the drawing realizes the stored parity. */
function placeByParity(stored: { order: StereoNeighbour[]; parity: 'cw' | 'ccw' } | undefined, fixed: Map<StereoNeighbour, Vec3>, pair: [StereoNeighbour, StereoNeighbour], slots: [Vec3, Vec3]): { first: StereoNeighbour; second: StereoNeighbour } {
  if (!stored) return { first: pair[0], second: pair[1] };
  const pos = new Map(fixed);
  pos.set(pair[0], slots[0]);
  pos.set(pair[1], slots[1]);
  const pts = stored.order.map((n) => pos.get(n));
  if (pts.some((p) => !p)) return { first: pair[0], second: pair[1] };
  const parity = parityFromPositions(pts as Vec3[]);
  return parity === stored.parity ? { first: pair[0], second: pair[1] } : { first: pair[1], second: pair[0] };
}

export interface FischerCross {
  atomId: AtomId;
  left: StereoNeighbour;
  right: StereoNeighbour;
  up: StereoNeighbour;
  down: StereoNeighbour;
  descriptor?: 'R' | 'S';
  specified: boolean;
  stereo: boolean;
}

export interface FischerData {
  ok: boolean;
  reason?: string;
  top?: string;
  bottom?: string;
  crosses: FischerCross[];
  offChain: AtomId[];
}

/**
 * Fischer projection of the main chain: C1 at the top, every stereocentre a cross whose
 * vertical bonds point away and horizontal bonds toward the viewer.
 */
export function fischerData(doc: MoleculeDocument, trace: naming.NamingTrace | undefined, centres: StereoCentre[]): FischerData {
  const tetra = centres.filter((c) => !c.needsHigherRules);
  if (!tetra.length) return { ok: false, reason: 'There are no stereocentres, so a Fischer projection shows nothing a skeletal drawing does not.', crosses: [], offChain: [] };
  if (!trace || trace.parent.kind !== 'chain') return { ok: false, reason: 'Fischer projections are drawn for open chains; the stereocentres here sit on a ring (use wedge/dash or the chair view).', crosses: [], offChain: [] };
  const chain = trace.numbering.orderedAtomIds;
  const on = tetra.filter((c) => chain.includes(c.atomId));
  const offChain = tetra.filter((c) => !chain.includes(c.atomId)).map((c) => c.atomId);
  if (!on.length) return { ok: false, reason: 'None of the stereocentres lie on the main chain, so there is no meaningful vertical backbone.', crosses: [], offChain };
  const idx = on.map((c) => chain.indexOf(c.atomId));
  const first = Math.min(...idx);
  const last = Math.max(...idx);
  const view = new MolView(doc);
  const crosses: FischerCross[] = [];
  const UP: Vec3 = [0, 1, -0.7];
  const DOWN: Vec3 = [0, -1, -0.7];
  const LEFT: Vec3 = [-1, 0, 0.7];
  const RIGHT: Vec3 = [1, 0, 0.7];
  for (let k = first; k <= last; k++) {
    const id = chain[k];
    const i = view.idx(id);
    const ligs: StereoNeighbour[] = view.nbrs[i].map((j) => doc.atoms[j].id);
    for (let h = 0; h < view.implicitH(i); h++) ligs.push('H');
    const up: StereoNeighbour = k > 0 ? chain[k - 1] : pickVertical(ligs, chain, id);
    const down: StereoNeighbour = k < chain.length - 1 ? chain[k + 1] : pickVertical(ligs.filter((l) => l !== up), chain, id);
    const rest = ligs.filter((l, n) => l !== up && l !== down && ligs.indexOf(l) === n);
    // Two implicit H on a non-stereo chain carbon: both horizontal slots are H.
    const hCount = ligs.filter((l) => l === 'H').length;
    const pair: [StereoNeighbour, StereoNeighbour] = rest.length >= 2 ? [rest[0], rest[1]] : hCount === 2 ? ['H', 'H'] : [rest[0] ?? 'H', 'H'];
    const centre = tetra.find((c) => c.atomId === id);
    const stored = doc.atoms[i].stereo;
    const placed = placeByParity(centre?.specified ? stored : undefined, new Map<StereoNeighbour, Vec3>([[up, UP], [down, DOWN]]), pair, [LEFT, RIGHT]);
    crosses.push({ atomId: id, up, down, left: placed.first, right: placed.second, descriptor: centre?.descriptor, specified: !!centre?.specified, stereo: !!centre });
  }
  const top = first > 0 ? condensed(doc, chain[first - 1], chain[first]) : undefined;
  const bottom = last < chain.length - 1 ? condensed(doc, chain[last + 1], chain[last]) : undefined;
  return { ok: true, top: top ?? labelOf(doc, crosses[0].up, crosses[0].atomId), bottom: bottom ?? labelOf(doc, crosses[crosses.length - 1].down, crosses[crosses.length - 1].atomId), crosses, offChain };
}

function pickVertical(ligs: StereoNeighbour[], chain: AtomId[], self: AtomId): StereoNeighbour {
  return ligs.find((l) => l !== 'H' && l !== 'LP' && !chain.includes(l as AtomId) && l !== self) ?? ligs[0];
}

export function labelOf(doc: MoleculeDocument, lig: StereoNeighbour, centre: AtomId): string {
  return condensed(doc, lig, centre);
}

export interface WedgeDash {
  centre: AtomId;
  inA: StereoNeighbour;
  inB: StereoNeighbour;
  wedge: StereoNeighbour;
  dash: StereoNeighbour;
  priorities: StereoNeighbour[];
}

/** Wedge/dash drawing of one centre with the lowest-priority group on the dash. */
export function wedgeDashData(doc: MoleculeDocument, centre: StereoCentre): WedgeDash | null {
  const p = centre.priorities;
  if (p.length !== 4) return null;
  const stored = doc.atoms.find((a) => a.id === centre.atomId)?.stereo;
  const IN_A: Vec3 = [-0.87, 0.5, 0];
  const IN_B: Vec3 = [0.87, 0.5, 0];
  const WEDGE: Vec3 = [-0.4, -0.9, 0.8];
  const DASH: Vec3 = [0.4, -0.9, -0.8];
  const placed = placeByParity(centre.specified ? stored : undefined, new Map<StereoNeighbour, Vec3>([[p[0], WEDGE], [p[3], DASH]]), [p[1], p[2]], [IN_A, IN_B]);
  return { centre: centre.atomId, inA: placed.first, inB: placed.second, wedge: p[0], dash: p[3], priorities: p };
}

// ---------------------------------------------------------------------------------------------
// Textbook chair drawing: an ideal chair projected from a slightly elevated viewpoint.

export interface ChairDrawing {
  ring: Array<[number, number]>;
  axial: Array<[number, number]>;
  equatorial: Array<[number, number]>;
  /** +1 when ring position k is an "up" carbon (axial bond points up). */
  up: number[];
}

export function idealChairDrawing(scale = 1): ChairDrawing {
  const R = 1.446;
  const h = 0.25;
  const pts: Vec3[] = [];
  for (let k = 0; k < 6; k++) {
    const phi = Math.PI + (k * Math.PI) / 3; // atom 0 = left tip
    pts.push([R * Math.cos(phi), R * Math.sin(phi), k % 2 === 0 ? -h : h]);
  }
  const el = (16 * Math.PI) / 180;
  // A slight turn about the ring axis, as textbooks draw it: without it the front and back
  // carbons sit directly above each other and their axial bonds overlap.
  const az = (14 * Math.PI) / 180;
  const project = (p: Vec3): [number, number] => {
    const x = p[0] * Math.cos(az) - p[1] * Math.sin(az);
    const y = p[0] * Math.sin(az) + p[1] * Math.cos(az);
    return [x * scale, -(p[2] * Math.cos(el) + y * Math.sin(el)) * scale];
  };
  const half = (109.47 / 2) * (Math.PI / 180);
  const axial: Array<[number, number]> = [];
  const equatorial: Array<[number, number]> = [];
  const up: number[] = [];
  const L = 0.95;
  for (let k = 0; k < 6; k++) {
    const p = pts[k];
    const prev = pts[(k + 5) % 6];
    const next = pts[(k + 1) % 6];
    const u1 = norm(sub3(p, prev));
    const u2 = norm(sub3(p, next));
    const bis = norm(add3(u1, u2));
    const perp = norm(cross3(u1, u2));
    const d1 = add3(scale3(bis, Math.cos(half)), scale3(perp, Math.sin(half)));
    const d2 = sub3(scale3(bis, Math.cos(half)), scale3(perp, Math.sin(half)));
    const [ax, eq] = Math.abs(d1[2]) > Math.abs(d2[2]) ? [d1, d2] : [d2, d1];
    axial.push(project(add3(p, scale3(ax, L))));
    equatorial.push(project(add3(p, scale3(eq, L))));
    up.push(p[2] > 0 ? 1 : -1);
  }
  return { ring: pts.map(project), axial, equatorial, up };
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
