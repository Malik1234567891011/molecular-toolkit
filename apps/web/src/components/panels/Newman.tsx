'use client';
import { useMemo } from 'react';
import { MolView, v3, type AtomId, type BondId, type Vec3 } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { condensed } from '@/lib/projections';

interface Sub {
  key: string;
  element: string;
  angle: number; // degrees in the projection plane
  front: boolean;
}

/** Substituent angles around a bond, looking from `front` to `back`. */
export function newmanData(doc: ReturnType<typeof useStudio.getState>['doc'], bondId: BondId, flip = false): { subs: Sub[]; front: AtomId; back: AtomId } | null {
  const b = doc.bonds.find((x) => x.id === bondId);
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  if (!b || !conf) return null;
  const front = flip ? b.a2 : b.a1;
  const back = flip ? b.a1 : b.a2;
  const pf = conf.coordinates[front];
  const pb = conf.coordinates[back];
  if (!pf || !pb) return null;
  const axis = v3.norm(v3.sub(pb, pf));
  const view = new MolView(doc);
  const list = (atom: AtomId, other: AtomId, isFront: boolean): Array<{ key: string; element: string; p: Vec3; isFront: boolean }> => {
    const i = view.idx(atom);
    const out = view.nbrs[i].map((j) => doc.atoms[j]).filter((a) => a.id !== other).map((a) => ({ key: a.id, element: a.element, p: conf.coordinates[a.id], isFront }));
    for (let k = 1; k <= view.implicitH(i); k++) out.push({ key: `${atom}.h${k}`, element: 'H', p: conf.coordinates[`${atom}.h${k}`], isFront });
    return out.filter((x) => x.p);
  };
  const all = [...list(front, back, true), ...list(back, front, false)];
  if (!all.length) return null;
  // Reference frame: first heavy front substituent points up.
  const ref = all.find((x) => x.isFront && x.element !== 'H') ?? all[0];
  const origin = ref.isFront ? pf : pb;
  let e1 = v3.sub(ref.p, origin);
  e1 = v3.norm(v3.sub(e1, v3.scale(axis, v3.dot(e1, axis))));
  const e2 = v3.cross(axis, e1);
  const subs = all.map((s) => {
    const o = s.isFront ? pf : pb;
    const d = v3.sub(s.p, o);
    const x = v3.dot(d, e2);
    const y = v3.dot(d, e1);
    return { key: s.key, element: s.element, angle: (Math.atan2(x, y) * 180) / Math.PI, front: s.isFront };
  });
  return { subs, front, back };
}

export function Newman({ bondId, size = 180 }: { bondId: BondId; size?: number }) {
  const doc = useStudio((s) => s.doc);
  const theme = useResolvedTheme();
  const data = useMemo(() => newmanData(doc, bondId), [doc, bondId]);
  if (!data) return null;
  const c = size / 2;
  const R = size * 0.19;
  const L = size * 0.33;
  // Textbook labels: groups (CH₃, OH), not bare element symbols.
  const label = (s: Sub) => (s.key.includes('.') ? 'H' : condensed(doc, s.key, s.front ? data.front : data.back));
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const fe = doc.atoms.find((a) => a.id === data.front)?.element;
  const be = doc.atoms.find((a) => a.id === data.back)?.element;
  const pt = (angle: number, r: number) => [c + Math.sin((angle * Math.PI) / 180) * r, c - Math.cos((angle * Math.PI) / 180) * r];
  // Label placement: anchored away from the centre, and a back label that would sit on a front
  // label (eclipsed) is nudged aside, as textbooks draw it. Bond lines stay at their true angles.
  const gap = (x: number, y: number) => Math.abs(((x - y + 540) % 360) - 180);
  const labelAngle = (s: Sub) => {
    if (s.front) return s.angle;
    const near = data.subs.filter((f) => f.front).sort((f, g) => gap(f.angle, s.angle) - gap(g.angle, s.angle))[0];
    if (!near || gap(near.angle, s.angle) >= 22) return s.angle;
    const side = ((s.angle - near.angle + 540) % 360) - 180 >= 0 ? 1 : -1;
    return near.angle + side * 22;
  };
  const anchor = (angle: number) => {
    const x = Math.sin((angle * Math.PI) / 180);
    return x > 0.35 ? 'start' : x < -0.35 ? 'end' : 'middle';
  };
  const labelPos = (angle: number) => pt(angle, L + (anchor(angle) === 'middle' ? 12 : 5));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} overflow="visible" role="img" aria-label={`Newman projection along the ${fe}–${be} bond`}>
      {data.subs.filter((s) => !s.front).map((s) => {
        const [x1, y1] = pt(s.angle, R);
        const [x2, y2] = pt(s.angle, L);
        return (
          <g key={s.key}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeWidth={2} strokeOpacity={0.7} />
            <text x={labelPos(labelAngle(s))[0]} y={labelPos(labelAngle(s))[1]} textAnchor={anchor(labelAngle(s))} dominantBaseline="central" fontSize={12} fontWeight={600} fill={s.element === 'H' || s.element === 'C' ? ink : atomColor(s.element, theme)} opacity={0.8}>
              {label(s)}
            </text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r={R} fill={theme === 'dark' ? '#171c28' : '#ffffff'} stroke={ink} strokeWidth={2} />
      {data.subs.filter((s) => s.front).map((s) => {
        const [x2, y2] = pt(s.angle, L);
        return (
          <g key={s.key}>
            <line x1={c} y1={c} x2={x2} y2={y2} stroke={ink} strokeWidth={2.4} />
            <text x={labelPos(s.angle)[0]} y={labelPos(s.angle)[1]} textAnchor={anchor(s.angle)} dominantBaseline="central" fontSize={13} fontWeight={700} fill={s.element === 'H' || s.element === 'C' ? ink : atomColor(s.element, theme)}>
              {label(s)}
            </text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r={3} fill={ink} />
    </svg>
  );
}

export function conformationName(dihedral: number): string {
  const d = Math.abs(((dihedral + 540) % 360) - 180);
  if (d < 15) return 'eclipsed (syn-periplanar)';
  if (d > 165) return 'anti (staggered)';
  if (d > 45 && d < 75) return 'gauche (staggered)';
  if (d > 105 && d < 135) return 'eclipsed (anticlinal)';
  return 'intermediate';
}
