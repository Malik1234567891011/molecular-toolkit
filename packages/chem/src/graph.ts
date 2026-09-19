import { allowedValences, IMPLICIT_H_ELEMENTS } from './elements.ts';
import type { Atom, AtomId, Bond, BondId, MoleculeDocument } from './types.ts';

/**
 * Index-based, read-only view over a MoleculeDocument. Algorithms (rings, CIP, naming)
 * work on integer indices for speed and map back to stable ids at their boundaries.
 */
export class MolView {
  readonly atoms: Atom[];
  readonly bonds: Bond[];
  readonly index = new Map<AtomId, number>();
  readonly bondIndex = new Map<BondId, number>();
  /** nbrs[i] = neighbour atom indices; nbrBonds[i][k] is the bond to nbrs[i][k]. */
  readonly nbrs: number[][];
  readonly nbrBonds: number[][];
  private readonly hCache: number[];

  constructor(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>) {
    this.atoms = doc.atoms;
    this.bonds = doc.bonds;
    this.atoms.forEach((a, i) => this.index.set(a.id, i));
    this.bonds.forEach((b, i) => this.bondIndex.set(b.id, i));
    this.nbrs = this.atoms.map(() => []);
    this.nbrBonds = this.atoms.map(() => []);
    this.bonds.forEach((b, bi) => {
      const i = this.index.get(b.a1);
      const j = this.index.get(b.a2);
      if (i === undefined || j === undefined) return;
      this.nbrs[i].push(j);
      this.nbrBonds[i].push(bi);
      this.nbrs[j].push(i);
      this.nbrBonds[j].push(bi);
    });
    this.hCache = this.atoms.map(() => -1);
  }

  get atomCount(): number {
    return this.atoms.length;
  }

  idx(id: AtomId): number {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`No atom ${id}`);
    return i;
  }

  el(i: number): string {
    return this.atoms[i].element;
  }

  bondBetween(i: number, j: number): number {
    const k = this.nbrs[i].indexOf(j);
    return k < 0 ? -1 : this.nbrBonds[i][k];
  }

  order(bi: number): number {
    return this.bonds[bi].order;
  }

  other(bi: number, i: number): number {
    const b = this.bonds[bi];
    const a1 = this.index.get(b.a1)!;
    return a1 === i ? this.index.get(b.a2)! : a1;
  }

  bondOrderSum(i: number): number {
    let s = 0;
    for (const bi of this.nbrBonds[i]) s += this.bonds[bi].order;
    return s;
  }

  implicitH(i: number): number {
    if (this.hCache[i] >= 0) return this.hCache[i];
    const h = computeImplicitH(this.atoms[i], this.bondOrderSum(i));
    this.hCache[i] = h;
    return h;
  }

  /** Explicit H atoms bonded to i. */
  explicitHNeighbours(i: number): number {
    let n = 0;
    for (const j of this.nbrs[i]) if (this.atoms[j].element === 'H') n++;
    return n;
  }

  totalH(i: number): number {
    return this.implicitH(i) + this.explicitHNeighbours(i);
  }

  heavyNeighbours(i: number): number[] {
    return this.nbrs[i].filter((j) => this.atoms[j].element !== 'H');
  }

  heavyDegree(i: number): number {
    return this.heavyNeighbours(i).length;
  }

  /** Number of σ-bonded neighbours including all hydrogens (steric partner count). */
  coordination(i: number): number {
    return this.nbrs[i].length + this.implicitH(i);
  }

  hasMultipleBond(i: number): boolean {
    return this.nbrBonds[i].some((bi) => this.bonds[bi].order > 1);
  }

  multipleBondTo(i: number, element?: string): number {
    for (let k = 0; k < this.nbrs[i].length; k++) {
      const bi = this.nbrBonds[i][k];
      if (this.bonds[bi].order > 1 && (!element || this.el(this.nbrs[i][k]) === element)) return this.nbrs[i][k];
    }
    return -1;
  }

  /** Connected components as arrays of atom indices. */
  components(): number[][] {
    const seen = new Array(this.atoms.length).fill(false);
    const out: number[][] = [];
    for (let s = 0; s < this.atoms.length; s++) {
      if (seen[s]) continue;
      const comp: number[] = [];
      const stack = [s];
      seen[s] = true;
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        for (const j of this.nbrs[i]) if (!seen[j]) { seen[j] = true; stack.push(j); }
      }
      out.push(comp.sort((a, b) => a - b));
    }
    return out;
  }
}

/**
 * Implicit hydrogen count from the valence model. Fixed counts (bracket atoms) win.
 * Over-valent atoms get zero; validation reports them separately.
 */
export function computeImplicitH(atom: Atom, bondOrderSum: number): number {
  if (atom.explicitHydrogens !== undefined) return atom.explicitHydrogens;
  if (!IMPLICIT_H_ELEMENTS.has(atom.element)) return 0;
  const vals = allowedValences(atom.element, atom.formalCharge);
  if (!vals || vals.length === 0) return 0;
  const used = bondOrderSum + (atom.radicalElectrons ?? 0);
  for (const v of vals) if (v >= used) return v - used;
  return 0;
}

export interface ValenceState {
  used: number;
  allowed: number[] | undefined;
  typical: number | undefined;
  overValent: boolean;
  hypervalent: boolean;
}

export function valenceState(view: MolView, i: number): ValenceState {
  const a = view.atoms[i];
  const allowed = allowedValences(a.element, a.formalCharge);
  const used = view.bondOrderSum(i) + (a.radicalElectrons ?? 0) + (a.explicitHydrogens ?? 0);
  const typical = allowed?.[0];
  if (!allowed) return { used, allowed, typical, overValent: false, hypervalent: false };
  const max = Math.max(...allowed);
  return {
    used,
    allowed,
    typical,
    overValent: used > max,
    hypervalent: typical !== undefined && used > typical && used <= max,
  };
}

/** Capacity left for new bonds on atom i when it keeps its typical (non-hypervalent) state. */
export function freeValence(view: MolView, i: number, allowHypervalent = false): number {
  const a = view.atoms[i];
  const allowed = allowedValences(a.element, a.formalCharge);
  if (!allowed) return 8; // no model: do not block (metals etc.)
  const used = view.bondOrderSum(i) + (a.radicalElectrons ?? 0) + (a.explicitHydrogens ?? 0);
  const max = Math.max(...allowed);
  const cap = allowHypervalent ? max : allowed.find((v) => v >= used) ?? max;
  return Math.max(0, cap - used);
}

export function atomById(doc: Pick<MoleculeDocument, 'atoms'>, id: AtomId): Atom | undefined {
  return doc.atoms.find((a) => a.id === id);
}

export function bondBetweenIds(doc: Pick<MoleculeDocument, 'bonds'>, a: AtomId, b: AtomId): Bond | undefined {
  return doc.bonds.find((x) => (x.a1 === a && x.a2 === b) || (x.a1 === b && x.a2 === a));
}

export function neighbourIds(doc: Pick<MoleculeDocument, 'bonds'>, id: AtomId): AtomId[] {
  const out: AtomId[] = [];
  for (const b of doc.bonds) {
    if (b.a1 === id) out.push(b.a2);
    else if (b.a2 === id) out.push(b.a1);
  }
  return out;
}
