'use client';
import { useEffect, useRef, useState } from 'react';
import { naming } from '@orbital/chem';
import { useStudio, studio } from '@/lib/store';
import {
  ACHIEVEMENTS, CONCEPTS, TYPE_LABEL, checkAnswer, clearPracticeHighlights, encodeSet, exportAnki, loadProgress, nextConcept, nextHint,
  saveSet, startDaily, startProblem, startSetItem, streakOf, today, usePractice, type Problem, type ProblemType,
} from '@/lib/practice';
import { I } from '../ui/icons';
import { FischerView } from './ProjectionLab';

const QUIZ_TYPES: Array<{ type: ProblemType; label: string }> = [
  { type: 'name', label: 'Name it' },
  { type: 'parent', label: 'Parent chain' },
  { type: 'number', label: 'Number it' },
  { type: 'principal', label: 'Suffix group' },
  { type: 'stereo', label: 'R/S · E/Z' },
  { type: 'geometry', label: 'Geometry' },
  { type: 'groups', label: 'Groups' },
  { type: 'fischer', label: 'Fischer' },
];

export function PracticePanel() {
  const loaded = usePractice((s) => s.loaded);
  const problem = usePractice((s) => s.problem);
  const preparing = usePractice((s) => s.preparing);
  useEffect(() => {
    void loadProgress();
  }, []);
  if (!loaded) return <div className="p-4 text-[13px] text-text-3">Loading your progress…</div>;
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="practice-panel">
      {preparing && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-[12.5px] text-text-2">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Preparing a problem…
        </div>
      )}
      {problem ? <ProblemCard problem={problem} /> : <Home />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Home() {
  const progress = usePractice((s) => s.progress);
  const hasMol = useStudio((s) => s.doc.atoms.length > 0 && !!s.analysis?.naming);
  const profileId = useStudio((s) => s.settings.profileId);
  const streak = streakOf(progress.days);
  const todayCount = progress.attempts.filter((a) => a.verdict === 'correct' && new Date(a.at).toDateString() === new Date().toDateString()).length;
  const dailyDone = progress.dailyDone.includes(today());
  const next = nextConcept(progress);
  const nextLabel = CONCEPTS.find((c) => c.id === next)?.label;
  return (
    <div className="space-y-5 p-4">
      <div className="grid grid-cols-3 gap-2" data-testid="practice-stats">
        <Stat label="day streak" value={streak} accent={streak > 0} />
        <Stat label="correct today" value={todayCount} />
        <Stat label="named" value={progress.named} />
      </div>

      <button onClick={() => void startProblem()} className="flex w-full items-center justify-between rounded-2xl bg-accent px-4 py-3 text-left text-accent-ink transition hover:brightness-110" data-testid="practice-next">
        <span>
          <span className="block text-[15px] font-semibold">Next problem</span>
          <span className="block text-[12px] opacity-80">Focus: {nextLabel} — chosen by spaced repetition</span>
        </span>
        <I.ChevronRight size={20} />
      </button>

      <button onClick={() => void startDaily()} disabled={dailyDone} className="flex w-full items-center justify-between rounded-2xl border border-border px-4 py-3 text-left transition hover:border-accent disabled:opacity-70" data-testid="practice-daily">
        <span>
          <span className="block text-[14px] font-semibold">Daily challenge</span>
          <span className="block text-[12px] text-text-2">{dailyDone ? 'Done for today — come back tomorrow' : 'Same problem for everyone today'}</span>
        </span>
        {dailyDone ? <I.Check size={18} className="text-good" /> : <I.Target size={18} className="text-accent-strong" />}
      </button>

      {hasMol && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">Quiz me on this molecule</h3>
          <div className="flex flex-wrap gap-1.5">
            {QUIZ_TYPES.map((q) => (
              <button key={q.type} onClick={() => void startProblem({ type: q.type, concept: conceptFor(q.type), source: 'molecule' })} className="rounded-full border border-border px-2.5 py-1 text-[12px] hover:border-accent" data-testid={`quiz-${q.type}`}>
                {q.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">Concepts</h3>
        <ul className="space-y-1" data-testid="mastery">
          {CONCEPTS.map((c) => {
            const box = progress.boxes[c.id] ?? 0;
            return (
              <li key={c.id} className="flex items-center gap-2 text-[12.5px]">
                <button onClick={() => void startProblem({ concept: c.id })} className="w-[118px] shrink-0 truncate text-left text-text-2 hover:text-text" title={`Practise ${c.label}`}>
                  {c.label}
                </button>
                <span className="flex flex-1 gap-0.5" aria-label={`${c.label}: level ${box} of 5`}>
                  {[1, 2, 3, 4, 5].map((k) => (
                    <span key={k} className={`h-1.5 flex-1 rounded-full ${k <= box ? 'bg-accent' : 'bg-border'}`} />
                  ))}
                </span>
                <span className="mono w-6 text-right text-[11px] text-text-3">{box}/5</span>
              </li>
            );
          })}
        </ul>
      </section>

      {progress.achievements.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-3">Achievements</h3>
          <div className="flex flex-wrap gap-1.5">
            {progress.achievements.map((a) => (
              <span key={a} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-medium text-accent-strong">{ACHIEVEMENTS[a]}</span>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-3">Course</h3>
        <label className="flex items-center justify-between gap-2 text-[12.5px]">
          <span className="text-text-2">Naming convention</span>
          <select value={profileId} onChange={(e) => studio().setSettings({ profileId: e.target.value })} className="rounded-md border border-border bg-panel-raised px-2 py-1 text-[12.5px]" data-testid="profile-select">
            {naming.PROFILES.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <p className="text-[11.5px] leading-relaxed text-text-3">Grading always compares structures, so every correct name passes; the convention decides which form is shown as the model answer.</p>
        <ProblemSets />
        <button onClick={() => void exportAnki()} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[12.5px] hover:border-accent" data-testid="anki-export">
          <I.Download size={14} /> Export flashcards for Anki
        </button>
      </section>
    </div>
  );
}

function conceptFor(t: ProblemType) {
  return ({ name: 'parent', parent: 'parent', number: 'locants', principal: 'suffix', stereo: 'rs', geometry: 'geometry', groups: 'groups', fischer: 'projection', build: 'build', acidity: 'acidity', repair: 'valence' } as const)[t];
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-panel-raised px-3 py-2">
      <div className={`mono text-[20px] font-semibold ${accent ? 'text-accent-strong' : ''}`}>{value}</div>
      <div className="text-[11px] text-text-3">{label}</div>
    </div>
  );
}

function ProblemSets() {
  const sets = usePractice((s) => s.progress.sets);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [link, setLink] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-border">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-3 py-2 text-[12.5px]" aria-expanded={open}>
        <span>Problem sets {sets.length ? `(${sets.length})` : ''}</span>
        <I.ChevronDown size={14} className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          {sets.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-[12.5px]">
              <span className="truncate">{s.title} <span className="text-text-3">· {s.items.length}</span></span>
              <span className="flex shrink-0 gap-1">
                <button onClick={() => void startSetItem(s.items[Math.floor(Math.random() * s.items.length)])} className="rounded-md bg-accent-soft px-2 py-0.5 text-accent-strong">Practise</button>
                <button onClick={() => setLink(encodeSet(s.title, s.items))} className="rounded-md border border-border px-2 py-0.5">Share</button>
              </span>
            </div>
          ))}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Set title (e.g. Chapter 4 alkanes)" className="w-full rounded-md border border-border bg-panel-raised px-2 py-1 text-[12.5px]" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder={'One per line: SMILES to name, or a name to build\nCCC(C)CC\n2-methylbutan-2-ol'} className="mono w-full rounded-md border border-border bg-panel-raised px-2 py-1 text-[12px]" />
          <button
            onClick={() => {
              const items = text.split('\n').map((l) => l.trim()).filter(Boolean);
              if (!items.length) return;
              saveSet(title.trim() || `Set ${new Date().toLocaleDateString()}`, items);
              setText('');
              setTitle('');
            }}
            className="w-full rounded-md bg-accent py-1.5 text-[12.5px] font-medium text-accent-ink"
          >
            Save set
          </button>
          {link && (
            <div className="rounded-md bg-panel-raised p-2 text-[11.5px]">
              <div className="mb-1 text-text-2">Share this link — it opens the set for anyone (no account):</div>
              <div className="flex gap-1">
                <input readOnly value={link} className="mono min-w-0 flex-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[11px]" onFocus={(e) => e.currentTarget.select()} />
                <button onClick={() => void navigator.clipboard?.writeText(link).then(() => studio().notify({ kind: 'success', text: 'Link copied' }, 1600))} className="rounded border border-border px-1.5"><I.Copy size={13} /></button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ProblemCard({ problem }: { problem: Problem }) {
  const feedback = usePractice((s) => s.feedback);
  const checking = usePractice((s) => s.checking);
  const hints = usePractice((s) => s.hints);
  const hintText = usePractice((s) => s.hintText);
  const picked = usePractice((s) => s.picked);
  const [answer, setAnswer] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setAnswer('');
    if (problem.type === 'name') setTimeout(() => input.current?.focus(), 50);
  }, [problem.id, problem.type]);
  const done = feedback && feedback.verdict !== 'invalid' && feedback.verdict !== 'offline';
  const leave = () => {
    clearPracticeHighlights();
    usePractice.setState({ problem: null, feedback: null, hints: 0, hintText: [], picked: [], order: [] });
  };
  return (
    <div className="space-y-3 p-4" data-testid="problem-card">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
          {TYPE_LABEL[problem.type]}
          {problem.source === 'daily' && <span className="ml-1.5 rounded bg-accent-soft px-1 text-accent-strong">daily</span>}
          {problem.source === 'set' && <span className="ml-1.5 rounded bg-accent-soft px-1 text-accent-strong">set</span>}
        </span>
        <span className="flex items-center gap-1" aria-label={`Level ${problem.level} of 4`}>
          {[1, 2, 3, 4].map((k) => (
            <span key={k} className={`h-1.5 w-1.5 rounded-full ${k <= problem.level ? 'bg-accent' : 'bg-border'}`} />
          ))}
        </span>
      </div>
      <div>
        <h3 className="text-[16px] font-semibold leading-snug" data-testid="problem-prompt">{problem.prompt}</h3>
        {problem.sub && <p className="mt-0.5 text-[12.5px] text-text-2">{problem.sub}</p>}
      </div>

      {problem.type === 'name' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void checkAnswer(answer);
          }}
          className="flex gap-1.5"
        >
          <input
            ref={input}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="e.g. 3-ethyl-2-methylhexane"
            className="min-w-0 flex-1 rounded-lg border border-border bg-panel-raised px-3 py-2 text-[14px] outline-none focus:border-accent"
            spellCheck={false}
            autoComplete="off"
            aria-label="Your name for this molecule"
            data-testid="answer-input"
            disabled={!!done}
          />
        </form>
      )}

      {problem.choices && problem.type !== 'fischer' && <Choices problem={problem} disabled={!!done} />}
      {problem.type === 'fischer' && problem.fischer && problem.trace && <FischerChoices problem={problem} disabled={!!done} />}
      {problem.type === 'acidity' && <Acidity problem={problem} disabled={!!done} />}

      {hintText.length > 0 && (
        <ol className="space-y-1 rounded-xl border border-amber/40 bg-amber-soft px-3 py-2 text-[12.5px] leading-relaxed" data-testid="hints">
          {hintText.map((h, k) => (
            <li key={k}><span className="mr-1 font-semibold text-amber">Hint {k + 1}.</span>{h}</li>
          ))}
        </ol>
      )}

      {!done && (
        <div className="flex gap-1.5">
          <button onClick={() => void checkAnswer(answer)} disabled={checking || (problem.choices && !picked.length && problem.type !== 'fischer' ? true : false)} className="flex-1 rounded-lg bg-accent py-2 text-[13px] font-semibold text-accent-ink disabled:opacity-50" data-testid="check-answer">
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button onClick={nextHint} disabled={hints >= 5} className="rounded-lg border border-border px-3 py-2 text-[12.5px] hover:border-amber disabled:opacity-40" data-testid="hint-button">
            Hint {hints}/5
          </button>
        </div>
      )}

      {feedback && <FeedbackCard problem={problem} />}

      <div className="flex items-center justify-between pt-1">
        <button onClick={leave} className="text-[12px] text-text-3 hover:text-text">← All practice</button>
        {done ? (
          <button onClick={() => void startProblem()} className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink" data-testid="next-problem">
            Next problem <I.ChevronRight size={14} />
          </button>
        ) : (
          <button onClick={() => usePractice.setState({ feedback: reveal(problem) })} className="text-[12px] text-text-3 hover:text-text" data-testid="give-up">Show answer</button>
        )}
      </div>
    </div>
  );
}

function reveal(p: Problem) {
  const answer =
    p.type === 'name' ? p.trace?.name : p.type === 'build' ? p.targetName : p.choices ? p.answer?.map((a) => p.choices!.find((c) => c.id === a)?.label ?? a).join(', ') : p.type === 'acidity' ? [...(p.acidity ?? [])].sort((a, b) => a.pKa - b.pKa).map((x) => x.name).join(' > ') : undefined;
  return { verdict: 'wrong' as const, title: 'Answer shown', detail: answer ? [`Answer: ${answer}`] : ['See the highlighted atoms on the model.'], reveal: p.type === 'name' ? p.trace?.name : undefined };
}

function Choices({ problem, disabled }: { problem: Problem; disabled: boolean }) {
  const picked = usePractice((s) => s.picked);
  const feedback = usePractice((s) => s.feedback);
  const toggle = (id: string) => {
    if (disabled) return;
    usePractice.setState({ picked: problem.multi ? (picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) : [id] });
  };
  const big = problem.type === 'stereo';
  return (
    <div className={big ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-1.5'} role={problem.multi ? 'group' : 'radiogroup'} aria-label="Answer choices">
      {problem.choices!.map((c) => {
        const on = picked.includes(c.id);
        const right = feedback && problem.answer?.includes(c.id);
        const wrong = feedback && on && !problem.answer?.includes(c.id);
        return (
          <button
            key={c.id}
            role={problem.multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            onClick={() => toggle(c.id)}
            data-testid={`choice-${c.id}`}
            className={`rounded-xl border px-3 transition ${big ? 'py-3 text-[20px] font-semibold italic' : 'py-1.5 text-[12.5px]'} ${
              right ? 'border-good bg-good-soft' : wrong ? 'border-danger bg-danger-soft' : on ? 'border-accent bg-accent-soft text-accent-strong' : 'border-border hover:border-border-strong'
            }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function FischerChoices({ problem, disabled }: { problem: Problem; disabled: boolean }) {
  const picked = usePractice((s) => s.picked);
  const feedback = usePractice((s) => s.feedback);
  const f = problem.fischer!;
  const opts = f.flip ? [{ id: 'A', doc: f.mirror }, { id: 'B', doc: f.correct }] : [{ id: 'A', doc: f.correct }, { id: 'B', doc: f.mirror }];
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Fischer projections">
      {opts.map((o) => {
        const on = picked.includes(o.id);
        const right = feedback && problem.answer?.includes(o.id);
        return (
          <button key={o.id} role="radio" aria-checked={on} disabled={disabled} onClick={() => usePractice.setState({ picked: [o.id] })} className={`rounded-xl border p-1.5 ${right ? 'border-good bg-good-soft' : on ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong'}`} data-testid={`choice-${o.id}`}>
            <FischerView doc={o.doc} trace={problem.trace!} />
            <span className="text-[12px] font-semibold">{o.id}</span>
          </button>
        );
      })}
    </div>
  );
}

function Acidity({ problem, disabled }: { problem: Problem; disabled: boolean }) {
  const order = usePractice((s) => s.order);
  const items = problem.acidity ?? [];
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((it) => {
          const k = order.indexOf(it.id);
          return (
            <button
              key={it.id}
              disabled={disabled}
              onClick={() => usePractice.setState({ order: k >= 0 ? order.filter((x) => x !== it.id) : [...order, it.id] })}
              className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[13px] ${k >= 0 ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-strong'}`}
              data-testid={`acid-${it.id}`}
            >
              <span className={`mono grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${k >= 0 ? 'bg-accent text-accent-ink' : 'border border-border text-text-3'}`}>{k >= 0 ? k + 1 : ''}</span>
              <span>
                <span className="block font-medium">{it.name}</span>
                <span className="mono block text-[10.5px] text-text-3">{it.smiles}</span>
              </span>
            </button>
          );
        })}
      </div>
      {order.length > 0 && !disabled && (
        <button onClick={() => usePractice.setState({ order: [] })} className="text-[11.5px] text-text-3 hover:text-text">Reset order</button>
      )}
    </div>
  );
}

function FeedbackCard({ problem }: { problem: Problem }) {
  const fb = usePractice((s) => s.feedback)!;
  const tone = fb.verdict === 'correct' ? 'good' : fb.verdict === 'almost' || fb.verdict === 'offline' ? 'amber' : fb.verdict === 'invalid' ? 'border' : 'danger';
  const cls = tone === 'good' ? 'border-good/50 bg-good-soft' : tone === 'amber' ? 'border-amber/50 bg-amber-soft' : tone === 'danger' ? 'border-danger/40 bg-danger-soft' : 'border-border bg-panel-raised';
  const icon = fb.verdict === 'correct' ? <I.Check size={16} className="text-good" /> : fb.verdict === 'almost' ? <I.Info size={16} className="text-amber" /> : <I.Alert size={16} className={fb.verdict === 'invalid' ? 'text-text-2' : 'text-danger'} />;
  // "…then animates both numberings on the molecule" — show the correct numbering after a locant slip.
  useEffect(() => {
    if (fb.concept === 'locants' && problem.trace && problem.type === 'name') {
      const t = problem.trace;
      const set = new Set(t.parent.atomIds);
      useStudio.setState((st) => ({ highlights: { ...st.highlights, 'practice:answer': { id: 'practice:answer', atoms: t.parent.atomIds, bonds: st.doc.bonds.filter((b) => set.has(b.a1) && set.has(b.a2)).map((b) => b.id), tone: 'good', labels: t.numbering.locantOf } } }));
    }
  }, [fb, problem]);
  const retry = fb.verdict === 'invalid' || fb.verdict === 'offline' || ((fb.verdict === 'almost' || fb.verdict === 'wrong') && (problem.type === 'build' || problem.type === 'repair' || problem.type === 'parent' || problem.type === 'number'));
  return (
    <div className={`fade-up space-y-2 rounded-xl border p-3 ${cls}`} data-testid="feedback" data-verdict={fb.verdict}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold leading-snug">{fb.title}</div>
          {fb.detail.filter(Boolean).map((d, k) => (
            <p key={k} className="mt-1 text-[12.5px] leading-relaxed text-text-2">{d}</p>
          ))}
        </div>
      </div>
      {fb.compare && (
        <div className="grid grid-cols-2 gap-2">
          <figure className="rounded-lg border border-border bg-panel p-1">
            <div className="[&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: fb.compare.target }} />
            <figcaption className="text-center text-[11px] text-text-3">This molecule</figcaption>
          </figure>
          <figure className="rounded-lg border border-border bg-panel p-1">
            <div className="[&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: fb.compare.yours }} />
            <figcaption className="truncate text-center text-[11px] text-text-3" title={fb.compare.yoursName}>Your name: {fb.compare.yoursName}</figcaption>
          </figure>
        </div>
      )}
      {fb.reveal && fb.verdict !== 'correct' && (
        <div className="rounded-lg bg-panel px-2.5 py-1.5 text-[12.5px]">
          Accepted name: <span className="nomen font-semibold">{fb.reveal}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {retry && (
          <button onClick={() => usePractice.setState({ feedback: null })} className="rounded-md border border-border bg-panel px-2 py-1 text-[12px] hover:border-accent">Try again</button>
        )}
        {problem.trace && fb.verdict !== 'invalid' && (
          <button onClick={() => { usePractice.setState({ problem: null, feedback: null }); clearPracticeHighlights(); useStudio.setState({ panel: 'explain', explainStep: stepFor(fb.concept) }); }} className="rounded-md border border-border bg-panel px-2 py-1 text-[12px] hover:border-accent">
            Explain it step by step
          </button>
        )}
      </div>
    </div>
  );
}

function stepFor(c?: string): number {
  return c === 'suffix' ? 0 : c === 'parent' ? 1 : c === 'locants' ? 2 : c === 'alphabetization' ? 5 : c === 'rs' || c === 'ez' ? 4 : 0;
}
