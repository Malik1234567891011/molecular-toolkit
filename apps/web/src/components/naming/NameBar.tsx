'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { naming } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import { subColor } from '@/lib/colors';
import { track } from '@/lib/analytics';
import { usePracticeHidesName } from '@/lib/practice';
import { ProvenanceBadge, PROVENANCE } from './ProvenanceBadge';
import { I } from '../ui/icons';

type Token = naming.NameToken;

export function stepForToken(t: Token): number {
  if (t.role === 'stereo') return 4;
  if (t.role === 'locant') return 2;
  if (t.ref?.startsWith('sub:')) return 3;
  if (t.role === 'suffix' || t.ref === 'suffix') return 0;
  if (t.role === 'parent' || t.role === 'unsaturation' || t.role === 'hydro') return 1;
  return 5;
}

/** Tokens that a naming step is about (the rest are dimmed while that step is shown). */
export function tokenInStep(t: Token, step: number): boolean {
  const sub = !!t.ref?.startsWith('sub:');
  switch (step) {
    case 0: return !sub && (t.ref === 'suffix' || t.role === 'suffix');
    case 1: return !sub && t.role !== 'stereo' && t.role !== 'locant' && t.ref !== 'suffix' && t.role !== 'punct';
    case 2: return t.role === 'locant';
    case 3: return sub && t.role !== 'locant';
    case 4: return t.role === 'stereo';
    default: return true;
  }
}

function tokenColor(t: Token): string | undefined {
  if (t.ref?.startsWith('sub:')) return subColor(Number(t.ref.slice(4)));
  return undefined;
}

/** The live name with clickable tokens (spec §9.4: click a word, watch its atoms light up — and the reverse). */
export function NameTokens({ tokens, interactive = true, size = 'lg', emphasis }: { tokens: Token[]; interactive?: boolean; size?: 'lg' | 'md' | 'sm'; emphasis?: (t: Token) => boolean }) {
  const selection = useStudio((s) => s.selection.atoms);
  const hover = useStudio((s) => s.hoverAtom);
  const focusAtoms = useMemo(() => new Set([...selection, ...(hover ? [hover] : [])]), [selection, hover]);
  const setHighlight = useStudio((s) => s.setHighlight);
  const cls = size === 'lg' ? 'text-[17px]' : size === 'md' ? 'text-[15px]' : 'text-[13px]';
  // A step with nothing to point at in the name (e.g. no principal group) leaves the name at full strength.
  const anyEmphasis = emphasis ? tokens.some(emphasis) : false;
  return (
    <span className={`nomen ${cls} font-medium tracking-[-0.01em]`}>
      {tokens.map((t, k) => {
        const lit = t.atomIds.some((a) => focusAtoms.has(a));
        const color = tokenColor(t);
        const italic = t.role === 'stereo' && /[RSEZ]|cis|trans/.test(t.text);
        const clickable = interactive && t.atomIds.length > 0;
        const dim = emphasis && anyEmphasis ? !emphasis(t) : false;
        return (
          <span
            key={k}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            data-token-role={t.role}
            onMouseEnter={() => clickable && setHighlight('token', { id: 'token', atoms: t.atomIds, bonds: [], tone: color ? 'palette' : 'accent', colorIndex: color ? Number(t.ref!.slice(4)) : undefined })}
            onMouseLeave={() => clickable && setHighlight('token', null)}
            onFocus={() => clickable && setHighlight('token', { id: 'token', atoms: t.atomIds, bonds: [], tone: 'accent' })}
            onBlur={() => clickable && setHighlight('token', null)}
            onClick={() => {
              if (!clickable) return;
              useStudio.setState({ panel: 'explain', explainStep: stepForToken(t) });
              studio().select(t.atomIds.filter((a) => !a.includes('.')));
              track('naming_step_opened', { via: 'token' });
              track('explanation_interaction', { kind: 'token' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLElement).click();
            }}
            className={`rounded-[4px] transition-colors ${clickable ? 'cursor-pointer hover:bg-accent-soft' : ''} ${lit ? 'bg-accent-soft text-accent-strong' : ''} ${italic ? 'italic' : ''}`}
            style={{
              color: lit ? undefined : color,
              textDecoration: color ? 'underline' : undefined,
              textDecorationColor: color,
              textDecorationThickness: color ? '2px' : undefined,
              textUnderlineOffset: '4px',
              whiteSpace: 'pre',
              opacity: dim ? 0.32 : 1,
              transition: 'opacity 220ms ease, color 160ms ease',
            }}
          >
            {t.text}
          </span>
        );
      })}
    </span>
  );
}

export function NameBar() {
  const analysis = useStudio((s) => s.analysis);
  const verification = useStudio((s) => s.verification);
  const doc = useStudio((s) => s.doc);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open]);
  const hidden = usePracticeHidesName();
  if (!doc.atoms.length) return <span className="text-sm text-text-3">No molecule yet</span>;
  if (hidden) {
    return (
      <span className="flex items-center gap-2 text-[14px] text-text-2" data-testid="name-hidden">
        <I.Target size={15} className="text-accent-strong" /> Name hidden while you practise
      </span>
    );
  }
  const n = analysis?.naming;
  const errors = analysis?.validation.filter((v) => v.severity === 'error') ?? [];
  if (errors.length) {
    return (
      <span className="flex items-center gap-2 text-sm text-danger">
        <I.Alert size={16} /> {errors[0].title} — fix it to get a name
      </span>
    );
  }
  const primary = verification?.primary;
  const useTokens = primary && n?.name && primary.name === n.name && n.tokens;
  const provenance = primary?.provenance ?? (verification?.status === 'pending' ? 'pending' : n?.ok ? 'pending' : 'unsupported');
  return (
    <div ref={root} className="relative flex min-w-0 items-center gap-2">
      <div className="min-w-0 truncate" data-testid="current-name" aria-live="polite">
        {useTokens ? (
          <NameTokens tokens={n!.tokens!} />
        ) : primary ? (
          <span className="nomen text-[15px] font-medium sm:text-[17px]">{primary.name}</span>
        ) : n?.name && verification?.status !== 'done' ? (
          <NameTokens tokens={n.tokens ?? []} />
        ) : (
          <span className="text-[14px] text-text-2">{verification?.message ?? n?.unsupportedReason ?? 'Naming…'}</span>
        )}
      </div>
      {(primary || verification?.status === 'pending') && (
        <>
          <span className="shrink-0 sm:hidden"><ProvenanceBadge p={provenance} mini /></span>
          <span className="hidden shrink-0 sm:inline-flex"><ProvenanceBadge p={provenance} /></span>
        </>
      )}
      {verification && (verification.accepted.length > 0 || verification.unverified.length > 0 || (verification.other?.length ?? 0) > 0) && (
        <button onClick={() => setOpen((o) => !o)} className="hidden shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[12px] text-text-2 hover:bg-panel-raised sm:flex" aria-expanded={open}>
          {verification.accepted.length ? `+${verification.accepted.length}` : 'names'} <I.ChevronDown size={14} />
        </button>
      )}
      {open && verification && (
        <div className="glass fade-up absolute left-0 top-full z-40 mt-2 w-[420px] max-w-[90vw] rounded-2xl p-3 text-sm">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">{verification.accepted.length ? 'Accepted names for this structure' : 'Names for this structure'}</div>
          {!verification.accepted.length && <p className="mb-2 text-[12.5px] text-text-2">The name above is the only accepted name in this course style.</p>}
          <ul className="space-y-1.5">
            {verification.accepted.map((c) => (
              <li key={c.name} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="nomen break-words">{c.name}</div>
                  {c.note && <div className="text-[11px] leading-snug text-text-3">{c.note}</div>}
                </div>
                <span className="shrink-0 pt-0.5"><ProvenanceBadge p={c.provenance} compact /></span>
              </li>
            ))}
          </ul>
          {(verification.other?.length ?? 0) > 0 && (
            <details className="mt-3 rounded-lg border border-border p-2">
              <summary className="cursor-pointer text-[12px] text-text-2">Other names in databases ({verification.other!.length}) — not used as answers</summary>
              <ul className="mt-1.5 space-y-1.5">
                {verification.other!.map((c) => (
                  <li key={c.name} className="text-[12.5px]">
                    <div className="nomen text-text-2">{c.name}</div>
                    {c.note && <div className="text-[11px] leading-snug text-text-3">{c.note}</div>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {verification.unverified.length > 0 && (
            <details className="mt-3 rounded-lg border border-border p-2">
              <summary className="cursor-pointer text-[12px] text-text-2">Unverified candidates ({verification.unverified.length}) — not used as answers</summary>
              <ul className="mt-1.5 space-y-1">
                {verification.unverified.map((c) => (
                  <li key={c.name} className="flex justify-between gap-2 text-[12.5px] text-text-2">
                    <span className="nomen line-through decoration-danger/60">{c.name}</span>
                    <ProvenanceBadge p="unverified_candidate" compact />
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-[11.5px] leading-snug text-text-3">{PROVENANCE[provenance].long}</p>
        </div>
      )}
    </div>
  );
}
