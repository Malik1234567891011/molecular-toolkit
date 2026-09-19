'use client';
import { useEffect, useMemo, useState } from 'react';
import { applyCommand, parseSmiles, prettyFormula, writeSmiles, type MoleculeDocument } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { loadStructure } from '@/lib/actions';
import { recents, type RecentEntry } from '@/lib/persist';
import { LIBRARY } from '@/lib/library';
import { call } from '@/lib/worker';
import type { Analysis } from '@/lib/types';

type Tab = 'library' | 'recent' | 'compare';

export function LibraryPanel() {
  const [tab, setTab] = useState<Tab>('library');
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="library-panel">
      <div role="tablist" className="mx-3 mt-3 flex rounded-lg border border-border bg-panel-raised p-0.5">
        {(['library', 'recent', 'compare'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`flex-1 rounded-md py-1.5 text-[12px] font-medium capitalize ${tab === t ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text'}`} data-testid={`lib-tab-${t}`}>
            {t === 'compare' ? 'Compare isomers' : t}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'library' && <Curated />}
        {tab === 'recent' && <Recent />}
        {tab === 'compare' && <Compare />}
      </div>
    </div>
  );
}

function Curated() {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const f = q.trim().toLowerCase();
    const items = LIBRARY.filter((x) => !f || x.name.toLowerCase().includes(f) || x.why.toLowerCase().includes(f) || x.category.toLowerCase().includes(f));
    const out = new Map<string, typeof LIBRARY>();
    for (const it of items) out.set(it.category, [...(out.get(it.category) ?? []), it]);
    return [...out.entries()];
  }, [q]);
  return (
    <div className="space-y-4">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter the library…" className="w-full rounded-lg border border-border bg-panel-raised px-3 py-1.5 text-[13px]" aria-label="Filter the library" />
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">{cat}</h3>
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.name}>
                <button onClick={() => void loadStructure(it.smiles, it.name, `Load ${it.name}`)} className="w-full rounded-xl border border-border px-3 py-2 text-left hover:border-accent" data-testid="library-item">
                  <span className="block text-[13px] font-medium">{it.name}</span>
                  <span className="block text-[11.5px] leading-snug text-text-2">{it.why}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Recent() {
  const [items, setItems] = useState<RecentEntry[] | null>(null);
  useEffect(() => {
    void recents().then(setItems);
  }, []);
  if (!items) return <p className="text-[13px] text-text-3">Loading…</p>;
  if (!items.length) return <p className="text-[13px] text-text-2">Molecules you build or load appear here, saved on this device (and available offline).</p>;
  return (
    <ul className="space-y-1">
      {items.map((r) => (
        <li key={r.id}>
          <button onClick={() => studio().replace(r.doc, `Open ${r.title}`)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-left hover:border-accent">
            <span className="min-w-0">
              <span className="nomen block truncate text-[13px] font-medium">{r.name ?? r.title}</span>
              <span className="mono block truncate text-[11px] text-text-3">{r.smiles}</span>
            </span>
            <span className="shrink-0 text-[11px] text-text-3">{new Date(r.updated).toLocaleDateString()}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Isomer comparison (spec §14): relationship label + diffed properties, side by side.

interface Side {
  smiles: string;
  doc: MoleculeDocument;
  analysis: Analysis;
  svg: string;
  key: string;
  /** Has stereocentres yet is its own mirror image (an internal mirror plane). */
  meso: boolean;
}

async function describe(smiles: string): Promise<Side> {
  const doc = parseSmiles(smiles).doc;
  const [analysis, svg] = await Promise.all([
    call<Analysis>('analyze', { doc, profileId: studio().settings.profileId }),
    call<string>('svg', { doc, width: 200, height: 150, dark: document.documentElement.dataset.resolvedTheme !== 'light' }),
  ]);
  const key = analysis.identifiers?.inchiKey ?? '';
  const specified = analysis.stereo.centres.filter((c) => c.specified).length;
  let meso = false;
  if (specified >= 2 && key) {
    const mirror = applyCommand(doc, { type: 'mirror' }).doc;
    meso = (await call<string | null>('inchikey', { smiles: writeSmiles(mirror).smiles })) === key;
  }
  return { smiles, doc, analysis, svg, key, meso };
}

async function relationship(a: Side, b: Side): Promise<{ label: string; detail: string }> {
  if (a.key && a.key === b.key) return { label: 'Identical', detail: 'Same compound: identical InChIKey, including stereochemistry.' };
  if (a.key.slice(0, 14) === b.key.slice(0, 14)) {
    const mirror = applyCommand(a.doc, { type: 'mirror' }).doc;
    const mk = await call<string | null>('inchikey', { smiles: writeSmiles(mirror).smiles });
    if (mk && mk === b.key) return { label: 'Enantiomers', detail: 'Non-superimposable mirror images: every stereocentre is inverted.' };
    const meso = a.meso ? 'The first' : b.meso ? 'The second' : null;
    return {
      label: 'Diastereomers',
      detail: `Same connectivity, different arrangement in space, and not mirror images.${meso ? ` ${meso} is meso: it has an internal mirror plane, so despite its stereocentres it is achiral — its own mirror image.` : ''}`,
    };
  }
  if (a.analysis.formula.formula === b.analysis.formula.formula) return { label: 'Constitutional isomers', detail: 'Same formula, atoms connected differently.' };
  return { label: 'Different compounds', detail: 'Different molecular formulas.' };
}

function Compare() {
  const current = useStudio((s) => s.analysis?.identifiers?.canonicalSmiles ?? '');
  const [left, setLeft] = useState(current);
  const [right, setRight] = useState('');
  const [result, setResult] = useState<{ a: Side; b: Side; rel: { label: string; detail: string } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (l = left, r = right) => {
    setErr(null);
    setBusy(true);
    try {
      const resolve = async (text: string) => {
        try {
          parseSmiles(text);
          return text;
        } catch {
          const { api } = await import('@/lib/api');
          const r = await api<{ candidates: Array<{ canonicalSmiles: string }> }>('/names/resolve', { query: text });
          if (!r.candidates[0]) throw new Error(`Could not resolve “${text}”`);
          return r.candidates[0].canonicalSmiles;
        }
      };
      const [sa, sb] = await Promise.all([resolve(l.trim()), resolve(r.trim())]);
      const [a, b] = await Promise.all([describe(sa), describe(sb)]);
      setResult({ a, b, rel: await relationship(a, b) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows: Array<[string, (s: Side) => string]> = [
    ['Name', (s) => s.analysis.naming?.name ?? '—'],
    ['Formula', (s) => prettyFormula(s.analysis.formula.counts, s.analysis.formula.charge)],
    ['Molar mass', (s) => `${s.analysis.identifiers?.descriptors?.molarMass.toFixed(2) ?? '—'} g/mol`],
    ['logP', (s) => s.analysis.identifiers?.descriptors?.logP.toFixed(2) ?? '—'],
    ['TPSA', (s) => `${s.analysis.identifiers?.descriptors?.tpsa.toFixed(1) ?? '—'} Å²`],
    ['Stereo', (s) => ([...s.analysis.stereo.centres.map((c) => c.descriptor ?? '?'), ...s.analysis.stereo.bonds.map((x) => x.descriptor ?? '?')].join(', ') || 'none') + (s.meso ? ' (meso)' : '')],
  ];
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-text-2">Compare two structures (names or SMILES). Orbital labels the relationship from their graphs.</p>
      <input value={left} onChange={(e) => setLeft(e.target.value)} placeholder="First molecule" className="w-full rounded-lg border border-border bg-panel-raised px-3 py-1.5 text-[13px]" aria-label="First molecule" data-testid="compare-a" />
      <input value={right} onChange={(e) => setRight(e.target.value)} placeholder="Second molecule, e.g. (S)-butan-2-ol" className="w-full rounded-lg border border-border bg-panel-raised px-3 py-1.5 text-[13px]" aria-label="Second molecule" data-testid="compare-b" />
      <button onClick={() => void run()} disabled={busy || !left.trim() || !right.trim()} className="w-full rounded-lg bg-accent py-1.5 text-[13px] font-semibold text-accent-ink disabled:opacity-50" data-testid="compare-run">
        {busy ? 'Comparing…' : 'Compare'}
      </button>
      {err && <p className="text-[12.5px] text-danger">{err}</p>}
      {result && (
        <div className="fade-up space-y-2">
          <div className="rounded-xl border border-accent/50 bg-accent-soft px-3 py-2" data-testid="compare-result">
            <div className="text-[15px] font-semibold">{result.rel.label}</div>
            <div className="text-[12px] text-text-2">{result.rel.detail}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[result.a, result.b].map((s, k) => (
              <div key={k} className="rounded-lg border border-border bg-panel-raised p-1 [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: s.svg }} />
            ))}
          </div>
          <table className="w-full text-[12px]">
            <tbody>
              {rows.map(([label, f]) => {
                const va = f(result.a);
                const vb = f(result.b);
                return (
                  <tr key={label} className="border-b border-border">
                    <td className="py-1 text-text-3">{label}</td>
                    <td className={`nomen py-1 ${va !== vb ? 'font-semibold text-accent-strong' : ''}`}>{va}</td>
                    <td className={`nomen py-1 ${va !== vb ? 'font-semibold text-accent-strong' : ''}`}>{vb}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="flex gap-1.5">
            <button onClick={() => void loadStructure(result.a.smiles, undefined, 'Load compared molecule')} className="flex-1 rounded-lg border border-border py-1 text-[12px] hover:border-accent">Open first</button>
            <button onClick={() => void loadStructure(result.b.smiles, undefined, 'Load compared molecule')} className="flex-1 rounded-lg border border-border py-1 text-[12px] hover:border-accent">Open second</button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 pt-1 text-[11.5px]">
        <span className="text-text-3">Try:</span>
        {[
          ['C[C@@H](O)CC', 'C[C@H](O)CC'],
          ['C/C=C/C', 'C/C=C\\C'],
          ['CCO', 'COC'],
          ['C[C@@H](Br)[C@@H](C)Br', 'C[C@@H](Br)[C@H](C)Br'],
        ].map(([a, b]) => (
          <button key={a + b} onClick={() => { setLeft(a); setRight(b); void run(a, b); }} className="mono rounded-full border border-border px-2 py-0.5 hover:border-accent">{a} vs {b}</button>
        ))}
      </div>
    </div>
  );
}
