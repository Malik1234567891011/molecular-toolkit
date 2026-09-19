'use client';
/**
 * 3D exports (spec §11): glTF/GLB for AR and 3D tools, STL for printing, USDZ for iOS Quick Look.
 * The live view uses instancing; exporters want plain meshes, so an export scene is built from
 * the same graph + conformer. Units: 1 Å → 1 unit for glTF/USDZ viewers that rescale; STL in mm.
 */
import * as THREE from 'three';
import { MolView, type MoleculeDocument } from '@orbital/chem';
import { atomColor } from './colors';

const RADIUS: Record<string, number> = { H: 0.25 };
const BOND_R = 0.11;

export function buildMoleculeGroup(doc: MoleculeDocument, opts: { theme?: 'dark' | 'light'; hydrogens?: boolean; scale?: number; segments?: number } = {}): THREE.Group {
  const theme = opts.theme ?? 'light';
  const seg = opts.segments ?? 24;
  const group = new THREE.Group();
  group.name = doc.title ?? 'molecule';
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  if (!conf) return group;
  const view = new MolView(doc);
  const pts: Record<string, THREE.Vector3> = {};
  for (const [k, p] of Object.entries(conf.coordinates)) pts[k] = new THREE.Vector3(p[0], p[1], p[2]);
  const center = new THREE.Vector3();
  const keys = Object.keys(pts).filter((k) => opts.hydrogens !== false || !k.includes('.'));
  for (const k of keys) center.add(pts[k]);
  center.multiplyScalar(1 / Math.max(1, keys.length));
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (el: string) => {
    let m = materials.get(el);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(atomColor(el, theme)), roughness: 0.35, metalness: 0.05 });
      m.name = el;
      materials.set(el, m);
    }
    return m;
  };
  const sphere = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
  const cyl = new THREE.CylinderGeometry(1, 1, 1, Math.max(8, Math.round(seg * 0.6)));
  const addAtom = (key: string, el: string) => {
    const p = pts[key];
    if (!p) return;
    const m = new THREE.Mesh(sphere, mat(el));
    const r = RADIUS[el] ?? (el === 'C' ? 0.34 : 0.32);
    m.scale.setScalar(r);
    m.position.copy(p).sub(center);
    m.name = `${el}:${key}`;
    group.add(m);
  };
  const addBond = (a: THREE.Vector3, b: THREE.Vector3, ea: string, eb: string, order: number) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q).multiplyScalar(0.14);
    const lanes = order === 1 ? [0] : order === 2 ? [-0.5, 0.5] : [-1, 0, 1];
    for (const l of lanes) {
      for (const half of [0, 1]) {
        const m = new THREE.Mesh(cyl, mat(half ? eb : ea));
        const start = a.clone().addScaledVector(dir, half ? 0.5 : 0).addScaledVector(side, l);
        m.position.copy(start).addScaledVector(dir, 0.25).sub(center);
        m.quaternion.copy(q);
        m.scale.set(order === 1 ? BOND_R : BOND_R * 0.7, len / 2, order === 1 ? BOND_R : BOND_R * 0.7);
        group.add(m);
      }
    }
  };
  doc.atoms.forEach((atom, i) => {
    addAtom(atom.id, atom.element);
    if (opts.hydrogens === false) return;
    for (let k = 1; k <= view.implicitH(i); k++) {
      const key = `${atom.id}.h${k}`;
      if (!pts[key]) continue;
      addAtom(key, 'H');
      addBond(pts[atom.id], pts[key], atom.element, 'H', 1);
    }
  });
  for (const b of doc.bonds) {
    const pa = pts[b.a1];
    const pb = pts[b.a2];
    if (!pa || !pb) continue;
    addBond(pa, pb, doc.atoms.find((x) => x.id === b.a1)!.element, doc.atoms.find((x) => x.id === b.a2)!.element, b.order);
  }
  if (opts.scale) group.scale.setScalar(opts.scale);
  return group;
}

export async function exportGLB(doc: MoleculeDocument, theme: 'dark' | 'light' = 'light', scale = 0.025): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  // Real-world scale for AR: 1 Å → 2.5 cm, like a classroom model kit.
  const group = buildMoleculeGroup(doc, { theme, scale });
  const scene = new THREE.Scene();
  scene.add(group);
  return new Promise((resolve, reject) => new GLTFExporter().parse(scene, (r) => resolve(r as ArrayBuffer), reject, { binary: true }));
}

export async function exportGLTF(doc: MoleculeDocument, theme: 'dark' | 'light' = 'light'): Promise<string> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const scene = new THREE.Scene();
  scene.add(buildMoleculeGroup(doc, { theme }));
  return new Promise((resolve, reject) => new GLTFExporter().parse(scene, (r) => resolve(JSON.stringify(r)), reject, { binary: false }));
}

export async function exportSTL(doc: MoleculeDocument): Promise<ArrayBuffer> {
  const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
  // Printable: 1 Å → 10 mm, fewer segments; binary STL keeps the file small.
  const group = buildMoleculeGroup(doc, { scale: 10, segments: 20 });
  group.updateMatrixWorld(true);
  const view = new STLExporter().parse(group, { binary: true }) as unknown as DataView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export async function exportUSDZ(doc: MoleculeDocument, theme: 'dark' | 'light' = 'light'): Promise<Uint8Array> {
  const { USDZExporter } = await import('three/examples/jsm/exporters/USDZExporter.js');
  const scene = new THREE.Scene();
  scene.add(buildMoleculeGroup(doc, { theme, scale: 0.025, segments: 20 }));
  scene.updateMatrixWorld(true);
  return new USDZExporter().parseAsync(scene) as Promise<Uint8Array>;
}
