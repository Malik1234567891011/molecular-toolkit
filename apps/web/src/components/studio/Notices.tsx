'use client';
import { useStudio } from '@/lib/store';
import { I } from '../ui/icons';

export function Notices() {
  const notices = useStudio((s) => s.notices);
  const dismiss = useStudio((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className="glass fade-up pointer-events-auto flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]" role={n.kind === 'error' ? 'alert' : 'status'}>
          {n.kind === 'error' ? <I.Alert size={16} className="mt-0.5 shrink-0 text-danger" /> : n.kind === 'warning' ? <I.Alert size={16} className="mt-0.5 shrink-0 text-amber" /> : n.kind === 'success' ? <I.Check size={16} className="mt-0.5 shrink-0 text-good" /> : <I.Info size={16} className="mt-0.5 shrink-0 text-text-2" />}
          <span className="flex-1 leading-snug">{n.text}</span>
          {n.action && (
            <button className="shrink-0 font-medium text-accent-strong" onClick={() => { n.action!.run(); dismiss(n.id); }}>
              {n.action.label}
            </button>
          )}
          <button onClick={() => dismiss(n.id)} className="shrink-0 text-text-3 hover:text-text" aria-label="Dismiss">
            <I.X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
