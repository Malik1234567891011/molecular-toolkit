import type { MolView } from '../graph.ts';
import type { RingInfo } from '../rings.ts';

/** Characteristic groups that can be cited as a suffix, in order of seniority (P-41). */
export type CGKind =
  | 'carboxylate' | 'alkoxide' | 'carbanion' | 'ammonium' | 'carbocation'
  | 'acid' | 'anhydride' | 'ester' | 'acidHalide' | 'amide' | 'nitrile' | 'aldehyde' | 'ketone'
  | 'alcohol' | 'thiol' | 'amine' | 'imine';

export const SENIORITY: CGKind[] = [
  'carboxylate', 'alkoxide', 'carbanion', 'ammonium', 'carbocation',
  'acid', 'anhydride', 'ester', 'acidHalide', 'amide', 'nitrile', 'aldehyde', 'ketone',
  'alcohol', 'thiol', 'amine', 'imine',
];

export const CG_LABEL: Record<CGKind, string> = {
  carboxylate: 'carboxylate (anion)', alkoxide: 'alkoxide (anion)', carbanion: 'carbanion', ammonium: 'ammonium (cation)',
  carbocation: 'carbocation', acid: 'carboxylic acid', anhydride: 'anhydride', ester: 'ester', acidHalide: 'acid halide',
  amide: 'amide', nitrile: 'nitrile', aldehyde: 'aldehyde', ketone: 'ketone', alcohol: 'alcohol', thiol: 'thiol',
  amine: 'amine', imine: 'imine',
};

/** Groups whose carbon atom is part of the group (and of a chain parent when cited as -oic acid, -al …). */
export const C_INCLUSIVE = new Set<CGKind>(['carboxylate', 'acid', 'anhydride', 'ester', 'acidHalide', 'amide', 'nitrile', 'aldehyde']);

export interface CharGroup {
  kind: CGKind;
  /** Skeletal atoms that may carry the suffix. C-inclusive groups: the group carbon itself. Amines: every attached carbon. */
  anchors: number[];
  /** Heteroatoms (and hydrogens-bearing atoms) that belong to the suffix. */
  hetero: number[];
  /** For C-inclusive groups: the group carbon. */
  carbon?: number;
  /** Nitrogen of amides / amines / imines / ammonium. */
  nitrogen?: number;
  /** Ester: the single-bonded oxygen and the carbon on the alcohol side. */
  esterO?: number;
  esterR?: number;
  /** Acid halide: the halogen. */
  halogen?: number;
  /** Anhydride: second acyl carbon. */
  partnerCarbon?: number;
}

export function detectCharGroups(view: MolView, rings: RingInfo): CharGroup[] {
  const out: CharGroup[] = [];
  const el = (i: number) => view.el(i);
  const order = (i: number, j: number) => {
    const b = view.bondBetween(i, j);
    return b < 0 ? 0 : view.bonds[b].order;
  };
  const sameRing = (i: number, j: number) => rings.atomRings[i].some((r) => rings.atomRings[j].includes(r));
  const q = (i: number) => view.atoms[i].formalCharge;
  const oxoOf = (c: number) => view.nbrs[c].find((j) => el(j) === 'O' && order(c, j) === 2 && view.nbrs[j].length === 1);
  const seenAnhydride = new Set<number>();

  for (let i = 0; i < view.atomCount; i++) {
    const e = el(i);
    if (e === 'C') {
      const oxo = oxoOf(i);
      if (oxo !== undefined && !view.atoms[i].aromatic) {
        const others = view.nbrs[i].filter((j) => j !== oxo);
        const single = (j: number) => order(i, j) === 1;
        const oh = others.find((j) => el(j) === 'O' && single(j) && view.nbrs[j].length === 1 && q(j) === 0 && view.totalH(j) === 1);
        const ominus = others.find((j) => el(j) === 'O' && single(j) && view.nbrs[j].length === 1 && q(j) === -1);
        const oBridge = others.find((j) => el(j) === 'O' && single(j) && view.nbrs[j].length === 2 && q(j) === 0);
        const n = others.find((j) => el(j) === 'N' && single(j) && q(j) === 0 && !view.atoms[j].aromatic && !rings.inRing(j));
        const x = others.find((j) => ['F', 'Cl', 'Br', 'I'].includes(el(j)) && single(j));
        const carbons = others.filter((j) => el(j) === 'C');
        if (oh !== undefined) {
          out.push({ kind: 'acid', anchors: [i], hetero: [oxo, oh], carbon: i });
          continue;
        }
        if (ominus !== undefined) {
          out.push({ kind: 'carboxylate', anchors: [i], hetero: [oxo, ominus], carbon: i });
          continue;
        }
        if (oBridge !== undefined && !sameRing(i, oBridge)) {
          const r = view.nbrs[oBridge].find((j) => j !== i)!;
          const rOxo = el(r) === 'C' ? oxoOf(r) : undefined;
          if (rOxo !== undefined) {
            if (!seenAnhydride.has(i)) {
              seenAnhydride.add(i);
              seenAnhydride.add(r);
              out.push({ kind: 'anhydride', anchors: [i], hetero: [oxo, oBridge, rOxo], carbon: i, partnerCarbon: r });
            }
            continue;
          }
          if (el(r) === 'C') {
            out.push({ kind: 'ester', anchors: [i], hetero: [oxo, oBridge], carbon: i, esterO: oBridge, esterR: r });
            continue;
          }
        }
        if (n !== undefined && !sameRing(i, n)) {
          out.push({ kind: 'amide', anchors: [i], hetero: [oxo, n], carbon: i, nitrogen: n });
          continue;
        }
        if (x !== undefined) {
          out.push({ kind: 'acidHalide', anchors: [i], hetero: [oxo, x], carbon: i, halogen: x });
          continue;
        }
        const heteroSingle = others.filter((j) => el(j) !== 'C' && el(j) !== 'H');
        if (heteroSingle.length === 0 || heteroSingle.every((j) => rings.inRing(j))) {
          // Carbonyl whose neighbours are carbons or ring heteroatoms (lactones/lactams, N-acyl heterocycles → ketone).
          if (carbons.length + heteroSingle.length >= 2) out.push({ kind: 'ketone', anchors: [i], hetero: [oxo] });
          else out.push({ kind: 'aldehyde', anchors: [i], hetero: [oxo], carbon: i });
        }
        continue;
      }
      const nitrileN = view.nbrs[i].find((j) => el(j) === 'N' && order(i, j) === 3 && view.nbrs[j].length === 1);
      if (nitrileN !== undefined) {
        out.push({ kind: 'nitrile', anchors: [i], hetero: [nitrileN], carbon: i });
        continue;
      }
      if (q(i) === 1 && !view.atoms[i].aromatic && view.bondOrderSum(i) + view.implicitH(i) === 3) out.push({ kind: 'carbocation', anchors: [i], hetero: [] });
      if (q(i) === -1 && !view.atoms[i].aromatic) out.push({ kind: 'carbanion', anchors: [i], hetero: [] });
    } else if (e === 'O' && view.nbrs[i].length === 1 && order(i, view.nbrs[i][0]) === 1) {
      const c = view.nbrs[i][0];
      if (el(c) !== 'C' || oxoOf(c) !== undefined) continue;
      if (q(i) === 0 && view.totalH(i) === 1) out.push({ kind: 'alcohol', anchors: [c], hetero: [i] });
      if (q(i) === -1) out.push({ kind: 'alkoxide', anchors: [c], hetero: [i] });
    } else if (e === 'S' && view.nbrs[i].length === 1 && q(i) === 0 && view.totalH(i) === 1) {
      const c = view.nbrs[i][0];
      if (el(c) === 'C' && order(i, c) === 1) out.push({ kind: 'thiol', anchors: [c], hetero: [i] });
    } else if (e === 'N' && !view.atoms[i].aromatic && !rings.inRing(i)) {
      const nbrs = view.nbrs[i];
      if (nbrs.some((j) => el(j) !== 'C')) continue; // hydrazines, hydroxylamines, nitro … are not amines
      if (nbrs.some((j) => oxoOf(j) !== undefined || view.nbrs[j].some((k) => el(k) === 'N' && order(j, k) === 3))) continue; // amide N / nitrile
      const dbl = nbrs.find((j) => order(i, j) === 2);
      if (dbl !== undefined && q(i) === 0) {
        out.push({ kind: 'imine', anchors: [dbl], hetero: [i], nitrogen: i });
        continue;
      }
      if (nbrs.some((j) => order(i, j) !== 1)) continue;
      if (q(i) === 1 && nbrs.length + view.implicitH(i) === 4) out.push({ kind: 'ammonium', anchors: [...nbrs], hetero: [i], nitrogen: i });
      else if (q(i) === 0 && nbrs.length >= 1) out.push({ kind: 'amine', anchors: [...nbrs], hetero: [i], nitrogen: i });
    }
  }
  return out;
}

export function principalKind(groups: CharGroup[]): CGKind | null {
  for (const k of SENIORITY) if (groups.some((g) => g.kind === k)) return k;
  return null;
}
