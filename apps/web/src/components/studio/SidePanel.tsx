'use client';
import dynamic from 'next/dynamic';
import { useStudio } from '@/lib/store';
import { useIsMobile } from '@/lib/useMobile';
import { Inspector } from '../panels/Inspector';
import { I } from '../ui/icons';

const ExplainPanel = dynamic(() => import('../panels/ExplainPanel').then((m) => m.ExplainPanel), { ssr: false });
const PracticePanel = dynamic(() => import('../panels/PracticePanel').then((m) => m.PracticePanel), { ssr: false });
const TutorPanel = dynamic(() => import('../panels/TutorPanel').then((m) => m.TutorPanel), { ssr: false });
const ProjectionLab = dynamic(() => import('../panels/ProjectionLab').then((m) => m.ProjectionLab), { ssr: false });
const SettingsPanel = dynamic(() => import('../panels/SettingsPanel').then((m) => m.SettingsPanel), { ssr: false });
const OrbitalsPanel = dynamic(() => import('../panels/OrbitalsPanel').then((m) => m.OrbitalsPanel), { ssr: false });
const MechanismPanel = dynamic(() => import('../panels/MechanismPanel').then((m) => m.MechanismPanel), { ssr: false });
const RoomPanel = dynamic(() => import('../panels/RoomPanel').then((m) => m.RoomPanel), { ssr: false });
const ResonancePanel = dynamic(() => import('../panels/ResonancePanel').then((m) => m.ResonancePanel), { ssr: false });
const LibraryPanel = dynamic(() => import('../panels/LibraryPanel').then((m) => m.LibraryPanel), { ssr: false });

export const TITLES: Record<string, string> = {
  facts: 'Inspector', explain: 'Explain the name', practice: 'Practice', tutor: 'Ask this molecule', projection: 'Projection lab',
  settings: 'Settings', orbitals: 'Orbitals & ESP', mechanism: 'Mechanisms', room: 'Study room', library: 'Library', resonance: 'Resonance',
};

export function SidePanel() {
  const panel = useStudio((s) => s.panel);
  // Phones get the bottom sheet instead; only one of them mounts the panel.
  if (useIsMobile()) return null;
  return (
    <aside className="panel relative z-20 hidden w-[372px] shrink-0 flex-col border-y-0 border-r-0 md:flex" aria-label={TITLES[panel]} data-testid="side-panel">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-[13px] font-semibold">{TITLES[panel]}</h2>
        <div className="flex items-center gap-1">
          {panel !== 'facts' && (
            <button onClick={() => useStudio.setState({ panel: 'facts' })} className="rounded-md p-1 text-text-3 hover:text-text" aria-label="Back to inspector">
              <I.X size={15} />
            </button>
          )}
        </div>
      </div>
      <PanelBody panel={panel} />
    </aside>
  );
}

export function PanelBody({ panel }: { panel: string }) {
  switch (panel) {
    case 'explain':
      return <ExplainPanel />;
    case 'practice':
      return <PracticePanel />;
    case 'tutor':
      return <TutorPanel />;
    case 'projection':
      return <ProjectionLab />;
    case 'settings':
      return <SettingsPanel />;
    case 'orbitals':
      return <OrbitalsPanel />;
    case 'mechanism':
      return <MechanismPanel />;
    case 'room':
      return <RoomPanel />;
    case 'library':
      return <LibraryPanel />;
    case 'resonance':
      return <ResonancePanel />;
    default:
      return <Inspector />;
  }
}
