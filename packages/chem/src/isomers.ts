/**
 * Constitutional isomers of a molecular formula, worked out from the bonding rules rather than
 * looked up in a database: every connected arrangement of the heavy atoms whose leftover
 * valences take exactly the formula's hydrogens.
 *
 * Skeletons are grown one atom at a time (all spanning trees of the atom multiset), then the
 * spare bond units are added one at a time (making double/triple bonds and rings). Duplicates
 * are removed at every step — by a Weisfeiler–Leman colour refinement, confirmed by an exact
 * isomorphism check — so the work stays proportional to the number of distinct answers.
 *
 * Neutral atoms in their usual valence (C 4, N 3, O 2, S 2, halogen 1): no charge-separated
 * forms (nitro groups, ylides) and no hypervalent sulfur or phosphorus. Stereoisomers are not
 * listed separately — cis/trans and R/S share one constitution.
 */
import { typicalValence } from './elements.ts';
import { emptyDocument } from './types.ts';
import type { BondOrder, MoleculeDocument } from './types.ts';

export interface IsomerOptions {
  /** Stop collecting after this many (the count keeps going). Default 300. */
  limit?: number;
  /** Refuse formulas with more heavy atoms than this. Default 12. */
  maxHeavyAtoms?: number;
  /** Give up rather than grind. Default 6000 ms. */
  budgetMs?: number;
}

export interface IsomerEnumeration {
  isomers: MoleculeDocument[];
  /** Distinct isomers found (equals isomers.length unless the search was cut short). */
  total: number;
  truncated: boolean;
  /** Plain-English reason when nothing, or not everything, could be produced. */
  note?: string;
}

interface Graph {
  /** Atoms present so far — the matrix is exactly this size while a skeleton is growing. */
  n: number;
  el: string[];
  /** n×n bond orders (0 = no bond). */
  adj: Uint8Array;
  /** Valence still free on each atom. */
  free: Int8Array;
}

const MAX_FRONTIER = 20000;

function bond(g: Graph, i: number, j: number): number {
  return g.adj[i * g.n + j];
}

function setBond(g: Graph, i: number, j: number, order: number): void {
  g.adj[i * g.n + j] = order;
  g.adj[j * g.n + i] = order;
}

function clone(g: Graph): Graph {
  return { n: g.n, el: g.el.slice(), adj: g.adj.slice(), free: g.free.slice() };
}

/** Copy with one more atom, bonded to `to` by a single bond. */
function grow(g: Graph, element: string, valence: number, to: number): Graph {
  const n = g.n + 1;
  const adj = new Uint8Array(n * n);
  for (let i = 0; i < g.n; i++) for (let j = 0; j < g.n; j++) adj[i * n + j] = g.adj[i * g.n + j];
  const free = new Int8Array(n);
  free.set(g.free);
  free[g.n] = valence - 1;
  free[to] -= 1;
  adj[to * n + g.n] = 1;
  adj[g.n * n + to] = 1;
  return { n, el: [...g.el, element], adj, free };
}

/** FNV-1a, so refinement labels stay short strings. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Weisfeiler–Leman colours: equal graphs always agree, different ones almost always differ. */
function colours(g: Graph): string[] {
  let labels = g.el.slice();
  for (let round = 0; round < Math.min(g.n, 6); round++) {
    const next: string[] = new Array(g.n);
    for (let i = 0; i < g.n; i++) {
      const nb: string[] = [];
      for (let j = 0; j < g.n; j++) {
        const b = bond(g, i, j);
        if (i !== j && b) nb.push(b + labels[j]);
      }
      nb.sort();
      next[i] = hash(labels[i] + '|' + nb.join(','));
    }
    labels = next;
  }
  return labels;
}

function key(g: Graph): string {
  return colours(g).sort().join('/');
}

/** Exact isomorphism: backtracking over atoms, matched by refinement colour and element. */
function isomorphic(a: Graph, b: Graph): boolean {
  if (a.n !== b.n) return false;
  const ca = colours(a);
  const cb = colours(b);
  const mapping = new Int32Array(a.n).fill(-1);
  const used = new Uint8Array(b.n);
  // Hardest atoms (rarest colour) first, so wrong branches die early.
  const freq = new Map<string, number>();
  for (const c of cb) freq.set(c, (freq.get(c) ?? 0) + 1);
  const order = [...a.el.keys()].sort((x, y) => (freq.get(ca[x]) ?? 0) - (freq.get(ca[y]) ?? 0));
  const place = (k: number): boolean => {
    if (k === a.n) return true;
    const i = order[k];
    for (let j = 0; j < b.n; j++) {
      if (used[j] || cb[j] !== ca[i] || b.el[j] !== a.el[i]) continue;
      let ok = true;
      for (let p = 0; p < k && ok; p++) {
        const i2 = order[p];
        ok = bond(a, i, i2) === bond(b, j, mapping[i2]);
      }
      if (!ok) continue;
      mapping[i] = j;
      used[j] = 1;
      if (place(k + 1)) return true;
      used[j] = 0;
      mapping[i] = -1;
    }
    return false;
  };
  return place(0);
}

/** Add a graph to a keyed pool unless an isomorphic one is already there. */
function offer(pool: Map<string, Graph[]>, g: Graph): boolean {
  const k = key(g);
  const bucket = pool.get(k);
  if (!bucket) {
    pool.set(k, [g]);
    return true;
  }
  for (const other of bucket) if (isomorphic(g, other)) return false;
  bucket.push(g);
  return true;
}

const flatten = (pool: Map<string, Graph[]>): Graph[] => [...pool.values()].flat();

function ringCount(g: Graph): number {
  let edges = 0;
  for (let i = 0; i < g.n; i++) for (let j = i + 1; j < g.n; j++) if (bond(g, i, j)) edges++;
  return edges - g.n + 1;
}

function toDocument(g: Graph): MoleculeDocument {
  const doc = emptyDocument();
  const ids = g.el.map((element, i) => {
    const id = `a${i + 1}`;
    doc.atoms.push({ id, element, formalCharge: 0, aromatic: false });
    return id;
  });
  doc.nextAtom = g.n + 1;
  let b = 1;
  for (let i = 0; i < g.n; i++) {
    for (let j = i + 1; j < g.n; j++) {
      const order = bond(g, i, j);
      if (order) doc.bonds.push({ id: `b${b++}`, a1: ids[i], a2: ids[j], order: order as BondOrder, aromatic: false });
    }
  }
  doc.nextBond = b;
  return doc;
}

/**
 * All constitutional isomers of a neutral formula, e.g. `{ C: 5, H: 10 }`.
 * The heavy-atom counts drive the search; hydrogens are whatever the spare valences hold.
 */
export function enumerateIsomers(counts: Record<string, number>, options: IsomerOptions = {}): IsomerEnumeration {
  const limit = options.limit ?? 300;
  const maxHeavy = options.maxHeavyAtoms ?? 12;
  const deadline = Date.now() + (options.budgetMs ?? 6000);
  const none = (note: string): IsomerEnumeration => ({ isomers: [], total: 0, truncated: false, note });

  const el: string[] = [];
  const valence: number[] = [];
  let hydrogens = 0;
  for (const [symbol, n] of Object.entries(counts)) {
    if (n <= 0) continue;
    if (symbol === 'H') {
      hydrogens = n;
      continue;
    }
    const v = typicalValence(symbol);
    if (!v) return none(`Orbital only works out isomers for main-group elements in their usual valence; ${symbol} isn't one of them.`);
    for (let i = 0; i < n; i++) {
      el.push(symbol);
      valence.push(v);
    }
  }
  if (!el.length) return none('That formula has no heavy atoms to arrange.');
  if (el.length > maxHeavy) return none(`Orbital works out isomers for up to ${maxHeavy} non-hydrogen atoms; this formula has ${el.length}.`);

  const n = el.length;
  const valenceSum = valence.reduce((a, b) => a + b, 0);
  if (hydrogens > valenceSum || (valenceSum - hydrogens) % 2 !== 0) {
    return none('No neutral structure has that formula — the hydrogens don’t balance the available bonds.');
  }
  const units = (valenceSum - hydrogens) / 2; // bond units between heavy atoms
  if (units < n - 1) return none('No connected structure has that formula: there aren’t enough bonds to join every atom.');

  if (n === 1) {
    const g: Graph = { n: 1, el, adj: new Uint8Array(1), free: Int8Array.from([valence[0] - hydrogens]) };
    return { isomers: [toDocument(g)], total: 1, truncated: false };
  }

  // When there are more arrangements than we can finish, we keep the ones already found and
  // say so, rather than returning nothing.
  let truncated = false;
  const cap = (pool: Map<string, Graph[]>, max: number) => {
    const all = flatten(pool);
    if (all.length <= max) return pool;
    truncated = true;
    const kept = new Map<string, Graph[]>();
    for (const g of all.slice(0, max)) {
      const k = key(g);
      kept.set(k, [...(kept.get(k) ?? []), g]);
    }
    return kept;
  };

  // Phase 1: every tree on the atom multiset, grown one atom at a time from a single seed.
  let pool = new Map<string, Graph[]>();
  const seed: Graph = { n: 1, el: [el[0]], adj: new Uint8Array(1), free: Int8Array.from([valence[0]]) };
  offer(pool, seed);
  const remainingAfter = (used: string[]) => {
    const left = el.slice();
    for (const e of used) left.splice(left.indexOf(e), 1);
    return left;
  };
  for (let size = 1; size < n; size++) {
    const next = new Map<string, Graph[]>();
    for (const g of flatten(pool)) {
      if (Date.now() > deadline || flatten(next).length > MAX_FRONTIER) {
        truncated = true;
        break;
      }
      const left = remainingAfter(g.el);
      for (const element of new Set(left)) {
        const v = typicalValence(element)!;
        for (let i = 0; i < g.n; i++) {
          if (g.free[i] < 1) continue;
          offer(next, grow(g, element, v, i));
        }
      }
    }
    pool = cap(next, MAX_FRONTIER);
    if (!pool.size) return none('No connected structure has that formula.');
  }

  // Phase 2: spend the spare bond units, one at a time — a higher bond order or a ring.
  for (let extra = 0; extra < units - (n - 1); extra++) {
    const next = new Map<string, Graph[]>();
    for (const g of flatten(pool)) {
      if (Date.now() > deadline || flatten(next).length > MAX_FRONTIER) {
        truncated = true;
        break;
      }
      for (let i = 0; i < g.n; i++) {
        if (g.free[i] < 1) continue;
        for (let j = i + 1; j < g.n; j++) {
          if (g.free[j] < 1 || bond(g, i, j) >= 3) continue;
          const child = clone(g);
          setBond(child, i, j, bond(g, i, j) + 1);
          child.free[i] -= 1;
          child.free[j] -= 1;
          offer(next, child);
        }
      }
    }
    // Keep the search inside its budget: finish fewer skeletons rather than none.
    pool = cap(next, Date.now() > deadline ? Math.min(400, MAX_FRONTIER) : MAX_FRONTIER);
    if (!pool.size) return none('No neutral structure has that formula.');
  }

  const all = flatten(pool);
  // Simplest first: chains before rings, unbranched before branched, single bonds before multiple.
  const rank = (g: Graph) => {
    let branches = 0;
    let highest = 1;
    for (let i = 0; i < g.n; i++) {
      let degree = 0;
      for (let j = 0; j < g.n; j++) {
        const b = bond(g, i, j);
        if (i !== j && b) {
          degree++;
          highest = Math.max(highest, b);
        }
      }
      if (degree > 2) branches++;
    }
    return [ringCount(g), branches, highest] as const;
  };
  all.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return key(a) < key(b) ? -1 : 1;
  });
  return {
    isomers: all.slice(0, limit).map(toDocument),
    total: all.length,
    truncated: truncated || all.length > limit,
    note: truncated ? 'This formula has more arrangements than Orbital can work through here; these are some of them.' : undefined,
  };
}
