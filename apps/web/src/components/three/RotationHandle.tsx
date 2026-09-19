'use client';
import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStudio } from '@/lib/store';
import { computeScan, currentDihedral, rotateBond, rotationEnds } from '@/lib/conformer';
import { displayPositions } from './MoleculeMesh';

/** Arc handle around the active rotatable bond; drag it to change the dihedral (spec §7 Conformer mode). */
export function RotationHandle({ onInteract }: { onInteract: (v: boolean) => void }) {
  const bondId = useStudio((s) => s.activeBond);
  const doc = useStudio((s) => s.doc);
  const scan = useStudio((s) => s.scan);
  const group = useRef<THREE.Group>(null);
  const readout = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = useRef<number | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const { camera, gl } = useThree();
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null;
  const bond = doc.bonds.find((b) => b.id === bondId);

  useEffect(() => {
    if (bondId && scan?.bondId !== bondId) void computeScan(bondId);
  }, [bondId, scan?.bondId]);

  useFrame(() => {
    if (!bond || !group.current) return;
    const a = displayPositions.get(bond.a1);
    const b = displayPositions.get(bond.a2);
    if (!a || !b) return;
    group.current.position.copy(a).lerp(b, 0.5);
    group.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
    if (readout.current && scan) {
      const d = currentDihedral(scan.dihedral);
      if (d !== null) readout.current.textContent = `${d.toFixed(0)}°`;
    }
  });

  const toScreen = (p: THREE.Vector3) => {
    const c = p.clone().project(camera);
    const rect = gl.domElement.getBoundingClientRect();
    return new THREE.Vector2(rect.left + ((c.x + 1) / 2) * rect.width, rect.top + ((1 - c.y) / 2) * rect.height);
  };

  const screenAngle = (clientX: number, clientY: number) => {
    const c = group.current!.position.clone().project(camera);
    const rect = gl.domElement.getBoundingClientRect();
    const cx = rect.left + ((c.x + 1) / 2) * rect.width;
    const cy = rect.top + ((1 - c.y) / 2) * rect.height;
    return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
  };

  useEffect(() => {
    if (!dragging || !bondId) return;
    const move = (e: PointerEvent) => {
      const ang = screenAngle(e.clientX, e.clientY);
      const ends = rotationEnds(bondId);
      const a = ends && displayPositions.get(ends.fixed);
      const b = ends && displayPositions.get(ends.moving);
      if (a && b && last.current !== null && lastPt.current) {
        const axis = b.clone().sub(a).normalize();
        const centre = group.current!.position;
        const view = camera.position.clone().sub(centre).normalize();
        const facing = axis.dot(view);
        if (Math.abs(facing) > 0.8) {
          // Looking down the bond: the ring is a circle on screen, so turn it like a dial.
          let d = ang - last.current;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          rotateBond(bondId, facing > 0 ? -d : d);
        } else {
          // Ring seen side-on: the near side of the ring follows the pointer. For +1° the near-side
          // point r moves along axis × r; project that to pixels and read the drag against it.
          const r = view.clone().sub(axis.clone().multiplyScalar(axis.dot(view))).normalize().multiplyScalar(0.72);
          const p0 = centre.clone().add(r);
          const p1 = p0.clone().add(axis.clone().cross(r).multiplyScalar(Math.PI / 180));
          const perDegree = toScreen(p1).sub(toScreen(p0));
          const drag = new THREE.Vector2(e.clientX - lastPt.current.x, e.clientY - lastPt.current.y);
          const len2 = perDegree.lengthSq();
          if (len2 > 1e-6) rotateBond(bondId, Math.max(-30, Math.min(30, drag.dot(perDegree) / len2)));
        }
      }
      last.current = ang;
      lastPt.current = { x: e.clientX, y: e.clientY };
    };
    const up = () => {
      setDragging(false);
      onInteract(false);
      last.current = null;
      lastPt.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  if (!bond) return null;
  const start = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    // Stop the camera before React re-renders, so the drag turns the bond and never the view.
    if (controls) controls.enabled = false;
    setDragging(true);
    onInteract(true);
    last.current = screenAngle(e.nativeEvent.clientX, e.nativeEvent.clientY);
    lastPt.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };
  return (
    <group ref={group}>
      {/* A fatter invisible torus makes the thin ring easy to grab with a mouse or a finger. */}
      <mesh onPointerDown={start}>
        <torusGeometry args={[0.72, 0.24, 8, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
      </mesh>
      <mesh onPointerDown={start} renderOrder={4}>
        <torusGeometry args={[0.72, 0.075, 16, 64]} />
        <meshBasicMaterial color={dragging ? '#a597ff' : '#8b7cff'} transparent opacity={dragging ? 0.95 : 0.7} depthTest={false} />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 4]} position={[0.72, 0, 0]} renderOrder={4} onPointerDown={start}>
        <coneGeometry args={[0.13, 0.26, 16]} />
        <meshBasicMaterial color="#a597ff" depthTest={false} />
      </mesh>
      <Html center zIndexRange={[30, 20]} style={{ pointerEvents: 'none', transform: 'translate(0,-44px)' }}>
        <div className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[12px] font-semibold text-accent-ink shadow-lg">
          <span className="opacity-70">dihedral</span>
          <span ref={readout} className="mono">–</span>
        </div>
      </Html>
    </group>
  );
}
