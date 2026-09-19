'use client';
import { useEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { startPipeline } from '@/lib/pipeline';
import { restore, startAutosave } from '@/lib/persist';
import { warmUp } from '@/lib/worker';
import { useApplyTheme } from '@/lib/useTheme';
import { track } from '@/lib/analytics';
import { bus } from '@/lib/events';
import { loadStructure, resolveQuery } from '@/lib/actions';
import { TopBar } from './TopBar';
import { ElementRail } from './ElementRail';
import { CanvasArea } from './CanvasArea';
import { SidePanel } from './SidePanel';
import { Landing } from './Landing';
import { Notices } from './Notices';
import { Shortcuts } from './Shortcuts';
import { Coach } from './Coach';

export function Studio() {
  useApplyTheme();
  const landing = useStudio((s) => s.landing);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    warmUp();
    void (async () => {
      const had = await restore();
      startPipeline();
      startAutosave();
      setReady(true);
      track(had ? 'return_session' : 'studio_opened', {});
      if (had) setTimeout(() => bus.emit('fit', 'instant'), 300);
      // Shared problem set link (#set=…): save it locally and open practice.
      if (location.hash.startsWith('#set=')) {
        const { decodeSet, saveSet, loadProgress } = await import('@/lib/practice');
        const set = decodeSet(location.hash.slice(5));
        history.replaceState(null, '', location.pathname + location.search);
        if (set) {
          await loadProgress();
          saveSet(set.title, set.items);
          useStudio.setState({ panel: 'practice', landing: false });
          useStudio.getState().notify({ kind: 'success', text: `Problem set “${set.title}” added (${set.items.length} items). Open “Problem sets” to start.` }, 7000);
        }
      }
    })();
    // Expose state for automated checks (read state, not screens).
    (window as unknown as { __orbital: unknown; __orbitalBus: unknown }).__orbital = useStudio;
    (window as unknown as { __orbitalBus: unknown }).__orbitalBus = bus;
    (window as unknown as { __orbitalActions: unknown }).__orbitalActions = {
      resolveQuery,
      loadStructure,
      practice: () => import('@/lib/practice'),
    };
  }, []);
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <div className="relative flex min-h-0 flex-1">
        <ElementRail />
        <main className="relative flex min-h-0 min-w-0 flex-1">
          <CanvasArea />
          <Coach />
          {ready && landing && <Landing />}
        </main>
        <SidePanel />
      </div>
      <Notices />
      <Shortcuts />
    </div>
  );
}
