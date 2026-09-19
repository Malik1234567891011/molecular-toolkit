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
import { ShareDialog } from './ShareDialog';
import { CommandPalette } from './CommandPalette';
import { ScanDialog } from './ScanDialog';
import { Tour } from './Tour';
import { Narrator } from './Narrator';
import { ShortcutHelp } from './ShortcutHelp';
import { BottomSheet, PEEK } from './BottomSheet';
import { watchVerifiedChime } from '@/lib/sound';

export function Studio() {
  useApplyTheme();
  const landing = useStudio((s) => s.landing);
  const [ready, setReady] = useState(false);
  useEffect(() => watchVerifiedChime(), []);
  useEffect(() => {
    // Offline support (spec §17). Dev builds skip it so hot reload never fights a cache.
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        // Hand over what this page already loaded (scripts, fonts, the chemistry worker) for offline use.
        const send = () => reg.active?.postMessage({ type: 'cache-urls', urls: performance.getEntriesByType('resource').map((e) => e.name) });
        send();
        setTimeout(send, 8000);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    warmUp();
    void (async () => {
      const had = await restore();
      startPipeline();
      startAutosave();
      setReady(true);
      track(had ? 'return_session' : 'studio_opened', {});
      if (had) setTimeout(() => bus.emit('fit', 'instant'), 300);
      // "Open in the studio" from a share page (?open=<id>): the snapshot becomes an editable copy.
      const openId = new URLSearchParams(location.search).get('open');
      if (openId) {
        history.replaceState(null, '', location.pathname);
        try {
          const { loadShare } = await import('@/lib/share');
          const r = await loadShare(openId);
          useStudio.getState().replace(r.snapshot.doc, `Open shared ${r.snapshot.name ?? 'molecule'}`);
          useStudio.setState({ landing: false });
          setTimeout(() => bus.emit('fit', 'orient'), 300);
        } catch {
          useStudio.getState().notify({ kind: 'warning', text: 'That shared molecule could not be opened (the link may be wrong or offline).' });
        }
      }
      // App shortcuts (manifest): ?panel=<panel> opens a panel, ?scan=1 opens the scanner.
      const params = new URLSearchParams(location.search);
      const panelParam = params.get('panel');
      if (panelParam && ['practice', 'tutor', 'explain', 'projection', 'mechanism', 'resonance', 'orbitals', 'library', 'room'].includes(panelParam)) {
        useStudio.setState({ panel: panelParam as never, landing: false });
      }
      if (params.get('scan') === '1') bus.emit('open:scan');
      if (panelParam || params.get('scan')) history.replaceState(null, '', location.pathname);
      // Study room link (?room=<id>): join straight away.
      const roomId = new URLSearchParams(location.search).get('room');
      if (roomId && /^[\w-]{4,64}$/.test(roomId)) {
        const { joinRoom } = await import('@/lib/room');
        useStudio.setState({ panel: 'room', landing: false });
        void joinRoom(roomId);
      }
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
      tutor: () => import('@/lib/tutor'),
      capture: () => import('@/lib/capture'),
      export3d: () => import('@/lib/export3d'),
      share: () => import('@/lib/share'),
      worker: () => import('@/lib/worker'),
      chem: () => import('@orbital/chem'),
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
      {/* Phones: thumb dock + inspector sheet (hidden while the landing screen is up). */}
      {!(ready && landing) && (
        <>
          <ElementRail dock />
          <div className="shrink-0 md:hidden" style={{ height: PEEK }} aria-hidden />
          <BottomSheet />
        </>
      )}
      <Notices />
      <Shortcuts />
      <ShareDialog />
      <CommandPalette />
      <ScanDialog />
      <Tour />
      <Narrator />
      <ShortcutHelp />
    </div>
  );
}
