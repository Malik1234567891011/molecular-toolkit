'use client';
import { useEffect, useMemo, useState } from 'react';
import type { MoleculeDocument, Vec3 } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { call } from '@/lib/worker';
import { atomColor } from '@/lib/colors';
import { track } from '@/lib/analytics';
import { useResolvedTheme } from '@/lib/useTheme';
import { Section } from './Inspector';

interface Candidate {
  coords: Record<string, Vec3>;
  energy: number;
  relative: number;
  converged: boolean;
  method: string;
}

interface Ensemble {
  conformers: Candidate[];
  currentRelative: number | null;
  method: string;
}

/** Orthographic sketch of one conformer (heavy atoms + bonds, nearer atoms drawn larger). */
function Thumb({ doc, coords, theme }: { doc: MoleculeDocument; coords: Record<string, Vec3>; theme: 'dark' | 'light' }) {
  const W = 84;
  const H = 64;
  const pts = doc.atoms.map((a) => coords[a.id]).filter(Boolean);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const zs = pts.map((p) => p[2]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const k = (Math.min(W, H) - 14) / span;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const zmin = Math.min(...zs);
  const zr = Math.max(Math.max(...zs) - zmin, 1e-6);
  const P = (id: string) => {
    const p = coords[id];
    return p ? { x: W / 2 + (p[0] - cx) * k, y: H / 2 - (p[1] - cy) * k, d: (p[2] - zmin) / zr } : null;
  };
  const ink = theme === 'dark' ? '#aab2c0' : '#4e5462';
  const order = [...doc.atoms].sort((a, b) => (P(a.id)?.d ?? 0) - (P(b.id)?.d ?? 0));
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      {doc.bonds.map((b) => {
        const p = P(b.a1);
        const q = P(b.a2);
        if (!p || !q) return null;
        return <line key={b.id} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={ink} strokeWidth={1.4} strokeOpacity={0.35 + 0.5 * ((p.d + q.d) / 2)} />;
      })}
      {order.map((a) => {
        const p = P(a.id);
        if (!p) return null;
        return <circle key={a.id} cx={p.x} cy={p.y} r={1.8 + 1.8 * p.d} fill={atomColor(a.element, theme)} fillOpacity={0.55 + 0.45 * p.d} />;
      })}
    </svg>
  );
}

/** "Conformers" filmstrip (spec §7): low-energy candidates the student can step through. */
export function ConformerFilmstrip() {
  const doc = useStudio((s) => s.doc);
  const version = useStudio((s) => s.version);
  const theme = useResolvedTheme();
  const [data, setData] = useState<{ version: number; e: Ensemble } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  // A graph edit makes the old candidates meaningless; a bond rotation does not.
  const stale = data && data.version !== version;
  useEffect(() => {
    if (stale) {
      setData(null);
      setPicked(null);
    }
  }, [stale]);

  const run = async () => {
    const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
    setBusy(true);
    setError(null);
    try {
      const e = await call<Ensemble>('ensemble', { doc: { ...doc, conformers: [], provenance: [] }, current: conf?.coordinates, count: 8 });
      setData({ version: studio().version, e });
      setPicked(null);
      track('explanation_interaction', { kind: 'conformer_search', found: e.conformers.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const use = (k: number) => {
    const c = data?.e.conformers[k];
    const cur = studio().doc;
    const conf = cur.conformers.find((x) => x.id === cur.selectedConformerId) ?? cur.conformers[0];
    if (!c) return;
    studio().setConformer({ id: conf?.id ?? 'c1', coordinates: c.coords, method: c.method, energy: c.energy, converged: c.converged }, 'relaxed', '');
    useStudio.setState({ scan: null });
    setPicked(k);
  };

  const list = useMemo(() => data?.e.conformers ?? [], [data]);
  if (doc.atoms.length < 2) return null;
  return (
    <Section title="Conformers" right={list.length ? <span className="text-[11px] text-text-3">{list.length} found</span> : undefined}>
      {!list.length ? (
        <>
          <p className="text-[12.5px] leading-snug text-text-2">Search for other low-energy shapes of this same molecule (same graph, same name).</p>
          <button onClick={() => void run()} disabled={busy} className="mt-2 rounded-lg border border-border px-3 py-1.5 text-[12.5px] hover:border-accent disabled:opacity-60" data-testid="conformer-search">
            {busy ? 'Searching…' : 'Find low-energy conformers'}
          </button>
          {error && <p className="mt-1 text-[12px] text-danger">Search failed: {error}</p>}
        </>
      ) : (
        <>
          <div className="scroll-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="listbox" aria-label="Low-energy conformers" data-testid="conformer-strip">
            {list.map((c, k) => (
              <button
                key={k}
                role="option"
                aria-selected={picked === k}
                onClick={() => use(k)}
                className={`shrink-0 rounded-xl border p-1 text-center transition ${picked === k ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong'}`}
                title={`Conformer ${k + 1}: ${c.relative.toFixed(2)} kcal/mol above the lowest found`}
              >
                <Thumb doc={doc} coords={c.coords} theme={theme} />
                <div className="mono text-[11px]">{k === 0 ? 'lowest' : `+${c.relative.toFixed(1)}`}</div>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-snug text-text-3">
            Relative MMFF94s+ energies in kcal/mol.
            {data?.e.currentRelative != null && picked === null ? <> The shape on screen is <span className="mono">+{Math.max(0, data.e.currentRelative).toFixed(1)}</span> above the lowest found.</> : null}{' '}
            A quick search can miss the global minimum; these are gas-phase force-field models.
          </p>
          <button onClick={() => void run()} disabled={busy} className="mt-1 text-[12px] text-accent-strong hover:underline disabled:opacity-60">{busy ? 'Searching…' : 'Search again'}</button>
        </>
      )}
    </Section>
  );
}
