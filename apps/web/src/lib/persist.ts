'use client';
/**
 * Local-first persistence (spec §18: "No visually committed edit is ever lost on refresh").
 * The current document is written to IndexedDB within ~150 ms of every change; recent
 * molecules are kept for the library and offline use.
 */
import { get, set, del, keys } from 'idb-keyval';
import { stereoMismatches, type MoleculeDocument } from '@orbital/chem';
import { studio, useStudio, type Settings } from './store';

const CURRENT = 'orbital:current';
const RECENTS = 'orbital:recents';
const SETTINGS = 'orbital:settings';

export interface RecentEntry {
  id: string;
  title: string;
  smiles?: string;
  name?: string;
  updated: number;
  doc: MoleculeDocument;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSavedVersion = -1;

export async function restore(): Promise<boolean> {
  try {
    const [doc, settings] = await Promise.all([get<MoleculeDocument>(CURRENT), get<Partial<Settings>>(SETTINGS)]);
    if (settings) studio().setSettings(settings);
    if (doc && doc.atoms?.length) {
      // A saved geometry that contradicts the stored R/S or E/Z (older sessions) is rebuilt.
      const conf = doc.conformers?.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers?.[0];
      const wrong = conf ? stereoMismatches(doc, conf.coordinates) : null;
      const stale = !!wrong && (wrong.centres.length > 0 || wrong.bonds.length > 0);
      useStudio.setState({ doc, version: studio().version + 1, landing: false, geometry: stale ? 'idealized' : doc.conformers?.length ? 'relaxed' : 'none' });
      return true;
    }
  } catch {
    /* storage unavailable (private mode): the app still works */
  }
  return false;
}

export function startAutosave(): void {
  useStudio.subscribe((s, prev) => {
    if (s.doc !== prev.doc) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveNow(), 150);
    }
    if (s.settings !== prev.settings) void set(SETTINGS, s.settings).catch(() => undefined);
  });
  window.addEventListener('pagehide', () => void saveNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveNow();
  });
}

async function saveNow(): Promise<void> {
  const s = studio();
  if (s.version === lastSavedVersion && s.doc.atoms.length) {
    await set(CURRENT, s.doc).catch(() => undefined);
    return;
  }
  lastSavedVersion = s.version;
  try {
    if (s.doc.atoms.length) await set(CURRENT, s.doc);
    else await del(CURRENT);
    if (s.doc.atoms.length && s.analysis?.identifiers?.inchiKey) await remember(s.doc, s.analysis.identifiers.canonicalSmiles, s.verification?.primary?.name ?? s.analysis.naming?.name);
  } catch {
    /* quota or private mode */
  }
}

async function remember(doc: MoleculeDocument, smiles?: string, name?: string): Promise<void> {
  const list = (await get<RecentEntry[]>(RECENTS)) ?? [];
  const id = smiles ?? doc.title ?? 'untitled';
  const entry: RecentEntry = { id, title: doc.title ?? name ?? smiles ?? 'Untitled molecule', smiles, name, updated: Date.now(), doc };
  const next = [entry, ...list.filter((x) => x.id !== id)].slice(0, 40);
  await set(RECENTS, next);
}

export async function recents(): Promise<RecentEntry[]> {
  try {
    return (await get<RecentEntry[]>(RECENTS)) ?? [];
  } catch {
    return [];
  }
}

export async function exportAllLocal(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of await keys()) if (String(k).startsWith('orbital:')) out[String(k)] = await get(k);
  return out;
}

export async function deleteAllLocal(): Promise<void> {
  for (const k of await keys()) if (String(k).startsWith('orbital:')) await del(k);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
}
