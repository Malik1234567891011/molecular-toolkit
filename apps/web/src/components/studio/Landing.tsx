'use client';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { parseSmiles, type MoleculeDocument } from '@orbital/chem';
import { useStudio } from '@/lib/store';
import { EXAMPLES, resolveQuery, startWithCarbon, useSearch } from '@/lib/actions';
import { bus } from '@/lib/events';
import { useResolvedTheme } from '@/lib/useTheme';
import { SearchBox } from './SearchBox';
import { startTour } from '@/lib/tour';
import { I } from '../ui/icons';

const Viewer = dynamic(() => import('../three/Viewer').then((m) => m.Viewer), { ssr: false });

const HERO_SMILES = 'Cn1cnc2c1c(=O)n(C)c(=O)n2C';

/** Caffeine, pre-minimized (OpenChemLib MMFF94s+) so the hero appears on first paint. */
const HERO_COORDS: Record<string, [number, number, number]> = {"a1":[-2.73,4.087,-2.327],"a2":[-2.228,2.805,-1.901],"a3":[-2.876,1.912,-1.089],"a4":[-2.153,0.829,-0.883],"a5":[-1.009,1.045,-1.591],"a6":[-1.024,2.249,-2.226],"a7":[0.049,2.718,-3.032],"a8":[0.025,3.806,-3.601],"a9":[1.112,1.813,-3.097],"a10":[2.27,2.176,-3.89],"a11":[1.165,0.558,-2.454],"a12":[2.152,-0.174,-2.573],"a13":[0.061,0.189,-1.686],"a14":[0.036,-1.086,-0.992],"a1.h1":[-2.792,4.091,-3.418],"a1.h2":[-3.723,4.25,-1.9],"a1.h3":[-2.046,4.863,-1.974],"a3.h1":[-3.861,2.097,-0.678],"a10.h1":[3.155,2.181,-3.245],"a10.h2":[2.419,1.42,-4.669],"a10.h3":[2.168,3.156,-4.361],"a14.h1":[-0.073,-0.906,0.082],"a14.h2":[0.951,-1.659,-1.159],"a14.h3":[-0.815,-1.673,-1.353]};

function useHero(): MoleculeDocument {
  return useMemo(() => {
    const d = parseSmiles(HERO_SMILES).doc;
    return { ...d, conformers: [{ id: 'hero', coordinates: HERO_COORDS, method: 'MMFF94s+' }], selectedConformerId: 'hero' };
  }, []);
}

export function Landing() {
  const theme = useResolvedTheme();
  const hero = useHero();
  const busy = useSearch((s) => s.busy);
  const [typing, setTyping] = useState(false);
  const close = () => useStudio.setState({ landing: false });
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  return (
    <div className="canvas-bg absolute inset-0 z-30 flex flex-col items-center justify-start overflow-y-auto overflow-x-hidden px-4 pb-8 sm:justify-center sm:pb-0" data-testid="landing">
      <div className="pointer-events-none relative h-[30vh] min-h-[180px] w-full max-w-[520px] shrink-0" aria-hidden>
        {hero ? <Viewer doc={hero} theme={theme} interactive={false} /> : <div className="grid h-full place-items-center"><span className="h-10 w-10 animate-pulse rounded-full bg-accent-soft" /></div>}
      </div>
      <div className="relative z-10 -mt-2 w-full max-w-[680px] text-center">
        <h1 className="text-[34px] font-semibold tracking-[-0.03em] sm:text-[44px]">Build or find any molecule</h1>
        <p className="mt-2 text-[16px] text-text-2">Type a name, draw it, scan it, or start with an atom.</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          <button onClick={() => bus.emit('open:guide')} className="inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft px-3.5 py-1.5 text-[13px] font-semibold text-accent-strong transition hover:bg-accent hover:text-accent-ink" data-testid="open-guide">
            <I.Book size={15} /> New here? See how Orbital works
          </button>
          <button onClick={startTour} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-text-2 hover:bg-accent-soft hover:text-accent-strong" data-testid="start-tour">
            <I.Sparkle size={14} /> or take the 60-second tour
          </button>
        </div>
        <div className="mt-6">
          {typing ? (
            <SearchBox big autoFocus />
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Action icon={<I.Search size={22} />} title="Type a name" sub="or formula, SMILES, CAS" onClick={() => setTyping(true)} testid="action-type" />
              <Action icon={<I.Cube size={22} />} title="Build in 3D" sub="start from one carbon" onClick={() => { startWithCarbon(); setTimeout(() => bus.emit('fit'), 50); }} testid="action-build" />
              <Action icon={<I.Pen size={22} />} title="Draw in 2D" sub="skeletal structures" onClick={() => { useStudio.setState({ view: '2d', tool2d: 'draw', landing: false }); }} testid="action-draw" />
              <Action icon={<I.Scan size={22} />} title="Scan a structure" sub="photo of notes" onClick={() => { close(); bus.emit('open:scan'); }} testid="action-scan" />
            </div>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[13px]">
          <span className="text-text-3">Try</span>
          {EXAMPLES.map((e) => (
            <button
              key={e.label}
              disabled={busy}
              onClick={async () => {
                await resolveQuery(e.query);
                if (e.chair) useStudio.setState({ panel: 'projection' });
                setTimeout(() => bus.emit('fit'), 80);
              }}
              className="rounded-full border border-border bg-panel px-3 py-1 font-medium text-text hover:border-accent"
              data-testid={`example-${e.label}`}
            >
              {e.label}
            </button>
          ))}
        </div>
        {hasMol && (
          <button onClick={close} className="mt-6 text-[13px] text-text-2 underline-offset-4 hover:text-text hover:underline">
            Back to my molecule
          </button>
        )}
        <p className="mt-6 text-[11.5px] text-text-3">No account needed · your work saves on this device · free</p>
      </div>
    </div>
  );
}

function Action({ icon, title, sub, onClick, testid }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; testid: string }) {
  return (
    <button onClick={onClick} data-testid={testid} className="glass group flex flex-col items-center gap-1.5 rounded-2xl px-3 py-4 transition hover:-translate-y-0.5 hover:border-accent">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent-strong transition group-hover:bg-accent group-hover:text-accent-ink">{icon}</span>
      <span className="text-[14px] font-semibold">{title}</span>
      <span className="text-[11.5px] text-text-3">{sub}</span>
    </button>
  );
}
