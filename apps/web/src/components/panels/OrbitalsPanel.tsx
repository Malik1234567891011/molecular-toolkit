'use client';
import { useEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { compute, espColor, rebuild, useOrbitals, type Surface } from '@/lib/orbitals';
import { track } from '@/lib/analytics';
import type { Highlight } from '@/lib/types';
import { I } from '../ui/icons';

const SURFACES: Array<{ id: Surface; label: string; sub: string }> = [
  { id: 'homo', label: 'HOMO', sub: 'highest occupied orbital' },
  { id: 'lumo', label: 'LUMO', sub: 'lowest unoccupied orbital' },
  { id: 'density', label: 'Density', sub: 'where the electrons are' },
  { id: 'esp', label: 'ESP', sub: 'electrostatic potential' },
];

/** Whole seconds since `on` became true (0 while off). */
function useElapsed(on: boolean): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    setS(0);
    if (!on) return;
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [on]);
  return s;
}

export function OrbitalsPanel() {
  const st = useOrbitals();
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  const heavy = useStudio((s) => Object.keys((s.doc.conformers[0]?.coordinates) ?? {}).length);
  const [busyRebuild, setBusyRebuild] = useState(false);
  useEffect(() => {
    track('explanation_interaction', { kind: 'orbitals_opened' });
  }, []);
  // Mulliken partial charges as badges on the model.
  useEffect(() => {
    const q = st.result?.mulliken;
    useStudio.setState((s) => {
      const next: Record<string, Highlight> = { ...s.highlights };
      delete next['orb:q'];
      if (st.showCharges && q) {
        const labels = Object.fromEntries(Object.entries(q).filter(([k]) => !k.includes('.') || Math.abs(q[k]) > 0.2).map(([k, v]) => [k, `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`]));
        next['orb:q'] = { id: 'orb:q', atoms: [], bonds: [], tone: 'faint', labels };
      }
      return { highlights: next };
    });
  }, [st.showCharges, st.result]);
  useEffect(() => () => useStudio.setState((s) => {
    const next = { ...s.highlights };
    delete next['orb:q'];
    return { highlights: next };
  }), []);
  const choose = async (patch: Partial<typeof st>) => {
    useOrbitals.setState(patch);
    setBusyRebuild(true);
    await rebuild();
    setBusyRebuild(false);
  };
  if (!hasMol) return <p className="p-4 text-[13px] text-text-2">Load or build a molecule, then compute its orbitals.</p>;
  const r = st.result;
  const busy = st.status === 'queued' || st.status === 'running';
  const elapsed = useElapsed(busy);
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4" data-testid="orbitals-panel">
      <p className="text-[12.5px] leading-relaxed text-text-2">A quantum-chemistry calculation on the current 3D geometry: molecular orbitals, electron density and the electrostatic potential, shown on the model.</p>
      <div className="space-y-1.5">
        <label className="flex items-center justify-between text-[12.5px]">
          <span className="text-text-2">Method</span>
          <select value={st.method} onChange={(e) => useOrbitals.setState({ method: e.target.value as typeof st.method })} className="rounded-md border border-border bg-panel-raised px-2 py-1 text-[12.5px]" data-testid="orb-method">
            <option value="HF/sto-3g">HF / STO-3G — fastest</option>
            <option value="HF/3-21g">HF / 3-21G — better</option>
            <option value="B3LYP/6-31g*" disabled={heavy > 30}>B3LYP / 6-31G* — best (≤30 atoms)</option>
          </select>
        </label>
        <button onClick={() => void compute()} disabled={busy} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-60" data-testid="orb-compute">
          <I.Orbital size={15} /> {busy ? `${st.status === 'queued' ? 'Queued' : 'Calculating'}… ${elapsed >= 2 ? `${elapsed} s` : ''}` : r ? 'Recalculate' : 'Compute orbitals'}
        </button>
        {st.error && <p className="text-[12.5px] text-danger" data-testid="orb-error">{st.error}</p>}
      </div>
      {r && (
        <>
          <div role="radiogroup" aria-label="Surface" className="grid grid-cols-4 gap-1">
            {SURFACES.map((s) => (
              <button key={s.id} role="radio" aria-checked={st.surface === s.id} onClick={() => void choose({ surface: s.id, iso: s.id === 'homo' || s.id === 'lumo' ? 0.05 : st.iso })} title={s.sub} className={`rounded-lg border py-1.5 text-[12px] font-semibold ${st.surface === s.id ? 'border-accent bg-accent-soft text-accent-strong' : 'border-border text-text-2'}`} data-testid={`orb-${s.id}`}>
                {s.label}
              </button>
            ))}
          </div>
          {(st.surface === 'homo' || st.surface === 'lumo') && (
            <label className="block space-y-1 text-[12px]">
              <span className="flex justify-between text-text-2"><span>Isovalue</span><span className="mono">{st.iso.toFixed(3)} a.u.</span></span>
              <input type="range" min={0.02} max={0.12} step={0.005} value={st.iso} onChange={(e) => useOrbitals.setState({ iso: Number(e.target.value) })} onPointerUp={() => void choose({})} onKeyUp={() => void choose({})} className="w-full accent-[var(--accent)]" aria-label="Isovalue" />
            </label>
          )}
          <label className="block space-y-1 text-[12px]">
            <span className="flex justify-between text-text-2"><span>Opacity</span><span className="mono">{Math.round(st.opacity * 100)}%</span></span>
            <input type="range" min={0.2} max={1} step={0.05} value={st.opacity} onChange={(e) => useOrbitals.setState({ opacity: Number(e.target.value) })} className="w-full accent-[var(--accent)]" aria-label="Opacity" />
          </label>
          {busyRebuild && <p className="text-[11.5px] text-text-3">Building the surface…</p>}
          {(st.surface === 'homo' || st.surface === 'lumo') && (
            <div className="space-y-0.5 text-[12px] text-text-2">
              <p className="flex items-center gap-3 whitespace-nowrap">
                <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#3b82f6]" /> + phase</span>
                <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-full bg-[#f97316]" /> − phase</span>
              </p>
              <p className="text-[11.5px] text-text-3">Colour is the wavefunction’s sign, not charge.</p>
            </div>
          )}
          {st.surface === 'esp' && <EspLegend range={st.espRange} />}
          <LevelDiagram />
          <div className="space-y-1">
            <label className="flex items-center justify-between text-[12.5px]">
              <span>Partial charges (Mulliken)</span>
              <input type="checkbox" checked={st.showCharges} onChange={(e) => useOrbitals.setState({ showCharges: e.target.checked })} className="accent-[var(--accent)]" />
            </label>
            <label className="flex items-center justify-between text-[12.5px]">
              <span>Dipole moment <span className="mono text-text-3">{Math.hypot(...r.dipole_debye).toFixed(2)} D</span></span>
              <input type="checkbox" checked={st.showDipole} onChange={(e) => useOrbitals.setState({ showDipole: e.target.checked })} className="accent-[var(--accent)]" />
            </label>
          </div>
          <p className="rounded-lg bg-panel-raised px-3 py-2 text-[11.5px] leading-relaxed text-text-3" data-testid="orb-method-note">
            {r.method}. {r.caveat} {r.converged ? '' : 'The SCF did not fully converge.'} ({r.seconds.toFixed(1)} s)
          </p>
        </>
      )}
    </div>
  );
}

function EspLegend({ range }: { range: number }) {
  const stops = Array.from({ length: 11 }, (_, k) => -range + (2 * range * k) / 10);
  const kcal = (v: number) => Math.round(v * 627.5);
  return (
    <figure className="space-y-1">
      <div className="flex h-3 overflow-hidden rounded-full" aria-hidden>
        {stops.map((v, k) => {
          const [r, g, b] = espColor(v, range);
          return <span key={k} className="flex-1" style={{ background: `rgb(${r * 255},${g * 255},${b * 255})` }} />;
        })}
      </div>
      <figcaption className="flex justify-between text-[11px] text-text-2">
        <span>{kcal(-range)} kcal/mol · electron-rich (δ−)</span>
        <span>0</span>
        <span>electron-poor (δ+) · +{kcal(range)}</span>
      </figcaption>
    </figure>
  );
}

/** Orbital energy levels around the frontier orbitals, with the HOMO–LUMO gap. */
function LevelDiagram() {
  const r = useOrbitals((s) => s.result)!;
  // Frontier region only: HOMO−2 … LUMO+2.
  const levels = r.orbitalEnergies_eV.map((e, k) => ({ e, index: r.orbitalEnergyStart + k })).filter((l) => l.index >= r.homoIndex - 2 && l.index <= r.homoIndex + 3);
  // Degenerate orbitals (same energy) are drawn side by side on one level.
  const groups: Array<{ e: number; members: typeof levels }> = [];
  for (const l of [...levels].sort((a, b) => b.e - a.e)) {
    const g = groups.find((x) => Math.abs(x.e - l.e) < 0.05);
    if (g) g.members.push(l);
    else groups.push({ e: l.e, members: [l] });
  }
  const lo = Math.min(...levels.map((l) => l.e));
  const hi = Math.max(...levels.map((l) => l.e));
  // Energy-ordered, but never closer than 20 px apart, so arrows and labels stay readable
  // (a qualitative diagram, as in textbooks; the numbers carry the true energies).
  const ys: number[] = [];
  groups.forEach((g, k) => {
    const trueY = 14 + (1 - (g.e - lo) / (hi - lo || 1)) * 122;
    ys.push(k === 0 ? trueY : Math.max(trueY, ys[k - 1] + 20));
  });
  const H = Math.max(150, (ys.at(-1) ?? 0) + 16);
  const gap = r.lumoEnergy_eV !== null ? r.lumoEnergy_eV - r.homoEnergy_eV : null;
  const yOf = (index: number) => ys[groups.findIndex((g) => g.members.some((m) => m.index === index))];
  return (
    <figure className="rounded-xl border border-border bg-panel-raised p-2" data-testid="orb-levels">
      <svg viewBox={`0 0 300 ${H.toFixed(0)}`} className="w-full" role="img" aria-label={`Orbital energy levels; HOMO ${r.homoEnergy_eV.toFixed(2)} eV, LUMO ${r.lumoEnergy_eV?.toFixed(2)} eV`}>
        {groups.map((g, k) => {
          const yy = ys[k];
          const n = g.members.length;
          const w = n === 1 ? 80 : (80 - (n - 1) * 8) / n;
          const isHomo = g.members.some((m) => m.index === r.homoIndex);
          const isLumo = g.members.some((m) => m.index === r.lumoIndex);
          return (
            <g key={g.members[0].index}>
              {g.members.map((m, j) => {
                const x1 = 90 + j * (w + 8);
                const cx = x1 + w / 2;
                const occ = m.index <= r.homoIndex;
                const frontier = m.index === r.homoIndex || m.index === r.lumoIndex || isHomo || isLumo;
                return (
                  <g key={m.index}>
                    <line x1={x1} x2={x1 + w} y1={yy} y2={yy} stroke={frontier ? 'var(--accent)' : 'var(--text-2)'} strokeWidth={frontier ? 2.5 : 1.5} />
                    {occ && (
                      <g stroke="var(--text)" strokeWidth={1.4} fill="none">
                        <path d={`M ${cx - 6} ${yy + 5} L ${cx - 6} ${yy - 7} M ${cx - 9} ${yy - 4} L ${cx - 6} ${yy - 7} L ${cx - 3} ${yy - 4}`} />
                        <path d={`M ${cx + 6} ${yy - 5} L ${cx + 6} ${yy + 7} M ${cx + 3} ${yy + 4} L ${cx + 6} ${yy + 7} L ${cx + 9} ${yy + 4}`} />
                      </g>
                    )}
                  </g>
                );
              })}
              <text x={82} y={yy} textAnchor="end" dominantBaseline="central" fontSize={10.5} fill="var(--text-2)" className="mono">{g.e.toFixed(1)}</text>
              {(isHomo || isLumo) && <text x={178} y={yy} dominantBaseline="central" fontSize={11} fontWeight={600} fill="var(--accent-strong)">{isHomo ? 'HOMO' : 'LUMO'}{n > 1 ? ` (×${n})` : ''}</text>}
            </g>
          );
        })}
        {gap !== null && r.lumoIndex !== null && (
          <g>
            <line x1={240} x2={240} y1={yOf(r.lumoIndex)} y2={yOf(r.homoIndex)} stroke="var(--text-3)" strokeDasharray="3 3" />
            <text x={246} y={(yOf(r.lumoIndex) + yOf(r.homoIndex)) / 2} dominantBaseline="central" fontSize={10.5} fill="var(--text-2)">gap {gap.toFixed(1)} eV</text>
          </g>
        )}
      </svg>
      <figcaption className="text-[11px] text-text-3">Orbital energies (eV) — arrows are electron pairs. Qualitative at this level of theory.</figcaption>
    </figure>
  );
}
