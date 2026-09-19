import type { AtomId, BondId } from '../types.ts';
import type { CGKind } from './groups.ts';

export type TokenRole =
  | 'stereo' | 'locant' | 'multiplier' | 'substituent' | 'parent' | 'unsaturation' | 'suffix' | 'punct'
  | 'enclosure' | 'word' | 'hydro';

/** One piece of the name string, linked to the atoms it describes (spec §9.4, "click a word"). */
export interface NameToken {
  text: string;
  role: TokenRole;
  atomIds: AtomId[];
  bondIds?: BondId[];
  /** Links related tokens: 'sub:3' (substituent group 3), 'parent', 'suffix', 'stereo'. */
  ref?: string;
}

export type ProvenanceStatus =
  | 'verified_systematic' | 'database_name' | 'accepted_common' | 'course_convention'
  | 'candidate_verified' | 'unverified_candidate';

export interface ParentAlternative {
  atomIds: AtomId[];
  label: string;
  rejectedBecause: string;
  criterion: string;
  /** Values compared at the deciding criterion (winner vs this one). */
  values?: { chosen: string; alternative: string };
}

export interface NumberingAlternative {
  orderedAtomIds: AtomId[];
  locants: number[];
  criterion: string;
  firstPointOfDifference: string;
  chosenLocants: number[];
}

export interface SubstituentTrace {
  text: string;
  atomIds: AtomId[];
  attachmentAtomId: AtomId;
  locant: number | string;
  colorIndex: number;
}

export interface StereoTrace {
  atomIds: AtomId[];
  kind: 'R/S' | 'E/Z' | 'cis/trans';
  descriptor: string;
  locant?: number | string;
  /** Ligands in CIP order (highest first); 'H' for implicit hydrogen. */
  priorities?: Array<{ atomId: AtomId | 'H' | 'LP'; rank: number }>;
  lowestPriority?: AtomId | 'H' | 'LP';
  explanation: string;
}

export interface NamingTrace {
  name: string;
  status: ProvenanceStatus | 'pending_verification';
  principalGroup: {
    kind: CGKind | null;
    label: string;
    atomIds: AtomId[];
    present: Array<{ kind: CGKind; label: string; atomIds: AtomId[]; rank: number }>;
    explanation: string;
  };
  parent: {
    atomIds: AtomId[];
    root: string;
    kind: 'chain' | 'ring';
    label: string;
    alternatives: ParentAlternative[];
    explanation: string;
  };
  numbering: {
    orderedAtomIds: AtomId[];
    reason: string;
    alternative?: NumberingAlternative;
    locantOf: Record<AtomId, number>;
  };
  substituents: SubstituentTrace[];
  stereo: StereoTrace[];
  unspecifiedStereo: AtomId[];
  assembly: string[];
  tokens: NameToken[];
  engineVersion: string;
  profileId: string;
}

export interface AlternativeName {
  name: string;
  kind: 'systematic' | 'traditional-locants' | 'common-prefixes' | 'cas-style' | 'retained' | 'functional-class' | 'older-rules' | 'stereo-variant';
  note: string;
  /** Profile that yields this as its preferred form, if any. */
  profileId?: string;
}

export interface NamingResult {
  ok: boolean;
  name?: string;
  tokens?: NameToken[];
  trace?: NamingTrace;
  alternatives: AlternativeName[];
  /** Why the course engine declined (outside verified scope) — never a guess. */
  unsupportedReason?: string;
  warnings: string[];
  engineVersion: string;
}
