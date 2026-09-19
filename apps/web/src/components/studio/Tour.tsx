'use client';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { TOUR, advanceTour, endTour, useTour } from '@/lib/tour';
import { I } from '../ui/icons';

type Rect = { x: number; y: number; w: number; h: number };

/** Spotlight + card for the 60-second tour. Never blocks the UI: the student does each step for real. */
export function Tour() {
  const step = useTour((s) => s.step);
  const [rect, setRect] = useState<Rect | null>(null);
  const current = step !== null && step < TOUR.length ? TOUR[step] : null;

  useEffect(() => {
    if (!current || step === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (timer || !current.done()) return;
      timer = setTimeout(() => advanceTour(step), 450);
    };
    check();
    const unsub = useStudio.subscribe(check);
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [current, step]);

  useLayoutEffect(() => {
    if (!current) return;
    const measure = () => {
      const el = document.querySelector(current.target);
      const r = el?.getBoundingClientRect();
      setRect(r && r.width ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
    };
    measure();
    const t = setInterval(measure, 300);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, [current]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endTour(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  if (step === null) return null;
  if (!current) {
    return (
      <div className="fixed bottom-6 left-1/2 z-[70] w-[380px] max-w-[92vw] -translate-x-1/2" role="dialog" aria-label="Tour complete" data-testid="tour-done">
        <div className="glass fade-up rounded-2xl p-4">
          <div className="text-[15px] font-semibold">That’s the loop: build → see → name.</div>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">Everything else is one keystroke away — press <kbd className="mono rounded border border-border px-1">⌘K</kbd> for every command, or type any name in the search box.</p>
          <button onClick={() => endTour(true)} className="mt-3 w-full rounded-lg bg-accent py-2 text-[13px] font-semibold text-accent-ink" data-testid="tour-finish">Start exploring</button>
        </div>
      </div>
    );
  }
  const big = rect && rect.w > 400;
  // Card: over large targets (the canvas) it sits at the top; next to small ones (buttons) below them.
  const cardW = 340;
  const vw = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const left = rect ? (big ? rect.x + rect.w / 2 - cardW / 2 : Math.min(vw - cardW - 12, Math.max(12, rect.x + rect.w / 2 - cardW / 2))) : vw / 2 - cardW / 2;
  const top = rect ? (big ? rect.y + 20 : rect.y + rect.h + 14) : 80;
  return (
    <>
      {rect && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[65] rounded-xl transition-all duration-300"
          style={{ left: rect.x - 4, top: rect.y - 4, width: rect.w + 8, height: rect.h + 8, boxShadow: big ? 'inset 0 0 0 2px var(--accent)' : '0 0 0 2px var(--accent), 0 0 0 9999px rgba(8,10,16,0.35)' }}
        />
      )}
      <div className="fixed z-[70]" style={{ left, top, width: cardW, maxWidth: '92vw' }} role="dialog" aria-live="polite" aria-label={`Tour step ${step + 1} of ${TOUR.length}: ${current.title}`} data-testid="tour-card">
        <div className="glass fade-up rounded-2xl p-4" key={current.id}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-strong">Step {step + 1} of {TOUR.length} · 60-second tour</span>
            <button onClick={() => endTour(false)} className="text-[12px] text-text-3 hover:text-text" data-testid="tour-skip">Skip</button>
          </div>
          <div className="text-[15px] font-semibold">{current.title}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">{current.body}</p>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex gap-1" aria-hidden>
              {TOUR.map((t, k) => (
                <span key={t.id} className={`h-1.5 w-6 rounded-full ${k < step ? 'bg-accent' : k === step ? 'bg-accent/60' : 'bg-border'}`} />
              ))}
            </div>
            <button onClick={() => advanceTour()} className="flex items-center gap-1 text-[12.5px] text-text-2 hover:text-text" data-testid="tour-next">
              Next <I.ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
