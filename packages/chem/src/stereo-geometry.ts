import { stereoNeighbourList } from './cip.ts';
import { MolView } from './graph.ts';
import { perceiveRings } from './rings.ts';
import type { AtomId, Conformer, MoleculeDocument, StereoNeighbour, Vec2, Vec3 } from './types.ts';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n < 1e-9 ? [0, 0, 0] : scale(a, 1 / n);
};

/**
 * Parity of four ligand positions around a centre: looking from p[0] toward the centre,
 * are p[1] → p[2] → p[3] clockwise? Returns null when the arrangement is (near) planar.
 */
export function parityFromPositions(p: Vec3[]): 'cw' | 'ccw' | null {
  const d = dot(sub(p[1], p[0]), cross(sub(p[2], p[0]), sub(p[3], p[0])));
  const scaleRef = norm(sub(p[1], p[0])) * norm(sub(p[2], p[0])) * norm(sub(p[3], p[0]));
  if (Math.abs(d) < 0.05 * scaleRef) return null;
  return d > 0 ? 'cw' : 'ccw';
}

/** Position for an implicit ligand (H or lone pair) opposite the explicit ones. */
function implicitPosition(centre: Vec3, others: Vec3[]): Vec3 {
  let s: Vec3 = [0, 0, 0];
  for (const o of others) s = add(s, unit(sub(o, centre)));
  const dir = unit(scale(s, -1));
  if (norm(dir) < 1e-6) return add(centre, [0, 0, -1]);
  return add(centre, dir);
}

export interface WedgeStereoResult {
  doc: MoleculeDocument;
  warnings: Array<{ atomId: AtomId; message: string }>;
}

/**
 * Derive tetrahedral stereo for atoms that carry wedge/hash bonds (narrow end at the atom).
 * Atoms without wedges keep no stereo (unspecified). Wavy ("either") bonds mark the centre unknown.
 */
export function stereoFromWedges(doc: MoleculeDocument, onlyAtoms?: Set<AtomId>): WedgeStereoResult {
  const out = structuredClone(doc);
  const view = new MolView(out);
  const warnings: WedgeStereoResult['warnings'] = [];
  for (let i = 0; i < view.atomCount; i++) {
    const a = out.atoms[i];
    if (onlyAtoms && !onlyAtoms.has(a.id)) continue;
    const wedges = view.nbrBonds[i].map((bi) => out.bonds[bi]).filter((b) => b.a1 === a.id && b.wedge);
    const nbrs = stereoNeighbourList(view, i);
    if (!wedges.length) {
      if (!onlyAtoms) {
        delete a.stereo;
        delete a.stereoUnknown;
      }
      continue;
    }
    if (wedges.some((w) => w.wedge === 'either')) {
      delete a.stereo;
      a.stereoUnknown = true;
      continue;
    }
    delete a.stereoUnknown;
    if (!nbrs) {
      delete a.stereo;
      warnings.push({ atomId: a.id, message: 'This atom is not a stereocentre, so its wedge has no effect.' });
      continue;
    }
    const c2 = out.layout2d[a.id];
    if (!c2) continue;
    const centre: Vec3 = [c2[0], c2[1], 0];
    const pos = new Map<StereoNeighbour, Vec3>();
    for (const nb of nbrs) {
      if (nb === 'H' || nb === 'LP') continue;
      const p = out.layout2d[nb];
      if (!p) continue;
      const b = out.bonds.find((x) => (x.a1 === a.id && x.a2 === nb) || (x.a2 === a.id && x.a1 === nb))!;
      let z = 0;
      if (b.a1 === a.id && b.wedge === 'up') z = 1;
      if (b.a1 === a.id && b.wedge === 'down') z = -1;
      const v = unit([p[0] - c2[0], p[1] - c2[1], 0]);
      pos.set(nb, add(centre, [v[0] * 1, v[1] * 1, z * 0.9]));
    }
    const explicit = [...pos.values()];
    for (const nb of nbrs) if (nb === 'H' || nb === 'LP') pos.set(nb, implicitPosition(centre, explicit));
    if (pos.size !== 4) continue;
    const parity = parityFromPositions(nbrs.map((nb) => pos.get(nb)!));
    if (!parity) {
      delete a.stereo;
      warnings.push({ atomId: a.id, message: 'The wedges at this centre are ambiguous (two ligands point the same way), so no configuration was assigned.' });
      continue;
    }
    a.stereo = { order: nbrs, parity };
  }
  return { doc: out, warnings };
}

/** Double-bond configurations read from 2D coordinates for the given bonds (all if omitted). */
export function doubleBondStereoFrom2D(doc: MoleculeDocument, onlyBonds?: Set<string>): MoleculeDocument {
  const out = structuredClone(doc);
  const view = new MolView(out);
  const rings = perceiveRings(view);
  out.bonds.forEach((b, bi) => {
    if (onlyBonds && !onlyBonds.has(b.id)) return;
    if (b.order !== 2 || b.stereoUnknown) {
      if (b.order !== 2) delete b.stereo;
      return;
    }
    if (rings.bondRings[bi].some((r) => rings.rings[r].atoms.length < 8)) {
      delete b.stereo;
      return;
    }
    const A = view.idx(b.a1);
    const B = view.idx(b.a2);
    const rA = view.nbrs[A].find((j) => j !== B);
    const rB = view.nbrs[B].find((j) => j !== A);
    if (rA === undefined || rB === undefined) {
      delete b.stereo;
      return;
    }
    const pA = out.layout2d[b.a1];
    const pB = out.layout2d[b.a2];
    const pa = out.layout2d[out.atoms[rA].id];
    const pb = out.layout2d[out.atoms[rB].id];
    if (!pA || !pB || !pa || !pb) return;
    const side = (p: Vec2) => (pB[0] - pA[0]) * (p[1] - pA[1]) - (pB[1] - pA[1]) * (p[0] - pA[0]);
    const s1 = side(pa);
    const s2 = side(pb);
    if (Math.abs(s1) < 1e-3 || Math.abs(s2) < 1e-3) {
      delete b.stereo;
      return;
    }
    b.stereo = { refs: [out.atoms[rA].id, out.atoms[rB].id], config: Math.sign(s1) === Math.sign(s2) ? 'cis' : 'trans' };
  });
  return out;
}

/**
 * Choose wedge/hash bonds that depict the stored stereo on the current 2D layout.
 * Existing wedge choices are kept where possible (only flipped up/down).
 */
export function wedgesFromStereo(doc: MoleculeDocument): MoleculeDocument {
  const out = structuredClone(doc);
  const view = new MolView(out);
  const rings = perceiveRings(view);
  const stereoAtoms = new Set(out.atoms.filter((a) => a.stereo).map((a) => a.id));
  // Clear wedges at atoms that no longer carry stereo.
  for (const b of out.bonds) {
    if (b.wedge && b.wedge !== 'either' && !stereoAtoms.has(b.a1)) delete b.wedge;
  }
  for (let i = 0; i < view.atomCount; i++) {
    const a = out.atoms[i];
    if (!a.stereo) continue;
    const c2 = out.layout2d[a.id];
    if (!c2) continue;
    const bondsHere = view.nbrBonds[i].map((bi) => out.bonds[bi]);
    let chosen = bondsHere.find((b) => b.a1 === a.id && b.wedge && b.wedge !== 'either');
    if (!chosen) {
      const candidates = view.nbrs[i]
        .map((j, k) => ({ j, b: out.bonds[view.nbrBonds[i][k]] }))
        .filter(({ b }) => b.order === 1 && !(b.wedge && b.a1 !== a.id && stereoAtoms.has(b.a1)));
      candidates.sort((x, y) => score(x.j) - score(y.j));
      function score(j: number): number {
        let s = 0;
        if (stereoAtoms.has(out.atoms[j].id)) s += 100;
        if (rings.inRing(j)) s += 10;
        s += view.nbrs[j].length;
        if (out.atoms[j].element === 'H') s -= 5;
        return s;
      }
      chosen = candidates[0]?.b;
      if (!chosen) continue;
      if (chosen.a1 !== a.id) {
        const t = chosen.a1;
        chosen.a1 = chosen.a2;
        chosen.a2 = t;
      }
    }
    chosen.wedge = 'up';
    const trial = stereoFromWedges(out, new Set([a.id])).doc.atoms[i].stereo;
    if (!trial) continue;
    const same = sameConfiguration(trial.order, trial.parity, a.stereo.order, a.stereo.parity);
    if (!same) chosen.wedge = 'down';
  }
  return out;
}

export function sameConfiguration(o1: StereoNeighbour[], p1: 'cw' | 'ccw', o2: StereoNeighbour[], p2: 'cw' | 'ccw'): boolean {
  // Bring o1 into o2's order and compare parities.
  const idx = o2.map((x) => o1.indexOf(x));
  if (idx.some((k) => k < 0)) return false;
  let swaps = 0;
  const arr = [...idx];
  for (let k = 0; k < arr.length; k++) {
    while (arr[k] !== k) {
      const j = arr[k];
      [arr[k], arr[j]] = [arr[j], arr[k]];
      swaps++;
    }
  }
  const p1in2 = swaps % 2 === 0 ? p1 : p1 === 'cw' ? 'ccw' : 'cw';
  return p1in2 === p2;
}

/** Hydrogen coordinate keys for implicit H of an atom in a conformer. */
export function hydrogenKeys(conf: Conformer, atomId: AtomId): string[] {
  const out: string[] = [];
  for (let k = 1; k <= 4; k++) {
    const key = `${atomId}.h${k}`;
    if (conf.coordinates[key]) out.push(key);
  }
  return out;
}

/**
 * Stereo read from a 3D conformer (used when the author commits "use this 3D arrangement").
 */
export function stereoFromConformer(doc: MoleculeDocument, conf: Conformer, atomIds?: AtomId[]): MoleculeDocument {
  const out = structuredClone(doc);
  const view = new MolView(out);
  for (let i = 0; i < view.atomCount; i++) {
    const a = out.atoms[i];
    if (atomIds && !atomIds.includes(a.id)) continue;
    const nbrs = stereoNeighbourList(view, i);
    const c = conf.coordinates[a.id];
    if (!nbrs || !c) continue;
    const hs = hydrogenKeys(conf, a.id);
    const pos: Vec3[] = [];
    const explicit: Vec3[] = [];
    for (const nb of nbrs) {
      if (nb === 'H' || nb === 'LP') continue;
      const p = conf.coordinates[nb];
      if (p) explicit.push(p);
    }
    for (const nb of nbrs) {
      if (nb === 'H') pos.push(hs[0] ? conf.coordinates[hs[0]] : implicitPosition(c, explicit));
      else if (nb === 'LP') pos.push(implicitPosition(c, explicit));
      else pos.push(conf.coordinates[nb]);
    }
    if (pos.some((p) => !p)) continue;
    const parity = parityFromPositions(pos);
    if (parity) {
      a.stereo = { order: nbrs, parity };
      delete a.stereoUnknown;
    }
  }
  out.bonds.forEach((b) => {
    if (b.order !== 2) return;
    if (atomIds && !atomIds.includes(b.a1) && !atomIds.includes(b.a2)) return;
    const A = view.idx(b.a1);
    const B = view.idx(b.a2);
    const rA = view.nbrs[A].find((j) => j !== B);
    const rB = view.nbrs[B].find((j) => j !== A);
    if (rA === undefined || rB === undefined) return;
    const p = [out.atoms[rA].id, b.a1, b.a2, out.atoms[rB].id].map((id) => conf.coordinates[id]);
    if (p.some((x) => !x)) return;
    const d = Math.abs(dihedral(p[0], p[1], p[2], p[3]));
    b.stereo = { refs: [out.atoms[rA].id, out.atoms[rB].id], config: d < 90 ? 'cis' : 'trans' };
  });
  return out;
}

/** Dihedral angle in degrees (−180, 180]. */
export function dihedral(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const b0 = sub(p0, p1);
  const b1 = unit(sub(p2, p1));
  const b2 = sub(p3, p2);
  const v = sub(b0, scale(b1, dot(b0, b1)));
  const w = sub(b2, scale(b1, dot(b2, b1)));
  const x = dot(v, w);
  const y = dot(cross(b1, v), w);
  return (Math.atan2(y, x) * 180) / Math.PI;
}
