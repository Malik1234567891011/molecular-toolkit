'use client';
import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { MolView, type MoleculeDocument } from '@orbital/chem';
import { atomColor } from '@/lib/colors';
import { atomRadius, boundingSphere } from './scene-data';

/** Read-only molecule viewer (landing hero, share pages, embeds). */
export function Viewer({ doc, theme, autoRotate = true, height = '100%', interactive = true }: { doc: MoleculeDocument; theme: 'dark' | 'light'; autoRotate?: boolean; height?: string | number; interactive?: boolean }) {
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  const { center, radius } = useMemo(() => boundingSphere(conf?.coordinates ?? {}), [conf]);
  const items = useMemo(() => {
    if (!conf) return { atoms: [], bonds: [] as Array<{ a: THREE.Vector3; b: THREE.Vector3; ca: string; cb: string; order: number }> };
    const view = new MolView(doc);
    const atoms: Array<{ p: THREE.Vector3; r: number; c: string }> = [];
    const bonds: Array<{ a: THREE.Vector3; b: THREE.Vector3; ca: string; cb: string; order: number }> = [];
    const P = (k: string) => {
      const p = conf.coordinates[k];
      return p ? new THREE.Vector3(p[0] - center[0], p[1] - center[1], p[2] - center[2]) : null;
    };
    doc.atoms.forEach((a, i) => {
      const p = P(a.id);
      if (!p) return;
      atoms.push({ p, r: atomRadius(a.element, 'kit'), c: atomColor(a.element, theme) });
      for (let k = 1; k <= view.implicitH(i); k++) {
        const h = P(`${a.id}.h${k}`);
        if (!h) continue;
        atoms.push({ p: h, r: atomRadius('H', 'kit'), c: atomColor('H', theme) });
        bonds.push({ a: p, b: h, ca: atomColor(a.element, theme), cb: atomColor('H', theme), order: 1 });
      }
    });
    for (const b of doc.bonds) {
      const p = P(b.a1);
      const q = P(b.a2);
      if (!p || !q) continue;
      const e1 = doc.atoms.find((x) => x.id === b.a1)!.element;
      const e2 = doc.atoms.find((x) => x.id === b.a2)!.element;
      bonds.push({ a: p, b: q, ca: atomColor(e1, theme), cb: atomColor(e2, theme), order: b.order });
    }
    return { atoms, bonds };
  }, [doc, conf, center, theme]);
  return (
    <div style={{ height }} className="w-full">
      <Canvas dpr={[1, 2]} camera={{ position: [0, 0, radius * 3.1], fov: 32 }} gl={{ alpha: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}>
        <ambientLight intensity={0.35} />
        <directionalLight position={[6, 9, 8]} intensity={1.6} />
        <directionalLight position={[-6, -2, 4]} intensity={0.5} color="#b8c4ff" />
        <Environment resolution={64} frames={1}>
          <Lightformer intensity={2} position={[0, 5, 5]} scale={[10, 4, 1]} />
          <Lightformer intensity={0.8} position={[-6, 1, 2]} scale={[3, 6, 1]} color="#c7d0ff" />
        </Environment>
        {items.atoms.map((a, k) => (
          <mesh key={`a${k}`} position={a.p} scale={a.r}>
            <sphereGeometry args={[1, 32, 24]} />
            <meshPhysicalMaterial color={a.c} roughness={0.3} clearcoat={0.6} clearcoatRoughness={0.18} />
          </mesh>
        ))}
        {items.bonds.flatMap((b, k) => {
          const dir = b.b.clone().sub(b.a);
          const len = dir.length();
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
          const mid = b.a.clone().lerp(b.b, 0.5);
          return [
            <mesh key={`b${k}a`} position={b.a.clone().lerp(mid, 0.5)} quaternion={q} scale={[0.1, len / 2, 0.1]}>
              <cylinderGeometry args={[1, 1, 1, 16]} />
              <meshPhysicalMaterial color={b.ca} roughness={0.4} clearcoat={0.3} />
            </mesh>,
            <mesh key={`b${k}b`} position={mid.clone().lerp(b.b, 0.5)} quaternion={q} scale={[0.1, len / 2, 0.1]}>
              <cylinderGeometry args={[1, 1, 1, 16]} />
              <meshPhysicalMaterial color={b.cb} roughness={0.4} clearcoat={0.3} />
            </mesh>,
          ];
        })}
        <ContactShadows position={[0, -radius - 0.2, 0]} opacity={theme === 'dark' ? 0.5 : 0.3} scale={radius * 5} blur={2.6} far={radius * 3} />
        <OrbitControls autoRotate={autoRotate} autoRotateSpeed={0.9} enableZoom={interactive} enablePan={false} enableRotate={interactive} />
      </Canvas>
    </div>
  );
}
