'use client';
import { useRef, useState } from 'react';

/**
 * Single-series energy profile (relative force-field energy vs dihedral / path coordinate).
 * Line 2px in series-1, 10% area wash, hairline grid, marker ≥ 8px with a surface ring,
 * crosshair + tooltip on hover, and a table view for accessibility.
 */
export function EnergyCurve({
  xs, ys, current, xLabel = 'dihedral (°)', unit = 'kcal/mol', width = 300, height = 150, caption, xTicks = [-180, -120, -60, 0, 60, 120, 180], onSeek,
}: {
  xs: number[];
  ys: number[];
  current?: number | null;
  xLabel?: string;
  unit?: string;
  width?: number;
  height?: number;
  caption?: string;
  xTicks?: number[];
  onSeek?: (x: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const ref = useRef<SVGSVGElement>(null);
  if (!xs.length) return null;
  const pts = xs.map((x, i) => ({ x, y: ys[i] })).sort((a, b) => a.x - b.x);
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  const minX = Math.min(...xTicks, ...pts.map((p) => p.x));
  const maxX = Math.max(...xTicks, ...pts.map((p) => p.x));
  const maxY = Math.max(1, ...pts.map((p) => p.y));
  const niceMax = maxY <= 2 ? 2 : maxY <= 5 ? 5 : maxY <= 10 ? 10 : maxY <= 20 ? 20 : Math.ceil(maxY / 10) * 10;
  const X = (x: number) => pad.l + ((x - minX) / (maxX - minX)) * (width - pad.l - pad.r);
  const Y = (y: number) => height - pad.b - (y / niceMax) * (height - pad.t - pad.b);
  const interp = (x: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      if (x >= pts[i].x && x <= pts[i + 1].x) {
        const t = (x - pts[i].x) / (pts[i + 1].x - pts[i].x || 1);
        return pts[i].y + t * (pts[i + 1].y - pts[i].y);
      }
    }
    return pts[pts.length - 1].y;
  };
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${X(pts[pts.length - 1].x)},${Y(0)} L${X(pts[0].x)},${Y(0)} Z`;
  const yTicks = [0, niceMax / 2, niceMax];
  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const x = minX + ((px - pad.l) / (width - pad.l - pad.r)) * (maxX - minX);
    setHover(Math.max(minX, Math.min(maxX, x)));
  };
  const cur = current === null || current === undefined ? null : current;
  return (
    <figure className="m-0">
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${width} ${height}`}
          className="w-full touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onClick={() => hover !== null && onSeek?.(hover)}
          role="img"
          aria-label={`${caption ?? 'Energy profile'}: relative energy from 0 to ${maxY.toFixed(1)} ${unit}`}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
              <text x={pad.l - 5} y={Y(t)} textAnchor="end" dominantBaseline="central" fontSize={9.5} fill="var(--text-3)" className="mono">
                {t % 1 ? t.toFixed(1) : t}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={X(t)} y={height - pad.b + 13} textAnchor="middle" fontSize={9.5} fill="var(--text-3)" className="mono">
              {t}
            </text>
          ))}
          <path d={area} fill="var(--series-1)" fillOpacity={0.1} />
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--text-3)" strokeWidth={1} />
              <circle cx={X(hover)} cy={Y(interp(hover))} r={4} fill="var(--series-1)" stroke="var(--panel-solid)" strokeWidth={2} />
            </g>
          )}
          {cur !== null && (
            <circle cx={X(cur)} cy={Y(interp(cur))} r={5} fill="var(--series-1)" stroke="var(--panel-solid)" strokeWidth={2} />
          )}
        </svg>
        {hover !== null && (
          <div className="pointer-events-none absolute top-1 rounded-md border border-border bg-panel-solid px-1.5 py-0.5 text-[11px] shadow" style={{ left: `${(X(hover) / width) * 100}%`, transform: 'translateX(-50%)' }}>
            <span className="mono text-text">{hover.toFixed(0)}°</span> <span className="text-text-2">· {interp(hover).toFixed(2)} {unit}</span>
          </div>
        )}
      </div>
      <figcaption className="mt-1 flex items-start justify-between gap-2 text-[10.5px] leading-snug text-text-3">
        <span className="min-w-0">
          {caption ?? `${xLabel} · relative force-field energy (${unit}) — lower is more stable`}
        </span>
        <button className="shrink-0 rounded border border-border px-1.5 py-px hover:border-border-strong hover:text-text" onClick={() => setTable((t) => !t)} aria-expanded={table}>
          {table ? 'Hide table' : 'Table'}
        </button>
      </figcaption>
      {table && (
        <table className="mono mt-1 w-full text-[10.5px] text-text-2">
          <thead>
            <tr className="text-text-3">
              <th className="text-left font-normal">x</th>
              <th className="text-right font-normal">ΔE ({unit})</th>
            </tr>
          </thead>
          <tbody>
            {pts.filter((_, i) => i % 3 === 0).map((p) => (
              <tr key={p.x}>
                <td>{p.x.toFixed(0)}</td>
                <td className="text-right">{p.y.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </figure>
  );
}
