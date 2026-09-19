'use client';
/**
 * The skippable 60-second tour (spec §5): place an atom, draw a bond, toggle 3D, name it. Each
 * step completes itself when the student does the thing — "Next" is only a fallback.
 */
import { create } from 'zustand';
import { emptyDocument } from '@orbital/chem';
import { studio, useStudio } from './store';
import { track } from './analytics';

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selector of the element to spotlight. */
  target: string;
  done: () => boolean;
  enter?: () => void;
}

export const TOUR: TourStep[] = [
  {
    id: 'place',
    title: 'Place an atom',
    body: 'Click anywhere on the canvas to drop a carbon. Pick another element from the rail on the left first if you like.',
    target: '[data-testid=canvas-area]',
    done: () => studio().doc.atoms.length >= 1,
    enter: () => {
      const s = studio();
      if (s.doc.atoms.length) s.replace(emptyDocument(), 'Start the tour (undo brings your molecule back)');
      useStudio.setState({ landing: false, view: '2d', tool2d: 'draw', panel: 'facts', armedElement: 'C' });
    },
  },
  {
    id: 'bond',
    title: 'Draw a bond',
    body: 'Drag outward from your atom — or just click it — to add a bonded carbon. Hydrogens fill in automatically.',
    target: '[data-testid=canvas-area]',
    done: () => studio().doc.bonds.length >= 1,
  },
  {
    id: '3d',
    title: 'Toggle 3D',
    body: 'Switch to 3D: the same molecule, built with real bond angles and relaxed to its lowest-energy shape.',
    target: '[data-tour=view-3d]',
    done: () => studio().view !== '2d',
  },
  {
    id: 'name',
    title: 'Name it',
    body: 'Open Explain to see the IUPAC name built step by step — parent, numbering, substituents — each step lit up on the model.',
    target: '[data-tour=panel-explain]',
    done: () => studio().panel === 'explain',
  },
];

interface TourState {
  step: number | null;
  startedAt: number;
}

export const useTour = create<TourState>(() => ({ step: null, startedAt: 0 }));

export function startTour(): void {
  useTour.setState({ step: 0, startedAt: Date.now() });
  TOUR[0].enter?.();
  track('tour_started', {});
}

/** Advance past `from` (default: the current step). Idempotent, so late timers can't skip steps. */
export function advanceTour(from?: number): void {
  const { step } = useTour.getState();
  if (step === null || (from !== undefined && step !== from)) return;
  const next = step + 1;
  if (next >= TOUR.length) {
    useTour.setState({ step: TOUR.length });
    return;
  }
  useTour.setState({ step: next });
  TOUR[next].enter?.();
}

export function endTour(completed: boolean): void {
  const { step, startedAt } = useTour.getState();
  useTour.setState({ step: null });
  studio().setSettings({ tourSeen: true });
  track(completed ? 'tour_completed' : 'tour_skipped', { step: step ?? 0, seconds: Math.round((Date.now() - startedAt) / 1000) });
}
