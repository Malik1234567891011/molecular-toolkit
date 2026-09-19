import { MolView } from './graph.ts';
import { perceiveRings, type RingInfo } from './rings.ts';
import type { MoleculeDocument } from './types.ts';

/**
 * π-electron contribution of atom i to ring `ringAtoms`, or null if the atom breaks
 * conjugation. Kekulé input: endocyclic double bonds contribute 1 per atom.
 */
function piContribution(view: MolView, i: number, ringSet: Set<number>): number | null {
  const a = view.atoms[i];
  let endoDouble = false;
  let exoDouble: number | null = null;
  for (let k = 0; k < view.nbrs[i].length; k++) {
    const j = view.nbrs[i][k];
    const b = view.bonds[view.nbrBonds[i][k]];
    if (b.order === 3) return null;
    if (b.order === 2) {
      if (ringSet.has(j)) endoDouble = true;
      else exoDouble = j;
    }
  }
  if (endoDouble) return 1;
  if (exoDouble !== null) {
    // Exocyclic C=O / C=N / C=S: the ring carbon contributes no π electrons (as in 2-pyridone).
    const x = view.el(exoDouble);
    if (a.element === 'C' && (x === 'O' || x === 'N' || x === 'S')) return 0;
    return null;
  }
  const el = a.element;
  const q = a.formalCharge;
  const deg = view.nbrs[i].length + view.implicitH(i);
  if (el === 'C') {
    if (q === -1) return 2;
    if (q === 1) return 0;
    return null; // sp3 carbon
  }
  if (el === 'N' || el === 'P') {
    if (q === 0 && deg === 3) return 2; // pyrrole-type
    if (q === -1 && deg === 2) return 2;
    return null;
  }
  if (el === 'O' || el === 'S' || el === 'Se' || el === 'Te') {
    if (q === 0 && deg === 2) return 2; // furan / thiophene type
    return null;
  }
  if (el === 'B' && q === 0 && deg === 3) return 0;
  return null;
}

function isHuckel(e: number): boolean {
  return e >= 2 && (e - 2) % 4 === 0;
}

/**
 * Mark aromatic atoms and bonds (Hückel 4n+2 over SSSR rings and fused pairs).
 * Returns a new document; the input is not mutated.
 */
export function perceiveAromaticity(doc: MoleculeDocument, info?: RingInfo): MoleculeDocument {
  const out = structuredClone(doc);
  const view = new MolView(out);
  const rings = info ?? perceiveRings(view);
  const aromaticAtoms = new Set<number>();
  const aromaticBonds = new Set<number>();
  const testSet = (atoms: number[], bonds: number[]): boolean => {
    const set = new Set(atoms);
    let e = 0;
    for (const a of atoms) {
      const c = piContribution(view, a, set);
      if (c === null) return false;
      e += c;
    }
    if (!isHuckel(e)) return false;
    atoms.forEach((a) => aromaticAtoms.add(a));
    bonds.forEach((b) => aromaticBonds.add(b));
    return true;
  };
  for (const r of rings.rings) {
    if (r.atoms.length > 24) continue;
    testSet(r.atoms, r.bonds);
  }
  // Fused pairs (azulene, some heteroaromatics) whose individual rings fail Hückel.
  for (let x = 0; x < rings.rings.length; x++) {
    for (let y = x + 1; y < rings.rings.length; y++) {
      const r1 = rings.rings[x];
      const r2 = rings.rings[y];
      const shared = r1.bonds.filter((b) => r2.bonds.includes(b));
      if (shared.length !== 1) continue;
      if (r1.atoms.every((a) => aromaticAtoms.has(a)) && r2.atoms.every((a) => aromaticAtoms.has(a))) continue;
      const atoms = [...new Set([...r1.atoms, ...r2.atoms])];
      const bonds = [...new Set([...r1.bonds, ...r2.bonds])];
      testSet(atoms, bonds);
    }
  }
  out.atoms.forEach((a, i) => (a.aromatic = aromaticAtoms.has(i)));
  out.bonds.forEach((b, i) => (b.aromatic = aromaticBonds.has(i)));
  return out;
}
