'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { EffectComposer, N8AO, SMAA } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { isRotatable, type AtomId, type Vec3 } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { addAtomTo, connectAtoms, cycleBondOrder } from '@/lib/edit';
import { bus } from '@/lib/events';
import { useResolvedTheme } from '@/lib/useTheme';
import { captureRef } from '@/lib/capture';
import { MoleculeMesh, displayPositions, type PickHandlers } from './MoleculeMesh';
import { boundingSphere, type RAtom, type RBond } from './scene-data';
import { Overlays } from './Overlays';
import { RotationHandle } from './RotationHandle';
import { MiniPalette, type PaletteRequest } from './MiniPalette';
import { GeometryGuides } from './GeometryGuides';
import { OrbitalSurfaces } from './OrbitalSurfaces';

interface DragState {
  kind: 'port' | 'atom';
  parent: AtomId;
  portKey?: string;
  startX: number;
  startY: number;
  moved: boolean;
  depth: number;
}

function CameraRig() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  useEffect(() => {
    const fit = (payload?: unknown) => {
      const doc = studio().doc;
      const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
      const { center, radius } = boundingSphere(conf?.coordinates ?? {});
      const cam = camera as THREE.PerspectiveCamera;
      const fov = (cam.fov * Math.PI) / 180;
      const aspect = size.width / Math.max(1, size.height);
      const fitH = radius / Math.sin(fov / 2);
      const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
      let dist = Math.max(fitH, fitW) * 1.08;
      let target = new THREE.Vector3(...center);
      let dir = camera.position.clone().sub(controls?.target ?? new THREE.Vector3()).normalize();
      if (dir.lengthSq() < 0.5) dir.set(0, 0, 1);
      const view = typeof payload === 'object' && payload ? (payload as { dir: Vec3; target?: Vec3; up?: Vec3 }) : null;
      if (view?.dir) {
        // Look along a chemical axis, e.g. with the lowest-priority ligand pointing away.
        dir = new THREE.Vector3(...view.dir).normalize();
        if (view.target) {
          const t = new THREE.Vector3(...view.target);
          dist *= 1 + t.distanceTo(target) / Math.max(radius, 1);
          target = t;
        }
        if (view.up) camera.up.set(...view.up).normalize();
        else {
          camera.up.set(0, 1, 0);
          if (Math.abs(dir.y) > 0.95) camera.up.set(0, 0, 1);
        }
      }
      if (payload === 'orient' && conf) {
        // Look along the axis of least spread so flat molecules face the viewer.
        const n = principalNormal(Object.values(conf.coordinates), center);
        if (n) {
          dir = n;
          camera.up.set(0, 1, 0);
          if (Math.abs(dir.y) > 0.95) camera.up.set(0, 0, 1);
        }
      }
      const to = target.clone().addScaledVector(dir, dist);
      const instant = payload === 'instant' || document.documentElement.dataset.motion === 'reduced';
      const from = camera.position.clone();
      const fromT = controls?.target.clone() ?? new THREE.Vector3();
      const t0 = performance.now();
      const step = () => {
        const t = instant ? 1 : Math.min(1, (performance.now() - t0) / 250);
        const e = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(from, to, e);
        if (controls) {
          controls.target.lerpVectors(fromT, target, e);
          controls.update();
        }
        if (t < 1) requestAnimationFrame(step);
      };
      step();
    };
    const off = bus.on('fit', fit);
    return off;
  }, [camera, controls, size]);
  // First fit once the controls exist (restored sessions, view switches).
  const fitted = useRef(false);
  useEffect(() => {
    (window as unknown as { __orbitalCam: unknown }).__orbitalCam = { camera, controls };
  }, [camera, controls]);
  useEffect(() => {
    if (!controls || fitted.current) return;
    fitted.current = true;
    const t = setTimeout(() => bus.emit('fit', 'orient'), 60);
    return () => clearTimeout(t);
  }, [controls]);
  return null;
}

/** Exposes the renderer to image/animation export (lib/capture). */
function CaptureBridge() {
  const { gl, scene, camera } = useThree();
  const controls = useThree((s) => s.controls) as unknown as OrbitControlsImpl | null;
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    captureRef.current = { gl, scene, camera, controls, advance: () => advance(performance.now(), true) };
    return () => {
      if (captureRef.current?.gl === gl) captureRef.current = null;
    };
  }, [gl, scene, camera, controls, advance]);
  return null;
}

/** Eigenvector of the smallest variance of the point cloud (power iteration on the shifted covariance). */
function principalNormal(points: Array<[number, number, number]>, c: [number, number, number]): THREE.Vector3 | null {
  if (points.length < 3) return null;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
  }
  const tr = C[0][0] + C[1][1] + C[2][2];
  // Largest eigenvector of (tr·I − C) is the smallest of C.
  const M = C.map((row, i) => row.map((v, j) => (i === j ? tr - v : -v)));
  let v = new THREE.Vector3(0.3, 0.4, 0.85);
  for (let it = 0; it < 60; it++) {
    const nv = new THREE.Vector3(M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z, M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z, M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z);
    if (nv.lengthSq() < 1e-12) return null;
    v = nv.normalize();
  }
  return v.z < 0 ? v.negate() : v;
}

function Lights({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <>
      <ambientLight intensity={theme === 'dark' ? 0.32 : 0.55} />
      <directionalLight position={[6, 9, 8]} intensity={theme === 'dark' ? 1.7 : 1.45} castShadow={false} />
      <directionalLight position={[-7, -2, 5]} intensity={0.45} color="#b8c4ff" />
      <directionalLight position={[0, 5, -9]} intensity={theme === 'dark' ? 1.1 : 0.6} color="#ffffff" />
      <Environment resolution={128} frames={1}>
        <Lightformer intensity={2.2} position={[0, 5, 5]} scale={[10, 4, 1]} form="rect" />
        <Lightformer intensity={0.9} position={[-6, 1, 2]} scale={[3, 6, 1]} form="rect" color="#c7d0ff" />
        <Lightformer intensity={0.7} position={[6, -1, 2]} scale={[3, 6, 1]} form="rect" color="#fff1e0" />
        <Lightformer intensity={0.5} position={[0, -6, 0]} rotation-x={Math.PI / 2} scale={[10, 10, 1]} form="circle" />
      </Environment>
    </>
  );
}

function Scene() {
  const theme = useResolvedTheme();
  const mode = useStudio((s) => s.mode3d);
  const doc = useStudio((s) => s.doc);
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const [interacting, setInteracting] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dragPoint, setDragPoint] = useState<THREE.Vector3 | null>(null);
  const { camera, gl, size } = useThree();
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  const bottom = useMemo(() => {
    const { center, radius } = boundingSphere(conf?.coordinates ?? {});
    return center[1] - radius - 0.4;
  }, [conf]);

  // Screen → world at a given depth (for drag ghosts).
  const unproject = (clientX: number, clientY: number, depth: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector3(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1, depth);
    return ndc.unproject(camera);
  };
  const depthOf = (p: THREE.Vector3) => p.clone().project(camera).z;

  const handlers: PickHandlers = {
    onAtomPointerDown: (e, key, atom) => {
      const s = studio();
      const native = e.nativeEvent;
      if (s.mode3d === 'measure') {
        const id = atom.isH ? key : atom.atomId;
        const m = s.measure.includes(id) ? s.measure.filter((x) => x !== id) : [...s.measure, id].slice(-4);
        useStudio.setState({ measure: m });
        return;
      }
      if (atom.isH && s.mode3d === 'build') {
        // Hydrogens are the valence ports.
        const p = displayPositions.get(key);
        setDrag({ kind: 'port', parent: atom.atomId, portKey: key, startX: native.clientX, startY: native.clientY, moved: false, depth: p ? depthOf(p) : 0.5 });
        (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
        return;
      }
      if (native.shiftKey || native.metaKey) {
        s.select([atom.atomId], [], true);
        return;
      }
      s.select([atom.atomId], []);
      if (s.mode3d === 'build') {
        const p = displayPositions.get(key);
        setDrag({ kind: 'atom', parent: atom.atomId, startX: native.clientX, startY: native.clientY, moved: false, depth: p ? depthOf(p) : 0.5 });
      }
    },
    onBondPointerDown: (e, bond: RBond) => {
      const s = studio();
      if (!bond.bondId) {
        // A bond to an implicit hydrogen: treat as the port.
        const hKey = bond.b;
        const p = displayPositions.get(hKey);
        if (s.mode3d === 'build') setDrag({ kind: 'port', parent: bond.a, portKey: hKey, startX: e.nativeEvent.clientX, startY: e.nativeEvent.clientY, moved: false, depth: p ? depthOf(p) : 0.5 });
        return;
      }
      if (s.mode3d === 'conformer') {
        if (isRotatable(s.doc, bond.bondId)) useStudio.setState({ activeBond: bond.bondId, selection: { atoms: [], bonds: [bond.bondId] } });
        else s.notify({ kind: 'info', text: 'This bond cannot rotate freely (it is a multiple bond, in a ring, or terminal).' });
        return;
      }
      if (s.mode3d === 'build' && s.selection.bonds.length === 1 && s.selection.bonds[0] === bond.bondId) {
        cycleBondOrder(bond.bondId);
        return;
      }
      s.select([], [bond.bondId], e.nativeEvent.shiftKey);
    },
    onAtomOver: (atom: RAtom | null) => {
      const cur = studio().hoverAtom;
      const next = atom ? atom.atomId : null;
      if (cur !== next) studio().setHover(next, null);
    },
    onBondOver: (bond: RBond | null) => {
      const cur = studio().hoverBond;
      const next = bond?.bondId ?? null;
      if (cur !== next) studio().setHover(null, next);
    },
  };

  useEffect(() => {
    if (!drag) return;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 6) setDrag({ ...drag, moved: true });
      if (drag.moved || Math.hypot(dx, dy) > 6) setDragPoint(unproject(ev.clientX, ev.clientY, drag.depth));
    };
    const up = (ev: PointerEvent) => {
      const s = studio();
      const target = s.hoverAtom;
      const wasMoved = drag.moved || Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 6;
      setDragPoint(null);
      setDrag(null);
      if (!wasMoved) {
        if (drag.kind === 'port') addAtomTo(drag.parent, s.armedElement, 1, { portKey: drag.portKey });
        return;
      }
      if (target && target !== drag.parent) {
        connectAtoms(drag.parent, target, 1);
        return;
      }
      const end = unproject(ev.clientX, ev.clientY, drag.depth);
      const from = displayPositions.get(drag.parent);
      const dir: Vec3 | undefined = from ? [end.x - from.x, end.y - from.y, end.z - from.z] : undefined;
      // Free ports? If none, this is the "fifth bond" moment: ghost + explanation.
      const hasPort = [1, 2, 3, 4].some((k) => displayPositions.has(`${drag.parent}.h${k}`));
      if (!hasPort && drag.kind === 'atom') {
        // The "fifth bond" moment: addAtomTo leaves a ghost at the boundary and explains.
        addAtomTo(drag.parent, s.armedElement, 1, { direction3d: dir });
        return;
      }
      bus.emit('palette:open', { x: ev.clientX, y: ev.clientY, parent: drag.parent, portKey: drag.kind === 'port' ? drag.portKey : undefined, direction: drag.kind === 'atom' ? dir : undefined } satisfies PaletteRequest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  void size;
  const quality = !interacting && !drag;

  return (
    <>
      <CameraRig />
      <CaptureBridge />
      <Lights theme={theme} />
      <MoleculeMesh handlers={handlers} />
      <GeometryGuides />
      <Overlays />
      <OrbitalSurfaces />
      {mode === 'conformer' && <RotationHandle onInteract={setInteracting} />}
      {drag && dragPoint && <DragGhost from={drag.parent} to={dragPoint} />}
      {doc.atoms.length > 0 && <group userData={{ noExport: true }}><ContactShadows position={[0, bottom, 0]} opacity={theme === 'dark' ? 0.55 : 0.32} scale={30} blur={2.8} far={14} resolution={512} color={theme === 'dark' ? '#000000' : '#3a3550'} frames={reduced ? 1 : Infinity} /></group>}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.12}
        rotateSpeed={0.85}
        enabled={!drag}
        onStart={() => setInteracting(true)}
        onEnd={() => setInteracting(false)}
        minDistance={2}
        maxDistance={80}
      />
      <EffectComposer multisampling={0} enableNormalPass={false}>
        {quality ? <N8AO halfRes aoRadius={1.1} intensity={theme === 'dark' ? 2.2 : 1.6} distanceFalloff={0.6} quality="medium" /> : <></>}
        <SMAA />
      </EffectComposer>
    </>
  );
}

function DragGhost({ from, to }: { from: AtomId; to: THREE.Vector3 }) {
  const p = displayPositions.get(from);
  const ref = useRef<THREE.Mesh>(null);
  if (!p) return null;
  const dir = to.clone().sub(p);
  const len = dir.length();
  const mid = p.clone().lerp(to, 0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return (
    <group>
      <mesh ref={ref} position={mid} quaternion={q} scale={[0.08, len, 0.08]}>
        <cylinderGeometry args={[1, 1, 1, 16]} />
        <meshBasicMaterial color="#8b7cff" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <mesh position={to}>
        <sphereGeometry args={[0.26, 24, 16]} />
        <meshBasicMaterial color="#8b7cff" transparent opacity={0.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

export default function KitCanvas() {
  const theme = useResolvedTheme();
  const [lost, setLost] = useState(false);
  const [generation, setGeneration] = useState(0);
  const retried = useRef(0);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  // Give the browser a moment to restore a lost context; otherwise remount once automatically.
  useEffect(() => {
    if (!lost) return;
    const now = Date.now();
    if (document.visibilityState === 'visible' && now - retried.current > 10000) {
      retried.current = now;
      const t = setTimeout(() => {
        setLost(false);
        setGeneration((g) => g + 1);
      }, 600);
      return () => clearTimeout(t);
    }
  }, [lost]);
  useEffect(() => {
    const a = bus.on('palette:open', (r) => setPalette(r as PaletteRequest));
    const b = bus.on('palette:close', () => setPalette(null));
    return () => {
      a();
      b();
    };
  }, []);
  return (
    <div className="relative h-full w-full" data-testid="kit-canvas">
      {palette && <MiniPalette req={palette} onClose={() => setPalette(null)} />}
      {lost ? (
        <div className="absolute inset-0 grid place-items-center px-6 text-center">
          <div className="max-w-[320px] space-y-2 text-sm text-text-2">
            <p>The 3D view lost its graphics context (the GPU was reset or reclaimed). Your molecule is safe, and the 2D editor still works.</p>
            <button onClick={() => { setLost(false); setGeneration((g) => g + 1); }} className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-ink" data-testid="restore-3d">
              Restore 3D
            </button>
          </div>
        </div>
      ) : (
        <Canvas
          key={generation}
          dpr={[1, 2]}
          gl={{ antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: theme === 'dark' ? 1.05 : 0.95 }}
          camera={{ position: [0, 0, 16], fov: 32, near: 0.1, far: 500 }}
          onPointerMissed={(e) => {
            if (e.type === 'click' && studio().mode3d !== 'conformer') {
              studio().clearSelection();
              bus.emit('palette:close');
            }
          }}
          onCreated={({ gl }) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            gl.domElement.addEventListener('webglcontextlost', (ev) => {
              ev.preventDefault();
              timer = setTimeout(() => setLost(true), 1200);
            });
            gl.domElement.addEventListener('webglcontextrestored', () => clearTimeout(timer));
          }}
        >
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
        </Canvas>
      )}
    </div>
  );
}

export function useCanvasEvents(cb: (e: ThreeEvent<PointerEvent>) => void) {
  return cb;
}
