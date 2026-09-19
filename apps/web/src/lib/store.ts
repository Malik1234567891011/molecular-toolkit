'use client';
import { create } from 'zustand';
import {
  applyCommand, emptyDocument, updateConformer, CommandError, type AtomId, type BondId, type Conformer, type EditCommand, type MoleculeDocument,
} from '@orbital/chem';
import type { Analysis, Highlight, HistoryEntry, InvalidAttempt, Verification } from './types';

export type ViewMode = '2d' | '3d' | 'split';
export type Mode3D = 'build' | 'conformer' | 'measure';
export type RenderStyle = 'kit' | 'licorice' | 'spacefill' | 'geometry' | 'stereo';
export type Tool2D = 'select' | 'draw' | 'chain' | 'ring' | 'erase' | 'charge+' | 'charge-' | 'wedge' | 'hash' | 'wavy';
export type SidePanel = 'facts' | 'explain' | 'practice' | 'tutor' | 'projection' | 'orbitals' | 'mechanism' | 'room' | 'library' | 'settings' | 'resonance';
export type GeometryStatus = 'none' | 'idealized' | 'relaxing' | 'relaxed' | 'failed';

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  motion: 'full' | 'reduced' | 'system';
  contrast: 'normal' | 'high';
  profileId: string;
  showHydrogens: boolean;
  showLabels: boolean;
  showLonePairs: boolean;
  colorBlindSafe: boolean;
  haptics: boolean;
  sound: boolean;
  tourSeen: boolean;
}

export interface Notice {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

export interface StudioState {
  doc: MoleculeDocument;
  /** Bumps on every identity-changing edit; async results carry it to discard stale work. */
  version: number;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: { atoms: AtomId[]; bonds: BondId[] };
  hoverAtom: AtomId | null;
  hoverBond: BondId | null;
  highlights: Record<string, Highlight>;
  view: ViewMode;
  mode3d: Mode3D;
  renderStyle: RenderStyle;
  tool2d: Tool2D;
  armedElement: string;
  ringSize: number;
  ringAromatic: boolean;
  measure: AtomId[];
  panel: SidePanel;
  explainStep: number;
  analysis: Analysis | null;
  analysisVersion: number;
  verification: Verification | null;
  geometry: GeometryStatus;
  geometryNote: string;
  invalid: InvalidAttempt | null;
  notices: Notice[];
  settings: Settings;
  landing: boolean;
  paletteOpen: boolean;
  mobileSheet: 'peek' | 'half' | 'full';
  /** Photo placed under the 2D editor for tracing (world units; never uploaded). */
  underlay: { url: string; x: number; y: number; w: number; h: number; opacity: number } | null;
  /** Rotatable bond being manipulated in conformer mode. */
  activeBond: BondId | null;
  /** Rigid MMFF scan for the active bond (energy curve). */
  scan: { bondId: BondId; dihedral: [AtomId, AtomId, AtomId, AtomId]; angles: number[]; energies: number[]; method: string; e0: number } | null;
  liveEnergy: number | null;

  apply: (cmd: EditCommand, opts?: { label?: string; select?: 'created' | 'keep' | 'none'; skipGeometry?: boolean }) => MoleculeDocument | null;
  replace: (doc: MoleculeDocument, label: string) => void;
  undo: () => void;
  redo: () => void;
  setConformer: (c: Conformer, status: GeometryStatus, note?: string, forVersion?: number) => void;
  select: (atoms: AtomId[], bonds?: BondId[], additive?: boolean) => void;
  clearSelection: () => void;
  setHover: (atom: AtomId | null, bond?: BondId | null) => void;
  setHighlight: (key: string, h: Highlight | null) => void;
  clearHighlights: (prefix?: string) => void;
  set: (patch: Partial<StudioState>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  notify: (n: Omit<Notice, 'id'>, ms?: number) => void;
  dismiss: (id: number) => void;
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  motion: 'system',
  contrast: 'normal',
  profileId: 'iupac-2013',
  showHydrogens: true,
  showLabels: false,
  showLonePairs: false,
  colorBlindSafe: false,
  haptics: true,
  sound: false,
  tourSeen: false,
};

let noticeSeq = 1;

function touchedAtoms(before: MoleculeDocument, after: MoleculeDocument, created: AtomId[]): AtomId[] {
  const out = new Set<AtomId>(created);
  const bmap = new Map(before.bonds.map((b) => [b.id, b]));
  for (const b of after.bonds) {
    const old = bmap.get(b.id);
    if (!old || old.order !== b.order) {
      out.add(b.a1);
      out.add(b.a2);
    }
  }
  const amap = new Map(before.atoms.map((a) => [a.id, a]));
  for (const a of after.atoms) {
    const old = amap.get(a.id);
    if (!old || old.element !== a.element || old.formalCharge !== a.formalCharge || old.radicalElectrons !== a.radicalElectrons) out.add(a.id);
  }
  const ids = new Set(after.atoms.map((a) => a.id));
  for (const b of before.bonds) {
    if (!after.bonds.some((x) => x.id === b.id)) {
      if (ids.has(b.a1)) out.add(b.a1);
      if (ids.has(b.a2)) out.add(b.a2);
    }
  }
  return [...out];
}

const createStudio = () => create<StudioState>((set, get) => ({
  doc: emptyDocument(),
  version: 0,
  past: [],
  future: [],
  selection: { atoms: [], bonds: [] },
  hoverAtom: null,
  hoverBond: null,
  highlights: {},
  view: '3d',
  mode3d: 'build',
  renderStyle: 'kit',
  tool2d: 'draw',
  armedElement: 'C',
  ringSize: 6,
  ringAromatic: false,
  measure: [],
  panel: 'facts',
  explainStep: 0,
  analysis: null,
  analysisVersion: -1,
  verification: null,
  geometry: 'none',
  geometryNote: '',
  invalid: null,
  notices: [],
  settings: DEFAULT_SETTINGS,
  landing: true,
  paletteOpen: false,
  mobileSheet: 'peek',
  activeBond: null,
  underlay: null,
  scan: null,
  liveEnergy: null,

  apply: (cmd, opts = {}) => {
    const before = get().doc;
    let res;
    try {
      res = applyCommand(before, cmd);
    } catch (e) {
      if (e instanceof CommandError) get().notify({ kind: 'warning', text: e.message });
      else get().notify({ kind: 'error', text: `Edit failed: ${(e as Error).message}` });
      return null;
    }
    let doc = res.doc;
    if (res.identityChanged && !opts.skipGeometry) {
      const prev = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
      const touched = touchedAtoms(before, doc, res.created.atoms);
      if (doc.atoms.length) {
        const conf = updateConformer(doc, prev, touched);
        doc = { ...doc, conformers: [conf], selectedConformerId: conf.id };
      } else doc = { ...doc, conformers: [], selectedConformerId: undefined };
    }
    const entry: HistoryEntry = { label: opts.label ?? res.label, before, after: doc, at: Date.now() };
    const selection = opts.select === 'created' ? { atoms: res.created.atoms.slice(-1), bonds: [] } : opts.select === 'none' ? { atoms: [], bonds: [] } : get().selection;
    const validAtoms = new Set(doc.atoms.map((a) => a.id));
    const validBonds = new Set(doc.bonds.map((b) => b.id));
    // Highlights that explained the previous structure are stale after an identity change;
    // open panels (Explain, Projections) re-derive theirs from the new document.
    const keepHighlight = (k: string) => !res.identityChanged || !/^(tutor:|explain:|practice:hint)/.test(k);
    set((s) => ({
      highlights: Object.fromEntries(Object.entries(s.highlights).filter(([k]) => keepHighlight(k))),
      doc,
      version: res.identityChanged ? s.version + 1 : s.version,
      past: [...s.past.slice(-199), entry],
      future: [],
      selection: { atoms: selection.atoms.filter((a) => validAtoms.has(a)), bonds: selection.bonds.filter((b) => validBonds.has(b)) },
      measure: s.measure.filter((a) => validAtoms.has(a)),
      geometry: res.identityChanged && doc.atoms.length ? 'idealized' : s.geometry,
      landing: false,
      invalid: null,
    }));
    if (res.notes.length) get().notify({ kind: 'info', text: res.notes[0] });
    return doc;
  },

  replace: (doc, label) => {
    get().apply({ type: 'replaceDocument', doc, label }, { label, select: 'none', skipGeometry: true });
    set({ geometry: doc.conformers.length ? 'relaxed' : 'none', highlights: {}, measure: [], activeBond: null, explainStep: 0 });
  },

  undo: () => {
    const s = get();
    const last = s.past[s.past.length - 1];
    if (!last) return;
    set({ doc: last.before, version: s.version + 1, past: s.past.slice(0, -1), future: [last, ...s.future], invalid: null, geometry: last.before.conformers.length ? 'relaxed' : 'none' });
    get().notify({ kind: 'info', text: `Undid: ${last.label}` }, 1600);
  },

  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ doc: next.after, version: s.version + 1, past: [...s.past, next], future: s.future.slice(1), invalid: null });
    get().notify({ kind: 'info', text: `Redid: ${next.label}` }, 1600);
  },

  setConformer: (c, status, note = '', forVersion) => {
    const s = get();
    if (forVersion !== undefined && forVersion !== s.version) return; // stale result
    const others = s.doc.conformers.filter((x) => x.id !== c.id);
    set({ doc: { ...s.doc, conformers: [c, ...others], selectedConformerId: c.id }, geometry: status, geometryNote: note });
  },

  select: (atoms, bonds = [], additive = false) => {
    const s = get();
    if (!additive) {
      set({ selection: { atoms, bonds } });
      return;
    }
    const toggle = <T,>(arr: T[], items: T[]) => {
      const out = [...arr];
      for (const it of items) {
        const k = out.indexOf(it);
        if (k >= 0) out.splice(k, 1);
        else out.push(it);
      }
      return out;
    };
    set({ selection: { atoms: toggle(s.selection.atoms, atoms), bonds: toggle(s.selection.bonds, bonds) } });
  },
  clearSelection: () => set({ selection: { atoms: [], bonds: [] }, measure: [], activeBond: null }),
  setHover: (atom, bond = null) => set({ hoverAtom: atom, hoverBond: bond }),
  setHighlight: (key, h) =>
    set((s) => {
      const next = { ...s.highlights };
      if (h) next[key] = h;
      else delete next[key];
      return { highlights: next };
    }),
  clearHighlights: (prefix) =>
    set((s) => {
      if (!prefix) return { highlights: {} };
      const next: Record<string, Highlight> = {};
      for (const [k, v] of Object.entries(s.highlights)) if (!k.startsWith(prefix)) next[k] = v;
      return { highlights: next };
    }),
  set: (patch) => set(patch),
  setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  notify: (n, ms = 4200) => {
    const id = noticeSeq++;
    set((s) => ({ notices: [...s.notices.slice(-3), { ...n, id }] }));
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
}));

// One store per page, even when Fast Refresh re-evaluates this module during development.
const g = globalThis as unknown as { __orbitalStudio?: ReturnType<typeof createStudio> };
export const useStudio = g.__orbitalStudio ?? (g.__orbitalStudio = createStudio());

/** Non-hook accessor for event handlers and async pipelines. */
export const studio = () => useStudio.getState();
