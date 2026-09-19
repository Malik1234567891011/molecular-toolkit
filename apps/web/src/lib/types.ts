import type {
  AtomId, BondId, FormulaInfo, FunctionalGroup, LocalGeometry, MoleculeDocument, StereoPerception, ValidationIssue, naming,
} from '@orbital/chem';

export interface Analysis {
  formula: FormulaInfo;
  validation: ValidationIssue[];
  groups: FunctionalGroup[];
  groupSummary: Array<{ kind: string; label: string; count: number }>;
  stereo: StereoPerception;
  geometry: Record<AtomId, LocalGeometry>;
  implicitH: Record<AtomId, number>;
  identifiers: null | {
    valid: boolean;
    smiles: string;
    canonicalSmiles?: string;
    inchi?: string;
    inchiKey?: string;
    descriptors?: { exactMass: number; molarMass: number; logP: number; tpsa: number; hbd: number; hba: number; rotatableBonds: number; rings: number; aromaticRings: number; fractionCSP3: number };
  };
  naming: naming.NamingResult | null;
  engine: { rdkit: string; naming: string };
  ms: number;
}

/** The six provenance labels (spec §4) plus transient states. */
export type Provenance = naming.ProvenanceStatus | 'pending' | 'offline' | 'unsupported';

export interface NameCandidate {
  name: string;
  provenance: Provenance;
  source: 'course-engine' | 'pubchem' | 'common' | 'stout' | 'course-convention';
  note?: string;
  verified: boolean;
}

export interface Verification {
  inchiKey: string;
  status: 'pending' | 'done' | 'offline' | 'error';
  /** Best name to show as the default answer. */
  primary?: NameCandidate;
  /** Other names that passed verification (accepted alternatives). */
  accepted: NameCandidate[];
  /** Names that failed round-trip (hidden under "unverified"). */
  unverified: NameCandidate[];
  /**
   * Database synonyms that parse to this structure but are not written the way the course
   * teaches (CAS inverted index names, prefixes out of alphabetical order, stray hyphens).
   * Shown for completeness under their own disclosure; never offered as answers.
   */
  other?: NameCandidate[];
  database?: { cid?: number; iupacName?: string; title?: string; synonyms?: string[] };
  ml?: { status: string; reason?: string };
  message?: string;
}

export interface Highlight {
  id: string;
  atoms: AtomId[];
  bonds: BondId[];
  tone: 'accent' | 'amber' | 'danger' | 'good' | 'faint' | 'palette';
  colorIndex?: number;
  label?: string;
  pulse?: boolean;
  /** Per-atom badges, e.g. locant numbers during the numbering step. */
  labels?: Record<AtomId, string>;
}

export interface InvalidAttempt {
  atomId: AtomId;
  title: string;
  message: string;
  fixes: Array<{ label: string; run: () => void }>;
  ghostTo?: [number, number, number];
  at: number;
}

export interface HistoryEntry {
  label: string;
  before: MoleculeDocument;
  after: MoleculeDocument;
  at: number;
}
