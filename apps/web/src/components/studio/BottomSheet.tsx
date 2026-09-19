'use client';
import { useEffect, useRef, useState } from 'react';
import { prettyFormula } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { useIsMobile } from '@/lib/useMobile';
import { PanelBody, TITLES } from './SidePanel';
import { I } from '../ui/icons';

type Snap = 'peek' | 'half' | 'full';
export const PEEK = 60;

/** The inspector on phones (spec §6): a three-height bottom sheet — peek, half, full. */
export function BottomSheet() {
  const mobile = useIsMobile();
  const panel = useStudio((s) => s.panel);
  const name = useStudio((s) => s.verification?.primary?.name ?? s.analysis?.naming?.name);
  const formula = useStudio((s) => s.analysis?.formula);
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  const [snap, setSnap] = useState<Snap>('peek');
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const [vh, setVh] = useState(800);

  useEffect(() => {
    const on = () => setVh(window.innerHeight);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // Opening a tool from the menu brings the sheet up; going back to the inspector keeps the height.
  const prevPanel = useRef(panel);
  useEffect(() => {
    if (panel !== prevPanel.current && panel !== 'facts') setSnap((s) => (s === 'peek' ? 'half' : s));
    prevPanel.current = panel;
  }, [panel]);

  if (!mobile) return null;
  const heights: Record<Snap, number> = { peek: PEEK, half: Math.round(vh * 0.52), full: vh - 64 };
  const height = drag ?? heights[snap];
  const cycle = () => setSnap((s) => (s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek'));

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: heights[snap], moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const dy = s.y - e.clientY;
    if (Math.abs(dy) > 6) s.moved = true;
    if (s.moved) setDrag(Math.max(PEEK, Math.min(heights.full, s.h + dy)));
  };
  const onUp = () => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    if (!s.moved) {
      cycle();
      return;
    }
    const h = drag ?? s.h;
    const nearest = (Object.keys(heights) as Snap[]).reduce((a, b) => (Math.abs(heights[b] - h) < Math.abs(heights[a] - h) ? b : a));
    setSnap(nearest);
    setDrag(null);
  };

  const summary = panel === 'facts' ? (hasMol ? [name, formula ? prettyFormula(formula.counts, formula.charge) : null].filter(Boolean).join(' · ') : 'Type a name or draw a molecule') : null;
  return (
    <section
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-border bg-panel-solid shadow-[0_-8px_30px_rgba(0,0,0,0.25)]"
      style={{ height, transition: drag === null ? 'height 220ms cubic-bezier(0.2,0.8,0.2,1)' : 'none', paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label={TITLES[panel]}
      data-testid="bottom-sheet"
      data-snap={snap}
    >
      <div
        className="flex h-[60px] shrink-0 touch-none select-none flex-col items-stretch px-4 pt-1.5"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <button className="mx-auto mb-1.5 h-1.5 w-10 rounded-full bg-border-strong" aria-label={`Panel height: ${snap}. Tap to change.`} onClick={(e) => e.preventDefault()} data-testid="sheet-handle" />
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[13.5px] font-semibold">{TITLES[panel]}</h2>
            {summary && <p className="truncate text-[12px] text-text-2">{summary}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={cycle} className="rounded-md p-1.5 text-text-3" aria-label={snap === 'full' ? 'Collapse panel' : 'Expand panel'}>
              {snap === 'full' ? <I.ChevronDown size={16} /> : <I.ChevronDown size={16} className="rotate-180" />}
            </button>
            {panel !== 'facts' && (
              <button onClick={() => useStudio.setState({ panel: 'facts' })} className="rounded-md p-1.5 text-text-3" aria-label="Back to inspector">
                <I.X size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-hidden={snap === 'peek' && drag === null}>
        <PanelBody panel={panel} />
      </div>
    </section>
  );
}
