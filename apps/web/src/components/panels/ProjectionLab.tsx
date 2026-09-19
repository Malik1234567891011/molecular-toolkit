'use client';
/**
 * Projection lab (spec §8): Newman ↔ sawhorse for a bond, wedge/dash ↔ Fischer for stereocentres,
 * and the chair with an animated ring flip. Every drawing is derived from the one graph + conformer,
 * so editing any view (rotate, swap two groups, flip the ring) updates all of them and the 3D model.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeChair, chairFlipFrames, chairRings, isRotatable, MolView, perceiveStereo, v3, type AtomId, type BondId, type MoleculeDocument, type StereoNeighbour, type Vec3 } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { instantGeometry, bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { call } from '@/lib/worker';
import { computeScan, currentDihedral, rotateBond } from '@/lib/conformer';
import { condensed, fischerData, idealChairDrawing, wedgeDashData, type FischerCross } from '@/lib/projections';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { loadStructure } from '@/lib/actions';
import type { Highlight } from '@/lib/types';
import { newmanData, conformationName } from './Newman';
import { EnergyCurve } from './EnergyCurve';
import { I } from '../ui/icons';

type Tab = 'newman' | 'stereo' | 'chair';

function setProjHighlights(hs: Highlight[]) {
  useStudio.setState((s) => {
    const next: Record<string, Highlight> = {};
    for (const [k, v] of Object.entries(s.highlights)) if (!k.startsWith('proj:')) next[k] = v;
    for (const h of hs) next[h.id] = h;
    return { highlights: next };
  });
}

function currentConf(doc: MoleculeDocument) {
  return doc.conformers.find((c) => c.id === doc.selectedConformerId) ?? doc.conformers[0];
}

/** A rotatable C–C bond with heavy groups on both ends, nearest the middle of the parent chain. */
function defaultBond(doc: MoleculeDocument, parent: AtomId[] | undefined): BondId | null {
  const view = new MolView(doc);
  const ok = doc.bonds.filter((b) => {
    if (!isRotatable(doc, b.id)) return false;
    const heavy = (x: AtomId, y: AtomId) => view.nbrs[view.idx(x)].some((j) => doc.atoms[j].id !== y);
    return heavy(b.a1, b.a2) && heavy(b.a2, b.a1);
  });
  if (!ok.length) return null;
  if (parent?.length) {
    const mid = (parent.length - 1) / 2;
    const scored = ok.map((b) => {
      const i = parent.indexOf(b.a1);
      const j = parent.indexOf(b.a2);
      return { b, s: i < 0 || j < 0 ? 99 : Math.abs((i + j) / 2 - mid) };
    });
    scored.sort((x, y) => x.s - y.s);
    return scored[0].b.id;
  }
  return ok[0].id;
}

export function ProjectionLab() {
  const doc = useStudio((s) => s.doc);
  const analysis = useStudio((s) => s.analysis);
  const selection = useStudio((s) => s.selection);
  const chairs = useMemo(() => chairRings(doc), [doc]);
  const centres = analysis?.stereo.centres.filter((c) => !c.needsHigherRules) ?? [];
  const initial: Tab = chairs.length ? 'chair' : centres.length ? 'stereo' : 'newman';
  const [tab, setTab] = useState<Tab>(initial);
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    track('projection_opened', {});
  }, []);
  // Pick the most useful view for each new molecule (the student's tab choice sticks within one).
  const key = analysis?.identifiers?.inchiKey ?? null;
  useEffect(() => {
    if (!analysis || seededFor.current === key) return;
    seededFor.current = key;
    setTab(initial);
  }, [analysis, key, initial]);
  // Selecting a bond or a stereocentre in 2D/3D drives the lab.
  useEffect(() => {
    if (selection.bonds.length && isRotatable(doc, selection.bonds[0])) setTab('newman');
    else if (selection.atoms.length && centres.some((c) => c.atomId === selection.atoms[0])) setTab('stereo');
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setProjHighlights([]), []);

  if (!doc.atoms.length) return <Empty text="Load or build a molecule to see its Newman, sawhorse, Fischer, wedge/dash and chair projections." />;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="projection-lab">
      <div role="tablist" aria-label="Projection" className="mx-3 mt-3 flex rounded-lg border border-border bg-panel-raised p-0.5">
        {([['newman', 'Newman · Sawhorse'], ['stereo', 'Wedge · Fischer'], ['chair', 'Chair']] as const).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} data-testid={`proj-tab-${t}`} className={`flex-1 rounded-md py-1.5 text-[12px] font-medium transition ${tab === t ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'newman' && <NewmanTab />}
        {tab === 'stereo' && <StereoTab />}
        {tab === 'chair' && <ChairTab />}
      </div>
    </div>
  );
}

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent-strong"><I.Layers size={18} /></span>
      <p className="text-[13px] leading-relaxed text-text-2">{text}</p>
      {children}
    </div>
  );
}

function Try({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5">
      {items.map(([label, smiles]) => (
        <button key={label} onClick={() => void loadStructure(smiles, label, `Load ${label}`)} className="rounded-full border border-border px-2.5 py-1 text-[12px] hover:border-accent">
          {label}
        </button>
      ))}
    </div>
  );
}

// =============================================================================================
// Newman + sawhorse

function NewmanTab() {
  const doc = useStudio((s) => s.doc);
  const analysis = useStudio((s) => s.analysis);
  const activeBond = useStudio((s) => s.activeBond);
  const selection = useStudio((s) => s.selection);
  const scan = useStudio((s) => s.scan);
  const liveEnergy = useStudio((s) => s.liveEnergy);
  const theme = useResolvedTheme();
  const picked = selection.bonds.find((b) => isRotatable(doc, b));
  const bondId = picked ?? (activeBond && isRotatable(doc, activeBond) ? activeBond : defaultBond(doc, analysis?.naming?.trace?.parent.atomIds));
  const bond = doc.bonds.find((b) => b.id === bondId);

  useEffect(() => {
    if (!bondId) return;
    useStudio.setState({ activeBond: bondId, mode3d: 'conformer' });
    if (studio().scan?.bondId !== bondId) void computeScan(bondId);
  }, [bondId]);
  useEffect(() => {
    if (!bond) return;
    setProjHighlights([{ id: 'proj:bond', atoms: [bond.a1, bond.a2], bonds: [bond.id], tone: 'accent' }]);
  }, [bond]);

  const data = useMemo(() => (bondId ? newmanData(doc, bondId) : null), [doc, bondId]);
  if (!bondId || !bond || !data) {
    return (
      <Empty text="Newman and sawhorse projections look along a single bond between two atoms that both carry groups. This molecule has no such bond — try butane or 2-bromobutane.">
        <Try items={[['butane', 'CCCC'], ['2-bromobutane', 'CC(Br)CC'], ['1,2-dichloroethane', 'ClCCCl']]} />
      </Empty>
    );
  }
  const dih = scan && scan.bondId === bondId ? currentDihedral(scan.dihedral) : null;
  const labelOf = (key: string, from: AtomId) => (key.includes('.') ? 'H' : condensed(doc, key, from));
  const locant = (id: AtomId) => analysis?.naming?.trace?.numbering.locantOf[id];
  const snap = (target: number) => {
    if (dih === null) return;
    let d = target - dih;
    d = ((d + 540) % 360) - 180;
    rotateBond(bondId, d);
    track('explanation_interaction', { kind: 'newman_snap' });
  };
  const rel = liveEnergy !== null && scan && scan.bondId === bondId ? liveEnergy - scan.e0 : null;
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-text-2">
        Looking along C{locant(bond.a1) ?? ''}→C{locant(bond.a2) ?? ''}. <b className="font-medium text-text">Drag the Newman</b> (or the ring in 3D) to rotate the back carbon — the sawhorse, 3D model and energy follow.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <figure className="rounded-xl border border-border bg-panel-raised p-1.5">
          <NewmanDraggable bondId={bondId} data={data} labelOf={labelOf} theme={theme} />
          <figcaption className="text-center text-[11px] text-text-3">Newman</figcaption>
        </figure>
        <figure className="rounded-xl border border-border bg-panel-raised p-1.5">
          <Sawhorse data={data} labelOf={labelOf} theme={theme} />
          <figcaption className="text-center text-[11px] text-text-3">Sawhorse</figcaption>
        </figure>
      </div>
      <div className="flex items-center justify-between rounded-lg bg-panel-raised px-3 py-2 text-[12.5px]" data-testid="newman-readout">
        <span>
          <span className="mono font-semibold">{dih !== null ? `${dih.toFixed(0)}°` : '—'}</span>
          <span className="ml-2 text-text-2">{dih !== null ? conformationName(dih) : ''}</span>
        </span>
        {rel !== null && <span className="mono text-text-2">{rel.toFixed(1)} kcal/mol</span>}
      </div>
      <div className="flex gap-1.5">
        {([['Anti', 180], ['Gauche', 60], ['Eclipsed', 0]] as const).map(([l, t]) => (
          <button key={l} onClick={() => snap(t)} className="flex-1 rounded-lg border border-border py-1.5 text-[12px] font-medium hover:border-accent">{l}</button>
        ))}
      </div>
      {scan && scan.bondId === bondId && (
        <EnergyCurve xs={scan.angles} ys={scan.energies} current={dih} width={330} onSeek={(x) => dih !== null && rotateBond(bondId, x - dih)} caption="Relative force-field energy (MMFF94s+, rigid rotation) — lower is more stable; not experimental" />
      )}
      <p className="text-[11.5px] leading-relaxed text-text-3">Rotating a single bond changes the conformation, not the molecule: the name and stereodescriptors stay the same.</p>
    </div>
  );
}

type NData = NonNullable<ReturnType<typeof newmanData>>;

function NewmanDraggable({ bondId, data, labelOf, theme }: { bondId: BondId; data: NData; labelOf: (key: string, from: AtomId) => string; theme: 'dark' | 'light' }) {
  const size = 160;
  const c = size / 2;
  const R = 22;
  const L = 50;
  const ref = useRef<SVGSVGElement>(null);
  const last = useRef<number | null>(null);
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const pt = (angle: number, r: number): [number, number] => [c + Math.sin((angle * Math.PI) / 180) * r, c - Math.cos((angle * Math.PI) / 180) * r];
  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };
  const doc = useStudio((s) => s.doc);
  const color = (el: string) => (el === 'H' || el === 'C' ? ink : atomColor(el, theme));
  // Convention: eclipsed back bonds are drawn a few degrees off so they are not hidden.
  const fronts = data.subs.filter((s) => s.front).map((s) => s.angle);
  const eclipsed = data.subs.some((s) => !s.front && fronts.some((f) => Math.abs(((s.angle - f + 540) % 360) - 180) < 7));
  const backAngle = (a: number) => (eclipsed ? a + 16 : a);
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${size} ${size}`}
      className="w-full cursor-grab touch-none active:cursor-grabbing"
      role="img"
      aria-label="Newman projection; drag to rotate the back carbon"
      data-testid="newman-svg"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        last.current = angleAt(e);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const a = angleAt(e);
        let d = a - last.current;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        last.current = a;
        if (Math.abs(d) > 0.2) rotateBond(bondId, d);
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
    >
      {data.subs.filter((s) => !s.front).map((s) => {
        const a = backAngle(s.angle);
        const [x1, y1] = pt(a, R);
        const [x2, y2] = pt(a, L);
        const [tx, ty] = pt(a, L + 13);
        return (
          <g key={s.key} opacity={0.8}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeWidth={2} />
            <text x={tx} y={ty} textAnchor="middle" dominantBaseline="central" fontSize={s.element === 'H' ? 10 : 11} fontWeight={600} fill={color(s.element)}>{labelOf(s.key, data.back)}</text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r={R} fill={theme === 'dark' ? '#171c28' : '#ffffff'} stroke={ink} strokeWidth={2} />
      {data.subs.filter((s) => s.front).map((s) => {
        const [x2, y2] = pt(s.angle, L);
        const [tx, ty] = pt(s.angle, L + 13);
        return (
          <g key={s.key}>
            <line x1={c} y1={c} x2={x2} y2={y2} stroke={ink} strokeWidth={2.4} />
            <text x={tx} y={ty} textAnchor="middle" dominantBaseline="central" fontSize={s.element === 'H' ? 10 : 12} fontWeight={700} fill={color(s.element)}>{labelOf(s.key, data.front)}</text>
          </g>
        );
      })}
      <circle cx={c} cy={c} r={2.5} fill={ink} />
      <title>{`Front: ${doc.atoms.find((a) => a.id === data.front)?.element}, back: ${doc.atoms.find((a) => a.id === data.back)?.element}`}</title>
    </svg>
  );
}

function Sawhorse({ data, labelOf, theme }: { data: NData; labelOf: (key: string, from: AtomId) => string; theme: 'dark' | 'light' }) {
  const size = 160;
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const front: [number, number] = [58, 100];
  const back: [number, number] = [102, 60];
  const L = 30;
  const end = (o: [number, number], a: number, r = L): [number, number] => [o[0] + Math.sin((a * Math.PI) / 180) * r, o[1] - Math.cos((a * Math.PI) / 180) * r * 0.92];
  const color = (el: string) => (el === 'H' || el === 'C' ? ink : atomColor(el, theme));
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full" role="img" aria-label="Sawhorse projection" data-testid="sawhorse-svg">
      {data.subs.filter((s) => !s.front).map((s) => {
        const [x, y] = end(back, s.angle);
        const [tx, ty] = end(back, s.angle, L + 11);
        return (
          <g key={s.key} opacity={0.8}>
            <line x1={back[0]} y1={back[1]} x2={x} y2={y} stroke={ink} strokeWidth={2} />
            <text x={tx} y={ty} textAnchor="middle" dominantBaseline="central" fontSize={10.5} fontWeight={600} fill={color(s.element)}>{labelOf(s.key, data.back)}</text>
          </g>
        );
      })}
      <line x1={front[0]} y1={front[1]} x2={back[0]} y2={back[1]} stroke={ink} strokeWidth={2.4} />
      {data.subs.filter((s) => s.front).map((s) => {
        const [x, y] = end(front, s.angle);
        const [tx, ty] = end(front, s.angle, L + 11);
        return (
          <g key={s.key}>
            <line x1={front[0]} y1={front[1]} x2={x} y2={y} stroke={ink} strokeWidth={2.4} />
            <text x={tx} y={ty} textAnchor="middle" dominantBaseline="central" fontSize={11.5} fontWeight={700} fill={color(s.element)}>{labelOf(s.key, data.front)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// =============================================================================================
// Wedge/dash + Fischer

function StereoTab() {
  const doc = useStudio((s) => s.doc);
  const analysis = useStudio((s) => s.analysis);
  const selection = useStudio((s) => s.selection);
  const theme = useResolvedTheme();
  const centres = useMemo(() => analysis?.stereo.centres.filter((c) => !c.needsHigherRules) ?? [], [analysis]);
  const [centreId, setCentreId] = useState<AtomId | null>(null);
  const [swapFrom, setSwapFrom] = useState<{ atomId: AtomId; lig: StereoNeighbour } | null>(null);
  const [turned, setTurned] = useState(false);
  const selected = selection.atoms.find((a) => centres.some((c) => c.atomId === a));
  const active = centres.find((c) => c.atomId === (selected ?? centreId)) ?? centres[0];
  const trace = analysis?.naming?.trace;
  const locant = (id: AtomId) => trace?.numbering.locantOf[id];
  const fischer = useMemo(() => fischerData(doc, trace, centres), [doc, trace, centres]);
  const wd = useMemo(() => (active ? wedgeDashData(doc, active) : null), [doc, active]);

  useEffect(() => {
    if (!active) return setProjHighlights([]);
    setProjHighlights([{ id: 'proj:centre', atoms: [active.atomId], bonds: [], tone: 'accent', pulse: true }]);
  }, [active]);

  if (!centres.length) {
    return (
      <Empty text="Wedge/dash and Fischer projections show tetrahedral stereocentres. This molecule has none — try one of these.">
        <Try items={[['(R)-2-butanol', 'C[C@@H](O)CC'], ['L-alanine', 'C[C@H](N)C(=O)O'], ['D-glyceraldehyde', 'O=C[C@H](O)CO'], ['meso-2,3-dibromobutane', 'C[C@@H](Br)[C@H](Br)C']]} />
      </Empty>
    );
  }
  const invert = (atomId: AtomId, why: string) => {
    studio().apply({ type: 'invertCentres', atomIds: [atomId] }, { label: why });
    track('explanation_interaction', { kind: 'projection_edit' });
  };
  const onLigand = (cross: FischerCross, lig: StereoNeighbour) => {
    if (!cross.stereo) return;
    if (!swapFrom || swapFrom.atomId !== cross.atomId) return setSwapFrom({ atomId: cross.atomId, lig });
    if (swapFrom.lig === lig) return setSwapFrom(null);
    const a = condensed(doc, swapFrom.lig, cross.atomId);
    const b = condensed(doc, lig, cross.atomId);
    setSwapFrom(null);
    invert(cross.atomId, `Swap ${a} and ${b} (Fischer)`);
    studio().notify({ kind: 'info', text: `Swapping any two groups inverts the centre: ${a} ↔ ${b}. Redrawn with the chain vertical.` }, 6000);
  };
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';

  return (
    <div className="space-y-4">
      {centres.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {centres.map((c) => (
            <button key={c.atomId} onClick={() => { setCentreId(c.atomId); studio().select([c.atomId]); }} className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${c.atomId === active?.atomId ? 'bg-accent text-accent-ink' : 'border border-border text-text-2'}`}>
              C{locant(c.atomId) ?? '?'} <i>{c.specified ? c.descriptor : '?'}</i>
            </button>
          ))}
        </div>
      )}
      {active && wd && (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-3">Wedge / dash · C{locant(active.atomId) ?? ''}</h3>
            <span className="text-[13px]">{active.specified ? <i className="font-semibold text-accent-strong">{active.descriptor}</i> : <span className="text-amber">not specified</span>}</span>
          </div>
          <WedgeDashSvg doc={doc} wd={wd} theme={theme} specified={active.specified} onSwap={() => invert(active.atomId, 'Swap wedge and dash')} />
          <p className="mt-1 text-[12px] leading-relaxed text-text-2">
            {active.specified
              ? `The lowest priority (4) is on the dash, pointing away, so read 1 → 2 → 3 directly: ${active.descriptor === 'R' ? 'clockwise = R' : 'counter-clockwise = S'}. Click the wedge or dash to swap them — that inverts the centre.`
              : 'This centre has no configuration yet; the drawing shows one arrangement only. Choose R or S in the inspector.'}
          </p>
        </section>
      )}
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-text-3">Fischer projection</h3>
          {fischer.ok && (
            <button onClick={() => { setTurned((t) => !t); track('explanation_interaction', { kind: 'fischer_rotate' }); }} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft">
              <I.Rotate size={12} /> Turn 180°
            </button>
          )}
        </div>
        {fischer.ok ? (
          <>
            <div className="grid place-items-center rounded-xl border border-border bg-panel-raised py-2">
              <svg
                viewBox={`0 0 220 ${24 + (fischer.crosses.length + 1) * 56}`}
                width="220"
                className="max-w-full"
                role="img"
                aria-label="Fischer projection"
                data-testid="fischer-svg"
                style={{ transform: turned ? 'rotate(180deg)' : 'none', transition: 'transform 600ms cubic-bezier(0.2,0.8,0.2,1)' }}
              >
                <FischerBody doc={doc} f={fischer} ink={ink} theme={theme} swapFrom={swapFrom} onLigand={onLigand} active={active?.atomId} turned={turned} />
              </svg>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-text-2">
              {turned
                ? 'Turned 180° in the plane: still the same molecule — a 180° turn keeps every configuration. (A 90° turn would not.)'
                : 'Vertical bonds point away from you, horizontal bonds toward you. Click two groups on one centre to swap them — any single swap inverts that centre.'}
            </p>
            {fischer.offChain.length > 0 && <p className="mt-1 text-[11.5px] text-amber">Stereocentres off the main chain are not shown in the Fischer projection.</p>}
          </>
        ) : (
          <p className="rounded-lg bg-panel-raised px-3 py-2 text-[12.5px] text-text-2">{fischer.reason}</p>
        )}
      </section>
      <button onClick={() => studio().apply({ type: 'mirror' }, { label: 'Mirror image' })} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[12.5px] font-medium hover:border-accent">
        <I.Mirror size={14} /> Make the mirror image
      </button>
    </div>
  );
}

function WedgeDashSvg({ doc, wd, theme, specified, onSwap }: { doc: MoleculeDocument; wd: NonNullable<ReturnType<typeof wedgeDashData>>; theme: 'dark' | 'light'; specified: boolean; onSwap: () => void }) {
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  const c: [number, number] = [110, 70];
  const ends: Record<string, [number, number]> = { inA: [52, 38], inB: [168, 38], wedge: [80, 124], dash: [140, 124] };
  const rank = (lig: StereoNeighbour) => wd.priorities.indexOf(lig) + 1;
  const label = (lig: StereoNeighbour) => condensed(doc, lig, wd.centre);
  const color = (lig: StereoNeighbour) => {
    const el = lig === 'H' || lig === 'LP' ? 'H' : doc.atoms.find((a) => a.id === lig)?.element ?? 'C';
    return el === 'C' || el === 'H' ? ink : atomColor(el, theme);
  };
  const slot = (k: 'inA' | 'inB' | 'wedge' | 'dash') => wd[k];
  const hashes = Array.from({ length: 7 }, (_, i) => {
    const t = (i + 1) / 8;
    const x = c[0] + (ends.dash[0] - c[0]) * t;
    const y = c[1] + (ends.dash[1] - c[1]) * t;
    const w = 1.5 + t * 6;
    return <line key={i} x1={x - w * 0.9} y1={y + w * 0.45} x2={x + w * 0.9} y2={y - w * 0.45} stroke={ink} strokeWidth={1.6} />;
  });
  const lab = (k: 'inA' | 'inB' | 'wedge' | 'dash', dx: number, dy: number) => {
    const lig = slot(k);
    const [x, y] = ends[k];
    return (
      <g key={k}>
        <text x={x + dx} y={y + dy} textAnchor="middle" dominantBaseline="central" fontSize={12.5} fontWeight={700} fill={color(lig)}>{label(lig)}</text>
        {specified && (
          <g>
            <circle cx={x + dx + (dx >= 0 ? 16 : -16)} cy={y + dy - 9} r={6.5} fill="var(--amber)" />
            <text x={x + dx + (dx >= 0 ? 16 : -16)} y={y + dy - 8.6} textAnchor="middle" dominantBaseline="central" fontSize={8.5} fontWeight={700} fill="#0b0e14">{rank(lig)}</text>
          </g>
        )}
      </g>
    );
  };
  return (
    <svg viewBox="0 0 220 150" className="w-full rounded-xl border border-border bg-panel-raised" role="img" aria-label="Wedge and dash drawing of the stereocentre" data-testid="wedge-svg">
      <line x1={c[0]} y1={c[1]} x2={ends.inA[0]} y2={ends.inA[1]} stroke={ink} strokeWidth={2.2} />
      <line x1={c[0]} y1={c[1]} x2={ends.inB[0]} y2={ends.inB[1]} stroke={ink} strokeWidth={2.2} />
      <g role="button" aria-label="Swap wedge and dash" onClick={onSwap} className="cursor-pointer">
        <polygon points={`${c[0]},${c[1]} ${ends.wedge[0] - 6},${ends.wedge[1] - 2} ${ends.wedge[0] + 6},${ends.wedge[1] + 2}`} fill={ink} />
        {hashes}
        <rect x={60} y={80} width={100} height={46} fill="transparent" />
      </g>
      {lab('inA', -14, -8)}
      {lab('inB', 14, -8)}
      {lab('wedge', -6, 14)}
      {lab('dash', 6, 14)}
    </svg>
  );
}

function FischerBody({ doc, f, ink, theme, swapFrom, onLigand, active, turned, hideDescriptors }: {
  doc: MoleculeDocument; f: ReturnType<typeof fischerData>; ink: string; theme: 'dark' | 'light';
  swapFrom: { atomId: AtomId; lig: StereoNeighbour } | null; onLigand: (c: FischerCross, l: StereoNeighbour) => void; active?: AtomId; turned: boolean; hideDescriptors?: boolean;
}) {
  const x0 = 110;
  const y0 = 30;
  const step = 56;
  const colorOf = (lig: StereoNeighbour) => {
    const el = lig === 'H' || lig === 'LP' ? 'H' : doc.atoms.find((a) => a.id === lig)?.element ?? 'C';
    return el === 'C' || el === 'H' ? ink : atomColor(el, theme);
  };
  const upright = turned ? 'rotate(180)' : undefined;
  const text = (x: number, y: number, s: string, fill: string, weight = 700, key?: string) => (
    <text key={key} x={0} y={0} transform={`translate(${x} ${y})${upright ? ` ${upright}` : ''}`} textAnchor="middle" dominantBaseline="central" fontSize={12.5} fontWeight={weight} fill={fill}>{s}</text>
  );
  const bottomY = y0 + (f.crosses.length + 1) * step - step / 2;
  return (
    <g>
      <line x1={x0} y1={y0 + 10} x2={x0} y2={bottomY - 10} stroke={ink} strokeWidth={2} />
      {text(x0, y0, f.top ?? '', ink)}
      {f.crosses.map((cr, k) => {
        const y = y0 + (k + 1) * step - step / 2 + 6;
        const sel = (lig: StereoNeighbour) => swapFrom?.atomId === cr.atomId && swapFrom.lig === lig;
        const side = (lig: StereoNeighbour, x: number, anchor: 'end' | 'start') => (
          <g role={cr.stereo ? 'button' : undefined} aria-label={cr.stereo ? `Select ${condensed(doc, lig, cr.atomId)} to swap` : undefined} onClick={() => onLigand(cr, lig)} className={cr.stereo ? 'cursor-pointer' : ''}>
            <rect x={anchor === 'end' ? x - 50 : x} y={y - 12} width={50} height={24} rx={6} fill={sel(lig) ? 'var(--accent-soft)' : 'transparent'} stroke={sel(lig) ? 'var(--accent)' : 'none'} />
            {text(anchor === 'end' ? x - 24 : x + 24, y, condensed(doc, lig, cr.atomId), colorOf(lig))}
          </g>
        );
        return (
          <g key={cr.atomId}>
            <line x1={x0 - 44} y1={y} x2={x0 + 44} y2={y} stroke={ink} strokeWidth={2} />
            {cr.atomId === active && <circle cx={x0} cy={y} r={5} fill="var(--accent)" />}
            {side(cr.left, x0 - 46, 'end')}
            {side(cr.right, x0 + 46, 'start')}
            {cr.stereo && !hideDescriptors && (
              <g transform={`translate(${x0 + 12} ${y - 12})`}>
                <text x={0} y={0} transform={upright} textAnchor="middle" dominantBaseline="central" fontSize={10} fontStyle="italic" fontWeight={600} fill={cr.specified ? 'var(--accent-strong)' : 'var(--amber)'}>{cr.specified ? cr.descriptor : '?'}</text>
              </g>
            )}
          </g>
        );
      })}
      {text(x0, bottomY, f.bottom ?? '', ink)}
    </g>
  );
}

// =============================================================================================
// Chair + ring flip

function ChairTab() {
  const doc = useStudio((s) => s.doc);
  const analysis = useStudio((s) => s.analysis);
  const showH = useStudio((s) => s.settings.showHydrogens);
  const reduced = useStudio((s) => s.settings.motion === 'reduced');
  const theme = useResolvedTheme();
  const rings = useMemo(() => chairRings(doc), [doc]);
  const [ringIdx, setRingIdx] = useState(0);
  const [stage, setStage] = useState<string | null>(null);
  const [energies, setEnergies] = useState<{ before: number; after: number; bigAxialBefore: boolean } | null>(null);
  const flipping = useRef(false);
  const sideViewRef = useRef<() => void>(() => undefined);
  const viewedRing = useRef<string | null>(null);
  const ring = rings[Math.min(ringIdx, rings.length - 1)];
  const conf = currentConf(doc);
  const chair = useMemo(() => (ring && conf ? analyzeChair(doc, conf.coordinates, ring) : null), [doc, ring, conf]);
  const trace = analysis?.naming?.trace;

  // ax/eq labels on the 3D model (heavy groups always; hydrogens when shown).
  useEffect(() => {
    if (!chair) return setProjHighlights([]);
    const labels: Record<string, string> = {};
    for (const subs of Object.values(chair.substituents)) for (const s of subs) if (s.element !== 'H' || showH) labels[s.key] = s.position === 'axial' ? 'ax' : 'eq';
    setProjHighlights([
      { id: 'proj:ring', atoms: chair.ring, bonds: doc.bonds.filter((b) => chair.ring.includes(b.a1) && chair.ring.includes(b.a2)).map((b) => b.id), tone: 'faint' },
      { id: 'proj:axeq', atoms: [], bonds: [], tone: 'accent', labels },
    ]);
  }, [chair, showH, doc.bonds]);

  useEffect(() => bus.on('canvas:ready', () => { if (chair?.isChair) sideViewRef.current(); }), [chair?.isChair]);
  useEffect(() => {
    const key = ring?.join(',') ?? null;
    if (!key || !chair?.isChair || viewedRing.current === key) return;
    const t = setTimeout(() => {
      viewedRing.current = key;
      sideViewRef.current();
    }, 80);
    return () => clearTimeout(t);
  }, [ring, chair]);

  if (!ring) {
    return (
      <Empty text="The chair view needs a saturated six-membered ring (not fused). Try one of these:">
        <Try items={[['cyclohexane', 'C1CCCCC1'], ['methylcyclohexane', 'CC1CCCCC1'], ['tert-butylcyclohexane', 'CC(C)(C)C1CCCCC1'], ['cis-1,2-dimethyl', 'C[C@H]1CCCC[C@H]1C'], ['menthol', 'CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O']]} />
      </Empty>
    );
  }

  const flip = async () => {
    if (flipping.current || !conf) return;
    const result = chairFlipFrames(doc, conf.coordinates, ring);
    if (!result) {
      studio().notify({ kind: 'warning', text: 'This ring cannot be flipped on its own (a substituent loops back into the ring system).' });
      return;
    }
    flipping.current = true;
    track('explanation_interaction', { kind: 'chair_flip' });
    const heavyAxialBefore = chair ? Object.values(chair.substituents).flat().some((s) => s.element !== 'H' && s.position === 'axial') : false;
    const before = conf.energy ?? (await call<number>('energy', { doc: { ...doc, conformers: [] }, coords: conf.coordinates }).catch(() => NaN));
    const { frames, stages } = result;
    const version = studio().version;
    const dur = reduced ? 0 : 1600;
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (studio().version !== version) return resolve();
        const t = dur ? Math.min(1, (performance.now() - t0) / dur) : 1;
        const k = Math.round(t * (frames.length - 1));
        instantGeometry(200);
        studio().setConformer({ ...conf, coordinates: frames[k], converged: false, method: `${conf.method.replace(/ \(.*\)$/, '')} (ring flip, not minimized)` }, 'relaxed', '');
        setStage(stages[k]);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
    try {
      const d = studio().doc;
      const r = await call<{ coords: Record<string, [number, number, number]>; energy: number; converged: boolean; method: string }>('relax', { doc: { ...d, conformers: [] }, coords: frames[frames.length - 1], maxIts: 1200 });
      if (studio().version === version) {
        studio().setConformer({ id: conf.id, coordinates: r.coords, method: r.method, energy: r.energy, converged: r.converged }, 'relaxed', '');
        if (Number.isFinite(before)) setEnergies({ before, after: r.energy, bigAxialBefore: heavyAxialBefore });
      }
    } catch {
      /* keep the unminimized flipped chair */
    }
    setStage(null);
    flipping.current = false;
  };

  const drawing = idealChairDrawing(54);
  const sideView = () => {
    if (!chair || !conf || !mapping) return bus.emit('fit', 'orient');
    // Camera in front of the drawing's front edge (positions 1–2), slightly above, normal up.
    const pos = ring.map((a) => conf.coordinates[a]);
    const mid = v3.scale(v3.add(pos[mapping.map[1]], pos[mapping.map[2]]), 0.5);
    let f = v3.sub(mid, chair.centre);
    f = v3.norm(v3.sub(f, v3.scale(chair.normal, v3.dot(f, chair.normal))));
    const el = (12 * Math.PI) / 180;
    const dir = v3.add(v3.scale(f, Math.cos(el)), v3.scale(chair.normal, Math.sin(el)));
    bus.emit('fit', { dir, up: chair.normal });
  };
  sideViewRef.current = sideView;
  // Map drawing positions onto ring atoms so up/down carbons agree with the model.
  const mapping = chair && conf ? mapChair(chair.z, drawing.up, trace?.numbering.locantOf, ring, ring.map((a) => conf.coordinates[a]), chair.normal) : null;
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  // Fit the viewBox to the drawing (ring, bonds and room for labels) so nothing is clipped.
  const allPts = [...drawing.ring, ...drawing.axial, ...drawing.equatorial];
  const minX = Math.min(...allPts.map((p) => p[0])) - 34;
  const maxX = Math.max(...allPts.map((p) => p[0])) + 34;
  const minY = Math.min(...allPts.map((p) => p[1])) - 14;
  const maxY = Math.max(...allPts.map((p) => p[1])) + 14;
  const P = (p: [number, number]): [number, number] => [p[0] - minX, p[1] - minY];
  const ringCentre = drawing.ring.reduce<[number, number]>((c, p) => [c[0] + p[0] / 6, c[1] + p[1] / 6], [0, 0]);
  const label = (key: string, ringAtom: AtomId) => (key.includes('.') ? 'H' : condensed(doc, key, ringAtom));
  const colorOf = (el: string) => (el === 'H' ? 'var(--text-3)' : el === 'C' ? ink : atomColor(el, theme));

  return (
    <div className="space-y-3">
      {rings.length > 1 && (
        <div className="flex gap-1">
          {rings.map((_, k) => (
            <button key={k} onClick={() => setRingIdx(k)} className={`rounded-md px-2 py-0.5 text-[12px] ${k === ringIdx ? 'bg-accent text-accent-ink' : 'border border-border'}`}>Ring {k + 1}</button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-border bg-panel-raised p-1">
        {chair?.isChair && mapping ? (
          <svg viewBox={`0 0 ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}`} className="w-full" role="img" aria-label="Chair drawing with axial and equatorial positions" data-testid="chair-svg">
            {drawing.ring.map((p, k) => {
              const q = drawing.ring[(k + 1) % 6];
              const [x1, y1] = P(p);
              const [x2, y2] = P(q);
              return <line key={`r${k}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ink} strokeWidth={2.4} strokeLinecap="round" />;
            })}
            {drawing.ring.map((p, k) => {
              const atom = ring[mapping.map[k]];
              const subs = chair.substituents[atom] ?? [];
              const ax = subs.find((s) => s.position === 'axial');
              const eq = subs.find((s) => s.position === 'equatorial' && s !== ax) ?? subs.find((s) => s !== ax);
              const [cx, cy] = P(p);
              const [axx, axy] = P(drawing.axial[k]);
              const [eqx, eqy] = P(drawing.equatorial[k]);
              const put = (s: typeof ax, x: number, y: number, dx: number, dy: number, anchor: 'start' | 'middle' | 'end') =>
                s ? (
                  <g>
                    <line x1={cx} y1={cy} x2={x} y2={y} stroke={s.element === 'H' ? 'var(--text-3)' : ink} strokeWidth={s.element === 'H' ? 1.3 : 2} />
                    <text x={x + dx} y={y + dy} textAnchor={anchor} dominantBaseline="central" fontSize={s.element === 'H' ? 10 : 12} fontWeight={s.element === 'H' ? 500 : 700} fill={colorOf(s.element)}>{label(s.key, atom)}</text>
                  </g>
                ) : null;
              const up = drawing.up[k] > 0;
              return (
                <g key={`s${k}`}>
                  {put(ax, axx, axy, 0, up ? -8 : 8, 'middle')}
                  {put(eq, eqx, eqy, eqx < cx ? -3 : 3, 0, eqx < cx ? 'end' : 'start')}
                  {mapping.locants[k] && (() => {
                    // Ring numbers sit just inside the ring, clear of every bond.
                    const [rx, ry] = P(ringCentre);
                    const d = Math.hypot(rx - cx, ry - cy) || 1;
                    return <text x={cx + ((rx - cx) / d) * 12} y={cy + ((ry - cy) / d) * 9} textAnchor="middle" dominantBaseline="central" fontSize={9.5} fontWeight={700} fill="var(--text-2)" stroke="var(--panel-raised)" strokeWidth={3.5} style={{ paintOrder: 'stroke' }}>{mapping.locants[k]}</text>;
                  })()}
                </g>
              );
            })}
          </svg>
        ) : (
          <p className="px-3 py-6 text-center text-[12.5px] text-text-2">
            {stage ? `Flipping… ${stage}` : 'The ring is not in a chair right now (it may be mid-edit or a twist-boat). Press Relax in the 3D toolbar to minimize it.'}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => void flip()} disabled={!!stage} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-60" data-testid="ring-flip">
          <I.Rotate size={15} /> {stage ? stage : 'Ring flip'}
        </button>
        <button onClick={sideView} className="rounded-lg border border-border px-3 py-2 text-[12.5px] hover:border-accent" title="Side-on view matching the drawing" aria-label="Side-on view matching the drawing">
          <I.Focus size={15} />
        </button>
      </div>
      <p className="text-[12px] leading-relaxed text-text-2">
        Axial bonds point straight up or down; equatorial bonds point outward around the ring. A ring flip passes through half-chair and twist-boat shapes and swaps <b className="font-medium text-text">every</b> axial group with its equatorial partner — each group stays on its own face, so cis/trans and R/S never change.
      </p>
      {energies && (
        <div className="rounded-lg border border-border bg-panel-raised px-3 py-2 text-[12.5px]" data-testid="chair-energy">
          <div className="flex justify-between"><span className="text-text-2">Before the flip</span><span className="mono">{energies.before.toFixed(1)} kcal/mol</span></div>
          <div className="flex justify-between"><span className="text-text-2">After the flip</span><span className="mono">{energies.after.toFixed(1)} kcal/mol</span></div>
          <p className="mt-1 text-text-2">
            {Math.abs(energies.after - energies.before) < 0.3
              ? 'Both chairs are essentially equal in energy.'
              : `The ${energies.after < energies.before ? 'new' : 'original'} chair is lower by ${Math.abs(energies.after - energies.before).toFixed(1)} kcal/mol — typically the one with the larger group equatorial, avoiding 1,3-diaxial strain.`}
          </p>
          <p className="mt-0.5 text-[11px] text-text-3">MMFF94s+ total energies, gas phase — relative model values, not experimental.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Map drawing position k → ring index so up/down carbons agree with the model and the ring runs
 * the same way round (a rotation, never a mirror image of the molecule).
 */
function mapChair(z: number[], up: number[], locantOf: Record<string, string> | undefined, ring: AtomId[], pos: Vec3[], normal: Vec3): { map: number[]; locants: Array<string | undefined> } | null {
  let best: number[] | null = null;
  let bestScore = -1;
  for (const dir of [1, -1]) {
    for (let o = 0; o < 6; o++) {
      const map = up.map((_, k) => (((o + dir * k) % 6) + 6) % 6);
      if (!map.every((r, k) => Math.sign(z[r]) === up[k])) continue;
      // The drawing runs counter-clockwise seen from above (+normal); so must the model.
      const [p0, p1, p2] = [pos[map[0]], pos[map[1]], pos[map[2]]];
      const turn = v3.dot(v3.cross(v3.sub(p1, p0), v3.sub(p2, p1)), normal);
      if (turn <= 0) continue;
      // Prefer C1 at a tip of the chair.
      const c1 = locantOf ? map.findIndex((r) => locantOf[ring[r]] === '1') : -1;
      const score = c1 === 0 || c1 === 3 ? 2 : 0;
      if (score > bestScore) {
        bestScore = score;
        best = map;
      }
    }
  }
  if (!best) return null;
  return { map: best, locants: best.map((r) => locantOf?.[ring[r]]) };
}

/** Read-only Fischer projection of any document (practice: "which projection is this?"). */
export function FischerView({ doc, trace }: { doc: MoleculeDocument; trace: import('@orbital/chem').naming.NamingTrace }) {
  const theme = useResolvedTheme();
  const centres = useMemo(() => perceiveStereo(doc).centres.filter((c) => !c.needsHigherRules), [doc]);
  const f = useMemo(() => fischerData(doc, trace, centres), [doc, trace, centres]);
  if (!f.ok) return <p className="text-[12px] text-text-2">{f.reason}</p>;
  const ink = theme === 'dark' ? '#dfe3ea' : '#1b1e24';
  return (
    <svg viewBox={`0 0 220 ${24 + (f.crosses.length + 1) * 56}`} className="w-full" role="img" aria-label="Fischer projection">
      <FischerBody doc={doc} f={f} ink={ink} theme={theme} swapFrom={null} onLigand={() => undefined} turned={false} hideDescriptors />
    </svg>
  );
}
