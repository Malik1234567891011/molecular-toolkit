'use client';
/**
 * Scan a structure (spec §12): photo → proposed atoms/bonds over the photo → the student checks
 * and corrects every low-confidence item → accept. Human confirmation is mandatory. The photo is
 * sent once for recognition and never stored; "Trace it myself" keeps it entirely on-device.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { computeFormula, parseMolfile, prettyFormula, validateDocument } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { bus } from '@/lib/events';
import { api, tryApi, type Health } from '@/lib/api';
import { track } from '@/lib/analytics';
import { loadStructure } from '@/lib/actions';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { I } from '../ui/icons';
import { alignToInk, applyInk, settleOnInk } from '@/lib/ink-align';

interface SAtom { symbol: string; x: number; y: number; charge: number; confidence: number; deleted?: boolean }
interface SBond { a: number; b: number; order: 1 | 2 | 3; stereo: 'none' | 'wedge' | 'hash' | 'wavy'; confidence: number; deleted?: boolean }
interface Recognition { atoms: SAtom[]; bonds: SBond[]; notes?: string; engine: string; image: { width: number; height: number }; warnings?: string[]; readerName?: string | null; altSmiles?: string | null }

const ELEMENTS = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I'];
const LOW = 0.75;

function toMolfile(r: Recognition): string {
  const atoms = r.atoms.map((a, i) => ({ ...a, i })).filter((a) => !a.deleted);
  const index = new Map(atoms.map((a, k) => [a.i, k + 1]));
  const bonds = r.bonds.filter((b) => !b.deleted && index.has(b.a) && index.has(b.b));
  const scale = 40 / Math.max(r.image.width, r.image.height);
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const lines = ['Scanned structure', '  Orbital', '', `${pad(atoms.length, 3)}${pad(bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`];
  for (const a of atoms) {
    const x = (a.x * r.image.width * scale).toFixed(4);
    const y = (-a.y * r.image.height * scale).toFixed(4);
    const chg = a.charge === 0 ? 0 : 4 - a.charge;
    lines.push(`${pad(x, 10)}${pad(y, 10)}${pad('0.0000', 10)} ${a.symbol.padEnd(3)} 0${pad(chg, 3)}  0  0  0  0  0  0  0  0  0  0`);
  }
  for (const b of bonds) {
    const st = b.stereo === 'wedge' ? 1 : b.stereo === 'hash' ? 6 : b.stereo === 'wavy' ? 4 : 0;
    lines.push(`${pad(index.get(b.a)!, 3)}${pad(index.get(b.b)!, 3)}${pad(b.order, 3)}${pad(st, 3)}`);
  }
  lines.push('M  END');
  return lines.join('\n');
}

export function ScanDialog() {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<{ url: string; w: number; h: number } | null>(null);
  const [rec, setRec] = useState<Recognition | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cap, setCap] = useState<Health['capabilities']['ocsr'] | null>(null);
  const [edits, setEdits] = useState(0);
  const [picker, setPicker] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => bus.on('open:scan', () => {
    setOpen(true);
    track('scan_started', {});
  }), []);
  useEffect(() => {
    if (!open) return;
    void tryApi<Health>('/health').then((h) => setCap(h?.capabilities.ocsr ?? { available: false, reason: 'offline' }));
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) void take(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    setImage(null);
    setRec(null);
    setErr(null);
    setEdits(0);
    setPicker(null);
  };
  const close = () => {
    setOpen(false);
    reset();
  };

  /** Downscale on-device (max 1600 px) before anything leaves the browser. */
  const take = async (f: File) => {
    reset();
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    setImage({ url: c.toDataURL('image/jpeg', 0.9), w: c.width, h: c.height });
  };

  const recognize = async () => {
    if (!image) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<Recognition & { found?: boolean; atoms: Array<SAtom & { index: number }>; bonds: SBond[] }>('/structures/recognize-image', { image: image.url }, { timeout: 180000 });
      if (r.found === false || !r.atoms.length) {
        setErr(`No structure could be read${r.notes ? ` (${r.notes})` : ''}. Try a tighter crop, or trace it yourself.`);
      } else {
        const atoms = r.atoms.map((a) => ({ symbol: a.symbol ?? 'C', x: a.x, y: a.y, charge: a.charge ?? 0, confidence: a.confidence ?? 0.5 }));
        const bonds = r.bonds.map((b) => ({ ...b, order: (b.order ?? 1) as 1 | 2 | 3, stereo: b.stereo ?? 'none', confidence: b.confidence ?? 0.5 }));
        // The reader places atoms roughly; snap the overlay onto the ink it describes.
        const t = await alignToInk(image.url, atoms, bonds).catch(() => null);
        const placed = t ? await settleOnInk(image.url, applyInk(atoms, t), bonds).catch(() => applyInk(atoms, t)) : atoms;
        setRec({ engine: r.engine, notes: r.notes, warnings: r.warnings ?? [], readerName: r.readerName ?? null, altSmiles: r.altSmiles ?? null, image: r.image, atoms: placed, bonds });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const trace = () => {
    if (!image) return;
    // World units: fit the photo ~14 bond lengths wide around the origin.
    const w = 14;
    const h = (w * image.h) / image.w;
    useStudio.setState({ underlay: { url: image.url, x: -w / 2, y: -h / 2, w, h, opacity: 0.45 }, view: 'split', tool2d: 'draw', landing: false });
    close();
  };

  const check = useMemo(() => {
    if (!rec) return null;
    try {
      const doc = parseMolfile(toMolfile(rec)).doc;
      const issues = validateDocument(doc).filter((v) => v.severity === 'error');
      const f = computeFormula(doc);
      return { ok: !issues.length, issues, formula: prettyFormula(f.counts, f.charge) };
    } catch (e) {
      return { ok: false, issues: [{ title: (e as Error).message }] };
    }
  }, [rec]);

  const accept = async () => {
    if (!rec) return;
    track(edits ? 'scan_correction_required' : 'scan_accepted', { edits });
    if (edits) track('scan_accepted', { edits });
    const ok = await loadStructure(toMolfile(rec), 'Scanned structure', 'Load scanned structure');
    if (ok) close();
  };

  const edit = (f: (r: Recognition) => Recognition) => {
    setRec((r) => (r ? f(structuredClone(r)) : r));
    setEdits((n) => n + 1);
  };

  if (!open) return null;
  const lowCount = rec ? rec.atoms.filter((a) => !a.deleted && a.confidence < LOW).length + rec.bonds.filter((b) => !b.deleted && b.confidence < LOW).length : 0;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 p-4" onClick={close} role="presentation">
      <div className="glass fade-up flex max-h-[90vh] w-full max-w-[760px] flex-col rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Scan a structure" data-testid="scan-dialog">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[14px] font-semibold">Scan a structure</h2>
          <button onClick={close} aria-label="Close" className="rounded-md p-1 text-text-3 hover:text-text"><I.X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!image ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f?.type.startsWith('image/')) void take(f);
              }}
              className="grid place-items-center gap-3 rounded-2xl border-2 border-dashed border-border px-6 py-12 text-center"
            >
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-accent-soft text-accent-strong"><I.Camera size={22} /></span>
              <p className="text-[14px] font-medium">Photograph or drop a drawn structure</p>
              <p className="max-w-[420px] text-[12.5px] text-text-2">Textbook figures and handwriting both work best cropped to one molecule. You can also paste an image (⌘V).</p>
              <button onClick={() => file.current?.click()} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink" data-testid="scan-pick">Choose photo</button>
              <input ref={file} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} data-testid="scan-file" />
              <p className="text-[11px] text-text-3">Photos are never stored. Recognition sends the image once; tracing keeps it on your device.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Sized to the photo (capped at half the screen) so the overlay stays on it and the
                  Accept / Trace buttons stay in view. */}
              <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl border border-border bg-white" data-testid="scan-overlay">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.url} alt="Your photo" className="block max-h-[48vh] w-auto max-w-full" style={{ opacity: rec ? 0.55 : 1 }} />
                {rec && (
                  <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                    {rec.bonds.map((b, k) => {
                      if (b.deleted || rec.atoms[b.a]?.deleted || rec.atoms[b.b]?.deleted) return null;
                      const p = rec.atoms[b.a];
                      const q = rec.atoms[b.b];
                      if (!p || !q) return null;
                      const low = b.confidence < LOW;
                      const [x1, y1, x2, y2] = [p.x * 1000, p.y * 1000, q.x * 1000, q.y * 1000];
                      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
                      const nx = (-(y2 - y1) / len) * 7;
                      const ny = ((x2 - x1) / len) * 7;
                      const lanes = b.order === 1 ? [0] : b.order === 2 ? [-0.6, 0.6] : [-1, 0, 1];
                      return (
                        <g key={k} className="cursor-pointer" onClick={() => edit((r) => { const x = r.bonds[k]; x.order = (x.order === 3 ? 1 : x.order + 1) as 1 | 2 | 3; x.confidence = 1; return r; })} onContextMenu={(e) => { e.preventDefault(); edit((r) => { r.bonds[k].deleted = true; return r; }); }}>
                          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={26} />
                          {lanes.map((l) => (
                            <line key={l} x1={x1 + nx * l} y1={y1 + ny * l} x2={x2 + nx * l} y2={y2 + ny * l} stroke={low ? '#f2b34c' : '#6b5cf0'} strokeWidth={b.stereo === 'wedge' ? 9 : 5} strokeDasharray={b.stereo === 'hash' ? '4 5' : undefined} strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={0.9} />
                          ))}
                        </g>
                      );
                    })}
                    {rec.atoms.map((a, k) => {
                      if (a.deleted) return null;
                      const low = a.confidence < LOW;
                      return (
                        <g key={k} transform={`translate(${a.x * 1000} ${a.y * 1000})`} className="cursor-pointer" onClick={() => setPicker(k)}>
                          <ellipse rx={22} ry={22 * (rec.image.width / rec.image.height)} fill={low ? '#fff4dc' : '#ffffff'} stroke={low ? '#f2b34c' : '#6b5cf0'} strokeWidth={3} vectorEffect="non-scaling-stroke" />
                          <text textAnchor="middle" dominantBaseline="central" fontSize={26} fontWeight={700} fill={atomColor(a.symbol, 'light')} transform={`scale(1 ${rec.image.width / rec.image.height})`}>{a.symbol}{a.charge ? (a.charge > 0 ? '+' : '−') : ''}</text>
                        </g>
                      );
                    })}
                  </svg>
                )}
                {picker !== null && rec && (
                  <div className="glass absolute left-1/2 top-3 flex -translate-x-1/2 flex-wrap items-center gap-1 rounded-xl p-1.5" role="menu" aria-label="Change atom">
                    {ELEMENTS.map((el) => (
                      <button key={el} onClick={() => { edit((r) => { r.atoms[picker].symbol = el; r.atoms[picker].confidence = 1; return r; }); setPicker(null); }} className="h-8 min-w-8 rounded-lg px-1.5 text-[13px] font-semibold hover:bg-accent-soft" style={{ color: atomColor(el, theme) }}>{el}</button>
                    ))}
                    <button onClick={() => { edit((r) => { r.atoms[picker].charge = r.atoms[picker].charge >= 1 ? -1 : r.atoms[picker].charge + 1; return r; }); setPicker(null); }} className="h-8 rounded-lg px-2 text-[12px] hover:bg-accent-soft">±</button>
                    <button onClick={() => { edit((r) => { r.atoms[picker].confidence = 1; return r; }); setPicker(null); }} className="h-8 rounded-lg px-2 text-[12px] text-good hover:bg-good-soft">Looks right</button>
                    <button onClick={() => { edit((r) => { r.atoms[picker].deleted = true; return r; }); setPicker(null); }} className="h-8 rounded-lg px-2 text-[12px] text-danger hover:bg-danger-soft">Delete</button>
                    <button onClick={() => setPicker(null)} className="h-8 rounded-lg px-2 text-[12px] text-text-3">Cancel</button>
                  </div>
                )}
              </div>
              {!rec ? (
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void recognize()} disabled={busy || !cap?.available} className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-50" data-testid="scan-recognize">
                    <I.Scan size={15} /> {busy ? 'Reading the structure…' : 'Recognize'}
                  </button>
                  <button onClick={trace} className="rounded-xl border border-border px-4 py-2 text-[13px] hover:border-accent" data-testid="scan-trace">Trace it myself</button>
                  <button onClick={reset} className="rounded-xl px-3 py-2 text-[13px] text-text-2 hover:text-text">Choose another</button>
                  {cap && !cap.available && <p className="w-full text-[12px] text-text-3">Automatic recognition isn&apos;t available on this server ({cap.reason}). Tracing works anywhere.</p>}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className={`rounded-xl border px-3 py-2 text-[12.5px] ${lowCount || (rec.warnings?.length && !edits) ? 'border-amber/50 bg-amber-soft' : 'border-good/40 bg-good-soft'}`} data-testid="scan-status">
                    <b className="font-semibold">
                      {rec.warnings?.length && !edits
                        ? 'Check this reading carefully — the reader disagrees with itself.'
                        : lowCount
                          ? `Check ${lowCount} highlighted item${lowCount > 1 ? 's' : ''}.`
                          : edits
                            ? 'Your corrections are applied — compare once more with your photo.'
                            : 'Everything was read with high confidence — still, compare it with your photo.'}
                    </b>{' '}
                    Tap an atom to change it, tap a bond to change its order, right-click (long-press) a bond to delete it.
                    {!edits && rec.warnings?.length ? (
                      <ul className="list-disc space-y-0.5 pl-4 pt-1 text-text">
                        {rec.warnings.map((w) => <li key={w}>{w}</li>)}
                      </ul>
                    ) : null}
                    {!edits && rec.altSmiles && (
                      <button
                        onClick={() => { track('scan_accepted', { via: 'alternative-reading' }); void loadStructure(rec.altSmiles!, rec.readerName ?? 'Scanned structure', 'Load scanned structure').then((ok) => ok && close()); }}
                        className="mt-2 rounded-lg border border-amber/60 px-2.5 py-1 text-[12.5px] font-medium hover:bg-amber-soft"
                        data-testid="scan-alternative"
                      >
                        Use the reader&apos;s other reading{rec.readerName ? ` (${rec.readerName})` : ''} instead
                      </button>
                    )}
                    {check?.formula && <span className="block pt-1 text-text-2">This reading is <b className="font-semibold text-text">{check.formula}</b>{rec.readerName ? <> · the reader thinks it is <i>{rec.readerName}</i></> : null}.</span>}
                    {rec.notes && <span className="block pt-1 text-text-2">Reader’s note: {rec.notes}</span>}
                  </div>
                  {check && !check.ok && <p className="text-[12.5px] text-danger">Not a valid structure yet: {check.issues[0].title}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => void accept()} disabled={!check?.ok} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-50" data-testid="scan-accept">Accept and open</button>
                    <button onClick={trace} className="rounded-xl border border-border px-4 py-2 text-[13px] hover:border-accent">Trace instead</button>
                    <span className="text-[11px] text-text-3">{rec.engine === 'vision' ? 'Read by a multimodal AI model' : 'Read by MolScribe'} · probabilistic · you confirm</span>
                  </div>
                </div>
              )}
              {err && <p className="text-[12.5px] text-danger">{err}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
