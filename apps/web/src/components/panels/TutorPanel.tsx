'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useStudio, studio } from '@/lib/store';
import { tryApi } from '@/lib/api';
import { applyProposal, ask, clearChat, clearTutorHighlights, dismissProposal, stop, useTutor, type NameCheck, type TutorAction, type TutorMessage } from '@/lib/tutor';
import { I } from '../ui/icons';

const SUGGESTIONS = [
  'Why was this parent chain chosen?',
  'Why is this R and not S?',
  'Why is this carbon sp²?',
  'Give me a hint, not the answer — how do I name this?',
  'Turn this into a practice question',
  'Walk me through an SN2 on this',
];

export function TutorPanel() {
  const messages = useTutor((s) => s.messages);
  const busy = useTutor((s) => s.busy);
  const available = useTutor((s) => s.available);
  const hasMol = useStudio((s) => s.doc.atoms.length > 0);
  const [q, setQ] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (available !== null) return;
    void tryApi<{ available: boolean }>('/tutor/status').then((r) => useTutor.setState({ available: r?.available ?? false }));
  }, [available]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);
  useEffect(() => () => clearTutorHighlights(), []);
  const send = (text: string) => {
    if (!text.trim()) return;
    void ask(text);
    setQ('');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tutor-panel">
      <div ref={scroller} className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!messages.length && (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-text-2">
              Ask about the molecule on screen. The tutor sees it as computed data — graph, CIP priorities, naming trace — and points at atoms instead of guessing.
              {available === false && ' The AI service is unavailable right now, so answers come straight from the computed chemistry.'}
            </p>
            {hasMol ? (
              <div className="flex flex-col gap-1.5">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-xl border border-border px-3 py-2 text-left text-[12.5px] hover:border-accent" data-testid="tutor-suggestion">
                    {s}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-text-3">Load or build a molecule first.</p>
            )}
            <p className="text-[11px] leading-relaxed text-text-3">Names the tutor writes are parsed and compared to the structure before you see a badge. It can suggest changes, but only you can apply them. Conversations are not stored.</p>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(q);
        }}
        className="flex items-end gap-1.5 border-t border-border p-2.5"
      >
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(q);
            }
          }}
          rows={1}
          placeholder={hasMol ? 'Ask this molecule…' : 'Load a molecule to ask about it'}
          disabled={!hasMol}
          className="max-h-32 min-h-9 flex-1 resize-none rounded-xl border border-border bg-panel-raised px-3 py-2 text-[13px] outline-none focus:border-accent"
          aria-label="Ask the tutor"
          data-testid="tutor-input"
        />
        {busy ? (
          <button type="button" onClick={stop} className="h-9 rounded-xl border border-border px-3 text-[12.5px]">Stop</button>
        ) : (
          <button type="submit" disabled={!q.trim() || !hasMol} className="h-9 rounded-xl bg-accent px-3 text-[12.5px] font-semibold text-accent-ink disabled:opacity-40" data-testid="tutor-send">Ask</button>
        )}
      </form>
      {messages.length > 0 && (
        <button onClick={clearChat} className="border-t border-border py-1.5 text-[11.5px] text-text-3 hover:text-text">Clear conversation</button>
      )}
    </div>
  );
}

function Message({ m }: { m: TutorMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13px] text-text">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="space-y-2" data-testid="tutor-reply">
      {m.actions.filter((a) => a.name !== 'propose_graph_edit').map((a, k) => (
        <ActionChip key={k} a={a} />
      ))}
      {m.text ? (
        <div className="text-[13px] leading-relaxed text-text">
          <RichText text={m.text} names={m.names} />
          {!m.done && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
        </div>
      ) : !m.done ? (
        <div className="flex items-center gap-2 text-[12.5px] text-text-3"><span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Looking at the molecule…</div>
      ) : null}
      {m.offline && <p className="text-[11px] text-text-3">From the computed data (no AI).</p>}
      {m.error && <p className="rounded-lg bg-amber-soft px-2.5 py-1.5 text-[12px] text-amber">{m.error}</p>}
      {m.actions.map((a, k) => (a.name === 'propose_graph_edit' ? <Proposal key={k} msg={m} index={k} a={a} /> : null))}
    </div>
  );
}

const STEP_LABEL: Record<string, string> = { principal_group: 'principal group', parent: 'parent', numbering: 'numbering', substituents: 'substituents', stereo: 'stereochemistry', assembly: 'assembly' };

function ActionChip({ a }: { a: TutorAction }) {
  const i = a.input;
  let text = '';
  let onClick: (() => void) | undefined;
  switch (a.name) {
    case 'highlight_atoms':
    case 'highlight_bonds':
      return (
        <div className="flex items-start gap-1.5 rounded-lg border border-border bg-panel-raised px-2 py-1 text-[11.5px] text-text-2">
          <I.Sparkle size={12} className="mt-0.5 shrink-0 text-accent-strong" />
          <span>Highlighted: <RichText text={String(i.reason ?? '')} names={[]} /></span>
        </div>
      );
    case 'measure':
      text = `Measured ${(i.atomIds as string[]).length === 2 ? 'a distance' : (i.atomIds as string[]).length === 3 ? 'an angle' : 'a dihedral'} on the model`;
      break;
    case 'explain_naming_step':
      text = `Naming step: ${STEP_LABEL[String(i.stepId)] ?? i.stepId}`;
      onClick = () => useStudio.setState({ panel: 'explain' });
      break;
    case 'compare_parent_candidates':
      text = 'Compared parent candidates on the model';
      onClick = () => useStudio.setState({ panel: 'explain', explainStep: 1 });
      break;
    case 'generate_practice_problem':
      text = `Practice: ${String(i.concept).replace(/_/g, ' ')}`;
      onClick = () => {
        const map: Record<string, [string, string]> = {
          name_structure: ['name', 'parent'], build_from_name: ['build', 'build'], parent_chain: ['parent', 'parent'], numbering: ['number', 'locants'], principal_group: ['principal', 'suffix'],
          rs: ['stereo', 'rs'], ez: ['stereo', 'ez'], mirror_image: ['fischer', 'projection'], functional_groups: ['groups', 'groups'], valence_repair: ['repair', 'valence'], bond_angle: ['geometry', 'geometry'],
        };
        const [type, concept] = map[String(i.concept)] ?? ['name', 'parent'];
        void import('@/lib/practice').then((p) => p.startProblem({ type: type as never, concept: concept as never, source: type === 'build' || type === 'repair' ? 'bank' : 'molecule' }));
        useStudio.setState({ panel: 'practice' });
      };
      break;
    case 'play_mechanism':
      text = `Mechanism: ${String(i.mechanismId).toUpperCase()}`;
      onClick = () => {
        useStudio.setState({ panel: 'mechanism' });
        setTimeout(() => import('@/lib/events').then(({ bus }) => bus.emit('mechanism:play', i.mechanismId)), 150);
      };
      break;
    default:
      text = a.name;
  }
  return (
    <button onClick={onClick} disabled={!onClick} className={`flex items-center gap-1.5 rounded-lg border border-border bg-panel-raised px-2 py-1 text-left text-[11.5px] text-text-2 ${onClick ? 'hover:border-accent hover:text-text' : ''}`}>
      <I.Sparkle size={12} className="shrink-0 text-accent-strong" /> {text}
      {onClick && <I.ChevronRight size={12} />}
    </button>
  );
}

function Proposal({ msg, index, a }: { msg: TutorMessage; index: number; a: TutorAction }) {
  const i = a.input;
  const ids = (i.atomIds as string[] | undefined) ?? [];
  useEffect(() => {
    if (a.state !== 'pending' || !ids.length) return;
    useStudio.setState((s) => ({ highlights: { ...s.highlights, 'tutor:proposal': { id: 'tutor:proposal', atoms: ids.filter((x) => s.doc.atoms.some((y) => y.id === x)), bonds: [], tone: 'amber', pulse: true, label: 'proposed change' } } }));
  }, [a.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rounded-xl border border-amber/50 bg-amber-soft p-3" data-testid="tutor-proposal">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber">Proposed change</div>
      <p className="mt-0.5 text-[13px]"><RichText text={String(i.summary ?? '')} names={[]} /></p>
      {i.action === 'load_name' && <p className="mono mt-1 text-[11px] text-text-3">Parsed by OPSIN: {String(i.smiles ?? '')}</p>}
      {a.state === 'pending' ? (
        <div className="mt-2 flex gap-1.5">
          <button onClick={() => void applyProposal(msg.id, index)} className="rounded-lg bg-accent px-3 py-1 text-[12.5px] font-semibold text-accent-ink" data-testid="apply-proposal">Apply</button>
          <button onClick={() => dismissProposal(msg.id, index)} className="rounded-lg border border-border px-3 py-1 text-[12.5px]">Dismiss</button>
        </div>
      ) : (
        <p className="mt-1.5 text-[12px] text-text-2">{a.state === 'applied' ? 'Applied — undo with ⌘Z.' : 'Dismissed.'}</p>
      )}
    </div>
  );
}

/** Render prose with [[a1,a2|label]] atom references, <name> tags, **bold** and *italic*. */
function RichText({ text, names }: { text: string; names: NameCheck[] }) {
  const parts: React.ReactNode[] = [];
  const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|<name(?:\s+ref="current")?>([\s\S]*?)<\/name>|\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1]) parts.push(<AtomRef key={k++} ids={m[1].split(',').map((x) => x.trim())} label={m[2]} />);
    else if (m[3] !== undefined) parts.push(<NameBadge key={k++} name={m[3].trim()} check={names.find((n) => n.name === m![3].trim())} />);
    else if (m[4]) parts.push(<b key={k++} className="font-semibold">{m[4]}</b>);
    else if (m[5]) parts.push(<i key={k++}>{m[5]}</i>);
    last = re.lastIndex;
  }
  // Hide a half-streamed reference or tag at the end.
  const tail = text.slice(last).replace(/(\[\[[^\]]*|<name[^>]*>?[^<]*|<\/?n?a?m?e?)$/, '');
  if (tail) parts.push(<Fragment key={k++}>{tail}</Fragment>);
  return <span className="whitespace-pre-wrap">{parts}</span>;
}

function AtomRef({ ids, label }: { ids: string[]; label?: string }) {
  const doc = useStudio((s) => s.doc);
  const locantOf = useStudio((s) => s.analysis?.naming?.trace?.numbering.locantOf);
  const known = ids.filter((id) => doc.atoms.some((a) => a.id === id.split('.')[0]));
  // Default label: element + locant (C2), so two references never read the same.
  const short = (id: string) => {
    if (id.includes('.')) return 'H';
    const el = doc.atoms.find((a) => a.id === id)?.element ?? id;
    const loc = locantOf?.[id];
    if (loc) return `${el}${loc}`;
    // Off the parent: name it by the numbered atom it hangs from ("O on C2").
    const nb = doc.bonds.filter((b) => b.a1 === id || b.a2 === id).map((b) => (b.a1 === id ? b.a2 : b.a1)).find((x) => locantOf?.[x]);
    return nb ? `${el} on C${locantOf![nb]}` : el;
  };
  const text = label ?? known.map(short).join('–');
  const on = () => useStudio.setState((s) => ({ highlights: { ...s.highlights, 'tutor:ref': { id: 'tutor:ref', atoms: known, bonds: s.doc.bonds.filter((b) => known.includes(b.a1) && known.includes(b.a2)).map((b) => b.id), tone: 'amber', pulse: true } } }));
  const off = () => studio().setHighlight('tutor:ref', null);
  return (
    <button
      onMouseEnter={on}
      onMouseLeave={off}
      onFocus={on}
      onBlur={off}
      onClick={() => studio().select(known.filter((x) => !x.includes('.')))}
      className="mx-0.5 rounded-md bg-amber-soft px-1 font-medium text-amber underline decoration-amber/40 underline-offset-2 hover:bg-amber/25"
      data-testid="atom-ref"
    >
      {text}
    </button>
  );
}

function NameBadge({ name, check }: { name: string; check?: NameCheck }) {
  const state = !check ? 'checking' : !check.parsed ? 'unparsed' : check.ref === 'current' ? (check.matchesCurrent ? 'match' : 'mismatch') : 'parsed';
  const cls = state === 'match' ? 'text-good' : state === 'mismatch' ? 'text-danger' : state === 'unparsed' ? 'text-amber' : 'text-text';
  const title =
    state === 'match' ? 'Verified: this name parses to exactly the molecule on screen' : state === 'mismatch' ? `Does not match the molecule on screen (${check?.describes})` : state === 'unparsed' ? 'Could not be parsed — treat as unverified' : state === 'parsed' ? 'Parsed to a valid structure' : 'Checking…';
  return (
    <span className={`nomen font-semibold ${cls}`} title={title} data-testid="tutor-name" data-state={state}>
      {name}
      {state === 'match' && <I.Check size={12} className="ml-0.5 inline align-[-1px]" />}
      {state === 'mismatch' && <I.Alert size={12} className="ml-0.5 inline align-[-1px]" />}
    </span>
  );
}
