'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { loadShare, detectAr, sceneViewerIntent, uploadArAsset, type ArPlatform, type ShareSnapshot } from '@/lib/share';
import { exportGLB, exportUSDZ } from '@/lib/export3d';
import { useApplyTheme, useResolvedTheme } from '@/lib/useTheme';
import { track } from '@/lib/analytics';
import { ProvenanceBadge } from '../naming/ProvenanceBadge';
import type { Provenance } from '@/lib/types';

const formula = (f: string) => f.replace(/\d/g, (d) => '₀₁₂₃₄₅₆₇₈₉'[+d]);

const Viewer = dynamic(() => import('../three/Viewer').then((m) => m.Viewer), { ssr: false });
const ARView = dynamic(() => import('../three/ARView'), { ssr: false });

export function ShareView({ id, embed = false, arFirst = false }: { id: string; embed?: boolean; arFirst?: boolean }) {
  useApplyTheme();
  const theme = useResolvedTheme();
  const [snap, setSnap] = useState<ShareSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [platform, setPlatform] = useState<ArPlatform | null>(null);
  const [arHref, setArHref] = useState<string | null>(null);
  const [webxr, setWebxr] = useState(false);
  useEffect(() => {
    loadShare(id).then((r) => setSnap(r.snapshot)).catch((e) => setErr((e as Error).message));
    void detectAr().then(setPlatform);
  }, [id]);
  useEffect(() => {
    if (!snap || (platform !== 'quicklook' && platform !== 'sceneviewer')) return;
    void (async () => {
      try {
        if (platform === 'quicklook') setArHref(await uploadArAsset(await exportUSDZ(snap.doc, 'light'), 'usdz'));
        else setArHref(sceneViewerIntent(await uploadArAsset(await exportGLB(snap.doc, 'light'), 'glb'), snap.name ?? 'molecule'));
      } catch {
        /* AR button stays hidden */
      }
    })();
  }, [snap, platform]);

  if (err) {
    return (
      <main className="canvas-bg grid min-h-dvh place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-[15px]">{err}</p>
          <a href="/" className="text-accent-strong underline">Open Orbital</a>
        </div>
      </main>
    );
  }
  const arButton =
    platform === 'webxr' ? (
      <button onClick={() => setWebxr(true)} className="rounded-xl bg-accent px-4 py-2 text-[14px] font-semibold text-accent-ink" data-testid="share-ar">See it on your desk (AR)</button>
    ) : arHref ? (
      <a rel={platform === 'quicklook' ? 'ar' : undefined} href={arHref} onClick={() => track('ar_opened', { platform: platform ?? '' })} className="rounded-xl bg-accent px-4 py-2 text-[14px] font-semibold text-accent-ink" data-testid="share-ar">
        {platform === 'quicklook' && <img src="/icon.svg" alt="" width={1} height={1} className="hidden" />}
        See it on your desk (AR)
      </a>
    ) : null;

  if (embed) {
    return (
      <main className="canvas-bg relative h-dvh w-full overflow-hidden" data-testid="embed-view">
        {snap && <Viewer doc={snap.doc} theme={theme} />}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-3">
          <div className="pointer-events-auto glass rounded-xl px-3 py-1.5">
            <div className="nomen text-[14px] font-semibold">{snap?.name ?? '…'}</div>
            {snap?.formula && <div className="text-[11.5px] text-text-2">{formula(snap.formula)}</div>}
          </div>
          <a href={`/s/${id}`} target="_blank" rel="noreferrer" className="pointer-events-auto glass rounded-xl px-3 py-1.5 text-[12px] font-medium text-accent-strong">Open in Orbital ↗</a>
        </div>
      </main>
    );
  }

  return (
    <main className="canvas-bg flex min-h-dvh flex-col" data-testid="share-view">
      {webxr && snap && <ARView doc={snap.doc} onClose={() => setWebxr(false)} />}
      <header className="flex items-center justify-between px-4 py-3">
        <a href="/" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden>
            <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="var(--text-3)" strokeWidth="1.4" transform="rotate(-28 16 16)" />
            <circle cx="16" cy="16" r="6" fill="#8b7cff" />
            <circle cx="27" cy="10.5" r="2.2" fill="var(--text)" />
          </svg>
          Orbital
        </a>
        <span className="text-[12px] text-text-3">Shared molecule · read-only snapshot</span>
      </header>
      <div className="relative min-h-[55vh] flex-1">
        <div className="absolute inset-0">{snap ? <Viewer doc={snap.doc} theme={theme} /> : <div className="grid h-full place-items-center text-text-3">Loading…</div>}</div>
      </div>
      <section className="mx-auto w-full max-w-[720px] space-y-3 px-4 pb-8 pt-2 text-center">
        {snap && (
          <>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <h1 className="nomen text-[26px] font-semibold tracking-tight" data-testid="share-name">{snap.name ?? 'Unnamed structure'}</h1>
              {snap.provenance && <ProvenanceBadge p={snap.provenance as Provenance} />}
            </div>
            {snap.formula && <p className="text-[14px] text-text-2">{formula(snap.formula)}{snap.smiles ? <span className="mono ml-2 text-[12px] text-text-3">{snap.smiles}</span> : null}</p>}
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {arFirst ? arButton : null}
              <a href={`/?open=${encodeURIComponent(id)}`} className="rounded-xl border border-border px-4 py-2 text-[14px] font-medium hover:border-accent" data-testid="open-in-studio">Open in the studio</a>
              {!arFirst ? arButton : null}
            </div>
            {platform === 'desktop' && <p className="text-[12px] text-text-3">Open this page on a phone to place the molecule on your desk in AR.</p>}
          </>
        )}
      </section>
    </main>
  );
}
