'use client';
import { useEffect, useRef, useState } from 'react';
import { useStudio, studio, type SidePanel, type ViewMode } from '@/lib/store';
import { bus } from '@/lib/events';
import { track } from '@/lib/analytics';
import { NameBar } from '../naming/NameBar';
import { SearchBox } from './SearchBox';
import { I } from '../ui/icons';
import { useIsMobile } from '@/lib/useMobile';

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ v: T; label: string; icon?: React.ReactNode; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border bg-panel-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={value === o.v}
          title={o.title ?? o.label}
          data-tour={`${label.toLowerCase()}-${o.v}`}
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
      data-tour={`panel-${panel}`}
      className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition ${active ? 'bg-accent-soft text-accent-strong' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function MoreMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useStudio((s) => s.panel);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // Keyboard: Escape closes (focus back on the button), arrows move between items.
    const key = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  // Opening a panel by any route (palette, shortcut) closes the menu.
  useEffect(() => setOpen(false), [panel]);
  const mobile = useIsMobile();
  const go = (p: SidePanel) => () => useStudio.setState({ panel: p, landing: false });
  const items: Array<{ label: string; icon: React.ReactNode; run: () => void; active?: boolean; kbd?: string }> = [
    // On phones the panel buttons live here too.
    ...(mobile
      ? [
          { label: 'Explain the name', icon: <I.Lightbulb size={15} />, run: go('explain'), active: panel === 'explain' },
          { label: 'Projections', icon: <I.Layers size={15} />, run: go('projection'), active: panel === 'projection' },
          { label: 'Practice', icon: <I.Target size={15} />, run: go('practice'), active: panel === 'practice' },
          { label: 'Tutor', icon: <I.Chat size={15} />, run: go('tutor'), active: panel === 'tutor' },
        ]
      : []),
    { label: 'Library & compare', icon: <I.Book size={15} />, run: () => useStudio.setState({ panel: 'library', landing: false }), active: panel === 'library' },
    { label: 'Mechanisms', icon: <I.Flask size={15} />, run: () => useStudio.setState({ panel: 'mechanism', landing: false }), active: panel === 'mechanism' },
    { label: 'Resonance', icon: <I.Resonance size={15} />, run: () => useStudio.setState({ panel: 'resonance', landing: false }), active: panel === 'resonance' },
    { label: 'Orbitals & ESP', icon: <I.Orbital size={15} />, run: () => useStudio.setState({ panel: 'orbitals', landing: false }), active: panel === 'orbitals' },
    { label: 'Study room', icon: <I.Users size={15} />, run: () => useStudio.setState({ panel: 'room', landing: false }), active: panel === 'room' },
    { label: 'Scan a structure', icon: <I.Scan size={15} />, run: () => bus.emit('open:scan') },
    { label: 'All commands', icon: <I.Search size={15} />, run: () => useStudio.setState({ paletteOpen: true }), kbd: '⌘K' },
    ...(mobile ? [{ label: 'Settings', icon: <I.Settings size={15} />, run: go('settings'), active: panel === 'settings' }] : []),
  ];
  const anyActive = items.some((i) => i.active);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title="More tools" className={`flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition ${anyActive || open ? 'bg-accent-soft text-accent-strong' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`} data-testid="more-menu">
        <I.Grid size={16} />
        <span className="hidden xl:inline">More</span>
      </button>
      {open && (
        <div role="menu" className="glass fade-up absolute right-0 top-full z-50 mt-2 w-56 rounded-xl p-1">
          {items.map((it) => (
            <button key={it.label} role="menuitem" onClick={() => { setOpen(false); it.run(); }} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] ${it.active ? 'bg-accent-soft text-accent-strong' : 'hover:bg-panel-raised'}`}>
              {it.icon}
              <span className="flex-1">{it.label}</span>
              {it.kbd && <kbd className="kbd">{it.kbd}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const view = useStudio((s) => s.view);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  return (
    <header className="panel relative z-30 flex h-14 shrink-0 items-center gap-1.5 border-x-0 border-t-0 px-2 sm:gap-3 sm:px-3">
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
      <button onClick={() => useStudio.setState({ paletteOpen: true })} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised md:hidden" aria-label="Find a molecule or command" data-testid="mobile-search">
        <I.Search size={18} />
      </button>
      <div className="min-w-0 flex-1 px-1">{hasMol && <NameBar />}</div>
      <div className="flex items-center gap-1">
        <button disabled={!canUndo} onClick={() => studio().undo()} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text disabled:opacity-30" title="Undo (⌘Z)" aria-label="Undo">
          <I.Undo size={17} />
        </button>
        <button disabled={!canRedo} onClick={() => studio().redo()} className="hidden rounded-lg p-1.5 sm:block text-text-2 hover:bg-panel-raised hover:text-text disabled:opacity-30" title="Redo (⇧⌘Z)" aria-label="Redo">
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
        <div className="hidden items-center gap-0.5 md:flex">
          <PanelButton panel="explain" icon={<I.Lightbulb size={16} />} label="Explain" kbd="E" />
          <PanelButton panel="projection" icon={<I.Layers size={16} />} label="Projections" />
          <PanelButton panel="practice" icon={<I.Target size={16} />} label="Practice" />
          <PanelButton panel="tutor" icon={<I.Chat size={16} />} label="Tutor" />
        </div>
        <MoreMenu />
      </nav>
      <div className="flex items-center gap-1">
        <button onClick={() => bus.emit('open:share')} className="rounded-lg p-1.5 text-text-2 hover:bg-panel-raised hover:text-text" title="Share / export / AR" aria-label="Share, export or view in AR">
          <I.Share size={17} />
        </button>
        <button onClick={() => useStudio.setState({ panel: 'settings' })} className="hidden rounded-lg p-1.5 md:block text-text-2 hover:bg-panel-raised hover:text-text" title="Settings" aria-label="Settings">
          <I.Settings size={17} />
        </button>
      </div>
    </header>
  );
}
