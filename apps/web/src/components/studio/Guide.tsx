'use client';
/**
 * "How Orbital works": every feature in plain words, in the order a student meets them, each with
 * where to find it and a "Try it" that closes the guide and does the thing for real. Opened from
 * the start screen, the ⓘ button, the More menu, ⌘K, or a link to /?guide.
 */
import { useEffect, useRef, useState } from 'react';
import { studio, useStudio, type SidePanel } from '@/lib/store';
import { bus } from '@/lib/events';
import { resolveQuery, startWithCarbon } from '@/lib/actions';
import { track } from '@/lib/analytics';
import { prefersReducedMotion } from '@/lib/useTheme';
import { I } from '../ui/icons';

// ------------------------------------------------------------------------------------------
// Actions behind "Try it"

const fit = () => setTimeout(() => bus.emit('fit'), 120);
const open = (panel: SidePanel) => useStudio.setState({ panel, landing: false });

/** Load a molecule (unless it's already the one on screen), then open a panel. */
async function show(query: string, panel?: SidePanel, extra?: Record<string, unknown>) {
  await resolveQuery(query);
  useStudio.setState({ landing: false, ...(panel ? { panel } : {}), ...(extra ?? {}) });
  fit();
}

/** Something on screen to work with: keep the current molecule, or load a friendly one. */
async function ensureMolecule(fallback = 'caffeine') {
  if (!studio().doc.atoms.length) await resolveQuery(fallback);
  useStudio.setState({ landing: false });
  fit();
}

// ------------------------------------------------------------------------------------------
// Little pieces that look like the real controls, so the guide's words map onto the screen

function B({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 whitespace-nowrap rounded-md border border-border bg-panel-raised px-1.5 py-[1px] text-[12px] font-medium text-text">
      {icon}
      {children}
    </span>
  );
}

function K({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd mx-0.5">{children}</kbd>;
}

// ------------------------------------------------------------------------------------------
// Content

interface Item {
  id: string;
  icon: React.ReactNode;
  title: string;
  what: React.ReactNode;
  steps?: React.ReactNode[];
  tip?: React.ReactNode;
  tryIt?: { label: string; run: () => void | Promise<void> };
}

interface Chapter {
  id: string;
  title: string;
  intro: string;
  items: Item[];
}

const CHAPTERS: Chapter[] = [
  {
    id: 'get',
    title: 'Get a molecule on screen',
    intro: 'Four ways in. Whichever you use, you end up with the same thing: a real molecule you can turn, name and study.',
    items: [
      {
        id: 'search',
        icon: <I.Search size={18} />,
        title: 'Type a name',
        what: 'Find any molecule by its common name (caffeine, aspirin), its IUPAC name (2-methylpropan-1-ol), a formula, a SMILES string or a CAS number.',
        steps: [
          <>Click the search box at the top left, or press <K>⌘K</K> (<K>Ctrl K</K> on Windows).</>,
          <>Type the name and press <K>Enter</K>. It appears in 3D with its name checked.</>,
          <>If the name could mean more than one molecule, pick the right one from the cards. If you misspell it, Orbital suggests what you probably meant.</>,
        ],
        tip: <>Tap the <B icon={<I.Mic size={12} />}>microphone</B> in the search box to say the name instead of typing it.</>,
        tryIt: { label: 'Look up caffeine', run: () => show('caffeine', 'facts') },
      },
      {
        id: 'formula',
        icon: <I.Atom size={18} />,
        title: 'Type a formula to see every isomer',
        what: 'Type a molecular formula like C5H10 and Orbital works out every way those atoms can be joined up — from the bonding rules, not from a list of molecules someone published. Each one is drawn and named for you.',
        steps: [
          <>Type the formula in the search box (capital letters for elements: <span className="mono">C5H10</span>, <span className="mono">C4H10O</span>).</>,
          'Tap any isomer to open it in 3D and name it, then come back to the list.',
        ],
        tip: 'These are constitutional isomers — different connections. Cis/trans and R/S versions of one skeleton aren’t listed separately; open one and use Projections for those.',
        tryIt: { label: 'Isomers of C5H10', run: async () => { const { openIsomers } = await import('@/lib/isomers'); await openIsomers({ C: 5, H: 10 }, 'C5H10'); } },
      },
      {
        id: 'build',
        icon: <I.Cube size={18} />,
        title: 'Build it in 3D',
        what: 'Snap atoms together like a plastic model kit. Orbital keeps the chemistry legal and relaxes the model into its real shape as you go.',
        steps: [
          <>On the start screen choose <B icon={<I.Cube size={12} />}>Build in 3D</B>. You get one carbon.</>,
          <>Click an atom to see its connection points (they’re its hydrogens). Drag from one to add a bonded atom, or select an atom and press <K>Enter</K>.</>,
          <>To add a different element, pick it first from the column on the left (N, O, Cl…).</>,
        ],
        tip: 'Try something impossible, like a fifth bond on carbon. Orbital refuses and explains why instead of just showing an error.',
        tryIt: { label: 'Start from one carbon', run: () => { startWithCarbon(); fit(); } },
      },
      {
        id: 'draw',
        icon: <I.Pen size={18} />,
        title: 'Draw it in 2D',
        what: 'Draw skeletal structures the way you would on paper. It is the same molecule as the 3D one: change one and the other follows.',
        steps: [
          <>Switch to <B icon={<I.Pen size={12} />}>2D</B> at the top.</>,
          'Click to place an atom. Drag from an atom to draw a bond. Click a bond to make it double, then triple.',
          <>The hexagon button (or <K>R</K>) draws rings — click it to choose the size (3 to 8, benzene, or type any size up to 30), or press <K>3</K>–<K>8</K>. Click empty space to drop one, an atom to hang it off, or a bond to fuse it.</>,
          <><K>W</K> and <K>D</K> draw wedge and dash bonds.</>,
        ],
        tip: <><B icon={<I.Split size={12} />}>Split</B> shows 2D and 3D side by side. Select an atom in one and it lights up in the other. To start over, the <B icon={<I.Trash size={12} />}>bin</B> in the toolbar clears everything (<K>⌘Z</K> undoes it), and <K>⌘A</K> selects the whole molecule so <K>Delete</K> removes it in one go.</>,
        tryIt: { label: 'Open the 2D drawing board', run: () => useStudio.setState({ view: '2d', tool2d: 'draw', landing: false }) },
      },
      {
        id: 'scan',
        icon: <I.Scan size={18} />,
        title: 'Scan it from a photo',
        what: 'Take a photo of a structure in your notes or textbook and turn it into a molecule you can rotate and name.',
        steps: [
          <>Choose <B icon={<I.Scan size={12} />}>Scan a structure</B> on the start screen (or in <B icon={<I.Grid size={12} />}>More</B>) and pick a photo.</>,
          'Orbital lays what it read over your drawing. Compare them: fix or delete anything it got wrong.',
          <>Press <B>Accept and open</B>. Prefer to do it yourself? <B>Trace it myself</B> puts the photo behind the 2D board.</>,
        ],
        tip: 'Photos are never stored. Orbital also tells you when it isn’t sure about part of a drawing.',
        tryIt: { label: 'Scan a photo', run: () => { useStudio.setState({ landing: false }); bus.emit('open:scan'); } },
      },
      {
        id: 'library',
        icon: <I.Book size={18} />,
        title: 'Library, recents and comparing isomers',
        what: 'Ready-made course molecules, everything you opened recently, and a comparer that tells you whether two structures are identical, enantiomers, diastereomers or constitutional isomers. It also spots meso compounds.',
        steps: [<>Open <B icon={<I.Grid size={12} />}>More</B> → <B icon={<I.Book size={12} />}>Library &amp; compare</B>.</>],
        tryIt: { label: 'Open the library', run: () => open('library') },
      },
    ],
  },
  {
    id: 'look',
    title: 'Look at it',
    intro: 'Turn it, measure it, and see it drawn every way your course draws molecules.',
    items: [
      {
        id: 'move',
        icon: <I.Rotate size={18} />,
        title: 'Move around the model',
        what: 'The 3D model is real geometry: bond lengths and angles come from a force field, not a drawing.',
        steps: [
          <>Drag to rotate. Scroll or pinch to zoom. Press <K>Space</K> to re-centre.</>,
          <>Switch between <B icon={<I.Pen size={12} />}>2D</B> <B icon={<I.Cube size={12} />}>3D</B> <B icon={<I.Split size={12} />}>Split</B> at the top.</>,
        ],
        tryIt: { label: 'Show me a molecule in 3D', run: () => show('caffeine', undefined, { view: '3d' }) },
      },
      {
        id: 'toolbar',
        icon: <I.Ruler size={18} />,
        title: 'The 3D toolbar',
        what: 'The bar at the bottom of the 3D view.',
        steps: [
          <><B>Conformer</B>: grab a single bond and twist it. A Newman projection and an energy curve update as you turn, so you can see why staggered beats eclipsed.</>,
          <><B>Measure</B> (<K>M</K>): click 2 atoms for a distance, 3 for an angle, 4 for a dihedral, each compared with the ideal value.</>,
          <>The <B>Model kit</B> menu changes the style: Sticks, Space-filling, Geometry (VSEPR shapes and lone pairs) or Stereo (R/S labels and CIP priorities).</>,
          <><B>H</B> shows or hides hydrogens. <B>Relax</B> settles the model into its nearest low-energy shape.</>,
        ],
        tryIt: { label: 'Twist butane’s middle bond', run: () => show('butane', 'facts', { view: '3d', mode3d: 'conformer' }) },
      },
      {
        id: 'projections',
        icon: <I.Layers size={18} />,
        title: 'Projections',
        what: 'The molecule on screen drawn as a Newman projection, a sawhorse, wedge-and-dash, a Fischer projection, or a chair, including an animated ring flip.',
        steps: [
          <>Press <B icon={<I.Layers size={12} />}>Projections</B> at the top.</>,
          'Pick a drawing. For a Newman, choose the bond to look down and drag it to rotate.',
        ],
        tryIt: { label: 'Flip a cyclohexane chair', run: () => show('cyclohexane', 'projection') },
      },
      {
        id: 'orbitals',
        icon: <I.Orbital size={18} />,
        title: 'Orbitals & electrostatic potential',
        what: 'A real quantum-chemistry calculation on your molecule. It shows where its highest-energy electrons are (HOMO), where new electrons would go (LUMO), the whole electron cloud, and which regions are electron-rich or electron-poor (ESP).',
        steps: [
          <>Open <B icon={<I.Grid size={12} />}>More</B> → <B icon={<I.Orbital size={12} />}>Orbitals &amp; ESP</B>.</>,
          <>Pick a method (HF / STO-3G is the fastest) and press <B>Compute orbitals</B>.</>,
          'Switch between HOMO, LUMO, density and ESP. For HOMO and LUMO, the isovalue slider grows or shrinks the surfaces.',
        ],
        tip: 'Small molecules take a few seconds. Big ones, or the B3LYP method, can take a minute or two; the button counts the seconds.',
        tryIt: { label: 'Open orbitals for formaldehyde', run: () => show('formaldehyde', 'orbitals') },
      },
    ],
  },
  {
    id: 'understand',
    title: 'Understand it',
    intro: 'Why it’s called what it’s called, how its electrons behave, and someone to ask.',
    items: [
      {
        id: 'name',
        icon: <I.Check size={18} />,
        title: 'The name at the top',
        what: 'Every molecule gets its name worked out and then checked by turning the name back into a structure. The badge tells you how far to trust it.',
        steps: [
          <><B>Verified</B> means the naming rules produced it and it converts back to exactly this molecule, stereochemistry included. <B>Database name</B> is PubChem’s recorded name. <B>Common name</B> is an accepted everyday name.</>,
          'Point at any part of the name to light up the atoms it describes. Click it to jump to the step that explains that part.',
          'The small menu beside the name lists the other names it goes by.',
        ],
        tryIt: { label: 'See (R)-2-butanol', run: () => show('(R)-butan-2-ol', 'facts') },
      },
      {
        id: 'explain',
        icon: <I.Lightbulb size={18} />,
        title: 'Explain the name',
        what: 'Why the molecule has the name it has, in six steps: the main functional group, the parent chain (and why not the others), numbering from both ends, the prefixes in alphabetical order, stereochemistry (R/S, E/Z), and putting it all together.',
        steps: [
          <>Press <B icon={<I.Lightbulb size={12} />}>Explain</B> at the top (or <K>E</K>).</>,
          'Go through the steps with Next. Each one lights up the atoms it’s talking about.',
        ],
        tip: 'The parent-chain step shows the chains that lost, and why. That’s usually the part that trips people up.',
        tryIt: { label: 'Explain 3-ethyl-2-methylhexane', run: () => show('3-ethyl-2-methylhexane', 'explain', { explainStep: 0 }) },
      },
      {
        id: 'inspector',
        icon: <I.Info size={18} />,
        title: 'The Inspector (right-hand panel)',
        what: 'What’s showing when no other panel is open: formula and mass, functional groups, the most acidic proton and its pKa, resonance, stereocentres, and a check that the structure makes sense, with plain-English warnings when it doesn’t.',
        steps: ['Close any other panel (the × at its top right) to get back to it.'],
        tryIt: { label: 'Inspect acetic acid', run: () => show('acetic acid', 'facts') },
      },
      {
        id: 'resonance',
        icon: <I.Resonance size={18} />,
        title: 'Resonance',
        what: 'All the reasonable resonance structures, with curved arrows showing how the electrons move from one to the next, and which structure contributes most.',
        steps: [<>Open <B icon={<I.Grid size={12} />}>More</B> → <B icon={<I.Resonance size={12} />}>Resonance</B>.</>],
        tryIt: { label: 'Resonance of acetate', run: () => show('acetate', 'resonance') },
      },
      {
        id: 'mechanisms',
        icon: <I.Flask size={18} />,
        title: 'Reaction mechanisms',
        what: 'SN2, SN1, E2 and E1, step by step with curved arrows and the reason behind each step. SN2 also plays as a 3D animation of the backside attack.',
        steps: [<>Open <B icon={<I.Grid size={12} />}>More</B> → <B icon={<I.Flask size={12} />}>Mechanisms</B>, pick one, and step through it.</>],
        tryIt: { label: 'Open mechanisms', run: () => open('mechanism') },
      },
      {
        id: 'tutor',
        icon: <I.Chat size={18} />,
        title: 'Ask the tutor',
        what: 'An AI tutor that can see the exact molecule on your screen. Ask it anything. It points at the atoms it means, and every name it writes is checked before you see it.',
        steps: [
          <>Press <B icon={<I.Chat size={12} />}>Tutor</B> at the top.</>,
          'Tap one of the suggested questions or type your own.',
        ],
        tip: 'Ask for a hint instead of the answer and it coaches you. Conversations aren’t saved.',
        tryIt: { label: 'Ask about ibuprofen', run: () => show('ibuprofen', 'tutor') },
      },
    ],
  },
  {
    id: 'practice',
    title: 'Practise',
    intro: 'Problems that notice what you get wrong and bring it back until it sticks.',
    items: [
      {
        id: 'problems',
        icon: <I.Target size={18} />,
        title: 'Practice problems',
        what: 'Naming, drawing from a name, parent chains, numbering, R/S, E/Z, conformations, projections, acidity and more. Orbital chooses what comes next from what you’ve missed (spaced repetition).',
        steps: [
          <>Press <B icon={<I.Target size={12} />}>Practice</B>, then <B>Next problem</B> or the <B>Daily challenge</B>.</>,
          'Answer on the molecule itself: type a name, build a structure, or click atoms.',
          <>Stuck? <B>Hint</B> gives up to five hints, each more direct than the last. <B>Show answer</B> walks you through it.</>,
        ],
        tip: 'Any correct name counts, because Orbital grades the structure, not the spelling of one particular name. Your streak and progress in each topic are at the top of the panel. You can also export your problems as Anki flashcards.',
        tryIt: { label: 'Start practising', run: () => { open('practice'); track('practice_started', { via: 'guide' }); } },
      },
      {
        id: 'quiz',
        icon: <I.Sparkle size={18} />,
        title: 'Quiz me on this molecule',
        what: 'Turn whatever is on screen into a question: name it, find its parent chain, number it, assign R/S or E/Z, work with its Fischer or Newman projection, and more.',
        steps: [<>In <B icon={<I.Target size={12} />}>Practice</B>, under “Quiz me on this molecule”, pick a question type.</>],
        tryIt: { label: 'Quiz me on (R)-2-butanol', run: () => show('(R)-butan-2-ol', 'practice') },
      },
    ],
  },
  {
    id: 'share',
    title: 'Share it and study together',
    intro: 'Send a molecule to a friend, put it on your desk, or work on one together live.',
    items: [
      {
        id: 'share',
        icon: <I.Share size={18} />,
        title: 'Share links and exports',
        what: 'A link opens a read-only copy of your molecule in 3D. It won’t change if you keep editing. There’s also a QR code and a code for embedding it in notes. Export saves pictures (PNG, SVG), animations (GIF, video), chemistry files (molfile, SDF) and 3D models (glTF, STL for 3D printing, USDZ).',
        steps: [
          <>Press the <B icon={<I.Share size={12} />}>Share</B> icon at the top right.</>,
          <>Copy the link, or switch to the <B>Export</B> tab.</>,
        ],
        tryIt: { label: 'Share this molecule', run: async () => { await ensureMolecule(); bus.emit('open:share', 'share'); } },
      },
      {
        id: 'ar',
        icon: <I.AR size={18} />,
        title: 'See it on your desk (AR)',
        what: 'On a phone, place the molecule on a real table at model-kit size and walk around it, with no app to install. On a computer, scan the QR code with your phone to do the same.',
        steps: [<>Press <B icon={<I.Share size={12} />}>Share</B> → <B>AR</B>.</>],
        tryIt: { label: 'Put it on my desk', run: async () => { await ensureMolecule(); bus.emit('open:ar'); } },
      },
      {
        id: 'room',
        icon: <I.Users size={18} />,
        title: 'Study rooms',
        what: 'Study with friends live. Everyone in the room sees the same molecule, each other’s cursors and a shared chat. Start a message with @tutor to ask the tutor on everyone’s behalf.',
        steps: [
          <>Open <B icon={<I.Grid size={12} />}>More</B> → <B icon={<I.Users size={12} />}>Study room</B> → <B>Start a room with this molecule</B>.</>,
          <>Press <B>Copy link</B> and send it to your friends. They’re in as soon as they open it.</>,
        ],
        tip: 'Only people with the link can get in, and a room is deleted an hour after everyone leaves.',
        tryIt: { label: 'Open study rooms', run: () => open('room') },
      },
    ],
  },
  {
    id: 'you',
    title: 'Your work and settings',
    intro: 'Nothing to sign up for. The rest is there when you want it.',
    items: [
      {
        id: 'saving',
        icon: <I.Download size={18} />,
        title: 'Saving, accounts and offline',
        what: 'Your work saves automatically on this device, with no account needed. To have your molecules and practice progress on another device too, create a free account in Settings, where you can also download or delete everything. Orbital works offline for molecules you’ve already opened, and your browser can install it like an app.',
        steps: [<>Press the <B icon={<I.Settings size={12} />}>Settings</B> gear at the top right (on a phone it’s in <B icon={<I.Grid size={12} />}>More</B>).</>],
        tryIt: { label: 'Open settings', run: () => open('settings') },
      },
      {
        id: 'settings',
        icon: <I.Settings size={18} />,
        title: 'Make it comfortable',
        what: 'Light or dark theme, less motion, high contrast, colour-blind-safe atom colours, and the naming style your course uses (so the practice answers match your class).',
        steps: [<>All in <B icon={<I.Settings size={12} />}>Settings</B>.</>],
        tryIt: { label: 'Open settings', run: () => open('settings') },
      },
      {
        id: 'keyboard',
        icon: <I.Bolt size={18} />,
        title: 'Keyboard and the command box',
        what: 'Everything works from the keyboard, and screen readers hear each selection and edit.',
        steps: [
          <>Arrow keys move between atoms. <K>Enter</K> adds an atom. <K>C</K> <K>N</K> <K>O</K> pick elements. <K>1</K> <K>2</K> <K>3</K> set the bond order. <K>?</K> lists every shortcut.</>,
          <><K>⌘K</K> (<K>Ctrl K</K>) opens a command box. Type what you want (“mirror image”, “chair”, “SN2”, “export”) or a molecule’s name.</>,
        ],
        tryIt: { label: 'Show all shortcuts', run: () => bus.emit('open:help') },
      },
      {
        id: 'tour',
        icon: <I.Play size={18} />,
        title: 'The 60-second tour',
        what: 'A hands-on warm-up: place an atom, draw a bond, switch to 3D, and see it named. Each step completes itself when you do it.',
        tryIt: { label: 'Take the tour', run: () => void import('@/lib/tour').then((t) => t.startTour()) },
      },
    ],
  },
];

const QUICK: Array<{ n: number; title: string; body: React.ReactNode; tryIt: Item['tryIt'] }> = [
  { n: 1, title: 'Get a molecule', body: 'Type any name in the search box, or build, draw or scan one.', tryIt: { label: 'Caffeine', run: () => show('caffeine', 'facts') } },
  { n: 2, title: 'Look at it', body: 'Drag to turn it in 3D. Its checked name is at the top.', tryIt: { label: '3D', run: () => ensureMolecule() } },
  { n: 3, title: 'Understand it', body: <>Press <B icon={<I.Lightbulb size={12} />}>Explain</B> to see why it has that name, step by step.</>, tryIt: { label: 'Explain', run: () => show('3-ethyl-2-methylhexane', 'explain', { explainStep: 0 }) } },
  { n: 4, title: 'Practise', body: <>Press <B icon={<I.Target size={12} />}>Practice</B> for problems that adapt to what you miss.</>, tryIt: { label: 'Practice', run: () => open('practice') } },
];

// ------------------------------------------------------------------------------------------

function setGuideParam(on: boolean) {
  const url = new URL(location.href);
  if (on === url.searchParams.has('guide')) return;
  if (on) url.searchParams.set('guide', '');
  else url.searchParams.delete('guide');
  history.replaceState(null, '', url.toString().replace('guide=&', 'guide&').replace(/guide=$/, 'guide'));
}

export function Guide() {
  const [isOpen, setOpen] = useState(false);
  const [active, setActive] = useState(CHAPTERS[0].id);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      bus.on('open:guide', () => {
        setOpen(true);
        track('explanation_interaction', { kind: 'guide_opened' });
      }),
    [],
  );
  useEffect(() => {
    if (new URLSearchParams(location.search).has('guide')) setOpen(true);
  }, []);
  useEffect(() => {
    setGuideParam(isOpen);
    if (!isOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [isOpen]);
  // Highlight the chapter being read in the contents.
  useEffect(() => {
    if (!isOpen || !bodyRef.current) return;
    const root = bodyRef.current;
    const obs = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (seen) setActive(seen.target.id.replace('guide-', ''));
      },
      { root, rootMargin: '0px 0px -70% 0px' },
    );
    root.querySelectorAll('section[id^=guide-]').forEach((s) => obs.observe(s));
    return () => obs.disconnect();
  }, [isOpen]);

  if (!isOpen) return null;

  const run = async (label: string, fn: () => void | Promise<void>) => {
    setOpen(false);
    track('explanation_interaction', { kind: 'guide_try', item: label });
    await fn();
  };
  const jump = (id: string) => {
    const body = bodyRef.current;
    const sec = body?.querySelector(`#guide-${id}`);
    if (!body || !sec) return;
    setActive(id);
    const top = body.scrollTop + sec.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
    body.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <div className="fixed inset-0 z-[75] flex flex-col bg-bg" role="dialog" aria-modal="true" aria-labelledby="guide-title" data-testid="guide">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-accent-strong">
          <I.Book size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 id="guide-title" className="text-[17px] font-semibold tracking-tight">How Orbital works</h1>
          <p className="hidden truncate text-[12.5px] text-text-3 sm:block">Everything it does, in plain words. Every part has a “Try it” button that shows you for real.</p>
        </div>
        <button ref={closeRef} onClick={() => setOpen(false)} aria-label="Back to Orbital" className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-panel-raised" data-testid="guide-close">
          <I.X size={15} /> <span className="hidden sm:inline">Back to Orbital</span>
        </button>
      </header>

      {/* Phones: chapters as a scrolling row of chips. */}
      <nav className="scroll-thin flex shrink-0 gap-1.5 overflow-x-auto border-b border-border px-4 py-2 md:hidden" aria-label="Guide chapters">
        {CHAPTERS.map((c) => (
          <button key={c.id} onClick={() => jump(c.id)} className={`shrink-0 rounded-full border px-3 py-1 text-[12.5px] ${active === c.id ? 'border-accent bg-accent-soft text-accent-strong' : 'border-border text-text-2'}`}>
            {c.title}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-[240px] shrink-0 flex-col gap-0.5 border-r border-border p-4 md:flex" aria-label="Guide chapters">
          <span className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">Contents</span>
          {CHAPTERS.map((c, i) => (
            <button key={c.id} onClick={() => jump(c.id)} aria-current={active === c.id ? 'true' : undefined} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${active === c.id ? 'bg-accent-soft font-medium text-accent-strong' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`}>
              <span className="mono w-4 text-[11px] text-text-3">{i + 1}</span>
              {c.title}
            </button>
          ))}
          <div className="mt-auto rounded-xl border border-border p-3 text-[12px] leading-relaxed text-text-2">
            Come back any time with the <B icon={<I.Info size={12} />}>Guide</B> button at the top, or type “guide” in <K>⌘K</K>.
          </div>
        </nav>

        <div ref={bodyRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="guide-body">
          <div className="mx-auto max-w-[820px] px-4 pb-24 pt-6 sm:px-8 lg:px-12">
            <section aria-labelledby="guide-quick" className="rounded-2xl border border-accent/40 bg-accent-soft/40 p-4 sm:p-5">
              <h2 id="guide-quick" className="text-[15px] font-semibold">The short version</h2>
              <p className="mt-1 text-[13px] text-text-2">Orbital is a place to see molecules in 3D, learn why they’re named what they’re named, and practise until it clicks. Most of the time you’ll do these four things:</p>
              <ol className="mt-3 grid gap-2 sm:grid-cols-2">
                {QUICK.map((q) => (
                  <li key={q.n} className="flex gap-3 rounded-xl bg-panel p-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent text-[13px] font-semibold text-accent-ink">{q.n}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] font-semibold">{q.title}</div>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">{q.body}</p>
                      {q.tryIt && (
                        <button onClick={() => void run(q.tryIt!.label, q.tryIt!.run)} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-strong hover:underline">
                          Try it <I.ChevronRight size={13} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-[12.5px] text-text-2">Everything else is below, grouped the same way. On a phone, the buttons from the top bar (Explain, Projections, Practice, Tutor) are in the <B icon={<I.Grid size={12} />}>More</B> menu.</p>
            </section>

            {CHAPTERS.map((c, ci) => (
              <section key={c.id} id={`guide-${c.id}`} aria-labelledby={`guide-h-${c.id}`} className="scroll-mt-4 pt-10">
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="mono text-[12px] text-accent-strong">{ci + 1}</span>
                  <h2 id={`guide-h-${c.id}`} className="text-[20px] font-semibold tracking-tight">{c.title}</h2>
                </div>
                <p className="mb-4 text-[13.5px] text-text-2">{c.intro}</p>
                <div className="space-y-3">
                  {c.items.map((it) => (
                    <article key={it.id} className="rounded-2xl border border-border bg-panel p-4" data-testid={`guide-item-${it.id}`}>
                      <div className="flex items-start gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-strong">{it.icon}</span>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold">{it.title}</h3>
                          <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">{it.what}</p>
                        </div>
                      </div>
                      {it.steps && (
                        <ol className="mt-3 space-y-1.5 pl-12">
                          {it.steps.map((s, k) => (
                            <li key={k} className="relative text-[13.5px] leading-relaxed">
                              <span className="absolute -left-6 top-[1px] grid h-[18px] w-[18px] place-items-center rounded-full border border-border text-[10.5px] text-text-3">{k + 1}</span>
                              {s}
                            </li>
                          ))}
                        </ol>
                      )}
                      {it.tip && (
                        <p className="mt-3 flex gap-2 rounded-xl bg-panel-raised px-3 py-2 text-[12.5px] leading-relaxed text-text-2 sm:ml-12">
                          <I.Lightbulb size={14} className="mt-[2px] shrink-0 text-amber" />
                          <span>{it.tip}</span>
                        </p>
                      )}
                      {it.tryIt && (
                        <div className="mt-3 sm:pl-12">
                          <button onClick={() => void run(it.tryIt!.label, it.tryIt!.run)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-semibold text-accent-ink hover:opacity-90" data-testid={`guide-try-${it.id}`}>
                            <I.Play size={13} /> Try it: {it.tryIt.label}
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            ))}

            <p className="mt-12 text-center text-[12.5px] text-text-3">
              That’s everything. Close this guide with <K>Esc</K> or <B icon={<I.X size={12} />}>Back to Orbital</B>, and reopen it any time from the <B icon={<I.Info size={12} />}>Guide</B> button.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
