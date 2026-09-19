/**
 * Shared pieces for textbook-style 2D sketches with curved electron-pushing arrows
 * (mechanisms and resonance). Coordinates are in bond-length units, y up.
 */
import { MolView, type MoleculeDocument } from '@orbital/chem';

/** Arrow endpoints address atoms by number (mechanism map numbers, or atom index + 1). */
export interface CurvedArrow {
  from: { lp: number } | { bond: [number, number] };
  to: { atom: number } | { bond: [number, number] };
  /** +1 bows to the left of travel (default), −1 to the right. */
  bend?: 1 | -1;
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
export function atomLabel(doc: MoleculeDocument, i: number, view: MolView): string {
  const a = doc.atoms[i];
  const h = view.implicitH(i);
  const hs = h ? `H${h > 1 ? SUB[h] : ''}` : '';
  // Isolated O/N read naturally with H first (H₂O, HO⁻, H₃O⁺); otherwise element first (OH, CH₃).
  const isolated = view.nbrs[i].filter((j) => doc.atoms[j].element !== 'H').length === 0 && view.nbrs[i].length === 0;
  return (a.element === 'O' || a.element === 'N') && isolated ? `${hs}${a.element}` : `${a.element}${hs}`;
}

/** Quadratic arrow from the electron source to its destination, bowed to one side. Returns [[x0,y0],[cx,cy,x1,y1]]. */
export function arrowPath(a: CurvedArrow, byMap: Map<number, [number, number]>, lpOffset?: (atom: number) => [number, number]): number[][] | null {
  const pt = (m: number) => byMap.get(m);
  const mid = (x: number, y: number) => {
    const p = pt(x);
    const q = pt(y);
    return p && q ? ([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number]) : null;
  };
  const endRaw = 'atom' in a.to ? pt(a.to.atom) : mid(a.to.bond[0], a.to.bond[1]);
  let start = 'lp' in a.from ? pt(a.from.lp) : mid(a.from.bond[0], a.from.bond[1]);
  if (!start || !endRaw) return null;
  if ('lp' in a.from) {
    const [ox, oy] = lpOffset?.(a.from.lp) ?? [0, 0.38];
    start = [start[0] + ox, start[1] + oy];
  }
  const dx = endRaw[0] - start[0];
  const dy = endRaw[1] - start[1];
  const len = Math.hypot(dx, dy) || 1;
  const sign = a.bend ?? 1;
  const nx = -dy / len;
  const ny = dx / len;
  // Short hops (a bond's electrons moving onto one of its own atoms) are drawn as a hook that
  // lifts off the bond and lands just beside the atom, the way textbooks draw them.
  if (len < 1.0) {
    const s2: [number, number] = [start[0] + nx * 0.14 * sign, start[1] + ny * 0.14 * sign];
    const e2: [number, number] = 'atom' in a.to ? [endRaw[0] + nx * 0.34 * sign - (dx / len) * 0.12, endRaw[1] + ny * 0.34 * sign - (dy / len) * 0.12] : [endRaw[0] + nx * 0.14 * sign, endRaw[1] + ny * 0.14 * sign];
    const c2: [number, number] = [(s2[0] + e2[0]) / 2 + nx * 0.55 * sign, (s2[1] + e2[1]) / 2 + ny * 0.55 * sign];
    return [[s2[0], s2[1]], [c2[0], c2[1], e2[0], e2[1]]];
  }
  // Stop short of an atom label; bonds are hit at their midpoint.
  const back = 'atom' in a.to ? 0.42 : 0.12;
  const end: [number, number] = [endRaw[0] - (dx / len) * back, endRaw[1] - (dy / len) * back];
  const bend = sign * Math.max(0.45, len * 0.38);
  const c: [number, number] = [(start[0] + end[0]) / 2 + nx * bend, (start[1] + end[1]) / 2 + ny * bend];
  return [[start[0], start[1]], [c[0], c[1], end[0], end[1]]];
}
