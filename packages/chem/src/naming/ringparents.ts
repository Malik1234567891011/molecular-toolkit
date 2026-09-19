import type { MolView } from '../graph.ts';
import type { RingInfo, RingSystem } from '../rings.ts';
import { parseSmiles } from '../smiles.ts';
import { MolView as View } from '../graph.ts';
import { chainStem } from './numerals.ts';

/** A numbering of a parent: atoms in locant order with printable labels and comparable values. */
export interface Numbering {
  atoms: number[];
  labels: string[];
  values: number[];
}

export function simpleNumbering(atoms: number[]): Numbering {
  return { atoms, labels: atoms.map((_, i) => String(i + 1)), values: atoms.map((_, i) => i + 1) };
}

export interface RingHydride {
  /** Complete names (benzene, pyridine, oxolane) take no ene/ane endings. */
  complete: boolean;
  /** Stem for carbocycles / von Baeyer / spiro: "cyclohex", "bicyclo[2.2.1]hept". */
  stem: string;
  /** Replacement prefix for von Baeyer/spiro heteroatoms, e.g. "7-oxa". */
  replacement?: string;
  /** Indicated hydrogen, e.g. "1H". */
  indicatedH?: string;
  /** Whether ring multiple bonds are expressed with ene/yne endings. */
  expressUnsaturation: boolean;
}

export interface RingParent {
  kind: 'benzene' | 'carbocycle' | 'heteromono' | 'fused' | 'vonbaeyer' | 'spiro';
  system: RingSystem;
  atoms: number[];
  numberings: Numbering[];
  heteroAtoms: number[];
  ringCount: number;
  /** Mancude (maximum non-cumulative double bonds, e.g. aromatic) parents. */
  mancude: boolean;
  label: string;
  hydride(n: Numbering): RingHydride;
  /** Atoms carrying indicated hydrogen for a numbering (locant values; lower is better). */
  indicatedH(n: Numbering): number[];
  /** Name kind for trace text. */
  describe: string;
}

// ---------------------------------------------------------------------------------------------
// Heterocycle tables

const HETERO_ORDER = ['O', 'S', 'Se', 'Te', 'N', 'P', 'Si', 'B'];
const HW_PREFIX: Record<string, string> = { O: 'oxa', S: 'thia', Se: 'selena', Te: 'tellura', N: 'aza', P: 'phospha', Si: 'sila', B: 'bora' };

/** Mancude heteromonocycles keyed by `${size}:${hetero-locants}` under Hantzsch–Widman numbering. */
const MANCUDE: Record<string, { name: string; indicated?: boolean }> = {
  '5:O1': { name: 'furan' }, '5:S1': { name: 'thiophene' }, '5:N1': { name: 'pyrrole', indicated: true },
  '5:N1,N3': { name: 'imidazole', indicated: true }, '5:N1,N2': { name: 'pyrazole', indicated: true },
  '5:O1,N3': { name: '1,3-oxazole' }, '5:O1,N2': { name: '1,2-oxazole' }, '5:S1,N3': { name: '1,3-thiazole' },
  '5:S1,N2': { name: '1,2-thiazole' }, '5:N1,N2,N3': { name: '1,2,3-triazole', indicated: true },
  '5:N1,N2,N4': { name: '1,2,4-triazole', indicated: true }, '5:N1,N2,N3,N4': { name: 'tetrazole', indicated: true },
  '5:O1,N3,N4': { name: '1,3,4-oxadiazole' }, '5:O1,N2,N4': { name: '1,2,4-oxadiazole' }, '5:S1,N3,N4': { name: '1,3,4-thiadiazole' },
  '5:O1,O3': { name: '1,3-dioxole', indicated: true }, '5:Se1': { name: 'selenophene' },
  '6:N1': { name: 'pyridine' }, '6:N1,N2': { name: 'pyridazine' }, '6:N1,N3': { name: 'pyrimidine' }, '6:N1,N4': { name: 'pyrazine' },
  '6:N1,N3,N5': { name: '1,3,5-triazine' }, '6:N1,N2,N4': { name: '1,2,4-triazine' }, '6:N1,N2,N3': { name: '1,2,3-triazine' },
  '6:O1': { name: 'pyran', indicated: true }, '6:S1': { name: 'thiopyran', indicated: true }, '6:O1,O4': { name: '1,4-dioxine', indicated: false },
  '7:N1': { name: 'azepine', indicated: true }, '7:O1': { name: 'oxepine' }, '7:S1': { name: 'thiepine' },
  '3:N1': { name: 'azirine', indicated: true }, '3:O1': { name: 'oxirene' }, '4:N1': { name: 'azete', indicated: true },
};

/** Retained saturated names that differ from systematic Hantzsch–Widman names. */
const SATURATED_RETAINED: Record<string, string> = {
  '5:N1': 'pyrrolidine', '6:N1': 'piperidine', '6:N1,N4': 'piperazine', '6:O1,N4': 'morpholine',
  '5:N1,N3': 'imidazolidine', '5:N1,N2': 'pyrazolidine', '6:S1,N4': 'thiomorpholine',
};

function hwStem(size: number, saturated: boolean, hasN: boolean, lastCited: string): string {
  switch (size) {
    case 3: return saturated ? (hasN ? 'iridine' : 'irane') : (hasN ? 'irine' : 'irene');
    case 4: return saturated ? (hasN ? 'etidine' : 'etane') : 'ete';
    case 5: return saturated ? (hasN ? 'olidine' : 'olane') : 'ole';
    case 6: {
      const sixA = ['O', 'S', 'Se', 'Te'].includes(lastCited);
      if (saturated) return sixA ? 'ane' : 'inane';
      return sixA ? 'ine' : 'ine';
    }
    case 7: return saturated ? 'epane' : 'epine';
    case 8: return saturated ? 'ocane' : 'ocine';
    case 9: return saturated ? 'onane' : 'onine';
    case 10: return saturated ? 'ecane' : 'ecine';
    default: return '';
  }
}

const MULT = ['', '', 'di', 'tri', 'tetra', 'penta'];

/** Replacement / Hantzsch–Widman prefix string, e.g. "1,3-dioxa" or "1-oxa-4-aza". */
function replacementPrefix(hetero: Array<{ el: string; locant: string }>, withLocants: boolean): string {
  const parts: string[] = [];
  for (const el of HETERO_ORDER) {
    const locs = hetero.filter((h) => h.el === el).map((h) => h.locant);
    if (!locs.length) continue;
    parts.push((withLocants ? locs.join(',') + '-' : '') + MULT[locs.length] + HW_PREFIX[el]);
  }
  // Join adjacent prefixes: "1-oxa-4-aza"; elide 'a' before a vowel within the chain ("oxaza" not used when locants present).
  return parts.join('-');
}

function joinPrefixStem(prefix: string, stem: string): string {
  if (/[aeiou]$/.test(prefix) && /^[aeiou]/.test(stem)) return prefix.slice(0, -1) + stem;
  return prefix + stem;
}

// ---------------------------------------------------------------------------------------------
// Fused templates (mancude polycycles) — SMILES atom order is the locant order.

interface FusedTemplate {
  name: string;
  smiles: string;
  labels: string[];
  /** Positions that may carry indicated hydrogen (NH / CH2 in the mancude form). */
  indicated?: boolean;
}

const FUSED: FusedTemplate[] = [
  { name: 'naphthalene', smiles: 'c1cccc2ccccc12', labels: ['1', '2', '3', '4', '4a', '5', '6', '7', '8', '8a'] },
  { name: 'anthracene', smiles: 'c1cccc2cc3ccccc3cc12', labels: ['1', '2', '3', '4', '4a', '10', '10a', '5', '6', '7', '8', '8a', '9', '9a'] },
  { name: 'phenanthrene', smiles: 'c1cccc2c3ccccc3ccc12', labels: ['1', '2', '3', '4', '4a', '4b', '5', '6', '7', '8', '8a', '9', '10', '10a'] },
  { name: 'indole', smiles: '[nH]1ccc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'], indicated: true },
  { name: 'quinoline', smiles: 'n1cccc2ccccc12', labels: ['1', '2', '3', '4', '4a', '5', '6', '7', '8', '8a'] },
  { name: 'isoquinoline', smiles: 'c1nccc2ccccc12', labels: ['1', '2', '3', '4', '4a', '5', '6', '7', '8', '8a'] },
  { name: '1-benzofuran', smiles: 'o1ccc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'] },
  { name: '1-benzothiophene', smiles: 's1ccc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'] },
  { name: 'benzimidazole', smiles: '[nH]1cnc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'], indicated: true },
  { name: 'indazole', smiles: '[nH]1ncc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'], indicated: true },
  { name: 'quinoxaline', smiles: 'n1ccnc2ccccc12', labels: ['1', '2', '3', '4', '4a', '5', '6', '7', '8', '8a'] },
  { name: 'quinazoline', smiles: 'n1cncc2ccccc12', labels: ['1', '2', '3', '4', '4a', '5', '6', '7', '8', '8a'] },
  { name: 'indene', smiles: 'C1C=Cc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'], indicated: true },
  { name: 'azulene', smiles: 'c1ccc2cccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '8', '8a'] },
  { name: 'purine', smiles: 'n1cnc2c3c1.n3c[nH]2', labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], indicated: true },
  { name: '1,3-benzoxazole', smiles: 'o1cnc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'] },
  { name: '1,3-benzothiazole', smiles: 's1cnc2ccccc12', labels: ['1', '2', '3', '3a', '4', '5', '6', '7', '7a'] },
];

interface TemplateGraph {
  t: FusedTemplate;
  els: string[];
  adj: number[][];
}

let templateCache: TemplateGraph[] | null = null;
function templates(): TemplateGraph[] {
  if (templateCache) return templateCache;
  templateCache = FUSED.map((t) => {
    const { doc } = parseSmiles(t.smiles);
    const v = new View(doc);
    return { t, els: doc.atoms.map((a) => a.element), adj: v.nbrs.map((n) => [...n]) };
  });
  return templateCache;
}

function labelValue(label: string): number {
  const m = /^(\d+)([a-z]?)$/.exec(label);
  if (!m) return 999;
  return parseInt(m[1], 10) + (m[2] ? (m[2].charCodeAt(0) - 96) * 0.1 : 0);
}

/** All isomorphisms of template onto the ring system atoms (element + adjacency). */
function matchTemplate(view: MolView, atoms: number[], tg: TemplateGraph): number[][] {
  if (tg.els.length !== atoms.length) return [];
  const set = new Set(atoms);
  const adj = new Map<number, number[]>();
  for (const a of atoms) adj.set(a, view.nbrs[a].filter((j) => set.has(j)));
  const results: number[][] = [];
  const map: number[] = new Array(tg.els.length).fill(-1);
  const used = new Set<number>();
  const rec = (k: number) => {
    if (k === tg.els.length) {
      results.push([...map]);
      return;
    }
    for (const a of atoms) {
      if (used.has(a)) continue;
      if (view.el(a) !== tg.els[k]) continue;
      if (adj.get(a)!.length !== tg.adj[k].length) continue;
      let ok = true;
      for (const tn of tg.adj[k]) {
        if (tn < k && !adj.get(a)!.includes(map[tn])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      map[k] = a;
      used.add(a);
      rec(k + 1);
      used.delete(a);
      map[k] = -1;
    }
  };
  rec(0);
  return results;
}

// ---------------------------------------------------------------------------------------------

function ringOrderAtoms(view: MolView, ring: { atoms: number[] }): number[] {
  return ring.atoms;
}

function allRotations(cycle: number[]): number[][] {
  const out: number[][] = [];
  const n = cycle.length;
  for (let s = 0; s < n; s++) {
    out.push(Array.from({ length: n }, (_, k) => cycle[(s + k) % n]));
    out.push(Array.from({ length: n }, (_, k) => cycle[(s - k + n) % n]));
  }
  return out;
}

function hasRingMultipleBond(view: MolView, i: number, set: Set<number>): boolean {
  return view.nbrs[i].some((j, k) => set.has(j) && view.bonds[view.nbrBonds[i][k]].order > 1);
}

/** Heteroatom rule comparison vectors: all heteroatoms together, then O, S, Se, N … */
export function heteroVectors(view: MolView, n: Numbering, heteroAtoms: number[]): number[][] {
  const pos = new Map<number, number>();
  n.atoms.forEach((a, k) => pos.set(a, n.values[k]));
  const all = heteroAtoms.map((a) => pos.get(a) ?? 999).sort((x, y) => x - y);
  const out = [all];
  for (const el of HETERO_ORDER) out.push(heteroAtoms.filter((a) => view.el(a) === el).map((a) => pos.get(a) ?? 999).sort((x, y) => x - y));
  return out;
}

function cmpVec(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function filterByHetero(view: MolView, nums: Numbering[], hetero: number[]): Numbering[] {
  if (!hetero.length) return nums;
  let best: Numbering[] = [];
  let bestVec: number[][] | null = null;
  for (const n of nums) {
    const v = heteroVectors(view, n, hetero);
    if (!bestVec) {
      best = [n];
      bestVec = v;
      continue;
    }
    let c = 0;
    for (let k = 0; k < v.length && c === 0; k++) c = cmpVec(v[k], bestVec[k]);
    if (c < 0) {
      best = [n];
      bestVec = v;
    } else if (c === 0) best.push(n);
  }
  return best;
}

export function buildRingParent(view: MolView, rings: RingInfo, system: RingSystem): RingParent | null {
  const atoms = system.atoms;
  const set = new Set(atoms);
  const hetero = atoms.filter((a) => view.el(a) !== 'C');
  if (hetero.some((a) => !HW_PREFIX[view.el(a)])) return null;
  const aromaticAll = atoms.every((a) => view.atoms[a].aromatic);

  if (system.rings.length === 1) {
    const cycle = ringOrderAtoms(view, system.rings[0]);
    const size = cycle.length;
    const rotations = allRotations(cycle).map(simpleNumbering);
    const noMultiple = atoms.filter((a) => !hasRingMultipleBond(view, a, set));
    if (!hetero.length) {
      if (size === 6 && aromaticAll) {
        return {
          kind: 'benzene', system, atoms, numberings: rotations, heteroAtoms: [], ringCount: 1, mancude: true,
          label: 'benzene ring', describe: 'benzene ring',
          hydride: () => ({ complete: true, stem: 'benzene', expressUnsaturation: false }),
          indicatedH: () => [],
        };
      }
      if (size > 99) return null;
      return {
        kind: 'carbocycle', system, atoms, numberings: rotations, heteroAtoms: [], ringCount: 1, mancude: false,
        label: `${size}-membered carbon ring`, describe: `cyclo${chainStem(size)}ane ring`,
        hydride: () => ({ complete: false, stem: 'cyclo' + chainStem(size), expressUnsaturation: true }),
        indicatedH: () => [],
      };
    }
    // Heteromonocycle.
    const nums = filterByHetero(view, rotations, hetero);
    const n0 = nums[0];
    const pos = new Map<number, number>();
    n0.atoms.forEach((a, k) => pos.set(a, k + 1));
    const hlist = [...hetero].sort((a, b) => pos.get(a)! - pos.get(b)!);
    const keyParts: string[] = [];
    for (const el of HETERO_ORDER) for (const a of hlist) if (view.el(a) === el) keyParts.push(`${el}${pos.get(a)}`);
    const key = `${size}:${keyParts.join(',')}`;
    const ringDoubles = noMultiple.length < atoms.length;
    const divalent = new Set(['O', 'S', 'Se', 'Te']);
    const sp3Positions = noMultiple.filter((a) => !divalent.has(view.el(a)));
    const saturated = !ringDoubles;
    // Mancude: every atom except divalent heteroatoms and at most one indicated-hydrogen position has a ring double bond.
    const mancude = !saturated && sp3Positions.length <= 1 && (aromaticAll || MANCUDE[key]?.indicated || sp3Positions.length === 0);
    if (saturated) {
      const retained = SATURATED_RETAINED[key];
      const hasN = hetero.some((a) => view.el(a) === 'N');
      const lastCited = [...HETERO_ORDER].reverse().find((el) => hetero.some((a) => view.el(a) === el))!;
      const stem = hwStem(size, true, hasN, lastCited);
      if (!stem && !retained) return null;
      const hwName = (() => {
        const heteroList = hlist.map((a) => ({ el: view.el(a), locant: String(pos.get(a)) }));
        const prefix = replacementPrefix(heteroList, hetero.length > 1);
        return joinPrefixStem(prefix, stem);
      })();
      const name = retained ?? hwName;
      return {
        kind: 'heteromono', system, atoms, numberings: nums, heteroAtoms: hetero, ringCount: 1, mancude: false,
        label: `${name} ring`, describe: `${name} ring (saturated heterocycle)`,
        hydride: () => ({ complete: true, stem: name, expressUnsaturation: false }),
        indicatedH: () => [],
      };
    }
    if (mancude) {
      const entry = MANCUDE[key];
      if (!entry) return null;
      return {
        kind: 'heteromono', system, atoms, numberings: nums, heteroAtoms: hetero, ringCount: 1, mancude: true,
        label: `${entry.name} ring`, describe: `${entry.name} ring (heteroaromatic)`,
        hydride: (n) => {
          if (!entry.indicated) return { complete: true, stem: entry.name, expressUnsaturation: false };
          const ih = indicatedFor(view, n, atoms, set);
          return { complete: true, stem: entry.name, expressUnsaturation: false, indicatedH: ih.length ? ih.map((v) => labelFor(n, v)).join(',') .split(',').map((l) => `${l}H`).join(',') : undefined };
        },
        indicatedH: (n) => (entry.indicated ? indicatedFor(view, n, atoms, set) : []),
      };
    }
    return null; // partially hydrogenated heterocycles: outside verified scope for now
  }

  if (system.rings.length === 2 && (system.kind === 'fused' || system.kind === 'bridged')) {
    // Mancude fused bicyclic? Try templates first.
    if (aromaticAll || atoms.every((a) => hasRingMultipleBond(view, a, set) || ['O', 'S', 'N'].includes(view.el(a)) || view.implicitH(a) === 2)) {
      const fused = fusedParent(view, system);
      if (fused) return fused;
    }
    if (system.kind === 'fused' && aromaticAll) return null;
    return vonBaeyer(view, system);
  }
  if (system.rings.length === 2 && system.kind === 'spiro') return spiroParent(view, system);
  if (system.rings.length === 3 && aromaticAll) return fusedParent(view, system);
  return null;
}

function labelFor(n: Numbering, value: number): string {
  const k = n.values.indexOf(value);
  return k >= 0 ? n.labels[k] : String(value);
}

function indicatedFor(view: MolView, n: Numbering, atoms: number[], set: Set<number>): number[] {
  const divalent = new Set(['O', 'S', 'Se', 'Te']);
  const out: number[] = [];
  n.atoms.forEach((a, k) => {
    if (!atoms.includes(a)) return;
    if (divalent.has(view.el(a))) return;
    if (!hasRingMultipleBond(view, a, set)) out.push(n.values[k]);
  });
  return out.sort((x, y) => x - y);
}

function fusedParent(view: MolView, system: RingSystem): RingParent | null {
  const set = new Set(system.atoms);
  for (const tg of templates()) {
    const maps = matchTemplate(view, system.atoms, tg);
    if (!maps.length) continue;
    // The ring system must be mancude: only the template's indicated-hydrogen position may lack a ring double bond.
    const divalent = new Set(['O', 'S', 'Se', 'Te']);
    const sp3 = system.atoms.filter((a) => !divalent.has(view.el(a)) && !hasRingMultipleBond(view, a, set));
    if (sp3.length !== (tg.t.indicated ? 1 : 0)) continue;
    const numberings: Numbering[] = maps.map((m) => ({ atoms: m, labels: tg.t.labels, values: tg.t.labels.map(labelValue) }));
    // For each numbering, sort atom list by value so locant order is increasing.
    const sorted = numberings.map((n) => {
      const idx = n.values.map((v, k) => [v, k] as const).sort((a, b) => a[0] - b[0]).map(([, k]) => k);
      return { atoms: idx.map((k) => n.atoms[k]), labels: idx.map((k) => n.labels[k]), values: idx.map((k) => n.values[k]) };
    });
    const hetero = system.atoms.filter((a) => view.el(a) !== 'C');
    const t = tg.t;
    return {
      kind: 'fused', system, atoms: system.atoms, numberings: sorted, heteroAtoms: hetero, ringCount: system.rings.length, mancude: true,
      label: `${t.name} ring system`, describe: `${t.name} (fused ring system)`,
      hydride: (n) => {
        if (!t.indicated) return { complete: true, stem: t.name, expressUnsaturation: false };
        const ih = indicatedFor(view, n, system.atoms, set);
        return { complete: true, stem: t.name, expressUnsaturation: false, indicatedH: ih.length ? ih.map((v) => `${labelFor(n, v)}H`).join(',') : undefined };
      },
      indicatedH: (n) => (t.indicated ? indicatedFor(view, n, system.atoms, set) : []),
    };
  }
  return null;
}

/** Paths between two bridgeheads through the ring system (the three bridges). */
function bridgesBetween(view: MolView, set: Set<number>, x: number, y: number): number[][] {
  const out: number[][] = [];
  for (const start of view.nbrs[x]) {
    if (!set.has(start)) continue;
    if (start === y) {
      out.push([]);
      continue;
    }
    const path = [start];
    let prev = x;
    let cur = start;
    let ok = true;
    while (cur !== y) {
      const next = view.nbrs[cur].filter((j) => set.has(j) && j !== prev);
      if (next.length !== 1) {
        ok = false;
        break;
      }
      prev = cur;
      cur = next[0];
      if (cur !== y) path.push(cur);
      if (path.length > set.size) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(path);
  }
  return out;
}

function permutationsBySize(bridges: number[][]): number[][][] {
  const perms: number[][][] = [];
  const idx = [0, 1, 2];
  const permute = (arr: number[], k: number) => {
    if (k === arr.length) {
      const ordered = arr.map((i) => bridges[i]);
      if (ordered[0].length >= ordered[1].length && ordered[1].length >= ordered[2].length) perms.push(ordered);
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  permute(idx, 0);
  return perms;
}

function vonBaeyer(view: MolView, system: RingSystem): RingParent | null {
  const atoms = system.atoms;
  const set = new Set(atoms);
  const heads = atoms.filter((a) => view.nbrs[a].filter((j) => set.has(j)).length >= 3);
  if (heads.length !== 2) return null;
  const [x, y] = heads;
  const bridges = bridgesBetween(view, set, x, y);
  if (bridges.length !== 3) return null;
  const numberings: Numbering[] = [];
  for (const [h1, h2] of [[x, y], [y, x]]) {
    const b = h1 === x ? bridges : bridgesBetween(view, set, h1, h2);
    for (const [main, second, small] of permutationsBySize(b)) {
      // Bridges were collected from h1's side; `second` must be traversed from h2 back to h1.
      const order = [h1, ...main, h2, ...[...second].reverse(), ...small];
      // Smallest bridge numbered from the end nearer to bridgehead 1: small is listed from h1 side already.
      numberings.push(simpleNumbering(order));
    }
  }
  const sizes = bridges.map((b) => b.length).sort((p, q) => q - p);
  const total = atoms.length;
  const hetero = atoms.filter((a) => view.el(a) !== 'C');
  const nums = filterByHetero(view, dedupe(numberings), hetero);
  const bracket = `bicyclo[${sizes.join('.')}]`;
  return {
    kind: 'vonbaeyer', system, atoms, numberings: nums, heteroAtoms: hetero, ringCount: 2, mancude: false,
    label: `${bracket}${chainStem(total)}ane skeleton`, describe: `bridged bicyclic (${bracket}) ring system`,
    hydride: (n) => {
      const pos = new Map<number, number>();
      n.atoms.forEach((a, k) => pos.set(a, k + 1));
      const hl = hetero.map((a) => ({ el: view.el(a), locant: String(pos.get(a)) })).sort((p, q) => +p.locant - +q.locant);
      return { complete: false, stem: bracket + chainStem(total), replacement: hl.length ? replacementPrefix(hl, true) : undefined, expressUnsaturation: true };
    },
    indicatedH: () => [],
  };
}

function spiroParent(view: MolView, system: RingSystem): RingParent | null {
  const [r1, r2] = system.rings;
  const spiro = r1.atoms.find((a) => r2.atoms.includes(a));
  if (spiro === undefined) return null;
  const numberings: Numbering[] = [];
  const small = r1.atoms.length <= r2.atoms.length ? [r1, r2] : [r2, r1];
  const pairs = r1.atoms.length === r2.atoms.length ? [[r1, r2], [r2, r1]] : [small];
  const walk = (ring: { atoms: number[] }, dir: 1 | -1): number[] => {
    const cyc = ring.atoms;
    const s = cyc.indexOf(spiro);
    const out: number[] = [];
    for (let k = 1; k < cyc.length; k++) out.push(cyc[(s + dir * k + cyc.length * 2) % cyc.length]);
    return out;
  };
  for (const [a, b] of pairs) {
    for (const d1 of [1, -1] as const) for (const d2 of [1, -1] as const) {
      numberings.push(simpleNumbering([...walk(a, d1), spiro, ...walk(b, d2)]));
    }
  }
  const sizes = [small[0].atoms.length - 1, small[1].atoms.length - 1];
  const total = system.atoms.length;
  const hetero = system.atoms.filter((a) => view.el(a) !== 'C');
  const nums = filterByHetero(view, dedupe(numberings), hetero);
  const bracket = `spiro[${sizes.join('.')}]`;
  return {
    kind: 'spiro', system, atoms: system.atoms, numberings: nums, heteroAtoms: hetero, ringCount: 2, mancude: false,
    label: `${bracket}${chainStem(total)}ane skeleton`, describe: `spiro ring system (${bracket})`,
    hydride: (n) => {
      const pos = new Map<number, number>();
      n.atoms.forEach((a, k) => pos.set(a, k + 1));
      const hl = hetero.map((a) => ({ el: view.el(a), locant: String(pos.get(a)) })).sort((p, q) => +p.locant - +q.locant);
      return { complete: false, stem: bracket + chainStem(total), replacement: hl.length ? replacementPrefix(hl, true) : undefined, expressUnsaturation: true };
    },
    indicatedH: () => [],
  };
}

function dedupe(nums: Numbering[]): Numbering[] {
  const seen = new Set<string>();
  return nums.filter((n) => {
    const k = n.atoms.join(',');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
