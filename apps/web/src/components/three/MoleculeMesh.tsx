'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Vec3 } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { atomColor, subColor } from '@/lib/colors';
import { buildScene, type RAtom, type RBond } from './scene-data';
import { useResolvedTheme } from '@/lib/useTheme';

export interface PickHandlers {
  onAtomPointerDown?: (e: ThreeEvent<PointerEvent>, atomKey: string, atom: RAtom) => void;
  onBondPointerDown?: (e: ThreeEvent<PointerEvent>, bond: RBond) => void;
  onAtomOver?: (atom: RAtom | null) => void;
  onBondOver?: (bond: RBond | null) => void;
}

/** Live display positions, shared with overlays (labels, ports, measurements). */
export const displayPositions = new Map<string, THREE.Vector3>();
export const displayOffset = new THREE.Vector3();

const sphereGeo = new THREE.SphereGeometry(1, 40, 28);
const haloGeo = new THREE.SphereGeometry(1, 24, 16);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, false);
const UP = new THREE.Vector3(0, 1, 0);
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

const HALO_TONES: Record<string, string> = { accent: '#8b7cff', amber: '#f2b34c', danger: '#ff5f6d', good: '#3ecf8e', faint: '#9aa3b2' };

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export function MoleculeMesh({ handlers, ghost }: { handlers: PickHandlers; ghost?: boolean }) {
  const doc = useStudio((s) => s.doc);
  const style = useStudio((s) => s.renderStyle);
  const showH = useStudio((s) => s.settings.showHydrogens);
  const cvd = useStudio((s) => s.settings.colorBlindSafe);
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const selection = useStudio((s) => s.selection);
  const highlights = useStudio((s) => s.highlights);
  const hoverAtom = useStudio((s) => s.hoverAtom);
  const hoverBond = useStudio((s) => s.hoverBond);
  const measure = useStudio((s) => s.measure);
  const invalid = useStudio((s) => s.invalid);
  const theme = useResolvedTheme();

  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  const target = conf?.coordinates;
  const scene = useMemo(() => buildScene(doc, style, showH), [doc, style, showH]);
  const heavy = useMemo(() => scene.atoms.filter((a) => !a.isH), [scene]);
  const hydrogens = useMemo(() => scene.atoms.filter((a) => a.isH), [scene]);
  const bondInstances = useMemo(() => {
    const out: Array<{ bond: RBond; lane: number; half: 0 | 1 }> = [];
    if (style === 'spacefill') return out;
    for (const b of scene.bonds) {
      const lanes = style === 'licorice' ? 1 : b.order;
      for (let l = 0; l < lanes; l++) {
        out.push({ bond: b, lane: l, half: 0 });
        out.push({ bond: b, lane: l, half: 1 });
      }
    }
    return out;
  }, [scene, style]);

  const atomRef = useRef<THREE.InstancedMesh>(null);
  const hRef = useRef<THREE.InstancedMesh>(null);
  const bondRef = useRef<THREE.InstancedMesh>(null);
  const haloRef = useRef<THREE.InstancedMesh>(null);
  const anim = useRef<{ from: Map<string, THREE.Vector3>; to: Map<string, THREE.Vector3>; t0: number; dur: number } | null>(null);
  const dirty = useRef(true);

  // Retarget the morph whenever the geometry or the atom set changes.
  useEffect(() => {
    if (!target) return;
    const to = new Map<string, THREE.Vector3>();
    for (const a of scene.atoms) {
      const p = target[a.key];
      if (p) to.set(a.key, new THREE.Vector3(p[0], p[1], p[2]));
    }
    const from = new Map<string, THREE.Vector3>();
    for (const a of scene.atoms) {
      const cur = displayPositions.get(a.key);
      if (cur) from.set(a.key, cur.clone());
      else {
        // New atoms grow out of their bonded neighbour (the "snap").
        const nb = scene.bonds.find((b) => b.a === a.key || b.b === a.key);
        const other = nb ? (nb.a === a.key ? nb.b : nb.a) : undefined;
        const start = (other && displayPositions.get(other)) ?? to.get(a.key);
        if (start) from.set(a.key, start.clone());
      }
    }
    const newcomers = scene.atoms.some((a) => !displayPositions.has(a.key));
    anim.current = { from, to, t0: performance.now(), dur: reduced ? 0 : newcomers ? 180 : 380 };
    for (const k of [...displayPositions.keys()]) if (!to.has(k)) displayPositions.delete(k);
    dirty.current = true;
  }, [target, scene, reduced]);

  useEffect(() => {
    dirty.current = true;
  }, [selection, highlights, hoverAtom, hoverBond, measure, theme, cvd, invalid]);

  useFrame(() => {
    const a = anim.current;
    if (a) {
      const t = a.dur === 0 ? 1 : Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = easeOutCubic(t);
      for (const [k, to] of a.to) {
        const from = a.from.get(k) ?? to;
        let d = displayPositions.get(k);
        if (!d) {
          d = new THREE.Vector3();
          displayPositions.set(k, d);
        }
        d.copy(from).lerp(to, e);
      }
      if (t >= 1) anim.current = null;
      dirty.current = true;
    }
    if (!dirty.current) return;
    dirty.current = false;
    writeInstances();
  });

  const highlightColorOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of Object.values(highlights)) {
      const c = h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : HALO_TONES[h.tone];
      for (const id of h.atoms) m.set(id, c);
    }
    return m;
  }, [highlights]);
  const highlightBondColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of Object.values(highlights)) {
      const c = h.tone === 'palette' ? subColor(h.colorIndex ?? 0) : HALO_TONES[h.tone];
      for (const id of h.bonds) m.set(id, c);
    }
    return m;
  }, [highlights]);

  function writeInstances() {
    const atomsMesh = atomRef.current;
    const hMesh = hRef.current;
    const bondMesh = bondRef.current;
    const haloMesh = haloRef.current;
    const sel = new Set(selection.atoms);
    const selBonds = new Set(selection.bonds);
    const measureSet = new Set(measure);
    if (atomsMesh) {
      heavy.forEach((at, i) => {
        const p = displayPositions.get(at.key) ?? tmpV.set(0, 0, 0);
        tmpS.setScalar(at.radius * (hoverAtom === at.atomId ? 1.06 : 1));
        tmpM.compose(p, tmpQ.identity(), tmpS);
        atomsMesh.setMatrixAt(i, tmpM);
        const col = atomColor(at.element, theme, cvd);
        tmpC.set(col);
        const hl = highlightColorOf.get(at.atomId);
        if (hl) tmpC.lerp(new THREE.Color(hl), 0.25);
        if (ghost) tmpC.lerp(new THREE.Color(theme === 'dark' ? '#0b0e14' : '#f6f4ef'), 0.5);
        atomsMesh.setColorAt(i, tmpC);
      });
      atomsMesh.count = heavy.length;
      atomsMesh.instanceMatrix.needsUpdate = true;
      if (atomsMesh.instanceColor) atomsMesh.instanceColor.needsUpdate = true;
      atomsMesh.computeBoundingSphere();
    }
    if (hMesh) {
      hydrogens.forEach((at, i) => {
        const p = displayPositions.get(at.key) ?? tmpV.set(0, 0, 0);
        const parentSel = sel.has(at.atomId) && useStudio.getState().mode3d === 'build';
        tmpS.setScalar(at.radius * (parentSel ? 1.12 : 1));
        tmpM.compose(p, tmpQ.identity(), tmpS);
        hMesh.setMatrixAt(i, tmpM);
        tmpC.set(atomColor('H', theme, cvd));
        if (parentSel) tmpC.lerp(new THREE.Color(HALO_TONES.accent), 0.55);
        hMesh.setColorAt(i, tmpC);
      });
      hMesh.count = hydrogens.length;
      hMesh.instanceMatrix.needsUpdate = true;
      if (hMesh.instanceColor) hMesh.instanceColor.needsUpdate = true;
      hMesh.computeBoundingSphere();
    }
    if (bondMesh) {
      const radius = style === 'licorice' ? 0.13 : 0.1;
      bondInstances.forEach((inst, i) => {
        const b = inst.bond;
        const pa = displayPositions.get(b.a);
        const pb = displayPositions.get(b.b);
        if (!pa || !pb) {
          tmpM.makeScale(0, 0, 0);
          bondMesh.setMatrixAt(i, tmpM);
          return;
        }
        const lanes = style === 'licorice' ? 1 : b.order;
        const dir = tmpV.copy(pb).sub(pa);
        const len = dir.length();
        dir.normalize();
        // Offset direction for multiple bonds: perpendicular to the bond, in the π plane.
        let off = new THREE.Vector3();
        if (lanes > 1) {
          const ref = b.planeRef ? displayPositions.get(b.planeRef) : undefined;
          const r = ref ? ref.clone().sub(pa) : new THREE.Vector3(0, 0, 1);
          const n = new THREE.Vector3().crossVectors(dir, r);
          if (n.lengthSq() < 1e-6) n.set(0, 0, 1).cross(dir);
          off = new THREE.Vector3().crossVectors(n, dir).normalize();
        }
        const spacing = lanes === 2 ? 0.18 : 0.21;
        const laneOffset = lanes === 1 ? 0 : (inst.lane - (lanes - 1) / 2) * spacing;
        const r = lanes > 1 ? radius * 0.62 : radius;
        const start = pa.clone().addScaledVector(off, laneOffset);
        const end = pb.clone().addScaledVector(off, laneOffset);
        const mid = start.clone().lerp(end, 0.5);
        const s = inst.half === 0 ? start : mid;
        const e = inst.half === 0 ? mid : end;
        const center = s.clone().lerp(e, 0.5);
        tmpQ.setFromUnitVectors(UP, dir);
        tmpS.set(r, s.distanceTo(e) * (len > 0 ? 1 : 0), r);
        tmpM.compose(center, tmpQ, tmpS);
        bondMesh.setMatrixAt(i, tmpM);
        const endKey = inst.half === 0 ? b.a : b.b;
        const endAtom = scene.atoms.find((x) => x.key === endKey);
        tmpC.set(atomColor(endAtom?.element ?? 'C', theme, cvd));
        if (theme === 'dark') tmpC.lerp(new THREE.Color('#aeb6c6'), 0.18);
        const hl = b.bondId ? highlightBondColor.get(b.bondId) : undefined;
        if (hl) tmpC.set(hl);
        if (b.bondId && (selBonds.has(b.bondId) || hoverBond === b.bondId)) tmpC.lerp(new THREE.Color(HALO_TONES.accent), selBonds.has(b.bondId) ? 0.75 : 0.35);
        if (ghost) tmpC.lerp(new THREE.Color(theme === 'dark' ? '#0b0e14' : '#f6f4ef'), 0.5);
        bondMesh.setColorAt(i, tmpC);
      });
      bondMesh.count = bondInstances.length;
      bondMesh.instanceMatrix.needsUpdate = true;
      if (bondMesh.instanceColor) bondMesh.instanceColor.needsUpdate = true;
      bondMesh.computeBoundingSphere();
    }
    if (haloMesh) {
      let n = 0;
      const put = (key: string, radius: number, color: string) => {
        const p = displayPositions.get(key);
        if (!p) return;
        tmpS.setScalar(radius);
        tmpM.compose(p, tmpQ.identity(), tmpS);
        haloMesh.setMatrixAt(n, tmpM);
        haloMesh.setColorAt(n, tmpC.set(color));
        n++;
      };
      for (const at of heavy) {
        const base = style === 'spacefill' ? at.radius * 1.04 : Math.max(at.radius * 1.55, 0.42);
        if (sel.has(at.atomId)) put(at.key, base, HALO_TONES.accent);
        else if (measureSet.has(at.atomId)) put(at.key, base, HALO_TONES.amber);
        else if (highlightColorOf.has(at.atomId)) put(at.key, base, highlightColorOf.get(at.atomId)!);
        if (invalid?.atomId === at.atomId) put(at.key, base * 1.12, HALO_TONES.danger);
      }
      haloMesh.count = n;
      haloMesh.instanceMatrix.needsUpdate = true;
      if (haloMesh.instanceColor) haloMesh.instanceColor.needsUpdate = true;
    }
  }

  const capacity = (n: number) => Math.max(8, Math.ceil(n * 1.5));
  const atomCap = capacity(heavy.length);
  const hCap = capacity(hydrogens.length);
  const bondCap = capacity(bondInstances.length);
  const haloCap = capacity(heavy.length * 2 + 4);

  const pickAtom = (list: RAtom[]) => (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined || ghost) return;
    const at = list[e.instanceId];
    if (!at) return;
    e.stopPropagation();
    handlers.onAtomPointerDown?.(e, at.key, at);
  };
  const overAtom = (list: RAtom[]) => (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined || ghost) return;
    e.stopPropagation();
    handlers.onAtomOver?.(list[e.instanceId] ?? null);
  };
  const pickBond = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined || ghost) return;
    const inst = bondInstances[e.instanceId];
    if (!inst) return;
    e.stopPropagation();
    handlers.onBondPointerDown?.(e, inst.bond);
  };

  return (
    <group>
      <instancedMesh
        key={`a${atomCap}`}
        ref={atomRef}
        args={[sphereGeo, undefined, atomCap]}
        onPointerDown={pickAtom(heavy)}
        onPointerMove={overAtom(heavy)}
        onPointerOut={() => handlers.onAtomOver?.(null)}
        castShadow
        frustumCulled={false}
      >
        <meshPhysicalMaterial roughness={0.3} metalness={0} clearcoat={0.65} clearcoatRoughness={0.16} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </instancedMesh>
      <instancedMesh
        key={`h${hCap}`}
        ref={hRef}
        args={[sphereGeo, undefined, hCap]}
        onPointerDown={pickAtom(hydrogens)}
        onPointerMove={overAtom(hydrogens)}
        onPointerOut={() => handlers.onAtomOver?.(null)}
        frustumCulled={false}
      >
        <meshPhysicalMaterial roughness={0.35} metalness={0} clearcoat={0.5} clearcoatRoughness={0.2} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </instancedMesh>
      <instancedMesh key={`b${bondCap}`} ref={bondRef} args={[cylGeo, undefined, bondCap]} onPointerDown={pickBond} onPointerMove={(e) => { if (e.instanceId !== undefined && !ghost) { e.stopPropagation(); handlers.onBondOver?.(bondInstances[e.instanceId]?.bond ?? null); } }} onPointerOut={() => handlers.onBondOver?.(null)} frustumCulled={false}>
        <meshPhysicalMaterial roughness={0.42} metalness={0} clearcoat={0.35} clearcoatRoughness={0.3} transparent={ghost} opacity={ghost ? 0.35 : 1} />
      </instancedMesh>
      <instancedMesh key={`g${haloCap}`} ref={haloRef} args={[haloGeo, undefined, haloCap]} frustumCulled={false} renderOrder={2} raycast={() => null}>
        <meshBasicMaterial transparent opacity={0.28} depthWrite={false} side={THREE.FrontSide} toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

export function positionOf(key: string): Vec3 | null {
  const p = displayPositions.get(key);
  return p ? [p.x, p.y, p.z] : null;
}
