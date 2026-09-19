'use client';
import { useState } from 'react';
import { RAIL_ELEMENTS, ELEMENTS, COURSE_SCOPE_ELEMENTS } from '@orbital/chem';
import { useStudio, studio, type Tool2D } from '@/lib/store';
import { atomColor } from '@/lib/colors';
import { useResolvedTheme } from '@/lib/useTheme';
import { attachSmiles, setElement } from '@/lib/edit';
import { FRAGMENTS, RING_BUTTONS, pendantRing } from '@/lib/templates';
import { newBondAngle2D } from '@/lib/edit';
import { I } from '../ui/icons';

function RailButton({ active, onClick, title, children, testid }: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode; testid?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testid}
      className={`grid h-10 w-10 place-items-center rounded-xl text-[14px] font-semibold transition ${active ? 'bg-accent text-accent-ink shadow' : 'text-text-2 hover:bg-panel-raised hover:text-text'}`}
    >
      {children}
    </button>
  );
}

const TOOLS: Array<{ tool: Tool2D; title: string; icon: React.ReactNode; key?: string }> = [
  { tool: 'select', title: 'Select / move (V)', icon: <I.Pointer size={17} />, key: 'V' },
  { tool: 'draw', title: 'Draw atoms and bonds (B)', icon: <I.Pen size={17} />, key: 'B' },
  { tool: 'chain', title: 'Chain — drag to draw a zig-zag carbon chain', icon: <I.Chain size={18} /> },
  { tool: 'ring', title: 'Ring templates (R)', icon: <I.Hexagon size={18} />, key: 'R' },
  { tool: 'erase', title: 'Erase', icon: <I.Eraser size={17} /> },
  { tool: 'charge+', title: 'Increase charge', icon: <span className="text-[15px]">⊕</span> },
  { tool: 'charge-', title: 'Decrease charge', icon: <span className="text-[15px]">⊖</span> },
  { tool: 'wedge', title: 'Wedge bond (W) — toward you', icon: <I.Wedge size={17} />, key: 'W' },
  { tool: 'hash', title: 'Hashed bond (D) — away from you', icon: <I.Hash size={17} />, key: 'D' },
  { tool: 'wavy', title: 'Wavy bond — unknown configuration', icon: <I.Wavy size={17} /> },
];

export function ElementRail() {
  const armed = useStudio((s) => s.armedElement);
  const tool = useStudio((s) => s.tool2d);
  const view = useStudio((s) => s.view);
  const ringSize = useStudio((s) => s.ringSize);
  const ringAromatic = useStudio((s) => s.ringAromatic);
  const theme = useResolvedTheme();
  const [table, setTable] = useState(false);
  const [section, setSection] = useState<'rings' | 'groups' | null>(null);

  const arm = (el: string) => {
    const s = studio();
    useStudio.setState({ armedElement: el, tool2d: s.tool2d === 'select' || s.tool2d === 'erase' ? 'draw' : s.tool2d });
    if (s.selection.atoms.length === 1) setElement(s.selection.atoms[0], el);
  };

  const ring = (size: number, aromatic: boolean) => {
    useStudio.setState({ ringSize: size, ringAromatic: aromatic, tool2d: 'ring' });
    const s = studio();
    // In 3D (or with an atom selected) attach the ring directly to the selected atom.
    if (s.selection.atoms.length === 1 && (s.view === '3d' || s.view === 'split')) {
      const at = s.selection.atoms[0];
      const frag = pendantRing(size, aromatic, s.doc.layout2d[at] ?? [0, 0], newBondAngle2D(s.doc, at));
      s.apply({ type: 'addFragment', fragment: frag, bondFrom: { atomId: at, fragmentAtomId: frag.atoms[0].id, order: 1 } }, { label: 'Add ring' });
    } else if (!s.doc.atoms.length) {
      import('@/lib/templates').then(({ ringTemplate }) => s.apply({ type: 'addFragment', fragment: ringTemplate(size, aromatic, [0, 0]) }, { label: 'Add ring' }));
    }
    setSection(null);
  };

  return (
    <aside className="panel relative z-20 flex w-[58px] shrink-0 flex-col items-center gap-1 overflow-y-auto border-y-0 border-l-0 py-2 scroll-thin" aria-label="Element and tool rail">
      {(view === '2d' || view === 'split') && (
        <>
          {TOOLS.map((t) => (
            <RailButton key={t.tool} active={tool === t.tool} onClick={() => useStudio.setState({ tool2d: t.tool })} title={t.title} testid={`tool-${t.tool}`}>
              {t.icon}
            </RailButton>
          ))}
          <div className="my-1 h-px w-8 bg-border" />
        </>
      )}
      {RAIL_ELEMENTS.map((el) => (
        <RailButton key={el} active={armed === el} onClick={() => arm(el)} title={`${el} — arm, or replace the selected atom (${el.length === 1 ? el : el[0] + ' then ' + el[1]})`} testid={`el-${el}`}>
          <span style={{ color: armed === el ? undefined : el === 'C' || el === 'H' ? undefined : atomColor(el, theme) }}>{el}</span>
        </RailButton>
      ))}
      <RailButton onClick={() => setTable(true)} title="Full periodic table" testid="periodic">
        <I.Grid size={16} />
      </RailButton>
      <div className="my-1 h-px w-8 bg-border" />
      <RailButton active={section === 'rings'} onClick={() => setSection(section === 'rings' ? null : 'rings')} title="Rings" testid="rail-rings">
        <I.Hexagon size={18} />
      </RailButton>
      <RailButton active={section === 'groups'} onClick={() => setSection(section === 'groups' ? null : 'groups')} title="Common groups (attach to the selected atom)" testid="rail-groups">
        <span className="text-[11px]">R–</span>
      </RailButton>
      {section && (
        <div className="glass fade-up fixed left-[66px] z-40 w-[210px] rounded-2xl p-2" style={{ top: 120 }}>
          {section === 'rings' ? (
            <div className="grid grid-cols-2 gap-1">
              {RING_BUTTONS.map((r) => (
                <button key={r.label} onClick={() => ring(r.size, r.aromatic)} className={`rounded-lg border px-2 py-1.5 text-left text-[12px] hover:border-accent ${ringSize === r.size && ringAromatic === r.aromatic ? 'border-accent bg-accent-soft' : 'border-border bg-panel-raised'}`}>
                  {r.label}
                </button>
              ))}
              <p className="col-span-2 mt-1 text-[11px] leading-snug text-text-3">2D: click empty space, an atom (attach), a bond (fuse), or ⇧-click an atom (spiro).</p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1">
              {FRAGMENTS.map((f) => (
                <button
                  key={f.label}
                  title={f.hint}
                  onClick={() => {
                    const s = studio();
                    if (s.selection.atoms.length !== 1) {
                      s.notify({ kind: 'info', text: 'Select one atom first, then pick a group to attach.' });
                      return;
                    }
                    void attachSmiles(s.selection.atoms[0], f.smiles);
                    setSection(null);
                  }}
                  className="rounded-lg border border-border bg-panel-raised px-1 py-1.5 text-[12px] hover:border-accent"
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {table && <PeriodicTable onClose={() => setTable(false)} onPick={(el) => { arm(el); setTable(false); }} />}
    </aside>
  );
}

function PeriodicTable({ onClose, onPick }: { onClose: () => void; onPick: (el: string) => void }) {
  const theme = useResolvedTheme();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-label="Periodic table">
      <div className="glass fade-up max-w-[980px] rounded-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold">Periodic table</div>
            <div className="text-[12px] text-text-3">Highlighted elements are inside the verified course scope; others can be drawn, but naming will say “outside verified course scope”.</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-panel-raised" aria-label="Close">
            <I.X size={18} />
          </button>
        </div>
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(18, minmax(0, 1fr))' }}>
          {ELEMENTS.filter((e) => e.z <= 118).map((e) => {
            const fblock = (e.z >= 57 && e.z <= 71) || (e.z >= 89 && e.z <= 103);
            const col = fblock ? 3 + ((e.z >= 89 ? e.z - 89 : e.z - 57)) : e.group;
            const row = fblock ? (e.period === 6 ? 9 : 10) : e.period;
            const inScope = COURSE_SCOPE_ELEMENTS.has(e.symbol);
            return (
              <button
                key={e.symbol}
                onClick={() => onPick(e.symbol)}
                title={`${e.name} (${e.z})`}
                className={`flex h-10 w-11 flex-col items-center justify-center rounded-md border text-[12px] font-semibold transition hover:scale-105 ${inScope ? 'border-accent/60 bg-accent-soft' : 'border-border bg-panel-raised opacity-80'}`}
                style={{ gridColumn: col, gridRow: row }}
              >
                <span style={{ color: e.symbol === 'C' || e.symbol === 'H' ? undefined : atomColor(e.symbol, theme) }}>{e.symbol}</span>
                <span className="text-[8.5px] font-normal text-text-3">{e.z}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
