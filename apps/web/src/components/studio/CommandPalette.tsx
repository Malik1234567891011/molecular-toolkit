'use client';
/**
 * ⌘K / "/" command palette (spec §6): expert functions live here instead of permanent chrome.
 * Typing something that isn't a command searches for a molecule instead.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio, studio, type RenderStyle, type SidePanel } from '@/lib/store';
import { bus } from '@/lib/events';
import { resolveQuery, clearMolecule } from '@/lib/actions';
import { cleanLayout, freshGeometry, relaxCurrent } from '@/lib/pipeline';
import { attachSmiles } from '@/lib/edit';
import { I } from '../ui/icons';

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  group: 'Molecule' | 'View' | 'Learn' | 'Share' | 'App';
  when?: () => boolean;
  run: () => void | Promise<void>;
}

const hasMol = () => studio().doc.atoms.length > 0;
const panel = (p: SidePanel) => () => useStudio.setState({ panel: p, landing: false });
const style = (r: RenderStyle) => () => useStudio.setState({ renderStyle: r, view: studio().view === '2d' ? '3d' : studio().view });

function selectedCentre(): string | undefined {
  const s = studio();
  const centres = s.analysis?.stereo.centres ?? [];
  return s.selection.atoms.find((a) => centres.some((c) => c.atomId === a)) ?? centres.find((c) => c.specified)?.atomId;
}

const COMMANDS: Command[] = [
  { id: 'name', label: 'Name this molecule — explain it step by step', keywords: 'name iupac explain why numbering parent', group: 'Learn', when: hasMol, run: () => useStudio.setState({ panel: 'explain', explainStep: 0 }) },
  { id: 'why-numbering', label: 'Why this numbering?', keywords: 'locant number other end', group: 'Learn', when: hasMol, run: () => useStudio.setState({ panel: 'explain', explainStep: 2 }) },
  { id: 'why-parent', label: 'Why this parent chain?', keywords: 'longest chain parent why not', group: 'Learn', when: hasMol, run: () => useStudio.setState({ panel: 'explain', explainStep: 1 }) },
  { id: 'quiz', label: 'Quiz me on this molecule', keywords: 'practice quiz test me problem', group: 'Learn', when: hasMol, run: async () => { useStudio.setState({ panel: 'practice' }); const p = await import('@/lib/practice'); await p.loadProgress(); await p.startProblem({ type: 'name', concept: 'parent', source: 'molecule' }); } },
  { id: 'practice', label: 'Next practice problem', keywords: 'practice spaced repetition daily', group: 'Learn', run: async () => { useStudio.setState({ panel: 'practice' }); const p = await import('@/lib/practice'); await p.loadProgress(); await p.startProblem(); } },
  { id: 'tutor', label: 'Ask the tutor about this molecule', keywords: 'ai tutor question chat help', group: 'Learn', run: panel('tutor') },
  { id: 'chair', label: 'Make it a chair (chair view + ring flip)', keywords: 'cyclohexane chair ring flip axial equatorial', group: 'Learn', run: async () => { if (!studio().doc.atoms.length || !studio().doc.bonds.some((b) => b.order === 1)) await resolveQuery('cyclohexane'); useStudio.setState({ panel: 'projection' }); } },
  { id: 'newman', label: 'Newman projection of a bond', keywords: 'newman sawhorse conformation rotate bond', group: 'Learn', when: hasMol, run: panel('projection') },
  { id: 'fischer', label: 'Fischer projection', keywords: 'fischer wedge dash projection', group: 'Learn', when: hasMol, run: panel('projection') },
  { id: 'mechanism', label: 'Play a reaction mechanism (SN2, E2, …)', keywords: 'mechanism sn2 sn1 e2 e1 arrows curved diels alder', group: 'Learn', run: panel('mechanism') },
  { id: 'tour', label: 'Take the 60-second tour', keywords: 'tour help onboarding tutorial start learn basics', group: 'Learn', run: () => void import('@/lib/tour').then((t) => t.startTour()) },
  { id: 'resonance', label: 'Show resonance contributors', keywords: 'resonance contributor delocalized hybrid curved arrows major minor', group: 'Learn', when: hasMol, run: panel('resonance') },
  { id: 'homo', label: 'Show HOMO / LUMO / ESP', keywords: 'orbital homo lumo esp electrostatic density quantum', group: 'Learn', when: hasMol, run: panel('orbitals') },
  { id: 'flip', label: 'Flip stereocentre (R ↔ S)', keywords: 'invert stereocenter flip r s configuration', group: 'Molecule', when: () => !!selectedCentre(), run: () => { const c = selectedCentre(); if (c) studio().apply({ type: 'invertCentres', atomIds: [c] }, { label: 'Flip stereocentre' }); } },
  { id: 'mirror', label: 'Make the mirror image', keywords: 'enantiomer mirror reflect', group: 'Molecule', when: hasMol, run: () => { studio().apply({ type: 'mirror' }, { label: 'Mirror image' }); } },
  { id: 'add-oh', label: 'Add OH to the selected atom', keywords: 'hydroxyl alcohol add water oh', group: 'Molecule', when: () => studio().selection.atoms.length === 1, run: () => void attachSmiles(studio().selection.atoms[0], 'O') },
  { id: 'relax', label: 'Minimize geometry (relax)', keywords: 'minimize relax optimize mmff energy', group: 'Molecule', when: hasMol, run: () => relaxCurrent() },
  { id: 'regenerate', label: 'Regenerate 3D geometry from scratch', keywords: 'new conformer regenerate embed fresh 3d', group: 'Molecule', when: hasMol, run: () => void freshGeometry(studio().doc, studio().version) },
  { id: 'conformers', label: 'Find low-energy conformers', keywords: 'conformers filmstrip search low energy shapes', group: 'Molecule', when: hasMol, run: () => useStudio.setState({ mode3d: 'conformer', view: studio().view === '2d' ? '3d' : studio().view, panel: 'facts' }) },
  { id: 'clean', label: 'Clean up the 2D drawing', keywords: 'clean layout tidy 2d', group: 'Molecule', when: hasMol, run: () => void cleanLayout() },
  { id: 'clear', label: 'New molecule (clear canvas)', keywords: 'new clear empty reset', group: 'Molecule', run: () => clearMolecule() },
  { id: 'scan', label: 'Scan a structure from a photo', keywords: 'scan photo camera image ocr handwritten', group: 'Molecule', run: () => bus.emit('open:scan') },
  { id: 'undo', label: 'Undo', hint: '⌘Z', keywords: 'undo back', group: 'Molecule', run: () => studio().undo() },
  { id: 'redo', label: 'Redo', hint: '⇧⌘Z', keywords: 'redo', group: 'Molecule', run: () => studio().redo() },
  { id: 'view-2d', label: '2D view', keywords: '2d skeletal draw', group: 'View', run: () => useStudio.setState({ view: '2d', landing: false }) },
  { id: 'view-3d', label: '3D view', keywords: '3d model kit', group: 'View', run: () => useStudio.setState({ view: '3d', landing: false }) },
  { id: 'view-split', label: 'Split view (2D + 3D)', keywords: 'split both side by side', group: 'View', run: () => useStudio.setState({ view: 'split', landing: false }) },
  { id: 'style-kit', label: 'Model kit style', keywords: 'ball and stick kit', group: 'View', run: style('kit') },
  { id: 'style-sticks', label: 'Sticks style', keywords: 'licorice sticks', group: 'View', run: style('licorice') },
  { id: 'style-space', label: 'Space-filling style', keywords: 'space filling cpk vdw', group: 'View', run: style('spacefill') },
  { id: 'style-geometry', label: 'Geometry view (VSEPR shapes)', keywords: 'vsepr geometry lone pairs polyhedra', group: 'View', run: style('geometry') },
  { id: 'style-stereo', label: 'Stereo labels (CIP priorities, R/S)', keywords: 'cip r s labels stereo', group: 'View', run: style('stereo') },
  { id: 'measure', label: 'Measure distances, angles, dihedrals', hint: 'M', keywords: 'measure angle distance dihedral', group: 'View', run: () => useStudio.setState({ mode3d: 'measure', view: studio().view === '2d' ? '3d' : studio().view }) },
  { id: 'hydrogens', label: 'Toggle hydrogens', hint: 'H', keywords: 'hydrogens show hide', group: 'View', run: () => studio().setSettings({ showHydrogens: !studio().settings.showHydrogens }) },
  { id: 'fit', label: 'Center & fit', hint: 'Space', keywords: 'fit center zoom', group: 'View', run: () => bus.emit('fit', 'orient') },
  { id: 'share', label: 'Share a link', keywords: 'share link url embed qr', group: 'Share', when: hasMol, run: () => bus.emit('open:share', 'share') },
  { id: 'export', label: 'Export (PNG, GIF, molfile, SDF, glTF, STL, USDZ…)', keywords: 'export download png gif svg mol sdf gltf stl usdz video image', group: 'Share', when: hasMol, run: () => bus.emit('open:share', 'export') },
  { id: 'ar', label: 'See it on your desk (AR)', keywords: 'ar augmented reality webxr desk phone', group: 'Share', when: hasMol, run: () => bus.emit('open:ar') },
  { id: 'room', label: 'Start a study room', keywords: 'study room multiplayer collaborate friends', group: 'Share', run: panel('room') },
  { id: 'library', label: 'Molecule library & recents', keywords: 'library recent examples drugs natural products compare isomers', group: 'App', run: panel('library') },
  { id: 'compare', label: 'Compare two isomers', keywords: 'compare enantiomer diastereomer isomer relationship', group: 'App', run: panel('library') },
  { id: 'settings', label: 'Settings', keywords: 'settings preferences theme account', group: 'App', run: panel('settings') },
  { id: 'theme', label: 'Toggle dark / light theme', keywords: 'theme dark light mode', group: 'App', run: () => studio().setSettings({ theme: document.documentElement.dataset.resolvedTheme === 'light' ? 'dark' : 'light' }) },
  { id: 'home', label: 'Start screen', keywords: 'home landing start', group: 'App', run: () => useStudio.setState({ landing: true }) },
];

function score(c: Command, q: string): number {
  if (!q) return 1;
  const hay = `${c.label} ${c.keywords}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
  }
  return s;
}

export function CommandPalette() {
  const open = useStudio((s) => s.paletteOpen);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);
  const results = useMemo(() => {
    const list = COMMANDS.filter((c) => !c.when || c.when())
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    return list.slice(0, 12);
  }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const searchItem = q.trim().length >= 2 ? { id: '__search', label: `Find molecule “${q.trim()}”`, hint: 'name · formula · SMILES · CAS', group: 'Molecule' as const, keywords: '', run: () => void resolveQuery(q.trim()) } : null;
  const items: Command[] = results.length ? [...results, ...(searchItem ? [searchItem] : [])] : searchItem ? [searchItem] : [];
  if (!open) return null;
  const close = () => useStudio.setState({ paletteOpen: false });
  const run = (c: Command) => {
    close();
    void c.run();
  };
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onClick={close} role="presentation">
      <div className="glass fade-up w-full max-w-[560px] overflow-hidden rounded-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette" data-testid="command-palette">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <I.Search size={17} className="text-text-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && items[active]) {
                e.preventDefault();
                run(items[active]);
              } else if (e.key === 'Escape') close();
            }}
            placeholder="Type a command or a molecule…  (“make it a chair”, “show HOMO”, “caffeine”)"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-text-3"
            aria-label="Command"
            aria-activedescendant={items[active] ? `cmd-${items[active].id}` : undefined}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            data-testid="palette-input"
          />
          <kbd className="kbd">esc</kbd>
        </div>
        <ul id="cmd-list" role="listbox" className="scroll-thin max-h-[52vh] overflow-y-auto p-1.5">
          {items.map((c, k) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={k === active}
              onMouseEnter={() => setActive(k)}
              onClick={() => run(c)}
              className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-[13.5px] ${k === active ? 'bg-accent-soft text-text' : 'text-text-2'}`}
              data-testid="palette-item"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-14 shrink-0 text-[10.5px] font-semibold uppercase tracking-wide text-text-3">{c.group}</span>
                <span className="truncate">{c.label}</span>
              </span>
              {c.hint && <span className="shrink-0 text-[11.5px] text-text-3">{c.hint}</span>}
            </li>
          ))}
          {!items.length && <li className="px-3 py-6 text-center text-[13px] text-text-3">No matching command.</li>}
        </ul>
      </div>
    </div>
  );
}
