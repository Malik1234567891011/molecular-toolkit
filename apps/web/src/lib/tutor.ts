'use client';
/**
 * Tutor client (spec §12): streams a grounded, tool-calling conversation. The model sees a
 * structured snapshot of the molecule; its tool calls arrive as actions the studio performs
 * (highlights, naming steps) or proposes (graph edits, which the student must confirm).
 * Conversations live only in memory — nothing is logged or stored.
 */
import { create } from 'zustand';
import type { AtomId } from '@orbital/chem';
import { isOnline } from './api';
import { studio, useStudio } from './store';
import type { Highlight } from './types';

export interface TutorAction {
  name: string;
  input: Record<string, unknown>;
  state?: 'pending' | 'applied' | 'dismissed';
}

export interface NameCheck {
  name: string;
  ref: 'current' | null;
  parsed: boolean;
  matchesCurrent?: boolean;
  describes?: string;
}

export interface TutorMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  actions: TutorAction[];
  names: NameCheck[];
  error?: string;
  offline?: boolean;
  done?: boolean;
}

interface TutorState {
  messages: TutorMessage[];
  busy: boolean;
  available: boolean | null;
  set: (p: Partial<TutorState>) => void;
}

export const useTutor = create<TutorState>((set) => ({ messages: [], busy: false, available: null, set: (p) => set(p) }));
let seq = 1;
let abort: AbortController | null = null;

/** Everything the model may rely on — computed data only (spec §12 "structured graph data"). */
export function snapshot(): Record<string, unknown> {
  const s = studio();
  const a = s.analysis;
  const doc = s.doc;
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  const cip = new Map((a?.stereo.centres ?? []).map((c) => [c.atomId, c.specified ? c.descriptor : 'unspecified']));
  return {
    name: s.verification?.primary?.name ?? a?.naming?.name ?? null,
    provenance: s.verification?.primary?.provenance ?? null,
    acceptedNames: s.verification?.accepted.filter((x) => x.verified).map((x) => x.name).slice(0, 6),
    formula: a?.formula.formula,
    smiles: a?.identifiers?.canonicalSmiles ?? a?.identifiers?.smiles,
    inchiKey: a?.identifiers?.inchiKey,
    atoms: doc.atoms.map((x) => ({
      id: x.id,
      element: x.element,
      charge: x.formalCharge || undefined,
      implicitH: a?.implicitH[x.id],
      aromatic: x.aromatic || undefined,
      hybridization: a?.geometry[x.id]?.hybridization,
      geometry: a?.geometry[x.id]?.molecularGeometry,
      cip: cip.get(x.id),
      locant: a?.naming?.trace?.numbering.locantOf[x.id],
    })),
    bonds: doc.bonds.map((b) => ({ id: b.id, a1: b.a1, a2: b.a2, order: b.order, aromatic: b.aromatic || undefined })),
    functionalGroups: a?.groups.map((g) => ({ kind: g.kind, label: g.label, atomIds: g.atomIds })),
    validation: a?.validation.map((v) => ({ severity: v.severity, title: v.title, atomIds: v.atomIds })),
    stereo: a?.stereo,
    descriptors: a?.identifiers?.descriptors,
    trace: a?.naming?.trace ?? null,
    unsupportedReason: a?.naming?.unsupportedReason,
    selection: s.selection.atoms.length || s.selection.bonds.length ? s.selection : undefined,
    conformer: conf ? { method: conf.method, coordinates: conf.coordinates } : undefined,
    engine: a?.engine,
  };
}

export async function ask(question: string): Promise<void> {
  const q = question.trim();
  if (!q || useTutor.getState().busy) return;
  const st = useTutor.getState();
  const user: TutorMessage = { id: seq++, role: 'user', text: q, actions: [], names: [] };
  const reply: TutorMessage = { id: seq++, role: 'assistant', text: '', actions: [], names: [] };
  useTutor.setState({ messages: [...st.messages, user, reply], busy: true });
  const update = (patch: (m: TutorMessage) => TutorMessage) =>
    useTutor.setState((s) => ({ messages: s.messages.map((m) => (m.id === reply.id ? patch(m) : m)) }));

  if (!isOnline() || st.available === false) {
    update((m) => ({ ...m, text: offlineAnswer(q), offline: true, done: true }));
    useTutor.setState({ busy: false });
    return;
  }
  abort = new AbortController();
  const history = [...st.messages, user].filter((m) => m.text && !m.offline).map((m) => ({ role: m.role, content: m.text }));
  try {
    const res = await fetch('/api/v1/tutor/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-20), snapshot: snapshot() }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let k: number;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, k);
        buf = buf.slice(k + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let ev: { type: string; delta?: string; name?: string; input?: Record<string, unknown>; checks?: NameCheck[]; message?: string; code?: string };
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === 'text' && ev.delta) update((m) => ({ ...m, text: m.text + ev.delta }));
        else if (ev.type === 'action' && ev.name) {
          const action: TutorAction = { name: ev.name, input: ev.input ?? {}, state: ev.name === 'propose_graph_edit' ? 'pending' : undefined };
          update((m) => ({ ...m, actions: [...m.actions, action] }));
          performAction(action);
        } else if (ev.type === 'names' && ev.checks) update((m) => ({ ...m, names: ev.checks! }));
        else if (ev.type === 'error') {
          if (ev.code === 'tutor_unavailable') useTutor.setState({ available: false });
          update((m) => ({ ...m, error: ev.message, text: m.text || offlineAnswer(q), offline: !m.text }));
        } else if (ev.type === 'done') update((m) => ({ ...m, done: true }));
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') update((m) => ({ ...m, error: 'The tutor could not be reached. Here is what the computed data says.', text: m.text || offlineAnswer(q), offline: !m.text }));
  } finally {
    update((m) => ({ ...m, done: true }));
    useTutor.setState({ busy: false });
    abort = null;
  }
}

export function stop(): void {
  abort?.abort();
}

export function clearChat(): void {
  stop();
  useTutor.setState({ messages: [] });
  clearTutorHighlights();
}

function hl(h: Highlight) {
  useStudio.setState((s) => ({ highlights: { ...s.highlights, [h.id]: h } }));
}

export function clearTutorHighlights(): void {
  useStudio.setState((s) => {
    const next: Record<string, Highlight> = {};
    for (const [k, v] of Object.entries(s.highlights)) if (!k.startsWith('tutor:')) next[k] = v;
    return { highlights: next };
  });
}

const valid = (ids: unknown): AtomId[] => {
  const known = new Set(studio().doc.atoms.map((a) => a.id));
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && (known.has(x) || known.has(x.split('.')[0]))) : [];
};

/** Non-mutating actions happen immediately; graph edits wait for the student. */
function performAction(a: TutorAction): void {
  const i = a.input;
  switch (a.name) {
    case 'highlight_atoms':
      clearTutorHighlights();
      hl({ id: 'tutor:hl', atoms: valid(i.atomIds), bonds: [], tone: 'accent', pulse: true, label: String(i.reason ?? '') });
      break;
    case 'highlight_bonds': {
      const known = new Set(studio().doc.bonds.map((b) => b.id));
      const bonds = Array.isArray(i.bondIds) ? i.bondIds.filter((x): x is string => typeof x === 'string' && known.has(x)) : [];
      const atoms = studio().doc.bonds.filter((b) => bonds.includes(b.id)).flatMap((b) => [b.a1, b.a2]);
      clearTutorHighlights();
      hl({ id: 'tutor:hl', atoms, bonds, tone: 'accent', pulse: true, label: String(i.reason ?? '') });
      break;
    }
    case 'measure': {
      const ids = valid(i.atomIds);
      if (ids.length >= 2) useStudio.setState({ measure: ids, mode3d: 'measure' });
      break;
    }
    case 'explain_naming_step':
    case 'compare_parent_candidates':
      void import('../components/panels/ExplainPanel').then(({ highlightsFor, setExplainHighlights }) => {
        const t = studio().analysis?.naming?.trace;
        if (!t) return;
        const steps = ['principal_group', 'parent', 'numbering', 'substituents', 'stereo', 'assembly'];
        const step = a.name === 'compare_parent_candidates' ? 1 : Math.max(0, steps.indexOf(String(i.stepId)));
        const focus = a.name === 'compare_parent_candidates' && t.parent.alternatives.length ? { kind: 'alt' as const, i: Number((i.candidateIndexes as number[] | undefined)?.[0] ?? 0) } : null;
        setExplainHighlights(highlightsFor(t, studio().doc, step, focus, 99, studio().analysis));
        useStudio.setState({ explainStep: step });
      });
      break;
  }
}

/** Apply a confirmed graph edit through the same validated command path as manual edits. */
export async function applyProposal(msgId: number, index: number): Promise<void> {
  const msg = useTutor.getState().messages.find((m) => m.id === msgId);
  const a = msg?.actions[index];
  if (!a) return;
  const i = a.input;
  const s = studio();
  const ids = valid(i.atomIds);
  const summary = String(i.summary ?? 'change').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, _ids, label) => label ?? '').replace(/\s+/g, ' ').trim();
  let ok = true;
  switch (i.action) {
    case 'load_name': {
      const { loadStructure } = await import('./actions');
      ok = await loadStructure(String(i.smiles ?? ''), String(i.name ?? ''), `Tutor: load ${i.name}`);
      break;
    }
    case 'set_element':
      for (const id of ids) ok = !!s.apply({ type: 'setElement', atomId: id, element: String(i.element) }, { label: `Tutor: ${summary}` }) && ok;
      break;
    case 'add_substituent': {
      const { attachSmiles } = await import('./edit');
      ok = ids[0] ? await attachSmiles(ids[0], String(i.substituent ?? '')) : false;
      break;
    }
    case 'remove_atoms':
      ok = !!s.apply({ type: 'removeAtoms', atomIds: ids }, { label: 'Tutor: remove atoms', select: 'none' });
      break;
    case 'set_bond_order':
      ok = !!s.apply({ type: 'setBondOrder', bondId: String(i.bondId), order: Number(i.order) as 1 | 2 | 3 }, { label: 'Tutor: change bond order' });
      break;
    case 'mirror':
      ok = !!s.apply({ type: 'mirror' }, { label: 'Tutor: mirror image' });
      break;
    case 'set_descriptor': {
      const d = String(i.descriptor);
      if (d === 'R' || d === 'S') ok = ids[0] ? !!s.apply({ type: 'setDescriptor', atomId: ids[0], descriptor: d }, { label: `Tutor: make it ${d}` }) : false;
      else if (i.bondId) ok = !!s.apply({ type: 'setDoubleBondDescriptor', bondId: String(i.bondId), descriptor: d as 'E' | 'Z' }, { label: `Tutor: make it ${d}` });
      break;
    }
    default:
      ok = false;
  }
  useTutor.setState((st) => ({
    messages: st.messages.map((m) => (m.id === msgId ? { ...m, actions: m.actions.map((x, k) => (k === index ? { ...x, state: ok ? 'applied' : 'dismissed' } : x)) } : m)),
  }));
  if (!ok) s.notify({ kind: 'warning', text: 'That change could not be applied — it failed the same validation as a manual edit.' });
}

export function dismissProposal(msgId: number, index: number): void {
  clearTutorHighlights();
  useTutor.setState((st) => ({
    messages: st.messages.map((m) => (m.id === msgId ? { ...m, actions: m.actions.map((x, k) => (k === index ? { ...x, state: 'dismissed' } : x)) } : m)),
  }));
}

// ---------------------------------------------------------------------------------------------
// Deterministic explainer (no AI): answers common questions straight from the computed data.

export function offlineAnswer(q: string): string {
  const s = studio();
  const a = s.analysis;
  const t = a?.naming?.trace;
  const lower = q.toLowerCase();
  const sel = s.selection.atoms[0];
  const parts: string[] = [];
  if (/parent|chain|longest|path|why not/.test(lower) && t) {
    const alt = t.parent.alternatives[0];
    parts.push(`The parent is the ${t.parent.label}${t.principalGroup.kind ? ' that carries the principal group' : ''} [[${t.parent.atomIds.join(',')}|highlight it]].`);
    if (alt) parts.push(`A rival ${alt.label} [[${alt.atomIds.join(',')}|highlight it]] loses because ${alt.rejectedBecause}.`);
  }
  if (/number|locant|other end|lowest/.test(lower) && t) parts.push(t.numbering.reason);
  if (/\b(r|s)\b|stereo|chiral|cip|configuration|e\/z|\be\b|\bz\b/.test(lower) && t) {
    if (t.stereo.length) for (const st of t.stereo) parts.push(`[[${st.atomIds.join(',')}|${st.locant ? `C${st.locant}` : 'This centre'}]] is ${st.descriptor}: ${st.explanation}`);
    else if (t.unspecifiedStereo.length) parts.push(`The stereocentre [[${t.unspecifiedStereo.join(',')}|here]] has no configuration drawn, so the name leaves it open.`);
    else parts.push('This molecule has no stereocentres or stereogenic double bonds.');
  }
  if (/sp2|sp3|sp\b|hybrid|geometry|angle|shape/.test(lower)) {
    const id = sel ?? s.doc.atoms.find((x) => a?.geometry[x.id]?.hybridization !== 'sp3')?.id ?? s.doc.atoms[0]?.id;
    const g = id ? a?.geometry[id] : undefined;
    if (id && g) parts.push(`[[${id}|That ${s.doc.atoms.find((x) => x.id === id)?.element}]] has ${g.sigma} σ bond${g.sigma === 1 ? '' : 's'} and ${g.lonePairs} lone pair${g.lonePairs === 1 ? '' : 's'}: ${g.hybridization}, ${g.molecularGeometry}${g.idealAngle ? `, ideal angle ${g.idealAngle}°` : ''}.`);
  }
  if (/suffix|principal|group|functional/.test(lower) && t) parts.push(t.principalGroup.explanation);
  if (!parts.length) {
    if (!a) return 'Load or build a molecule first.';
    parts.push(`This is ${s.verification?.primary?.name ?? a.naming?.name ?? 'a molecule without a verified name'} (${a.formula.formula}).`);
    if (t) parts.push(t.parent.explanation, t.numbering.reason);
    if (a.groupSummary.length) parts.push(`Functional groups: ${a.groupSummary.map((g) => g.label).join(', ')}.`);
  }
  return parts.join(' ');
}
