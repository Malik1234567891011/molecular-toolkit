import { MolView } from './graph.ts';
import type { AtomId, Conformer, MoleculeDocument } from './types.ts';

/**
 * Fold ordinary explicit hydrogen atoms into implicit counts, keeping their 3D positions as
 * conformer hydrogens (`${parent}.h${n}`) and rewriting stereo references to 'H'.
 * Isotopic, charged, bridging or H–H hydrogens stay explicit.
 */
export function suppressHydrogens(doc: MoleculeDocument): MoleculeDocument {
  const view = new MolView(doc);
  const remove = new Set<number>();
  const parentOf = new Map<number, number>();
  doc.atoms.forEach((a, i) => {
    if (a.element !== 'H' || a.isotope || a.formalCharge || a.radicalElectrons) return;
    if (view.nbrs[i].length !== 1) return;
    const p = view.nbrs[i][0];
    if (doc.atoms[p].element === 'H') return;
    if (doc.bonds[view.nbrBonds[i][0]].order !== 1) return;
    // Keep H on atoms whose H count is fixed (bracket-style atoms) to avoid double counting.
    remove.add(i);
    parentOf.set(i, p);
  });
  if (!remove.size) return doc;
  // Each parent may keep at most one 'H' placeholder in its stereo order.
  const out = structuredClone(doc);
  const removedIds = new Set([...remove].map((i) => doc.atoms[i].id));
  const hCountAdded = new Map<number, number>();
  for (const [h, p] of parentOf) hCountAdded.set(p, (hCountAdded.get(p) ?? 0) + 1);
  out.atoms = out.atoms.filter((a) => !removedIds.has(a.id));
  out.bonds = out.bonds.filter((b) => !removedIds.has(b.a1) && !removedIds.has(b.a2));
  for (const a of out.atoms) {
    const i = view.idx(a.id);
    const added = hCountAdded.get(i) ?? 0;
    if (a.explicitHydrogens !== undefined && added) a.explicitHydrogens += added;
    if (a.stereo) {
      const order = a.stereo.order.map((n) => (removedIds.has(n) ? 'H' : n));
      if (order.filter((n) => n === 'H').length > 1) delete a.stereo;
      else a.stereo = { ...a.stereo, order };
    }
  }
  for (const b of out.bonds) {
    if (b.stereo && (removedIds.has(b.stereo.refs[0]) || removedIds.has(b.stereo.refs[1]))) {
      // Re-express relative to heavy neighbours when possible.
      const flip = (ref: AtomId, end: AtomId, other: AtomId): { ref: AtomId; flipped: boolean } | null => {
        if (!removedIds.has(ref)) return { ref, flipped: false };
        const alt = out.bonds
          .filter((x) => x.id !== b.id && (x.a1 === end || x.a2 === end))
          .map((x) => (x.a1 === end ? x.a2 : x.a1))
          .find((n) => n !== other);
        return alt ? { ref: alt, flipped: true } : null;
      };
      const r1 = flip(b.stereo.refs[0], b.a1, b.a2);
      const r2 = flip(b.stereo.refs[1], b.a2, b.a1);
      if (!r1 || !r2) delete b.stereo;
      else {
        let config = b.stereo.config;
        if (r1.flipped !== r2.flipped) config = config === 'cis' ? 'trans' : 'cis';
        b.stereo = { refs: [r1.ref, r2.ref], config };
      }
    }
  }
  for (const id of removedIds) delete out.layout2d[id];
  out.conformers = out.conformers.map((c): Conformer => {
    const coords = { ...c.coordinates };
    const counter = new Map<number, number>();
    for (const [h, p] of parentOf) {
      const hid = doc.atoms[h].id;
      const pos = c.coordinates[hid];
      delete coords[hid];
      if (!pos) continue;
      const n = (counter.get(p) ?? 0) + 1;
      counter.set(p, n);
      coords[`${doc.atoms[p].id}.h${n}`] = pos;
    }
    return { ...c, coordinates: coords };
  });
  return out;
}
