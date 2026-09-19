'use client';
/**
 * Async derivations after every edit: analysis (worker), geometry relaxation (worker),
 * 2D layout for atoms that lack one, and server-side name verification. Stale work is
 * discarded by comparing the document version (spec §7 step 6: "stale requests are cancelled").
 */
import { naming, type MoleculeDocument } from '@orbital/chem';
import { tryApi, type GenerateResponse } from './api';
import { track } from './analytics';
import { studio, useStudio } from './store';
import type { Analysis, NameCandidate, Verification } from './types';
import { call } from './worker';

const verifyCache = new Map<string, Verification>();
let analysisTimer: ReturnType<typeof setTimeout> | undefined;
let relaxTimer: ReturnType<typeof setTimeout> | undefined;
let verifyTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

export function startPipeline(): void {
  if (started) return;
  started = true;
  let lastVersion = -1;
  let lastProfile = studio().settings.profileId;
  useStudio.subscribe((s) => {
    if (s.version !== lastVersion) {
      lastVersion = s.version;
      scheduleAnalysis(0);
      if (s.geometry === 'idealized') scheduleRelax();
      if (s.doc.atoms.some((a) => !s.doc.layout2d[a.id])) void ensureLayout(s.version);
    }
    if (s.settings.profileId !== lastProfile) {
      lastProfile = s.settings.profileId;
      scheduleAnalysis(0);
    }
  });
  scheduleAnalysis(0);
  if (studio().geometry === 'idealized') scheduleRelax();
}

export function scheduleAnalysis(delay = 60): void {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, delay);
}

async function runAnalysis(): Promise<void> {
  const s = studio();
  const version = s.version;
  const doc = s.doc;
  if (!doc.atoms.length) {
    useStudio.setState({ analysis: null, analysisVersion: version, verification: null });
    return;
  }
  try {
    const analysis = await call<Analysis>('analyze', { doc: stripForWorker(doc), profileId: s.settings.profileId });
    if (studio().version !== version) return;
    useStudio.setState({ analysis, analysisVersion: version });
    scheduleVerification(analysis, version);
  } catch (e) {
    if (studio().version !== version) return;
    studio().notify({ kind: 'error', text: `Analysis failed: ${(e as Error).message}` });
  }
}

/** Conformers are large and irrelevant to analysis; don't ship them to the worker. */
function stripForWorker(doc: MoleculeDocument): MoleculeDocument {
  return { ...doc, conformers: [], provenance: [] };
}

/** Minimize from the geometry on screen (spec §7 "Relax minimizes") — keeps the student's conformer. */
export function relaxCurrent(): void {
  clearTimeout(relaxTimer);
  void runRelax();
}

function scheduleRelax(): void {
  clearTimeout(relaxTimer);
  relaxTimer = setTimeout(runRelax, 260);
}

async function runRelax(): Promise<void> {
  const s = studio();
  const version = s.version;
  const conf = s.doc.conformers.find((c) => c.id === s.doc.selectedConformerId) ?? s.doc.conformers[0];
  if (!conf || !s.doc.atoms.length) return;
  useStudio.setState({ geometry: 'relaxing' });
  try {
    const r = await call<{ coords: Record<string, [number, number, number]>; energy: number; converged: boolean; method: string }>('relax', {
      doc: stripForWorker(s.doc), coords: conf.coordinates, maxIts: 800,
    });
    // A newer geometry (fresh conformer, conformer drag) arrived meanwhile: this result is stale.
    const cur = studio().doc;
    if ((cur.conformers.find((c) => c.id === cur.selectedConformerId) ?? cur.conformers[0]) !== conf) return;
    studio().setConformer({ id: conf.id, coordinates: r.coords, method: r.method, energy: r.energy, converged: r.converged }, 'relaxed', r.converged ? '' : 'not fully converged', version);
  } catch (e) {
    if (studio().version !== version) return;
    useStudio.setState({ geometry: 'failed', geometryNote: `Relaxation failed (${(e as Error).message}); showing idealized local geometry.` });
  }
}

export async function freshGeometry(doc: MoleculeDocument, version: number): Promise<void> {
  try {
    const prev = doc.conformers[0]?.coordinates;
    const r = await call<{ coords: Record<string, [number, number, number]>; energy: number; converged: boolean; method: string }>('fresh', { doc: stripForWorker(doc), previous: prev });
    studio().setConformer({ id: 'c1', coordinates: r.coords, method: r.method, energy: r.energy, converged: r.converged }, 'relaxed', '', version);
  } catch (e) {
    if (studio().version !== version) return;
    useStudio.setState({ geometry: 'failed', geometryNote: `3D generation failed (${(e as Error).message}). The 2D structure and naming still work.` });
  }
}

async function ensureLayout(version: number): Promise<void> {
  const s = studio();
  try {
    const r = await call<{ layout: Record<string, [number, number]>; doc: MoleculeDocument }>('layout2d', { doc: stripForWorker(s.doc) });
    if (studio().version !== version) return;
    const cur = studio().doc;
    const layout = { ...r.layout, ...Object.fromEntries(Object.entries(cur.layout2d)) };
    // Keep the student's existing 2D positions only if every atom already had one; otherwise use the clean layout.
    const complete = cur.atoms.every((a) => cur.layout2d[a.id]);
    const bonds = cur.bonds.map((b) => {
      const w = r.doc.bonds.find((x) => x.id === b.id);
      return w ? { ...b, a1: w.a1, a2: w.a2, wedge: w.wedge } : b;
    });
    useStudio.setState({ doc: { ...cur, layout2d: complete ? layout : r.layout, bonds } });
  } catch {
    /* 2D layout is best-effort */
  }
}

export async function cleanLayout(): Promise<void> {
  const s = studio();
  if (!s.doc.atoms.length) return;
  try {
    const r = await call<{ layout: Record<string, [number, number]>; doc: MoleculeDocument }>('layout2d', { doc: stripForWorker(s.doc) });
    s.apply({ type: 'setLayout2D', layout: r.layout }, { label: 'Clean up layout' });
    const cur = studio().doc;
    useStudio.setState({ doc: { ...cur, bonds: cur.bonds.map((b) => { const w = r.doc.bonds.find((x) => x.id === b.id); return w ? { ...b, a1: w.a1, a2: w.a2, wedge: w.wedge } : b; }) } });
  } catch (e) {
    s.notify({ kind: 'warning', text: `Could not clean up: ${(e as Error).message}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Name verification (course engine → OPSIN round trip; PubChem exact match; STOUT slot)

function scheduleVerification(analysis: Analysis, version: number): void {
  clearTimeout(verifyTimer);
  const key = analysis.identifiers?.inchiKey;
  const n = analysis.naming;
  if (!key || !analysis.identifiers?.canonicalSmiles) {
    useStudio.setState({ verification: null });
    return;
  }
  const profile = studio().settings.profileId;
  const cacheKey = `${key}|${profile}|${n?.name ?? ''}|${naming.ENGINE_VERSION}`;
  const hit = verifyCache.get(cacheKey);
  if (hit) {
    useStudio.setState({ verification: hit });
    return;
  }
  const pending: Verification = {
    inchiKey: key,
    status: 'pending',
    primary: n?.name ? { name: n.name, provenance: 'pending', source: 'course-engine', verified: false } : undefined,
    accepted: [],
    unverified: [],
  };
  useStudio.setState({ verification: pending });
  verifyTimer = setTimeout(() => void verify(analysis, version, cacheKey), 350);
}

async function verify(analysis: Analysis, version: number, cacheKey: string): Promise<void> {
  const n = analysis.naming;
  const ids = analysis.identifiers!;
  const course = [
    ...(n?.name ? [{ name: n.name, kind: 'primary' }] : []),
    ...((n?.alternatives ?? []).map((a) => ({ name: a.name, kind: a.kind }))),
  ];
  const res = await tryApi<GenerateResponse>('/names/generate', { smiles: ids.smiles, course }, { timeout: 20000 });
  if (studio().version !== version) return;
  if (!res) {
    const offline: Verification = {
      inchiKey: ids.inchiKey!,
      status: 'offline',
      primary: n?.name ? { name: n.name, provenance: 'offline', source: 'course-engine', verified: false, note: 'Round-trip verification needs the network; shown from the course engine.' } : undefined,
      accepted: [],
      unverified: [],
      message: 'Offline: names come from the course engine and are not yet round-trip verified.',
    };
    useStudio.setState({ verification: offline });
    return;
  }
  const accepted: NameCandidate[] = [];
  const unverified: NameCandidate[] = [];
  let primary: NameCandidate | undefined;
  const alts = n?.alternatives ?? [];
  for (const c of res.course) {
    const verified = c.status === 'verified';
    const alt = alts.find((a) => a.name === c.name);
    const isCommon = alt?.kind === 'retained' || alt?.kind === 'functional-class';
    const cand: NameCandidate = {
      name: c.name,
      provenance: verified ? (isCommon ? 'accepted_common' : alt && alt.kind !== 'systematic' ? 'course_convention' : 'verified_systematic') : 'unverified_candidate',
      source: isCommon ? 'common' : 'course-engine',
      note: alt?.note,
      verified,
    };
    if (c.kind === 'primary') {
      if (verified) primary = cand;
      else unverified.push({ ...cand, note: 'The course engine produced this name but it did not survive the OPSIN round trip.' });
    } else if (verified) accepted.push(cand);
    else unverified.push(cand);
  }
  const db = res.database;
  if (db.status === 'found' && db.iupacName) {
    const dbName: NameCandidate = { name: db.iupacName, provenance: 'database_name', source: 'pubchem', verified: !!db.iupacVerified, note: `PubChem CID ${db.cid} (Lexichem)` };
    if (!primary) primary = dbName;
    else if (dbName.name !== primary.name && !accepted.some((a) => a.name === dbName.name)) accepted.push(dbName);
  }
  if (db.status === 'found') {
    const details = db.synonymDetails ?? (db.synonyms ?? []).map((name) => ({ name, checked: false, kind: 'common' as const }));
    const NOTE = {
      'cas-index': 'CAS index name (inverted), parses to this structure',
      systematic: 'PubChem synonym; OPSIN parses it to this exact structure',
      common: 'PubChem synonym (trivial or trade name, not structure-checked)',
    };
    for (const syn of details.slice(0, 6)) {
      if ([primary?.name, ...accepted.map((a) => a.name)].some((x) => x?.toLowerCase() === syn.name.toLowerCase())) continue;
      accepted.push({ name: syn.name, provenance: 'accepted_common', source: 'pubchem', verified: syn.checked, note: NOTE[syn.kind] });
    }
  }
  const out: Verification = {
    inchiKey: ids.inchiKey!,
    status: 'done',
    primary,
    accepted,
    unverified,
    database: db.status === 'found' ? { cid: db.cid, iupacName: db.iupacName, title: db.title, synonyms: db.synonyms } : undefined,
    ml: res.ml,
    message: !primary
      ? n?.unsupportedReason
        ? `No verified name: ${n.unsupportedReason}.`
        : 'No verified name for this structure yet.'
      : undefined,
  };
  verifyCache.set(cacheKey, out);
  useStudio.setState({ verification: out });
  if (primary) track('structure_name_verified', { provenance: primary.provenance });
  else track('structure_name_unsupported', {});
}
