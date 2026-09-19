'use client';
import { useMemo } from 'react';
import * as THREE from 'three';
import { useOrbitals } from '@/lib/orbitals';
import { useStudio } from '@/lib/store';

/** Isosurfaces from the last quantum job, drawn in the model's own coordinates (Å). */
export function OrbitalSurfaces() {
  const meshes = useOrbitals((s) => s.meshes);
  const opacity = useOrbitals((s) => s.opacity);
  const showDipole = useOrbitals((s) => s.showDipole);
  const result = useOrbitals((s) => s.result);
  const doc = useStudio((s) => s.doc);
  // Surfaces belong to the Orbitals panel: leaving it shows the plain model again (the result
  // is kept, so reopening the panel brings them straight back).
  const visible = useStudio((s) => s.panel === 'orbitals');
  const geoms = useMemo(
    () =>
      meshes.map((m) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
        if (m.colors) g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
        return { g, m };
      }),
    [meshes],
  );
  const dipole = useMemo(() => {
    if (!showDipole || !result) return null;
    const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
    if (!conf) return null;
    const pts = Object.values(conf.coordinates);
    const c = pts.reduce((s, p) => s.add(new THREE.Vector3(...p)), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const d = new THREE.Vector3(...result.dipole_debye);
    const mag = d.length();
    if (mag < 0.05) return null;
    // Chemistry convention: the arrow points toward the negative end (δ−).
    const dir = d.clone().normalize().negate();
    return { c, dir, len: Math.min(4, 0.6 + mag * 0.7), mag };
  }, [showDipole, result, doc]);
  if (!visible) return null;
  return (
    <group>
      {geoms.map(({ g, m }) =>
        // Transparent surfaces: draw inner (back) faces first, then outer faces, so layers
        // of the same surface don't show through each other.
        (['back', 'front'] as const).map((side) => (
          <mesh key={`${m.key}-${side}`} geometry={g} renderOrder={side === 'back' ? 2 : 3}>
            <meshPhysicalMaterial
              color={m.colors ? '#ffffff' : m.color}
              vertexColors={!!m.colors}
              transparent
              opacity={side === 'back' ? opacity * 0.6 : opacity}
              roughness={0.35}
              clearcoat={0.4}
              depthWrite={side === 'front' && opacity > 0.95}
              side={side === 'back' ? THREE.BackSide : THREE.FrontSide}
            />
          </mesh>
        )),
      )}
      {dipole && (
        <arrowHelper args={[dipole.dir, dipole.c.clone().addScaledVector(dipole.dir, -dipole.len / 2), dipole.len, 0xf2b34c, 0.45, 0.28]} />
      )}
    </group>
  );
}
