'use client';
/**
 * The naming trace as a six-step, replayable explanation (spec §9.4). Every step drives the
 * same highlight layer that the 2D and 3D views render, so atoms brighten first and the text
 * follows; the name above dims to the tokens the step is about.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { naming, type AtomId, type BondId, type MoleculeDocument } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { subColor } from '@/lib/colors';
import type { Highlight } from '@/lib/types';
import { NameTokens, tokenInStep } from '../naming/NameBar';
import { ProvenanceBadge } from '../naming/ProvenanceBadge';
import { I } from '../ui/icons';

type Trace = naming.NamingTrace;

const STEPS = [
  { title: 'Choose the principal group', short: 'Group' },
  { title: 'Choose the parent', short: 'Parent' },
  { title: 'Number the parent', short: 'Number' },
  { title: 'Name the substituents', short: 'Prefixes' },
  { title: 'Resolve stereochemistry', short: 'Stereo' },
  { title: 'Assemble the name', short: 'Assemble' },
];

type Focus = { kind: 'alt'; i: number } | { kind: 'other' } | { kind: 'sub'; i: number } | { kind: 'stereo'; i: number } | { kind: 'group'; i: number } | null;

function bondsWithin(doc: MoleculeDocument, atoms: AtomId[]): BondId[] {
  const s = new Set(atoms);
  return doc.bonds.filter((b) => s.has(b.a1) && s.has(b.a2)).map((b) => b.id);
}

function bondBetween(doc: MoleculeDocument, a: AtomId, b: AtomId): BondId | undefined {
  return doc.bonds.find((x) => (x.a1 === a && x.a2 === b) || (x.a1 === b && x.a2 === a))?.id;
}

function setExplainHighlights(hs: Highlight[]) {
  useStudio.setState((s) => {
    const next: Record<string, Highlight> = {};
    for (const [k, v] of Object.entries(s.highlights)) if (!k.startsWith('explain:')) next[k] = v;
    for (const h of hs) next[h.id] = h;
    return { highlights: next };
  });
}

/** Substituents grouped the way the name cites them ("2,2-dimethyl" is one prefix). */
function subGroups(t: Trace) {
  const by = new Map<number, { colorIndex: number; text: string; locants: string[]; atomIds: AtomId[]; attachments: AtomId[] }>();
  for (const s of t.substituents) {
    const g = by.get(s.colorIndex) ?? { colorIndex: s.colorIndex, text: s.text, locants: [], atomIds: [], attachments: [] };
    g.locants.push(String(s.locant));
    g.atomIds.push(...s.atomIds);
    g.attachments.push(s.attachmentAtomId);
    by.set(s.colorIndex, g);
  }
  return [...by.values()];
}

const MULT = ['', '', 'di', 'tri', 'tetra', 'penta', 'hexa', 'hepta', 'octa', 'nona', 'deca'];

export function ExplainPanel() {
  const analysis = useStudio((s) => s.analysis);
  const verification = useStudio((s) => s.verification);
  const doc = useStudio((s) => s.doc);
  const step = useStudio((s) => s.explainStep);
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const trace = analysis?.naming?.trace;
  const tokens = analysis?.naming?.tokens;
  const [focus, setFocus] = useState<Focus>(null);
  const [playing, setPlaying] = useState(false);
  const [reveal, setReveal] = useState(99);

  const go = (k: number) => {
    const n = Math.max(0, Math.min(5, k));
    useStudio.setState({ explainStep: n });
  };

  // Reset per-step focus and animate numbering badges in when a step opens.
  useEffect(() => {
    setFocus(null);
    track('naming_step_opened', { step });
    if (step !== 2 || reduced || !trace) {
      setReveal(99);
      return;
    }
    setReveal(0);
    const n = trace.numbering.orderedAtomIds.length;
    let k = 0;
    const id = setInterval(() => {
      k++;
      setReveal(k);
      if (k >= n) clearInterval(id);
    }, 110);
    return () => clearInterval(id);
  }, [step, trace, reduced]);

  // Replay: walk through all six steps.
  useEffect(() => {
    if (!playing) return;
    if (step >= 5) {
      const t = setTimeout(() => setPlaying(false), 2600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => go(step + 1), step === 2 ? 3600 : 3000);
    return () => clearTimeout(t);
  }, [playing, step]);

  // Drive the shared highlight layer (2D + 3D) from the step and focus.
  useEffect(() => {
    if (!trace) {
      setExplainHighlights([]);
      return;
    }
    setExplainHighlights(highlightsFor(trace, doc, step, focus, reveal, analysis));
  }, [trace, doc, step, focus, reveal, analysis]);
  useEffect(() => () => setExplainHighlights([]), []);

  if (!doc.atoms.length) return <Empty text="Build or load a molecule, then come back to see how its name is derived step by step." />;
  const errors = analysis?.validation.filter((v) => v.severity === 'error') ?? [];
  if (errors.length) return <Empty text={`Fix the structure first: ${errors[0].title}. A name is only derived for a valid molecule.`} />;
  if (!analysis) return <Empty text="Analysing…" />;
  if (!trace || !tokens) {
    return (
      <Empty
        text={`The course engine does not explain this structure: ${analysis.naming?.unsupportedReason ?? 'outside the verified course scope'}. ${verification?.primary ? `The name shown (${verification.primary.name}) comes from ${verification.primary.source === 'pubchem' ? 'PubChem' : 'another source'} and has no step-by-step trace.` : ''}`}
      />
    );
  }
  const primary = verification?.primary;
  const matches = primary?.name === trace.name;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="explain-panel">
      <div className="border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 leading-snug" data-testid="explain-name">
            <NameTokens tokens={tokens} size="md" emphasis={(t) => tokenInStep(t, step)} />
          </div>
          {matches ? <ProvenanceBadge p={primary!.provenance} compact /> : <ProvenanceBadge p={verification?.status === 'pending' ? 'pending' : 'unverified_candidate'} compact />}
        </div>
        {!matches && verification?.status === 'done' && primary && (
          <p className="mt-1.5 text-[11.5px] text-amber">The verified answer shown in the bar is “{primary.name}”; this trace explains the course-engine name.</p>
        )}
      </div>

      <ol className="grid grid-cols-6 gap-1 border-b border-border px-3 py-2" aria-label="Naming steps">
        {STEPS.map((s, k) => {
          const skip = (k === 4 && !trace.stereo.length && !trace.unspecifiedStereo.length) || (k === 3 && !trace.substituents.length) || (k === 0 && !trace.principalGroup.kind);
          return (
            <li key={k}>
              <button
                onClick={() => {
                  setPlaying(false);
                  go(k);
                  track('explanation_interaction', { kind: 'step' });
                }}
                aria-current={step === k ? 'step' : undefined}
                data-testid={`explain-step-${k}`}
                className={`group flex w-full flex-col items-center gap-1 rounded-lg py-1 text-[10.5px] font-medium transition ${step === k ? 'text-accent-strong' : skip ? 'text-text-3/70 hover:text-text-2' : 'text-text-2 hover:text-text'}`}
              >
                <span className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold transition ${step === k ? 'bg-accent text-accent-ink' : k < step ? 'bg-accent-soft text-accent-strong' : 'border border-border-strong'}`}>{k + 1}</span>
                {s.short}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div key={step} className="fade-up" style={{ animationDelay: reduced ? '0ms' : '120ms' }}>
          <h3 className="mb-2 text-[14px] font-semibold">
            <span className="mr-1.5 text-text-3">{step + 1}.</span>
            {STEPS[step].title}
          </h3>
          {step === 0 && <StepGroup trace={trace} focus={focus} setFocus={setFocus} />}
          {step === 1 && <StepParent trace={trace} focus={focus} setFocus={setFocus} />}
          {step === 2 && <StepNumbering trace={trace} focus={focus} setFocus={setFocus} />}
          {step === 3 && <StepSubstituents trace={trace} focus={focus} setFocus={setFocus} />}
          {step === 4 && <StepStereo trace={trace} focus={focus} setFocus={setFocus} />}
          {step === 5 && <StepAssemble trace={trace} tokens={tokens} />}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <button onClick={() => { setPlaying(false); go(step - 1); }} disabled={step === 0} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] text-text-2 hover:bg-panel-raised hover:text-text disabled:opacity-30" data-testid="explain-prev">
          <I.ChevronLeft size={15} /> Back
        </button>
        <button
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              go(0);
              setPlaying(true);
              track('explanation_interaction', { kind: 'replay' });
            }
          }}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-medium hover:border-accent"
          data-testid="explain-replay"
        >
          {playing ? <I.Pause size={14} /> : <I.Play size={14} />} {playing ? 'Pause' : 'Replay all steps'}
        </button>
        <button onClick={() => { setPlaying(false); go(step + 1); }} disabled={step === 5} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-accent-strong hover:bg-accent-soft disabled:opacity-30" data-testid="explain-next">
          Next <I.ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent-strong"><I.Lightbulb size={18} /></span>
      <p className="text-[13px] leading-relaxed text-text-2">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Highlights for each step

function highlightsFor(t: Trace, doc: MoleculeDocument, step: number, focus: Focus, reveal: number, analysis: ReturnType<typeof useStudio.getState>['analysis']): Highlight[] {
  const out: Highlight[] = [];
  const parentBonds = bondsWithin(doc, t.parent.atomIds);
  const parent = (tone: Highlight['tone'], labels?: Record<AtomId, string>): Highlight => ({ id: 'explain:parent', atoms: t.parent.atomIds, bonds: parentBonds, tone, labels });
  switch (step) {
    case 0: {
      const pg = t.principalGroup;
      if (focus?.kind === 'group') {
        const g = pg.present[focus.i];
        if (g) out.push({ id: 'explain:group', atoms: g.atomIds, bonds: bondsWithin(doc, g.atomIds), tone: focus.i === 0 ? 'accent' : 'amber', pulse: true });
      } else if (pg.kind) {
        pg.present.slice(1).forEach((g, k) => out.push({ id: `explain:other${k}`, atoms: g.atomIds, bonds: bondsWithin(doc, g.atomIds), tone: 'faint' }));
        out.push({ id: 'explain:group', atoms: pg.atomIds, bonds: bondsWithin(doc, pg.atomIds), tone: 'accent', pulse: true, label: pg.label });
      }
      break;
    }
    case 1: {
      if (focus?.kind === 'alt') {
        const alt = t.parent.alternatives[focus.i];
        out.push(parent('faint'));
        if (alt) {
          const labels = /chain/.test(alt.label) ? Object.fromEntries(alt.atomIds.map((a, k) => [a, String(k + 1)])) : undefined;
          out.push({ id: 'explain:alt', atoms: alt.atomIds, bonds: bondsWithin(doc, alt.atomIds), tone: 'amber', labels });
        }
      } else {
        out.push({ ...parent('accent'), pulse: true });
      }
      break;
    }
    case 2: {
      if (focus?.kind === 'other' && t.numbering.alternative) {
        out.push({ ...parent('amber'), labels: t.numbering.alternative.locantOf });
      } else {
        const shown = t.numbering.orderedAtomIds.slice(0, reveal);
        out.push(parent('accent', Object.fromEntries(shown.map((a) => [a, t.numbering.locantOf[a]]))));
      }
      break;
    }
    case 3: {
      out.push(parent('faint'));
      subGroups(t).forEach((g, k) => {
        if (focus?.kind === 'sub' && focus.i !== k) return;
        const bonds = bondsWithin(doc, g.atomIds);
        g.attachments.forEach((att, j) => {
          const first = g.atomIds.find((a) => bondBetween(doc, a, att)) ?? g.atomIds[j];
          const b = first ? bondBetween(doc, first, att) : undefined;
          if (b) bonds.push(b);
        });
        out.push({ id: `explain:sub${k}`, atoms: g.atomIds, bonds, tone: 'palette', colorIndex: g.colorIndex, pulse: focus?.kind === 'sub' });
      });
      break;
    }
    case 4: {
      const i = focus?.kind === 'stereo' ? focus.i : 0;
      const st = t.stereo[i];
      if (t.unspecifiedStereo.length) out.push({ id: 'explain:unspec', atoms: t.unspecifiedStereo, bonds: [], tone: 'amber', labels: Object.fromEntries(t.unspecifiedStereo.map((a) => [a, '?'])) });
      if (st?.kind === 'R/S') {
        const centre = st.atomIds[0];
        const labels: Record<string, string> = {};
        for (const p of st.priorities ?? []) {
          if (p.atomId === 'LP') continue;
          labels[p.atomId === 'H' ? `${centre}.h1` : p.atomId] = String(p.rank);
        }
        out.push({ id: 'explain:centre', atoms: [centre], bonds: [], tone: 'accent', pulse: true });
        out.push({ id: 'explain:prio', atoms: [], bonds: [], tone: 'amber', labels });
      } else if (st) {
        const sb = analysis?.stereo.bonds.find((b) => b.atoms.every((a) => st.atomIds.includes(a)));
        const labels: Record<string, string> = {};
        sb?.high.forEach((h) => {
          if (h !== 'H' && h !== 'LP') labels[h] = '1';
        });
        const bond = bondBetween(doc, st.atomIds[0], st.atomIds[1]);
        out.push({ id: 'explain:centre', atoms: st.atomIds, bonds: bond ? [bond] : [], tone: 'accent', pulse: true });
        out.push({ id: 'explain:prio', atoms: Object.keys(labels), bonds: [], tone: 'amber', labels });
      }
      break;
    }
    default: {
      out.push(parent('accent'));
      subGroups(t).forEach((g, k) => out.push({ id: `explain:sub${k}`, atoms: g.atomIds, bonds: bondsWithin(doc, g.atomIds), tone: 'palette', colorIndex: g.colorIndex }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Step 1 — principal characteristic group

const SUFFIX: Record<string, [string, string]> = {
  carboxylate: ['-oate', 'carboxylato'], alkoxide: ['-olate', 'oxido'], carbanion: ['-ide', '—'], ammonium: ['-aminium', 'azaniumyl'], carbocation: ['-ylium', 'ylium'],
  acid: ['-oic acid', 'carboxy'], anhydride: ['-oic anhydride', '—'], ester: ['-oate', 'alkoxycarbonyl'], acidHalide: ['-oyl halide', 'halocarbonyl'],
  amide: ['-amide', 'carbamoyl'], nitrile: ['-nitrile', 'cyano'], aldehyde: ['-al', 'oxo / formyl'], ketone: ['-one', 'oxo'], alcohol: ['-ol', 'hydroxy'],
  thiol: ['-thiol', 'sulfanyl'], amine: ['-amine', 'amino'], imine: ['-imine', 'imino'],
};
const IONIC = new Set(['carboxylate', 'alkoxide', 'carbanion', 'ammonium', 'carbocation']);

interface StepProps {
  trace: Trace;
  focus: Focus;
  setFocus: (f: Focus) => void;
}

function StepGroup({ trace, focus, setFocus }: StepProps) {
  const pg = trace.principalGroup;
  const presentKinds = new Map(pg.present.map((p, k) => [p.kind as string, k]));
  const rows = naming.SENIORITY.filter((k) => !IONIC.has(k) || presentKinds.has(k));
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-text-2" data-testid="explain-text">{pg.explanation}</p>
      {!pg.kind && (
        <p className="rounded-lg bg-panel-raised px-3 py-2 text-[12px] leading-relaxed text-text-2">
          Halogens, nitro groups and ethers are only ever cited as prefixes, and C=C / C≡C change the ending (-ene, -yne) rather than acting as a suffix.
        </p>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-3">
          <span>Seniority, highest first</span>
          <span>suffix · prefix</span>
        </div>
        <table className="w-full border-separate border-spacing-y-0.5 text-[12.5px]" data-testid="priority-table">
          <tbody>
            {rows.map((k, r) => {
              const pi = presentKinds.get(k);
              const isPrincipal = pi === 0 && !!pg.kind;
              const present = pi !== undefined;
              return (
                <tr
                  key={k}
                  onMouseEnter={() => present && setFocus({ kind: 'group', i: pi! })}
                  onMouseLeave={() => present && setFocus(null)}
                  onClick={() => present && setFocus(focus?.kind === 'group' && focus.i === pi ? null : { kind: 'group', i: pi! })}
                  className={`${present ? 'cursor-pointer' : ''} ${isPrincipal ? 'bg-accent-soft' : present ? 'bg-amber-soft' : ''}`}
                >
                  <td className={`w-6 rounded-l-md py-1 pl-2 text-[11px] ${present ? 'text-text-2' : 'text-text-3'}`}>{r + 1}</td>
                  <td className={`py-1 ${present ? 'font-medium text-text' : 'text-text-3'}`}>
                    {naming.CG_LABEL[k]}
                    {isPrincipal && <span className="ml-1.5 rounded bg-accent px-1 py-px text-[10px] font-semibold text-accent-ink">suffix</span>}
                    {present && !isPrincipal && <span className="ml-1.5 rounded bg-amber px-1 py-px text-[10px] font-semibold text-accent-ink">prefix</span>}
                  </td>
                  <td className={`mono py-1 text-right text-[11.5px] ${isPrincipal ? 'text-accent-strong' : 'text-text-3'}`}>{SUFFIX[k]?.[0]}</td>
                  <td className={`mono rounded-r-md py-1 pr-2 text-right text-[11.5px] ${present && !isPrincipal ? 'text-amber' : 'text-text-3'}`}>{SUFFIX[k]?.[1]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2 — parent chain or ring, with "why not this one?"

const CRITERION: Record<string, { label: string; fmt?: (v: string) => string }> = {
  principalCount: { label: 'principal groups on it' },
  ringOverChain: { label: 'ring or chain', fmt: (v) => (v === '1' ? 'ring' : 'chain') },
  largerUnit: { label: 'skeletal atoms' },
  carboMode: { label: 'group carbon inside the chain', fmt: (v) => (v === '0' ? 'yes' : 'no') },
  heterocycle: { label: 'heterocycle', fmt: (v) => (v === '1' ? 'yes' : 'no') },
  nitrogen: { label: 'contains nitrogen', fmt: (v) => (v === '1' ? 'yes' : 'no') },
  ringCount: { label: 'rings' },
  ringSize: { label: 'ring atoms' },
  heteroCount: { label: 'heteroatoms' },
  length: { label: 'chain length (carbons)' },
  multipleBonds: { label: 'double + triple bonds' },
  doubleBonds: { label: 'double bonds' },
  principalLocants: { label: 'principal-group locants', fmt: (v) => `{${v}}` },
  multiLocants: { label: 'multiple-bond locants', fmt: (v) => `{${v}}` },
  doubleLocants: { label: 'double-bond locants', fmt: (v) => `{${v}}` },
  substituentCount: { label: 'substituents on it' },
  substituentLocants: { label: 'substituent locants', fmt: (v) => `{${v}}` },
  alphaLocants: { label: 'first-cited substituent locant', fmt: (v) => `{${v}}` },
  alphanumeric: { label: 'alphanumerical order' },
};

function ladder(profileId: string, bothRings: boolean): string[] {
  const p = naming.PROFILES.find((x) => x.id === profileId) ?? naming.PROFILE_2013;
  const out = ['principalCount'];
  if (p.ringVsChain === '2013') out.push('ringOverChain');
  else out.push('largerUnit', 'ringOverChain');
  out.push('carboMode');
  if (bothRings) out.push('heterocycle', 'nitrogen', 'ringCount', 'ringSize', 'heteroCount');
  if (p.chainSeniority === '1993') out.push('multipleBonds', 'length');
  else out.push('length', 'multipleBonds');
  out.push('doubleBonds', 'principalLocants', 'multiLocants', 'doubleLocants', 'substituentCount', 'substituentLocants', 'alphaLocants', 'alphanumeric');
  return out;
}

function StepParent({ trace, focus, setFocus }: StepProps) {
  const alts = trace.parent.alternatives;
  const sel = focus?.kind === 'alt' ? alts[focus.i] : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
        <span className="text-[13px]">
          <span className="font-semibold">{trace.parent.label}</span>
          <span className="text-text-2"> → </span>
          <span className="nomen font-medium text-accent-strong">{trace.parent.root}</span>
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-text-2" data-testid="explain-text">
        {trace.parent.kind === 'chain'
          ? `The parent is the ${trace.parent.label}${trace.principalGroup.kind ? ' that carries the principal group' : ''}. It glows on the model.`
          : trace.parent.explanation}
      </p>
      {alts.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">Why not this one?</div>
          <ul className="space-y-1" data-testid="parent-alternatives">
            {alts.map((a, k) => {
              const on = focus?.kind === 'alt' && focus.i === k;
              return (
                <li key={k}>
                  <button
                    onClick={() => {
                      setFocus(on ? null : { kind: 'alt', i: k });
                      if (!on) track('explanation_interaction', { kind: 'why_not_parent' });
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left text-[12.5px] transition ${on ? 'border-amber bg-amber-soft' : 'border-border hover:border-border-strong'}`}
                    aria-pressed={on}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${on ? 'bg-amber' : 'border border-text-3'}`} />
                      {a.label}
                    </span>
                    <span className="text-[11.5px] text-text-3">{CRITERION[a.criterion]?.label ?? a.criterion}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {sel && <Comparison trace={trace} alt={sel} />}
    </div>
  );
}

function Comparison({ trace, alt }: { trace: Trace; alt: naming.ParentAlternative }) {
  const profileId = useStudio((s) => s.settings.profileId);
  const bothRings = trace.parent.kind === 'ring' && !/chain/.test(alt.label);
  const rungs = ladder(profileId, bothRings);
  const at = Math.max(0, rungs.indexOf(alt.criterion));
  const c = CRITERION[alt.criterion];
  const fmt = (v?: string) => (v === undefined || v === '' ? '—' : c?.fmt ? c.fmt(v) : v);
  return (
    <div className="fade-up space-y-2.5 rounded-xl border border-border bg-panel-raised p-3" data-testid="parent-comparison">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-accent/50 p-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-accent-strong">Chosen</div>
          <div className="mono mt-0.5 text-[20px] font-semibold">{fmt(alt.values?.chosen)}</div>
          <div className="text-[11px] text-text-3">{c?.label}</div>
        </div>
        <div className="rounded-lg border border-amber/60 p-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-amber">This candidate</div>
          <div className="mono mt-0.5 text-[20px] font-semibold">{fmt(alt.values?.alternative)}</div>
          <div className="text-[11px] text-text-3">{c?.label}</div>
        </div>
      </div>
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">Rules, in order — the first difference decides</div>
        <ol className="flex flex-wrap items-center gap-1 text-[11px]">
          {rungs.slice(0, at + 1).map((r, k) => (
            <li key={r} className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 ${k === at ? 'bg-accent text-accent-ink font-semibold' : 'bg-bg text-text-3'}`}>
              {CRITERION[r]?.label ?? r}
              <span>{k === at ? '✓' : '='}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="text-[12.5px] leading-relaxed text-text-2">Rejected because {alt.rejectedBecause}.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 3 — numbering, both directions on demand

function firstDiff(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return -1;
}

function StepNumbering({ trace, focus, setFocus }: StepProps) {
  const alt = trace.numbering.alternative;
  const other = focus?.kind === 'other';
  const fd = alt ? firstDiff(alt.chosenLocants, alt.locants) : -1;
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-text-2" data-testid="explain-text">{trace.numbering.reason}</p>
      {alt ? (
        <>
          <div role="radiogroup" aria-label="Numbering direction" className="flex rounded-lg border border-border bg-panel-raised p-0.5">
            <button role="radio" aria-checked={!other} onClick={() => setFocus(null)} className={`flex-1 rounded-md py-1 text-[12.5px] font-medium ${!other ? 'bg-accent text-accent-ink' : 'text-text-2'}`}>
              This way (chosen)
            </button>
            <button
              role="radio"
              aria-checked={other}
              data-testid="why-not-other-end"
              onClick={() => {
                setFocus({ kind: 'other' });
                track('why_not_numbering_opened', {});
              }}
              className={`flex-1 rounded-md py-1 text-[12.5px] font-medium ${other ? 'bg-amber text-accent-ink' : 'text-text-2'}`}
            >
              Why not the other end?
            </button>
          </div>
          <div className="space-y-1.5 rounded-xl border border-border bg-panel-raised p-3" data-testid="locant-comparison">
            <LocantRow label="This numbering" set={alt.chosenLocants} fd={fd} tone="accent" win />
            <LocantRow label="Other end" set={alt.locants} fd={fd} tone="amber" />
            {fd >= 0 && (
              <p className="pt-1 text-[12px] text-text-2">
                First point of difference: <span className="mono font-semibold text-accent-strong">{alt.chosenLocants[fd]}</span> vs <span className="mono font-semibold text-amber">{alt.locants[fd]}</span> — the lower locant wins.
              </p>
            )}
          </div>
          {other && <p className="fade-up text-[12px] text-amber">Amber numbers on the model show the rejected direction.</p>}
        </>
      ) : (
        <p className="rounded-lg bg-panel-raised px-3 py-2 text-[12px] text-text-2">No competing direction changes any locant here.</p>
      )}
    </div>
  );
}

function LocantRow({ label, set, fd, tone, win }: { label: string; set: number[]; fd: number; tone: 'accent' | 'amber'; win?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-text-2">{label}</span>
      <span className="flex items-center gap-1">
        {set.map((v, k) => (
          <span
            key={k}
            className={`mono grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-[13px] font-semibold ${k === fd ? (tone === 'accent' ? 'bg-accent text-accent-ink' : 'bg-amber text-accent-ink') : 'border border-border text-text'}`}
          >
            {v}
          </span>
        ))}
        <span className={`ml-1 w-4 ${win ? 'text-good' : 'text-text-3'}`}>{win ? <I.Check size={14} /> : ''}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 4 — substituents

function StepSubstituents({ trace, focus, setFocus }: StepProps) {
  const groups = subGroups(trace);
  const doc = useStudio((s) => s.doc);
  if (!groups.length) return <p className="text-[13px] text-text-2" data-testid="explain-text">Nothing is attached to the parent, so there are no prefixes.</p>;
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-text-2" data-testid="explain-text">
        Everything attached to the parent that is not the principal group becomes a prefix. Each one has its own colour, used on the model and in the name.
      </p>
      <ul className="space-y-1" data-testid="substituent-list">
        {groups.map((g, k) => {
          const on = focus?.kind === 'sub' && focus.i === k;
          const count = g.locants.length;
          const carbons = new Set(g.atomIds).size;
          const els = [...new Set(g.atomIds.map((a) => doc.atoms.find((x) => x.id === a)?.element))].filter(Boolean);
          return (
            <li key={k}>
              <button
                onMouseEnter={() => setFocus({ kind: 'sub', i: k })}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus({ kind: 'sub', i: k })}
                onBlur={() => setFocus(null)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-left transition ${on ? 'border-border-strong bg-panel-raised' : 'border-border'}`}
              >
                <span className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: subColor(g.colorIndex) }} />
                  <span className="nomen text-[13.5px] font-medium" style={{ color: subColor(g.colorIndex) }}>
                    {g.locants.join(',')}-{MULT[count] ?? ''}{g.text}
                  </span>
                </span>
                <span className="text-[11.5px] text-text-3">
                  {count > 1 ? `${count}× ` : ''}
                  {els.join('/')} · {carbons / count} atom{carbons / count > 1 ? 's' : ''} each · on C{g.locants.join(', C')}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {groups.some((g) => g.locants.length > 1) && (
        <p className="text-[12px] text-text-3">Identical prefixes are grouped with di-, tri-, tetra- and every position gets a locant (2,2-dimethyl, never 2-dimethyl).</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 5 — stereochemistry

function StepStereo({ trace, focus, setFocus }: StepProps) {
  const doc = useStudio((s) => s.doc);
  const view = useStudio((s) => s.view);
  const i = focus?.kind === 'stereo' ? focus.i : 0;
  const st = trace.stereo[i];
  const unspec = trace.unspecifiedStereo;
  const lookAway = () => {
    if (!st || st.kind !== 'R/S') return;
    const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
    const centre = st.atomIds[0];
    const low = st.lowestPriority === 'H' ? Object.keys(conf?.coordinates ?? {}).find((k) => k.startsWith(`${centre}.h`)) : st.lowestPriority;
    const c = conf?.coordinates[centre];
    const l = low ? conf?.coordinates[low] : undefined;
    if (!c || !l) return;
    if (view === '2d') useStudio.setState({ view: 'split' });
    setTimeout(() => bus.emit('fit', { dir: [c[0] - l[0], c[1] - l[1], c[2] - l[2]], target: c }), view === '2d' ? 400 : 0);
    track('explanation_interaction', { kind: 'lowest_priority_away' });
  };
  if (!st && !unspec.length) {
    return <p className="text-[13px] leading-relaxed text-text-2" data-testid="explain-text">No stereocentres or stereogenic double bonds, so the name needs no R/S or E/Z descriptors.</p>;
  }
  return (
    <div className="space-y-3">
      {trace.stereo.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {trace.stereo.map((s, k) => (
            <button key={k} onClick={() => setFocus({ kind: 'stereo', i: k })} className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${k === i ? 'bg-accent text-accent-ink' : 'border border-border text-text-2'}`}>
              <i>{s.locant ?? ''}{s.descriptor}</i>
            </button>
          ))}
        </div>
      )}
      {st && (
        <>
          <div className="flex items-center gap-3">
            <StereoDiagram kind={st.kind} descriptor={st.descriptor} />
            <div className="min-w-0">
              <div className="text-[13px]">
                {st.kind === 'R/S' ? 'Centre' : 'Double bond'} {st.locant ? <span className="mono">C{st.locant}</span> : ''} is <i className="font-semibold text-accent-strong">{st.descriptor}</i>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-text-2" data-testid="explain-text">{st.explanation}</p>
            </div>
          </div>
          {st.kind === 'R/S' && st.priorities && (
            <ol className="space-y-0.5 text-[12.5px]" data-testid="cip-priorities">
              {st.priorities.map((p) => (
                <li key={p.rank} className="flex items-center gap-2">
                  <span className="mono grid h-5 w-5 place-items-center rounded-full bg-amber text-[11px] font-semibold text-accent-ink">{p.rank}</span>
                  <span>{p.atomId === 'H' ? 'H (implicit hydrogen)' : p.atomId === 'LP' ? 'lone pair' : describeLigand(doc, p.atomId)}</span>
                  {p.rank === 4 && <span className="text-[11px] text-text-3">lowest — points away</span>}
                </li>
              ))}
            </ol>
          )}
          {st.kind === 'R/S' && (
            <button onClick={lookAway} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium hover:border-accent" data-testid="view-lowest-away">
              <I.Eye size={14} /> View with the lowest priority pointing away
            </button>
          )}
        </>
      )}
      {unspec.length > 0 && (
        <div className="rounded-lg border border-amber/50 bg-amber-soft px-3 py-2 text-[12.5px] leading-relaxed">
          <div className="font-medium text-amber">Stereochemistry not specified</div>
          <p className="mt-0.5 text-text-2">
            {unspec.length === 1 ? 'The atom marked ? is' : `The ${unspec.length} atoms marked ? are`} stereogenic but no configuration was drawn, so the name leaves it open and stands for every stereoisomer. Orbital never picks one for you.
          </p>
          <button
            onClick={() => {
              studio().select([unspec[0]]);
              useStudio.setState({ panel: 'facts' });
            }}
            className="mt-1.5 text-[12px] font-medium text-accent-strong hover:underline"
          >
            Choose R or S in the inspector →
          </button>
        </div>
      )}
    </div>
  );
}

function describeLigand(doc: MoleculeDocument, id: AtomId): string {
  const a = doc.atoms.find((x) => x.id === id);
  if (!a) return id;
  const n = doc.bonds.filter((b) => b.a1 === id || b.a2 === id).length;
  const name: Record<string, string> = { C: 'carbon', O: 'oxygen', N: 'nitrogen', S: 'sulfur', Cl: 'chlorine', Br: 'bromine', I: 'iodine', F: 'fluorine', P: 'phosphorus' };
  return `${a.element} (${name[a.element] ?? a.element}${a.element === 'C' ? `, ${n} heavy neighbour${n > 1 ? 's' : ''}` : ''})`;
}

function StereoDiagram({ kind, descriptor }: { kind: string; descriptor: string }) {
  if (kind === 'R/S') {
    const cw = descriptor === 'R';
    // Ligands 1–3 around the centre with 4 behind it; the arc sweeps 1 → 2 → 3.
    const at = (deg: number, r: number) => [44 + r * Math.cos((deg * Math.PI) / 180), 42 - r * Math.sin((deg * Math.PI) / 180)];
    const angles = cw ? [90, -30, 210] : [90, 210, -30];
    const [sx, sy] = at(cw ? 68 : 112, 30);
    const [ex, ey] = at(cw ? -135 : 315, 30);
    return (
      <svg width="88" height="84" viewBox="0 0 88 84" className="shrink-0" aria-label={`${descriptor}: 1 to 2 to 3 runs ${cw ? 'clockwise' : 'counter-clockwise'} with 4 pointing away`}>
        <defs>
          <marker id="cip-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10z" fill="var(--accent)" />
          </marker>
        </defs>
        <path d={`M ${sx} ${sy} A 30 30 0 1 ${cw ? 1 : 0} ${ex} ${ey}`} fill="none" stroke="var(--accent)" strokeWidth="2" markerEnd="url(#cip-arrow)" />
        <circle cx="44" cy="42" r="6" fill="var(--text-3)" />
        <text x="44" y="45" textAnchor="middle" fontSize="8" fontWeight="600" fill="var(--bg)">4</text>
        {angles.map((deg, k) => {
          const [x, y] = at(deg, 22);
          return (
            <g key={k}>
              <circle cx={x} cy={y} r="8" fill="var(--amber)" />
              <text x={x} y={y + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="#0b0e14">{k + 1}</text>
            </g>
          );
        })}
      </svg>
    );
  }
  const z = descriptor === 'Z' || descriptor === 'cis';
  return (
    <svg width="80" height="72" viewBox="0 0 80 72" className="shrink-0" aria-label={`${descriptor}: higher priorities ${z ? 'same side' : 'opposite sides'}`}>
      <line x1="26" y1="34" x2="54" y2="34" stroke="var(--text-2)" strokeWidth="2" />
      <line x1="26" y1="39" x2="54" y2="39" stroke="var(--text-2)" strokeWidth="2" />
      <line x1="26" y1="36" x2="12" y2="14" stroke="var(--text-2)" strokeWidth="2" />
      <line x1="54" y1="36" x2="68" y2={z ? 14 : 60} stroke="var(--text-2)" strokeWidth="2" />
      <circle cx="12" cy="14" r="7" fill="var(--amber)" />
      <circle cx="68" cy={z ? 14 : 60} r="7" fill="var(--amber)" />
      <text x="12" y="17.5" textAnchor="middle" fontSize="9" fontWeight="600" fill="#0b0e14">1</text>
      <text x="68" y={(z ? 14 : 60) + 3.5} textAnchor="middle" fontSize="9" fontWeight="600" fill="#0b0e14">1</text>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 6 — assembly: prefixes slide into alphabetical order

function alphaKey(prefix: string): { key: string; ignored: string } {
  let rest = prefix.replace(/^(?:\d+[a-z]?'*|N|O|S)(?:,(?:\d+[a-z]?'*|N|O|S))*-/, '');
  let ignored = '';
  const m = /^(di|tri|tetra|penta|hexa|hepta|octa|nona|deca)(?=[a-z])/.exec(rest);
  if (m) {
    ignored = m[1];
    rest = rest.slice(m[1].length);
  }
  const it = /^(sec-|tert-)/.exec(rest);
  if (it) {
    ignored = ignored + it[1];
    rest = rest.slice(it[1].length);
  }
  const letter = /[a-z]/i.exec(rest.replace(/^\(|^\[/, ''))?.[0] ?? '';
  return { key: letter.toLowerCase(), ignored };
}

function StepAssemble({ trace, tokens }: { trace: Trace; tokens: naming.NameToken[] }) {
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const verification = useStudio((s) => s.verification);
  const groups = subGroups(trace);
  const prefixes = trace.assembly.filter((p) => !/^\(.*\)$/.test(p) && p !== trace.assembly[trace.assembly.length - 1]);
  const stereoPart = trace.assembly.find((p) => /^\(.*\)$/.test(p));
  const byPosition = useMemo(() => {
    const first = (p: string) => parseFloat(/^\d+/.exec(p)?.[0] ?? '99');
    return [...prefixes].sort((a, b) => first(a) - first(b));
  }, [prefixes.join('|')]);
  const [alpha, setAlpha] = useState(reduced);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const replay = () => {
    setAlpha(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAlpha(true), reduced ? 0 : 900);
  };
  useEffect(() => {
    replay();
    return () => clearTimeout(timer.current);
  }, []);
  const ROW = 34;
  const colorOf = (p: string) => {
    const bare = p.replace(/^[^a-z(]*-/i, '').replace(/^(di|tri|tetra|penta|hexa|bis|tris)(?=[a-z(])/, '').replace(/^\((.*)\)$/, '$1');
    const g = groups.find((x) => x.text === bare) ?? groups.find((x) => p.endsWith(x.text) && !groups.some((y) => y !== x && y.text.length > x.text.length && p.endsWith(y.text)));
    return g ? subColor(g.colorIndex) : 'var(--text)';
  };
  return (
    <div className="space-y-3">
      {prefixes.length > 1 ? (
        <>
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-text-2" data-testid="explain-text">
              Prefixes are cited in <b className="font-semibold text-text">alphabetical order</b>, not by position.
            </p>
            <button onClick={replay} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft">Replay</button>
          </div>
          <div className="relative rounded-xl border border-border bg-panel-raised" style={{ height: prefixes.length * ROW + 12 }} data-testid="alpha-sort">
            {prefixes.map((p) => {
              const idx = (alpha ? prefixes : byPosition).indexOf(p);
              const k = alphaKey(p);
              return (
                <div
                  key={p}
                  className="absolute inset-x-2 flex items-center justify-between rounded-lg px-2"
                  style={{ top: 6, height: ROW - 4, transform: `translateY(${idx * ROW}px)`, transition: reduced ? 'none' : 'transform 520ms cubic-bezier(0.2, 0.8, 0.2, 1)' }}
                >
                  <span className="nomen text-[14px] font-medium" style={{ color: colorOf(p) }}>{p}</span>
                  <span className="text-[11.5px] text-text-3">
                    filed under <b className="mono text-text">{k.key}</b>
                    {k.ignored && <> · “{k.ignored}” ignored</>}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-[11.5px] text-text-3">{alpha ? 'Alphabetical order (as cited in the name).' : 'By position on the chain…'}</p>
        </>
      ) : (
        <p className="text-[13px] text-text-2" data-testid="explain-text">
          {prefixes.length === 1 ? 'With one prefix there is nothing to alphabetize; it goes directly in front of the parent.' : 'No prefixes: the name is the parent with its endings.'}
        </p>
      )}
      <div className="rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">Assembled</div>
        <div className="flex flex-wrap items-center gap-1">
          {trace.assembly.map((part, k) => (
            <span key={k} className="flex items-center gap-1">
              {k > 0 && <span className="text-[11px] text-text-3">+</span>}
              <span
                className="fade-up nomen rounded-md border border-border bg-panel px-1.5 py-0.5 text-[13px] font-medium"
                style={{ animationDelay: reduced ? '0ms' : `${1000 + k * 160}ms`, color: /^\(.*\)$/.test(part) ? 'var(--accent-strong)' : prefixes.includes(part) ? colorOf(part) : undefined }}
              >
                {part}
              </span>
            </span>
          ))}
        </div>
        <div className="fade-up mt-2" style={{ animationDelay: reduced ? '0ms' : `${1100 + trace.assembly.length * 160}ms` }} data-testid="assembled-name">
          <NameTokens tokens={tokens} size="md" />
        </div>
      </div>
      <ul className="space-y-1 text-[12px] text-text-2">
        <li>• Commas separate locants (2,3); hyphens join locants to words (2,3-dimethyl).</li>
        <li>• No space or hyphen before the parent name when a prefix ends in a letter (ethylhexane).</li>
        {stereoPart && <li>• Stereodescriptors go first, in parentheses: {stereoPart}-</li>}
      </ul>
      {verification?.accepted.length ? (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">Also accepted</div>
          <ul className="space-y-0.5 text-[12.5px]">
            {verification.accepted.slice(0, 4).map((c) => (
              <li key={c.name} className="flex justify-between gap-2">
                <span className="nomen">{c.name}</span>
                <ProvenanceBadge p={c.provenance} compact />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
