'use client';
import { useEffect, useRef, useState } from 'react';
import { MolView, computeImplicitH, type AtomId, type BondOrder, type Vec3 } from '@orbital/chem';
import { studio } from '@/lib/store';
import { addAtomTo } from '@/lib/edit';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';

export interface PaletteRequest {
  x: number;
  y: number;
  parent: AtomId;
  portKey?: string;
  direction?: Vec3;
}

const ELEMENTS = ['C', 'N', 'O', 'S', 'F', 'Cl', 'Br', 'I', 'P'];

/** The element palette that opens under the cursor after dragging from a port (spec §5, §7). */
export function MiniPalette({ req, onClose }: { req: PaletteRequest; onClose: () => void }) {
  const theme = useResolvedTheme();
  const [order, setOrder] = useState<BondOrder>(1);
  const [hover, setHover] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const place = (el: string) => {
    addAtomTo(req.parent, el, order, { portKey: req.portKey, direction3d: req.direction });
    onClose();
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      const up = e.key.toUpperCase();
      const hit = ELEMENTS.find((x) => x.toUpperCase() === up);
      if (hit && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        place(hit);
      }
      if (['1', '2', '3'].includes(e.key)) setOrder(Number(e.key) as BondOrder);
    };
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down, true);
    ref.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down, true);
    };
  });
  const preview = (el: string) => {
    const h = computeImplicitH({ id: 'x', element: el, formalCharge: 0, aromatic: false }, order);
    return `${el}${h ? 'H' + (h > 1 ? String(h).replace(/\d/g, (d) => '₀₁₂₃₄'[+d]) : '') : ''}`;
  };
  const parentEl = studio().doc.atoms.find((a) => a.id === req.parent);
  void MolView;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = Math.min(req.x + 12, vw - 280);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose an element"
      className="glass fade-up fixed z-50 w-[264px] rounded-2xl p-2"
      style={{ left, top: Math.max(8, req.y - 60) }}
    >
      <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] text-text-2">
        <span>
          Bond to {parentEl?.element} · {hover ? <span className="mono text-text">{preview(hover)}</span> : 'pick an element'}
        </span>
        <span className="kbd">esc</span>
      </div>
      <div className="grid grid-cols-5 gap-1">
        {ELEMENTS.map((el) => (
          <button
            key={el}
            onClick={() => place(el)}
            onMouseEnter={() => setHover(el)}
            onFocus={() => setHover(el)}
            className="flex h-11 flex-col items-center justify-center rounded-xl border border-border bg-panel-raised text-[15px] font-semibold transition hover:border-accent hover:bg-accent-soft"
            aria-label={`Add ${el}`}
          >
            <span style={{ color: el === 'C' ? undefined : atomColor(el, theme) }}>{el}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 px-1 text-[11px] text-text-2">
        Bond
        {([1, 2, 3] as BondOrder[]).map((o) => (
          <button key={o} onClick={() => setOrder(o)} className={`rounded-md px-2 py-0.5 ${order === o ? 'bg-accent text-accent-ink' : 'bg-panel-raised'}`} aria-pressed={order === o}>
            {o === 1 ? 'single' : o === 2 ? 'double' : 'triple'}
          </button>
        ))}
      </div>
    </div>
  );
}
