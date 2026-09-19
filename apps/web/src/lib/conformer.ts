'use client';
import { MolView, dihedralDeg, rotateFragment, sideOfBond, atomicNumber, type AtomId, type BondId, type Vec3 } from '@orbital/chem';
import { studio, useStudio } from './store';
import { call } from './worker';

/** Reference atoms for the dihedral of a bond: heaviest substituent on each end (H if none). */
export function dihedralFor(bondId: BondId): [AtomId, AtomId, AtomId, AtomId] | null {
  const doc = studio().doc;
  const b = doc.bonds.find((x) => x.id === bondId);
  if (!b) return null;
  const view = new MolView(doc);
  const pick = (end: AtomId, other: AtomId): AtomId => {
    const i = view.idx(end);
    const nbrs = view.nbrs[i].map((j) => doc.atoms[j]).filter((a) => a.id !== other);
    nbrs.sort((x, y) => atomicNumber(y.element) - atomicNumber(x.element));
    return nbrs[0]?.id ?? `${end}.h1`;
  };
  return [pick(b.a1, b.a2), b.a1, b.a2, pick(b.a2, b.a1)];
}

export function currentDihedral(dih: [string, string, string, string]): number | null {
  const doc = studio().doc;
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  const p = dih.map((k) => conf?.coordinates[k]);
  if (p.some((x) => !x)) return null;
  return dihedralDeg(p[0] as Vec3, p[1] as Vec3, p[2] as Vec3, p[3] as Vec3);
}

/** Rotate the smaller fragment about a bond by `delta` degrees (graph identity unchanged). */
export function rotateBond(bondId: BondId, delta: number): void {
  const s = studio();
  const doc = s.doc;
  const b = doc.bonds.find((x) => x.id === bondId);
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  if (!b || !conf) return;
  const sideB = sideOfBond(doc, b.a1, b.a2);
  const sideA = sideOfBond(doc, b.a2, b.a1);
  if (!sideA || !sideB) return;
  const moveB = sideB.length <= sideA.length;
  const side = moveB ? sideB : sideA;
  const from = conf.coordinates[moveB ? b.a1 : b.a2];
  const to = conf.coordinates[moveB ? b.a2 : b.a1];
  const coords = rotateFragment(conf.coordinates, side, from, to, moveB ? delta : -delta);
  s.setConformer({ ...conf, coordinates: coords, converged: false, method: `${conf.method.replace(/ \(rotated.*\)$/, '')} (rotated by hand, not re-minimized)` }, 'relaxed', 'Bond rotated by hand — press Relax to re-minimize.');
  scheduleLiveEnergy();
}

let energyTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleLiveEnergy() {
  clearTimeout(energyTimer);
  energyTimer = setTimeout(async () => {
    const s = studio();
    const conf = s.doc.conformers.find((c) => c.id === s.doc.selectedConformerId) ?? s.doc.conformers[0];
    if (!conf) return;
    try {
      const e = await call<number>('energy', { doc: { ...s.doc, conformers: [] }, coords: conf.coordinates });
      useStudio.setState({ liveEnergy: e });
    } catch {
      /* ignore */
    }
  }, 40);
}

export async function computeScan(bondId: BondId): Promise<void> {
  const s = studio();
  const dih = dihedralFor(bondId);
  const conf = s.doc.conformers.find((c) => c.id === s.doc.selectedConformerId) ?? s.doc.conformers[0];
  if (!dih || !conf) return;
  try {
    const r = await call<{ angles: number[]; energies: number[]; method: string }>('scan', { doc: { ...s.doc, conformers: [] }, coords: conf.coordinates, dihedral: dih, step: 10 });
    const start = currentDihedral(dih) ?? 0;
    // The scan rotates from the current geometry, so angle 0 corresponds to the current dihedral.
    const angles = r.angles.map((a) => ((((start + a + 180) % 360) + 360) % 360) - 180);
    const e0 = await call<number>('energy', { doc: { ...s.doc, conformers: [] }, coords: conf.coordinates });
    const minRaw = e0 - r.energies[0];
    useStudio.setState({ scan: { bondId, dihedral: dih, angles, energies: r.energies, method: r.method, e0: minRaw }, liveEnergy: e0 });
  } catch (e) {
    s.notify({ kind: 'warning', text: `Energy scan unavailable: ${(e as Error).message}` });
  }
}
