'use client';
/** Unlisted, immutable share snapshots (spec §14/§20) and AR asset hosting. */
import type { MoleculeDocument } from '@orbital/chem';
import { api } from './api';
import { track } from './analytics';
import { studio } from './store';

export interface ShareSnapshot {
  doc: MoleculeDocument;
  name?: string;
  provenance?: string;
  formula?: string;
  smiles?: string;
  createdWith: string;
}

const cache = new Map<string, string>();

export async function createShare(): Promise<{ id: string; url: string; embed: string }> {
  const s = studio();
  const doc = { ...s.doc, provenance: [] };
  const key = JSON.stringify([doc.atoms, doc.bonds, doc.conformers[0]?.coordinates]);
  let id = cache.get(key);
  if (!id) {
    const snapshot: ShareSnapshot = {
      doc,
      name: s.verification?.primary?.name ?? s.analysis?.naming?.name,
      provenance: s.verification?.primary?.provenance,
      formula: s.analysis?.formula.formula,
      smiles: s.analysis?.identifiers?.canonicalSmiles,
      createdWith: 'Orbital',
    };
    const r = await api<{ id: string }>('/shares', { title: doc.title ?? snapshot.name ?? null, snapshot });
    id = r.id;
    cache.set(key, id);
    track('molecule_shared', {});
  }
  return { id, url: `${location.origin}/s/${id}`, embed: `${location.origin}/embed/${id}` };
}

export async function loadShare(id: string): Promise<{ title: string | null; snapshot: ShareSnapshot }> {
  return api(`/shares/${encodeURIComponent(id)}`);
}

export async function uploadArAsset(bytes: ArrayBuffer | Uint8Array, ext: 'usdz' | 'glb'): Promise<string> {
  const res = await fetch(`/api/v1/ar-assets?ext=${ext}`, { method: 'POST', body: bytes as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  const j = (await res.json()) as { url: string };
  return new URL(j.url, location.origin).href;
}

export type ArPlatform = 'webxr' | 'quicklook' | 'sceneviewer' | 'desktop';

export async function detectAr(): Promise<ArPlatform> {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return 'quicklook';
  const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
  try {
    if (xr && (await xr.isSessionSupported('immersive-ar'))) return 'webxr';
  } catch {
    /* not supported */
  }
  if (/Android/.test(ua)) return 'sceneviewer';
  return 'desktop';
}

export function sceneViewerIntent(glbUrl: string, title: string): string {
  const params = `file=${encodeURIComponent(glbUrl)}&mode=ar_preferred&title=${encodeURIComponent(title)}`;
  return `intent://arvr.google.com/scene-viewer/1.0?${params}#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(location.href)};end;`;
}
