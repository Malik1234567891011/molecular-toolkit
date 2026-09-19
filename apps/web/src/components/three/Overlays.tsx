'use client';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { angleDeg, dihedralDeg } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { subColor } from '@/lib/colors';
import { displayPositions } from './MoleculeMesh';

interface LabelSpec {
  key: string;
  at: string;
  text: string;
  tone: 'symbol' | 'locant' | 'cip' | 'priority' | 'badge';
  color?: string;
}

function FollowLabel({ spec }: { spec: LabelSpec }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const p = displayPositions.get(spec.at);
    if (p && ref.current) ref.current.position.copy(p);
  });
  const cls =
    spec.tone === 'symbol'
      ? 'text-[11px] font-semibold text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,.8)]'
      : spec.tone === 'locant'
        ? 'min-w-[20px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-semibold text-[#0b0e14] shadow-md'
        : spec.tone === 'cip'
          ? 'rounded-md px-1.5 py-0.5 text-[12px] font-bold italic text-white shadow-md'
          : spec.tone === 'priority'
            ? 'grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-bold text-[#0b0e14] shadow'
            : 'rounded px-1 text-[10px] text-white';
  return (
    <group ref={ref}>
      <Html center zIndexRange={[20, 10]} style={{ pointerEvents: 'none', transform: spec.tone === 'locant' ? 'translateY(-18px)' : spec.tone === 'priority' ? 'translate(12px,-12px)' : undefined }}>
        <div className={`mono select-none whitespace-nowrap ${cls}`} style={{ background: spec.color }}>
          {spec.text}
        </div>
      </Html>
    </group>
  );
}

function MeasureOverlay() {
  const measure = useStudio((s) => s.measure);
  const textRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<THREE.Group>(null);
  const lineRef = useRef<THREE.Group>(null);
  const pts = useMemo(() => measure.map(() => new THREE.Vector3()), [measure]);
  useFrame(() => {
    const ps = measure.map((k) => displayPositions.get(k));
    if (ps.some((p) => !p) || ps.length < 2) return;
    ps.forEach((p, i) => pts[i].copy(p!));
    const arr = pts.map((p) => [p.x, p.y, p.z] as [number, number, number]);
    let text = '';
    if (arr.length === 2) text = `${Math.hypot(arr[0][0] - arr[1][0], arr[0][1] - arr[1][1], arr[0][2] - arr[1][2]).toFixed(3)} Å`;
    if (arr.length === 3) text = `${angleDeg(arr[0], arr[1], arr[2]).toFixed(1)}°`;
    if (arr.length === 4) text = `${dihedralDeg(arr[0], arr[1], arr[2], arr[3]).toFixed(1)}° dihedral`;
    if (textRef.current && textRef.current.textContent !== text) textRef.current.textContent = text;
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.multiplyScalar(1 / pts.length);
    if (groupRef.current) groupRef.current.position.copy(c);
    // Update line geometry
    if (lineRef.current) {
      const line = lineRef.current.children[0] as unknown as { geometry?: { setPositions?: (a: number[]) => void } };
      line?.geometry?.setPositions?.(pts.flatMap((p) => [p.x, p.y, p.z]));
    }
  });
  if (measure.length < 2) return null;
  return (
    <>
      <group ref={lineRef}>
        <Line points={measure.map(() => [0, 0, 0] as [number, number, number])} color="#f2b34c" lineWidth={2} dashed dashSize={0.12} gapSize={0.08} depthTest={false} renderOrder={5} />
      </group>
      <group ref={groupRef}>
        <Html center zIndexRange={[30, 20]} style={{ pointerEvents: 'none', transform: 'translateY(-26px)' }}>
          <div ref={textRef} className="mono rounded-lg bg-[#f2b34c] px-2 py-1 text-[12px] font-semibold text-[#1a1406] shadow-lg" />
        </Html>
      </group>
    </>
  );
}

export function Overlays() {
  const doc = useStudio((s) => s.doc);
  const showLabels = useStudio((s) => s.settings.showLabels || s.settings.colorBlindSafe);
  const style = useStudio((s) => s.renderStyle);
  const highlights = useStudio((s) => s.highlights);
  const analysis = useStudio((s) => s.analysis);
  const labels = useMemo(() => {
    const out: LabelSpec[] = [];
    if (showLabels) {
      for (const a of doc.atoms) if (a.element !== 'C' || showLabels) out.push({ key: `sym:${a.id}`, at: a.id, text: a.element + (a.formalCharge ? (a.formalCharge > 0 ? '⁺' : '⁻') : ''), tone: 'symbol' });
    }
    for (const h of Object.values(highlights)) {
      if (!h.labels) continue;
      for (const [id, text] of Object.entries(h.labels)) {
        out.push({ key: `hl:${h.id}:${id}`, at: id, text, tone: h.tone === 'palette' ? 'locant' : 'locant', color: h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : h.tone === 'amber' ? '#f2b34c' : h.tone === 'faint' ? '#9aa3b2' : '#a597ff' });
      }
    }
    if (style === 'stereo' && analysis) {
      for (const c of analysis.stereo.centres) {
        if (c.descriptor) out.push({ key: `cip:${c.atomId}`, at: c.atomId, text: c.descriptor, tone: 'cip', color: c.descriptor === 'R' ? '#6c5ce7' : '#e8590c' });
        else if (!c.needsHigherRules) out.push({ key: `cip:${c.atomId}`, at: c.atomId, text: '?', tone: 'cip', color: '#6d7586' });
        c.priorities.forEach((p, k) => {
          if (p === 'LP') return;
          const at = p === 'H' ? `${c.atomId}.h1` : p;
          out.push({ key: `pri:${c.atomId}:${k}`, at, text: String(k + 1), tone: 'priority', color: ['#ffd43b', '#ffa94d', '#74c0fc', '#ced4da'][k] });
        });
      }
      for (const b of analysis.stereo.bonds) {
        if (!b.descriptor) continue;
        out.push({ key: `ez:${b.bondId}`, at: b.atoms[0], text: b.descriptor, tone: 'cip', color: b.descriptor === 'Z' ? '#0ca678' : '#1c7ed6' });
      }
    }
    return out;
  }, [doc, showLabels, highlights, style, analysis]);
  return (
    <>
      {labels.map((l) => (
        <FollowLabel key={l.key} spec={l} />
      ))}
      <MeasureOverlay />
    </>
  );
}
