'use client';
/**
 * Orbitals, density and electrostatic potential (spec §11) from queued quantum jobs. Grids come
 * back from the server; isosurfaces are extracted in the chemistry worker; ESP is mapped onto the
 * density surface with a diverging scale (red = electron-rich, blue = electron-poor).
 */
import { create } from 'zustand';
import { api } from './api';
import { studio, useStudio } from './store';
import { call } from './worker';

export type Surface = 'homo' | 'lumo' | 'density' | 'esp';

export interface QuantumResult {
  method: string;
  caveat: string;
  energy_hartree: number;
  converged: boolean;
  homoIndex: number;
  lumoIndex: number | null;
  orbitalEnergies_eV: number[];
  orbitalEnergyStart: number;
  homoEnergy_eV: number;
  lumoEnergy_eV: number | null;
  mulliken: Record<string, number>;
  dipole_debye: [number, number, number];
  grid: { dims: [number, number, number]; origin: [number, number, number]; spacing: number };
  espGrid: { dims: [number, number, number]; origin: [number, number, number]; spacing: number } | null;
  grids: Partial<Record<'homo' | 'lumo' | 'density' | 'esp', string>>;
  seconds: number;
}

export interface SurfaceMesh {
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  colors?: Float32Array;
  color?: string;
}

interface OrbitalState {
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  error: string | null;
  result: QuantumResult | null;
  forKey: string | null;
  surface: Surface;
  iso: number;
  opacity: number;
  meshes: SurfaceMesh[];
  showCharges: boolean;
  showDipole: boolean;
  espRange: number;
  method: 'HF/sto-3g' | 'HF/3-21g' | 'B3LYP/6-31g*';
}

export const useOrbitals = create<OrbitalState>(() => ({
  status: 'idle',
  error: null,
  result: null,
  forKey: null,
  surface: 'homo',
  iso: 0.05,
  opacity: 0.72,
  meshes: [],
  showCharges: false,
  showDipole: false,
  espRange: 0.06,
  method: 'HF/sto-3g',
}));

const decoded = new Map<string, Float32Array>();
function grid(r: QuantumResult, name: 'homo' | 'lumo' | 'density' | 'esp'): Float32Array | null {
  const b64 = r.grids[name];
  if (!b64) return null;
  const k = `${r.energy_hartree}:${name}`;
  let arr = decoded.get(k);
  if (!arr) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    arr = new Float32Array(bytes.buffer);
    decoded.set(k, arr);
  }
  return arr;
}

/** A job is only valid for the geometry it was computed on. */
export function geometryKey(): string {
  const d = studio().doc;
  const conf = d.conformers.find((c) => c.id === d.selectedConformerId) ?? d.conformers[0];
  if (!conf) return '';
  return Object.entries(conf.coordinates).map(([k, p]) => `${k}:${p.map((x) => x.toFixed(2)).join(',')}`).join('|');
}

export async function compute(): Promise<void> {
  const s = studio();
  const doc = s.doc;
  const conf = doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
  if (!conf || !doc.atoms.length) return;
  const errors = s.analysis?.validation.filter((v) => v.severity === 'error') ?? [];
  if (errors.length) {
    useOrbitals.setState({ status: 'failed', error: `Fix the structure first (${errors[0].title}).` });
    return;
  }
  const atoms = Object.entries(conf.coordinates).map(([id, p]) => {
    const el = id.includes('.') ? 'H' : doc.atoms.find((a) => a.id === id)?.element ?? 'C';
    return { id, element: el, x: p[0], y: p[1], z: p[2] };
  });
  const charge = doc.atoms.reduce((n, a) => n + a.formalCharge, 0);
  const radicals = doc.atoms.reduce((n, a) => n + (a.radicalElectrons ?? 0), 0);
  const [method, basis] = useOrbitals.getState().method.split('/');
  lastKey = geometryKey();
  const key = lastKey + `|${useOrbitals.getState().method}`;
  useOrbitals.setState({ status: 'running', error: null, result: null, meshes: [], forKey: key });
  try {
    // Hosted, the server computes inside this request (its instances can't keep background
    // work), so the submit can take as long as the calculation: up to the 5-minute limit.
    const sub = await api<{ id: string; status: string }>('/quantum/submit', { atoms, charge, multiplicity: radicals % 2 ? 2 : 1, method, basis, outputs: ['homo', 'lumo', 'density', 'esp'], spacing: atoms.length > 30 ? 0.35 : 0.28 }, { timeout: 300000 });
    if (useOrbitals.getState().forKey !== key) return; // superseded
    for (let tries = 0; tries < 400; tries++) {
      const r = await api<{ status: string; result?: QuantumResult; error?: string }>(`/quantum/${sub.id}`, undefined, { timeout: 15000 });
      if (useOrbitals.getState().forKey !== key) return; // superseded
      if (r.status === 'done' && r.result) {
        useOrbitals.setState({ status: 'done', result: r.result });
        await rebuild();
        return;
      }
      if (r.status === 'failed') {
        useOrbitals.setState({ status: 'failed', error: r.error ?? 'The calculation failed.' });
        return;
      }
      useOrbitals.setState({ status: r.status === 'running' ? 'running' : 'queued' });
      await new Promise((res) => setTimeout(res, tries < 10 ? 400 : 1200));
    }
    useOrbitals.setState({ status: 'failed', error: 'The calculation is taking too long; try a smaller basis.' });
  } catch (e) {
    useOrbitals.setState({ status: 'failed', error: (e as Error).message.includes('503') || /not available/.test((e as Error).message) ? 'Quantum jobs are not available on this server.' : `Could not run the calculation: ${(e as Error).message}` });
  }
}

/** Rebuild isosurfaces for the selected surface / isovalue. */
export async function rebuild(): Promise<void> {
  const st = useOrbitals.getState();
  const r = st.result;
  if (!r) return;
  const g = { dims: r.grid.dims, origin: r.grid.origin, spacing: r.grid.spacing };
  const meshes: SurfaceMesh[] = [];
  if (st.surface === 'homo' || st.surface === 'lumo') {
    const values = grid(r, st.surface);
    if (!values) return useOrbitals.setState({ meshes: [] });
    for (const sign of [1, -1]) {
      const m = await call<{ positions: Float32Array; normals: Float32Array }>('isosurface', { grid: { ...g, values }, iso: st.iso, sign });
      meshes.push({ key: `${st.surface}${sign}`, positions: m.positions, normals: m.normals, color: sign > 0 ? '#3b82f6' : '#f97316' });
    }
  } else {
    const rho = grid(r, 'density');
    if (!rho) return;
    const iso = st.surface === 'esp' ? 0.004 : Math.max(0.002, st.iso / 5);
    const m = await call<{ positions: Float32Array; normals: Float32Array }>('isosurface', { grid: { ...g, values: rho }, iso, sign: 1, log: true });
    const mesh: SurfaceMesh = { key: st.surface, positions: m.positions, normals: m.normals, color: '#9aa3b2' };
    if (st.surface === 'esp' && r.espGrid) {
      const esp = grid(r, 'esp');
      if (esp) mesh.colors = espColors(m.positions, esp, r.espGrid, st.espRange);
    }
    meshes.push(mesh);
  }
  useOrbitals.setState({ meshes });
}

function trilinear(values: Float32Array, dims: [number, number, number], origin: [number, number, number], h: number, x: number, y: number, z: number): number {
  const [nx, ny, nz] = dims;
  const fx = Math.min(nx - 1.001, Math.max(0, (x - origin[0]) / h));
  const fy = Math.min(ny - 1.001, Math.max(0, (y - origin[1]) / h));
  const fz = Math.min(nz - 1.001, Math.max(0, (z - origin[2]) / h));
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const u = fx - i, v = fy - j, w = fz - k;
  const at = (a: number, b: number, c: number) => values[(a * ny + b) * nz + c];
  const c00 = at(i, j, k) * (1 - u) + at(i + 1, j, k) * u;
  const c10 = at(i, j + 1, k) * (1 - u) + at(i + 1, j + 1, k) * u;
  const c01 = at(i, j, k + 1) * (1 - u) + at(i + 1, j, k + 1) * u;
  const c11 = at(i, j + 1, k + 1) * (1 - u) + at(i + 1, j + 1, k + 1) * u;
  return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
}

/** Diverging map: −range (red, electron-rich) → 0 (near-white neutral) → +range (blue, electron-poor). */
export function espColor(value: number, range: number): [number, number, number] {
  const t = Math.max(-1, Math.min(1, value / range));
  const neutral: [number, number, number] = [0.92, 0.92, 0.9];
  const neg: [number, number, number] = [0.86, 0.2, 0.18];
  const pos: [number, number, number] = [0.17, 0.38, 0.86];
  const end = t < 0 ? neg : pos;
  const a = Math.abs(t);
  return [neutral[0] + (end[0] - neutral[0]) * a, neutral[1] + (end[1] - neutral[1]) * a, neutral[2] + (end[2] - neutral[2]) * a];
}

function espColors(positions: Float32Array, esp: Float32Array, g: NonNullable<QuantumResult['espGrid']>, range: number): Float32Array {
  const out = new Float32Array(positions.length);
  for (let p = 0; p < positions.length; p += 3) {
    const v = trilinear(esp, g.dims, g.origin, g.spacing, positions[p], positions[p + 1], positions[p + 2]);
    const [r, gg, b] = espColor(v, range);
    out[p] = r;
    out[p + 1] = gg;
    out[p + 2] = b;
  }
  return out;
}

// Results belong to one geometry: drop them when the molecule or its shape changes.
let lastKey = '';
useStudio.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  const k = geometryKey();
  if (k === lastKey) return;
  lastKey = k;
  const st = useOrbitals.getState();
  if (st.result || st.meshes.length) useOrbitals.setState({ result: null, meshes: [], status: 'idle', forKey: null });
});
