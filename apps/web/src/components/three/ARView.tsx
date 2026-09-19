'use client';
/**
 * "Put it on your desk" (spec §11): WebXR immersive-ar with a hit-test reticle. Tap to place;
 * the molecule appears at classroom-kit scale (1 Å ≈ 2.5 cm). iOS uses Quick Look instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { createXRStore, useXR, useXRHitTest, XR } from '@react-three/xr';
import * as THREE from 'three';
import type { MoleculeDocument } from '@orbital/chem';
import { buildMoleculeGroup } from '@/lib/export3d';
import { track } from '@/lib/analytics';

const matrix = new THREE.Matrix4();
const hitPosition = new THREE.Vector3();

function Placement({ doc }: { doc: MoleculeDocument }) {
  const group = useMemo(() => buildMoleculeGroup(doc, { scale: 0.025, theme: 'light' }), [doc]);
  const reticle = useRef<THREE.Mesh>(null);
  const molecule = useRef<THREE.Group>(null);
  const [placed, setPlaced] = useState(false);
  const hasHit = useRef(false);
  const session = useXR((s) => s.session);
  useXRHitTest((results, getWorldMatrix) => {
    if (!results.length) {
      hasHit.current = false;
      return;
    }
    getWorldMatrix(matrix, results[0]);
    hitPosition.setFromMatrixPosition(matrix);
    hasHit.current = true;
  }, 'viewer');
  useEffect(() => {
    if (!session) return;
    const onSelect = () => {
      if (!hasHit.current || !molecule.current) return;
      // Float the model a little above the surface so it sits on it.
      molecule.current.position.copy(hitPosition).add(new THREE.Vector3(0, 0.12, 0));
      setPlaced(true);
    };
    session.addEventListener('select', onSelect);
    return () => session.removeEventListener('select', onSelect);
  }, [session]);
  useFrame((_, dt) => {
    if (reticle.current) {
      reticle.current.visible = hasHit.current;
      reticle.current.position.copy(hitPosition);
    }
    if (molecule.current && placed) molecule.current.rotation.y += dt * 0.25;
  });
  return (
    <>
      <mesh ref={reticle} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[0.05, 0.065, 40]} />
        <meshBasicMaterial color="#8b7cff" transparent opacity={0.9} />
      </mesh>
      <group ref={molecule} position={[0, 0, -0.6]}>
        <primitive object={group} />
      </group>
    </>
  );
}

export default function ARView({ doc, onClose }: { doc: MoleculeDocument; onClose: () => void }) {
  const store = useMemo(() => createXRStore({ hand: false, controller: false, offerSession: false, emulate: false }), []);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => store.subscribe((s) => setActive(!!s.session)), [store]);
  const start = async () => {
    setError(null);
    try {
      track('ar_opened', { platform: 'webxr' });
      const session = await store.enterAR();
      if (!session) setError('The browser did not start an AR session.');
    } catch (e) {
      setError((e as Error).message || 'AR is not available on this device.');
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/80 backdrop-blur" data-testid="ar-view">
      <div className="flex items-center justify-between p-3 text-white">
        <span className="text-[14px] font-semibold">See it on your desk</span>
        <button onClick={onClose} className="rounded-lg px-3 py-1 text-[13px] hover:bg-white/10">Close</button>
      </div>
      <div className="relative flex-1">
        <Canvas camera={{ position: [0, 0.1, 0.4], fov: 50 }} gl={{ alpha: true }}>
          <XR store={store}>
            <ambientLight intensity={0.9} />
            <directionalLight position={[1, 2, 1]} intensity={1.4} />
            <Placement doc={doc} />
          </XR>
        </Canvas>
        {!active && (
          <div className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-2 px-6 text-center text-white">
            <p className="text-[13px] opacity-80">Point your phone at a table, then tap to place the molecule. Walk around it — it stays put.</p>
            <button onClick={() => void start()} className="rounded-2xl bg-[#8b7cff] px-6 py-3 text-[15px] font-semibold text-[#0b0e14]" data-testid="start-ar">Start AR</button>
            {error && <p className="text-[12.5px] text-[#ffb4bb]">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
