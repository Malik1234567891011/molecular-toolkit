'use client';
import { useEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { startPipeline } from '@/lib/pipeline';
import { restore, startAutosave } from '@/lib/persist';
import { warmUp } from '@/lib/worker';
import { useApplyTheme } from '@/lib/useTheme';
import { track } from '@/lib/analytics';
import { bus } from '@/lib/events';
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
    })();
    // Expose state for automated checks (read state, not screens).
    (window as unknown as { __orbital: unknown; __orbitalBus: unknown }).__orbital = useStudio;
    (window as unknown as { __orbitalBus: unknown }).__orbitalBus = bus;
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
