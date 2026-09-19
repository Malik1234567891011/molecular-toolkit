'use client';
/**
 * Isomers of a formula (spec §9.1 "formula"): typing C5H10 asks what structures that formula can
 * make, not which one a database happens to know. The chemistry engine works them out from the
 * bonding rules in the worker; this holds the page of results the panel shows.
 */
import { create } from 'zustand';
import { writeSmiles, type MoleculeDocument } from '@orbital/chem';
import { call } from './worker';
import { studio, useStudio } from './store';
import { loadStructure } from './actions';
import { track } from './analytics';

export interface IsomerCard {
  doc: MoleculeDocument;
  svg: string;
  name: string | null;
}

interface IsomerState {
  formula: string | null;
  counts: Record<string, number>;
  cards: IsomerCard[];
  total: number;
  truncated: boolean;
  note?: string;
  loading: boolean;
  error: string | null;
}

const PAGE = 24;

export const useIsomers = create<IsomerState>(() => ({
  formula: null, counts: {}, cards: [], total: 0, truncated: false, loading: false, error: null,
}));

/** "C5H10" → { C: 5, H: 10 }; null when it isn't a plain formula. */
export function parseFormula(text: string): Record<string, number> | null {
  const t = text.replace(/\s+/g, '');
  if (!/^([A-Z][a-z]?\d*)+$/.test(t)) return null;
  const counts: Record<string, number> = {};
  for (const [, el, n] of t.matchAll(/([A-Z][a-z]?)(\d*)/g)) counts[el] = (counts[el] ?? 0) + (n ? Number(n) : 1);
  return Object.keys(counts).length ? counts : null;
}

const pretty = (counts: Record<string, number>) =>
  Object.entries(counts).map(([el, n]) => el + (n > 1 ? n : '')).join('');

interface Page { page: IsomerCard[]; total: number; truncated: boolean; note?: string }

/**
 * Work out the isomers of a formula and show them. Returns how many there are, so the caller can
 * fall back to a database lookup when the engine can't enumerate this one.
 */
export async function openIsomers(counts: Record<string, number>, label?: string): Promise<number> {
  const formula = label ?? pretty(counts);
  useIsomers.setState({ formula, counts, cards: [], total: 0, truncated: false, note: undefined, loading: true, error: null });
  try {
    const r = await call<Page>('isomers', { counts, profileId: studio().settings.profileId, offset: 0, count: PAGE, dark: document.documentElement.dataset.resolvedTheme !== 'light' });
    useIsomers.setState({ cards: r.page, total: r.total, truncated: r.truncated, note: r.note, loading: false });
    if (r.total) {
      useStudio.setState({ panel: 'isomers', landing: false });
      track('explanation_interaction', { kind: 'isomers', formula, count: r.total });
    }
    return r.total;
  } catch (e) {
    useIsomers.setState({ loading: false, error: (e as Error).message });
    return 0;
  }
}

export async function moreIsomers(): Promise<void> {
  const s = useIsomers.getState();
  if (s.loading || s.cards.length >= s.total) return;
  useIsomers.setState({ loading: true });
  try {
    const r = await call<Page>('isomers', { counts: s.counts, profileId: studio().settings.profileId, offset: s.cards.length, count: PAGE, dark: document.documentElement.dataset.resolvedTheme !== 'light' });
    useIsomers.setState((prev) => ({ cards: [...prev.cards, ...r.page], loading: false }));
  } catch (e) {
    useIsomers.setState({ loading: false, error: (e as Error).message });
  }
}

/** Open one isomer in the studio, keeping the list to come back to. */
export async function openIsomer(card: IsomerCard): Promise<void> {
  const smiles = writeSmiles(card.doc, { includeStereo: false }).smiles;
  await loadStructure(smiles, card.name ?? undefined, `Open ${card.name ?? 'isomer'}`);
}
