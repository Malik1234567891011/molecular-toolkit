'use client';
import { useStudio, studio, type SidePanel, type ViewMode } from '@/lib/store';
import { bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { NameBar } from '../naming/NameBar';
import { SearchBox } from './SearchBox';
import { I } from '../ui/icons';

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ v: T; label: string; icon?: React.ReactNode; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border bg-panel-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          title={o.title ?? o.label}
          onClick={() => onChange(o.v)}
          className={`flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium transition ${value === o.v ? 'bg-accent text-accent-ink shadow-sm' : 'text-text-2 hover:text-text'}`}
        >
          {o.icon}
          <span className="hidden lg:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function PanelButton({ panel, icon, label, kbd }: { panel: SidePanel; icon: React.ReactNode; label: string; kbd?: string }) {
  const active = useStudio((s) => s.panel === panel);
  return (
    <button
      onClick={() => {
        useStudio.setState({ panel: active ? 'facts' : panel });
        if (panel === 'practice' && !active) track('practice_started', {});
      }}
      aria-pressed={active}
      title={kbd ? `${label} (${kbd})` : label}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition ${active ? 'bg-accent-soft text-accent-strong' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

export function TopBar() {
  const view = useStudio((s) => s.view);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  return (
    <header className="panel relative z-30 flex h-14 shrink-0 items-center gap-3 border-x-0 border-t-0 px-3">
      <button onClick={() => useStudio.setState({ landing: true })} className="flex items-center gap-2 pr-1" aria-label="Orbital home">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
          <defs>
            <radialGradient id="lg" cx="40%" cy="35%" r="70%">
              <stop offset="0%" stopColor="#c4bbff" />
              <stop offset="100%" stopColor="#6b5cf0" />
            </radialGradient>
          </defs>
          <ellipse cx="16" cy="16" rx="13" ry="5.5" fill="none" stroke="var(--text-3)" strokeWidth="1.4" transform="rotate(-28 16 16)" />
          <circle cx="16" cy="16" r="6" fill="url(#lg)" />
          <circle cx="27" cy="10.5" r="2.2" fill="var(--text)" />
        </svg>
        <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">Orbital</span>
      </button>
      <div className="hidden w-[300px] shrink-0 md:block">
        <SearchBox />
      </div>
      <div className="min-w-0 flex-1 px-1">{hasMol && <NameBar />}</div>
      <div className="flex items-center gap-1">
        <button disabled={!canUndo} onClick={() => studio().undo()} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text disabled:opacity-30" title="Undo (⌘Z)" aria-label="Undo">
          <I.Undo size={17} />
        </button>
        <button disabled={!canRedo} onClick={() => studio().redo()} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text disabled:opacity-30" title="Redo (⇧⌘Z)" aria-label="Redo">
          <I.Redo size={17} />
        </button>
      </div>
      <Seg<ViewMode>
        label="View"
        value={view}
        onChange={(v) => {
          useStudio.setState({ view: v });
          setTimeout(() => bus.emit('fit'), 60);
        }}
        options={[
          { v: '2d', label: '2D', icon: <I.Pen size={14} /> },
          { v: '3d', label: '3D', icon: <I.Cube size={14} /> },
          { v: 'split', label: 'Split', icon: <I.Split size={14} /> },
        ]}
      />
      <nav className="flex items-center gap-0.5" aria-label="Panels">
        <PanelButton panel="explain" icon={<I.Lightbulb size={16} />} label="Explain" kbd="E" />
        <PanelButton panel="projection" icon={<I.Layers size={16} />} label="Projections" />
        <PanelButton panel="practice" icon={<I.Target size={16} />} label="Practice" />
        <PanelButton panel="tutor" icon={<I.Chat size={16} />} label="Tutor" />
      </nav>
      <div className="flex items-center gap-1">
        <button onClick={() => bus.emit('open:share')} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text" title="Share / export / AR" aria-label="Share, export or view in AR">
          <I.Share size={17} />
        </button>
        <button onClick={() => useStudio.setState({ panel: 'settings' })} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text" title="Settings" aria-label="Settings">
          <I.Settings size={17} />
        </button>
      </div>
    </header>
  );
}
