'use client';
import { useMemo } from 'react';
import { MolView, v3, type AtomId, type BondId, type Vec3 } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';

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
  const R = size * 0.2;
  const L = size * 0.4;
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const fe = doc.atoms.find((a) => a.id === data.front)?.element;
  const be = doc.atoms.find((a) => a.id === data.back)?.element;
  const pt = (angle: number, r: number) => [c + Math.sin((angle * Math.PI) / 180) * r, c - Math.cos((angle * Math.PI) / 180) * r];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Newman projection along the ${fe}–${be} bond`}>
      {data.subs.filter((s) => !s.front).map((s) => {
        const [x1, y1] = pt(s.angle, R);
        const [x2, y2] = pt(s.angle, L);
        return (
          <g key={s.key}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeWidth={2} strokeOpacity={0.7} />
            <text x={pt(s.angle, L + 11)[0]} y={pt(s.angle, L + 11)[1]} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} fill={s.element === 'H' ? ink : atomColor(s.element, theme)} opacity={0.75}>
              {s.element === 'C' ? 'C' : s.element}
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
            <text x={pt(s.angle, L + 11)[0]} y={pt(s.angle, L + 11)[1]} textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={700} fill={s.element === 'H' ? ink : atomColor(s.element, theme)}>
              {s.element === 'C' ? 'C' : s.element}
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
