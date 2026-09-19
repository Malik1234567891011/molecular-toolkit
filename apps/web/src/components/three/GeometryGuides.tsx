'use client';
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { MolView } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { displayPositions } from './MoleculeMesh';

/**
 * Geometry mode: translucent coordination polyhedron + lone-pair lobes + VSEPR label for the
 * selected atom (or every heavy atom when nothing is selected, capped). Also draws the ghost
 * of an impossible bond at the valence boundary.
 */
export function GeometryGuides() {
  const style = useStudio((s) => s.renderStyle);
  const doc = useStudio((s) => s.doc);
  const selection = useStudio((s) => s.selection);
  const analysis = useStudio((s) => s.analysis);
  const invalid = useStudio((s) => s.invalid);
  const centres = useMemo(() => {
    if (style !== 'geometry') return [];
    const ids = selection.atoms.length ? selection.atoms : doc.atoms.filter((a) => a.element !== 'H').slice(0, 12).map((a) => a.id);
    return ids.filter((id) => analysis?.geometry[id]);
  }, [style, selection, doc, analysis]);
  return (
    <>
      {centres.map((id) => (
        <Polyhedron key={id} atomId={id} />
      ))}
      {invalid?.ghostTo && <Ghost atomId={invalid.atomId} to={invalid.ghostTo} />}
    </>
  );
}

function Polyhedron({ atomId }: { atomId: string }) {
  const doc = useStudio((s) => s.doc);
  const g = useStudio((s) => s.analysis?.geometry[atomId]);
  const meshRef = useRef<THREE.Mesh>(null);
  const lpRef = useRef<THREE.Group>(null);
  const labelRef = useRef<THREE.Group>(null);
  const view = useMemo(() => new MolView(doc), [doc]);
  const partners = useMemo(() => {
    const i = view.idx(atomId);
    const keys = view.nbrs[i].map((j) => doc.atoms[j].id);
    for (let k = 1; k <= view.implicitH(i); k++) keys.push(`${atomId}.h${k}`);
    return keys;
  }, [view, doc, atomId]);
  const geo = useMemo(() => new THREE.BufferGeometry(), []);
  useFrame(() => {
    const c = displayPositions.get(atomId);
    if (!c) return;
    if (labelRef.current) labelRef.current.position.copy(c);
    const pts = partners.map((k) => displayPositions.get(k)).filter(Boolean) as THREE.Vector3[];
    // Normalise to 1.1 Å so the polyhedron reads as geometry, not bond lengths.
    const dirs = pts.map((p) => p.clone().sub(c).normalize());
    const verts = dirs.map((d) => c.clone().addScaledVector(d, 1.1));
    const positions: number[] = [];
    if (verts.length >= 3) {
      for (let a = 0; a < verts.length; a++)
        for (let b = a + 1; b < verts.length; b++)
          for (let d = b + 1; d < verts.length; d++) positions.push(...verts[a].toArray(), ...verts[b].toArray(), ...verts[d].toArray());
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    // Lone pairs: remaining tetrahedral directions.
    if (lpRef.current && g && g.lonePairs > 0 && g.hybridization === 'sp3') {
      const sum = dirs.reduce((s, d) => s.add(d), new THREE.Vector3());
      const lp = sum.lengthSq() > 1e-6 ? sum.clone().negate().normalize() : new THREE.Vector3(0, 1, 0);
      lpRef.current.children.forEach((child, k) => {
        const m = child as THREE.Mesh;
        let dir = lp.clone();
        if (g.lonePairs === 2) {
          const perp = new THREE.Vector3().crossVectors(dirs[0] ?? new THREE.Vector3(1, 0, 0), dirs[1] ?? new THREE.Vector3(0, 1, 0)).normalize();
          dir = lp.clone().multiplyScalar(Math.cos(0.95)).addScaledVector(perp, (k === 0 ? 1 : -1) * Math.sin(0.95)).normalize();
        }
        m.visible = k < g.lonePairs;
        m.position.copy(c).addScaledVector(dir, 0.62);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      });
    }
  });
  if (!g) return null;
  return (
    <group>
      <mesh ref={meshRef} geometry={geo} renderOrder={3}>
        <meshStandardMaterial color="#8b7cff" transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <group ref={lpRef}>
        {[0, 1].map((k) => (
          <mesh key={k} scale={[0.26, 0.5, 0.26]} renderOrder={3}>
            <sphereGeometry args={[1, 24, 16]} />
            <meshStandardMaterial color="#f2b34c" transparent opacity={0.35} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <group ref={labelRef}>
        <Html center zIndexRange={[25, 15]} style={{ pointerEvents: 'none', transform: 'translate(0, 34px)' }}>
          <div className="whitespace-nowrap rounded-md bg-black/70 px-1.5 py-0.5 text-[10.5px] text-white">
            {g.hybridization} · {g.molecularGeometry}
            {g.idealAngle ? ` · ideal ${g.idealAngle}°` : ''}
          </div>
        </Html>
      </group>
    </group>
  );
}

function Ghost({ atomId, to }: { atomId: string; to: [number, number, number] }) {
  const line = useRef<THREE.Mesh>(null);
  const end = useMemo(() => new THREE.Vector3(...to), [to]);
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const a = displayPositions.get(atomId);
    if (!a || !line.current) return;
    const dir = end.clone().sub(a);
    line.current.position.copy(a).lerp(end, 0.5);
    line.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    line.current.scale.set(0.07, dir.length(), 0.07);
    if (ring.current) {
      ring.current.position.copy(a);
      const s = 0.55 + 0.05 * Math.sin(clock.elapsedTime * 5);
      ring.current.scale.setScalar(s);
    }
  });
  return (
    <group>
      <mesh ref={line} renderOrder={4}>
        <cylinderGeometry args={[1, 1, 1, 12]} />
        <meshBasicMaterial color="#ff5f6d" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh position={end} renderOrder={4}>
        <sphereGeometry args={[0.3, 24, 16]} />
        <meshBasicMaterial color="#ff5f6d" transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <mesh ref={ring} renderOrder={4}>
        <torusGeometry args={[1, 0.06, 12, 48]} />
        <meshBasicMaterial color="#ff5f6d" transparent opacity={0.85} depthTest={false} />
      </mesh>
    </group>
  );
}
