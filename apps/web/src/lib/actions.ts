'use client';
import { create } from 'zustand';
import { emptyDocument, naming, parseMolfile, parseSmiles, suppressHydrogens, updateConformer, type MoleculeDocument } from '@orbital/chem';
import { api, isOnline, type ResolveCandidate, type ResolveResponse } from './api';
import { track } from './analytics';
import { bus } from './events';
import { freshGeometry } from './pipeline';
import { studio, useStudio } from './store';
import { call } from './worker';

export interface SearchState {
  query: string;
  busy: boolean;
  result: ResolveResponse | null;
  cards: Array<{ candidate: ResolveCandidate; svg: string; label: string }>;
  error: string | null;
  set: (p: Partial<SearchState>) => void;
}

export const useSearch = create<SearchState>((set) => ({
  query: '',
  busy: false,
  result: null,
  cards: [],
  error: null,
  set: (p) => set(p),
}));

export const EXAMPLES = [
  { label: 'caffeine', query: 'caffeine' },
  { label: '(R)-2-butanol', query: '(R)-butan-2-ol' },
  { label: '3-ethyl-2-methylhexane', query: '3-ethyl-2-methylhexane' },
  { label: 'cyclohexane chair', query: 'cyclohexane', chair: true },
];

/** Load a structure (SMILES or molfile) as the current molecule, with fresh 2D + 3D. */
export async function loadStructure(text: string, title?: string, label = 'Load molecule'): Promise<boolean> {
  let doc: MoleculeDocument;
  const warnings: string[] = [];
  try {
    if (text.includes('M  END')) {
      const p = parseMolfile(text);
      doc = suppressHydrogens(p.doc);
      warnings.push(...p.warnings);
    } else {
      const p = parseSmiles(text);
      doc = p.doc;
      warnings.push(...p.warnings);
    }
  } catch (e) {
    studio().notify({ kind: 'error', text: `Could not read that structure: ${(e as Error).message}` });
    return false;
  }
  doc.title = title;
  // 2D layout and a quick idealized 3D so something is visible within one frame.
  try {
    const r = await call<{ layout: Record<string, [number, number]>; doc: MoleculeDocument }>('layout2d', { doc });
    doc = { ...r.doc, layout2d: r.layout };
  } catch {
    /* pipeline will retry */
  }
  const hasImported3D = doc.conformers.length > 0;
  if (!hasImported3D) {
    const conf = updateConformer(doc, undefined, doc.atoms.map((a) => a.id));
    doc = { ...doc, conformers: [conf], selectedConformerId: conf.id };
  }
  studio().replace(doc, label);
  if (!hasImported3D) useStudio.setState({ geometry: 'relaxing' });
  for (const w of warnings) studio().notify({ kind: 'info', text: w }, 7000);
  bus.emit('loaded');
  setTimeout(() => bus.emit('fit', 'orient'), 30);
  await freshGeometry(studio().doc, studio().version);
  setTimeout(() => bus.emit('fit', 'orient'), 60);
  track('first_molecule_completed', { via: 'load' });
  return true;
}

export async function loadCandidate(c: ResolveCandidate, label: string): Promise<void> {
  useSearch.getState().set({ cards: [], result: null });
  await loadStructure(c.canonicalSmiles, c.pubchemTitle ?? c.inputName ?? label, `Load ${label}`);
}

/** Universal input (spec §9.1): name, common name, formula, SMILES, InChI, CAS, CID. */
export async function resolveQuery(query: string): Promise<void> {
  const q = query.trim();
  if (!q) return;
  const search = useSearch.getState();
  search.set({ query: q, busy: true, error: null, cards: [], result: null });
  if (!isOnline()) {
    const ok = await offlineResolve(q);
    search.set({ busy: false, error: ok ? null : 'You are offline. Names need the naming service; SMILES, molfiles and recent molecules still work.' });
    return;
  }
  let res: ResolveResponse;
  try {
    res = await api<ResolveResponse>('/names/resolve', { query: q }, { timeout: 20000 });
  } catch {
    const ok = await offlineResolve(q);
    search.set({ busy: false, error: ok ? null : 'The naming service is unreachable right now. SMILES and recent molecules still work offline.' });
    return;
  }
  search.set({ result: res, busy: false });
  if (res.status === 'resolved') {
    track('input_name_resolved', { kind: res.input.interpretedAs.join(',') });
    const c = res.candidates[0];
    await loadCandidate(c, res.input.normalized);
    if (res.input.changes.length) studio().notify({ kind: 'info', text: `Input normalized: ${res.input.changes.join('; ')}.` }, 6000);
    if (!c.stereo.complete) {
      studio().notify({ kind: 'info', text: 'Stereochemistry is not specified in this input; the model shows one arrangement and the name leaves it open.' }, 7000);
    }
  } else if (res.status === 'ambiguous') {
    track('input_name_ambiguous', {});
    const docs = res.candidates.map((c) => parseSmiles(c.canonicalSmiles).doc);
    let diff: string[][] = docs.map(() => []);
    try {
      diff = await call<string[][]>('mcs', { docs });
    } catch {
      /* no highlight */
    }
    const dark = document.documentElement.dataset.resolvedTheme !== 'light';
    const cards = await Promise.all(
      res.candidates.map(async (c, k) => ({
        candidate: c,
        svg: await call<string>('svg', { doc: docs[k], width: 220, height: 150, highlight: diff[k], dark }).catch(() => ''),
        label: c.pubchemTitle ?? c.iupacName ?? (c.sources.includes('smiles') ? 'as SMILES' : c.sources.includes('opsin') ? 'as a systematic name' : c.formula),
      })),
    );
    search.set({ cards });
  } else {
    track('input_name_failed', {});
    search.set({ error: res.opsin?.message ? `Not recognised: ${res.opsin.message}` : 'Not recognised as a name, formula, SMILES, InChI, CAS or CID.' });
  }
}

async function offlineResolve(q: string): Promise<boolean> {
  try {
    parseSmiles(q);
    return loadStructure(q, undefined, 'Load SMILES');
  } catch {
    /* not SMILES */
  }
  const hit = naming.COMMON_NAMES.find((c) => c.name.toLowerCase() === q.toLowerCase());
  if (hit) return loadStructure(hit.smiles, hit.name, `Load ${hit.name}`);
  return false;
}

/** "Build in 3D": start from a single carbon with its four tetrahedral ports. */
export function startWithCarbon(): void {
  const doc = emptyDocument();
  const s = studio();
  s.replace(doc, 'New molecule');
  const next = s.apply({ type: 'addAtom', element: 'C', at: [0, 0] }, { label: 'Add carbon', select: 'created' });
  if (next) useStudio.setState({ view: '3d', mode3d: 'build', landing: false });
}

export function clearMolecule(): void {
  studio().replace(emptyDocument(), 'Clear canvas');
  useStudio.setState({ landing: true });
}
