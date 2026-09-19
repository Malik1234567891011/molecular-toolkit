'use client';
/** Every structure a formula can make, worked out from the bonding rules (spec §9.1). */
import { useEffect } from 'react';
import { moreIsomers, openIsomer, useIsomers } from '@/lib/isomers';
import { useStudio } from '@/lib/store';
import { I } from '../ui/icons';

const sub = (formula: string) => formula.replace(/\d+/g, (d) => [...d].map((x) => '₀₁₂₃₄₅₆₇₈₉'[+x]).join(''));

export function IsomersPanel() {
  const { formula, cards, total, truncated, note, loading, error } = useIsomers();
  const current = useStudio((s) => s.doc);
  useEffect(() => {
    // Nothing to do on mount; the search opens this panel with results already loading.
  }, []);

  if (!formula) {
    return <p className="p-4 text-[13px] text-text-2">Type a formula such as <span className="mono">C5H10</span> in the search box to see every structure it can make.</p>;
  }
  const currentKey = current.atoms.length ? `${current.atoms.length}:${current.bonds.map((b) => b.order).sort().join('')}` : '';
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4" data-testid="isomers-panel">
      <div>
        <h3 className="nomen text-[15px] font-semibold">{sub(formula)}</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">
          {total > 0
            ? <><b className="text-text">{total}{truncated ? '+' : ''} constitutional isomer{total === 1 ? '' : 's'}</b> — every way these atoms can be joined up, worked out from the bonding rules. Tap one to open it in 3D.</>
            : 'No structure found for this formula.'}
        </p>
      </div>

      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      {note && <p className="rounded-xl bg-panel-raised px-3 py-2 text-[12px] leading-relaxed text-text-2">{note}</p>}

      <div className="grid grid-cols-2 gap-2">
        {cards.map((c, k) => {
          const key = `${c.doc.atoms.length}:${c.doc.bonds.map((b) => b.order).sort().join('')}`;
          return (
            <button
              key={k}
              onClick={() => void openIsomer(c)}
              className={`group rounded-xl border p-2 text-left transition hover:border-accent ${key === currentKey ? 'border-border-strong bg-panel-raised' : 'border-border bg-panel-raised'}`}
              data-testid={`isomer-${k}`}
            >
              <div className="h-[104px] w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: c.svg }} />
              <div className="nomen mt-1 line-clamp-2 text-[12.5px] font-medium first-letter:uppercase">{c.name ?? `Isomer ${k + 1}`}</div>
            </button>
          );
        })}
      </div>

      {loading && <p className="text-center text-[12.5px] text-text-3">Working them out…</p>}
      {!loading && cards.length < total && (
        <button onClick={() => void moreIsomers()} className="w-full rounded-lg border border-border py-2 text-[12.5px] font-medium hover:border-accent" data-testid="isomers-more">
          Show {Math.min(24, total - cards.length)} more ({cards.length} of {total})
        </button>
      )}

      <p className="flex gap-2 pt-1 text-[11.5px] leading-relaxed text-text-3">
        <I.Info size={13} className="mt-[2px] shrink-0" />
        <span>Neutral structures with the usual valences (C 4, N 3, O 2, halogen 1). Cis/trans and R/S versions of the same skeleton aren’t listed separately — open one and use Projections or the stereo tools to explore those.</span>
      </p>
    </div>
  );
}
