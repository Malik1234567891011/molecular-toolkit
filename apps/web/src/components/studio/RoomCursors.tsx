'use client';
import { useEffect, useRef } from 'react';
import { moveCursor, useRoom } from '@/lib/room';

/** Other people's pointers over the canvas (Figma-style), plus sending our own. */
export function RoomCursors({ container }: { container: React.RefObject<HTMLDivElement | null> }) {
  const roomId = useRoom((s) => s.roomId);
  const peers = useRoom((s) => s.peers);
  const last = useRef(0);
  useEffect(() => {
    const el = container.current;
    if (!roomId || !el) return;
    const move = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last.current < 40) return;
      last.current = now;
      const r = el.getBoundingClientRect();
      moveCursor({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
    };
    const leave = () => moveCursor(null);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [roomId, container]);
  if (!roomId) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-hidden data-testid="room-cursors">
      {peers.filter((p) => p.cursor).map((p) => (
        <div key={p.clientId} className="absolute transition-all duration-75 ease-linear" style={{ left: `${p.cursor!.x * 100}%`, top: `${p.cursor!.y * 100}%` }}>
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 2 L15 8 L9 10 L7 16 Z" fill={p.color} stroke="#0b0e14" strokeWidth="1.2" /></svg>
          <span className="ml-3 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-[#0b0e14]" style={{ background: p.color }}>{p.name}</span>
        </div>
      ))}
    </div>
  );
}
