/**
 * Condensed structural formulas — what students actually write in their notes: HN(CH3)2,
 * CH3CH2OH, (CH3)3COH, CH3(CH2)4CH3, CH3COOH, C6H5OH.
 *
 * These are not molecular formulas (C2H7N) and not SMILES: parentheses mean a group, a digit
 * after an element means "this many of them", and hydrogens are always written out, so an atom
 * with no H beside it has none. That last rule is what makes the reading unambiguous: build the
 * skeleton with single bonds, then raise bonds until every atom's valence is exactly filled —
 * which is how CH3COOH gets its C=O and CH3CN its C≡N.
 *
 * Where a bracket could be read two ways — a branch, as in CH3CH(OH)CH3, or a piece of the
 * chain, as in CH3(CH2)4CH3 — both readings are built and the one whose valences work is kept.
 */
import { typicalValence } from './elements.ts';
import { emptyDocument } from './types.ts';
import type { BondOrder, MoleculeDocument } from './types.ts';

export interface CondensedParse {
  doc: MoleculeDocument;
  /** How it was read, for telling the student what happened. */
  reading: string;
}

/** Two-letter symbols worth recognising in organic shorthand; everything else is one letter. */
const TWO_LETTER = ['Cl', 'Br', 'Si', 'Se', 'Sn', 'Mg', 'Li', 'Na', 'Zn', 'Al'];
const ONE_LETTER = ['C', 'N', 'O', 'S', 'P', 'F', 'I', 'B', 'K', 'H'];

/** Group shorthands students write instead of spelling the atoms out. */
const SHORTHAND: Record<string, string> = { Ph: 'C6H5', Me: 'CH3', Et: 'C2H5', Pr: 'C3H7', Bu: 'C4H9', Ac: 'C(=O)CH3' };

type Item =
  | { kind: 'atom'; el: string; h: number; count: number }
  | { kind: 'alkyl'; carbons: number }
  | { kind: 'phenyl' }
  | { kind: 'group'; items: Item[]; count: number }
  | { kind: 'bond'; order: BondOrder };

interface Cursor { s: string; i: number }

function parseItems(c: Cursor, depth = 0): Item[] | null {
  const items: Item[] = [];
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === ')') {
      if (!depth) return null;
      return items;
    }
    if (ch === '(' || ch === '[') {
      c.i++;
      const inner = parseItems(c, depth + 1);
      const close = c.s[c.i];
      if (!inner || !inner.length || (close !== ')' && close !== ']')) return null;
      c.i++;
      items.push({ kind: 'group', items: inner, count: readNumber(c) });
      continue;
    }
    if (ch === '=' || ch === '#' || ch === '≡') {
      c.i++;
      items.push({ kind: 'bond', order: ch === '=' ? 2 : 3 });
      continue;
    }
    if (ch === '-' || ch === '–' || ch === '·' || ch === ' ') {
      c.i++;
      continue;
    }
    const el = readElement(c);
    if (!el) return null;
    const count = readNumber(c);
    // Cn H(2n+1) is an alkyl group; C6H5 is a phenyl ring; otherwise a digit means repeats.
    if (el === 'C' && count > 1 && c.s[c.i] === 'H') {
      const save = c.i;
      c.i++;
      const hn = readNumber(c);
      if (count === 6 && hn === 5) {
        items.push({ kind: 'phenyl' });
        continue;
      }
      if (hn === 2 * count + 1) {
        items.push({ kind: 'alkyl', carbons: count });
        continue;
      }
      c.i = save;
      return null; // C5H10 and friends are molecular formulas, not condensed ones
    }
    if (el === 'H') {
      // A bare H belongs to the atom beside it: HN(CH3)2, H2O, CH3CH2OH's OH.
      items.push({ kind: 'atom', el: 'H', h: 0, count });
      continue;
    }
    let h = 0;
    if (c.s[c.i] === 'H') {
      c.i++;
      h = readNumber(c);
    }
    items.push({ kind: 'atom', el, h, count });
  }
  return depth ? null : items;
}

function readElement(c: Cursor): string | null {
  const two = c.s.slice(c.i, c.i + 2);
  if (SHORTHAND[two]) {
    c.i += 2;
    return SHORTHAND[two];
  }
  if (TWO_LETTER.includes(two)) {
    c.i += 2;
    return two;
  }
  const one = c.s[c.i];
  if (ONE_LETTER.includes(one)) {
    c.i += 1;
    return one;
  }
  return null;
}

function readNumber(c: Cursor): number {
  let n = '';
  while (c.i < c.s.length && /\d/.test(c.s[c.i])) n += c.s[c.i++];
  return n ? Number(n) : 1;
}

// ------------------------------------------------------------------------------------------
// Building

interface Build {
  el: string[];
  h: number[];
  /** Atoms whose hydrogens weren't written out (inside C2H5, Ph…): they take whatever is left. */
  flex: boolean[];
  bonds: Array<{ a: number; b: number; order: number }>;
}

const add = (b: Build, el: string, h: number, flex = false) => (b.el.push(el), b.h.push(h), b.flex.push(flex), b.el.length - 1);

function join(b: Build, a: number, z: number, order: number) {
  b.bonds.push({ a, b: z, order });
}

interface Choices {
  /** For each bracket, in order: does it hang off the atom before it, or continue the chain? */
  groups: boolean[];
  /** For each atom written after another: does the chain continue from it, or is it a branch? */
  atoms: boolean[];
  g: number;
  a: number;
}

/**
 * Lay a sequence of items into the structure, following the reading in `choices`. Writing
 * CH3COOH, the two oxygens hang off the same carbon; writing CH3OCH3, the oxygen is in the
 * chain. The text looks the same, so both readings get built and valence decides.
 */
function layout(b: Build, items: Item[], start: number | null, choices: Choices): number | null {
  let prev = start;
  let pendingOrder = 1;
  let pendingH = 0; // a leading H waits for the atom it belongs to
  const attach = (index: number) => {
    if (prev !== null) join(b, prev, index, pendingOrder);
    pendingOrder = 1;
  };
  for (const item of items) {
    if (item.kind === 'bond') {
      pendingOrder = item.order;
      continue;
    }
    if (item.kind === 'atom' && item.el === 'H') {
      if (prev === null) pendingH += item.count;
      else b.h[prev] += item.count;
      continue;
    }
    if (item.kind === 'atom') {
      if (item.count === 1) {
        const index = add(b, item.el, item.h + pendingH);
        pendingH = 0;
        const branch = prev !== null && (choices.atoms[choices.a++] ?? false);
        attach(index);
        if (!branch) prev = index;
      } else {
        // CCl4, CF3: several of the same atom hanging off the atom before them.
        if (prev === null) return null;
        for (let k = 0; k < item.count; k++) join(b, prev, add(b, item.el, item.h), 1);
      }
      continue;
    }
    if (item.kind === 'alkyl' || item.kind === 'phenyl') {
      const ring = item.kind === 'phenyl';
      const n = ring ? 6 : item.carbons;
      // C2H5 says how many hydrogens the group has in total, not which carbon holds them:
      // whichever end ends up bonded keeps one fewer, so let the valences settle it.
      const first = add(b, 'C', ring ? 1 : 0, !ring);
      let last = first;
      for (let k = 1; k < n; k++) {
        const next = add(b, 'C', ring ? 1 : 0, !ring);
        join(b, last, next, 1);
        last = next;
      }
      if (ring) {
        join(b, last, first, 1);
        b.h[first] = 0; // the attachment point carries no hydrogen
      }
      attach(first);
      prev = ring ? first : last;
      continue;
    }
    // A bracket.
    const branch = choices.groups[choices.g++] ?? true;
    if (branch) {
      if (prev === null) {
        // (CH3)2NH — the groups belong to whatever comes next; build them after it.
        const rest = items.slice(items.indexOf(item) + 1);
        const anchor = layout(b, rest, null, choices);
        if (anchor === null) return null;
        for (let k = 0; k < item.count; k++) {
          const head = layout(b, item.items, null, choices);
          if (head === null) return null;
          join(b, anchor, head, 1);
        }
        return anchor;
      }
      for (let k = 0; k < item.count; k++) {
        const head = layout(b, item.items, null, choices);
        if (head === null) return null;
        join(b, prev, head, pendingOrder);
      }
      pendingOrder = 1;
    } else {
      for (let k = 0; k < item.count; k++) {
        const next = layout(b, item.items, prev, choices);
        if (next === null) return null;
        prev = next;
      }
    }
  }
  return prev;
}

/** Raise bond orders until every atom's valence is exactly used, or report that it can't be. */
function fillValences(b: Build): boolean {
  const valence = b.el.map((e) => typicalValence(e) ?? 0);
  // Flexible atoms soak up their remaining valence as hydrogen, so they are never short.
  const rigid = (i: number) => !b.flex[i];
  const used = () => {
    const u = b.el.map((_, i) => b.h[i]);
    for (const bond of b.bonds) {
      u[bond.a] += bond.order;
      u[bond.b] += bond.order;
    }
    return u;
  };
  const solve = (depth: number): boolean => {
    const u = used();
    if (u.some((v, i) => v > valence[i])) return false;
    const short = u.map((v, i) => (rigid(i) ? valence[i] - v : 0));
    if (short.every((v) => v === 0)) return true;
    if (depth > 12) return false;
    for (const bond of b.bonds) {
      if (bond.order < 3 && short[bond.a] > 0 && short[bond.b] > 0) {
        bond.order++;
        if (solve(depth + 1)) return true;
        bond.order--;
      }
    }
    return false;
  };
  return solve(0);
}

const bits = (n: number) => { let c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };

function toDocument(b: Build): MoleculeDocument {
  const doc = emptyDocument();
  const ids = b.el.map((element, i) => {
    const id = `a${i + 1}`;
    doc.atoms.push({ id, element, formalCharge: 0, aromatic: false });
    return id;
  });
  doc.nextAtom = b.el.length + 1;
  b.bonds.forEach((bond, k) => {
    doc.bonds.push({ id: `b${k + 1}`, a1: ids[bond.a], a2: ids[bond.b], order: bond.order as BondOrder, aromatic: false });
  });
  doc.nextBond = b.bonds.length + 1;
  return doc;
}

/**
 * Read a condensed structural formula. Returns null when the text isn't one — a molecular
 * formula (C5H10), a name, SMILES — so the caller can go on trying other readings.
 */
export function parseCondensed(text: string): CondensedParse | null {
  const s = text.replace(/\s+/g, '');
  if (!s || s.length > 200 || !/^[A-Za-z0-9()[\]=#≡·\-–]+$/.test(s)) return null;
  const items = parseItems({ s, i: 0 });
  if (!items || !items.length) return null;
  const heavy = (list: Item[]): number =>
    list.reduce((n, it) => n + (it.kind === 'atom' ? (it.el === 'H' ? 0 : it.count) : it.kind === 'group' ? heavy(it.items) * it.count : it.kind === 'alkyl' ? it.carbons : it.kind === 'phenyl' ? 6 : 0), 0);
  if (heavy(items) < 1) return null;
  const groups = (list: Item[]): number => list.reduce((n, it) => n + (it.kind === 'group' ? 1 + groups(it.items) : 0), 0);
  const atomSpots = (list: Item[]): number =>
    list.reduce((n, it) => n + (it.kind === 'atom' && it.el !== 'H' && it.count === 1 ? 1 : it.kind === 'group' ? atomSpots(it.items) : 0), 0);
  const brackets = groups(items);
  const spots = Math.min(atomSpots(items), 14);
  if (brackets > 6) return null;
  // Every reading of the brackets and of each atom's attachment, the plainest first: a chain
  // with no branches, then one deviation, then two… The first whose valences come out exact
  // is the structure that was written.
  const masks: number[] = [];
  for (let mask = 0; mask < 1 << (brackets + spots); mask++) masks.push(mask);
  masks.sort((x, y) => bits(x) - bits(y) || x - y);
  for (const mask of masks) {
    const choices: Choices = {
      groups: Array.from({ length: brackets }, (_, k) => !(mask & (1 << k))),
      atoms: Array.from({ length: spots }, (_, k) => Boolean(mask & (1 << (brackets + k)))),
      g: 0,
      a: 0,
    };
    const b: Build = { el: [], h: [], flex: [], bonds: [] };
    const ok = layout(b, items, null, choices);
    if (ok === null || !b.el.length) continue;
    if (b.el.some((e) => typicalValence(e) === undefined)) continue;
    if (!fillValences(b)) continue;
    return { doc: toDocument(b), reading: `${text.trim()} read as a structural formula` };
  }
  return null;
}
