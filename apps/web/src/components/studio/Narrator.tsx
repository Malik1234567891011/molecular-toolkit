'use client';
import { useEffect, useState } from 'react';
import { useStudio } from '@/lib/store';
import { describeAtom, describeBond, describeMolecule } from '@/lib/narrate';

/**
 * A visually hidden live region that narrates selections, edits and the molecule itself
 * (spec §15). Selection and edits speak immediately; the molecule summary once it is named.
 */
export function Narrator() {
  const [text, setText] = useState('');
  useEffect(() => {
    let lastKey = '';
    let lastPast = useStudio.getState().past.length;
    let lastFuture = useStudio.getState().future.length;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const say = (t: string) => {
      // Re-announce identical text by toggling a zero-width space.
      setText((prev) => (prev === t ? t + '​' : t));
    };
    return useStudio.subscribe((s, prev) => {
      if (s.selection !== prev.selection) {
        if (s.selection.atoms.length === 1) say(describeAtom(s.doc, s.analysis, s.selection.atoms[0]));
        else if (s.selection.bonds.length === 1 && !s.selection.atoms.length) say(describeBond(s.doc, s.selection.bonds[0]));
        else if (s.selection.atoms.length > 1) say(`${s.selection.atoms.length} atoms selected.`);
      }
      if (s.past.length !== lastPast || s.future.length !== lastFuture) {
        const undo = s.future.length > lastFuture;
        const redo = s.future.length < lastFuture && s.past.length > lastPast;
        const entry = undo ? s.future[s.future.length - 1] : s.past[s.past.length - 1];
        lastPast = s.past.length;
        lastFuture = s.future.length;
        if (entry && !(s.selection !== prev.selection && s.selection.atoms.length === 1)) {
          say(`${undo ? 'Undid' : redo ? 'Redid' : 'Done'}: ${entry.label}. ${s.doc.atoms.length} atom${s.doc.atoms.length === 1 ? '' : 's'}.`);
        }
      }
      // The molecule summary, once per structure, when its name has settled.
      const key = s.analysis?.identifiers?.inchiKey ?? '';
      const settled = s.analysis && s.analysisVersion === s.version && (s.verification?.status === 'done' || s.verification?.status === 'offline' || !s.analysis.naming?.ok);
      if (key && key !== lastKey && settled) {
        lastKey = key;
        clearTimeout(pending);
        pending = setTimeout(() => {
          const st = useStudio.getState();
          say(describeMolecule(st.doc, st.analysis, st.verification?.primary?.name));
        }, 400);
      }
    });
  }, []);
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true" role="status" data-testid="narrator">
      {text}
    </div>
  );
}
