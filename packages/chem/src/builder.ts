import { emptyDocument, type Atom, type AtomId, type Bond, type BondId, type BondOrder, type MoleculeDocument, type Vec2 } from './types.ts';

/** Mutable helper used by parsers and templates to assemble a document with sequential ids. */
export class DocBuilder {
  readonly doc: MoleculeDocument;

  constructor(base?: MoleculeDocument) {
    this.doc = base ? structuredClone(base) : emptyDocument();
  }

  addAtom(element: string, props: Partial<Omit<Atom, 'id' | 'element'>> = {}, at?: Vec2): AtomId {
    const id = `a${this.doc.nextAtom++}`;
    this.doc.atoms.push({ id, element, formalCharge: 0, aromatic: false, ...props });
    if (at) this.doc.layout2d[id] = at;
    return id;
  }

  addBond(a1: AtomId, a2: AtomId, order: BondOrder = 1, props: Partial<Omit<Bond, 'id' | 'a1' | 'a2' | 'order'>> = {}): BondId {
    if (a1 === a2) throw new Error('Cannot bond an atom to itself');
    const existing = this.doc.bonds.find((b) => (b.a1 === a1 && b.a2 === a2) || (b.a1 === a2 && b.a2 === a1));
    if (existing) throw new Error(`Atoms ${a1} and ${a2} are already bonded`);
    const id = `b${this.doc.nextBond++}`;
    this.doc.bonds.push({ id, a1, a2, order, aromatic: false, ...props });
    return id;
  }

  atom(id: AtomId): Atom {
    const a = this.doc.atoms.find((x) => x.id === id);
    if (!a) throw new Error(`No atom ${id}`);
    return a;
  }
}

/** Deep copy with fresh ids offset, used when merging fragments into an existing document. */
export function mergeDocuments(target: MoleculeDocument, source: MoleculeDocument, offset: Vec2 = [0, 0]): { doc: MoleculeDocument; idMap: Map<AtomId, AtomId> } {
  const doc = structuredClone(target);
  const idMap = new Map<AtomId, AtomId>();
  for (const a of source.atoms) {
    const id = `a${doc.nextAtom++}`;
    idMap.set(a.id, id);
  }
  for (const a of source.atoms) {
    const copy: Atom = { ...structuredClone(a), id: idMap.get(a.id)! };
    if (copy.stereo) copy.stereo = { ...copy.stereo, order: copy.stereo.order.map((n) => (n === 'H' || n === 'LP' ? n : idMap.get(n)!)) };
    doc.atoms.push(copy);
    const p = source.layout2d[a.id];
    if (p) doc.layout2d[copy.id] = [p[0] + offset[0], p[1] + offset[1]];
  }
  for (const b of source.bonds) {
    const copy: Bond = { ...structuredClone(b), id: `b${doc.nextBond++}`, a1: idMap.get(b.a1)!, a2: idMap.get(b.a2)! };
    if (copy.stereo) copy.stereo = { ...copy.stereo, refs: [idMap.get(copy.stereo.refs[0])!, idMap.get(copy.stereo.refs[1])!] };
    doc.bonds.push(copy);
  }
  return { doc, idMap };
}
