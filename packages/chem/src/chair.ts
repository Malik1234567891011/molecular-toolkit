/**
 * Cyclohexane-type chairs: axial/equatorial analysis and an animated ring flip
 * (chair → half-chair → boat → half-chair → flipped chair) that carries every substituent
 * rigidly on its own face, so configuration never changes while axial ↔ equatorial swap.
 */
import { MolView } from './graph.ts';
import { perceiveRings } from './rings.ts';
import { rotate, sideOfBond, v3 } from './geometry3d.ts';
import type { AtomId, MoleculeDocument, Vec3 } from './types.ts';

export interface ChairSubstituent {
  /** Coordinate key of the attached atom (an atom id, or `${ringAtom}.hN` for implicit H). */
  key: string;
  element: string;
  position: 'axial' | 'equatorial';
  face: 'up' | 'down';
}

export interface ChairAnalysis {
  /** Ring atoms in cyclic order. */
  ring: AtomId[];
  isChair: boolean;
  /** Out-of-plane displacement of each ring atom (Å) along `normal`. */
  z: number[];
  normal: Vec3;
  centre: Vec3;
  substituents: Record<AtomId, ChairSubstituent[]>;
}

/** Saturated six-membered rings not fused to another ring (a flip is well defined for these). */
export function chairRings(doc: MoleculeDocument): AtomId[][] {
  const view = new MolView(doc);
  const rings = perceiveRings(view);
  const out: AtomId[][] = [];
  for (const r of rings.rings) {
    if (r.atoms.length !== 6) continue;
    const members = new Set(r.atoms);
    const saturated = r.atoms.every((i) => !view.atoms[i].aromatic && view.nbrBonds[i].every((b) => view.bonds[b].order === 1));
    const isolated = r.atoms.every((i) => rings.atomRings[i].length === 1);
    if (!saturated || !isolated) continue;
    // Walk the ring so atoms come in bonded order.
    const order = [r.atoms[0]];
    while (order.length < 6) {
      const last = order[order.length - 1];
      const next = view.nbrs[last].find((j) => members.has(j) && !order.includes(j));
      if (next === undefined) break;
      order.push(next);
    }
    if (order.length === 6) out.push(order.map((i) => doc.atoms[i].id));
  }
  return out;
}

function planeNormal(points: Vec3[], c: Vec3): Vec3 {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = v3.sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
  }
  const tr = C[0][0] + C[1][1] + C[2][2];
  const M = C.map((row, i) => row.map((v, j) => (i === j ? tr - v : -v)));
  let v: Vec3 = [0.31, 0.42, 0.85];
  for (let it = 0; it < 80; it++) {
    const nv: Vec3 = [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
    v = v3.norm(nv);
  }
  return v;
}

function exocyclic(view: MolView, doc: MoleculeDocument, coords: Record<string, Vec3>, ringSet: Set<AtomId>, id: AtomId): Array<{ key: string; element: string }> {
  const i = view.idx(id);
  const out = view.nbrs[i].map((j) => doc.atoms[j]).filter((a) => !ringSet.has(a.id)).map((a) => ({ key: a.id, element: a.element }));
  for (let k = 1; k <= 4; k++) if (coords[`${id}.h${k}`]) out.push({ key: `${id}.h${k}`, element: 'H' });
  return out;
}

export function analyzeChair(doc: MoleculeDocument, coords: Record<string, Vec3>, ring: AtomId[]): ChairAnalysis | null {
  const pts = ring.map((a) => coords[a]);
  if (pts.some((p) => !p)) return null;
  const centre = v3.scale(pts.reduce((s, p) => v3.add(s, p), [0, 0, 0] as Vec3), 1 / 6);
  const normal = planeNormal(pts, centre);
  const z = pts.map((p) => v3.dot(v3.sub(p, centre), normal));
  const alternating = z.every((v, k) => Math.sign(v) !== Math.sign(z[(k + 1) % 6]) && Math.abs(v) > 0.12);
  const view = new MolView(doc);
  const ringSet = new Set(ring);
  const substituents: Record<AtomId, ChairSubstituent[]> = {};
  ring.forEach((id, k) => {
    const p = coords[id];
    substituents[id] = exocyclic(view, doc, coords, ringSet, id)
      .filter((s) => coords[s.key])
      .map((s) => {
        const d = v3.norm(v3.sub(coords[s.key], p));
        const along = v3.dot(d, normal);
        const face: 'up' | 'down' = along >= 0 ? 'up' : 'down';
        // In a chair the axial bond on an "up" atom points up; equatorial bonds tilt slightly the other way.
        const axial = Math.abs(along) > 0.75 || (alternating && face === (z[k] > 0 ? 'up' : 'down') && Math.abs(along) > 0.5);
        return { key: s.key, element: s.element, position: axial ? 'axial' : 'equatorial', face };
      });
  });
  return { ring, isChair: alternating, z, normal, centre, substituents };
}

const TETRA_HALF = (109.47 / 2) * (Math.PI / 180);

/**
 * Frames of a ring flip. Ring atoms keep their in-plane positions while the pucker inverts one
 * end at a time; substituents are carried rigidly and stay on their face. Returns null for
 * rings whose substituents loop back into the ring system.
 */
export function chairFlipFrames(doc: MoleculeDocument, coords: Record<string, Vec3>, ring: AtomId[], count = 48): { frames: Array<Record<string, Vec3>>; stages: string[] } | null {
  const a = analyzeChair(doc, coords, ring);
  if (!a) return null;
  const { centre: c, normal: n } = a;
  const p0 = ring.map((id) => coords[id]);
  const e1 = v3.norm(v3.sub(v3.sub(p0[0], c), v3.scale(n, v3.dot(v3.sub(p0[0], c), n))));
  const e2 = v3.cross(n, e1);
  const polar = p0.map((p) => {
    const d = v3.sub(p, c);
    return { x: v3.dot(d, e1), y: v3.dot(d, e2) };
  });
  const h = a.z.reduce((s, v) => s + Math.abs(v), 0) / 6 || 0.25;
  const sigma = Math.sign(a.z[0]) || 1;
  const z0 = a.z;
  const zf = z0.map((v) => -v);
  // Boat halfway: atoms 0 and 3 are the flagpoles on the far side from atom 0's start.
  const zb = [-sigma * 2 * h, sigma * h, sigma * h, -sigma * 2 * h, sigma * h, sigma * h];

  // Substituent fragments, each with its attached key and face.
  const view = new MolView(doc);
  const ringSet = new Set(ring);
  const frags: Array<{ ringIndex: number; key: string; keys: string[]; face: number }> = [];
  for (let k = 0; k < 6; k++) {
    const id = ring[k];
    for (const s of exocyclic(view, doc, coords, ringSet, id)) {
      if (!coords[s.key]) continue;
      let keys: string[];
      if (s.key.includes('.')) keys = [s.key];
      else {
        const side = sideOfBond(doc, id, s.key);
        if (!side) return null;
        const set = new Set(side);
        keys = Object.keys(coords).filter((key) => set.has(key.split('.')[0]));
      }
      frags.push({ ringIndex: k, key: s.key, keys, face: Math.sign(v3.dot(v3.sub(coords[s.key], p0[k]), n)) || 1 });
    }
  }

  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const frames: Array<Record<string, Vec3>> = [];
  const stages: string[] = [];
  for (let f = 0; f <= count; f++) {
    const t = f / count;
    const z = t <= 0.5 ? z0.map((v, k) => v + (zb[k] - v) * ease(t * 2)) : zb.map((v, k) => v + (zf[k] - v) * ease((t - 0.5) * 2));
    const ringPos = polar.map((q, k) => v3.add(c, v3.add(v3.add(v3.scale(e1, q.x), v3.scale(e2, q.y)), v3.scale(n, z[k]))));
    const out: Record<string, Vec3> = { ...coords };
    ring.forEach((id, k) => (out[id] = ringPos[k]));
    for (const fr of frags) {
      const k = fr.ringIndex;
      const p = ringPos[k];
      const u1 = v3.norm(v3.sub(p, ringPos[(k + 5) % 6]));
      const u2 = v3.norm(v3.sub(p, ringPos[(k + 1) % 6]));
      const bis = v3.norm(v3.add(u1, u2));
      const perp = v3.norm(v3.cross(u1, u2));
      const d1 = v3.add(v3.scale(bis, Math.cos(TETRA_HALF)), v3.scale(perp, Math.sin(TETRA_HALF)));
      const d2 = v3.sub(v3.scale(bis, Math.cos(TETRA_HALF)), v3.scale(perp, Math.sin(TETRA_HALF)));
      const dir = (Math.sign(v3.dot(d1, n)) || 1) === fr.face ? d1 : d2;
      const old = v3.norm(v3.sub(coords[fr.key], p0[k]));
      const axis = v3.cross(old, dir);
      const s = v3.len(axis);
      const ang = Math.atan2(s, v3.dot(old, dir));
      const kx = s > 1e-9 ? v3.scale(axis, 1 / s) : ([1, 0, 0] as Vec3);
      for (const key of fr.keys) {
        const rel = v3.sub(coords[key], p0[k]);
        out[key] = v3.add(p, s > 1e-9 ? rotate(rel, kx, ang) : rel);
      }
    }
    frames.push(out);
    stages.push(t < 0.08 ? 'chair' : t < 0.4 ? 'half-chair' : t < 0.6 ? 'twist-boat' : t < 0.92 ? 'half-chair' : 'chair (flipped)');
  }
  return { frames, stages };
}
