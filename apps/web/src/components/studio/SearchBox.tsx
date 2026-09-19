'use client';
import { useEffect, useRef, useState } from 'react';
import { resolveQuery, useSearch, loadCandidate } from '@/lib/actions';
import { tryApi } from '@/lib/api';
import { bus } from '@/lib/events';
import { I } from '../ui/icons';

/** Universal input (spec §9.1): names, common names, formulas, SMILES, InChI, CAS, CID — no format selector. */
export function SearchBox({ autoFocus, big }: { autoFocus?: boolean; big?: boolean }) {
  const search = useSearch();
  const [value, setValue] = useState('');
  const [suggest, setSuggest] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [listening, setListening] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  useEffect(() => bus.on('focus-search', () => input.current?.focus()), []);
  // Keep anything typed before hydration finished.
  useEffect(() => {
    const early = input.current?.value;
    if (early) setValue(early);
  }, []);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const onChange = (v: string) => {
    setValue(v);
    setActive(-1);
    clearTimeout(timer.current);
    const ticket = ++seq.current;
    if (v.trim().length < 3 || /[=#()[\]@\\/]/.test(v)) {
      setSuggest([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const r = await tryApi<{ terms: string[] }>(`/names/autocomplete?q=${encodeURIComponent(v.trim())}`, undefined, { timeout: 4000 });
      // A submit (or newer keystroke) since this request makes it stale.
      if (ticket === seq.current) setSuggest((r?.terms ?? []).slice(0, 6));
    }, 180);
  };

  const submit = async (q?: string) => {
    const query = (q ?? value).trim();
    if (!query) return;
    clearTimeout(timer.current);
    seq.current++;
    setSuggest([]);
    setValue(query);
    input.current?.blur();
    await resolveQuery(query);
    bus.emit('fit');
  };

  const voice = () => {
    type SR = { lang: string; interimResults: boolean; maxAlternatives: number; start: () => void; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void };
    const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) {
      useSearch.getState().set({ error: 'Voice input is not supported in this browser.' });
      return;
    }
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      // Spoken names go through the same normalise → OPSIN → preview pipeline.
      const text = e.results[0][0].transcript.replace(/\s+dash\s+/gi, '-').replace(/\s+comma\s+/gi, ',').replace(/(\d)\s+(?=[a-z])/gi, '$1-');
      setValue(text);
      void submit(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const showDrop = focused && (suggest.length > 0 || search.result?.suggestions?.length);
  return (
    <div className="relative w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(active >= 0 ? suggest[active] : undefined);
        }}
        className={`flex items-center gap-2 rounded-xl border border-border bg-panel-raised px-3 transition focus-within:border-accent ${big ? 'h-14 text-[17px]' : 'h-9 text-[14px]'}`}
      >
        <I.Search size={big ? 20 : 16} className="shrink-0 text-text-3" />
        <input
          ref={input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(suggest.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(-1, a - 1));
            } else if (e.key === 'Escape') {
              setSuggest([]);
              input.current?.blur();
            }
          }}
          placeholder={big ? 'Type a name, formula, SMILES, CAS or CID…' : 'Find a molecule…'}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-3"
          aria-label="Find a molecule by name, formula, SMILES, InChI, CAS number or PubChem CID"
          spellCheck={false}
          autoComplete="off"
          data-testid="search-input"
        />
        {!big && !value && !search.busy && (
          <kbd className="mono hidden shrink-0 rounded border border-border px-1 text-[11px] text-text-3 lg:inline" title="Command palette">⌘K</kbd>
        )}
        {search.busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-label="Resolving" />}
        <button type="button" onClick={voice} className={`rounded-md p-1 ${listening ? 'text-danger' : 'text-text-3 hover:text-text'}`} aria-label="Speak a name" title="Speak a name or command">
          <I.Mic size={big ? 18 : 15} />
        </button>
      </form>
      {showDrop ? (
        <ul className="glass absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl py-1 text-sm" role="listbox">
          {suggest.map((s, k) => (
            <li key={s}>
              <button
                role="option"
                aria-selected={active === k}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void submit(s)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${active === k ? 'bg-accent-soft' : 'hover:bg-panel-raised'}`}
              >
                <I.Search size={13} className="text-text-3" /> {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {search.error && (
        <div className="fade-up mt-2 flex items-start gap-2 rounded-lg border border-border bg-panel-raised p-2 text-[13px] text-text-2" role="alert">
          <I.Info size={15} className="mt-0.5 shrink-0" />
          <div>
            {search.error}
            {search.result?.suggestions?.length ? (
              <div className="mt-1">
                Did you mean{' '}
                {search.result.suggestions.slice(0, 4).map((s, k) => (
                  <span key={s.name}>
                    {k > 0 && ', '}
                    <button className="font-medium text-accent-strong underline-offset-2 hover:underline" onClick={() => void submit(s.name)}>
                      {s.name}
                    </button>
                  </span>
                ))}
                ?
              </div>
            ) : null}
          </div>
        </div>
      )}
      {search.cards.length > 0 && (
        <div className="glass fade-up absolute left-0 right-0 top-full z-40 mt-2 rounded-2xl p-3" data-testid="candidate-cards">
          <div className="mb-2 text-[12.5px] text-text-2">
            <b className="text-text">“{search.result?.input.normalized}”</b> could mean more than one structure{search.result?.agreement ? ` — ${search.result.agreement}` : ''}. The differing region is highlighted.
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {search.cards.map((c) => (
              <button
                key={c.candidate.inchiKey}
                onClick={() => void loadCandidate(c.candidate, c.label)}
                className="group rounded-xl border border-border bg-panel-raised p-2 text-left transition hover:border-accent"
              >
                <div className="h-[110px] w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: c.svg }} />
                <div className="mt-1 truncate text-[12.5px] font-medium">{c.label}</div>
                <div className="mono truncate text-[11px] text-text-3">{c.candidate.formula} · {c.candidate.sources.join(', ')}</div>
              </button>
            ))}
          </div>
          <button className="mt-2 text-[12px] text-text-3 hover:text-text" onClick={() => useSearch.getState().set({ cards: [] })}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
