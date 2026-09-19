import { perceiveAromaticity } from '../aromaticity.ts';
import { CipRanker, perceiveStereo, type StereoPerception } from '../cip.ts';
import { MolView } from '../graph.ts';
import { suppressHydrogens } from '../hydrogens.ts';
import { perceiveRings, type RingInfo, type RingSystem } from '../rings.ts';
import { sameConfiguration } from '../stereo-geometry.ts';
import type { AtomId, MoleculeDocument, StereoNeighbour } from '../types.ts';
import { C_INCLUSIVE, CG_LABEL, detectCharGroups, principalKind, SENIORITY, type CGKind, type CharGroup } from './groups.ts';
import { alphaKey, chainStem, compareLocantSets, complexMultiplier, enclose, firstDifference, multiplier, nestingDepth } from './numerals.ts';
import { ENGINE_VERSION, PROFILE_2013, type NamingProfile } from './profile.ts';
import { buildRingParent, simpleNumbering, type Numbering, type RingParent } from './ringparents.ts';
import type { NameToken, NamingTrace, NumberingAlternative, ParentAlternative, StereoTrace, SubstituentTrace, TokenRole } from './types.ts';

export class NamingUnsupported extends Error {}

// =============================================================================================
// Tokens
// =============================================================================================

function tokensText(t: NameToken[]): string {
  return t.map((x) => x.text).join('');
}

const VOWEL = /^[aeiouy]/;

// =============================================================================================
// Context
// =============================================================================================

interface Ctx {
  doc: MoleculeDocument;
  view: MolView;
  rings: RingInfo;
  profile: NamingProfile;
  groups: CharGroup[];
  stereo: StereoPerception;
  cip: CipRanker;
  ringParents: Map<RingSystem, RingParent | null>;
  systemOfAtom: Map<number, RingSystem>;
  id: (i: number) => AtomId;
  warnings: string[];
  subMemo: Map<string, SubName>;
}

interface SubName {
  tokens: NameToken[];
  text: string;
  /** No internal locants or enclosures: multiplied with di/tri and not parenthesised. */
  simple: boolean;
  atoms: number[];
  sortKey: string;
  stereo: StereoTrace[];
}

type FreeSuffix = 'yl' | 'ylidene' | 'ylidyne' | 'oyl' | 'carbonyl';

interface Task {
  atoms: Set<number>;
  principal: CGKind | null;
  /** Substituent mode: the atom with the free valence, the atom it bonds to, and the suffix used. */
  free?: { atom: number; from: number; suffix: FreeSuffix; exclude: number[] };
  depth: number;
}

interface SuffixUse {
  group: CharGroup;
  /** Parent atom that carries the suffix (for inclusive groups: the group carbon itself). */
  at: number;
  inclusive: boolean;
}

interface Component {
  atoms: number[];
  root: number;
  to: number;
  order: 1 | 2 | 3;
  onNitrogen: boolean;
}

interface NumEval {
  n: Numbering;
  loc: Map<number, number>;
  label: Map<number, string>;
  vecs: Array<{ name: string; vec: number[] }>;
  invalid: boolean;
}

interface Candidate {
  kind: 'chain' | 'ring';
  atoms: number[];
  set: Set<number>;
  ring?: RingParent;
  numberings: Numbering[];
  suffix: SuffixUse[];
  suffixKind: CGKind | null;
  components: Component[];
  multiple: Array<{ a: number; b: number; order: 2 | 3 }>;
  label: string;
  free?: Task['free'];
  best?: NumEval;
  runnerUp?: NumEval;
  decidingNumberingCriterion?: string;
}

const NUMBERING_CRITERIA_TEXT: Record<string, string> = {
  hetero: 'the heteroatoms get the lowest locants',
  indicatedH: 'indicated hydrogen gets the lowest locant',
  principal: 'the principal characteristic group gets the lowest locant',
  free: 'the attachment point (free valence) gets the lowest locant',
  multi: 'the multiple bonds get the lowest locants',
  doubles: 'the double bonds get the lowest locants',
  prefixes: 'the substituents get the lowest set of locants',
  alpha: 'the substituent cited first in alphabetical order gets the lower locant',
  stereo: 'Z is preferred to E and R to S at the first point of difference',
};

function makeCtx(doc: MoleculeDocument, profile: NamingProfile): Ctx {
  const view = new MolView(doc);
  const rings = perceiveRings(view);
  const groups = detectCharGroups(view, rings);
  const stereo = perceiveStereo(doc, rings);
  const ringParents = new Map<RingSystem, RingParent | null>();
  const systemOfAtom = new Map<number, RingSystem>();
  for (const s of rings.systems) {
    ringParents.set(s, buildRingParent(view, rings, s));
    for (const a of s.atoms) systemOfAtom.set(a, s);
  }
  return {
    doc, view, rings, profile, groups, stereo, cip: new CipRanker(view), ringParents, systemOfAtom,
    id: (i) => doc.atoms[i].id, warnings: [], subMemo: new Map(),
  };
}

function bondOrder(ctx: Ctx, i: number, j: number): number {
  const b = ctx.view.bondBetween(i, j);
  return b < 0 ? 0 : ctx.view.bonds[b].order;
}

function oxoOn(ctx: Ctx, c: number, atoms: Set<number>): number | undefined {
  return ctx.view.nbrs[c].find((j) => atoms.has(j) && ctx.view.el(j) === 'O' && bondOrder(ctx, c, j) === 2 && ctx.view.nbrs[j].length === 1);
}

/** Acyclic carbons usable as chain atoms. Carbons of non-principal nitrile/amide/ester/acid-halide groups are prefixes (cyano, carbamoyl …). */
function chainCarbons(ctx: Ctx, atoms: Set<number>, principal: CGKind | null, keep?: number): Set<number> {
  const blocked = new Set<number>();
  for (const g of ctx.groups) {
    if (g.carbon === undefined || !atoms.has(g.carbon) || g.carbon === keep) continue;
    if (g.kind === principal || g.kind === 'aldehyde') continue;
    blocked.add(g.carbon);
  }
  const out = new Set<number>();
  for (const a of atoms) {
    if (ctx.view.el(a) !== 'C' || ctx.rings.inRing(a) || blocked.has(a)) continue;
    out.add(a);
  }
  return out;
}

/** Leaf-to-leaf paths in the forest induced on `nodes` (optionally through / starting at an atom). */
function forestPaths(ctx: Ctx, nodes: Set<number>, through?: number, startAt?: number): number[][] {
  const adj = new Map<number, number[]>();
  for (const a of nodes) adj.set(a, ctx.view.nbrs[a].filter((j) => nodes.has(j)));
  const paths: number[][] = [];
  const seenTree = new Set<number>();
  const pathBetween = (u: number, v: number): number[] => {
    const prev = new Map<number, number>([[u, -1]]);
    const q = [u];
    while (q.length) {
      const x = q.shift()!;
      if (x === v) break;
      for (const y of adj.get(x)!) if (!prev.has(y)) { prev.set(y, x); q.push(y); }
    }
    const p: number[] = [];
    for (let c = v; c !== -1; c = prev.get(c)!) p.push(c);
    return p.reverse();
  };
  for (const s of nodes) {
    if (seenTree.has(s)) continue;
    const tree: number[] = [];
    const st = [s];
    seenTree.add(s);
    while (st.length) {
      const x = st.pop()!;
      tree.push(x);
      for (const y of adj.get(x)!) if (!seenTree.has(y)) { seenTree.add(y); st.push(y); }
    }
    const anchor = startAt ?? through;
    if (anchor !== undefined && !tree.includes(anchor)) continue;
    if (tree.length === 1) {
      paths.push([tree[0]]);
      continue;
    }
    const leaves = tree.filter((x) => adj.get(x)!.length <= 1);
    if (startAt !== undefined) {
      for (const l of leaves) if (l !== startAt) paths.push(pathBetween(startAt, l));
      continue;
    }
    for (let x = 0; x < leaves.length; x++) {
      for (let y = x + 1; y < leaves.length; y++) {
        const p = pathBetween(leaves[x], leaves[y]);
        if (through !== undefined && !p.includes(through)) continue;
        paths.push(p);
      }
    }
  }
  return paths;
}

// =============================================================================================
// Candidates
// =============================================================================================

function buildCandidates(ctx: Ctx, task: Task): Candidate[] {
  const out: Candidate[] = [];
  const { atoms, principal, free } = task;
  const principalGroups = principal ? ctx.groups.filter((g) => g.kind === principal && g.anchors.some((a) => atoms.has(a))) : [];
  const freeInRing = !!free && ctx.rings.inRing(free.atom);

  const systems = new Set<RingSystem>();
  if (freeInRing) systems.add(ctx.systemOfAtom.get(free!.atom)!);
  else if (!free) {
    for (const a of atoms) {
      const s = ctx.systemOfAtom.get(a);
      if (s && s.atoms.every((x) => atoms.has(x))) systems.add(s);
    }
  }
  for (const s of systems) {
    const rp = ctx.ringParents.get(s);
    if (!rp) throw new NamingUnsupported(`the ring system (${s.atoms.length} atoms, ${s.rings.length} rings) is outside the course engine's verified scope`);
    const c = makeCandidate(ctx, task, 'ring', rp.atoms, principalGroups, rp, rp.numberings);
    if (c) out.push(c);
  }
  if (freeInRing) return out;

  const carbons = chainCarbons(ctx, atoms, principal, free?.atom);
  const paths: number[][] = [];
  if (free) {
    if (!carbons.has(free.atom)) throw new NamingUnsupported('this substituent is outside the verified scope');

    // 2013 substituent chains contain the attachment atom anywhere (propan-2-yl); CAS/common chains start at it (1-methylethyl).
    const startOnly = free.suffix === 'oyl' || ctx.profile.substituentStyle !== 'systematic';
    paths.push(...forestPaths(ctx, carbons, startOnly ? undefined : free.atom, startOnly ? free.atom : undefined));
  } else {
    paths.push(...forestPaths(ctx, carbons));
    const incl = principalGroups.filter((g) => C_INCLUSIVE.has(g.kind)).map((g) => g.carbon!);
    if (incl.length) paths.push(...forestPaths(ctx, new Set([...carbons].filter((c) => !incl.includes(c)))));
  }
  const seen = new Set<string>();
  for (const p of paths) {
    const key = [...p].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const numberings = p.length === 1 ? [simpleNumbering(p)] : [simpleNumbering(p), simpleNumbering([...p].reverse())];
    const c = makeCandidate(ctx, task, 'chain', p, principalGroups, undefined, numberings);
    if (c) out.push(c);
  }
  return out;
}

function makeCandidate(ctx: Ctx, task: Task, kind: 'chain' | 'ring', parentAtoms: number[], principalGroups: CharGroup[], ring: RingParent | undefined, numberings: Numbering[]): Candidate | null {
  const set = new Set(parentAtoms);
  const view = ctx.view;
  const suffix: SuffixUse[] = [];
  const excluded = new Set<number>();
  if (task.free) {
    if (!set.has(task.free.atom)) return null;
    for (const x of task.free.exclude) excluded.add(x);
  } else {
    const inclusive = principalGroups.filter((g) => C_INCLUSIVE.has(g.kind) && set.has(g.carbon!));
    if (inclusive.length) {
      if (kind === 'chain' && inclusive.some((g) => g.carbon !== parentAtoms[0] && g.carbon !== parentAtoms[parentAtoms.length - 1])) return null;
      for (const g of inclusive) suffix.push({ group: g, at: g.carbon!, inclusive: true });
    } else {
      for (const g of principalGroups) {
        if (!C_INCLUSIVE.has(g.kind)) continue;
        const at = view.nbrs[g.carbon!].find((j) => set.has(j) && bondOrder(ctx, g.carbon!, j) === 1);
        if (at !== undefined) suffix.push({ group: g, at, inclusive: false });
      }
    }
    for (const g of principalGroups) {
      if (C_INCLUSIVE.has(g.kind)) continue;
      const at = g.anchors.find((a) => set.has(a));
      if (at !== undefined) suffix.push({ group: g, at, inclusive: false });
    }
    for (const s of suffix) {
      for (const h of s.group.hetero) excluded.add(h);
      if (s.group.carbon !== undefined && !s.inclusive) excluded.add(s.group.carbon);
    }
  }
  const multiple: Candidate['multiple'] = [];
  for (const a of parentAtoms) {
    view.nbrs[a].forEach((b, m) => {
      if (b <= a || !set.has(b)) return;
      const o = view.bonds[view.nbrBonds[a][m]].order;
      if (o > 1) multiple.push({ a, b, order: o as 2 | 3 });
    });
  }
  const rest = new Set([...task.atoms].filter((a) => !set.has(a) && !excluded.has(a)));
  const nitrogens = new Set(suffix.map((s) => s.group.nitrogen).filter((n): n is number => n !== undefined));
  const components: Component[] = [];
  const done = new Set<number>();
  for (const s0 of rest) {
    if (done.has(s0)) continue;
    const comp: number[] = [];
    const st = [s0];
    done.add(s0);
    while (st.length) {
      const x = st.pop()!;
      comp.push(x);
      for (const y of view.nbrs[x]) if (rest.has(y) && !done.has(y)) { done.add(y); st.push(y); }
    }
    const attach: Array<{ root: number; to: number; order: number }> = [];
    for (const x of comp) {
      view.nbrs[x].forEach((y, m) => {
        if (rest.has(y) || !task.atoms.has(y)) return;
        attach.push({ root: x, to: y, order: view.bonds[view.nbrBonds[x][m]].order });
      });
    }
    if (attach.length !== 1) return null;
    const at = attach[0];
    const onNitrogen = nitrogens.has(at.to);
    if (!set.has(at.to) && !onNitrogen) return null;
    components.push({ atoms: comp.sort((a, b) => a - b), root: at.root, to: at.to, order: at.order as 1 | 2 | 3, onNitrogen });
  }
  // Every non-parent atom must be accounted for: excluded suffix atoms must not bond to stray atoms.
  const label = kind === 'ring' ? ring!.label : `${parentAtoms.length}-carbon chain`;
  return { kind, atoms: parentAtoms, set, ring, numberings, suffix, suffixKind: task.free ? null : task.principal, components, multiple, label, free: task.free };
}

// =============================================================================================
// Numbering
// =============================================================================================

function evalNumbering(ctx: Ctx, c: Candidate, n: Numbering, depth: number): NumEval {
  const loc = new Map<number, number>();
  const label = new Map<number, string>();
  n.atoms.forEach((a, k) => {
    loc.set(a, n.values[k]);
    label.set(a, n.labels[k]);
  });
  const vecs: NumEval['vecs'] = [];
  let invalid = false;
  if (c.ring?.heteroAtoms.length) vecs.push({ name: 'hetero', vec: c.ring.heteroAtoms.map((a) => loc.get(a)!).sort((x, y) => x - y) });
  if (c.ring) vecs.push({ name: 'indicatedH', vec: c.ring.indicatedH(n) });
  if (c.free) vecs.push({ name: 'free', vec: [loc.get(c.free.atom)!] });
  else vecs.push({ name: 'principal', vec: c.suffix.map((s) => loc.get(s.at)!).sort((x, y) => x - y) });
  if (!c.ring?.mancude) {
    const bondLoc = (m: { a: number; b: number }) => {
      const la = loc.get(m.a)!;
      const lb = loc.get(m.b)!;
      if (Math.abs(la - lb) !== 1) invalid = true;
      return Math.min(la, lb);
    };
    vecs.push({ name: 'multi', vec: c.multiple.map(bondLoc).sort((x, y) => x - y) });
    vecs.push({ name: 'doubles', vec: c.multiple.filter((m) => m.order === 2).map(bondLoc).sort((x, y) => x - y) });
  }
  const pc = c.components.filter((x) => !x.onNitrogen);
  vecs.push({ name: 'prefixes', vec: pc.map((x) => loc.get(x.to)!).sort((p, q) => p - q) });
  if (pc.length > 1) {
    const named = pc.map((x) => ({ key: subName(ctx, x, depth).sortKey, l: loc.get(x.to)! }));
    named.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : p.l - q.l));
    vecs.push({ name: 'alpha', vec: named.map((x) => x.l) });
  } else vecs.push({ name: 'alpha', vec: [] });
  const items: Array<{ l: number; v: number }> = [];
  for (const sc of ctx.stereo.centres) {
    const i = ctx.view.index.get(sc.atomId)!;
    if (c.set.has(i) && sc.descriptor) items.push({ l: loc.get(i)!, v: sc.descriptor === 'R' ? 0 : 1 });
  }
  for (const sb of ctx.stereo.bonds) {
    const i = ctx.view.index.get(sb.atoms[0])!;
    const j = ctx.view.index.get(sb.atoms[1])!;
    if (c.set.has(i) && c.set.has(j) && sb.descriptor) items.push({ l: Math.min(loc.get(i)!, loc.get(j)!), v: sb.descriptor === 'Z' ? 0 : 1 });
  }
  items.sort((p, q) => p.l - q.l);
  vecs.push({ name: 'stereo', vec: items.map((x) => x.v) });
  return { n, loc, label, vecs, invalid };
}

function compareNumEvals(a: NumEval, b: NumEval): { c: number; criterion?: string } {
  if (a.invalid !== b.invalid) return { c: a.invalid ? 1 : -1, criterion: 'multi' };
  for (let k = 0; k < a.vecs.length; k++) {
    const c = compareLocantSets(a.vecs[k].vec, b.vecs[k].vec);
    if (c !== 0) return { c, criterion: a.vecs[k].name };
  }
  return { c: 0 };
}

function chooseNumbering(ctx: Ctx, c: Candidate, depth: number): void {
  const evals = c.numberings.map((n) => evalNumbering(ctx, c, n, depth));
  evals.sort((x, y) => compareNumEvals(x, y).c);
  c.best = evals[0];
  const alt = evals.slice(1).find((e) => compareNumEvals(evals[0], e).c !== 0);
  c.runnerUp = alt;
  if (alt) c.decidingNumberingCriterion = compareNumEvals(evals[0], alt).criterion;
}

// =============================================================================================
// Parent selection
// =============================================================================================

interface Score {
  name: string;
  higherIsBetter: boolean;
  value: number | number[];
}

function scores(ctx: Ctx, c: Candidate): Score[] {
  const p = ctx.profile;
  const b = c.best!;
  const vec = (name: string) => b.vecs.find((v) => v.name === name)?.vec ?? [];
  const size = c.atoms.length;
  const out: Score[] = [{ name: 'principalCount', higherIsBetter: true, value: c.free ? 1 : c.suffix.length }];
  if (p.ringVsChain === '2013') out.push({ name: 'ringOverChain', higherIsBetter: true, value: c.kind === 'ring' ? 1 : 0 });
  else out.push({ name: 'largerUnit', higherIsBetter: true, value: size }, { name: 'ringOverChain', higherIsBetter: true, value: c.kind === 'ring' ? 1 : 0 });
  // Between chains, -oic acid/-al/-nitrile (group carbon counted) beats the carbo- suffix form.
  out.push({ name: 'carboMode', higherIsBetter: false, value: c.kind === 'chain' && c.suffix.some((s) => C_INCLUSIVE.has(s.group.kind) && !s.inclusive) ? 1 : 0 });
  if (c.ring) {
    out.push(
      { name: 'heterocycle', higherIsBetter: true, value: c.ring.heteroAtoms.length ? 1 : 0 },
      { name: 'nitrogen', higherIsBetter: true, value: c.ring.heteroAtoms.some((a) => ctx.view.el(a) === 'N') ? 1 : 0 },
      { name: 'ringCount', higherIsBetter: true, value: c.ring.ringCount },
      { name: 'ringSize', higherIsBetter: true, value: size },
      { name: 'heteroCount', higherIsBetter: true, value: c.ring.heteroAtoms.length },
    );
  }
  const multi = { name: 'multipleBonds', higherIsBetter: true, value: c.multiple.length };
  const length = { name: 'length', higherIsBetter: true, value: size };
  if (p.chainSeniority === '1993') out.push(multi, length);
  else out.push(length, multi);
  out.push(
    { name: 'doubleBonds', higherIsBetter: true, value: c.multiple.filter((m) => m.order === 2).length },
    { name: 'principalLocants', higherIsBetter: false, value: vec(c.free ? 'free' : 'principal') },
    { name: 'multiLocants', higherIsBetter: false, value: vec('multi') },
    { name: 'doubleLocants', higherIsBetter: false, value: vec('doubles') },
    { name: 'substituentCount', higherIsBetter: true, value: c.components.filter((x) => !x.onNitrogen).length },
    { name: 'substituentLocants', higherIsBetter: false, value: vec('prefixes') },
    { name: 'alphaLocants', higherIsBetter: false, value: vec('alpha') },
  );
  return out;
}

function compareScores(a: Score[], b: Score[]): { c: number; criterion?: string; av?: number | number[]; bv?: number | number[] } {
  const bm = new Map(b.map((s) => [s.name, s]));
  for (const x of a) {
    const y = bm.get(x.name);
    if (!y) continue;
    let c = Array.isArray(x.value) && Array.isArray(y.value) ? compareLocantSets(x.value, y.value) : (x.value as number) - (y.value as number);
    if (x.higherIsBetter) c = -c;
    if (c !== 0) return { c, criterion: x.name, av: x.value, bv: y.value };
  }
  return { c: 0 };
}

const PARENT_REASON: Record<string, (w: string, l: string, profile: NamingProfile) => string> = {
  principalCount: (w, l) => `it carries fewer principal characteristic groups (${l} vs ${w})`,
  carboMode: () => 'the chain can include the group carbon, so the -oic acid / -al / -nitrile form is preferred',
  ringOverChain: (_w, _l, p) => (p.ringVsChain === '2013' ? 'under the 2013 IUPAC rules a ring is senior to a chain' : 'when the ring and chain are the same size, the ring is preferred'),
  largerUnit: (w, l) => `it has fewer skeletal atoms (${l} vs ${w}); older rules make the larger unit the parent`,
  heterocycle: () => 'a heterocycle is senior to a carbocycle',
  nitrogen: () => 'a nitrogen-containing ring is senior',
  ringCount: (w, l) => `it has fewer rings (${l} vs ${w})`,
  ringSize: (w, l) => `it is the smaller ring (${l} vs ${w} atoms)`,
  heteroCount: () => 'it has fewer heteroatoms',
  length: (w, l) => `it is a shorter chain (${l} vs ${w} carbons)`,
  multipleBonds: (w, l) => `it contains fewer multiple bonds (${l} vs ${w})`,
  doubleBonds: (w, l) => `it contains fewer double bonds (${l} vs ${w})`,
  principalLocants: (w, l) => `its principal group would get higher locants ({${l}} vs {${w}})`,
  multiLocants: (w, l) => `its multiple bonds would get higher locants ({${l}} vs {${w}})`,
  doubleLocants: (w, l) => `its double bonds would get higher locants ({${l}} vs {${w}})`,
  substituentCount: (w, l) => `it would carry fewer substituents (${l} vs ${w}); with equal length, the chain with more substituents wins`,
  substituentLocants: (w, l) => `its substituents would get higher locants ({${l}} vs {${w}})`,
  alphaLocants: (w, l) => `the first-cited substituent would get a higher locant ({${l}} vs {${w}})`,
  alphanumeric: () => 'its complete name comes later in alphanumerical order',
};

// =============================================================================================
// Substituents
// =============================================================================================

const HALO: Record<string, string> = { F: 'fluoro', Cl: 'chloro', Br: 'bromo', I: 'iodo' };
const HALIDE: Record<string, string> = { F: 'fluoride', Cl: 'chloride', Br: 'bromide', I: 'iodide' };

function simpleSub(ctx: Ctx, text: string, atoms: number[]): SubName {
  return { tokens: [{ text, role: 'substituent', atomIds: atoms.map(ctx.id) }], text, simple: true, atoms, sortKey: alphaKey(text), stereo: [] };
}

function makeSub(tokens: NameToken[], atoms: number[], stereo: StereoTrace[], simple?: boolean): SubName {
  const text = tokensText(tokens);
  return { tokens, text, simple: simple ?? !/[\d(,[{]/.test(text), atoms, sortKey: alphaKey(text), stereo };
}

function subName(ctx: Ctx, comp: Component, depth: number): SubName {
  const key = `${comp.root}>${comp.to}:${comp.order}:${depth}:${comp.atoms.length}`;
  const memo = ctx.subMemo.get(key);
  if (memo) return memo;
  const r = nameSubstituent(ctx, new Set(comp.atoms), comp.root, comp.to, comp.order, depth);
  ctx.subMemo.set(key, r);
  return r;
}

function collectBranch(ctx: Ctx, atoms: Set<number>, start: number, block: number): Set<number> {
  const out = new Set<number>([start]);
  const st = [start];
  while (st.length) {
    const x = st.pop()!;
    for (const y of ctx.view.nbrs[x]) if (atoms.has(y) && y !== block && !out.has(y)) { out.add(y); st.push(y); }
  }
  return out;
}

function wrap(sub: SubName, depthHint = 0): NameToken[] {
  const d = Math.max(depthHint, nestingDepth(sub.text) + 1);
  const [o, c] = [enclose('', d)[0], enclose('', d)[1]];
  return [{ text: o, role: 'enclosure', atomIds: [] }, ...sub.tokens, { text: c, role: 'enclosure', atomIds: [] }];
}

function nameSubstituent(ctx: Ctx, atoms: Set<number>, root: number, from: number, order: 1 | 2 | 3, depth: number): SubName {
  const view = ctx.view;
  const el = view.el(root);
  const all = [...atoms];
  const style = ctx.profile.substituentStyle;
  const q = view.atoms[root].formalCharge;
  const tok = (text: string, at: number[], role: TokenRole = 'substituent'): NameToken => ({ text, role, atomIds: at.map(ctx.id) });

  if (order === 2) {
    if (atoms.size === 1 && el === 'O') return simpleSub(ctx, 'oxo', all);
    if (atoms.size === 1 && el === 'S') return simpleSub(ctx, style === 'systematic' ? 'sulfanylidene' : 'thioxo', all);
    if (atoms.size === 1 && el === 'N') return simpleSub(ctx, 'imino', all);
    if (el === 'C') return carbonSubstituent(ctx, atoms, root, from, 'ylidene', [], depth);
    throw new NamingUnsupported(`a double-bonded ${el} substituent is outside the verified scope`);
  }
  if (order === 3) {
    if (el === 'C') return carbonSubstituent(ctx, atoms, root, from, 'ylidyne', [], depth);
    throw new NamingUnsupported('this triple-bonded substituent is outside the verified scope');
  }
  if (HALO[el] && atoms.size === 1 && q === 0) return simpleSub(ctx, HALO[el], all);
  const next = view.nbrs[root].filter((j) => atoms.has(j));
  if (ctx.rings.inRing(root)) return carbonSubstituent(ctx, atoms, root, from, 'yl', [], depth);

  if (el === 'O') {
    if (atoms.size === 1 && q === 0) return simpleSub(ctx, 'hydroxy', all);
    if (atoms.size === 1 && q === -1) return simpleSub(ctx, 'oxido', all);
    if (next.length !== 1 || q !== 0 || bondOrder(ctx, root, next[0]) !== 1) throw new NamingUnsupported('this oxygen substituent is outside the verified scope');
    const inner = nameSubstituent(ctx, new Set(all.filter((a) => a !== root)), next[0], root, 1, depth + 1);
    return oxy(ctx, inner, root, all);
  }
  if (el === 'S') {
    if (atoms.size === 1 && q === 0) return simpleSub(ctx, style === 'systematic' ? 'sulfanyl' : 'mercapto', all);
    if (next.length === 1 && q === 0 && bondOrder(ctx, root, next[0]) === 1) {
      const inner = nameSubstituent(ctx, new Set(all.filter((a) => a !== root)), next[0], root, 1, depth + 1);
      const word = style === 'systematic' ? 'sulfanyl' : 'thio';
      const body = inner.simple ? inner.tokens : wrap(inner);
      return makeSub([...body, tok(word, [root])], all, inner.stereo, false);
    }
    throw new NamingUnsupported('this sulfur substituent is outside the verified scope');
  }
  if (el === 'N') {
    if (q === 1) {
      const os = next.filter((j) => view.el(j) === 'O');
      if (os.length === 2 && next.length === 2 && os.some((j) => bondOrder(ctx, root, j) === 2) && os.some((j) => view.atoms[j].formalCharge === -1)) return simpleSub(ctx, 'nitro', all);
      throw new NamingUnsupported('this charged nitrogen substituent is outside the verified scope');
    }
    if (q !== 0 || next.some((j) => bondOrder(ctx, root, j) !== 1)) throw new NamingUnsupported('this nitrogen substituent is outside the verified scope');
    if (atoms.size === 1) return simpleSub(ctx, 'amino', all);
    const branches = next.map((j) => nameSubstituent(ctx, collectBranch(ctx, atoms, j, root), j, root, 1, depth + 1));
    // N-acyl: acetamido, propanamido, benzamido.
    if (branches.length === 1 && /(oyl|acetyl|formyl|benzoyl|carbonyl)$/.test(branches[0].text)) {
      const t = branches[0].text;
      const text = t === 'acetyl' ? 'acetamido' : t === 'formyl' ? 'formamido' : t === 'benzoyl' ? 'benzamido' : t.endsWith('carbonyl') ? t.slice(0, -8) + 'carboxamido' : t.slice(0, -3) + 'amido';
      if (style === 'cas') {
        const body = branches[0].simple ? branches[0].tokens : wrap(branches[0]);
        return makeSub([...body, tok('amino', [root])], all, branches[0].stereo, false);
      }
      return makeSub([{ text, role: 'substituent', atomIds: all.map(ctx.id) }], all, branches[0].stereo, !/[\d(,[{]/.test(text));
    }
    branches.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
    const toks: NameToken[] = [];
    if (branches.length === 2 && branches[0].text === branches[1].text) {
      const both = [...branches[0].atoms, ...branches[1].atoms];
      if (branches[0].simple) toks.push(tok('di', both, 'multiplier'), ...branches[0].tokens.map((t) => ({ ...t, atomIds: both.map(ctx.id) })));
      else toks.push(tok('bis', both, 'multiplier'), ...wrap(branches[0]).map((t) => ({ ...t, atomIds: t.atomIds.length ? both.map(ctx.id) : [] })));
    } else {
      branches.forEach((b, k) => {
        if (k === 0 && b.simple) toks.push(...b.tokens);
        else toks.push(...wrap(b));
      });
    }
    toks.push(tok('amino', [root]));
    return makeSub(toks, all, branches.flatMap((b) => b.stereo), false);
  }
  if (el === 'C') {
    const oxo = oxoOn(ctx, root, atoms);
    const nitrileN = next.find((j) => view.el(j) === 'N' && bondOrder(ctx, root, j) === 3);
    if (nitrileN !== undefined && atoms.size === 2) return simpleSub(ctx, 'cyano', all);
    if (oxo !== undefined && !ctx.rings.inRing(root)) {
      const others = next.filter((j) => j !== oxo);
      if (others.length === 0) return simpleSub(ctx, 'formyl', all);
      if (others.length === 1) {
        const o = others[0];
        const oel = view.el(o);
        if (oel === 'O' && view.nbrs[o].length === 1 && view.atoms[o].formalCharge === 0) return simpleSub(ctx, 'carboxy', all);
        if (oel === 'O' && view.nbrs[o].length === 2) {
          const alkoxy = nameSubstituent(ctx, new Set(all.filter((a) => a !== root && a !== oxo)), o, root, 1, depth + 1);
          const body = alkoxy.simple ? alkoxy.tokens : wrap(alkoxy);
          return makeSub([...body, tok('carbonyl', [root, oxo])], all, alkoxy.stereo, false);
        }
        if (oel === 'N' && view.atoms[o].formalCharge === 0 && !ctx.rings.inRing(o)) {
          if (view.nbrs[o].length === 1) return simpleSub(ctx, 'carbamoyl', all);
          const amino = nameSubstituent(ctx, new Set(all.filter((a) => a !== root && a !== oxo)), o, root, 1, depth + 1);
          const toks = [...amino.tokens];
          const last = toks[toks.length - 1];
          toks[toks.length - 1] = { ...last, text: last.text.replace(/amino$/, 'carbamoyl'), atomIds: [...last.atomIds, ctx.id(root), ctx.id(oxo)] };
          return makeSub(toks, all, amino.stereo, false);
        }
        if (HALO[oel]) {
          const t = style === 'systematic' ? `carbono${HALIDE[oel].replace(/ide$/, 'id')}oyl` : `${HALO[oel]}carbonyl`;
          return simpleSub(ctx, t, all);
        }
        if (oel === 'C' && ctx.rings.inRing(o)) {
          // Ring acyl: cyclohexanecarbonyl, benzoyl, pyridine-3-carbonyl.
          const ringAtoms = new Set(all.filter((a) => a !== root && a !== oxo));
          return carbonSubstituent(ctx, ringAtoms, o, root, 'carbonyl', [], depth, [root, oxo]);
        }
        if (oel === 'C') return carbonSubstituent(ctx, atoms, root, from, 'oyl', [oxo], depth);
      }
    }
    return carbonSubstituent(ctx, atoms, root, from, 'yl', [], depth);
  }
  throw new NamingUnsupported(`substituents starting with ${el} are outside the verified scope`);
}

function oxy(ctx: Ctx, inner: SubName, o: number, all: number[]): SubName {
  const style = ctx.profile.substituentStyle;
  const t = inner.text;
  const oTok: NameToken = { text: 'oxy', role: 'substituent', atomIds: [ctx.id(o)] };
  const common: Record<string, string> = { isopropyl: 'isopropoxy', 'tert-butyl': 'tert-butoxy', 'sec-butyl': 'sec-butoxy', isobutyl: 'isobutoxy' };
  if (style !== 'systematic' && common[t]) return makeSub([{ text: common[t], role: 'substituent', atomIds: all.map(ctx.id) }], all, inner.stereo, true);
  // Contracted forms: methoxy, ethoxy, propoxy, butoxy, phenoxy — also when substituted (2-chloroethoxy).
  const contractible = /(meth|eth|prop|but)yl$/.test(t) && !/cyclo(meth|eth|prop|but)yl$/.test(t) || /phenyl$/.test(t);
  const last = inner.tokens[inner.tokens.length - 1];
  if (contractible && last && /(yl|phenyl)$/.test(last.text)) {
    const toks = inner.tokens.slice(0, -1).map((x) => ({ ...x }));
    const stem = last.text.slice(0, -2);
    if (stem) toks.push({ ...last, text: stem });
    toks.push({ text: 'oxy', role: 'substituent', atomIds: [...(stem ? [] : last.atomIds), ctx.id(o)] });
    return makeSub(toks, all, inner.stereo, inner.simple);
  }
  if (inner.simple) return makeSub([...inner.tokens, oTok], all, inner.stereo, false);
  return makeSub([...wrap(inner), oTok], all, inner.stereo, false);
}

/** Common and CAS-style substituent names keyed by the 2013 systematic name. */
const COMMON_SUBS: Record<string, string> = {
  'propan-2-yl': 'isopropyl', '2-methylpropyl': 'isobutyl', 'butan-2-yl': 'sec-butyl', '2-methylpropan-2-yl': 'tert-butyl',
  '1-methylethyl': 'isopropyl', '1-methylpropyl': 'sec-butyl', '1,1-dimethylethyl': 'tert-butyl',
  '2,2-dimethylpropyl': 'neopentyl', '3-methylbutyl': 'isopentyl', 'ethenyl': 'vinyl', 'prop-2-en-1-yl': 'allyl', '2-propenyl': 'allyl',
  'prop-1-en-2-yl': 'isopropenyl', '1-methylethenyl': 'isopropenyl', 'prop-2-yn-1-yl': 'propargyl', '2-propynyl': 'propargyl',
  'phenylmethyl': 'benzyl', 'methylidene': 'methylene',
};
const PIN_SUBS: Record<string, string> = { ethanoyl: 'acetyl', methanoyl: 'formyl', phenylmethyl: 'benzyl' };

function carbonSubstituent(ctx: Ctx, atoms: Set<number>, root: number, from: number, suffix: FreeSuffix, exclude: number[], depth: number, extraAtoms: number[] = []): SubName {
  const r = nameWithTask(ctx, { atoms, principal: null, free: { atom: root, from, suffix, exclude }, depth });
  let tokens = r.tokens;
  let text = tokensText(tokens);
  const allAtoms = [...atoms, ...extraAtoms];
  const map = { ...PIN_SUBS, ...(ctx.profile.substituentStyle === 'common' ? COMMON_SUBS : {}) };
  if (map[text] && !r.stereo.length) {
    text = map[text];
    tokens = [{ text, role: 'substituent', atomIds: allAtoms.map(ctx.id) }];
  } else if (extraAtoms.length) {
    // Attach the carbonyl atoms to the suffix token.
    const last = tokens[tokens.length - 1];
    tokens = [...tokens.slice(0, -1), { ...last, atomIds: [...last.atomIds, ...extraAtoms.map(ctx.id)] }];
  }
  const bare = !r.candidate.components.length && !r.stereo.length;
  const simple = /^(tert|sec)-[a-z]+$/.test(text) || (bare && !/[\d(,[{]/.test(text));
  return { tokens, text, simple, atoms: allAtoms, sortKey: alphaKey(text), stereo: r.stereo };
}

// =============================================================================================
// Assembly
// =============================================================================================

interface Assembled {
  tokens: NameToken[];
  stereo: StereoTrace[];
  substituents: SubstituentTrace[];
  candidate: Candidate;
  candidates: Candidate[];
  unspecified: number[];
}

const SUFFIX_TEXT: Record<string, { incl?: string; carbo?: string; plain?: string }> = {
  carboxylate: { incl: 'oate', carbo: 'carboxylate' },
  acid: { incl: 'oic acid', carbo: 'carboxylic acid' },
  ester: { incl: 'oate', carbo: 'carboxylate' },
  anhydride: { incl: 'oic', carbo: 'carboxylic' },
  acidHalide: { incl: 'oyl', carbo: 'carbonyl' },
  amide: { incl: 'amide', carbo: 'carboxamide' },
  nitrile: { incl: 'nitrile', carbo: 'carbonitrile' },
  aldehyde: { incl: 'al', carbo: 'carbaldehyde' },
  ketone: { plain: 'one' },
  alcohol: { plain: 'ol' },
  thiol: { plain: 'thiol' },
  amine: { plain: 'amine' },
  imine: { plain: 'imine' },
  ammonium: { plain: 'aminium' },
  alkoxide: { plain: 'olate' },
  carbocation: { plain: 'ylium' },
  carbanion: { plain: 'ide' },
};

function nameWithTask(ctx: Ctx, task: Task): Assembled {
  const candidates = buildCandidates(ctx, task);
  if (!candidates.length) throw new NamingUnsupported('no parent structure could be identified');
  for (const c of candidates) chooseNumbering(ctx, c, task.depth);
  const scored = candidates.map((c) => ({ c, s: scores(ctx, c) }));
  const nameCache = new Map<Candidate, string>();
  const fullName = (c: Candidate) => {
    if (!nameCache.has(c)) nameCache.set(c, tokensText(assemble(ctx, c, task).tokens));
    return nameCache.get(c)!;
  };
  scored.sort((x, y) => {
    const r = compareScores(x.s, y.s).c;
    if (r !== 0) return r;
    const tx = fullName(x.c);
    const ty = fullName(y.c);
    return tx < ty ? -1 : tx > ty ? 1 : 0;
  });
  const best = scored[0].c;
  const out = assemble(ctx, best, task);
  out.candidates = scored.map((s) => s.c);
  return out;
}

/** Retained names (spec §9.3): phenol, benzoic acid, acetic acid … and phenyl / benzoyl for substituents. */
function retainedCore(ctx: Ctx, c: Candidate): { text: string; atoms: number[] } | null {
  const level = ctx.profile.retained;
  if (level === 'none') return null;
  if (c.free) {
    if (c.ring?.kind === 'benzene' && c.free.suffix === 'yl') return { text: 'phenyl', atoms: c.atoms };
    if (c.ring?.kind === 'benzene' && c.free.suffix === 'carbonyl') return { text: 'benzoyl', atoms: c.atoms };
    return null;
  }
  const k = c.suffixKind;
  const n = c.suffix.length;
  const groupAtoms = c.suffix.flatMap((s) => [...s.group.hetero, ...(s.group.carbon !== undefined ? [s.group.carbon] : [])]);
  if (c.ring?.kind === 'benzene' && n === 1 && k) {
    const map: Partial<Record<CGKind, string>> = {
      alcohol: 'phenol', amine: 'aniline', acid: 'benzoic acid', aldehyde: 'benzaldehyde', nitrile: 'benzonitrile',
      amide: 'benzamide', ester: 'benzoate', carboxylate: 'benzoate', acidHalide: 'benzoyl', anhydride: 'benzoic',
    };
    if (map[k]) return { text: map[k]!, atoms: [...c.atoms, ...groupAtoms] };
  }
  if (c.kind === 'chain' && n >= 1 && k && C_INCLUSIVE.has(k) && c.suffix.every((s) => s.inclusive) && !c.multiple.length) {
    const len = c.atoms.length;
    const acetic: Partial<Record<CGKind, string>> = { acid: 'acetic acid', ester: 'acetate', carboxylate: 'acetate', amide: 'acetamide', nitrile: 'acetonitrile', acidHalide: 'acetyl', anhydride: 'acetic', aldehyde: 'acetaldehyde' };
    const formic: Partial<Record<CGKind, string>> = { acid: 'formic acid', ester: 'formate', carboxylate: 'formate', amide: 'formamide', anhydride: 'formic', aldehyde: 'formaldehyde' };
    if (len === 2 && n === 1 && acetic[k]) return { text: acetic[k]!, atoms: [...c.atoms, ...groupAtoms] };
    if (len === 1 && n === 1 && formic[k]) return { text: formic[k]!, atoms: [...c.atoms, ...groupAtoms] };
    if (len === 2 && n === 2 && k === 'acid' && !c.components.length) return { text: 'oxalic acid', atoms: [...c.atoms, ...groupAtoms] };
  }
  if (level === 'common' && c.kind === 'chain' && c.atoms.length === 3 && n === 1 && k === 'ketone' && !c.components.length && c.best!.loc.get(c.suffix[0].at) === 2) {
    return { text: 'acetone', atoms: [...c.atoms, ...groupAtoms] };
  }
  return null;
}

function labelOfValue(n: Numbering, v: number): string {
  const k = n.values.indexOf(v);
  return k >= 0 ? n.labels[k] : String(v);
}

function assemble(ctx: Ctx, c: Candidate, task: Task): Assembled {
  const b = c.best!;
  const profile = ctx.profile;
  const traditional = profile.locantStyle === 'traditional';
  const view = ctx.view;
  const lab = (a: number) => b.label.get(a)!;
  const id = ctx.id;
  const T = (text: string, role: TokenRole, atoms: number[] = [], ref?: string): NameToken => ({ text, role, atomIds: atoms.map(id), ref });

  // ---- Suffix
  const kind = c.suffixKind;
  const nSuffix = c.suffix.length;
  const groupAtoms = c.suffix.flatMap((s) => [...s.group.hetero, ...(s.group.carbon !== undefined ? [s.group.carbon] : [])]);
  let suffixText = '';
  let suffixLocants: string[] = [];
  let suffixAtoms: number[] = groupAtoms;
  let word: NameToken[] = [];
  if (c.free) {
    suffixText = c.free.suffix;
    suffixLocants = [lab(c.free.atom)];
    suffixAtoms = [c.free.atom, ...c.free.exclude];
  } else if (kind && nSuffix) {
    const inclusive = c.suffix.every((s) => s.inclusive);
    const t = SUFFIX_TEXT[kind];
    const base = t.plain ?? (inclusive ? t.incl! : t.carbo!);
    suffixText = multiplier(nSuffix) + base;
    suffixLocants = c.suffix.map((s) => b.loc.get(s.at)!).sort((x, y) => x - y).map((v) => labelOfValue(b.n, v));
    if (kind === 'acidHalide') {
      const hal = view.el(c.suffix[0].group.halogen!);
      word = [T(' ' + multiplier(nSuffix) + HALIDE[hal], 'word', c.suffix.map((s) => s.group.halogen!), 'suffix')];
    }
  }

  // ---- Substituents
  const named = c.components.map((x) => ({ comp: x, sub: subName(ctx, x, task.depth), locant: x.onNitrogen ? 'N' : lab(x.to), value: x.onNitrogen ? 0 : b.loc.get(x.to)! }));
  const suffixNs = c.suffix.filter((s) => s.group.nitrogen !== undefined);
  if (suffixNs.length > 1) {
    for (const nm of named) if (nm.comp.onNitrogen) nm.locant = 'N' + lab(suffixNs.find((s) => s.group.nitrogen === nm.comp.to)!.at);
  }
  const byText = new Map<string, typeof named>();
  for (const nm of named) {
    if (!byText.has(nm.sub.text)) byText.set(nm.sub.text, []);
    byText.get(nm.sub.text)!.push(nm);
  }
  const prefixGroups = [...byText.values()].map((g) => g.sort((x, y) => (x.comp.onNitrogen === y.comp.onNitrogen ? x.value - y.value : x.comp.onNitrogen ? -1 : 1)));
  prefixGroups.sort((x, y) => (x[0].sub.sortKey < y[0].sub.sortKey ? -1 : x[0].sub.sortKey > y[0].sub.sortKey ? 1 : x[0].value - y[0].value));

  // ---- Locant citation rules (P-14.3.4)
  const parentPrefixCount = named.filter((x) => !x.comp.onNitrogen).length;
  const unsat = c.ring?.mancude ? 0 : c.multiple.length;
  const inclusiveTerminal = !c.free && !!kind && C_INCLUSIVE.has(kind) && c.kind === 'chain' && c.suffix.every((s) => s.inclusive);
  const symmetricRing = c.kind === 'ring' && (c.ring!.kind === 'benzene' || c.ring!.kind === 'carbocycle');
  const retained = retainedCore(ctx, c);
  const nonFreeSuffix = c.free ? 0 : nSuffix;
  let omitPrefixLocants = false;
  let omitUnsatLocants = false;
  if (c.atoms.length === 1) {
    omitPrefixLocants = true;
    omitUnsatLocants = true;
    suffixLocants = [];
  } else if (c.kind === 'chain' && c.atoms.length === 2) {
    omitUnsatLocants = true;
    if (c.free) suffixLocants = [];
    if (c.free ? parentPrefixCount === 0 : parentPrefixCount + nonFreeSuffix <= 1) {
      omitPrefixLocants = true;
      suffixLocants = [];
    }
  } else if (symmetricRing || retained) {
    const features = parentPrefixCount + (c.free ? 1 : nSuffix) + unsat;
    if (features <= 1) {
      omitPrefixLocants = true;
      omitUnsatLocants = true;
      if (!c.free) suffixLocants = [];
    }
  }
  if (inclusiveTerminal) suffixLocants = [];
  if (c.free) {
    const fl = b.loc.get(c.free.atom)!;
    if (c.free.suffix === 'oyl') suffixLocants = [];
    if (c.kind === 'chain' && fl === 1 && !unsat) suffixLocants = [];
    if (c.kind === 'chain' && fl === 1 && profile.substituentStyle !== 'systematic') suffixLocants = [];
    if (symmetricRing && !unsat && fl === 1) suffixLocants = [];
    if (c.free.suffix === 'carbonyl' && symmetricRing && parentPrefixCount === 0 && !unsat) suffixLocants = [];
  }
  if (retained && !c.free) suffixLocants = [];
  // Traditional style drops the 1 of a single ring suffix: 2-methylcyclohexanol.
  if (traditional && c.kind === 'ring' && suffixLocants.length === 1 && suffixLocants[0] === '1' && !c.free) suffixLocants = [];
  const omitAll = omitPrefixLocants;

  // ---- Stereo
  const stereo: StereoTrace[] = [];
  const unspecified: number[] = [];
  for (const sc of ctx.stereo.centres) {
    const i = view.index.get(sc.atomId)!;
    if (!c.set.has(i)) continue;
    if (!sc.descriptor) {
      if (!sc.specified && !sc.needsHigherRules) unspecified.push(i);
      continue;
    }
    stereo.push(stereoTraceForCentre(ctx, i, sc.descriptor, sc.priorities, lab(i)));
  }
  for (const sb of ctx.stereo.bonds) {
    const i = view.index.get(sb.atoms[0])!;
    const j = view.index.get(sb.atoms[1])!;
    if (!c.set.has(i) || !c.set.has(j)) continue;
    if (!sb.descriptor) {
      unspecified.push(i, j);
      continue;
    }
    const lo = b.loc.get(i)! < b.loc.get(j)! ? i : j;
    stereo.push({
      atomIds: [id(i), id(j)], kind: 'E/Z', descriptor: sb.descriptor, locant: lab(lo),
      explanation: `The higher-priority group on each end of the double bond is on ${sb.descriptor === 'Z' ? 'the same side (Z, zusammen)' : 'opposite sides (E, entgegen)'}.`,
    });
  }
  const cisTrans = ringCisTrans(ctx, c, b);

  const out: NameToken[] = [];
  // Stereodescriptors.
  const descs = [...stereo].sort((x, y) => (parseFloat(String(x.locant)) || 0) - (parseFloat(String(y.locant)) || 0));
  if (descs.length) {
    const useLocants = !!task.free || profile.stereoLocants || descs.length > 1;
    out.push(T('(', 'stereo'));
    descs.forEach((d, k) => {
      if (k) out.push(T(',', 'stereo'));
      out.push({ text: (useLocants ? String(d.locant) : '') + d.descriptor, role: 'stereo', atomIds: d.atomIds, ref: 'stereo' });
    });
    out.push(T(')-', 'stereo'));
  }
  if (cisTrans) out.push({ text: cisTrans.text + '-', role: 'stereo', atomIds: cisTrans.atoms.map(id), ref: 'stereo' });

  // Prefixes.
  const substituents: SubstituentTrace[] = [];
  prefixGroups.forEach((g, gi) => {
    const ref = `sub:${gi}`;
    const sub = g[0].sub;
    const allAtoms = g.flatMap((x) => x.comp.atoms);
    const showLoc = !omitAll || g.some((x) => x.comp.onNitrogen);
    if (gi > 0 && showLoc) out.push(T('-', 'punct'));
    if (showLoc) out.push({ text: g.map((x) => x.locant).join(',') + '-', role: 'locant', atomIds: g.map((x) => id(x.comp.to)), ref });
    if (g.length > 1) out.push({ text: sub.simple ? multiplier(g.length) : complexMultiplier(g.length), role: 'multiplier', atomIds: allAtoms.map(id), ref });
    const prevText = gi > 0 ? prefixGroups[gi - 1][0].sub : null;
    const guard = !showLoc && gi > 0 && prevText && (!prevText.simple || /[)\]}]$/.test(prevText.text));
    const body = sub.simple && !guard ? sub.tokens : wrap(sub);
    for (const t of body) out.push({ ...t, atomIds: t.atomIds.length ? (g.length > 1 ? allAtoms.map(id) : t.atomIds) : [], ref });
    g.forEach((x) => substituents.push({ text: sub.text, atomIds: x.comp.atoms.map(id), attachmentAtomId: id(x.comp.to), locant: x.locant, colorIndex: gi }));
  });

  // Parent + suffix.
  const core: NameToken[] = [];
  if (retained) {
    core.push({ text: retained.text, role: 'parent', atomIds: retained.atoms.map(id), ref: 'parent' });
    core.push(...word);
  } else {
    const vowelSuffix = VOWEL.test(suffixText);
    const hydride: NameToken[] = [];
    const front: NameToken[] = [];
    if (c.ring) {
      const h = c.ring.hydride(b.n);
      if (h.indicatedH) hydride.push(T(h.indicatedH + '-', 'hydro', c.atoms.filter((a) => c.ring!.indicatedH(b.n).includes(b.loc.get(a)!))));
      if (h.replacement) hydride.push(T(h.replacement, 'parent', c.ring.heteroAtoms, 'parent'));
      if (h.complete) hydride.push(T(h.stem, 'parent', c.atoms, 'parent'));
      else unsaturation(hydride, front, h.stem);
    } else unsaturation(hydride, front, chainStem(c.atoms.length));
    function unsaturation(into: NameToken[], frontInto: NameToken[], stem: string) {
      const enes = c.multiple.filter((m) => m.order === 2);
      const ynes = c.multiple.filter((m) => m.order === 3);
      const locOf = (m: { a: number; b: number }) => Math.min(b.loc.get(m.a)!, b.loc.get(m.b)!);
      const eneL = enes.map(locOf).sort((x, y) => x - y).map((v) => labelOfValue(b.n, v));
      const yneL = ynes.map(locOf).sort((x, y) => x - y).map((v) => labelOfValue(b.n, v));
      const eneA = enes.flatMap((m) => [m.a, m.b]);
      const yneA = ynes.flatMap((m) => [m.a, m.b]);
      if (!enes.length && !ynes.length) {
        into.push(T(stem, 'parent', c.atoms, 'parent'), T('ane', 'parent', c.atoms, 'parent'));
        return;
      }
      const aForm = enes.length > 1 || (!enes.length && ynes.length > 1);
      into.push(T(stem + (aForm ? 'a' : ''), 'parent', c.atoms, 'parent'));
      if (traditional) {
        // CAS style: 1,3-butadiene, 3-buten-2-ol, 1-penten-4-yne.
        const lead = enes.length ? eneL : yneL;
        const leadA = enes.length ? eneA : yneA;
        if (!omitUnsatLocants) frontInto.push(T(lead.join(',') + '-', 'locant', leadA));
        if (enes.length) into.push(T(multiplier(enes.length) + (ynes.length ? 'en' : 'ene'), 'unsaturation', eneA));
        if (enes.length && ynes.length && !omitUnsatLocants) into.push(T('-' + yneL.join(',') + '-', 'locant', yneA));
        if (ynes.length) into.push(T(multiplier(ynes.length) + 'yne', 'unsaturation', yneA));
        return;
      }
      if (enes.length) {
        if (!omitUnsatLocants) into.push(T('-' + eneL.join(',') + '-', 'locant', eneA));
        into.push(T(multiplier(enes.length) + (ynes.length ? 'en' : 'ene'), 'unsaturation', eneA));
      }
      if (ynes.length) {
        if (!omitUnsatLocants) into.push(T('-' + yneL.join(',') + '-', 'locant', yneA));
        into.push(T(multiplier(ynes.length) + 'yne', 'unsaturation', yneA));
      }
    }
    const tradSuffixFront = traditional && !unsat && suffixLocants.length > 0 && !c.free;
    if (front.length) core.push(...front);
    if (tradSuffixFront) core.push(T(suffixLocants.join(',') + '-', 'locant', suffixAtoms, 'suffix'));
    core.push(...hydride);
    if (c.free && ['yl', 'ylidene', 'ylidyne'].includes(c.free.suffix) && !unsat && !suffixLocants.length && !c.ring?.hydride(b.n).complete) {
      const last = core[core.length - 1];
      if (last?.text === 'ane') core.pop();
    }
    if (suffixText) {
      const showLoc = suffixLocants.length > 0 && !tradSuffixFront;
      // Elide the final e of the hydride before a vowel (butan-2-ol, cyclohexanone, pyridin-2-yl).
      const last = core[core.length - 1];
      if (vowelSuffix && last.text.endsWith('e')) core[core.length - 1] = { ...last, text: last.text.slice(0, -1) };
      if (showLoc) core.push(T('-' + suffixLocants.join(',') + '-', 'locant', suffixAtoms, 'suffix'));
      core.push(T(suffixText, 'suffix', suffixAtoms, 'suffix'));
      core.push(...word);
    }
  }
  // Join prefixes and core: a hyphen is needed only when the core starts with a digit (locant or indicated H).
  if (out.length && core.length) {
    const prev = out[out.length - 1].text;
    if (/^\d/.test(core[0].text) && /[a-z)\]}]$/.test(prev)) out.push(T('-', 'punct'));
  }
  out.push(...core);
  for (const nm of named) stereo.push(...nm.sub.stereo);
  return { tokens: out.filter((t) => t.text), stereo, substituents, candidate: c, candidates: [c], unspecified };
}

function stereoTraceForCentre(ctx: Ctx, i: number, d: 'R' | 'S', priorities: StereoNeighbour[], locLabel: string | undefined): StereoTrace {
  const lowest = priorities[3];
  const lowestText = lowest === 'H' ? 'the hydrogen' : lowest === 'LP' ? 'the lone pair' : `the ${ctx.view.el(ctx.view.idx(lowest as AtomId))}`;
  return {
    atomIds: [ctx.id(i)], kind: 'R/S', descriptor: d, locant: locLabel,
    priorities: priorities.map((p, k) => ({ atomId: p as AtomId | 'H' | 'LP', rank: k + 1 })),
    lowestPriority: lowest as AtomId | 'H' | 'LP',
    explanation: `With ${lowestText} (priority 4) pointing away, priorities 1 → 2 → 3 run ${d === 'R' ? 'clockwise (R, rectus)' : 'counter-clockwise (S, sinister)'}.`,
  };
}

function ringCisTrans(ctx: Ctx, c: Candidate, b: NumEval): { text: string; atoms: number[] } | null {
  if (c.kind !== 'ring' || !c.ring || c.ring.ringCount !== 1) return null;
  const pseudo = ctx.stereo.centres.filter((sc) => sc.needsHigherRules && c.set.has(ctx.view.index.get(sc.atomId)!) && ctx.view.atoms[ctx.view.index.get(sc.atomId)!].stereo);
  if (pseudo.length !== 2) return null;
  const cycle = b.n.atoms;
  const faces: number[] = [];
  for (const sc of pseudo) {
    const i = ctx.view.index.get(sc.atomId)!;
    const k = cycle.indexOf(i);
    const prev = cycle[(k - 1 + cycle.length) % cycle.length];
    const next = cycle[(k + 1) % cycle.length];
    const exo: StereoNeighbour[] = ctx.view.nbrs[i].filter((j) => !c.set.has(j)).map((j) => ctx.id(j));
    if (ctx.view.implicitH(i) === 1) exo.push('H');
    if (exo.length !== 2) return null;
    const hi = ctx.cip.compareBranches(i, exo[0], exo[1]) >= 0 ? exo[0] : exo[1];
    const lo = hi === exo[0] ? exo[1] : exo[0];
    const st = ctx.view.atoms[i].stereo!;
    faces.push(sameConfiguration(st.order, st.parity, [ctx.id(prev), ctx.id(next), hi, lo], 'cw') ? 1 : 0);
  }
  return { text: faces[0] === faces[1] ? 'cis' : 'trans', atoms: pseudo.map((sc) => ctx.view.index.get(sc.atomId)!) };
}

// =============================================================================================
// Esters and anhydrides (functional class names)
// =============================================================================================

function nameEsters(ctx: Ctx, atoms: Set<number>): Assembled {
  const allEsters = ctx.groups.filter((g) => g.kind === 'ester' && atoms.has(g.carbon!));
  // An ester whose alcohol side carries another ester is cited as a prefix (acyloxy) instead.
  const esters = allEsters.filter((g) => {
    const part = collectBranch(ctx, atoms, g.esterR!, g.esterO!);
    return !allEsters.some((e) => e !== g && part.has(e.carbon!));
  });
  if (!esters.length) throw new NamingUnsupported('cyclic polyesters are outside the verified scope');
  const alcohol: Array<{ atoms: Set<number>; root: number; o: number }> = [];
  const used = new Set<number>();
  for (const g of esters) {
    const part = collectBranch(ctx, atoms, g.esterR!, g.esterO!);
    for (const a of part) {
      if (used.has(a)) throw new NamingUnsupported('esters whose alcohol part carries further ester groups are outside the verified scope');
    }
    part.forEach((a) => used.add(a));
    alcohol.push({ atoms: part, root: g.esterR!, o: g.esterO! });
  }
  const acidAtoms = new Set([...atoms].filter((a) => !used.has(a)));
  const acid = nameWithTask(ctx, { atoms: acidAtoms, principal: 'ester', depth: 0 });
  if (acid.candidate.suffix.length !== esters.length) throw new NamingUnsupported('not every ester group sits on one parent chain or ring');
  const alkyls = alcohol.map((p) => ({ p, sub: nameSubstituent(ctx, p.atoms, p.root, p.o, 1, 1) }));
  alkyls.sort((x, y) => (x.sub.sortKey < y.sub.sortKey ? -1 : x.sub.sortKey > y.sub.sortKey ? 1 : 0));
  const byText = new Map<string, typeof alkyls>();
  for (const a of alkyls) {
    if (!byText.has(a.sub.text)) byText.set(a.sub.text, []);
    byText.get(a.sub.text)!.push(a);
  }
  const toks: NameToken[] = [];
  for (const [, g] of byText) {
    if (toks.length) toks.push({ text: ' ', role: 'punct', atomIds: [] });
    const sub = g[0].sub;
    const all = g.flatMap((x) => [...x.p.atoms]);
    if (g.length > 1) toks.push({ text: sub.simple ? multiplier(g.length) : complexMultiplier(g.length), role: 'multiplier', atomIds: all.map(ctx.id), ref: 'alkyl' });
    const body = sub.simple ? sub.tokens : g.length > 1 || /^[\d(]/.test(sub.text) ? wrap(sub) : sub.tokens;
    for (const t of body) toks.push({ ...t, atomIds: t.atomIds.length ? (g.length > 1 ? all.map(ctx.id) : t.atomIds) : [], ref: 'alkyl' });
  }
  toks.push({ text: ' ', role: 'punct', atomIds: [] });
  toks.push(...acid.tokens);
  return { ...acid, tokens: toks, stereo: [...acid.stereo, ...alkyls.flatMap((a) => a.sub.stereo)] };
}

function nameAnhydride(ctx: Ctx, atoms: Set<number>): Assembled {
  const all = ctx.groups.filter((x) => x.kind === 'anhydride' && atoms.has(x.carbon!));
  if (all.length > 1) throw new NamingUnsupported('polyanhydrides are outside the verified scope');
  const g = all[0];
  const bridge = g.hetero[1];
  const partA = collectBranch(ctx, atoms, g.carbon!, bridge);
  const partB = collectBranch(ctx, atoms, g.partnerCarbon!, bridge);
  if ([...partA].some((a) => partB.has(a))) throw new NamingUnsupported('cyclic anhydrides are named as heterocycles');
  const acidPart = (part: Set<number>, carbon: number, oxo: number) => {
    const pseudo: CharGroup = { kind: 'anhydride', anchors: [carbon], hetero: [oxo], carbon };
    const saved = ctx.groups;
    ctx.groups = [...saved.filter((x) => x !== g), pseudo];
    ctx.subMemo.clear();
    try {
      return nameWithTask(ctx, { atoms: part, principal: 'anhydride', depth: 0 });
    } finally {
      ctx.groups = saved;
      ctx.subMemo.clear();
    }
  };
  const a = acidPart(partA, g.carbon!, g.hetero[0]);
  const b = acidPart(partB, g.partnerCarbon!, g.hetero[2]);
  const ta = tokensText(a.tokens);
  const tb = tokensText(b.tokens);
  const tail: NameToken = { text: ' anhydride', role: 'word', atomIds: [ctx.id(bridge)], ref: 'suffix' };
  const toks = ta === tb ? [...a.tokens, tail] : ta < tb ? [...a.tokens, { text: ' ', role: 'punct' as TokenRole, atomIds: [] }, ...b.tokens, tail] : [...b.tokens, { text: ' ', role: 'punct' as TokenRole, atomIds: [] }, ...a.tokens, tail];
  return { ...a, tokens: toks, stereo: [...a.stereo, ...b.stereo] };
}

// =============================================================================================
// Public API
// =============================================================================================

export interface EngineOutput {
  name: string;
  tokens: NameToken[];
  trace: NamingTrace;
  warnings: string[];
}

const MONATOMIC_IONS: Record<string, string> = {
  'Na+1': 'sodium', 'K+1': 'potassium', 'Li+1': 'lithium', 'Cs+1': 'caesium', 'Mg+2': 'magnesium', 'Ca+2': 'calcium',
  'Cl-1': 'chloride', 'Br-1': 'bromide', 'I-1': 'iodide', 'F-1': 'fluoride', 'Zn+2': 'zinc', 'Ag+1': 'silver',
};

export function prepareForNaming(doc: MoleculeDocument): MoleculeDocument {
  return perceiveAromaticity(suppressHydrogens(doc));
}

export function runEngine(input: MoleculeDocument, profile: NamingProfile = PROFILE_2013): EngineOutput {
  const doc = prepareForNaming(input);
  if (!doc.atoms.length) throw new NamingUnsupported('the canvas is empty');
  const ctx = makeCtx(doc, profile);
  const comps = ctx.view.components();
  if (comps.length > 1) return nameSalt(ctx, comps);
  return nameSingle(ctx, new Set(comps[0]));
}

function nameSalt(ctx: Ctx, comps: number[][]): EngineOutput {
  const parts: Array<{ text: string; tokens: NameToken[]; charge: number; ion: boolean }> = [];
  for (const comp of comps) {
    const charge = comp.reduce((s, i) => s + ctx.view.atoms[i].formalCharge, 0);
    if (comp.length === 1) {
      const a = ctx.view.atoms[comp[0]];
      const key = `${a.element}${a.formalCharge >= 0 ? '+' : ''}${a.formalCharge}`;
      if (MONATOMIC_IONS[key]) {
        parts.push({ text: MONATOMIC_IONS[key], tokens: [{ text: MONATOMIC_IONS[key], role: 'word', atomIds: [a.id] }], charge, ion: true });
        continue;
      }
      if (a.element === 'N' && a.formalCharge === 1) {
        parts.push({ text: 'ammonium', tokens: [{ text: 'ammonium', role: 'word', atomIds: [a.id] }], charge, ion: true });
        continue;
      }
    }
    const r = nameSingle(ctx, new Set(comp));
    parts.push({ text: r.name, tokens: r.tokens, charge, ion: false });
  }
  const cations = parts.filter((p) => p.charge > 0);
  const anions = parts.filter((p) => p.charge < 0);
  if (parts.some((p) => p.charge === 0) || !cations.length || !anions.length) throw new NamingUnsupported('mixtures of separate neutral molecules are named one species at a time');
  if (cations.reduce((s, p) => s + p.charge, 0) !== -anions.reduce((s, p) => s + p.charge, 0)) throw new NamingUnsupported('the ions do not balance');
  const tokens: NameToken[] = [];
  const emit = (list: typeof parts) => {
    const m = new Map<string, typeof parts>();
    for (const p of list) {
      if (!m.has(p.text)) m.set(p.text, []);
      m.get(p.text)!.push(p);
    }
    for (const g of m.values()) {
      if (tokens.length) tokens.push({ text: ' ', role: 'punct', atomIds: [] });
      const ids = g.flatMap((p) => p.tokens.flatMap((t) => t.atomIds));
      if (g.length > 1) tokens.push({ text: g[0].ion || !/[\d(-]/.test(g[0].text) ? multiplier(g.length) : complexMultiplier(g.length), role: 'multiplier', atomIds: ids });
      tokens.push(...g[0].tokens.map((t) => ({ ...t, atomIds: g.length > 1 ? ids : t.atomIds })));
    }
  };
  emit(cations);
  emit(anions);
  const name = tokensText(tokens);
  const trace = blankTrace(ctx, name, tokens);
  trace.parent.explanation = 'Ionic compound: the cation is named first, then the anion.';
  return { name, tokens, trace, warnings: ctx.warnings };
}

function blankTrace(ctx: Ctx, name: string, tokens: NameToken[]): NamingTrace {
  return {
    name, status: 'pending_verification',
    principalGroup: { kind: null, label: 'none', atomIds: [], present: [], explanation: '' },
    parent: { atomIds: [], root: '', kind: 'chain', label: '', alternatives: [], explanation: '' },
    numbering: { orderedAtomIds: [], reason: '', locantOf: {} },
    substituents: [], stereo: [], unspecifiedStereo: [], assembly: [name], tokens, engineVersion: ENGINE_VERSION, profileId: ctx.profile.id,
  };
}

function nameSingle(ctx: Ctx, atoms: Set<number>): EngineOutput {
  const view = ctx.view;
  if (![...atoms].some((a) => view.el(a) === 'C')) throw new NamingUnsupported('the course engine names carbon compounds; other species come from the database tier');
  for (const a of atoms) {
    const el = view.el(a);
    if (!['C', 'H', 'N', 'O', 'S', 'F', 'Cl', 'Br', 'I'].includes(el)) throw new NamingUnsupported(`${el} is outside the course engine's verified scope`);
    if (view.atoms[a].radicalElectrons) throw new NamingUnsupported('radicals are outside the verified scope');
    if (view.atoms[a].isotope) throw new NamingUnsupported('isotopically labelled compounds are outside the verified scope');
  }
  for (const s of ctx.rings.systems) {
    if (s.atoms.some((a) => atoms.has(a)) && !ctx.ringParents.get(s)) {
      throw new NamingUnsupported(`this ring system (${s.rings.length} ring${s.rings.length > 1 ? 's' : ''}, ${s.atoms.length} atoms) is outside the course engine's verified scope`);
    }
  }
  for (const a of atoms) {
    if (view.el(a) !== 'C') continue;
    const hetero = view.nbrs[a].filter((j) => ['O', 'N', 'S'].includes(view.el(j)));
    const heteroBonds = hetero.reduce((s2, j) => s2 + bondOrder(ctx, a, j), 0);
    if (hetero.length >= 3 || heteroBonds >= 4) throw new NamingUnsupported('carbonic-acid derivatives (ureas, carbamates, carbonates) use special names outside the course engine');
    if (view.nbrs[a].some((j) => view.el(j) === 'O' && bondOrder(ctx, a, j) === 2) && view.nbrs[a].some((j) => view.el(j) === 'S')) throw new NamingUnsupported('thioacids and thioesters are outside the course engine\'s verified scope');
    if (view.nbrs[a].some((j) => view.el(j) === 'S' && bondOrder(ctx, a, j) === 2)) throw new NamingUnsupported('thiocarbonyl compounds are outside the course engine\'s verified scope');
  }
  const groupsHere = ctx.groups.filter((g) => g.anchors.some((a) => atoms.has(a)));
  const pk = principalKind(groupsHere);
  let result: Assembled;
  if (pk === 'ester') result = nameEsters(ctx, atoms);
  else if (pk === 'anhydride') result = nameAnhydride(ctx, atoms);
  else result = nameWithTask(ctx, { atoms, principal: pk, depth: 0 });
  const name = tokensText(result.tokens);
  checkCoverage(ctx, result, atoms);
  return { name, tokens: result.tokens, trace: buildTrace(ctx, result, pk, groupsHere, name, atoms), warnings: ctx.warnings };
}

/** Stereo that the name cannot express must never be silently dropped. */
function checkCoverage(ctx: Ctx, r: Assembled, atoms: Set<number>): void {
  const expressed = new Set(r.stereo.flatMap((s) => s.atomIds));
  const cisTransAtoms = new Set(r.tokens.filter((t) => t.role === 'stereo' && /^(cis|trans)-$/.test(t.text)).flatMap((t) => t.atomIds));
  for (const sc of ctx.stereo.centres) {
    const i = ctx.view.index.get(sc.atomId)!;
    if (!atoms.has(i) || !ctx.view.atoms[i].stereo) continue;
    if (sc.descriptor && !expressed.has(sc.atomId)) throw new NamingUnsupported('a specified stereocentre could not be placed in the name');
    if (sc.needsHigherRules && !cisTransAtoms.has(sc.atomId)) throw new NamingUnsupported('this stereochemistry needs CIP rules beyond 1–2 (pseudoasymmetry); the course engine will not guess');
  }
  for (const sb of ctx.stereo.bonds) {
    if (!sb.descriptor) continue;
    if (!atoms.has(ctx.view.index.get(sb.atoms[0])!)) continue;
    if (!expressed.has(sb.atoms[0]) && !expressed.has(sb.atoms[1])) throw new NamingUnsupported('a specified double-bond configuration could not be placed in the name');
  }
}

// =============================================================================================
// Trace
// =============================================================================================

function buildTrace(ctx: Ctx, r: Assembled, pk: CGKind | null, groups: CharGroup[], name: string, atoms: Set<number>): NamingTrace {
  const c = r.candidate;
  const b = c.best!;
  const id = ctx.id;
  const present = SENIORITY.filter((k) => groups.some((g) => g.kind === k)).map((k) => ({
    kind: k, label: CG_LABEL[k], rank: SENIORITY.indexOf(k) + 1,
    atomIds: groups.filter((g) => g.kind === k).flatMap((g) => [...g.hetero, ...(g.carbon !== undefined ? [g.carbon] : [])]).map(id),
  }));
  const principalAtoms = c.suffix.flatMap((s) => [...s.group.hetero, ...(s.group.carbon !== undefined ? [s.group.carbon] : [])]);
  const others = present.slice(1).map((p) => p.label);
  const pgExplanation = pk
    ? `The most senior characteristic group is the ${CG_LABEL[pk]}, so it is cited as the suffix${others.length ? `; ${others.join(', ')} ${others.length > 1 ? 'are' : 'is'} cited as prefix${others.length > 1 ? 'es' : ''}` : ''}.`
    : 'No group here can be cited as a suffix, so the name is built on the parent hydride alone.';

  const winner = scores(ctx, c);
  const alts: ParentAlternative[] = [];
  const seen = new Set<string>([[...c.atoms].sort((p, q) => p - q).join(',')]);
  for (const x of r.candidates) {
    if (x === c) continue;
    const key = [...x.atoms].sort((p, q) => p - q).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const cmp = compareScores(winner, scores(ctx, x));
    const crit = cmp.criterion ?? 'alphanumeric';
    const fmt = (v: number | number[] | undefined) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));
    alts.push({
      atomIds: x.atoms.map(id), label: x.label, criterion: crit,
      rejectedBecause: (PARENT_REASON[crit] ?? PARENT_REASON.alphanumeric)(fmt(cmp.av), fmt(cmp.bv), ctx.profile),
      values: { chosen: fmt(cmp.av), alternative: fmt(cmp.bv) },
    });
  }
  const instructive = ['substituentCount', 'length', 'multipleBonds', 'substituentLocants', 'alphaLocants', 'doubleBonds', 'principalLocants', 'multiLocants', 'doubleLocants', 'ringOverChain', 'largerUnit', 'principalCount', 'carboMode', 'alphanumeric'];
  alts.sort((p, q) => instructive.indexOf(p.criterion) - instructive.indexOf(q.criterion) || q.atomIds.length - p.atomIds.length);
  const topAlts = alts.slice(0, 6);
  const parentText = c.kind === 'chain'
    ? `The parent is the ${c.atoms.length}-carbon chain${pk ? ' that carries the principal group' : ''}${topAlts.length ? `. The ${topAlts[0].label} was rejected because ${topAlts[0].rejectedBecause}` : ''}.`
    : `The parent is the ${c.ring!.describe}${topAlts.length ? `. The ${topAlts[0].label} was rejected because ${topAlts[0].rejectedBecause}` : ''}.`;

  let alternative: NumberingAlternative | undefined;
  let reason = c.numberings.length > 1 ? 'Every direction gives the same locants.' : 'Only one numbering is possible.';
  if (c.runnerUp) {
    const crit = c.decidingNumberingCriterion ?? 'prefixes';
    const va = b.vecs.find((v) => v.name === crit)?.vec ?? [];
    const vb = c.runnerUp.vecs.find((v) => v.name === crit)?.vec ?? [];
    const fd = firstDifference(va, vb);
    alternative = { orderedAtomIds: c.runnerUp.n.atoms.map(id), locants: vb, chosenLocants: va, criterion: crit, firstPointOfDifference: fd ? `${fd.a} vs ${fd.b}` : `{${va.join(',')}} vs {${vb.join(',')}}` };
    reason = `Number so that ${NUMBERING_CRITERIA_TEXT[crit] ?? crit}: {${va.join(',')}} beats {${vb.join(',')}}${fd ? ` — the first point of difference is ${fd.a} vs ${fd.b}` : ''}.`;
  }
  const locantOf: Record<AtomId, number> = {};
  b.n.atoms.forEach((a, k) => (locantOf[id(a)] = b.n.values[k]));
  const unspecified = new Set<number>(r.unspecified);
  for (const sc of ctx.stereo.centres) {
    const i = ctx.view.index.get(sc.atomId)!;
    if (atoms.has(i) && !sc.specified && !sc.needsHigherRules) unspecified.add(i);
  }
  for (const sb of ctx.stereo.bonds) {
    if (sb.specified) continue;
    for (const aid of sb.atoms) {
      const i = ctx.view.index.get(aid)!;
      if (atoms.has(i)) unspecified.add(i);
    }
  }
  const assembly: string[] = [];
  let cur = '';
  let curRef: string | undefined;
  for (const t of r.tokens) {
    const ref = t.ref?.startsWith('sub:') ? t.ref : t.role === 'stereo' ? 'stereo' : t.ref === 'alkyl' ? 'alkyl' : 'core';
    if (curRef !== undefined && ref !== curRef && cur.replace(/[- ]/g, '')) {
      assembly.push(cur.replace(/^[- ]+|[- ]+$/g, ''));
      cur = '';
    }
    curRef = ref;
    cur += t.text;
  }
  if (cur.trim()) assembly.push(cur.replace(/^[- ]+|[- ]+$/g, ''));
  return {
    name,
    status: 'pending_verification',
    principalGroup: { kind: pk, label: pk ? CG_LABEL[pk] : 'none', atomIds: [...new Set(principalAtoms)].map(id), present, explanation: pgExplanation },
    parent: {
      atomIds: c.atoms.map(id),
      root: c.ring ? c.ring.hydride(b.n).stem + (c.ring.hydride(b.n).complete ? '' : 'ane') : chainStem(c.atoms.length) + 'ane',
      kind: c.kind, label: c.label, alternatives: topAlts, explanation: parentText,
    },
    numbering: { orderedAtomIds: b.n.atoms.map(id), reason, alternative, locantOf },
    substituents: r.substituents,
    stereo: r.stereo,
    unspecifiedStereo: [...unspecified].map(id),
    assembly,
    tokens: r.tokens,
    engineVersion: ENGINE_VERSION,
    profileId: ctx.profile.id,
  };
}
