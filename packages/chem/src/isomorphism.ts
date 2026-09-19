import { MolView } from './graph.ts';
import type { MoleculeDocument } from './types.ts';

/** Atom invariant used to prune the search: element, charge, H count, heavy degree, isotope. */
function invariant(v: MolView, i: number): string {
  const a = v.atoms[i];
  return `${a.element}|${a.formalCharge}|${v.totalH(i)}|${v.heavyDegree(i)}|${a.isotope ?? 0}`;
}

/**
 * Constitutional isomorphism (stereo ignored), with explicit H folded into counts.
 * Returns a mapping from atoms of `a` to atoms of `b`, or null.
 */
export function findIsomorphism(a: Pick<MoleculeDocument, 'atoms' | 'bonds'>, b: Pick<MoleculeDocument, 'atoms' | 'bonds'>): Map<number, number> | null {
  const va = new MolView(a);
  const vb = new MolView(b);
  const ha = a.atoms.map((_, i) => i).filter((i) => va.el(i) !== 'H' || va.nbrs[i].length === 0);
  const hb = b.atoms.map((_, i) => i).filter((i) => vb.el(i) !== 'H' || vb.nbrs[i].length === 0);
  if (ha.length !== hb.length) return null;
  const ia = ha.map((i) => invariant(va, i));
  const ib = hb.map((i) => invariant(vb, i));
  if ([...ia].sort().join() !== [...ib].sort().join()) return null;
  const invA = new Map(ha.map((i, k) => [i, ia[k]]));
  const invB = new Map(hb.map((i, k) => [i, ib[k]]));
  // Order atoms of a so each atom (after the first) has an already-mapped neighbour when possible.
  const order: number[] = [];
  const seen = new Set<number>();
  for (const s of ha) {
    if (seen.has(s)) continue;
    const q = [s];
    seen.add(s);
    while (q.length) {
      const x = q.shift()!;
      order.push(x);
      for (const y of va.heavyNeighbours(x)) if (!seen.has(y)) { seen.add(y); q.push(y); }
    }
  }
  const map = new Map<number, number>();
  const used = new Set<number>();
  const bondOrder = (v: MolView, i: number, j: number) => {
    const bi = v.bondBetween(i, j);
    return bi < 0 ? 0 : v.bonds[bi].order;
  };
  const rec = (k: number): boolean => {
    if (k === order.length) return true;
    const x = order[k];
    const mappedNbr = va.heavyNeighbours(x).find((y) => map.has(y));
    const pool = mappedNbr !== undefined ? vb.heavyNeighbours(map.get(mappedNbr)!) : hb;
    for (const y of pool) {
      if (used.has(y) || invB.get(y) !== invA.get(x)) continue;
      let ok = true;
      for (const xn of va.heavyNeighbours(x)) {
        const yn = map.get(xn);
        if (yn === undefined) continue;
        if (bondOrder(va, x, xn) !== bondOrder(vb, y, yn)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      map.set(x, y);
      used.add(y);
      if (rec(k + 1)) return true;
      map.delete(x);
      used.delete(y);
    }
    return false;
  };
  return rec(0) ? map : null;
}

export function sameConstitution(a: Pick<MoleculeDocument, 'atoms' | 'bonds'>, b: Pick<MoleculeDocument, 'atoms' | 'bonds'>): boolean {
  return findIsomorphism(a, b) !== null;
}
