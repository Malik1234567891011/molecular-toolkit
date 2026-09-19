'use client';
import { useEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { usePractice } from '@/lib/practice';
import { ProvenanceBadge } from '../naming/ProvenanceBadge';
import { I } from '../ui/icons';

/**
 * First-run coaching (spec §5 "The 30-second wow"): one pulse and one line, then a success card
 * after the first bond, with "Name it" and "See it on your desk".
 */
export function Coach() {
  const doc = useStudio((s) => s.doc);
  const selection = useStudio((s) => s.selection);
  const view = useStudio((s) => s.view);
  const verification = useStudio((s) => s.verification);
  const tourSeen = useStudio((s) => s.settings.tourSeen);
  const practising = usePractice((s) => !!s.problem);
  const [stage, setStage] = useState<'idle' | 'hint' | 'success' | 'done'>('idle');
  useEffect(() => {
    // Coaching would give answers away (and distract) during a practice problem.
    if (tourSeen || practising) return;
    if (stage === 'idle' && doc.atoms.length === 1 && view !== '2d') setStage('hint');
    if (stage === 'hint' && doc.atoms.length >= 2) {
      setStage('success');
      track('first_molecule_completed', { via: 'build' });
    }
  }, [doc, stage, view, tourSeen, practising]);
  if (tourSeen || practising || stage === 'idle' || stage === 'done') return null;
  if (stage === 'hint') {
    return (
      <div className="pointer-events-none absolute left-1/2 top-16 z-20 -translate-x-1/2">
        <div className="glass fade-up flex items-center gap-2 rounded-full px-4 py-2 text-[13.5px]">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
          {selection.atoms.length ? 'Drag from a glowing port to add another atom.' : 'Tap the carbon to see its four connection ports.'}
        </div>
      </div>
    );
  }
  const name = verification?.primary?.name;
  const carbons = doc.atoms.filter((a) => a.element === 'C').length;
  return (
    <div className="absolute left-1/2 top-16 z-20 w-[380px] max-w-[92vw] -translate-x-1/2" data-testid="coach-success">
      <div className="glass fade-up rounded-2xl p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="text-[15px] font-semibold">
            You built {name ? <span className="nomen">{name}</span> : 'your first molecule'}.
          </div>
          <button onClick={() => { setStage('done'); useStudio.getState().setSettings({ tourSeen: true }); }} aria-label="Close" className="text-text-3 hover:text-text">
            <I.X size={16} />
          </button>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-text-2">
          {carbons ? 'Carbon forms four bonds here; hidden hydrogens fill the rest.' : 'Each atom keeps its typical number of bonds; hydrogens fill the rest.'} The molecule relaxed to its lowest-energy shape.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => { useStudio.setState({ panel: 'explain', explainStep: 0 }); }} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-ink">
            Name it {name && verification?.primary && <ProvenanceBadge p={verification.primary.provenance} compact />}
          </button>
          <button onClick={() => bus.emit('open:ar')} className="flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-1.5 text-[13px] font-medium">
            <I.AR size={15} /> See it on your desk
          </button>
        </div>
      </div>
    </div>
  );
}
