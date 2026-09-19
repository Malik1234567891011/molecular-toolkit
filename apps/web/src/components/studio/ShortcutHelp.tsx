'use client';
import { useEffect, useRef, useState } from 'react';
import { bus } from '@/lib/events';
import { I } from '../ui/icons';

const KEYS: Array<[string, string]> = [
  ['← → ↑ ↓', 'Move between atoms (nearest in that direction, bonded neighbours first)'],
  ['⇧ + arrow', 'Select the bond in that direction'],
  ['Enter', 'Bond a new atom of the armed element to the selected atom'],
  ['C N O S P F I H', 'Arm an element, or change the selected atom'],
  ['C then l · B then r', 'Chlorine · bromine'],
  ['1 2 3', 'Selected bond: single, double, triple'],
  ['+ / −', 'Selected atom: raise or lower the formal charge'],
  ['Delete', 'Remove the selection (undoable)'],
  ['Space', 'Centre and fit the molecule'],
  ['H · M', 'Show/hide hydrogens · measure mode'],
  ['R · W · D · V', 'Ring templates · wedge · hash · select tool (2D)'],
  ['E', 'Explain the name'],
  ['⌘Z · ⇧⌘Z', 'Undo · redo'],
  ['⌘K or /', 'Command palette — every other action'],
  ['Esc', 'Clear the selection or close a dialog'],
];

/** "?" — every shortcut in one place (spec §6: every pointer action has a keyboard equivalent). */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => bus.on('open:help', () => setOpen(true)), []);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={() => setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-labelledby="kbd-title" className="fade-up w-[520px] max-w-full rounded-2xl border border-border-strong bg-panel-solid p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} data-testid="shortcut-help">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="kbd-title" className="text-[16px] font-semibold">Keyboard</h2>
          <button ref={closeRef} onClick={() => setOpen(false)} className="rounded-lg p-1.5 hover:bg-panel-raised" aria-label="Close">
            <I.X size={17} />
          </button>
        </div>
        <p className="mb-3 text-[12.5px] leading-relaxed text-text-2">Everything you can do with a pointer works from the keyboard. Selections and edits are read aloud by screen readers.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {KEYS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt className="mono whitespace-nowrap text-right text-[12px] text-accent-strong">{k}</dt>
              <dd className="text-text-2">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
