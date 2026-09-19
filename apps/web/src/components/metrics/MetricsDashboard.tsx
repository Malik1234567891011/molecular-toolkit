'use client';
/**
 * Product metrics (spec §22). Headline numbers are stat tiles; distributions are single-series bar
 * charts in the accent colour with per-bar tooltips and a table view. Nothing here is personal:
 * the event log holds event names and small scalar props only.
 */
import { useCallback, useEffect, useState } from 'react';
import { PROVENANCE } from '../naming/ProvenanceBadge';
import type { Provenance } from '@/lib/types';

interface Metrics {
  generatedAt: number;
  sessions: number;
  totalEvents: number;
  events: Record<string, number>;
  kpis: Record<string, number | null>;
  samples: Record<string, number>;
  funnel: Array<{ step: string; sessions: number }>;
  inputClasses: Array<{ kind: string; count: number }>;
  provenance: Array<{ kind: string; count: number }>;
  daily: Array<{ date: string; sessions: number; events: number }>;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const dur = (s: number | null | undefined) => {
  if (s === null || s === undefined) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};
const INPUT_LABEL: Record<string, string> = { name: 'IUPAC or common name', smiles: 'SMILES', formula: 'Formula', cas: 'CAS number', inchi: 'InChI', molfile: 'Molfile', other: 'Other', ambiguous: 'Ambiguous (asked to choose)', 'not found': 'Not found' };

export function MetricsDashboard() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/analytics/metrics', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setM(await r.json());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-text sm:px-8" data-testid="metrics">
      <div className="mx-auto max-w-[1080px]">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <a href="/" className="text-[12.5px] text-text-3 hover:text-text">← Orbital studio</a>
            <h1 className="mt-1 text-[26px] font-semibold tracking-tight">Product metrics</h1>
            <p className="mt-1 max-w-[640px] text-[13.5px] leading-relaxed text-text-2">
              Privacy-preserving events only: event names and small counts. No typed names, no molecules, no AI conversations are logged.
            </p>
          </div>
          <div className="flex items-center gap-3 text-[12.5px] text-text-3">
            {m && <span>{m.sessions} sessions · {m.totalEvents} events · updated {new Date(m.generatedAt * 1000).toLocaleTimeString()}</span>}
            <button onClick={() => void load()} className="rounded-lg border border-border px-3 py-1.5 text-text-2 hover:border-accent hover:text-text">Refresh</button>
          </div>
        </header>
        {error && <p className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-[13px]" role="alert">Could not load metrics ({error}). Is the API running?</p>}
        {!m && !error && <p className="text-[13px] text-text-3">Loading…</p>}
        {m && (
          <>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Headline metrics">
              <Tile label="Median time to first molecule" value={dur(m.kpis.medianSecondsToFirstMolecule)} sub={`${m.samples.timeToFirstMolecule} sessions measured`} />
              <Tile label="Names resolved" value={pct(m.kpis.nameResolutionRate)} sub={`of ${m.samples.nameInputs} typed inputs`} />
              <Tile label="Verified naming coverage" value={pct(m.kpis.verifiedNamingCoverage)} sub={`of ${m.samples.namedStructures} structures named`} />
              <Tile label="Explanations explored" value={pct(m.kpis.explanationInteractionRate)} sub="opened explanations with a visual interaction" />
              <Tile label="Wrong after a hint" value={pct(m.kpis.correctionRateAfterHint)} sub={`of ${m.samples.hintedAnswers} hinted answers`} />
              <Tile label="Share or export" value={pct(m.kpis.shareExportRate)} sub="of sessions" />
              <Tile label="Returning sessions" value={pct(m.kpis.returningSessionShare)} sub="resumed saved work" />
              <Tile label="Sessions" value={String(m.sessions)} sub={`${m.daily.length} day${m.daily.length === 1 ? '' : 's'} of data`} />
            </section>
            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <Card title="Where sessions get to" note="Sessions that reached each step at least once">
                <HBars rows={m.funnel.map((f) => ({ label: f.step, value: f.sessions, detail: m.funnel[0].sessions ? `${Math.round((f.sessions / m.funnel[0].sessions) * 100)}% of sessions that opened the studio` : '' }))} unit="sessions" />
              </Card>
              <Card title="Activity by day" note="Distinct sessions per day (UTC)">
                <VBars rows={m.daily.map((d) => ({ label: d.date.slice(5), value: d.sessions, detail: `${d.date}: ${d.sessions} sessions, ${d.events} events` }))} unit="sessions" />
              </Card>
              <Card title="How molecules were looked up" note="Typed inputs by the kind of input recognised">
                <HBars rows={m.inputClasses.map((x) => ({ label: INPUT_LABEL[x.kind] ?? x.kind, value: x.count }))} unit="inputs" />
              </Card>
              <Card title="Where the shown name came from" note="Provenance of the name shown for each named structure">
                <HBars rows={m.provenance.map((x) => ({ label: PROVENANCE[x.kind as Provenance]?.label ?? (x.kind === 'unsupported' ? 'No verified name' : x.kind), value: x.count }))} unit="structures" />
              </Card>
            </div>
            <Card title="Every event" note="Raw counts, most frequent first" className="mt-4">
              <Table rows={Object.entries(m.events).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, value: v }))} unit="count" />
            </Card>
          </>
        )}
      </div>
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-border bg-panel-solid p-4">
      <div className="text-[12px] text-text-2">{label}</div>
      <div className="mono mt-1 text-[28px] font-semibold tracking-tight">{value}</div>
      <div className="mt-0.5 text-[11.5px] text-text-3">{sub}</div>
    </div>
  );
}

function Card({ title, note, children, className = '' }: { title: string; note: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-border bg-panel-solid p-4 ${className}`} aria-label={title}>
      <h2 className="text-[14px] font-semibold">{title}</h2>
      <p className="mb-3 text-[12px] text-text-3">{note}</p>
      {children}
    </section>
  );
}

interface Row {
  label: string;
  value: number;
  detail?: string;
}

/** A per-mark tooltip that also works from the keyboard. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, text: string) => {
    const host = (e.currentTarget as HTMLElement).closest('[data-chart]') as HTMLElement | null;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const h = host?.getBoundingClientRect();
    setTip({ x: r.left - (h?.left ?? 0) + r.width / 2, y: r.top - (h?.top ?? 0), text });
  };
  const hide = () => setTip(null);
  const el = tip ? (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border-strong bg-panel-solid px-2.5 py-1.5 text-[12px] shadow-lg" style={{ left: tip.x, top: tip.y - 6 }} role="tooltip">
      {tip.text}
    </div>
  ) : null;
  return { show, hide, el };
}

function ViewToggle({ table, set }: { table: boolean; set: (v: boolean) => void }) {
  return (
    <div className="mb-2 flex justify-end">
      <button onClick={() => set(!table)} className="text-[11.5px] text-text-3 hover:text-text" aria-pressed={table}>{table ? 'Show chart' : 'Show table'}</button>
    </div>
  );
}

function HBars({ rows, unit }: { rows: Row[]; unit: string }) {
  const [table, setTable] = useState(false);
  const tip = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-[12.5px] text-text-3">No data yet.</p>;
  return (
    <>
      <ViewToggle table={table} set={setTable} />
      {table ? (
        <Table rows={rows} unit={unit} />
      ) : (
        <div className="relative" data-chart>
          <ul className="space-y-[2px]">
            {rows.map((r) => {
              const text = `${r.label}: ${r.value} ${unit}${r.detail ? ` — ${r.detail}` : ''}`;
              return (
                <li key={r.label} tabIndex={0} aria-label={text} onMouseEnter={(e) => tip.show(e, text)} onMouseLeave={tip.hide} onFocus={(e) => tip.show(e, text)} onBlur={tip.hide} className="grid cursor-default grid-cols-[minmax(110px,40%)_1fr_auto] items-center gap-3 rounded-md px-1 py-1.5 outline-none hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/60">
                  <span className="truncate text-[12.5px] text-text-2">{r.label}</span>
                  <span className="h-3.5 rounded-r-[4px] bg-accent" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 2 : 0 }} />
                  <span className="mono text-[12px] text-text">{r.value}</span>
                </li>
              );
            })}
          </ul>
          {tip.el}
        </div>
      )}
    </>
  );
}

function VBars({ rows, unit }: { rows: Row[]; unit: string }) {
  const [table, setTable] = useState(false);
  const tip = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-[12.5px] text-text-3">No data yet.</p>;
  const H = 150;
  return (
    <>
      <ViewToggle table={table} set={setTable} />
      {table ? (
        <Table rows={rows.map((r) => ({ ...r, label: r.detail?.split(':')[0] ?? r.label }))} unit={unit} />
      ) : (
        <div className="relative" data-chart>
          <div className="flex items-end gap-[2px] border-b border-border" style={{ height: H }}>
            {rows.map((r) => {
              const text = r.detail ?? `${r.label}: ${r.value} ${unit}`;
              return (
                <div key={r.label} tabIndex={0} aria-label={text} onMouseEnter={(e) => tip.show(e, text)} onMouseLeave={tip.hide} onFocus={(e) => tip.show(e, text)} onBlur={tip.hide} className="group flex h-full min-w-[14px] max-w-[56px] flex-1 cursor-default items-end outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                  <div className="w-full rounded-t-[4px] bg-accent group-hover:brightness-110" style={{ height: `${(r.value / max) * 100}%`, minHeight: r.value ? 2 : 0 }} />
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex gap-[2px]">
            {rows.map((r, k) => (
              <span key={r.label} className="min-w-[14px] max-w-[56px] flex-1 truncate text-center text-[10.5px] text-text-3">
                {rows.length <= 10 || k % Math.ceil(rows.length / 8) === 0 ? r.label : ''}
              </span>
            ))}
          </div>
          {tip.el}
        </div>
      )}
    </>
  );
}

function Table({ rows, unit }: { rows: Row[]; unit: string }) {
  return (
    <table className="w-full text-left text-[12.5px]">
      <thead>
        <tr className="border-b border-border text-text-3">
          <th className="py-1 font-medium">Item</th>
          <th className="py-1 text-right font-medium">{unit}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-b border-border/60">
            <td className="py-1 text-text-2">{r.label}</td>
            <td className="mono py-1 text-right">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
