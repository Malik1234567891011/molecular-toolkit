'use client';
/**
 * SN2 backside attack in 3D (spec §11 "umbrella flip"): (R)-2-bromobutane + HO⁻ → (S)-butan-2-ol.
 * The three spectator groups pass through a planar (trigonal bipyramidal) transition state and
 * invert. Positions are a schematic trajectory, not a computed reaction path.
 */
import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { atomColor } from '@/lib/colors';

const ease = (t: number) => t * t * (3 - 2 * t);

interface Frame {
  atoms: Array<{ key: string; el: string; p: THREE.Vector3; r: number; label?: string }>;
  bonds: Array<{ a: THREE.Vector3; b: THREE.Vector3; kind: 'full' | 'partial'; opacity: number; ca: string; cb: string }>;
  stage: string;
  descriptor: string;
}

function frame(t: number, theme: 'dark' | 'light'): Frame {
  // C at the origin; leaving group along +x, nucleophile along −x.
  const u = ease(Math.min(1, Math.max(0, t)));
  const nuX = THREE.MathUtils.lerp(-3.8, -1.43, Math.min(1, u * 1.15));
  const lgX = THREE.MathUtils.lerp(1.94, 3.8, Math.max(0, (u - 0.35) / 0.65));
  // Umbrella: substituents lean toward −x (away from Br) before, toward +x after.
  const lean = THREE.MathUtils.lerp(-0.334, 0.334, u);
  const radial = Math.sqrt(1 - lean * lean);
  const dirs = [0, 120, 240].map((deg) => {
    const a = (deg * Math.PI) / 180 + 0.3;
    return new THREE.Vector3(lean, radial * Math.cos(a), radial * Math.sin(a));
  });
  const C = new THREE.Vector3(0, 0, 0);
  const sub = [
    { key: 'H', el: 'H', len: 1.09, r: 0.28 },
    { key: 'CH3', el: 'C', len: 1.53, r: 0.42, label: 'CH₃' },
    { key: 'C2H5', el: 'C', len: 1.53, r: 0.42, label: 'CH₂CH₃' },
  ].map((s, k) => ({ ...s, p: dirs[k].clone().multiplyScalar(s.len) }));
  const O = new THREE.Vector3(nuX, 0, 0);
  const OH = O.clone().add(new THREE.Vector3(-0.55, 0.78, 0));
  const Br = new THREE.Vector3(lgX, 0, 0);
  const col = (el: string) => atomColor(el, theme);
  const formed = Math.min(1, Math.max(0, (u - 0.2) / 0.6));
  const broken = Math.min(1, Math.max(0, (u - 0.35) / 0.5));
  const atoms: Frame['atoms'] = [
    { key: 'C', el: 'C', p: C, r: 0.42 },
    ...sub.map((s) => ({ key: s.key, el: s.el, p: s.p, r: s.r, label: s.label })),
    { key: 'O', el: 'O', p: O, r: 0.4, label: u < 0.58 ? 'HO⁻' : 'OH' },
    { key: 'OH', el: 'H', p: OH, r: 0.26 },
    { key: 'Br', el: 'Br', p: Br, r: 0.55, label: u > 0.6 ? 'Br⁻' : 'Br' },
  ];
  const bonds: Frame['bonds'] = [
    ...sub.map((s) => ({ a: C, b: s.p, kind: 'full' as const, opacity: 1, ca: col('C'), cb: col(s.el) })),
    { a: O, b: OH, kind: 'full', opacity: 1, ca: col('O'), cb: col('H') },
    { a: O, b: C, kind: formed >= 1 ? 'full' : 'partial', opacity: formed, ca: col('O'), cb: col('C') },
    { a: C, b: Br, kind: broken > 0 ? 'partial' : 'full', opacity: 1 - broken, ca: col('C'), cb: col('Br') },
  ];
  const stage = u < 0.15 ? 'Reactants: (R)-2-bromobutane + HO⁻' : u < 0.42 ? 'Hydroxide approaches the back side' : u < 0.58 ? 'Transition state: five-coordinate, groups planar' : u < 0.92 ? 'Bromide leaves; the umbrella flips' : 'Product: (S)-butan-2-ol — inverted';
  return { atoms, bonds, stage, descriptor: u < 0.5 ? 'R' : 'S' };
}

function Bond({ a, b, kind, opacity, ca, cb }: Frame['bonds'][number]) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const mid = a.clone().lerp(b, 0.5);
  if (opacity <= 0.02) return null;
  if (kind === 'partial') {
    // Dashed partial bond: a row of short segments.
    const n = Math.max(3, Math.round(len / 0.25));
    return (
      <group>
        {Array.from({ length: n }, (_, k) => {
          const t = (k + 0.5) / n;
          return (
            <mesh key={k} position={a.clone().lerp(b, t)} quaternion={q} scale={[0.06, (len / n) * 0.5, 0.06]}>
              <cylinderGeometry args={[1, 1, 1, 8]} />
              <meshStandardMaterial color={t < 0.5 ? ca : cb} transparent opacity={Math.max(0.35, opacity)} />
            </mesh>
          );
        })}
      </group>
    );
  }
  return (
    <group>
      <mesh position={a.clone().lerp(mid, 0.5)} quaternion={q} scale={[0.1, len / 2, 0.1]}>
        <cylinderGeometry args={[1, 1, 1, 14]} />
        <meshStandardMaterial color={ca} transparent={opacity < 1} opacity={opacity} />
      </mesh>
      <mesh position={mid.clone().lerp(b, 0.5)} quaternion={q} scale={[0.1, len / 2, 0.1]}>
        <cylinderGeometry args={[1, 1, 1, 14]} />
        <meshStandardMaterial color={cb} transparent={opacity < 1} opacity={opacity} />
      </mesh>
    </group>
  );
}

export default function SN2Viewer({ t, theme }: { t: number; theme: 'dark' | 'light' }) {
  const f = useMemo(() => frame(t, theme), [t, theme]);
  return (
    <div className="relative h-[230px] w-full overflow-hidden rounded-xl border border-border bg-panel-raised" data-testid="sn2-3d">
      <Canvas camera={{ position: [0.2, 2.8, 11.8], fov: 38 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[4, 6, 6]} intensity={1.5} />
        <directionalLight position={[-5, -2, 3]} intensity={0.4} color="#b8c4ff" />
        {f.atoms.map((a) => (
          <group key={a.key} position={a.p}>
            <mesh scale={a.r}>
              <sphereGeometry args={[1, 28, 20]} />
              <meshPhysicalMaterial color={atomColor(a.el, theme)} roughness={0.35} clearcoat={0.5} />
            </mesh>
            {a.label && (
              <Html center distanceFactor={9} position={[0, a.r + 0.35, 0]} style={{ pointerEvents: 'none' }}>
                <span className="whitespace-nowrap rounded bg-panel px-1 text-[11px] font-semibold text-text">{a.label}</span>
              </Html>
            )}
          </group>
        ))}
        {f.bonds.map((b, k) => (
          <Bond key={k} {...b} />
        ))}
        <OrbitControls enablePan={false} enableZoom={false} />
      </Canvas>
      <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-panel px-2 py-0.5 text-[11.5px]">{f.stage}</div>
      <div className="pointer-events-none absolute right-2 top-2 rounded-md bg-panel px-2 py-0.5 text-[12px] font-semibold italic text-accent-strong">C2: {f.descriptor}</div>
      <div className="pointer-events-none absolute bottom-2 left-2 right-2 text-[11px] text-text-3">Shown on 2-bromobutane, whose stereocentre makes the inversion visible. Drag to turn it.</div>
    </div>
  );
}
