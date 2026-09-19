'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { writeMolfileV2000, writeMolfileV3000, writeSdf } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { download } from '@/lib/account';
import { call } from '@/lib/worker';
import { copyImage, recordGif, recordVideo, snapshot, snapshotTransparent } from '@/lib/capture';
import { exportGLB, exportGLTF, exportSTL, exportUSDZ } from '@/lib/export3d';
import { createShare, detectAr, sceneViewerIntent, uploadArAsset, type ArPlatform } from '@/lib/share';
import { useResolvedTheme } from '@/lib/useTheme';
import { I } from '../ui/icons';

const ARView = dynamic(() => import('../three/ARView'), { ssr: false });

type Tab = 'share' | 'export' | 'ar';

export function ShareDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('share');
  const [ar, setAr] = useState(false);
  const doc = useStudio((s) => s.doc);
  useEffect(() => {
    const a = bus.on('open:share', (t) => {
      setTab((t as Tab) ?? 'share');
      setOpen(true);
    });
    const b = bus.on('open:ar', () => {
      setTab('ar');
      setOpen(true);
    });
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open]);
  if (ar) return <ARView doc={doc} onClose={() => setAr(false)} />;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" onClick={() => setOpen(false)} role="presentation">
      <div className="glass fade-up w-full max-w-[520px] rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Share, export or view in AR" data-testid="share-dialog">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div role="tablist" className="flex gap-1">
            {(['share', 'export', 'ar'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1 text-[13px] font-medium ${tab === t ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text'}`} data-testid={`share-tab-${t}`}>
                {t === 'ar' ? 'AR' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-text-3 hover:text-text"><I.X size={16} /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">
          {!doc.atoms.length ? (
            <p className="text-[13px] text-text-2">Build or load a molecule first.</p>
          ) : tab === 'share' ? (
            <SharePane />
          ) : tab === 'export' ? (
            <ExportPane />
          ) : (
            <ArPane onWebXR={() => { setOpen(false); setAr(true); }} />
          )}
        </div>
      </div>
    </div>
  );
}

function useShareLink() {
  const [link, setLink] = useState<{ id: string; url: string; embed: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const version = useStudio((s) => s.version);
  useEffect(() => {
    setLink(null);
    setErr(null);
    createShare().then(setLink).catch((e) => setErr(`Could not create a link: ${(e as Error).message}. Share links need the network.`));
  }, [version]);
  return { link, err };
}

function Qr({ text, size = 132 }: { text: string; size?: number }) {
  const [svg, setSvg] = useState<string>('');
  useEffect(() => {
    void Promise.all([import('lean-qr'), import('lean-qr/extras/svg')]).then(([{ generate }, { toSvgSource }]) => {
      const code = generate(text);
      setSvg(toSvgSource(code, { on: '#0b0e14', off: '#ffffff', pad: 2, width: size, height: size, xmlDeclaration: false }));
    });
  }, [text, size]);
  return <div className="shrink-0 overflow-hidden rounded-lg bg-white p-1" style={{ width: size + 8, height: size + 8 }} dangerouslySetInnerHTML={{ __html: svg }} aria-label="QR code" role="img" />;
}

/** A QR code for a localhost URL can never open on a phone; say so rather than let it fail. */
function LocalOnlyNote() {
  const local = typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  if (!local) return null;
  return <p className="text-[12px] leading-snug text-amber">This link points at <span className="mono">localhost</span>, which only this computer can open. To use it on a phone, open Orbital from your computer&apos;s network address (or deploy it) and share again.</p>;
}

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex gap-1.5">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label={label} className="mono min-w-0 flex-1 rounded-lg border border-border bg-panel-raised px-2 py-1.5 text-[12px]" />
      <button
        onClick={() => void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 text-[12px] hover:border-accent"
      >
        {done ? <I.Check size={13} /> : <I.Copy size={13} />} {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function SharePane() {
  const { link, err } = useShareLink();
  const name = useStudio((s) => s.verification?.primary?.name ?? s.analysis?.naming?.name);
  if (err) return <p className="text-[13px] text-danger">{err}</p>;
  if (!link) return <p className="text-[13px] text-text-3">Creating a link…</p>;
  const iframe = `<iframe src="${link.embed}" width="480" height="360" style="border:0;border-radius:12px" title="${name ?? 'Molecule'} — Orbital" loading="lazy" allow="xr-spatial-tracking"></iframe>`;
  return (
    <div className="space-y-3" data-testid="share-pane">
      <div className="flex gap-3">
        <Qr text={link.url} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[13px] leading-relaxed text-text-2">
            An <b className="font-medium text-text">unlisted, read-only snapshot</b> of {name ? <span className="nomen">{name}</span> : 'this molecule'}. Later edits don&apos;t change it. Anyone with the link can open it in 3D, in AR, or in their own studio.
          </p>
          <Copy value={link.url} label="Share link" />
          <LocalOnlyNote />
        </div>
      </div>
      <div className="space-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Embed in notes or an LMS</span>
        <Copy value={iframe} label="Embed code" />
      </div>
    </div>
  );
}

function ExportPane() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const theme = useResolvedTheme();
  const base = () => (studio().verification?.primary?.name ?? studio().analysis?.naming?.name ?? studio().doc.title ?? 'molecule').replace(/[^\w\-(),]+/g, '_').slice(0, 60);
  const run = (label: string, f: () => Promise<void>) => async () => {
    setBusy(label);
    setMsg(null);
    try {
      await f();
      track('molecule_exported', { format: label });
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const conf = () => {
    const d = studio().doc;
    return d.conformers.find((c) => c.id === d.selectedConformerId) ?? d.conformers[0];
  };
  const ids = useStudio((s) => s.analysis?.identifiers);
  const groups: Array<{ title: string; items: Array<{ label: string; sub: string; run: () => Promise<void> }> }> = [
    {
      title: 'Images & animation',
      items: [
        { label: 'PNG', sub: 'as shown, retina', run: async () => download(`${base()}.png`, await snapshot(), 'image/png') },
        { label: 'PNG transparent', sub: 'for slides', run: async () => download(`${base()}-transparent.png`, await snapshotTransparent(2), 'image/png') },
        { label: 'Copy image', sub: 'to clipboard', run: async () => { await copyImage(); setMsg('Image copied — paste it into your notes or slides.'); } },
        { label: '2D SVG', sub: 'skeletal drawing', run: async () => download(`${base()}.svg`, await call<string>('svg', { doc: { ...studio().doc, conformers: [] }, width: 600, height: 440, dark: false }), 'image/svg+xml') },
        { label: 'GIF', sub: 'rotating, 3 s', run: async () => download(`${base()}.gif`, await recordGif({ background: theme === 'dark' ? '#0e121a' : '#f6f4ef' }), 'image/gif') },
        { label: 'Video', sub: 'rotating, 5 s', run: async () => { const v = await recordVideo(); download(`${base()}.${v.ext}`, v.blob, v.blob.type); } },
      ],
    },
    {
      title: 'Chemistry files',
      items: [
        { label: 'Molfile V3000', sub: '.mol with 3D coordinates', run: async () => download(`${base()}.mol`, writeMolfileV3000(studio().doc, { conformer: conf(), includeHydrogens: true }), 'chemical/x-mdl-molfile') },
        { label: 'Molfile V2000', sub: '.mol, widest support', run: async () => download(`${base()}-v2000.mol`, writeMolfileV2000(studio().doc, { conformer: conf(), includeHydrogens: true }), 'chemical/x-mdl-molfile') },
        { label: 'SDF', sub: '3D + name + SMILES', run: async () => download(`${base()}.sdf`, writeSdf([{ doc: studio().doc, conformer: conf(), props: { NAME: studio().verification?.primary?.name ?? '', SMILES: ids?.canonicalSmiles ?? '', INCHIKEY: ids?.inchiKey ?? '' } }]), 'chemical/x-mdl-sdfile') },
      ],
    },
    {
      title: '3D models',
      items: [
        { label: 'GLB', sub: 'AR & 3D apps (real scale)', run: async () => download(`${base()}.glb`, await exportGLB(studio().doc, 'light'), 'model/gltf-binary') },
        { label: 'glTF', sub: 'text glTF 2.0', run: async () => download(`${base()}.gltf`, await exportGLTF(studio().doc, 'light'), 'model/gltf+json') },
        { label: 'STL', sub: '3D printing (1 Å = 10 mm)', run: async () => download(`${base()}.stl`, await exportSTL(studio().doc), 'model/stl') },
        { label: 'USDZ', sub: 'iPhone / iPad AR', run: async () => download(`${base()}.usdz`, (await exportUSDZ(studio().doc, 'light')) as Uint8Array<ArrayBuffer>, 'model/vnd.usdz+zip') },
      ],
    },
  ];
  return (
    <div className="space-y-4" data-testid="export-pane">
      {groups.map((g) => (
        <section key={g.title}>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">{g.title}</h3>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {g.items.map((it) => (
              <button key={it.label} onClick={run(it.label, it.run)} disabled={!!busy} className="rounded-xl border border-border px-2.5 py-2 text-left hover:border-accent disabled:opacity-50" data-testid={`export-${it.label.replace(/\s+/g, '-').toLowerCase()}`}>
                <span className="block text-[13px] font-medium">{busy === it.label ? 'Working…' : it.label}</span>
                <span className="block text-[11px] text-text-3">{it.sub}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {ids && (
        <section className="space-y-1.5">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Identifiers</h3>
          <Copy value={ids.canonicalSmiles ?? ids.smiles} label="SMILES" />
          {ids.inchi && <Copy value={ids.inchi} label="InChI" />}
          {ids.inchiKey && <Copy value={ids.inchiKey} label="InChIKey" />}
        </section>
      )}
      {msg && <p className="text-[12.5px] text-text-2">{msg}</p>}
    </div>
  );
}

function ArPane({ onWebXR }: { onWebXR: () => void }) {
  const [platform, setPlatform] = useState<ArPlatform | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { link } = useShareLink();
  const name = useStudio((s) => s.verification?.primary?.name ?? s.analysis?.naming?.name ?? 'molecule');
  useEffect(() => {
    void detectAr().then(setPlatform);
  }, []);
  useEffect(() => {
    if (platform !== 'quicklook' && platform !== 'sceneviewer') return;
    setHref(null);
    void (async () => {
      try {
        if (platform === 'quicklook') setHref(await uploadArAsset(await exportUSDZ(studio().doc, 'light'), 'usdz'));
        else setHref(sceneViewerIntent(await uploadArAsset(await exportGLB(studio().doc, 'light'), 'glb'), name));
      } catch (e) {
        setErr((e as Error).message);
      }
    })();
  }, [platform, name]);
  if (!platform) return <p className="text-[13px] text-text-3">Checking what this device supports…</p>;
  return (
    <div className="space-y-3" data-testid="ar-pane">
      <p className="text-[13px] leading-relaxed text-text-2">Stand the molecule on your desk at model-kit scale (1 Å ≈ 2.5 cm) and walk around it. No app to install.</p>
      {platform === 'webxr' && (
        <button onClick={() => { track('ar_opened', { platform }); onWebXR(); }} className="w-full rounded-xl bg-accent py-2.5 text-[14px] font-semibold text-accent-ink">Open AR view</button>
      )}
      {(platform === 'quicklook' || platform === 'sceneviewer') &&
        (href ? (
          platform === 'quicklook' ? (
            <a rel="ar" href={href} onClick={() => track('ar_opened', { platform })} className="block rounded-xl bg-accent py-2.5 text-center text-[14px] font-semibold text-accent-ink">
              {/* Quick Look requires an <img> child inside the rel="ar" link. */}
              <img src="/icon.svg" alt="" width={1} height={1} className="hidden" />
              View in AR
            </a>
          ) : (
            <a href={href} onClick={() => track('ar_opened', { platform })} className="block rounded-xl bg-accent py-2.5 text-center text-[14px] font-semibold text-accent-ink">View in AR</a>
          )
        ) : err ? (
          <p className="text-[13px] text-danger">{err}</p>
        ) : (
          <p className="text-[13px] text-text-3">Preparing the 3D model…</p>
        ))}
      {platform === 'desktop' && (
        <div className="flex items-center gap-3">
          {link ? <Qr text={`${link.url}?ar=1`} /> : <div className="h-[140px] w-[140px] animate-pulse rounded-lg bg-panel-raised" />}
          <div className="min-w-0 space-y-2">
            <p className="text-[13px] leading-relaxed text-text-2">This computer can&apos;t do AR. Scan the code with your phone&apos;s camera — the molecule opens there, ready to place on your desk.</p>
            <LocalOnlyNote />
          </div>
        </div>
      )}
    </div>
  );
}
