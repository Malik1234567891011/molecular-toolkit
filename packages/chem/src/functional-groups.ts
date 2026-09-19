import { MolView } from './graph.ts';
import { perceiveRings, type RingInfo } from './rings.ts';
import type { AtomId, MoleculeDocument } from './types.ts';

export type FGKind =
  | 'carboxylate' | 'carboxylic-acid' | 'anhydride' | 'ester' | 'lactone' | 'acid-halide' | 'amide' | 'lactam'
  | 'nitrile' | 'aldehyde' | 'ketone' | 'alcohol' | 'phenol' | 'enol' | 'thiol' | 'amine' | 'ammonium'
  | 'imine' | 'ether' | 'epoxide' | 'sulfide' | 'disulfide' | 'sulfoxide' | 'sulfone' | 'sulfonic-acid'
  | 'nitro' | 'alkyl-halide' | 'aryl-halide' | 'vinyl-halide' | 'alkene' | 'alkyne' | 'arene' | 'heteroarene'
  | 'alkoxide' | 'enolate' | 'carbocation' | 'carbanion' | 'oxonium' | 'thioester' | 'phosphate';

export interface FunctionalGroup {
  kind: FGKind;
  label: string;
  /** Heavy atoms that make up the group. */
  atomIds: AtomId[];
  /** Key atom(s): the carbonyl carbon, the hydroxyl oxygen, the halogen … */
  centreIds: AtomId[];
  detail?: string;
}

export const FG_LABEL: Record<FGKind, string> = {
  'carboxylate': 'carboxylate', 'carboxylic-acid': 'carboxylic acid', 'anhydride': 'acid anhydride', 'ester': 'ester',
  'lactone': 'lactone (cyclic ester)', 'acid-halide': 'acid halide', 'amide': 'amide', 'lactam': 'lactam (cyclic amide)',
  'nitrile': 'nitrile', 'aldehyde': 'aldehyde', 'ketone': 'ketone', 'alcohol': 'alcohol', 'phenol': 'phenol',
  'enol': 'enol', 'thiol': 'thiol', 'amine': 'amine', 'ammonium': 'ammonium ion', 'imine': 'imine', 'ether': 'ether',
  'epoxide': 'epoxide', 'sulfide': 'sulfide (thioether)', 'disulfide': 'disulfide', 'sulfoxide': 'sulfoxide',
  'sulfone': 'sulfone', 'sulfonic-acid': 'sulfonic acid', 'nitro': 'nitro', 'alkyl-halide': 'haloalkane (alkyl halide)',
  'aryl-halide': 'aryl halide', 'vinyl-halide': 'vinyl halide', 'alkene': 'alkene', 'alkyne': 'alkyne',
  'arene': 'aromatic ring', 'heteroarene': 'heteroaromatic ring', 'alkoxide': 'alkoxide', 'enolate': 'enolate',
  'carbocation': 'carbocation', 'carbanion': 'carbanion', 'oxonium': 'oxonium ion', 'thioester': 'thioester',
  'phosphate': 'phosphate',
};

const HALOGENS = new Set(['F', 'Cl', 'Br', 'I']);

export function detectFunctionalGroups(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>, ringInfo?: RingInfo): FunctionalGroup[] {
  const v = new MolView(doc);
  const rings = ringInfo ?? perceiveRings(v);
  const out: FunctionalGroup[] = [];
  const id = (i: number) => v.atoms[i].id;
  const el = (i: number) => v.el(i);
  const bo = (i: number, j: number) => {
    const b = v.bondBetween(i, j);
    return b < 0 ? 0 : v.bonds[b].order;
  };
  const sameRing = (i: number, j: number) => rings.atomRings[i].some((r) => rings.atomRings[j].includes(r));
  const isCarbonylC = (i: number) => el(i) === 'C' && v.nbrs[i].some((j) => el(j) === 'O' && bo(i, j) === 2);
  const aromatic = (i: number) => v.atoms[i].aromatic;
  const add = (kind: FGKind, atoms: number[], centres: number[], detail?: string) =>
    out.push({ kind, label: FG_LABEL[kind], atomIds: [...new Set(atoms)].map(id), centreIds: centres.map(id), detail });
  const used = new Set<string>();
  const key = (kind: string, atoms: number[]) => kind + ':' + [...atoms].sort((a, b) => a - b).join(',');
  const addOnce = (kind: FGKind, atoms: number[], centres: number[], detail?: string) => {
    const k = key(kind, atoms);
    if (used.has(k)) return;
    used.add(k);
    add(kind, atoms, centres, detail);
  };

  for (let i = 0; i < v.atomCount; i++) {
    const e = el(i);
    const q = v.atoms[i].formalCharge;
    if (e === 'C') {
      const oxo = v.nbrs[i].find((j) => el(j) === 'O' && bo(i, j) === 2 && v.nbrs[j].length === 1);
      if (oxo !== undefined) {
        const others = v.nbrs[i].filter((j) => j !== oxo);
        const oh = others.find((j) => el(j) === 'O' && bo(i, j) === 1 && v.nbrs[j].length === 1 && v.atoms[j].formalCharge === 0 && v.totalH(j) === 1);
        const ominus = others.find((j) => el(j) === 'O' && bo(i, j) === 1 && v.nbrs[j].length === 1 && v.atoms[j].formalCharge === -1);
        const oBridge = others.find((j) => el(j) === 'O' && bo(i, j) === 1 && v.nbrs[j].length === 2);
        const n = others.find((j) => el(j) === 'N' && bo(i, j) === 1);
        const s = others.find((j) => el(j) === 'S' && bo(i, j) === 1 && v.nbrs[j].length === 2);
        const x = others.find((j) => HALOGENS.has(el(j)));
        const carbons = others.filter((j) => el(j) === 'C');
        if (oh !== undefined) addOnce('carboxylic-acid', [i, oxo, oh], [i]);
        else if (ominus !== undefined) addOnce('carboxylate', [i, oxo, ominus], [i]);
        else if (oBridge !== undefined) {
          const partner = v.nbrs[oBridge].find((j) => j !== i)!;
          if (isCarbonylC(partner)) {
            const oxo2 = v.nbrs[partner].find((j) => el(j) === 'O' && bo(partner, j) === 2)!;
            addOnce('anhydride', [i, oxo, oBridge, partner, oxo2], [i, partner]);
          } else if (sameRing(i, oBridge)) addOnce('lactone', [i, oxo, oBridge], [i]);
          else addOnce('ester', [i, oxo, oBridge, partner], [i]);
        } else if (n !== undefined) addOnce(sameRing(i, n) ? 'lactam' : 'amide', [i, oxo, n], [i]);
        else if (s !== undefined) addOnce('thioester', [i, oxo, s], [i]);
        else if (x !== undefined) addOnce('acid-halide', [i, oxo, x], [i]);
        else if (carbons.length === 2) addOnce('ketone', [i, oxo], [i]);
        else if (carbons.length <= 1 && v.totalH(i) >= 1) addOnce('aldehyde', [i, oxo], [i]);
        else if (carbons.length === 1 && others.length === 1) addOnce('ketone', [i, oxo], [i]);
      }
      const nitrile = v.nbrs[i].find((j) => el(j) === 'N' && bo(i, j) === 3);
      if (nitrile !== undefined) addOnce('nitrile', [i, nitrile], [i]);
      if (q === 1 && !aromatic(i) && v.bondOrderSum(i) + v.implicitH(i) === 3) addOnce('carbocation', [i], [i]);
      if (q === -1 && !aromatic(i)) addOnce('carbanion', [i], [i]);
      for (const j of v.nbrs[i]) {
        if (j < i || el(j) !== 'C') continue;
        const o = bo(i, j);
        if (o === 2 && !(aromatic(i) && aromatic(j))) addOnce('alkene', [i, j], [i, j]);
        if (o === 3) addOnce('alkyne', [i, j], [i, j]);
      }
    } else if (e === 'O') {
      const deg = v.nbrs[i].length;
      if (deg === 1 && bo(i, v.nbrs[i][0]) === 1) {
        const c = v.nbrs[i][0];
        if (el(c) !== 'C' || isCarbonylC(c)) continue;
        const enol = v.nbrs[c].some((j) => el(j) === 'C' && bo(c, j) === 2 && !(aromatic(c) && aromatic(j)));
        if (q === 0 && v.totalH(i) === 1) addOnce(aromatic(c) ? 'phenol' : enol ? 'enol' : 'alcohol', [i, c], [i]);
        if (q === -1) addOnce(enol ? 'enolate' : 'alkoxide', [i, c], [i]);
      } else if (deg === 2 && q === 0) {
        const [a, b] = v.nbrs[i];
        if (el(a) === 'C' && el(b) === 'C' && !isCarbonylC(a) && !isCarbonylC(b) && !aromatic(i)) {
          const ring3 = rings.atomRings[i].some((r) => rings.rings[r].atoms.length === 3);
          addOnce(ring3 ? 'epoxide' : 'ether', [a, i, b], [i]);
        }
      } else if (q === 1 && v.nbrs[i].length + v.implicitH(i) === 3) addOnce('oxonium', [i, ...v.nbrs[i]], [i]);
    } else if (e === 'S') {
      const oxos = v.nbrs[i].filter((j) => el(j) === 'O' && bo(i, j) === 2);
      const cs = v.nbrs[i].filter((j) => el(j) === 'C');
      if (oxos.length === 2 && cs.length === 1) {
        const oh = v.nbrs[i].find((j) => el(j) === 'O' && bo(i, j) === 1 && v.totalH(j) === 1);
        if (oh !== undefined) addOnce('sulfonic-acid', [i, ...oxos, oh], [i]);
      } else if (oxos.length === 2 && cs.length === 2) addOnce('sulfone', [i, ...oxos], [i]);
      else if (oxos.length === 1 && cs.length === 2) addOnce('sulfoxide', [i, oxos[0]], [i]);
      else if (oxos.length === 0 && v.nbrs[i].length === 1 && cs.length === 1 && v.totalH(i) === 1) addOnce('thiol', [i, cs[0]], [i]);
      else if (oxos.length === 0 && cs.length === 2 && !aromatic(i) && !cs.some(isCarbonylC)) addOnce('sulfide', [cs[0], i, cs[1]], [i]);
      const ss = v.nbrs[i].find((j) => el(j) === 'S');
      if (ss !== undefined && ss > i) addOnce('disulfide', [i, ss], [i, ss]);
    } else if (e === 'N') {
      const oNbrs = v.nbrs[i].filter((j) => el(j) === 'O');
      if (q === 1 && oNbrs.length === 2 && oNbrs.some((j) => bo(i, j) === 2) && oNbrs.some((j) => v.atoms[j].formalCharge === -1)) {
        addOnce('nitro', [i, ...oNbrs], [i]);
        continue;
      }
      if (v.nbrs[i].some((j) => isCarbonylC(j) && bo(i, j) === 1)) continue; // amide nitrogen
      if (v.nbrs[i].some((j) => bo(i, j) === 3)) continue; // nitrile nitrogen
      const dbl = v.nbrs[i].find((j) => el(j) === 'C' && bo(i, j) === 2);
      if (dbl !== undefined && !aromatic(i)) {
        addOnce('imine', [i, dbl], [i]);
        continue;
      }
      if (aromatic(i)) continue;
      const cs = v.nbrs[i].filter((j) => el(j) === 'C');
      if (q === 1 && v.nbrs[i].length + v.implicitH(i) === 4) addOnce('ammonium', [i, ...cs], [i]);
      else if (q === 0 && cs.length >= 1 && v.nbrs[i].every((j) => bo(i, j) === 1)) {
        const degree = cs.length === 1 ? 'primary' : cs.length === 2 ? 'secondary' : 'tertiary';
        addOnce('amine', [i], [i], degree);
      }
    } else if (HALOGENS.has(e) && v.nbrs[i].length === 1) {
      const c = v.nbrs[i][0];
      if (el(c) !== 'C' || isCarbonylC(c)) continue;
      const vinyl = v.nbrs[c].some((j) => bo(c, j) === 2 && !aromatic(c));
      addOnce(aromatic(c) ? 'aryl-halide' : vinyl ? 'vinyl-halide' : 'alkyl-halide', [i, c], [i]);
    } else if (e === 'P') {
      const os = v.nbrs[i].filter((j) => el(j) === 'O');
      if (os.length === 4) addOnce('phosphate', [i, ...os], [i]);
    }
  }
  for (const r of rings.rings) {
    if (!r.atoms.every((a) => aromatic(a))) continue;
    const hetero = r.atoms.some((a) => el(a) !== 'C');
    addOnce(hetero ? 'heteroarene' : 'arene', r.atoms, r.atoms);
  }
  return out;
}

/** Grouped summary for the facts card: kind → count. */
export function summarizeGroups(groups: FunctionalGroup[]): Array<{ kind: FGKind; label: string; count: number; detail?: string }> {
  const map = new Map<string, { kind: FGKind; label: string; count: number; detail?: string }>();
  for (const g of groups) {
    const k = g.kind + (g.detail ?? '');
    const cur = map.get(k);
    if (cur) cur.count++;
    else map.set(k, { kind: g.kind, label: g.detail ? `${g.detail} ${g.label}` : g.label, count: 1, detail: g.detail });
  }
  return [...map.values()];
}
