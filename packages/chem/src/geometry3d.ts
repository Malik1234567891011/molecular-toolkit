import { element } from './elements.ts';
import { MolView } from './graph.ts';
import type { AtomId, Conformer, MoleculeDocument, Vec3 } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Vector helpers

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l < 1e-9 ? [1, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
  },
  dist: (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

/** Rotate v about unit axis k by angle (radians) — Rodrigues. */
export function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxv = v3.cross(k, v);
  const kdv = v3.dot(k, v);
  return [v[0] * c + kxv[0] * s + k[0] * kdv * (1 - c), v[1] * c + kxv[1] * s + k[1] * kdv * (1 - c), v[2] * c + kxv[2] * s + k[2] * kdv * (1 - c)];
}

function anyPerpendicular(v: Vec3): Vec3 {
  const a: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return v3.norm(v3.cross(v, a));
}

// ---------------------------------------------------------------------------------------------
// Local geometry model (VSEPR)

export interface LocalGeometry {
  /** σ-bonded partners (explicit neighbours + implicit H). */
  sigma: number;
  lonePairs: number;
  stericNumber: number;
  hybridization: 'sp' | 'sp2' | 'sp3' | 'sp3d' | 'sp3d2' | 's' | 'none';
  electronGeometry: string;
  molecularGeometry: string;
  idealAngle: number | null;
  /** Number of directions used to place substituents (steric number with LPs counted). */
  domains: number;
}

const VALENCE_ELECTRONS: Record<string, number> = { H: 1, B: 3, C: 4, N: 5, O: 6, F: 7, Si: 4, P: 5, S: 6, Cl: 7, Se: 6, Br: 7, I: 7 };

export function localGeometry(view: MolView, i: number): LocalGeometry {
  const a = view.atoms[i];
  const h = view.implicitH(i);
  const sigma = view.nbrs[i].length + h;
  const bondOrderSum = view.bondOrderSum(i) + h;
  const ve = VALENCE_ELECTRONS[a.element];
  let lonePairs = 0;
  if (ve !== undefined) {
    const nonBonding = ve - a.formalCharge - bondOrderSum - (a.radicalElectrons ?? 0);
    lonePairs = Math.max(0, Math.floor(nonBonding / 2));
  }
  if (a.element === 'H') return { sigma, lonePairs: 0, stericNumber: sigma, hybridization: 's', electronGeometry: 'single bond', molecularGeometry: 'terminal', idealAngle: null, domains: 1 };
  const multiple = view.nbrBonds[i].reduce((s, b) => s + (view.bonds[b].order - 1), 0);
  // Conjugated lone pairs (amide N, enol O, aromatic pyrrole N) flatten the centre.
  let conjugated = false;
  if (lonePairs > 0 && multiple === 0 && (a.element === 'N' || a.element === 'O')) {
    conjugated = view.nbrs[i].some((j) => view.atoms[j].aromatic || view.nbrBonds[j].some((b) => view.bonds[b].order === 2)) && (a.element === 'N' || a.aromatic);
    if (a.element === 'N' && view.atoms[i].aromatic) conjugated = true;
  }
  let steric = sigma + lonePairs;
  if (conjugated) steric = sigma + 0 + (lonePairs > 0 ? 1 : 0) - (lonePairs > 0 ? 0 : 0);
  let hyb: LocalGeometry['hybridization'];
  if (multiple >= 2 || (multiple === 1 && sigma === 1 && lonePairs === 0 && view.nbrBonds[i].some((b) => view.bonds[b].order === 3))) hyb = 'sp';
  else if (multiple === 1 || conjugated || a.aromatic) hyb = 'sp2';
  else if (steric <= 4) hyb = steric === 2 ? 'sp' : steric === 3 ? 'sp2' : 'sp3';
  else hyb = steric === 5 ? 'sp3d' : 'sp3d2';
  if (sigma === 0) hyb = 'none';
  const domains = hyb === 'sp' ? 2 : hyb === 'sp2' ? 3 : hyb === 'sp3' ? 4 : steric;
  const eg: Record<number, string> = { 2: 'linear', 3: 'trigonal planar', 4: 'tetrahedral', 5: 'trigonal bipyramidal', 6: 'octahedral' };
  const lpForShape = hyb === 'sp2' && conjugated ? 0 : lonePairs;
  const mgKey = `${domains}:${lpForShape}`;
  const mg: Record<string, string> = {
    '2:0': 'linear', '3:0': 'trigonal planar', '3:1': 'bent', '4:0': 'tetrahedral', '4:1': 'trigonal pyramidal', '4:2': 'bent',
    '4:3': 'linear', '2:1': 'linear', '5:0': 'trigonal bipyramidal', '6:0': 'octahedral', '5:1': 'seesaw', '6:1': 'square pyramidal',
  };
  const ideal: Record<number, number> = { 2: 180, 3: 120, 4: 109.5, 5: 90, 6: 90 };
  return {
    sigma,
    lonePairs,
    stericNumber: domains === 4 && hyb === 'sp3' ? sigma + lonePairs : domains,
    hybridization: hyb,
    electronGeometry: eg[domains] ?? `${domains} domains`,
    molecularGeometry: mg[mgKey] ?? eg[domains] ?? '',
    idealAngle: ideal[domains] ?? null,
    domains,
  };
}

// ---------------------------------------------------------------------------------------------
// Bond lengths

const ORDER_FACTOR = [1, 1, 0.87, 0.78];
const TABLE: Record<string, number> = {
  'C-C1': 1.53, 'C-C2': 1.34, 'C-C3': 1.2, 'C-H1': 1.09, 'C-N1': 1.47, 'C-N2': 1.28, 'C-N3': 1.16, 'C-O1': 1.43, 'C-O2': 1.22,
  'C-F1': 1.35, 'C-Cl1': 1.77, 'C-Br1': 1.94, 'C-I1': 2.14, 'C-S1': 1.82, 'C-S2': 1.61, 'N-H1': 1.01, 'O-H1': 0.96, 'S-H1': 1.34,
  'N-N1': 1.45, 'N-O1': 1.4, 'N-O2': 1.21, 'O-O1': 1.48, 'C-P1': 1.84, 'P-O1': 1.63, 'P-O2': 1.5, 'S-O2': 1.45, 'S-O1': 1.58,
};

export function bondLength(e1: string, e2: string, order: number): number {
  const key1 = `${e1}-${e2}${order}`;
  const key2 = `${e2}-${e1}${order}`;
  if (TABLE[key1]) return TABLE[key1];
  if (TABLE[key2]) return TABLE[key2];
  return (element(e1).covalentRadius + element(e2).covalentRadius) * (ORDER_FACTOR[order] ?? 1);
}

// ---------------------------------------------------------------------------------------------
// Ideal directions

/**
 * Directions for the remaining domains around a centre, given existing unit bond vectors.
 * `reference` (optional) chooses the rotation of otherwise free arrangements (e.g. keep a new
 * sp2 plane coplanar with a neighbour's plane).
 */
export function completeDirections(existing: Vec3[], domains: number, reference?: Vec3): Vec3[] {
  const need = domains - existing.length;
  if (need <= 0) return [];
  const e = existing.map(v3.norm);
  if (domains === 2) {
    if (e.length === 0) return [[1, 0, 0], [-1, 0, 0]];
    return [v3.scale(e[0], -1)];
  }
  if (domains === 3) {
    if (e.length === 0) {
      const out: Vec3[] = [];
      for (let k = 0; k < 3; k++) out.push([Math.cos((2 * Math.PI * k) / 3), Math.sin((2 * Math.PI * k) / 3), 0]);
      return out;
    }
    if (e.length === 1) {
      let perp = reference ? v3.sub(reference, v3.scale(e[0], v3.dot(reference, e[0]))) : anyPerpendicular(e[0]);
      if (v3.len(perp) < 1e-6) perp = anyPerpendicular(e[0]);
      perp = v3.norm(perp);
      // In-plane directions at ±120° from e0 (plane spanned by e0 and perp).
      const c = Math.cos((2 * Math.PI) / 3);
      const s = Math.sin((2 * Math.PI) / 3);
      return [v3.norm(v3.add(v3.scale(e[0], c), v3.scale(perp, s))), v3.norm(v3.add(v3.scale(e[0], c), v3.scale(perp, -s)))];
    }
    return [v3.norm(v3.scale(v3.add(e[0], e[1]), -1))];
  }
  if (domains >= 4) {
    if (e.length === 0) {
      const t = 1 / Math.sqrt(3);
      return [[t, t, t], [t, -t, -t], [-t, t, -t], [-t, -t, t]];
    }
    const tet = Math.acos(-1 / 3);
    if (e.length === 1) {
      let perp = reference ? v3.sub(reference, v3.scale(e[0], v3.dot(reference, e[0]))) : anyPerpendicular(e[0]);
      if (v3.len(perp) < 1e-6) perp = anyPerpendicular(e[0]);
      perp = v3.norm(perp);
      const out: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        const around = rotate(perp, e[0], (2 * Math.PI * k) / 3);
        out.push(v3.norm(v3.add(v3.scale(e[0], Math.cos(tet)), v3.scale(around, Math.sin(tet)))));
      }
      return out;
    }
    if (e.length === 2) {
      const bis = v3.norm(v3.scale(v3.add(e[0], e[1]), -1));
      const nrm = v3.norm(v3.cross(e[0], e[1]));
      const half = tet / 2;
      return [
        v3.norm(v3.add(v3.scale(bis, Math.cos(half)), v3.scale(nrm, Math.sin(half)))),
        v3.norm(v3.add(v3.scale(bis, Math.cos(half)), v3.scale(nrm, -Math.sin(half)))),
      ].slice(0, need);
    }
    if (e.length === 3) return [v3.norm(v3.scale(v3.add(v3.add(e[0], e[1]), e[2]), -1))];
  }
  return [];
}

/** Coordinates key for implicit hydrogen k (1-based) of an atom. */
export const hKey = (atomId: AtomId, k: number) => `${atomId}.h${k}`;

/**
 * Place implicit hydrogens (and fix up their count) for the given atoms using ideal local
 * geometry. Existing heavy-atom coordinates are kept.
 */
export function placeHydrogens(doc: MoleculeDocument, coords: Record<string, Vec3>, atomIds?: AtomId[]): Record<string, Vec3> {
  const view = new MolView(doc);
  const out = { ...coords };
  const targets = atomIds ? atomIds.map((id) => view.idx(id)) : doc.atoms.map((_, i) => i);
  for (const i of targets) {
    const a = doc.atoms[i];
    for (let k = 1; k <= 4; k++) delete out[hKey(a.id, k)];
    const h = view.implicitH(i);
    if (!h) continue;
    const c = out[a.id];
    if (!c) continue;
    const g = localGeometry(view, i);
    const nbrDirs: Vec3[] = [];
    let reference: Vec3 | undefined;
    for (const j of view.nbrs[i]) {
      const p = out[doc.atoms[j].id];
      if (p) nbrDirs.push(v3.norm(v3.sub(p, c)));
      // Reference: a substituent of the neighbour, to stagger/align.
      if (!reference && p) {
        const k2 = view.nbrs[j].find((x) => x !== i && out[doc.atoms[x].id]);
        if (k2 !== undefined) reference = v3.sub(out[doc.atoms[k2].id], p);
      }
    }
    const domains = Math.max(nbrDirs.length + h, Math.min(g.domains, 4));
    let dirs = completeDirections(nbrDirs, domains, reference ? v3.scale(reference, g.hybridization === 'sp3' ? -1 : 1) : undefined);
    if (dirs.length < h) {
      // Over-crowded: spread remaining H around
      while (dirs.length < h) dirs.push(anyPerpendicular(dirs[0] ?? [0, 0, 1]));
    }
    // With lone pairs on sp3 N/O, H take the first directions (LPs occupy the rest).
    dirs = dirs.slice(0, h);
    const len = bondLength(a.element, 'H', 1);
    dirs.forEach((d, k) => (out[hKey(a.id, k + 1)] = v3.add(c, v3.scale(d, len))));
  }
  return out;
}

/** Positions available for new substituents on atom `id` ("valence ports"). */
export function portsFor(doc: MoleculeDocument, coords: Record<string, Vec3>, id: AtomId): Array<{ key: string; position: Vec3; direction: Vec3 }> {
  const view = new MolView(doc);
  const i = view.idx(id);
  const c = coords[id];
  if (!c) return [];
  const h = view.implicitH(i);
  const out: Array<{ key: string; position: Vec3; direction: Vec3 }> = [];
  for (let k = 1; k <= h; k++) {
    const p = coords[hKey(id, k)];
    if (!p) continue;
    const d = v3.norm(v3.sub(p, c));
    out.push({ key: hKey(id, k), position: p, direction: d });
  }
  return out;
}

/** Position for a new atom bonded to `fromId` along `direction`. */
export function newAtomPosition(doc: MoleculeDocument, coords: Record<string, Vec3>, fromId: AtomId, element2: string, order: number, direction: Vec3): Vec3 {
  const a = doc.atoms.find((x) => x.id === fromId)!;
  const c = coords[fromId];
  return v3.add(c, v3.scale(v3.norm(direction), bondLength(a.element, element2, order)));
}

/**
 * Incrementally update a conformer after a graph edit: keep coordinates of existing atoms,
 * place new heavy atoms next to a placed neighbour, then rebuild hydrogens of touched atoms.
 */
export function updateConformer(doc: MoleculeDocument, prev: Conformer | undefined, touched: AtomId[] = []): Conformer {
  const view = new MolView(doc);
  const coords: Record<string, Vec3> = {};
  if (prev) for (const [k, p] of Object.entries(prev.coordinates)) coords[k] = p;
  // Remove coordinates of atoms that no longer exist.
  const ids = new Set(doc.atoms.map((a) => a.id));
  for (const k of Object.keys(coords)) if (!ids.has(k.split('.')[0])) delete coords[k];
  const placed = new Set(doc.atoms.filter((a) => coords[a.id]).map((a) => a.id));
  const touchedSet = new Set(touched);
  // Seed every connected fragment that has no placed atom yet.
  let seedOffset = 0;
  const maxX = Math.max(0, ...Object.values(coords).map((p) => p[0]));
  for (const comp of view.components()) {
    if (comp.some((i) => placed.has(doc.atoms[i].id))) continue;
    const first = doc.atoms[comp[0]].id;
    coords[first] = placed.size ? [maxX + 4 + seedOffset, 0, 0] : [seedOffset, 0, 0];
    seedOffset += 6;
    placed.add(first);
    touchedSet.add(first);
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < view.atomCount; i++) {
      const a = doc.atoms[i];
      if (placed.has(a.id)) continue;
      const anchor = view.nbrs[i].find((j) => placed.has(doc.atoms[j].id));
      if (anchor === undefined) continue;
      const aid = doc.atoms[anchor].id;
      // Use a free port (an H position) of the anchor when available.
      const tmp = placeHydrogens(doc, coords, [aid]);
      const anchorView = view;
      const g = localGeometry(anchorView, anchor);
      const existing: Vec3[] = anchorView.nbrs[anchor].filter((j) => placed.has(doc.atoms[j].id)).map((j) => v3.norm(v3.sub(coords[doc.atoms[j].id], coords[aid])));
      let dirs = completeDirections(existing, Math.max(g.domains, existing.length + 1));
      const hdir = [1, 2, 3, 4].map((k) => tmp[hKey(aid, k)]).filter(Boolean).map((p) => v3.norm(v3.sub(p as Vec3, coords[aid])));
      if (hdir.length) dirs = [hdir[0], ...dirs];
      const dir = dirs[0] ?? anyPerpendicular(existing[0] ?? [0, 0, 1]);
      const b = doc.bonds.find((x) => (x.a1 === a.id && x.a2 === aid) || (x.a2 === a.id && x.a1 === aid))!;
      coords[a.id] = v3.add(coords[aid], v3.scale(dir, bondLength(doc.atoms[anchor].element, a.element, b.order)));
      placed.add(a.id);
      touchedSet.add(a.id);
      touchedSet.add(aid);
      progress = true;
    }
  }
  // Disconnected, unplaced atoms (new fragments): place near the origin, offset.
  let offset = 0;
  for (const a of doc.atoms) {
    if (placed.has(a.id)) continue;
    coords[a.id] = [3 + offset, 0, 0];
    offset += 1.6;
    placed.add(a.id);
    touchedSet.add(a.id);
  }
  // Atoms whose H count changed need new hydrogens; neighbours of touched atoms too.
  const hTargets = new Set<AtomId>(touchedSet);
  for (const id of touchedSet) {
    const i = view.index.get(id);
    if (i === undefined) continue;
    for (const j of view.nbrs[i]) hTargets.add(doc.atoms[j].id);
  }
  for (const a of doc.atoms) {
    const i = view.idx(a.id);
    const h = view.implicitH(i);
    const have = [1, 2, 3, 4].filter((k) => coords[hKey(a.id, k)]).length;
    if (h !== have) hTargets.add(a.id);
  }
  const withH = placeHydrogens(doc, coords, [...hTargets].filter((id) => ids.has(id)));
  return {
    id: prev?.id ?? 'c1',
    coordinates: withH,
    method: 'idealized local placement (not yet relaxed)',
    converged: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Measurements

export function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
  const u = v3.norm(v3.sub(a, b));
  const w = v3.norm(v3.sub(c, b));
  return (Math.acos(Math.max(-1, Math.min(1, v3.dot(u, w)))) * 180) / Math.PI;
}

export function dihedralDeg(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const b0 = v3.sub(p0, p1);
  const b1 = v3.norm(v3.sub(p2, p1));
  const b2 = v3.sub(p3, p2);
  const v = v3.sub(b0, v3.scale(b1, v3.dot(b0, b1)));
  const w = v3.sub(b2, v3.scale(b1, v3.dot(b2, b1)));
  return (Math.atan2(v3.dot(v3.cross(b1, v), w), v3.dot(v, w)) * 180) / Math.PI;
}

/** Why a measured angle differs from the idealized one (teaching copy). */
export function explainAngle(doc: MoleculeDocument, centreId: AtomId, measured: number, ringSize: number): string[] {
  const view = new MolView(doc);
  const i = view.idx(centreId);
  const g = localGeometry(view, i);
  const reasons: string[] = [];
  if (g.idealAngle === null) return reasons;
  const d = measured - g.idealAngle;
  if (Math.abs(d) < 1.5) return ['The model angle is essentially the idealized VSEPR angle.'];
  if (ringSize && ringSize <= 5) reasons.push(`The ${ringSize}-membered ring forces the angle away from ${g.idealAngle}° (ring strain).`);
  if (g.lonePairs > 0 && g.hybridization === 'sp3') reasons.push(`${g.lonePairs} lone pair${g.lonePairs > 1 ? 's' : ''} on this atom repel${g.lonePairs > 1 ? '' : 's'} more strongly than bonding pairs, squeezing the bond angle below ${g.idealAngle}°.`);
  if (view.nbrBonds[i].some((b) => view.bonds[b].order > 1)) reasons.push('A multiple bond holds more electron density than a single bond, so angles next to it open up slightly.');
  if (Math.abs(d) > 1.5 && reasons.length === 0) reasons.push('Different substituents (size and electronegativity) make the real geometry deviate from the idealized one; bulky groups push each other apart.');
  reasons.push('This is an optimized force-field model angle, not an experimental measurement.');
  return reasons;
}

// ---------------------------------------------------------------------------------------------
// Rigid rotation about a bond (conformer mode)

/** Atoms on the `side` end of bond a–b (graph walk not crossing the bond), including H keys. */
export function sideOfBond(doc: MoleculeDocument, aId: AtomId, bId: AtomId): AtomId[] | null {
  const view = new MolView(doc);
  const a = view.idx(aId);
  const b = view.idx(bId);
  const seen = new Set<number>([b]);
  const st = [b];
  while (st.length) {
    const x = st.pop()!;
    for (const y of view.nbrs[x]) {
      if (x === b && y === a) continue;
      if (y === a) return null; // ring bond: not rotatable
      if (!seen.has(y)) {
        seen.add(y);
        st.push(y);
      }
    }
  }
  return [...seen].map((i) => doc.atoms[i].id);
}

export function rotateFragment(coords: Record<string, Vec3>, atomIds: AtomId[], axisFrom: Vec3, axisTo: Vec3, angleDegrees: number): Record<string, Vec3> {
  const out = { ...coords };
  const k = v3.norm(v3.sub(axisTo, axisFrom));
  const ang = (angleDegrees * Math.PI) / 180;
  const set = new Set(atomIds);
  for (const [key, p] of Object.entries(coords)) {
    if (!set.has(key.split('.')[0])) continue;
    out[key] = v3.add(axisTo, rotate(v3.sub(p, axisTo), k, ang));
  }
  return out;
}

/** Rotatable = single, not in a ring, both ends have other heavy/H substituents, not terminal. */
export function isRotatable(doc: MoleculeDocument, bondId: string): boolean {
  const view = new MolView(doc);
  const bi = view.bondIndex.get(bondId);
  if (bi === undefined) return false;
  const b = doc.bonds[bi];
  if (b.order !== 1) return false;
  const a = view.idx(b.a1);
  const c = view.idx(b.a2);
  if (view.coordination(a) < 2 || view.coordination(c) < 2) return false;
  return sideOfBond(doc, b.a1, b.a2) !== null;
}

// ---------------------------------------------------------------------------------------------
// Alignment (Kabsch) so regenerated conformers do not jump

export function alignTo(moving: Record<string, Vec3>, target: Record<string, Vec3>): Record<string, Vec3> {
  const keys = Object.keys(moving).filter((k) => target[k] && !k.includes('.'));
  if (keys.length < 3) return moving;
  const cm = keys.reduce<Vec3>((s, k) => v3.add(s, moving[k]), [0, 0, 0]).map((x) => x / keys.length) as Vec3;
  const ct = keys.reduce<Vec3>((s, k) => v3.add(s, target[k]), [0, 0, 0]).map((x) => x / keys.length) as Vec3;
  // Covariance
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const k of keys) {
    const p = v3.sub(moving[k], cm);
    const q = v3.sub(target[k], ct);
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) H[r][s] += p[r] * q[s];
  }
  const R = kabschRotation(H);
  const out: Record<string, Vec3> = {};
  for (const [k, p] of Object.entries(moving)) {
    const x = v3.sub(p, cm);
    out[k] = v3.add(ct, [R[0][0] * x[0] + R[0][1] * x[1] + R[0][2] * x[2], R[1][0] * x[0] + R[1][1] * x[1] + R[1][2] * x[2], R[2][0] * x[0] + R[2][1] * x[1] + R[2][2] * x[2]]);
  }
  return out;
}

/** Optimal proper rotation from covariance H via quaternion method (Horn). */
function kabschRotation(H: number[][]): number[][] {
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = H;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Power iteration on shifted matrix for the largest eigenvector.
  let q = [1, 0, 0, 0];
  const shift = 1e-3 + Math.abs(N.flat().reduce((s, x) => s + Math.abs(x), 0));
  for (let it = 0; it < 200; it++) {
    const nq = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) nq[r] += (N[r][c] + (r === c ? shift : 0)) * q[c];
    const n = Math.hypot(...nq);
    q = nq.map((x) => x / n);
  }
  const [w, x, y, z] = q;
  return [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
}

export function centroid(coords: Record<string, Vec3>, keys?: string[]): Vec3 {
  const ks = keys ?? Object.keys(coords);
  if (!ks.length) return [0, 0, 0];
  const s = ks.reduce<Vec3>((acc, k) => v3.add(acc, coords[k]), [0, 0, 0]);
  return v3.scale(s, 1 / ks.length);
}
