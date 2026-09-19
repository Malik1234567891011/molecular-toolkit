'use client';
/**
 * Practice (spec §13): problems grow out of molecules, grading is structural (OPSIN parse + graph
 * compare, never string compare), feedback is precise, and concepts are scheduled with a small
 * Leitner system. Everything is local-first; nothing here needs an account.
 */
import { create } from 'zustand';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { MolView, analyzeChair, applyCommand, chairFlipFrames, chairRings, naming, parseSmiles, v3, type AtomId, type BondId, type MoleculeDocument, type Vec3 } from '@orbital/chem';
import { api, isOnline, type CheckAnswerResponse } from './api';
import { track } from './analytics';
import { studio, useStudio } from './store';
import { call } from './worker';
import { loadStructure } from './actions';
import type { Analysis, Highlight } from './types';
import { currentDihedral, dihedralFor, rotateBond, rotationEnds } from './conformer';
import { bus } from './events';

// ---------------------------------------------------------------------------------------------
// Concepts and problem types

export type Concept = 'suffix' | 'parent' | 'locants' | 'alphabetization' | 'rs' | 'ez' | 'geometry' | 'groups' | 'acidity' | 'projection' | 'conformation' | 'build' | 'valence';

export const CONCEPTS: Array<{ id: Concept; label: string }> = [
  { id: 'parent', label: 'Parent chain' },
  { id: 'suffix', label: 'Suffix priority' },
  { id: 'locants', label: 'Locants' },
  { id: 'alphabetization', label: 'Alphabetization' },
  { id: 'rs', label: 'R / S' },
  { id: 'ez', label: 'E / Z' },
  { id: 'projection', label: 'Projections' },
  { id: 'conformation', label: 'Conformations' },
  { id: 'geometry', label: 'Geometry' },
  { id: 'groups', label: 'Functional groups' },
  { id: 'acidity', label: 'Acidity' },
  { id: 'build', label: 'Name → structure' },
  { id: 'valence', label: 'Valence' },
];

export type ProblemType = 'name' | 'build' | 'parent' | 'number' | 'principal' | 'stereo' | 'geometry' | 'groups' | 'acidity' | 'fischer' | 'repair' | 'newman' | 'chair';

export const TYPE_LABEL: Record<ProblemType, string> = {
  name: 'Name the structure', build: 'Build from the name', parent: 'Choose the parent chain', number: 'Number correctly',
  principal: 'Principal group', stereo: 'Assign the configuration', geometry: 'Predict the geometry', groups: 'Identify functional groups',
  acidity: 'Rank acidity', fischer: 'Match the projection', repair: 'Repair the structure', newman: 'Name the conformation',
  chair: 'Axial or equatorial',
};

const TYPES_FOR: Record<Concept, ProblemType[]> = {
  parent: ['parent', 'name'], suffix: ['principal', 'name'], locants: ['number', 'name'], alphabetization: ['name'],
  rs: ['stereo'], ez: ['stereo'], projection: ['fischer'], conformation: ['newman', 'chair'], geometry: ['geometry'], groups: ['groups'], acidity: ['acidity'],
  build: ['build'], valence: ['repair'],
};

export interface Choice {
  id: string;
  label: string;
}

export interface Problem {
  id: string;
  type: ProblemType;
  concept: Concept;
  level: number;
  prompt: string;
  sub?: string;
  source: 'bank' | 'molecule' | 'daily' | 'set';
  /** Molecule shown on the canvas (not for build problems). */
  smiles?: string;
  /** Build problems: the name to build and the structure that answers it. */
  targetName?: string;
  targetSmiles?: string;
  targetKey?: string;
  atomId?: AtomId;
  choices?: Choice[];
  multi?: boolean;
  answer?: string[];
  acidity?: Array<{ id: string; name: string; smiles: string; pKa: number }>;
  fischer?: { correct: MoleculeDocument; mirror: MoleculeDocument; flip: boolean };
  /** Newman problems: the bond looked down and the two reference groups. */
  bondId?: BondId;
  refAtoms?: [string, string];
  dihedral?: number;
  /** Chair problems: the ring and the substituent asked about. */
  chair?: { ring: AtomId[]; ringAtom: AtomId; sub: AtomId; element: string };
  /** Snapshot of the analysis the problem was built from (grading must not drift if the user edits). */
  trace?: naming.NamingTrace;
  accepted?: string[];
  hidesName: boolean;
}

export interface Feedback {
  verdict: 'correct' | 'almost' | 'wrong' | 'invalid' | 'offline';
  title: string;
  detail: string[];
  concept?: Concept;
  compare?: { target: string; yours: string; yoursName?: string };
  reveal?: string;
}

// ---------------------------------------------------------------------------------------------
// Problem bank (structures only — the expected answers come from the engine at run time)

interface BankItem {
  smiles: string;
  level: number;
  concepts: Concept[];
}

export const BANK: BankItem[] = [
  { smiles: 'CC(C)C', level: 1, concepts: ['parent', 'locants', 'geometry', 'groups'] },
  { smiles: 'CCC(C)C', level: 1, concepts: ['parent', 'locants'] },
  { smiles: 'CCC(C)CC', level: 1, concepts: ['parent', 'locants'] },
  { smiles: 'CC(C)C(C)C', level: 1, concepts: ['parent', 'locants'] },
  { smiles: 'CCCC(CC)C(C)C', level: 2, concepts: ['parent', 'locants', 'alphabetization'] },
  { smiles: 'CCC(C)(C)CC(C)CC', level: 2, concepts: ['parent', 'locants', 'alphabetization'] },
  { smiles: 'CCC(CC)CC(C)CCC', level: 2, concepts: ['parent', 'locants', 'alphabetization'] },
  { smiles: 'CC(Br)CC', level: 1, concepts: ['locants', 'groups'] },
  { smiles: 'CC(C)CCl', level: 1, concepts: ['locants', 'groups'] },
  { smiles: 'ClCC(Br)CC', level: 2, concepts: ['locants', 'alphabetization', 'groups'] },
  { smiles: 'CC=CCC', level: 2, concepts: ['parent', 'locants', 'groups', 'geometry'] },
  { smiles: 'C#CCC(C)C', level: 2, concepts: ['locants', 'groups', 'geometry'] },
  { smiles: 'C=CC(C)C', level: 2, concepts: ['locants', 'groups'] },
  { smiles: 'CCC(C)=C(C)C', level: 3, concepts: ['parent', 'locants'] },
  { smiles: 'CC(O)CC', level: 2, concepts: ['suffix', 'locants', 'groups', 'geometry'] },
  { smiles: 'CC(C)(O)CC', level: 2, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'CC(C)CCO', level: 2, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'CCC(=O)CC', level: 2, concepts: ['suffix', 'groups', 'geometry'] },
  { smiles: 'CC(C)CC(C)=O', level: 3, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'CCCC=O', level: 2, concepts: ['suffix', 'groups', 'geometry'] },
  { smiles: 'CC(C)CC(=O)O', level: 3, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'CCOC(C)=O', level: 3, concepts: ['suffix', 'groups'] },
  { smiles: 'CCC(N)=O', level: 3, concepts: ['suffix', 'groups'] },
  { smiles: 'CCC#N', level: 2, concepts: ['suffix', 'groups', 'geometry'] },
  { smiles: 'OC(CC)CC(C)=O', level: 4, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'NCCO', level: 3, concepts: ['suffix', 'groups'] },
  { smiles: 'OC1CCCCC1', level: 2, concepts: ['suffix', 'groups'] },
  { smiles: 'CC1CCCCC1=O', level: 3, concepts: ['suffix', 'locants', 'groups'] },
  { smiles: 'Clc1cccc(Br)c1', level: 3, concepts: ['locants', 'alphabetization', 'groups'] },
  { smiles: 'Oc1ccc(cc1)[N+](=O)[O-]', level: 3, concepts: ['suffix', 'groups'] },
  { smiles: 'OC(=O)c1ccc(Cl)cc1', level: 3, concepts: ['suffix', 'groups'] },
  { smiles: 'CCOCC', level: 1, concepts: ['groups', 'geometry'] },
  { smiles: 'C[C@@H](O)CC', level: 3, concepts: ['rs', 'projection', 'suffix'] },
  { smiles: 'C[C@H](Br)CC', level: 3, concepts: ['rs', 'projection'] },
  { smiles: 'C[C@H](N)C(=O)O', level: 4, concepts: ['rs', 'projection', 'groups'] },
  { smiles: 'O=C[C@H](O)CO', level: 4, concepts: ['rs', 'projection', 'groups'] },
  { smiles: 'C[C@@H](Cl)[C@H](C)Br', level: 4, concepts: ['rs', 'projection'] },
  { smiles: 'C/C=C/C', level: 2, concepts: ['ez'] },
  { smiles: 'C/C=C\\C', level: 2, concepts: ['ez'] },
  { smiles: 'C/C=C/CC', level: 3, concepts: ['ez'] },
  { smiles: 'CC/C(C)=C(/C)Cl', level: 4, concepts: ['ez'] },
  { smiles: 'OC/C=C(/C)Br', level: 4, concepts: ['ez'] },
];

/** Deliberately broken structures for "repair" problems (never silently fixed by the editor). */
const BROKEN: Array<{ smiles: string; fix: string }> = [
  { smiles: 'CC(C)(C)(C)C', fix: 'The central carbon has five bonds. Remove one methyl (or turn it into a separate molecule).' },
  { smiles: 'CO(C)C', fix: 'Neutral oxygen makes two bonds. Remove one carbon from the oxygen, or make it O⁺ (an oxonium ion).' },
  { smiles: 'CN(C)(C)C', fix: 'Neutral nitrogen makes three bonds. Remove a methyl, or make it N⁺ (an ammonium ion).' },
  { smiles: 'CC(=O)(O)C', fix: 'The carbonyl carbon has five bonds. Remove the OH or one methyl.' },
];

/** Approximate aqueous pKa values (typical textbook table). */
const ACIDS = [
  { name: 'ethane', smiles: 'CC', pKa: 50 },
  { name: 'ammonia', smiles: 'N', pKa: 38 },
  { name: 'ethyne', smiles: 'C#C', pKa: 25 },
  { name: 'ethanol', smiles: 'CCO', pKa: 16 },
  { name: 'water', smiles: 'O', pKa: 15.7 },
  { name: 'phenol', smiles: 'Oc1ccccc1', pKa: 10 },
  { name: '4-nitrophenol', smiles: 'Oc1ccc(cc1)[N+](=O)[O-]', pKa: 7.2 },
  { name: 'acetic acid', smiles: 'CC(=O)O', pKa: 4.76 },
  { name: 'chloroacetic acid', smiles: 'OC(=O)CCl', pKa: 2.86 },
  { name: 'trifluoroacetic acid', smiles: 'OC(=O)C(F)(F)F', pKa: 0.23 },
  { name: 'hydrochloric acid', smiles: 'Cl', pKa: -7 },
];

// ---------------------------------------------------------------------------------------------
// Spaced repetition, streaks, achievements

interface Attempt {
  at: number;
  type: ProblemType;
  concept: Concept;
  verdict: Feedback['verdict'];
  hints: number;
  smiles?: string;
  name?: string;
}

export interface PracticeProgress {
  boxes: Partial<Record<Concept, number>>;
  due: Partial<Record<Concept, number>>;
  days: string[];
  attempts: Attempt[];
  named: number;
  achievements: string[];
  dailyDone: string[];
  sets: Array<{ id: string; title: string; items: string[] }>;
}

const EMPTY: PracticeProgress = { boxes: {}, due: {}, days: [], attempts: [], named: 0, achievements: [], dailyDone: [], sets: [] };
const KEY = 'orbital:practice';
const INTERVAL_MS = [0, 60_000, 10 * 60_000, 24 * 3600_000, 3 * 24 * 3600_000, 7 * 24 * 3600_000];

export const ACHIEVEMENTS: Record<string, string> = {
  first: 'First correct answer',
  named10: 'Named 10 molecules',
  named50: 'Named 50 molecules',
  named100: 'Named 100 molecules',
  streak3: '3-day streak',
  streak7: '7-day streak',
  nohint10: '10 correct without hints',
  stereo: 'Assigned a stereocentre',
  daily5: '5 daily challenges',
  mastery: 'Every concept at level 3+',
};

export interface PracticeState {
  progress: PracticeProgress;
  loaded: boolean;
  problem: Problem | null;
  preparing: boolean;
  hints: number;
  hintText: string[];
  feedback: Feedback | null;
  checking: boolean;
  order: string[];
  picked: string[];
  set: (p: Partial<PracticeState>) => void;
}

export const usePractice = create<PracticeState>((set) => ({
  progress: EMPTY,
  loaded: false,
  problem: null,
  preparing: false,
  hints: 0,
  hintText: [],
  feedback: null,
  checking: false,
  order: [],
  picked: [],
  set: (p) => set(p),
}));
const practice = () => usePractice.getState();

export async function loadProgress(): Promise<void> {
  if (practice().loaded) return;
  try {
    const p = await idbGet<PracticeProgress>(KEY);
    usePractice.setState({ progress: { ...EMPTY, ...(p ?? {}) }, loaded: true });
  } catch {
    usePractice.setState({ loaded: true });
  }
}

function saveProgress(p: PracticeProgress) {
  usePractice.setState({ progress: p });
  void idbSet(KEY, p).catch(() => undefined);
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function streakOf(days: string[]): number {
  const set = new Set(days);
  let n = 0;
  const d = new Date();
  if (!set.has(today(d))) d.setDate(d.getDate() - 1);
  while (set.has(today(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function record(problem: Problem, fb: Feedback, hints: number) {
  const p = structuredClone(practice().progress);
  const c = problem.concept;
  const box = p.boxes[c] ?? 1;
  const ok = fb.verdict === 'correct';
  const next = ok ? (hints >= 3 ? box : Math.min(5, box + 1)) : 1;
  p.boxes[c] = next;
  p.due[c] = Date.now() + INTERVAL_MS[next];
  // A precise "almost" diagnosis also schedules the concept it exposed.
  if (fb.concept && fb.concept !== c && !ok) {
    p.boxes[fb.concept] = 1;
    p.due[fb.concept] = Date.now() + INTERVAL_MS[1];
  }
  p.attempts = [...p.attempts.slice(-499), { at: Date.now(), type: problem.type, concept: c, verdict: fb.verdict, hints, smiles: problem.smiles ?? problem.targetSmiles, name: problem.trace?.name ?? problem.targetName }];
  if (ok) {
    if (!p.days.includes(today())) p.days = [...p.days, today()].slice(-400);
    if (problem.type === 'name') p.named++;
    if (problem.source === 'daily' && !p.dailyDone.includes(today())) p.dailyDone = [...p.dailyDone, today()];
  }
  const earn = (id: string, cond: boolean) => {
    if (cond && !p.achievements.includes(id)) {
      p.achievements = [...p.achievements, id];
      studio().notify({ kind: 'success', text: `Achievement: ${ACHIEVEMENTS[id]}` }, 5000);
    }
  };
  const streak = streakOf(p.days);
  earn('first', ok);
  earn('named10', p.named >= 10);
  earn('named50', p.named >= 50);
  earn('named100', p.named >= 100);
  earn('streak3', streak >= 3);
  earn('streak7', streak >= 7);
  earn('nohint10', p.attempts.filter((a) => a.verdict === 'correct' && a.hints === 0).length >= 10);
  earn('stereo', ok && problem.type === 'stereo');
  earn('daily5', p.dailyDone.length >= 5);
  earn('mastery', CONCEPTS.every((x) => (p.boxes[x.id] ?? 0) >= 3));
  saveProgress(p);
  if (hints) track('hint_level_used', { level: hints, type: problem.type });
  if (!ok && fb.verdict !== 'offline') track('answer_corrected', { type: problem.type, concept: fb.concept ?? c });
}

/** Concept most in need of practice: overdue first, then lowest box, then least recently seen. */
export function nextConcept(p: PracticeProgress): Concept {
  const now = Date.now();
  const scored = CONCEPTS.map((c) => {
    const box = p.boxes[c.id] ?? 0;
    const due = p.due[c.id] ?? 0;
    const overdue = due <= now ? 1 : 0;
    const last = [...p.attempts].reverse().find((a) => a.concept === c.id)?.at ?? 0;
    return { c: c.id, key: [-overdue, box, last] };
  });
  scored.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return scored[0].c;
}

// ---------------------------------------------------------------------------------------------
// Building problems

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function waitForAnalysis(timeout = 10000): Promise<Analysis | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (a: Analysis | null) => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(t);
      resolve(a);
    };
    const check = () => {
      const s = studio();
      if (s.analysis && s.analysisVersion === s.version) finish(s.analysis);
    };
    const unsub = useStudio.subscribe(check);
    const t = setTimeout(() => finish(studio().analysis), timeout);
    check();
  });
}

function waitForVerification(timeout = 12000): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const v = studio().verification;
      if (!v || v.status !== 'pending' || Date.now() - t0 > timeout) resolve();
      else setTimeout(tick, 150);
    };
    tick();
  });
}

function acceptedNames(a: Analysis): string[] {
  const v = studio().verification;
  const out = new Set<string>();
  if (a.naming?.name) out.add(a.naming.name);
  for (const alt of a.naming?.alternatives ?? []) out.add(alt.name);
  if (v?.primary?.verified) out.add(v.primary.name);
  for (const c of v?.accepted ?? []) if (c.verified) out.add(c.name);
  return [...out];
}

export const normalizeName = (s: string) =>
  s.normalize('NFKC').toLowerCase().replace(/[‐-―−]/g, '-').replace(/\s*-\s*/g, '-').replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').replace(/\.$/, '').trim();

function pick<T>(xs: T[], seed: number): T {
  return xs[seed % xs.length];
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let seq = 0;

/** Start a problem. With `smiles` omitted the current molecule is used ("quiz me on this"). */
export async function startProblem(opts: { type?: ProblemType; concept?: Concept; source?: Problem['source']; smiles?: string; seed?: number } = {}): Promise<void> {
  const s0 = practice();
  if (s0.preparing) return;
  usePractice.setState({ preparing: true, feedback: null, hints: 0, hintText: [], picked: [], order: [] });
  clearPracticeHighlights();
  try {
    const seed = opts.seed ?? hash(`${Date.now()}:${++seq}`);
    const concept = opts.concept ?? nextConcept(practice().progress);
    const box = practice().progress.boxes[concept] ?? 1;
    let type = opts.type ?? pick(TYPES_FOR[concept], seed);
    const source = opts.source ?? 'bank';
    // Difficulty follows mastery: one level per box, never jumping more than one.
    const level = Math.min(4, Math.max(1, box));
    let smiles = opts.smiles;
    if (!smiles && source !== 'molecule' && (type === 'newman' || type === 'chair')) {
      const pool = (type === 'newman' ? NEWMAN_BANK : CHAIR_BANK).filter((b) => b.level <= level + 1);
      smiles = pick(pool, seed >>> 3).smiles;
    } else if (!smiles && source !== 'molecule' && type !== 'acidity' && type !== 'repair') {
      const pool = BANK.filter((b) => b.concepts.includes(concept));
      const near = pool.filter((b) => Math.abs(b.level - level) <= 1);
      smiles = pick(near.length ? near : pool.length ? pool : BANK, seed >>> 3).smiles;
    }
    const problem = await buildProblem(type, concept, level, source, smiles, seed);
    if (!problem) {
      // The molecule does not support this type (e.g. no stereocentre): fall back to naming it.
      type = 'name';
      const fallback = await buildProblem('name', 'parent', level, source, smiles, seed);
      usePractice.setState({ problem: fallback, preparing: false });
    } else usePractice.setState({ problem, preparing: false });
    track('practice_started', { type: practice().problem?.type ?? 'none', source });
  } catch (e) {
    usePractice.setState({ preparing: false });
    studio().notify({ kind: 'error', text: `Could not start a problem: ${(e as Error).message}` });
  }
}

async function showMolecule(smiles: string | undefined, label: string): Promise<Analysis | null> {
  if (smiles) await loadStructure(smiles, undefined, label);
  useStudio.setState({ panel: 'practice', landing: false });
  return waitForAnalysis();
}

async function buildProblem(type: ProblemType, concept: Concept, level: number, source: Problem['source'], smiles: string | undefined, seed: number): Promise<Problem | null> {
  const id = `p${Date.now()}`;
  const base = { id, type, concept, level, source } as const;
  if (type === 'acidity') {
    const items = shuffle(ACIDS, seed).slice(0, level <= 1 ? 3 : 4).map((x, k) => ({ id: `acid${k}`, ...x }));
    // Keep the set chemically sensible: distinct pKa values.
    const distinct = items.filter((x, k) => items.findIndex((y) => Math.abs(y.pKa - x.pKa) < 0.5) === k);
    return { ...base, concept: 'acidity', prompt: 'Rank from most acidic to least acidic.', sub: 'Tap them in order, strongest acid first.', acidity: distinct, hidesName: false };
  }
  if (type === 'repair') {
    const b = pick(BROKEN, seed);
    await showMolecule(b.smiles, 'Practice: repair');
    return { ...base, concept: 'valence', smiles: b.smiles, prompt: 'This structure is impossible. Repair it.', sub: 'Edit it in 2D or 3D until the status strip says valid, then check.', hidesName: false };
  }
  if (type === 'build') {
    const target = smiles ?? pick(BANK, seed).smiles;
    const doc = parseSmiles(target).doc;
    const an = await call<Analysis>('analyze', { doc, profileId: studio().settings.profileId });
    const name = an.naming?.name;
    const key = an.identifiers?.inchiKey;
    if (!name || !key) return null;
    // Fresh canvas: the student draws from scratch.
    useStudio.getState().replace({ ...doc, atoms: [], bonds: [], conformers: [], layout2d: {}, title: undefined }, 'Practice: new canvas');
    useStudio.setState({ panel: 'practice', landing: false, view: 'split', tool2d: 'draw' });
    return { ...base, concept: 'build', targetName: name, targetSmiles: target, targetKey: key, prompt: `Build ${name}`, sub: 'Draw it in 2D or build it in 3D, then check. Stereochemistry counts.', hidesName: true };
  }
  const an = await showMolecule(smiles, `Practice: ${TYPE_LABEL[type]}`);
  const trace = an?.naming?.trace;
  const doc = studio().doc;
  switch (type) {
    case 'name': {
      if (!an || !trace) return null;
      await waitForVerification();
      return { ...base, smiles: smiles ?? an.identifiers?.canonicalSmiles, trace, accepted: acceptedNames(an), prompt: 'Name this molecule.', sub: 'Type the IUPAC name. Any accepted name passes — grading compares structures, not strings.', hidesName: true };
    }
    case 'parent': {
      if (!trace) return null;
      return { ...base, concept: 'parent', trace, prompt: trace.parent.kind === 'ring' ? 'Select every atom of the parent ring.' : 'Select every carbon of the parent chain.', sub: 'Click atoms in 2D or 3D (shift-click to add more), then check.', hidesName: true };
    }
    case 'number': {
      if (!trace || trace.parent.kind !== 'chain' || trace.parent.atomIds.length < 3) return null;
      return { ...base, concept: 'locants', trace, prompt: 'Click the carbon that gets locant 1.', sub: 'The parent chain is highlighted.', hidesName: true };
    }
    case 'principal': {
      if (!trace) return null;
      const present = trace.principalGroup.present.map((p) => p.kind as string);
      const distract = naming.SENIORITY.filter((k) => !present.includes(k) && !['carboxylate', 'alkoxide', 'carbanion', 'ammonium', 'carbocation', 'imine', 'anhydride'].includes(k));
      const opts = [...present, ...shuffle(distract, seed).slice(0, Math.max(1, 3 - present.length))];
      const choices = shuffle(opts, seed).map((k) => ({ id: k, label: naming.CG_LABEL[k as keyof typeof naming.CG_LABEL] }));
      choices.push({ id: 'none', label: 'none — the parent hydride takes no suffix' });
      return { ...base, concept: 'suffix', trace, choices, answer: [trace.principalGroup.kind ?? 'none'], prompt: 'Which group is cited as the suffix?', hidesName: true };
    }
    case 'stereo': {
      if (!an) return null;
      const centres = an.stereo.centres.filter((c) => c.specified && c.descriptor);
      const bonds = an.stereo.bonds.filter((b) => b.specified && b.descriptor);
      const useBond = concept === 'ez' ? bonds.length > 0 : !centres.length && bonds.length > 0;
      if (useBond) {
        const b = pick(bonds, seed);
        useStudio.setState({ highlights: { ...studio().highlights, 'practice:target': { id: 'practice:target', atoms: b.atoms, bonds: [b.bondId], tone: 'accent', pulse: true } } });
        return { ...base, concept: 'ez', trace, atomId: b.atoms[0], choices: [{ id: 'E', label: 'E' }, { id: 'Z', label: 'Z' }], answer: [b.descriptor!], prompt: 'Is the highlighted double bond E or Z?', hidesName: true };
      }
      if (!centres.length) return null;
      const c = pick(centres, seed);
      useStudio.setState({ highlights: { ...studio().highlights, 'practice:target': { id: 'practice:target', atoms: [c.atomId], bonds: [], tone: 'accent', pulse: true } } });
      return { ...base, concept: 'rs', trace, atomId: c.atomId, choices: [{ id: 'R', label: 'R' }, { id: 'S', label: 'S' }], answer: [c.descriptor!], prompt: 'Is the highlighted stereocentre R or S?', sub: 'Rotate the model so the lowest priority points away.', hidesName: true };
    }
    case 'geometry': {
      if (!an) return null;
      const cands = doc.atoms.filter((a) => {
        const g = an.geometry[a.id];
        return g && g.idealAngle && (g.sigma + g.lonePairs >= 2) && a.element !== 'H';
      });
      if (!cands.length) return null;
      // Prefer something other than a plain CH3/CH2 at higher levels.
      const interesting = cands.filter((a) => a.element !== 'C' || an.geometry[a.id].hybridization !== 'sp3');
      const atom = pick(level >= 2 && interesting.length ? interesting : cands, seed);
      const g = an.geometry[atom.id];
      useStudio.setState({ highlights: { ...studio().highlights, 'practice:target': { id: 'practice:target', atoms: [atom.id], bonds: [], tone: 'accent', pulse: true } } });
      const all = [
        { id: 'linear', label: 'linear · 180°' },
        { id: 'trigonal planar', label: 'trigonal planar · 120°' },
        { id: 'tetrahedral', label: 'tetrahedral · 109.5°' },
        { id: 'trigonal pyramidal', label: 'trigonal pyramidal · ~107°' },
        { id: 'bent', label: `bent · ${g.stericNumber === 3 ? '~120°' : '~104.5°'}` },
      ];
      return { ...base, concept: 'geometry', atomId: atom.id, choices: all, answer: [g.molecularGeometry], prompt: `What is the shape around the highlighted ${atom.element === 'C' ? 'carbon' : atom.element === 'O' ? 'oxygen' : atom.element === 'N' ? 'nitrogen' : atom.element}?`, sub: 'Count σ bonds and lone pairs (VSEPR).', hidesName: false };
    }
    case 'groups': {
      if (!an) return null;
      const present = [...new Set(an.groups.map((g) => g.kind as string))].filter((k) => k !== 'arene' || true);
      if (!present.length) return null;
      const pool = ['alcohol', 'ether', 'aldehyde', 'ketone', 'carboxylic-acid', 'ester', 'amide', 'amine', 'nitrile', 'alkene', 'alkyne', 'alkyl-halide', 'aryl-halide', 'arene', 'phenol', 'nitro', 'thiol'];
      const distract = shuffle(pool.filter((k) => !present.includes(k)), seed).slice(0, Math.max(2, 5 - present.length));
      const labels: Record<string, string> = Object.fromEntries(an.groups.map((g) => [g.kind, g.label]));
      const FG: Record<string, string> = { alcohol: 'alcohol', ether: 'ether', aldehyde: 'aldehyde', ketone: 'ketone', 'carboxylic-acid': 'carboxylic acid', ester: 'ester', amide: 'amide', amine: 'amine', nitrile: 'nitrile', alkene: 'alkene', alkyne: 'alkyne', 'alkyl-halide': 'haloalkane', 'aryl-halide': 'aryl halide', arene: 'aromatic ring', phenol: 'phenol', nitro: 'nitro', thiol: 'thiol' };
      const choices = shuffle([...present, ...distract], seed).map((k) => ({ id: k, label: labels[k] ?? FG[k] ?? k }));
      return { ...base, concept: 'groups', choices, multi: true, answer: present, prompt: 'Select every functional group in this molecule.', hidesName: false };
    }
    case 'newman':
      return an ? buildNewman(base, level, seed) : null;
    case 'chair':
      return an ? buildChair(base, level, seed) : null;
    case 'fischer': {
      if (!an || !trace) return null;
      const centres = an.stereo.centres.filter((c) => c.specified);
      if (!centres.length || trace.parent.kind !== 'chain') return null;
      const mirror = applyCommand(doc, { type: 'mirror' }).doc;
      return { ...base, concept: 'projection', trace, fischer: { correct: doc, mirror, flip: (seed & 1) === 1 }, choices: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }], answer: [(seed & 1) === 1 ? 'B' : 'A'], prompt: 'Which Fischer projection shows this molecule?', sub: 'Compare with the 3D model — vertical bonds point away from you.', hidesName: false };
    }
  }
  return null;
}

export async function startDaily(): Promise<void> {
  const d = today();
  const h = hash(`daily:${d}`);
  const item = BANK[h % BANK.length];
  const concept = item.concepts[h % item.concepts.length];
  const type: ProblemType = concept === 'rs' || concept === 'ez' ? 'stereo' : 'name';
  await startProblem({ smiles: item.smiles, type, concept, source: 'daily', seed: h });
}

// ---------------------------------------------------------------------------------------------
// Hints (the student chooses the depth; the level used is recorded)

export function nextHint(): void {
  const s = practice();
  const p = s.problem;
  if (!p || s.hints >= 5) return;
  const level = s.hints + 1;
  const text = hintFor(p, level);
  usePractice.setState({ hints: level, hintText: [...s.hintText, text] });
  track('hint_level_used', { level, type: p.type });
}

function hl(h: Highlight) {
  useStudio.setState((st) => ({ highlights: { ...st.highlights, [h.id]: h } }));
}

export function clearPracticeHighlights(): void {
  useStudio.setState((st) => {
    const next: Record<string, Highlight> = {};
    for (const [k, v] of Object.entries(st.highlights)) if (!k.startsWith('practice:')) next[k] = v;
    return { highlights: next };
  });
}

function bondsWithin(atoms: AtomId[]): string[] {
  const set = new Set(atoms);
  return studio().doc.bonds.filter((b) => set.has(b.a1) && set.has(b.a2)).map((b) => b.id);
}

function hintFor(p: Problem, level: number): string {
  const t = p.trace;
  switch (p.type) {
    case 'name':
    case 'parent':
    case 'number':
    case 'principal': {
      if (!t) return 'Look for the longest carbon chain.';
      if (level === 1) return t.principalGroup.kind ? 'Start with the highest-priority functional group — it becomes the suffix, and the parent must contain it.' : 'No group here can be a suffix: the name is built on the longest carbon chain.';
      if (level === 2) {
        const region = t.principalGroup.kind ? t.principalGroup.atomIds : [t.numbering.orderedAtomIds[0], t.numbering.orderedAtomIds[t.numbering.orderedAtomIds.length - 1]];
        hl({ id: 'practice:hint', atoms: region, bonds: [], tone: 'amber', pulse: true });
        return t.principalGroup.kind ? `The pulsing atoms are the ${t.principalGroup.label}.` : 'The pulsing atoms are the two ends of the parent chain.';
      }
      if (level === 3) {
        const alt = t.parent.alternatives[0];
        hl({ id: 'practice:hint', atoms: t.parent.atomIds, bonds: bondsWithin(t.parent.atomIds), tone: 'accent' });
        if (alt) hl({ id: 'practice:hint2', atoms: alt.atomIds.filter((a) => !t.parent.atomIds.includes(a)), bonds: [], tone: 'amber' });
        return alt ? `Two candidate parents are shown: the ${t.parent.label} (violet) and a ${alt.label} (amber). One wins because ${alt.rejectedBecause.replace(/^it /, 'the other ')}.` : `The parent is the violet ${t.parent.label}.`;
      }
      if (level === 4) return t.numbering.reason;
      hl({ id: 'practice:hint', atoms: t.parent.atomIds, bonds: bondsWithin(t.parent.atomIds), tone: 'accent', labels: t.numbering.locantOf });
      return `Parent: ${t.parent.root}, numbered as shown. ${p.type === 'name' ? 'Now name each substituent at its locant and put them in alphabetical order.' : ''}`;
    }
    case 'stereo': {
      if (p.concept === 'ez') {
        if (level === 1) return 'On each end of the double bond, rank the two groups by atomic number (CIP rules).';
        if (level === 2) return 'Compare the higher-priority group on the left carbon with the higher-priority group on the right carbon.';
        if (level === 3) return 'Same side = Z (zusammen, "together"). Opposite sides = E (entgegen).';
        if (level === 4) return 'If the first atoms tie, move outward to the next set of atoms and compare again.';
        return p.trace?.stereo.find((x) => x.kind === 'E/Z')?.explanation ?? 'Look at where the two higher-priority groups sit.';
      }
      const st = p.trace?.stereo.find((x) => x.atomIds[0] === p.atomId);
      if (level === 1) return 'Rank the four groups on the centre by atomic number of the directly attached atom.';
      if (level === 2) return 'Hydrogen (if present) is always priority 4. Orient the model so it points away from you.';
      if (level === 3 && st?.priorities) {
        const labels: Record<string, string> = {};
        for (const pr of st.priorities) labels[pr.atomId === 'H' ? `${p.atomId}.h1` : pr.atomId] = String(pr.rank);
        hl({ id: 'practice:hint', atoms: [], bonds: [], tone: 'amber', labels });
        return 'The priorities are now labelled on the model.';
      }
      if (level === 4) return 'With 4 pointing away, trace 1 → 2 → 3: clockwise is R, counter-clockwise is S.';
      if (st?.lowestPriority) {
        const doc = studio().doc;
        const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
        const c = conf?.coordinates[p.atomId!];
        const lowKey = st.lowestPriority === 'H' ? Object.keys(conf?.coordinates ?? {}).find((k) => k.startsWith(`${p.atomId}.h`)) : st.lowestPriority;
        const l = lowKey ? conf?.coordinates[lowKey] : undefined;
        if (c && l) import('./events').then(({ bus }) => bus.emit('fit', { dir: [c[0] - l[0], c[1] - l[1], c[2] - l[2]], target: c }));
      }
      return 'The camera now looks with priority 4 pointing away. Follow 1 → 2 → 3.';
    }
    case 'geometry':
      return [
        'Count the σ bonds (every single, double or triple bond counts once) and the lone pairs.',
        'σ bonds + lone pairs = steric number: 2 → linear, 3 → trigonal planar, 4 → tetrahedral electron geometry.',
        'The shape names only the atoms: lone pairs are there but not "seen" in the shape.',
        'Double and triple bonds count as one region; an atom with one double bond and two single bonds is trigonal planar.',
        'Lone pairs squeeze bond angles slightly below the ideal value.',
      ][level - 1];
    case 'groups':
      return ['Look at every heteroatom (O, N, S, halogens) and every multiple bond.', 'C=O with H on the carbon is an aldehyde; with two carbons, a ketone.', 'C=O next to O–H is a carboxylic acid; next to O–C, an ester; next to N, an amide.', 'O between two carbons is an ether; O–H on an sp³ carbon is an alcohol, on a benzene ring a phenol.', 'Alkenes and aromatic rings count as groups too.'][level - 1];
    case 'acidity':
      return ['The more stable the conjugate base, the stronger the acid.', 'Compare which atom carries the negative charge: more electronegative atoms hold it better (same row).', 'Resonance spreads the charge — carboxylates beat alkoxides.', 'Nearby electronegative atoms (F, Cl, NO₂) pull charge away and increase acidity.', 'sp C–H is more acidic than sp² and sp³ C–H (more s character).'][level - 1];
    case 'fischer':
      return ['In a Fischer projection, horizontal bonds come toward you and vertical bonds go away.', 'Find the centre in 3D and turn the model so the chain runs up–down, curving away from you.', 'Only one of the two drawings has the groups on the sides you see.', 'The two options are mirror images: exactly one matches.', 'Assign R/S to both and to the model — the matching descriptor wins.'][level - 1];
    case 'newman':
      return ['Find the two reference groups: one on the front carbon, one on the back carbon.', 'Staggered: back bonds sit between front bonds. Eclipsed: back bonds hide behind front bonds.', 'Measure the angle between the two reference groups around the circle.', '180° = anti, 60° = gauche, 120° = eclipsed (group eclipses H), 0° = totally eclipsed (groups eclipse each other).', `The dihedral here is ${Math.round(Math.abs(p.dihedral ?? 0))}°.`][level - 1];
    case 'chair':
      return ['Every ring carbon has one axial and one equatorial position.', 'Axial bonds are parallel to the ring’s axis — straight up or straight down.', 'Equatorial bonds point outward, roughly along the ring’s mean plane.', 'Up-carbons have their axial bond pointing up; down-carbons, down.', 'Compare the highlighted bond with the ring’s axis (the up direction in this view).'][level - 1];
    case 'repair':
      return ['Find the atom with the red valence ring.', 'Count its bonds: C makes 4, N makes 3, O makes 2 when neutral.', 'Delete one bond or atom attached to it.', 'You could also give it a charge — but only if that species is real (oxonium, ammonium).', BROKEN.find((b) => b.smiles === p.smiles)?.fix ?? 'Remove the extra bond.'][level - 1];
    case 'build':
      return ['Find the parent in the name: the stem (meth-, eth-, prop-, but-, pent-, hex-…) and ending tell you the chain and the principal group.', 'Draw the parent chain first and number it from one end.', 'Add each substituent at its locant.', 'Check the suffix group sits on the right carbon (its locant is just before the suffix).', `Stereodescriptors: (R)/(S) and (E)/(Z) must match — check them in the inspector.`][level - 1];
  }
}

// ---------------------------------------------------------------------------------------------
// Grading

export async function checkAnswer(input?: string): Promise<void> {
  const s = practice();
  const p = s.problem;
  if (!p || s.checking) return;
  usePractice.setState({ checking: true });
  let fb: Feedback;
  try {
    fb = await grade(p, input ?? '', s);
  } catch (e) {
    fb = { verdict: 'invalid', title: 'Could not check that', detail: [(e as Error).message] };
  }
  usePractice.setState({ feedback: fb, checking: false });
  if (fb.verdict !== 'invalid' && fb.verdict !== 'offline') record(p, fb, s.hints);
}

async function grade(p: Problem, input: string, s: PracticeState): Promise<Feedback> {
  switch (p.type) {
    case 'name':
      return gradeName(p, input);
    case 'build':
      return gradeBuild(p);
    case 'parent': {
      const t = p.trace!;
      const sel = new Set(studio().selection.atoms.filter((a) => !a.includes('.')));
      const same = (atoms: AtomId[]) => atoms.length === sel.size && atoms.every((a) => sel.has(a));
      if (!sel.size) return { verdict: 'invalid', title: 'Select some atoms first', detail: ['Click the atoms of the parent in the 2D or 3D view (shift-click adds).'] };
      if (same(t.parent.atomIds) || (t.parent.equivalents ?? []).some(same)) {
        return { verdict: 'correct', title: `Yes — the ${t.parent.label}.`, detail: [t.parent.kind === 'chain' ? `It becomes the parent: ${t.parent.root}.` : t.parent.explanation] };
      }
      const alt = t.parent.alternatives.find((a) => same(a.atomIds));
      hl({ id: 'practice:answer', atoms: t.parent.atomIds, bonds: bondsWithin(t.parent.atomIds), tone: 'good' });
      if (alt) return { verdict: 'wrong', title: `That ${alt.label} is a candidate, but it loses.`, detail: [`It is rejected because ${alt.rejectedBecause}.`, 'The correct parent is now shown in green.'], concept: 'parent' };
      return { verdict: 'wrong', title: `Not the parent: you selected ${sel.size} atom${sel.size === 1 ? '' : 's'}; the parent has ${t.parent.atomIds.length}.`, detail: [t.parent.kind === 'chain' ? 'The parent must be one continuous chain — the longest one (containing the principal group, if any).' : t.parent.explanation, 'The correct parent is now shown in green.'], concept: 'parent' };
    }
    case 'number': {
      const t = p.trace!;
      const clicked = studio().selection.atoms[0];
      const first = t.numbering.orderedAtomIds[0];
      const last = t.numbering.orderedAtomIds[t.numbering.orderedAtomIds.length - 1];
      if (!clicked) return { verdict: 'invalid', title: 'Click an atom first', detail: ['Click the carbon that should be C1.'] };
      const symmetric = !t.numbering.alternative;
      if (clicked === first || (symmetric && clicked === last)) {
        hl({ id: 'practice:answer', atoms: t.parent.atomIds, bonds: bondsWithin(t.parent.atomIds), tone: 'good', labels: t.numbering.locantOf });
        return { verdict: 'correct', title: 'Right end.', detail: [t.numbering.reason] };
      }
      hl({ id: 'practice:answer', atoms: t.parent.atomIds, bonds: bondsWithin(t.parent.atomIds), tone: 'accent', labels: t.numbering.locantOf });
      if (clicked === last && t.numbering.alternative) {
        const a = t.numbering.alternative;
        return { verdict: 'wrong', title: 'That numbers from the opposite end.', detail: [`From that end the locants are {${a.locants.join(',')}}; from the other end {${a.chosenLocants.join(',')}}.`, `First point of difference: ${a.firstPointOfDifference} — the lower number wins. The correct numbering is on the model.`], concept: 'locants' };
      }
      return { verdict: 'wrong', title: 'C1 is always at an end of the parent chain.', detail: ['Numbering starts at one end — choose the end that gives the lowest locants. The correct numbering is on the model.'], concept: 'locants' };
    }
    case 'principal':
    case 'stereo':
    case 'geometry':
    case 'groups':
    case 'newman':
    case 'chair':
    case 'fischer': {
      const picked = [...s.picked].sort();
      const answer = [...(p.answer ?? [])].sort();
      if (!picked.length) return { verdict: 'invalid', title: 'Choose an answer first', detail: [] };
      const ok = picked.length === answer.length && picked.every((x, k) => x === answer[k]);
      return explainChoice(p, ok, picked);
    }
    case 'acidity': {
      const order = s.order;
      const items = p.acidity!;
      if (order.length !== items.length) return { verdict: 'invalid', title: 'Rank all of them first', detail: [] };
      const right = [...items].sort((a, b) => a.pKa - b.pKa).map((x) => x.id);
      const ok = order.every((x, k) => x === right[k]);
      const table = [...items].sort((a, b) => a.pKa - b.pKa).map((x) => `${x.name}: pKa ≈ ${x.pKa}`);
      return ok
        ? { verdict: 'correct', title: 'Correct order.', detail: ['Lower pKa = stronger acid:', ...table] }
        : { verdict: 'wrong', title: 'Not quite.', detail: ['Lower pKa = stronger acid (approximate aqueous values):', ...table, 'The stronger acid has the more stable conjugate base: charge on a more electronegative atom, spread by resonance, or pulled away by electronegative neighbours.'], concept: 'acidity' };
    }
    case 'repair': {
      await waitForAnalysis(4000);
      const a = studio().analysis;
      const errors = a?.validation.filter((v) => v.severity === 'error') ?? [];
      if (errors.length) return { verdict: 'wrong', title: 'Still invalid.', detail: [errors[0].title, errors[0].message ?? ''], concept: 'valence' };
      return { verdict: 'correct', title: 'Valid structure.', detail: [`Every atom now has a normal valence${a?.naming?.name ? ` — this is ${a.naming.name}` : ''}.`] };
    }
  }
}

function explainChoice(p: Problem, ok: boolean, picked: string[]): Feedback {
  const label = (id: string) => p.choices?.find((c) => c.id === id)?.label ?? id;
  const t = p.trace;
  switch (p.type) {
    case 'principal':
      return ok
        ? { verdict: 'correct', title: `Yes — ${label(p.answer![0])}.`, detail: [t?.principalGroup.explanation ?? ''] }
        : { verdict: 'wrong', title: `The suffix is the ${label(p.answer![0])}.`, detail: [t?.principalGroup.explanation ?? '', 'Seniority: acids > anhydrides > esters > acid halides > amides > nitriles > aldehydes > ketones > alcohols > thiols > amines.'], concept: 'suffix' };
    case 'stereo': {
      const st = t?.stereo.find((x) => x.atomIds.includes(p.atomId!));
      const expl = st?.explanation ?? '';
      if (ok) return { verdict: 'correct', title: `Yes — ${p.answer![0]}.`, detail: [expl] };
      return { verdict: 'wrong', title: `It is ${p.answer![0]}.`, detail: [expl, 'Open Explain → Stereo to see the priorities on the model with 4 pointing away.'], concept: p.concept };
    }
    case 'geometry': {
      const g = studio().analysis?.geometry[p.atomId!];
      const why = g ? `${g.sigma} σ bond${g.sigma === 1 ? '' : 's'} + ${g.lonePairs} lone pair${g.lonePairs === 1 ? '' : 's'} → ${g.hybridization}, ${g.electronGeometry} electron geometry; ideal angle ${g.idealAngle}°.` : '';
      return ok ? { verdict: 'correct', title: `Yes — ${label(p.answer![0])}.`, detail: [why] } : { verdict: 'wrong', title: `It is ${label(p.answer![0])}.`, detail: [why], concept: 'geometry' };
    }
    case 'groups': {
      const answer = new Set(p.answer);
      const missed = [...answer].filter((x) => !picked.includes(x)).map(label);
      const extra = picked.filter((x) => !answer.has(x)).map(label);
      const groups = studio().analysis?.groups ?? [];
      hl({ id: 'practice:answer', atoms: groups.flatMap((g) => g.atomIds), bonds: [], tone: 'good' });
      if (ok) return { verdict: 'correct', title: 'All found.', detail: groups.map((g) => g.label + (g.detail ? ` (${g.detail})` : '')) };
      return { verdict: 'wrong', title: 'Not quite.', detail: [...(missed.length ? [`Missed: ${missed.join(', ')}.`] : []), ...(extra.length ? [`Not present: ${extra.join(', ')}.`] : []), 'The groups are highlighted on the model.'], concept: 'groups' };
    }
    case 'newman': {
      const d = Math.round(Math.abs(((p.dihedral ?? 0) + 540) % 360 - 180));
      const why: Record<string, string> = {
        anti: 'Anti is the lowest-energy conformation: the two groups are as far apart as possible.',
        gauche: 'Gauche is staggered but the two groups are 60° apart — about 3.8 kJ/mol above anti for butane (steric strain).',
        eclipsed: 'Each group eclipses a hydrogen: torsional strain puts it about 16 kJ/mol above anti for butane.',
        syn: 'The two groups eclipse each other: the highest-energy conformation (about 19 kJ/mol above anti for butane).',
      };
      const detail = [`The dihedral between the reference groups is ${d}°.`, why[p.answer![0]], 'Energy order: anti < gauche < eclipsed < totally eclipsed.'];
      return ok ? { verdict: 'correct', title: `Yes — ${label(p.answer![0])}.`, detail } : { verdict: 'wrong', title: `It is ${label(p.answer![0])}.`, detail, concept: 'conformation' };
    }
    case 'chair': {
      const pos = p.answer![0];
      const big = p.chair?.element !== 'H';
      const detail = [
        pos === 'axial' ? 'The bond runs parallel to the ring axis — straight up or down from its carbon.' : 'The bond points out from the ring, roughly along its equator.',
        big ? (pos === 'axial' ? 'Axial substituents clash with the two axial hydrogens on the same face (1,3-diaxial strain), so a ring flip to put it equatorial is favoured.' : 'Equatorial is the preferred position for substituents: no 1,3-diaxial strain.') : '',
        'Try Projections → Chair and flip the ring: every axial position becomes equatorial.',
      ].filter(Boolean);
      return ok ? { verdict: 'correct', title: `Yes — ${pos}.`, detail } : { verdict: 'wrong', title: `It is ${pos}.`, detail, concept: 'conformation' };
    }
    case 'fischer':
      return ok
        ? { verdict: 'correct', title: 'Yes — that projection matches.', detail: ['The other one is its mirror image (every centre inverted).'] }
        : { verdict: 'wrong', title: 'That one is the mirror image.', detail: ['Swapping the two horizontal groups — or taking the mirror image — inverts each centre. Check which groups point toward you in 3D.'], concept: 'projection' };
  }
  return { verdict: ok ? 'correct' : 'wrong', title: ok ? 'Correct.' : 'Not quite.', detail: [] };
}

// --- Conformations (stereo trainer) ------------------------------------------------------------

/** Chains where each end of the central bond carries exactly one group besides H — the textbook set. */
export const NEWMAN_BANK: Array<{ smiles: string; level: number }> = [
  { smiles: 'CCCC', level: 1 },
  { smiles: 'ClCCCl', level: 1 },
  { smiles: 'BrCCBr', level: 2 },
  { smiles: 'CCCO', level: 2 },
  { smiles: 'OCCO', level: 2 },
  { smiles: 'CCCCC', level: 3 },
  { smiles: 'CCCBr', level: 3 },
];

export const CHAIR_BANK: Array<{ smiles: string; level: number }> = [
  { smiles: 'CC1CCCCC1', level: 1 },
  { smiles: 'OC1CCCCC1', level: 1 },
  { smiles: 'ClC1CCCCC1', level: 2 },
  { smiles: 'CC(C)(C)C1CCCCC1', level: 2 },
  { smiles: 'C[C@H]1CC[C@@H](C)CC1', level: 3 },
  { smiles: 'C[C@H]1CC[C@H](C)CC1', level: 3 },
  { smiles: 'C[C@H]1CCCC[C@@H]1C', level: 4 },
];

const CONFORMATIONS = [
  { id: 'anti', label: 'anti (staggered, 180°)' },
  { id: 'gauche', label: 'gauche (staggered, 60°)' },
  { id: 'eclipsed', label: 'eclipsed (120°)' },
  { id: 'syn', label: 'totally eclipsed (0°)' },
];

function conformationOf(dihedral: number): string {
  const d = Math.abs(((dihedral + 540) % 360) - 180);
  return d > 150 ? 'anti' : d > 90 ? 'eclipsed' : d > 30 ? 'gauche' : 'syn';
}

function waitForGeometry(timeout = 12000): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const g = studio().geometry;
      if ((g !== 'idealized' && g !== 'relaxing') || Date.now() - t0 > timeout) resolve();
      else setTimeout(tick, 120);
    };
    tick();
  });
}

function coordsNow(): Record<string, Vec3> {
  const d = studio().doc;
  return (d.conformers.find((c) => c.id === d.selectedConformerId) ?? d.conformers[0])?.coordinates ?? {};
}

async function buildNewman(base: Pick<Problem, 'id' | 'type' | 'concept' | 'level' | 'source'>, level: number, seed: number): Promise<Problem | null> {
  await waitForGeometry();
  const doc = studio().doc;
  const view = new MolView(doc);
  const heavy = (i: number) => view.nbrs[i].filter((j) => doc.atoms[j].element !== 'H');
  // A single, acyclic bond with one more heavy group on each end.
  const cands = doc.bonds.filter((b) => {
    if (b.order !== 1) return false;
    const i = view.idx(b.a1);
    const j = view.idx(b.a2);
    return heavy(i).length === 2 && heavy(j).length === 2 && doc.atoms[i].element === 'C' && doc.atoms[j].element === 'C' && rotationEnds(b.id) !== null;
  });
  // Prefer the central bond.
  cands.sort((x, y) => Math.abs(view.idx(x.a1) + view.idx(x.a2) - (doc.atoms.length - 1)) - Math.abs(view.idx(y.a1) + view.idx(y.a2) - (doc.atoms.length - 1)));
  const bond = cands[0];
  if (!bond) return null;
  const dih = dihedralFor(bond.id);
  if (!dih) return null;
  const targets = level <= 1 ? [180, 60, 0] : [180, 60, -60, 120, -120, 0];
  const target = pick(targets, seed >>> 5);
  for (let k = 0; k < 2; k++) {
    const now = currentDihedral(dih);
    if (now === null) return null;
    const delta = ((target - now + 540) % 360) - 180;
    if (Math.abs(delta) < 1) break;
    rotateBond(bond.id, delta);
  }
  const final = currentDihedral(dih) ?? target;
  const ends = [dih[0], dih[3]] as [string, string];
  const c = coordsNow();
  const p1 = c[bond.a1];
  const p2 = c[bond.a2];
  // After the load's own auto-fit has settled, look straight down the bond (front carbon nearest).
  if (p1 && p2) lookLater({ dir: v3.norm(v3.sub(p1, p2)), target: v3.scale(v3.add(p1, p2), 0.5) });
  hl({ id: 'practice:target', atoms: [bond.a1, bond.a2, ...ends.filter((x) => !x.includes('.'))], bonds: [bond.id], tone: 'accent' });
  const names = ends.map((id) => groupName(doc, view, id));
  const groups = names[0] === names[1] ? `the two ${names[0]} groups` : `the ${names[0]} and ${names[1]} groups`;
  return {
    ...base,
    concept: 'conformation',
    bondId: bond.id,
    refAtoms: ends,
    dihedral: final,
    choices: level <= 1 ? CONFORMATIONS.filter((x) => x.id !== 'eclipsed') : CONFORMATIONS,
    answer: [conformationOf(final)],
    prompt: `Looking down the highlighted bond, how are ${groups} arranged?`,
    sub: 'The camera looks straight down the bond; the Newman projection is below. Rotate to check.',
    hidesName: false,
  };
}

function groupName(doc: MoleculeDocument, view: MolView, id: string): string {
  const a = doc.atoms.find((x) => x.id === id);
  if (!a) return 'H';
  if (a.element === 'C') return view.nbrs[view.idx(id)].length === 1 ? 'CH₃' : 'alkyl';
  return a.element === 'O' ? 'OH' : a.element;
}

let lookTimer: ReturnType<typeof setTimeout> | undefined;
function lookLater(view: { dir: Vec3; target?: Vec3; up?: Vec3 }) {
  clearTimeout(lookTimer);
  bus.emit('fit', view);
  lookTimer = setTimeout(() => bus.emit('fit', view), 450);
}

async function buildChair(base: Pick<Problem, 'id' | 'type' | 'concept' | 'level' | 'source'>, level: number, seed: number): Promise<Problem | null> {
  await waitForGeometry();
  let doc = studio().doc;
  const ring = chairRings(doc)[0];
  if (!ring) return null;
  let a = analyzeChair(doc, coordsNow(), ring);
  if (!a?.isChair) return null;
  const heavySubs = () => ring.flatMap((r) => (a!.substituents[r] ?? []).filter((x) => x.element !== 'H').map((x) => ({ ringAtom: r, ...x })));
  // Half the time flip the ring so the answer is not always "equatorial".
  if ((seed >>> 7) & 1) {
    const flip = chairFlipFrames(doc, coordsNow(), ring);
    const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
    if (flip && conf) {
      studio().setConformer({ ...conf, coordinates: flip.frames[flip.frames.length - 1], converged: false, method: `${conf.method.replace(/ \(.*\)$/, '')} (ring flipped)` }, 'relaxed', '');
      doc = studio().doc;
      a = analyzeChair(doc, coordsNow(), ring);
      if (!a) return null;
    }
  }
  const subs = heavySubs();
  if (!subs.length) return null;
  const s = pick(subs, seed >>> 9);
  // Side view: camera in the ring's mean plane, ring normal up.
  const c = coordsNow();
  const p = c[s.ringAtom];
  if (p) {
    let f = v3.sub(p, a.centre);
    f = v3.norm(v3.sub(f, v3.scale(a.normal, v3.dot(f, a.normal))));
    const side = v3.norm(v3.cross(a.normal, f));
    const el = (15 * Math.PI) / 180;
    lookLater({ dir: v3.add(v3.scale(side, Math.cos(el)), v3.scale(a.normal, Math.sin(el))), up: a.normal });
  }
  hl({ id: 'practice:target', atoms: [s.key, s.ringAtom], bonds: doc.bonds.filter((b) => (b.a1 === s.key && b.a2 === s.ringAtom) || (b.a2 === s.key && b.a1 === s.ringAtom)).map((b) => b.id), tone: 'accent', pulse: true });
  const what = s.element === 'C' ? 'carbon substituent' : s.element === 'O' ? 'OH group' : s.element;
  return {
    ...base,
    concept: 'conformation',
    chair: { ring, ringAtom: s.ringAtom, sub: s.key, element: s.element },
    choices: [{ id: 'axial', label: 'axial' }, { id: 'equatorial', label: 'equatorial' }],
    answer: [s.position],
    prompt: `In this chair, is the highlighted ${what} axial or equatorial?`,
    sub: level >= 3 ? 'Then ask yourself: is this the more stable chair?' : 'Axial bonds run parallel to the ring’s axis; equatorial ones point out around the ring’s equator.',
    hidesName: false,
  };
}

// --- Name the structure --------------------------------------------------------------------

const SUBS = '₀₁₂₃₄₅₆₇₈₉';
const fmtFormula = (f?: string) => (f ?? '').replace(/\d/g, (d) => SUBS[+d]);

const STEREO_PREFIX = /^\(([^)]*)\)-/;

function locantsOf(name: string): number[] {
  return (name.replace(STEREO_PREFIX, '').match(/\d+/g) ?? []).map(Number).sort((a, b) => a - b);
}

function prefixWords(name: string, root: string): string[] {
  const body = name.replace(STEREO_PREFIX, '');
  const stem = root.replace(/(ane|ene|yne)$/, '');
  const cut = body.lastIndexOf(stem);
  const head = cut > 0 ? body.slice(0, cut) : body;
  return head
    .split(/[-\s]/)
    .map((w) => w.replace(/^[\d,]+/, '').replace(/^(di|tri|tetra|penta|hexa)(?=[a-z])/, ''))
    .filter((w) => /[a-z]{3,}/.test(w));
}

async function gradeName(p: Problem, input: string): Promise<Feedback> {
  const answer = input.trim();
  if (!answer) return { verdict: 'invalid', title: 'Type a name first', detail: [] };
  const t = p.trace!;
  const ours = t.name;
  const accepted = (p.accepted ?? [ours]).map(normalizeName);
  const norm = normalizeName(answer);
  if (accepted.includes(norm)) return { verdict: 'correct', title: 'Correct.', detail: norm === normalizeName(ours) ? ['That is the systematic name.'] : [`Accepted. The systematic name under your course profile is ${ours}.`] };
  if (!isOnline()) return { verdict: 'offline', title: 'Offline — cannot check this one yet', detail: ['Names that are not in the accepted list need the name parser (OPSIN), which needs the network. Your answer is kept; try again when you are back online.'] };
  const res = await api<CheckAnswerResponse & { stereo?: unknown }>('/names/check-answer', { targetSmiles: p.smiles, answer }, { timeout: 15000 });
  if (res.verdict === 'unparseable') {
    return { verdict: 'invalid', title: 'That name could not be read as a structure.', detail: [res.message ? `Parser: ${res.message}` : '', ...(res.suggestions?.length ? [`Did you mean: ${res.suggestions.join(' · ')}?`] : []), 'Check spelling, hyphens between numbers and words, and commas between numbers.'].filter(Boolean) };
  }
  if (res.verdict === 'correct') return diagnoseSameMolecule(answer, t);
  if (res.verdict === 'stereo') {
    const theirs = res.answerSmiles ? await call<Analysis>('analyze', { doc: parseSmiles(res.answerSmiles).doc, profileId: studio().settings.profileId }).catch(() => null) : null;
    const given = theirs?.stereo.centres.filter((c) => c.specified).length ?? 0;
    const detail = given === 0 ? [`Your name leaves the configuration open, but this molecule is specifically ${ours.match(STEREO_PREFIX)?.[0]?.slice(0, -1) ?? 'defined'}.`] : ['Your name describes a stereoisomer of this molecule (the same connectivity, a different 3D arrangement).'];
    return { verdict: 'almost', title: 'Right constitution — the stereodescriptor is off.', detail: [...detail, 'Use Explain → Stereo to see the CIP priorities with the lowest one pointing away.'], concept: t.stereo.some((x) => x.kind === 'R/S') ? 'rs' : 'ez', reveal: ours };
  }
  const svg = async (smi: string, highlight: string[]) => call<string>('svg', { doc: parseSmiles(smi).doc, width: 200, height: 140, highlight, dark: document.documentElement.dataset.resolvedTheme !== 'light' }).catch(() => '');
  const theirDoc = parseSmiles(res.answerSmiles!).doc;
  const target = parseSmiles(p.smiles!).doc;
  const diff = await call<string[][]>('mcs', { docs: [target, theirDoc] }).catch(() => [[], []]);
  const [targetSvg, yoursSvg] = await Promise.all([svg(p.smiles!, diff[0]), svg(res.answerSmiles!, diff[1])]);
  const theirs = await call<Analysis>('analyze', { doc: theirDoc, profileId: studio().settings.profileId }).catch(() => null);
  const detail: string[] = [];
  let concept: Concept = 'parent';
  if (res.verdict === 'different') {
    detail.push(`Your name gives ${fmtFormula(res.answerFormula)}, but this molecule is ${fmtFormula(res.targetFormula)}.`);
  } else {
    detail.push('Same formula, different structure (a constitutional isomer).');
  }
  const tt = theirs?.naming?.trace;
  if (tt) {
    if ((tt.principalGroup.kind ?? null) !== (t.principalGroup.kind ?? null)) {
      detail.push(`Your name has ${tt.principalGroup.kind ? `the ${tt.principalGroup.label} as its suffix` : 'no suffix group'}; here the senior group is ${t.principalGroup.kind ? `the ${t.principalGroup.label}` : 'absent (the parent hydride takes no suffix)'}.`);
      concept = 'suffix';
    } else if (tt.parent.atomIds.length !== t.parent.atomIds.length) {
      detail.push(`Your name is built on a ${tt.parent.label}; the parent here is the ${t.parent.label}.`);
      concept = 'parent';
    } else {
      detail.push('The parent matches, but groups sit on different carbons — check each locant against the numbering.');
      concept = 'locants';
    }
  }
  detail.push('Differences are highlighted in both drawings.');
  return { verdict: 'wrong', title: 'That name describes a different molecule.', detail, concept, compare: { target: targetSvg, yours: yoursSvg, yoursName: answer }, reveal: ours };
}

/** Right molecule, non-standard name: say exactly which rule was broken (spec §13 example). */
function diagnoseSameMolecule(answer: string, t: naming.NamingTrace): Feedback {
  const ours = t.name;
  const a = locantsOf(normalizeName(answer));
  const o = locantsOf(normalizeName(ours));
  const stem = t.parent.root.replace(/(ane|ene|yne)$/, '');
  if (!normalizeName(answer).includes(stem)) {
    return { verdict: 'almost', title: 'Right molecule, wrong parent.', detail: [`Your name is built on a different parent chain. The rules pick the ${t.parent.label} (${t.parent.root}) — ${t.parent.alternatives[0] ? `any other candidate loses because ${t.parent.alternatives[0].rejectedBecause}` : 'it is the longest chain containing the principal group'}.`], concept: 'parent', reveal: ours };
  }
  const same = a.length === o.length && a.every((x, k) => x === o[k]);
  if (!same) {
    const n = t.parent.atomIds.length;
    const flipped = o.map((k) => n + 1 - k).sort((x, y) => x - y);
    const alt = t.numbering.alternative;
    if (t.parent.kind === 'chain' && flipped.length === a.length && flipped.every((x, k) => x === a[k]) && alt) {
      return {
        verdict: 'almost',
        title: 'Same carbon skeleton — but numbered from the opposite end.',
        detail: [`That gives locants ${alt.locants.join(',')} instead of ${alt.chosenLocants.join(',')}. The first point of difference is ${alt.firstPointOfDifference}, and the lower number wins.`, 'The correct numbering is shown on the model.'],
        concept: 'locants',
        reveal: ours,
      };
    }
    return { verdict: 'almost', title: 'Right molecule, but not the lowest locants.', detail: [`Your locants are {${a.join(',')}}; the rules give {${o.join(',')}}. ${t.numbering.reason}`], concept: 'locants', reveal: ours };
  }
  const pa = prefixWords(normalizeName(answer), t.parent.root);
  const po = prefixWords(normalizeName(ours), t.parent.root);
  if (pa.length > 1 && pa.join('|') !== po.join('|') && [...pa].sort().join('|') === [...po].sort().join('|')) {
    return { verdict: 'almost', title: 'Right molecule and locants — but prefixes go in alphabetical order.', detail: [`Cite them as: ${po.join(', ')}. Multiplying prefixes (di-, tri-) and sec-/tert- are ignored when alphabetizing; iso- and cyclo- count.`], concept: 'alphabetization', reveal: ours };
  }
  return { verdict: 'almost', title: 'Right molecule — but not in standard form.', detail: ['Check punctuation (hyphens between numbers and letters, commas between numbers), spacing, and whether the stereodescriptor or a locant is missing.'], concept: 'locants', reveal: ours };
}

// --- Build from a name ---------------------------------------------------------------------

async function gradeBuild(p: Problem): Promise<Feedback> {
  const a = await waitForAnalysis(6000);
  const key = a?.identifiers?.inchiKey;
  if (!studio().doc.atoms.length) return { verdict: 'invalid', title: 'Build something first', detail: ['Draw in 2D or add atoms in 3D.'] };
  const errors = a?.validation.filter((v) => v.severity === 'error') ?? [];
  if (errors.length) return { verdict: 'invalid', title: 'Fix the structure first', detail: [errors[0].title] };
  if (!key) return { verdict: 'invalid', title: 'Still analysing — try again in a moment', detail: [] };
  if (key === p.targetKey) return { verdict: 'correct', title: `Correct — that is ${p.targetName}.`, detail: ['Checked by structure (InChIKey including stereochemistry), not by drawing.'] };
  const target = parseSmiles(p.targetSmiles!).doc;
  const yours = studio().doc;
  if (key.slice(0, 14) === p.targetKey!.slice(0, 14)) {
    return { verdict: 'almost', title: 'Right connectivity — the stereochemistry differs.', detail: [`${p.targetName} needs the configuration in its name. Set it with wedge/dash in 2D or R/S in the inspector.`], concept: /\((\d+)?[EZ]/.test(p.targetName ?? '') ? 'ez' : 'rs' };
  }
  const diff = await call<string[][]>('mcs', { docs: [target, { ...yours, conformers: [] }] }).catch(() => [[], []]);
  hl({ id: 'practice:diff', atoms: diff[1], bonds: [], tone: 'danger', pulse: true });
  const tf = (await call<Analysis>('analyze', { doc: target, profileId: studio().settings.profileId })).formula.formula;
  const yf = a?.formula.formula;
  return {
    verdict: 'wrong',
    title: tf === yf ? 'Same formula, different structure.' : `Your structure is ${fmtFormula(yf)}; ${p.targetName} is ${fmtFormula(tf)}.`,
    detail: [`You built ${a?.naming?.name ?? 'something else'}.`, 'Atoms outside the common core are pulsing red. Compare the parent length and where each group sits.'],
    concept: 'build',
  };
}

// ---------------------------------------------------------------------------------------------
// Anki export and shareable problem sets

export async function exportAnki(): Promise<void> {
  const prog = practice().progress;
  const s = studio();
  const cards: Array<{ smiles: string; name: string }> = [];
  if (s.analysis?.identifiers?.canonicalSmiles && (s.verification?.primary?.name ?? s.analysis.naming?.name)) {
    cards.push({ smiles: s.analysis.identifiers.canonicalSmiles, name: s.verification?.primary?.name ?? s.analysis.naming!.name! });
  }
  for (const at of [...prog.attempts].reverse()) {
    if (at.verdict === 'correct' || !at.smiles || !at.name) continue;
    if (!cards.some((c) => c.smiles === at.smiles)) cards.push({ smiles: at.smiles, name: at.name });
    if (cards.length >= 60) break;
  }
  if (!cards.length) {
    s.notify({ kind: 'info', text: 'Nothing to export yet: load a molecule or miss a practice problem first.' });
    return;
  }
  const rows: string[] = ['#separator:tab', '#html:true', '#tags column:3'];
  for (const c of cards) {
    const svg = await call<string>('svg', { doc: parseSmiles(c.smiles).doc, width: 260, height: 190, dark: false }).catch(() => '');
    const front = `${svg.replace(/\s+/g, ' ').replace(/\t/g, ' ')}<div>Name this molecule</div>`;
    const back = `<b>${c.name}</b><br><small>${c.smiles} · from Orbital</small>`;
    rows.push(`${front}\t${back}\torbital`);
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `orbital-anki-${today()}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  track('molecule_exported', { format: 'anki', count: cards.length });
}

export function encodeSet(title: string, items: string[]): string {
  const json = JSON.stringify({ t: title, i: items });
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}/#set=${b64}`;
}

export function decodeSet(hashPart: string): { title: string; items: string[] } | null {
  try {
    const b64 = hashPart.replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (!Array.isArray(j.i)) return null;
    return { title: String(j.t ?? 'Problem set'), items: j.i.map(String).slice(0, 100) };
  } catch {
    return null;
  }
}

export function saveSet(title: string, items: string[]): string {
  const p = structuredClone(practice().progress);
  const id = `set${Date.now()}`;
  p.sets = [...p.sets.filter((x) => x.title !== title), { id, title, items }];
  saveProgress(p);
  return id;
}

/** One item of a problem set: SMILES → "name it"; anything else is treated as a name → "build it". */
export async function startSetItem(item: string): Promise<void> {
  let isSmiles = false;
  try {
    parseSmiles(item);
    isSmiles = !/^[a-z]/.test(item) || /[=#()[\]@]/.test(item);
  } catch {
    isSmiles = false;
  }
  if (isSmiles) return startProblem({ smiles: item, type: 'name', concept: 'parent', source: 'set' });
  const r = await api<{ status: string; candidates: Array<{ canonicalSmiles: string }> }>('/names/resolve', { query: item }).catch(() => null);
  const smi = r?.candidates?.[0]?.canonicalSmiles;
  if (!smi) {
    studio().notify({ kind: 'warning', text: `“${item}” could not be resolved to a structure.` });
    return;
  }
  return startProblem({ smiles: smi, type: 'build', concept: 'build', source: 'set' });
}

/** While a naming problem is open the answer must not be on screen (name bar, explain trigger). */
export function usePracticeHidesName(): boolean {
  return usePractice((s) => !!s.problem?.hidesName && (!s.feedback || s.feedback.verdict === 'invalid' || s.feedback.verdict === 'offline'));
}
