'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { useStudio, studio, type Mode3D, type RenderStyle } from '@/lib/store';
import { bus } from '@/lib/events';
import { cleanLayout, relaxCurrent } from '@/lib/pipeline';
import { usePracticeHidesName } from '@/lib/practice';
import { RoomCursors } from './RoomCursors';
import { I } from '../ui/icons';

const KitCanvas = dynamic(() => import('../three/KitCanvas'), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-text-3">Loading 3D…</div> });
const Canvas2D = dynamic(() => import('../two/Canvas2D'), { ssr: false });

function ToolButton({ active, onClick, title, children }: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} aria-pressed={active} className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium transition ${active ? 'bg-accent text-accent-ink' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`}>
      {children}
    </button>
  );
}

function Toolbar3D() {
  const mode = useStudio((s) => s.mode3d);
  const style = useStudio((s) => s.renderStyle);
  const showH = useStudio((s) => s.settings.showHydrogens);
  const labels = useStudio((s) => s.settings.showLabels);
  const geometry = useStudio((s) => s.geometry);
  const setMode = (m: Mode3D) => useStudio.setState({ mode3d: m, measure: [], activeBond: m === 'conformer' ? studio().activeBond : null });
  const styles: Array<{ v: RenderStyle; label: string }> = [
    { v: 'kit', label: 'Model kit' },
    { v: 'licorice', label: 'Sticks' },
    { v: 'spacefill', label: 'Space-filling' },
    { v: 'geometry', label: 'Geometry' },
    { v: 'stereo', label: 'Stereo' },
  ];
  return (
    <div className="glass pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-0.5 rounded-2xl p-1" role="toolbar" aria-label="3D tools">
      <ToolButton active={mode === 'build'} onClick={() => setMode('build')} title="Build: drag from a hydrogen port to add atoms">
        <I.Plus size={15} /> <span className="hidden sm:inline">Build</span>
      </ToolButton>
      <ToolButton active={mode === 'conformer'} onClick={() => setMode('conformer')} title="Conformer: rotate single bonds">
        <I.Rotate size={15} /> <span className="hidden sm:inline">Conformer</span>
      </ToolButton>
      <ToolButton active={mode === 'measure'} onClick={() => setMode('measure')} title="Measure (M): click 2–4 atoms">
        <I.Ruler size={15} /> <span className="hidden sm:inline">Measure</span>
      </ToolButton>
      <div className="mx-1 h-5 w-px bg-border" />
      <select value={style} onChange={(e) => useStudio.setState({ renderStyle: e.target.value as RenderStyle })} className="h-8 rounded-lg bg-transparent px-1.5 text-[12.5px] text-text-2 hover:bg-panel-raised" aria-label="Render style">
        {styles.map((s) => (
          <option key={s.v} value={s.v}>{s.label}</option>
        ))}
      </select>
      <ToolButton active={showH} onClick={() => studio().setSettings({ showHydrogens: !showH })} title="Toggle hydrogens (H)">
        H
      </ToolButton>
      <ToolButton active={labels} onClick={() => studio().setSettings({ showLabels: !labels })} title="Atom labels">
        Aa
      </ToolButton>
      <ToolButton onClick={() => bus.emit('fit')} title="Center & fit (Space)">
        <I.Focus size={15} />
      </ToolButton>
      <ToolButton onClick={() => relaxCurrent()} title="Relax: minimize from the current shape (force field)">
        <I.Sparkle size={15} /> <span className="hidden md:inline">{geometry === 'relaxing' ? 'Relaxing…' : 'Relax'}</span>
      </ToolButton>
    </div>
  );
}

function Toolbar2D() {
  const underlay = useStudio((s) => s.underlay);
  return (
    <div className="glass pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1" role="toolbar" aria-label="2D tools">
      {underlay && (
        <div className="flex items-center gap-1.5 border-r border-border pl-2 pr-2 text-[12px] text-text-2" data-testid="underlay-controls">
          <I.Camera size={14} />
          <input type="range" min={0.1} max={0.9} step={0.05} value={underlay.opacity} onChange={(e) => useStudio.setState({ underlay: { ...underlay, opacity: Number(e.target.value) } })} className="w-20 accent-[var(--accent)]" aria-label="Photo opacity" />
          <button onClick={() => useStudio.setState({ underlay: null })} className="rounded-md px-1 hover:text-text" title="Remove the photo">
            <I.X size={13} />
          </button>
        </div>
      )}
      <ToolButton onClick={() => void cleanLayout()} title="Clean up the 2D layout">
        <I.Wand size={15} /> Clean up
      </ToolButton>
      <ToolButton onClick={() => bus.emit('fit')} title="Fit to view">
        <I.Focus size={15} />
      </ToolButton>
      <ToolButton onClick={() => studio().setSettings({ showLonePairs: !studio().settings.showLonePairs })} title="Show lone pairs">
        ⁚
      </ToolButton>
    </div>
  );
}

function StatusStrip() {
  const a = useStudio((s) => s.analysis);
  const doc = useStudio((s) => s.doc);
  const mode = useStudio((s) => s.mode3d);
  const view = useStudio((s) => s.view);
  const hidden = usePracticeHidesName();
  if (!doc.atoms.length) return null;
  const errors = a?.validation.filter((v) => v.severity === 'error') ?? [];
  const warns = a?.validation.filter((v) => v.severity === 'warning') ?? [];
  const hint =
    view !== '2d' && mode === 'build'
      ? 'Click an atom to see its ports · drag from a port (hydrogen) to add an atom'
      : mode === 'conformer'
        ? 'Click a single bond, then drag the ring to rotate it'
        : mode === 'measure'
          ? 'Click 2 atoms for a distance, 3 for an angle, 4 for a dihedral'
          : 'Drag from an atom to draw a bond · click a bond to change its order';
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-panel px-3 py-1 text-[12px] text-text-2 backdrop-blur" role="status">
      {errors.length > 0 ? (
        <span className="flex items-center gap-1 text-danger"><I.Alert size={13} /> {errors.length} valence problem{errors.length > 1 ? 's' : ''}</span>
      ) : warns.length > 0 ? (
        <span className="flex items-center gap-1 text-amber"><I.Info size={13} /> {warns[0].title}</span>
      ) : (
        <span className="flex items-center gap-1 text-good"><I.Check size={13} /> valid</span>
      )}
      <span className="hidden md:inline">{hint}</span>
      {a?.naming?.ok && !hidden && (
        <button onClick={() => useStudio.setState({ panel: 'explain', explainStep: 0 })} className="flex items-center gap-1 font-medium text-accent-strong hover:underline" data-testid="explain-trigger">
          <I.Lightbulb size={13} /> Explain name
        </button>
      )}
    </div>
  );
}

export function CanvasArea() {
  const view = useStudio((s) => s.view);
  const [split, setSplit] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !box.current) return;
      const r = box.current.getBoundingClientRect();
      setSplit(Math.max(0.2, Math.min(0.8, (e.clientX - r.left) / r.width)));
    };
    const up = () => (dragging.current = false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);
  return (
    <div
      ref={box}
      className="canvas-bg relative flex min-h-0 min-w-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
      data-testid="canvas-area"
      tabIndex={0}
      role="application"
      aria-roledescription="molecule canvas"
      aria-label="Molecule canvas. Arrow keys move between atoms, Enter bonds a new atom, 1 2 3 set bond order, Delete removes, question mark lists every shortcut."
    >
      {(view === '2d' || view === 'split') && (
        <div className="relative h-full min-w-0 shrink-0 overflow-hidden" style={{ width: view === 'split' ? `${split * 100}%` : '100%' }}>
          <Canvas2D />
          <div className="pointer-events-none absolute bottom-3 left-3 flex">
            <Toolbar2D />
          </div>
          {view === 'split' && <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-panel px-1.5 py-0.5 text-[11px] text-text-3">2D</div>}
        </div>
      )}
      {view === 'split' && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize split view"
          tabIndex={0}
          onPointerDown={() => (dragging.current = true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0.2, s - 0.05));
            if (e.key === 'ArrowRight') setSplit((s) => Math.min(0.8, s + 0.05));
          }}
          className="z-10 w-1.5 cursor-col-resize bg-border hover:bg-accent"
        />
      )}
      {(view === '3d' || view === 'split') && (
        <div className="relative h-full min-w-0 flex-1 overflow-hidden">
          <KitCanvas />
          {view === 'split' && <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-panel px-1.5 py-0.5 text-[11px] text-text-3">3D</div>}
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
            <Toolbar3D />
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2">
        <StatusStrip />
      </div>
      <RoomCursors container={box} />
    </div>
  );
}
