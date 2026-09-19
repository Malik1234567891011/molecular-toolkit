import { atomicNumber, isotopeMass } from './elements.ts';
import { MolView } from './graph.ts';
import { perceiveRings, type RingInfo } from './rings.ts';
import { permutationParity } from './smiles.ts';
import type { AtomId, MoleculeDocument, StereoNeighbour } from './types.ts';

/**
 * Cahn–Ingold–Prelog ranking over the hierarchical digraph (rules 1a and 2).
 * Rules 3–5 (like/unlike, pseudoasymmetry) are detected as ties and reported, never guessed.
 */

interface Node {
  atom: number; // -1 for implicit H / lone pair / phantom
  z: number;
  mass: number;
  dup: boolean;
  depth: number;
  path: number[]; // atom indices from root to this node (inclusive)
  parentAtom: number;
  kids?: Node[];
}

const H_MASS = 1.00782503223;

export class CipRanker {
  readonly view: MolView;
  private budget = 0;

  constructor(view: MolView) {
    this.view = view;
  }

  private node(atom: number, parentAtom: number, path: number[], depth: number, dup = false): Node {
    const a = this.view.atoms[atom];
    return {
      atom,
      z: atomicNumber(a.element),
      mass: a.isotope ? isotopeMass(a.element, a.isotope) : isotopeMass(a.element),
      dup,
      depth,
      path,
      parentAtom,
    };
  }

  private children(n: Node): Node[] {
    if (n.kids) return n.kids;
    const kids: Node[] = [];
    if (n.atom < 0 || n.dup) {
      n.kids = kids; // phantoms are represented by padding with Z = 0
      return kids;
    }
    this.budget++;
    const v = this.view;
    const i = n.atom;
    for (let k = 0; k < v.nbrs[i].length; k++) {
      const j = v.nbrs[i][k];
      const order = v.bonds[v.nbrBonds[i][k]].order;
      if (j === n.parentAtom) {
        // Duplicates for multiple bonds back to the parent.
        for (let d = 1; d < order; d++) kids.push(this.node(j, i, [...n.path, j], n.depth + 1, true));
        continue;
      }
      const onPath = n.path.includes(j);
      kids.push(this.node(j, i, [...n.path, j], n.depth + 1, onPath));
      if (!onPath) for (let d = 1; d < order; d++) kids.push(this.node(j, i, [...n.path, j], n.depth + 1, true));
    }
    const h = v.implicitH(i);
    for (let k = 0; k < h; k++) kids.push({ atom: -1, z: 1, mass: H_MASS, dup: false, depth: n.depth + 1, path: n.path, parentAtom: i, kids: [] });
    n.kids = kids;
    return kids;
  }

  private key(n: Node, rule: 1 | 2): number {
    return rule === 1 ? n.z : n.mass;
  }

  /** Sorted (descending priority) children of a node. */
  private sortedChildren(n: Node, rule: 1 | 2): Node[] {
    const kids = [...this.children(n)];
    kids.sort((x, y) => -this.compareNodes(x, y, rule));
    return kids;
  }

  /** >0 if a outranks b under `rule`, exploring sphere by sphere. */
  compareNodes(a: Node, b: Node, rule: 1 | 2): number {
    if (this.key(a, rule) !== this.key(b, rule)) return this.key(a, rule) - this.key(b, rule);
    let fa: Node[] = [a];
    let fb: Node[] = [b];
    for (let depth = 0; depth < 30; depth++) {
      if (this.budget > 200000) return 0;
      const setsA = fa.map((n) => this.sortedChildren(n, rule));
      const setsB = fb.map((n) => this.sortedChildren(n, rule));
      const len = Math.max(setsA.length, setsB.length);
      for (let s = 0; s < len; s++) {
        const sa = setsA[s] ?? [];
        const sb = setsB[s] ?? [];
        const m = Math.max(sa.length, sb.length, 3);
        for (let k = 0; k < m; k++) {
          const ka = sa[k] ? this.key(sa[k], rule) : 0;
          const kb = sb[k] ? this.key(sb[k], rule) : 0;
          if (ka !== kb) return ka - kb;
        }
      }
      fa = setsA.flat().filter((n) => n.atom >= 0 && !n.dup);
      fb = setsB.flat().filter((n) => n.atom >= 0 && !n.dup);
      if (!fa.length && !fb.length) return 0;
    }
    return 0;
  }

  /** Branch node for neighbour `nbr` of centre `centre` (or implicit H / lone pair). */
  branch(centre: number, nbr: StereoNeighbour | number): Node {
    if (nbr === 'H') return { atom: -1, z: 1, mass: H_MASS, dup: false, depth: 1, path: [centre], parentAtom: centre, kids: [] };
    if (nbr === 'LP') return { atom: -1, z: 0, mass: 0, dup: false, depth: 1, path: [centre], parentAtom: centre, kids: [] };
    const j = typeof nbr === 'number' ? nbr : this.view.idx(nbr);
    return this.node(j, centre, [centre, j], 1);
  }

  compareBranches(centre: number, x: StereoNeighbour | number, y: StereoNeighbour | number): number {
    const a = this.branch(centre, x);
    const b = this.branch(centre, y);
    const r1 = this.compareNodes(a, b, 1);
    if (r1 !== 0) return r1;
    return this.compareNodes(this.branch(centre, x), this.branch(centre, y), 2);
  }

  /**
   * Rank neighbours of `centre` (highest first). Returns null ranks entries that tie.
   */
  rank(centre: number, nbrs: Array<StereoNeighbour | number>): { order: Array<StereoNeighbour | number>; ties: boolean } {
    const sorted = [...nbrs].sort((x, y) => -this.compareBranches(centre, x, y));
    let ties = false;
    for (let k = 1; k < sorted.length; k++) if (this.compareBranches(centre, sorted[k - 1], sorted[k]) === 0) ties = true;
    return { order: sorted, ties };
  }

  /**
   * Explain why branch x outranks y: the sphere and the atom sets where they first differ.
   */
  explain(centre: number, x: StereoNeighbour | number, y: StereoNeighbour | number): CipDifference {
    const a = this.branch(centre, x);
    const b = this.branch(centre, y);
    for (const rule of [1, 2] as const) {
      if (this.key(a, rule) !== this.key(b, rule)) {
        return { sphere: 1, rule, setA: [labelOf(this.view, a)], setB: [labelOf(this.view, b)] };
      }
      let fa: Node[] = [a];
      let fb: Node[] = [b];
      for (let depth = 0; depth < 30; depth++) {
        const setsA = fa.map((n) => this.sortedChildren(n, rule));
        const setsB = fb.map((n) => this.sortedChildren(n, rule));
        const len = Math.max(setsA.length, setsB.length);
        for (let s = 0; s < len; s++) {
          const sa = setsA[s] ?? [];
          const sb = setsB[s] ?? [];
          const m = Math.max(sa.length, sb.length, 3);
          for (let k = 0; k < m; k++) {
            const ka = sa[k] ? this.key(sa[k], rule) : 0;
            const kb = sb[k] ? this.key(sb[k], rule) : 0;
            if (ka !== kb) {
              const pad = (arr: Node[]) => [...arr.map((n) => labelOf(this.view, n)), ...Array(Math.max(0, 3 - arr.length)).fill('0')];
              return { sphere: depth + 2, rule, setA: pad(sa), setB: pad(sb), atomsA: sa.filter((n) => n.atom >= 0).map((n) => this.view.atoms[n.atom].id), atomsB: sb.filter((n) => n.atom >= 0).map((n) => this.view.atoms[n.atom].id) };
            }
          }
        }
        fa = setsA.flat().filter((n) => n.atom >= 0 && !n.dup);
        fb = setsB.flat().filter((n) => n.atom >= 0 && !n.dup);
        if (!fa.length && !fb.length) break;
      }
    }
    return { sphere: 0, rule: 1, setA: [], setB: [] };
  }
}

export interface CipDifference {
  sphere: number;
  rule: 1 | 2;
  setA: string[];
  setB: string[];
  atomsA?: AtomId[];
  atomsB?: AtomId[];
}

function labelOf(view: MolView, n: Node): string {
  if (n.atom < 0) return n.z === 1 ? 'H' : n.z === 0 ? '0' : '?';
  const el = view.atoms[n.atom].element;
  return n.dup ? `(${el})` : el;
}

// ---------------------------------------------------------------------------------------------

export interface StereoCentre {
  atomId: AtomId;
  kind: 'tetrahedral';
  /** Neighbours in CIP priority order (1 = highest); 'H' / 'LP' for implicit. */
  priorities: StereoNeighbour[];
  specified: boolean;
  descriptor?: 'R' | 'S';
  /** True when CIP rules 1–2 cannot rank all four ligands (pseudoasymmetric / ring cis-trans). */
  needsHigherRules?: boolean;
}

export interface StereoBond {
  bondId: string;
  atoms: [AtomId, AtomId];
  /** Higher-priority substituent on each end. */
  high: [StereoNeighbour, StereoNeighbour];
  specified: boolean;
  descriptor?: 'E' | 'Z';
}

export interface StereoPerception {
  centres: StereoCentre[];
  bonds: StereoBond[];
  /** Atoms whose stereo is stored but which are no longer stereogenic. */
  staleCentres: AtomId[];
}

const TETRA_ELEMENTS = new Set(['C', 'Si', 'Ge', 'N', 'P', 'S', 'Se', 'B']);

function tetrahedralNeighbours(view: MolView, i: number): StereoNeighbour[] | null {
  const a = view.atoms[i];
  if (!TETRA_ELEMENTS.has(a.element)) return null;
  const nbrs: StereoNeighbour[] = view.nbrs[i].map((j) => view.atoms[j].id);
  const h = view.implicitH(i);
  if (h > 1) return null;
  if (h === 1) nbrs.push('H');
  const hasTriple = view.nbrBonds[i].some((b) => view.bonds[b].order === 3);
  if (hasTriple) return null;
  const doubles = view.nbrBonds[i].filter((b) => view.bonds[b].order === 2).length;
  if (a.element === 'C' || a.element === 'Si' || a.element === 'Ge' || a.element === 'B') {
    if (doubles) return null;
    if (nbrs.length !== 4) return null;
    return nbrs;
  }
  if (a.element === 'N') {
    // Only quaternary ammonium / N-oxides are configurationally stable in course scope.
    if (a.formalCharge === 1 && nbrs.length === 4 && !doubles) return nbrs;
    return null;
  }
  if (a.element === 'P') {
    if (nbrs.length === 4) return nbrs;
    if (nbrs.length === 3 && !doubles && a.formalCharge === 0) return [...nbrs, 'LP'];
    return null;
  }
  if (a.element === 'S' || a.element === 'Se') {
    // Sulfoxides (S=O with two substituents) and sulfonium ions carry a lone pair.
    if (nbrs.length === 3 && (doubles === 1 || a.formalCharge === 1)) return [...nbrs, 'LP'];
    return null;
  }
  return null;
}

export function perceiveStereo(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>, ringInfo?: RingInfo): StereoPerception {
  const view = new MolView(doc);
  const rings = ringInfo ?? perceiveRings(view);
  const cip = new CipRanker(view);
  const centres: StereoCentre[] = [];
  const staleCentres: AtomId[] = [];
  for (let i = 0; i < view.atomCount; i++) {
    const a = view.atoms[i];
    const nbrs = tetrahedralNeighbours(view, i);
    if (!nbrs) {
      if (a.stereo) staleCentres.push(a.id);
      continue;
    }
    const { order, ties } = cip.rank(i, nbrs);
    if (ties) {
      // Ring cis/trans centres (1,4-disubstituted rings) tie on the two ring branches.
      const ringTie = rings.inRing(i) && isRingPseudoCentre(view, cip, i, nbrs, rings);
      if (ringTie) {
        centres.push({ atomId: a.id, kind: 'tetrahedral', priorities: order as StereoNeighbour[], specified: !!a.stereo, needsHigherRules: true });
      } else if (a.stereo) staleCentres.push(a.id);
      continue;
    }
    const centre: StereoCentre = { atomId: a.id, kind: 'tetrahedral', priorities: order as StereoNeighbour[], specified: !!a.stereo && !a.stereoUnknown };
    if (centre.specified && a.stereo) {
      const d = descriptorFromParity(a.stereo.order, a.stereo.parity, centre.priorities);
      if (d) centre.descriptor = d;
      else {
        centre.specified = false;
        staleCentres.push(a.id);
      }
    }
    centres.push(centre);
  }

  const bonds: StereoBond[] = [];
  view.bonds.forEach((b, bi) => {
    if (b.order !== 2) return;
    const A = view.idx(b.a1);
    const B = view.idx(b.a2);
    if (b.aromatic) return;
    // Double bonds in rings of fewer than 8 atoms are fixed cis.
    const small = rings.bondRings[bi].some((r) => rings.rings[r].atoms.length < 8);
    if (small) return;
    const subs = (x: number, y: number): StereoNeighbour[] | null => {
      const list: StereoNeighbour[] = view.nbrs[x].filter((j) => j !== y).map((j) => view.atoms[j].id);
      const h = view.implicitH(x);
      for (let k = 0; k < h; k++) list.push('H');
      const el = view.el(x);
      if (el === 'N' && list.length === 1) list.push('LP');
      if (list.length !== 2) return null;
      if (list[0] === 'H' && list[1] === 'H') return null;
      return list;
    };
    const sA = subs(A, B);
    const sB = subs(B, A);
    if (!sA || !sB) return;
    const rankEnd = (x: number, y: number, s: StereoNeighbour[]): StereoNeighbour | null => {
      // Rank the two substituents on end x, exploring away from the double bond partner y.
      const cmp = cip.compareBranches(x, s[0], s[1]);
      if (cmp === 0) return null;
      return cmp > 0 ? s[0] : s[1];
    };
    const hA = rankEnd(A, B, sA);
    const hB = rankEnd(B, A, sB);
    if (!hA || !hB) return;
    const sb: StereoBond = { bondId: b.id, atoms: [b.a1, b.a2], high: [hA, hB], specified: !!b.stereo && !b.stereoUnknown };
    if (sb.specified && b.stereo) {
      // Translate the stored cis/trans relation to the high-priority pair.
      let config = b.stereo.config;
      const [r1, r2] = b.stereo.refs;
      if (r1 !== hA) config = config === 'cis' ? 'trans' : 'cis';
      if (r2 !== hB) config = config === 'cis' ? 'trans' : 'cis';
      if (!sA.includes(r1) || !sB.includes(r2)) sb.specified = false;
      else sb.descriptor = config === 'cis' ? 'Z' : 'E';
    }
    bonds.push(sb);
  });
  return { centres, bonds, staleCentres };
}

function isRingPseudoCentre(view: MolView, cip: CipRanker, i: number, nbrs: StereoNeighbour[], rings: RingInfo): boolean {
  const ringNbrs = nbrs.filter((n) => n !== 'H' && n !== 'LP' && rings.inRing(view.idx(n)) && rings.atomRings[i].some((r) => rings.atomRings[view.idx(n)].includes(r)));
  const others = nbrs.filter((n) => !ringNbrs.includes(n));
  if (ringNbrs.length !== 2 || others.length !== 2) return false;
  if (cip.compareBranches(i, ringNbrs[0], ringNbrs[1]) !== 0) return false;
  if (cip.compareBranches(i, others[0], others[1]) === 0) return false;
  // Another substituted ring atom must exist in the same ring for cis/trans to matter.
  const ring = rings.rings[rings.atomRings[i][0]];
  return ring.atoms.some((x) => x !== i && view.nbrs[x].some((y) => !ring.atoms.includes(y)) );
}

/**
 * CIP descriptor from a stored parity. priorities[0] is the highest-ranked ligand.
 */
export function descriptorFromParity(order: StereoNeighbour[], parity: 'cw' | 'ccw', priorities: StereoNeighbour[]): 'R' | 'S' | undefined {
  // View from the lowest-priority ligand: arrange order as [lowest, p1, p2, p3].
  const target: StereoNeighbour[] = [priorities[3], priorities[0], priorities[1], priorities[2]];
  const p = permutationParity(order, target);
  if (p === null) return undefined;
  const fromLowest = p === 0 ? parity : parity === 'cw' ? 'ccw' : 'cw';
  // Clockwise seen from the lowest ligand is counter-clockwise with the lowest pointing away.
  return fromLowest === 'cw' ? 'S' : 'R';
}

/** Parity that realises descriptor d for the given neighbour order and priorities. */
export function parityForDescriptor(order: StereoNeighbour[], priorities: StereoNeighbour[], d: 'R' | 'S'): 'cw' | 'ccw' {
  const cw = descriptorFromParity(order, 'cw', priorities);
  return cw === d ? 'cw' : 'ccw';
}

/** Neighbour list used for storing new stereo on an atom (explicit ids, then H/LP). */
export function stereoNeighbourList(view: MolView, i: number): StereoNeighbour[] | null {
  return tetrahedralNeighbours(view, i);
}
