/**
 * Canonical molecule schema (spec §16). The graph is the single source of truth; 2D layout
 * and 3D conformers are views of it. Ids are stable across edits so highlights, name tokens
 * and undo history survive coordinate regeneration.
 */

export type AtomId = string;
export type BondId = string;

/** Kekulé bond order. Aromaticity is a perceived flag, never a fourth order in the live graph. */
export type BondOrder = 1 | 2 | 3;

/** Placeholder neighbours used in stereo neighbour orders. */
export type ImplicitNeighbour = 'H' | 'LP';
export type StereoNeighbour = AtomId | ImplicitNeighbour;

/**
 * Tetrahedral configuration, stored relative to explicit neighbours so it survives edits.
 * Looking from `order[0]` toward the centre, `order[1..3]` run clockwise ('cw') or
 * counter-clockwise ('ccw'). 'H' stands for the single implicit hydrogen, 'LP' for a lone pair.
 */
export interface TetrahedralStereo {
  order: StereoNeighbour[];
  parity: 'cw' | 'ccw';
}

/**
 * Double-bond configuration relative to one reference neighbour on each end.
 * refs[0] is a neighbour of bond.a1, refs[1] a neighbour of bond.a2.
 */
export interface DoubleBondStereo {
  refs: [AtomId, AtomId];
  config: 'cis' | 'trans';
}

export interface Atom {
  id: AtomId;
  element: string;
  isotope?: number;
  formalCharge: number;
  radicalElectrons?: number;
  /** Perceived; recomputed after every connectivity edit. */
  aromatic: boolean;
  /** Fixed hydrogen count (bracket atoms, metals). Undefined = derived from valence. */
  explicitHydrogens?: number;
  stereo?: TetrahedralStereo;
  /** Set when the author explicitly asked for "unknown" (wavy bond) at this centre. */
  stereoUnknown?: boolean;
  mapNumber?: number;
}

export interface Bond {
  id: BondId;
  a1: AtomId;
  a2: AtomId;
  order: BondOrder;
  /** Perceived; recomputed after every connectivity edit. */
  aromatic: boolean;
  /** 2D depiction only. Narrow end is a1. */
  wedge?: 'up' | 'down' | 'either';
  stereo?: DoubleBondStereo;
  /** Author explicitly marked the double bond configuration as unknown (crossed/wavy). */
  stereoUnknown?: boolean;
}

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Conformer {
  id: string;
  /** Heavy atoms keyed by AtomId; implicit hydrogens keyed `${atomId}.h${n}`. */
  coordinates: Record<string, Vec3>;
  method: string;
  energy?: number;
  converged?: boolean;
  /** Human-readable caveat shown next to geometry values. */
  note?: string;
}

export interface ProvenanceEvent {
  at: number;
  kind: 'import' | 'edit' | 'name' | 'conformer' | 'validation' | 'tutor';
  detail: string;
  engine?: string;
}

export interface MoleculeDocument {
  schemaVersion: 1;
  title?: string;
  atoms: Atom[];
  bonds: Bond[];
  /** 2D depiction coordinates in Ångström-like units (bond length ≈ 1.5). */
  layout2d: Record<AtomId, Vec2>;
  conformers: Conformer[];
  selectedConformerId?: string;
  /** Monotonic id counters so ids are never reused within a document. */
  nextAtom: number;
  nextBond: number;
  canonicalSmiles?: string;
  inchi?: string;
  inchiKey?: string;
  provenance: ProvenanceEvent[];
}

export function emptyDocument(title?: string): MoleculeDocument {
  return {
    schemaVersion: 1,
    title,
    atoms: [],
    bonds: [],
    layout2d: {},
    conformers: [],
    nextAtom: 1,
    nextBond: 1,
    provenance: [],
  };
}
