import { allowedValences } from './elements.ts';
import { MolView } from './graph.ts';
import type { BondId, MoleculeDocument } from './types.ts';

/**
 * Re-assign alternating single/double bonds over `bondIds` (e.g. after fusing a benzene ring
 * onto an existing aromatic bond) so every carbon keeps a valid valence. Returns null if no
 * Kekulé structure exists.
 */
export function kekulizeBonds(input: MoleculeDocument, bondIds: BondId[]): MoleculeDocument | null {
  const doc = structuredClone(input);
  const set = new Set(bondIds);
  for (const b of doc.bonds) if (set.has(b.id)) b.order = 1;
  const view = new MolView(doc);
  const atomsIn = new Set<number>();
  for (const b of doc.bonds) if (set.has(b.id)) {
    atomsIn.add(view.idx(b.a1));
    atomsIn.add(view.idx(b.a2));
  }
  const needs = (i: number) => {
    const a = doc.atoms[i];
    if (a.explicitHydrogens !== undefined) return false;
    const vals = allowedValences(a.element, a.formalCharge);
    if (!vals) return false;
    const used = view.bondOrderSum(i);
    // A ring carbon with 3 σ partners (incl. one H) and no double bond yet needs one.
    if (a.element === 'C') return a.formalCharge === 0 && view.nbrs[i].length <= 3 && vals[0] - used >= 1;
    if (a.element === 'N' || a.element === 'P') return view.nbrs[i].length === 2 && used === 2;
    return false;
  };
  const targets = [...atomsIn].filter(needs);
  const adj = new Map<number, Array<{ nb: number; bond: number }>>();
  for (const t of targets) adj.set(t, []);
  doc.bonds.forEach((b, bi) => {
    if (!set.has(b.id)) return;
    const x = view.idx(b.a1);
    const y = view.idx(b.a2);
    if (adj.has(x) && adj.has(y)) {
      adj.get(x)!.push({ nb: y, bond: bi });
      adj.get(y)!.push({ nb: x, bond: bi });
    }
  });
  const matched = new Map<number, number>();
  const solve = (): boolean => {
    let best = -1;
    let opts: Array<{ nb: number; bond: number }> = [];
    for (const t of targets) {
      if (matched.has(t)) continue;
      const o = adj.get(t)!.filter((e) => !matched.has(e.nb));
      if (!o.length) return false;
      if (best < 0 || o.length < opts.length) {
        best = t;
        opts = o;
      }
    }
    if (best < 0) return true;
    for (const o of opts) {
      matched.set(best, o.bond);
      matched.set(o.nb, o.bond);
      if (solve()) return true;
      matched.delete(best);
      matched.delete(o.nb);
    }
    return false;
  };
  if (!solve()) return null;
  for (const bi of new Set(matched.values())) doc.bonds[bi].order = 2;
  return doc;
}
