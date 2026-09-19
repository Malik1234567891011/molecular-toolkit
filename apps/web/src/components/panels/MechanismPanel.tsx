'use client';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MolView, parseSmiles, type MoleculeDocument } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { bus } from '@/lib/events';
import { call } from '@/lib/worker';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { MECHANISMS, type MechStep, type Mechanism } from '@/lib/mechanisms';
import { I } from '../ui/icons';
import { arrowPath, atomLabel as label } from '../two/sketch';

const SN2Viewer = dynamic(() => import('../three/SN2Viewer'), { ssr: false });

export function MechanismPanel() {
  const [id, setId] = useState<Mechanism['id'] | null>(null);
  useEffect(() => bus.on('mechanism:play', (m) => MECHANISMS.some((x) => x.id === m) && setId(m as Mechanism['id'])), []);
  const mech = MECHANISMS.find((m) => m.id === id);
  if (!mech) {
    return (
      <div className="scroll-thin min-h-0 flex-1 space-y-1.5 overflow-y-auto p-4" data-testid="mechanism-list">
        <p className="pb-1 text-[12.5px] leading-relaxed text-text-2">A curated, reviewed library. Curved arrows show where electron pairs move; step through them or play them.</p>
        {MECHANISMS.map((m) => (
          <button key={m.id} onClick={() => setId(m.id)} className="w-full rounded-xl border border-border px-3 py-2 text-left hover:border-accent" data-testid={`mech-${m.id}`}>
            <span className="block text-[13.5px] font-medium">{m.title}</span>
            <span className="block text-[11.5px] leading-snug text-text-2">{m.summary}</span>
          </button>
        ))}
      </div>
    );
  }
  return <MechanismPlayer key={mech.id} mech={mech} onBack={() => setId(null)} />;
}

function MechanismPlayer({ mech, onBack }: { mech: Mechanism; onBack: () => void }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [t3d, setT3d] = useState(0);
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const theme = useResolvedTheme();
  const st = mech.steps[step];
  useEffect(() => {
    if (!playing) return;
    if (step >= mech.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), 1200 + st.arrows.length * 600 + st.caption.length * 18);
    return () => clearTimeout(t);
  }, [playing, step, st, mech.steps.length]);
  // 3D SN2: scrub with the steps, animate when playing.
  useEffect(() => {
    if (!mech.has3d) return;
    const target = step / Math.max(1, mech.steps.length - 1);
    if (reduced) return setT3d(target);
    let raf = 0;
    const t0 = performance.now();
    const from = t3d;
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 2200);
      setT3d(from + (target - from) * k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mechanism-player">
      <div className="border-b border-border px-4 py-2.5">
        <button onClick={onBack} className="mb-1 flex items-center gap-1 text-[12px] text-text-3 hover:text-text"><I.ChevronLeft size={13} /> All mechanisms</button>
        <h3 className="text-[14.5px] font-semibold">{mech.title}</h3>
        <p className="text-[12px] text-text-2">{mech.overall}</p>
        {mech.rate && <span className="mono mt-1 inline-block rounded bg-panel-raised px-1.5 py-0.5 text-[11px] text-text-2">{mech.rate}</span>}
      </div>
      <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Steps">
          {mech.steps.map((s, k) => (
            <button key={k} role="tab" aria-selected={k === step} onClick={() => { setPlaying(false); setStep(k); }} className={`h-1.5 flex-1 rounded-full ${k <= step ? 'bg-accent' : 'bg-border'}`} aria-label={`Step ${k + 1}: ${s.title}`} />
          ))}
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Step {step + 1} of {mech.steps.length}</div>
          <div className="text-[14px] font-semibold">{st.title}</div>
        </div>
        <StepDrawing key={`${mech.id}-${step}`} step={st} theme={theme} animate={!reduced} />
        <p className="text-[13px] leading-relaxed text-text-2" data-testid="mechanism-caption">{st.caption}</p>
        {mech.has3d && (
          <div className="space-y-1.5">
            <SN2Viewer t={t3d} theme={theme} />
            <input type="range" min={0} max={1} step={0.01} value={t3d} onChange={(e) => { setPlaying(false); setT3d(Number(e.target.value)); }} className="w-full accent-[var(--accent)]" aria-label="Scrub the 3D trajectory" />
            <p className="text-[11px] text-text-3">Schematic trajectory in 3D — drag to rotate, slide to scrub. The three groups invert like an umbrella: (R) in, (S) out.</p>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-text-3">Arrows start at a lone pair or a bond and point to where the electron pair ends up. Mechanism drawings are curated and reviewed; the tutor narrates them but never invents arrows.</p>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <button onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] text-text-2 hover:bg-panel-raised disabled:opacity-30"><I.ChevronLeft size={15} /> Back</button>
        <button onClick={() => { if (playing) setPlaying(false); else { setStep(0); setPlaying(true); } }} className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-medium hover:border-accent" data-testid="mechanism-play">
          {playing ? <I.Pause size={14} /> : <I.Play size={14} />} {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => { setPlaying(false); setStep((s) => Math.min(mech.steps.length - 1, s + 1)); }} disabled={step === mech.steps.length - 1} className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-accent-strong hover:bg-accent-soft disabled:opacity-30" data-testid="mechanism-next">Next <I.ChevronRight size={15} /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 2D drawing with curved arrows

interface Placed {
  doc: MoleculeDocument;
  pos: Record<string, [number, number]>;
}

const SCALE = 40;

function useLayout(step: MechStep): { placed: Placed[]; byMap: Map<number, [number, number]>; plus: Array<[number, number]>; box: [number, number, number, number] } | null {
  const [out, setOut] = useState<ReturnType<typeof useLayout>>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const docs = step.species.map((s) => parseSmiles(s.smiles).doc);
      const shared = step.species.every((s) => s.coords);
      const local: Array<Record<string, [number, number]>> = [];
      for (let k = 0; k < docs.length; k++) {
        const sp = step.species[k];
        const doc = docs[k];
        let pos: Record<string, [number, number]> = {};
        const complete = sp.coords && doc.atoms.every((a) => a.mapNumber && sp.coords![a.mapNumber]);
        if (!complete) {
          const r = await call<{ layout: Record<string, [number, number]> }>('layout2d', { doc }).catch(() => ({ layout: {} as Record<string, [number, number]> }));
          // Normalize RDKit's ~1.5 bond length to 1.
          for (const [id, p] of Object.entries(r.layout)) pos[id] = [p[0] / 1.5, p[1] / 1.5];
        }
        if (sp.coords) {
          // Hand coordinates win; keep automatic positions only for unmapped atoms.
          for (const a of doc.atoms) if (a.mapNumber && sp.coords[a.mapNumber]) pos[a.id] = sp.coords[a.mapNumber];
        }
        if (!Object.keys(pos).length) pos = Object.fromEntries(doc.atoms.map((a, i) => [a.id, [i, 0] as [number, number]]));
        local.push(pos);
      }
      const placed: Placed[] = [];
      const plus: Array<[number, number]> = [];
      let x = 0;
      for (let k = 0; k < docs.length; k++) {
        const pos = local[k];
        const xs = Object.values(pos).map((p) => p[0]);
        const ys = Object.values(pos).map((p) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const shift = shared ? 0 : x - minX;
        const moved: Record<string, [number, number]> = {};
        for (const [id, p] of Object.entries(pos)) moved[id] = [p[0] + shift, shared ? p[1] : p[1] - cy];
        placed.push({ doc: docs[k], pos: moved });
        if (!shared && k < docs.length - 1) plus.push([x + (maxX - minX) + 0.9, 0]);
        x += maxX - minX + 1.8;
      }
      const byMap = new Map<number, [number, number]>();
      for (const p of placed) for (const a of p.doc.atoms) if (a.mapNumber) byMap.set(a.mapNumber, p.pos[a.id]);
      const all = placed.flatMap((p) => Object.values(p.pos));
      const box: [number, number, number, number] = [Math.min(...all.map((p) => p[0])) - 1.2, Math.min(...all.map((p) => p[1])) - 1.4, Math.max(...all.map((p) => p[0])) + 1.2, Math.max(...all.map((p) => p[1])) + 1.6];
      if (alive) setOut({ placed, byMap, plus, box });
    })();
    return () => {
      alive = false;
    };
  }, [step]);
  return out;
}

function StepDrawing({ step, theme, animate }: { step: MechStep; theme: 'dark' | 'light'; animate: boolean }) {
  const lay = useLayout(step);
  const [shown, setShown] = useState(!animate);
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setShown(true), 80);
    return () => clearTimeout(t);
  }, [animate]);
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const arrowCol = '#e8590c';
  const paths = useMemo(() => (lay ? step.arrows.map((a) => arrowPath(a, lay.byMap)) : []), [lay, step]);
  if (!lay) return <div className="h-[170px] animate-pulse rounded-xl bg-panel-raised" />;
  const [x0, y0, x1, y1] = lay.box;
  const W = (x1 - x0) * SCALE;
  const H = (y1 - y0) * SCALE;
  const tx = (p: [number, number]) => (p[0] - x0) * SCALE;
  const ty = (p: [number, number]) => (y1 - p[1]) * SCALE;
  const lpAtoms = new Set(step.arrows.flatMap((a) => ('lp' in a.from ? [a.from.lp] : [])));
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full rounded-xl border border-border bg-panel-raised" style={{ maxHeight: 240 }} role="img" aria-label={`${step.title}: ${step.caption}`} data-testid="mechanism-svg">
      <defs>
        <marker id="mech-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10 3 5z" fill={arrowCol} />
        </marker>
      </defs>
      {lay.placed.map((pl, k) => {
        const view = new MolView(pl.doc);
        return (
          <g key={k}>
            {pl.doc.bonds.map((b) => {
              const p = pl.pos[b.a1];
              const q = pl.pos[b.a2];
              if (!p || !q) return null;
              const [ax, ay, bx, by] = [tx(p), ty(p), tx(q), ty(q)];
              const len = Math.hypot(bx - ax, by - ay) || 1;
              const nx = (-(by - ay) / len) * 3.2;
              const ny = ((bx - ax) / len) * 3.2;
              // Shorten each end by its label's half-width so bonds never run through text.
              const trim = (t: number) => [ax + (bx - ax) * t, ay + (by - ay) * t];
              const halfWidth = (id: string) => {
                const i = pl.doc.atoms.findIndex((x) => x.id === id);
                const t = label(pl.doc, i, view);
                return 3 + t.replace(/[₀-₉]/g, "").length * 3.4 + (t.match(/[₀-₉]/g)?.length ?? 0) * 2;
              };
              const [sx, sy] = trim(Math.min(0.45, halfWidth(b.a1) / len));
              const [ex, ey] = trim(1 - Math.min(0.45, halfWidth(b.a2) / len));
              const lanes = b.order === 1 ? [0] : b.order === 2 ? [-1, 1] : [-2, 0, 2];
              return lanes.map((l) => <line key={`${b.id}${l}`} x1={sx + nx * l} y1={sy + ny * l} x2={ex + nx * l} y2={ey + ny * l} stroke={ink} strokeWidth={1.6} strokeLinecap="round" />);
            })}
            {pl.doc.atoms.map((a, i) => {
              const p = pl.pos[a.id];
              if (!p) return null;
              const text = label(pl.doc, i, view);
              const color = a.element === 'C' || a.element === 'H' ? ink : atomColor(a.element, theme);
              const lp = a.mapNumber && lpAtoms.has(a.mapNumber);
              return (
                <g key={a.id} transform={`translate(${tx(p)} ${ty(p)})`}>
                  <text textAnchor="middle" dominantBaseline="central" fontSize={12.5} fontWeight={600} fill={color}>{text}</text>
                  {a.formalCharge !== 0 && (
                    <g transform="translate(12 -9)">
                      <circle r={5.2} fill="none" stroke={color} strokeWidth={1} />
                      <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill={color}>{a.formalCharge > 0 ? '+' : '−'}</text>
                    </g>
                  )}
                  {lp && (
                    <g fill={color}>
                      <circle cx={-3} cy={-12} r={1.5} />
                      <circle cx={3} cy={-12} r={1.5} />
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
      {lay.plus.map((p, k) => (
        <text key={`plus${k}`} x={tx(p)} y={ty(p)} textAnchor="middle" dominantBaseline="central" fontSize={16} fill={ink} opacity={0.7}>+</text>
      ))}
      {paths.map((pth, k) =>
        pth ? (
          <path
            key={k}
            d={pth.map((p) => p.map((v, j) => (j % 2 === 0 ? (v - x0) * SCALE : (y1 - v) * SCALE)).join(' ')).reduce((s, seg, j) => s + (j === 0 ? `M ${seg}` : ` Q ${seg}`), '')}
            fill="none"
            stroke={arrowCol}
            strokeWidth={1.8}
            markerEnd="url(#mech-head)"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={shown ? 0 : 1}
            style={{ transition: animate ? `stroke-dashoffset 650ms cubic-bezier(0.4,0,0.2,1) ${250 + k * 550}ms` : 'none' }}
            data-testid="mechanism-arrow"
          />
        ) : null,
      )}
    </svg>
  );
}
