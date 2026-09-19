'use client';
/**
 * "Show resonance" (spec §8): cycles the contributors of the current molecule with the curved
 * arrows that interconvert them, labels major/minor with the reason, and highlights the
 * delocalized region on the canvas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MolView, contributorDocument, perceiveRings, resonanceContributors, type Contributor, type MoleculeDocument, type ResArrow } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { resolveQuery } from '@/lib/actions';
import { arrowPath, atomLabel } from '../two/sketch';
import { I } from '../ui/icons';

const SCALE = 38;
const EXAMPLES: Array<[string, string]> = [
  ['Benzene', 'benzene'],
  ['Acetate', 'acetate'],
  ['Acetamide', 'acetamide'],
  ['Allyl cation', 'C=C[CH2+]'],
  ['Acetone enolate', 'CC(=O)[CH2-]'],
  ['Phenoxide', 'phenoxide'],
  ['Nitromethane', 'nitromethane'],
  ['Methyl vinyl ketone', 'methyl vinyl ketone'],
];

export function ResonancePanel() {
  const doc = useStudio((s) => s.doc);
  const setHighlight = useStudio((s) => s.setHighlight);
  const theme = useResolvedTheme();
  const res = useMemo(() => (doc.atoms.length && doc.atoms.length <= 80 ? resonanceContributors(doc) : null), [doc]);
  const [pick, setPick] = useState<{ of: typeof res; step: number }>({ of: null, step: 1 });
  const [playing, setPlaying] = useState(false);
  const count = res?.contributors.length ?? 0;
  // The step belongs to one molecule's contributor list; a new molecule starts over at step 1.
  const step = pick.of === res && pick.step < count ? pick.step : 1;
  const setStep = (f: (k: number) => number) => setPick({ of: res, step: f(step) });

  // Show where the electrons are delocalized while the panel is open.
  useEffect(() => {
    if (!res || count < 2) {
      setHighlight('res', null);
      return;
    }
    setHighlight('res', {
      id: 'res',
      atoms: res.delocalized.map((i) => doc.atoms[i]?.id).filter(Boolean),
      bonds: [],
      tone: 'accent',
    });
    return () => setHighlight('res', null);
  }, [res, count, doc, setHighlight]);

  useEffect(() => {
    if (!playing || count < 2) return;
    const t = setInterval(() => setPick((p) => ({ of: res, step: p.of === res && p.step + 1 < count ? p.step + 1 : 1 })), 2600);
    return () => clearInterval(t);
  }, [playing, count, res]);

  if (!doc.atoms.length) return <Empty />;
  if (!res || count < 2) {
    return (
      <div className="space-y-3 p-4" data-testid="resonance-panel">
        <p className="text-[13px] leading-relaxed text-text-2">
          No resonance contributors for this structure — its electrons are localized (no lone pair, cation or π bond next to another π bond to push into).
        </p>
        <Empty />
      </div>
    );
  }
  const child = res.contributors[step];
  const parent = res.contributors[child.parent];
  return (
    <div className="space-y-3 p-4" data-testid="resonance-panel">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] leading-relaxed text-text-2">
          {count} contributors{res.equivalent ? ', all equivalent' : ''}. The real molecule is one hybrid of these — electrons are shared, the structures don’t interconvert.
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-panel-raised p-2.5">
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-text-3">
          <span>
            Step {step} of {count - 1}: #{child.parent + 1} → #{step + 1}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setStep((k) => (k <= 1 ? count - 1 : k - 1))} className="rounded-md p-1 hover:bg-panel hover:text-text" aria-label="Previous contributor"><I.ChevronLeft size={15} /></button>
            <button onClick={() => setPlaying((p) => !p)} className="rounded-md px-1.5 py-0.5 text-[11.5px] hover:bg-panel hover:text-text" aria-pressed={playing} data-testid="resonance-play">{playing ? 'Pause' : 'Cycle'}</button>
            <button onClick={() => setStep((k) => (k + 1 >= count ? 1 : k + 1))} className="rounded-md p-1 hover:bg-panel hover:text-text" aria-label="Next contributor" data-testid="resonance-next"><I.ChevronRight size={15} /></button>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-0.5">
          <Figure doc={doc} c={parent} index={child.parent} arrows={child.arrows} theme={theme} key={`p${step}`} animate />
          <span className="text-center text-[20px] leading-none text-text-3" aria-label="resonance arrow">⟷</span>
          <Figure doc={doc} c={child} index={step} theme={theme} key={`c${step}`} />
        </div>
      </div>
      <div>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">All contributors</h3>
        <div className="grid grid-cols-2 gap-2" data-testid="resonance-strip">
          {res.contributors.map((c, k) => (
            <button
              key={k}
              onClick={() => k > 0 && setStep(() => k)}
              className={`rounded-xl border p-1.5 text-left transition ${k === step ? 'border-accent' : 'border-border hover:border-border-strong'}`}
              aria-label={`Contributor ${k + 1}, ${c.weight}`}
            >
              <Figure doc={doc} c={c} index={k} theme={theme} compact />
            </button>
          ))}
        </div>
      </div>
      <Weights contributors={res.contributors} equivalent={res.equivalent} />
    </div>
  );
}

function Weights({ contributors, equivalent }: { contributors: Contributor[]; equivalent: boolean }) {
  if (equivalent) return <p className="text-[12.5px] leading-relaxed text-text-2">Every contributor has full octets and the same charges, so they contribute equally — bonds that change between them are identical in the real molecule.</p>;
  const minors = contributors.map((c, k) => [c, k] as const).filter(([c]) => c.weight === 'minor');
  return (
    <div className="space-y-1 text-[12.5px] leading-relaxed">
      <p className="text-text-2">Major contributors have full octets, fewer charges, and negative charge on the more electronegative atom.</p>
      <ul className="space-y-0.5">
        {minors.map(([c, k]) => (
          <li key={k} className="text-text-2">
            <span className="font-semibold text-text">#{k + 1} minor</span> — {c.notes.join('; ') || 'less stable arrangement'}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty() {
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Try a classic</h3>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map(([label, q]) => (
          <button key={q} onClick={() => void resolveQuery(q)} className="rounded-full border border-border bg-panel-raised px-2.5 py-1 text-[12px] hover:border-accent">{label}</button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Figure({ doc, c, index, arrows, theme, compact, animate }: { doc: MoleculeDocument; c: Contributor; index: number; arrows?: ResArrow[]; theme: 'dark' | 'light'; compact?: boolean; animate?: boolean }) {
  const d = useMemo(() => contributorDocument(doc, c), [doc, c]);
  const [shown, setShown] = useState(!animate);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(() => setShown(true), 60);
    return () => clearTimeout(t);
  }, [animate]);
  const geo = useMemo(() => {
    const pts = doc.atoms.map((a) => doc.layout2d[a.id]);
    if (pts.some((p) => !p)) return null;
    const pos = pts.map((p) => [p![0] / 1.5, p![1] / 1.5] as [number, number]);
    const xs = pos.map((p) => p[0]);
    const ys = pos.map((p) => p[1]);
    const pad = compact ? 0.65 : 0.8;
    return { pos, box: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad] as const };
  }, [doc, compact]);
  const view = useMemo(() => new MolView(d), [d]);
  const ringCentre = useMemo(() => {
    // For drawing the second line of a ring double bond inside the ring.
    const m = new Map<number, [number, number]>();
    if (!geo) return m;
    for (const r of perceiveRings(view).rings) {
      const cx = r.atoms.reduce((s, i) => s + geo.pos[i][0], 0) / r.atoms.length;
      const cy = r.atoms.reduce((s, i) => s + geo.pos[i][1], 0) / r.atoms.length;
      for (const b of r.bonds) if (!m.has(b)) m.set(b, [cx, cy]);
    }
    return m;
  }, [view, geo]);
  if (!geo) return <div className="h-[110px] animate-pulse rounded-xl bg-panel" />;
  const [x0, y0, x1, y1] = geo.box;
  const W = (x1 - x0) * SCALE;
  const H = (y1 - y0) * SCALE;
  const tx = (p: readonly [number, number]) => (p[0] - x0) * SCALE;
  const ty = (p: readonly [number, number]) => (y1 - p[1]) * SCALE;
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const arrowCol = '#e8590c';
  const byMap = new Map<number, [number, number]>(geo.pos.map((p, i) => [i + 1, p]));
  const shownLabel = (i: number) => {
    const a = d.atoms[i];
    const heavyDeg = view.nbrs[i].length;
    return a.element !== 'C' || a.formalCharge !== 0 || heavyDeg === 0 || (arrows?.some((x) => 'lp' in x.from && x.from.lp === i + 1) ?? false);
  };
  const lpAtoms = new Set((arrows ?? []).flatMap((a) => ('lp' in a.from ? [a.from.lp - 1] : [])));
  /** Screen angles (y down) for an atom's lone pair and charge, placed in its open side. */
  const marks = (i: number) => {
    const p = geo.pos[i];
    let fx = 0;
    let fy = 0;
    for (const j of view.nbrs[i]) {
      fx -= geo.pos[j][0] - p[0];
      fy -= geo.pos[j][1] - p[1];
    }
    const free = Math.hypot(fx, fy) < 1e-6 ? -Math.PI / 2 : Math.atan2(-fy, fx);
    const charged = d.atoms[i].formalCharge !== 0;
    return { lp: free - (charged ? 0.75 : 0), q: lpAtoms.has(i) ? free + 0.75 : free, r: shownLabel(i) ? 12 : 8 };
  };
  const lpOffset = (num: number): [number, number] => {
    const m = marks(num - 1);
    return [(Math.cos(m.lp) * (m.r + 2)) / SCALE, (-Math.sin(m.lp) * (m.r + 2)) / SCALE];
  };
  // Pick each arrow's bow so its curve stays clear of atoms.
  const paths = (arrows ?? []).map((a) => {
    const options = [1, -1].map((bend) => arrowPath({ ...a, bend: bend as 1 | -1 }, byMap, lpOffset));
    const clearance = (pth: number[][] | null) => (pth ? Math.min(...geo.pos.map((p) => Math.hypot(p[0] - pth[1][0], p[1] - pth[1][1]))) : -1);
    return clearance(options[0]) >= clearance(options[1]) ? options[0] : options[1];
  });
  return (
    <figure className="m-0">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: compact ? 110 : 190 }} role="img" aria-label={`Contributor ${index + 1} (${c.weight})`} data-testid={compact ? undefined : 'resonance-figure'}>
        <defs>
          <marker id="res-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 10 5 0 10 3 5z" fill={arrowCol} />
          </marker>
        </defs>
        {d.bonds.map((b, bi) => {
          const i = view.index.get(b.a1)!;
          const j = view.index.get(b.a2)!;
          const p = geo.pos[i];
          const q = geo.pos[j];
          const [ax, ay, bx, by] = [tx(p), ty(p), tx(q), ty(q)];
          const len = Math.hypot(bx - ax, by - ay) || 1;
          const ux = (bx - ax) / len;
          const uy = (by - ay) / len;
          const cut = (k: number) => (shownLabel(k) ? 3 + atomLabel(d, k, view).replace(/[₀-₉]/g, '').length * 3.6 : 0);
          const sx = ax + ux * Math.min(len * 0.45, cut(i));
          const sy = ay + uy * Math.min(len * 0.45, cut(i));
          const ex = bx - ux * Math.min(len * 0.45, cut(j));
          const ey = by - uy * Math.min(len * 0.45, cut(j));
          let nx = -uy * 3.4;
          let ny = ux * 3.4;
          const centre = ringCentre.get(bi);
          const lines: Array<[number, number, number, number]> = [];
          if (b.order === 1) lines.push([sx, sy, ex, ey]);
          else if (b.order === 2 && centre) {
            // Ring double bond: main line on the bond, the second one inside the ring, shortened.
            const cxs = tx(centre) - (ax + bx) / 2;
            const cys = ty(centre) - (ay + by) / 2;
            if (cxs * nx + cys * ny < 0) {
              nx = -nx;
              ny = -ny;
            }
            lines.push([sx, sy, ex, ey]);
            const inset = len * 0.14;
            lines.push([sx + ux * inset + nx * 2, sy + uy * inset + ny * 2, ex - ux * inset + nx * 2, ey - uy * inset + ny * 2]);
          } else {
            const lanes = b.order === 2 ? [-0.5, 0.5] : [-1, 0, 1];
            for (const l of lanes) lines.push([sx + nx * l * 1.4, sy + ny * l * 1.4, ex + nx * l * 1.4, ey + ny * l * 1.4]);
          }
          const changed = c.orders[bi] !== doc.bonds[bi].order;
          return lines.map(([x1_, y1_, x2_, y2_], k) => <line key={`${b.id}-${k}`} x1={x1_} y1={y1_} x2={x2_} y2={y2_} stroke={ink} strokeWidth={1.6} strokeLinecap="round" opacity={changed || !compact ? 1 : 0.85} />);
        })}
        {d.atoms.map((a, i) => {
          const p = geo.pos[i];
          const color = a.element === 'C' || a.element === 'H' ? ink : atomColor(a.element, theme);
          const lbl = shownLabel(i);
          const { lp: lpAngle, q: qAngle, r } = marks(i);
          const q = a.formalCharge > 0 ? '#4dabf7' : '#f06595';
          return (
            <g key={a.id} transform={`translate(${tx(p)} ${ty(p)})`}>
              {lbl && <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={600} fill={color}>{atomLabel(d, i, view)}</text>}
              {a.formalCharge !== 0 && (
                <g transform={`translate(${Math.cos(qAngle) * r} ${Math.sin(qAngle) * r})`}>
                  <circle r={5.2} fill={theme === 'dark' ? '#171b24' : '#fff'} stroke={q} strokeWidth={1.1} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={9} fontWeight={700} fill={q}>{a.formalCharge > 0 ? '+' : '−'}</text>
                </g>
              )}
              {lpAtoms.has(i) && (
                <g fill={color} transform={`translate(${Math.cos(lpAngle) * (r - 1)} ${Math.sin(lpAngle) * (r - 1)}) rotate(${(lpAngle * 180) / Math.PI + 90})`}>
                  <circle cx={-3} cy={0} r={1.5} />
                  <circle cx={3} cy={0} r={1.5} />
                </g>
              )}
            </g>
          );
        })}
        {paths.map((pth, k) =>
          pth ? (
            <path
              key={k}
              d={pth.map((pp) => pp.map((val, j) => (j % 2 === 0 ? (val - x0) * SCALE : (y1 - val) * SCALE)).join(' ')).reduce((s, seg, j) => s + (j === 0 ? `M ${seg}` : ` Q ${seg}`), '')}
              fill="none"
              stroke={arrowCol}
              strokeWidth={1.8}
              markerEnd="url(#res-head)"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={shown ? 0 : 1}
              style={{ transition: animate ? `stroke-dashoffset 600ms cubic-bezier(0.4,0,0.2,1) ${150 + k * 380}ms` : 'none' }}
              data-testid="resonance-arrow"
            />
          ) : null,
        )}
      </svg>
      <figcaption className="flex items-center justify-center gap-1.5 text-[11.5px]">
        <span className="text-text-3">#{index + 1}</span>
        <span className={`rounded-full px-1.5 py-px font-semibold ${c.weight === 'major' ? 'bg-accent-soft text-accent-strong' : 'bg-panel text-text-3'}`}>{c.weight}</span>
      </figcaption>
    </figure>
  );
}
