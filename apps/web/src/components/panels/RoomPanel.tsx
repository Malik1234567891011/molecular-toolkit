'use client';
import { useEffect, useRef, useState } from 'react';
import { joinRoom, leaveRoom, newRoomId, say, setMe, useRoom } from '@/lib/room';
import { I } from '../ui/icons';

export function RoomPanel() {
  const { roomId, status, me, peers, chat } = useRoom();
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [chat]);
  if (!roomId) {
    return (
      <div className="space-y-4 p-4" data-testid="room-panel">
        <p className="text-[13px] leading-relaxed text-text-2">Study together: everyone in a room sees the same molecule, each other’s cursors, and a shared chat — with the tutor if you type <span className="mono">@tutor</span>.</p>
        <label className="block space-y-1 text-[12.5px]">
          <span className="text-text-2">Your name in the room</span>
          <div className="flex items-center gap-2">
            <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: me.color }} />
            <input value={me.name} onChange={(e) => setMe({ name: e.target.value.slice(0, 32) })} className="flex-1 rounded-lg border border-border bg-panel-raised px-2.5 py-1.5 text-[13px]" aria-label="Your name" />
          </div>
        </label>
        <button onClick={() => void joinRoom(newRoomId())} className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent py-2.5 text-[13.5px] font-semibold text-accent-ink" data-testid="room-create">
          <I.Users size={16} /> Start a room with this molecule
        </button>
        <form onSubmit={(e) => { e.preventDefault(); const id = code.trim().replace(/.*[?&]room=/, ''); if (/^[\w-]{4,64}$/.test(id)) void joinRoom(id); }} className="flex gap-1.5">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code or link" className="min-w-0 flex-1 rounded-lg border border-border bg-panel-raised px-2.5 py-1.5 text-[13px]" aria-label="Room code or link" data-testid="room-code" />
          <button type="submit" className="rounded-lg border border-border px-3 text-[13px] hover:border-accent">Join</button>
        </form>
        <p className="text-[11.5px] text-text-3">Rooms are temporary and private to people with the link. Nothing is stored on the server.</p>
      </div>
    );
  }
  const link = `${location.origin}/?room=${roomId}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="room-panel">
      <div className="space-y-2 border-b border-border p-4">
        <div className="flex items-center justify-between">
          <span className="mono text-[13px] font-semibold">{roomId}</span>
          <span className={`flex items-center gap-1 text-[11.5px] ${status === 'connected' ? 'text-good' : 'text-amber'}`} data-testid="room-status">
            <span className={`h-2 w-2 rounded-full ${status === 'connected' ? 'bg-good' : 'bg-amber'}`} /> {status}
          </span>
        </div>
        <div className="flex gap-1.5">
          <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="mono min-w-0 flex-1 rounded-lg border border-border bg-panel-raised px-2 py-1 text-[11.5px]" aria-label="Room link" />
          <button onClick={() => void navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })} className="rounded-lg border border-border px-2 text-[12px] hover:border-accent">{copied ? 'Copied' : 'Copy link'}</button>
        </div>
        <ul className="flex flex-wrap gap-1.5" aria-label="People in the room" data-testid="room-peers">
          <li className="flex items-center gap-1 rounded-full bg-panel-raised px-2 py-0.5 text-[12px]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: me.color }} /> {me.name} (you)</li>
          {peers.map((p) => (
            <li key={p.clientId} className="flex items-center gap-1 rounded-full bg-panel-raised px-2 py-0.5 text-[12px]"><span className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} /> {p.name}</li>
          ))}
        </ul>
        {!peers.length && <p className="text-[12px] text-text-3">Send the link to friends — the molecule, edits and cursors sync live.</p>}
      </div>
      <div ref={scroller} className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" data-testid="room-chat">
        {chat.map((m) => (
          <div key={m.id} className={`rounded-xl px-3 py-2 text-[13px] ${m.tutor ? 'border border-accent/40 bg-accent-soft' : 'bg-panel-raised'}`}>
            <div className="mb-0.5 flex items-center gap-1 text-[11.5px] font-semibold" style={{ color: m.color }}>{m.tutor && <I.Sparkle size={12} />}{m.name}</div>
            <div className="whitespace-pre-wrap leading-relaxed">{m.text}</div>
          </div>
        ))}
        {!chat.length && <p className="text-[12.5px] text-text-3">Chat here. Start a message with <span className="mono">@tutor</span> to ask the tutor for everyone.</p>}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void say(text); setText(''); }} className="flex gap-1.5 border-t border-border p-2.5">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the room…" className="min-w-0 flex-1 rounded-xl border border-border bg-panel-raised px-3 py-2 text-[13px]" aria-label="Message the room" data-testid="room-input" />
        <button type="submit" disabled={!text.trim()} className="rounded-xl bg-accent px-3 text-[12.5px] font-semibold text-accent-ink disabled:opacity-40">Send</button>
      </form>
      <button onClick={leaveRoom} className="border-t border-border py-1.5 text-[12px] text-text-3 hover:text-danger">Leave room</button>
    </div>
  );
}
