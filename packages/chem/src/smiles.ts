import { DocBuilder } from './builder.ts';
import { allowedValences, isElement } from './elements.ts';
import { MolView } from './graph.ts';
import type { AtomId, BondOrder, MoleculeDocument, StereoNeighbour } from './types.ts';

export class SmilesError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'SmilesError';
    this.position = position;
  }
}

interface PAtom {
  element: string;
  aromatic: boolean;
  bracket: boolean;
  isotope?: number;
  charge: number;
  hcount?: number;
  chiral?: '@' | '@@';
  mapNumber?: number;
  hadFrom: boolean;
  nbrOrder: Array<number | 'H' | { ring: number }>;
}

interface PBond {
  a: number;
  b: number;
  order: 1 | 2 | 3;
  aromatic: boolean;
}

interface DirMark {
  bond: number;
  from: number;
  to: number;
  sign: 1 | -1;
}

const ORGANIC = ['Cl', 'Br', 'B', 'C', 'N', 'O', 'P', 'S', 'F', 'I'];
const AROMATIC_ORGANIC = ['b', 'c', 'n', 'o', 'p', 's'];
const AROMATIC_BRACKET = ['se', 'as', 'te', 'b', 'c', 'n', 'o', 'p', 's'];

export interface ParseSmilesOptions {
  /** Convert pentavalent nitro/N-oxide drawings to charge-separated form (reported in warnings). */
  normalizeNitro?: boolean;
}

export interface ParsedSmiles {
  doc: MoleculeDocument;
  warnings: string[];
}

export function parseSmiles(input: string, options: ParseSmilesOptions = {}): ParsedSmiles {
  const smiles = input.trim().split(/\s+/)[0] ?? '';
  if (!smiles) throw new SmilesError('Empty SMILES', 0);
  const atoms: PAtom[] = [];
  const bonds: PBond[] = [];
  const marks: DirMark[] = [];
  const warnings: string[] = [];
  const ringOpen = new Map<number, { atom: number; sym: string | null; slot: { ring: number } }>();
  const stack: number[] = [];
  let prev = -1;
  let pendingBond: string | null = null;
  let i = 0;

  const bondSymbolOrder = (sym: string | null, a: number, b: number): { order: 1 | 2 | 3; aromatic: boolean } => {
    if (sym === '=') return { order: 2, aromatic: false };
    if (sym === '#') return { order: 3, aromatic: false };
    if (sym === ':') return { order: 1, aromatic: true };
    if (sym === '$') throw new SmilesError('Quadruple bonds are not supported', i);
    if (sym === '-' || sym === '/' || sym === '\\') return { order: 1, aromatic: false };
    // Implicit bond: aromatic between two aromatic atoms, otherwise single.
    return { order: 1, aromatic: atoms[a].aromatic && atoms[b].aromatic };
  };

  const connect = (a: number, b: number, sym: string | null, from: number, to: number): number => {
    const { order, aromatic } = bondSymbolOrder(sym, a, b);
    const bi = bonds.length;
    bonds.push({ a, b, order, aromatic });
    if (sym === '/' || sym === '\\') marks.push({ bond: bi, from, to, sign: sym === '/' ? 1 : -1 });
    return bi;
  };

  const addAtom = (p: Omit<PAtom, 'nbrOrder' | 'hadFrom'>): number => {
    const idx = atoms.length;
    atoms.push({ ...p, hadFrom: prev >= 0, nbrOrder: [] });
    if (prev >= 0) {
      if (bonds.some((b) => (b.a === prev && b.b === idx) || (b.a === idx && b.b === prev))) {
        throw new SmilesError('Duplicate bond', i);
      }
      connect(prev, idx, pendingBond, prev, idx);
      atoms[prev].nbrOrder.push(idx);
      atoms[idx].nbrOrder.push(prev);
    }
    if (p.bracket && p.hcount === 1 && p.chiral) atoms[idx].nbrOrder.push('H');
    pendingBond = null;
    prev = idx;
    return idx;
  };

  while (i < smiles.length) {
    const ch = smiles[i];
    if (ch === '(') {
      if (prev < 0) throw new SmilesError('Branch cannot start a SMILES string', i);
      stack.push(prev);
      i++;
      continue;
    }
    if (ch === ')') {
      if (!stack.length) throw new SmilesError('Unmatched closing parenthesis', i);
      if (pendingBond) throw new SmilesError('Bond symbol before a closing parenthesis', i);
      prev = stack.pop()!;
      i++;
      continue;
    }
    if (ch === '.') {
      if (pendingBond) throw new SmilesError('Bond symbol before a dot', i);
      prev = -1;
      i++;
      continue;
    }
    if ('-=#$:/\\'.includes(ch)) {
      if (pendingBond) throw new SmilesError('Two bond symbols in a row', i);
      pendingBond = ch;
      i++;
      continue;
    }
    if (ch === '%' || (ch >= '0' && ch <= '9')) {
      if (prev < 0) throw new SmilesError('Ring-closure digit without an atom', i);
      let num: number;
      if (ch === '%') {
        const m = /^%(\d\d)/.exec(smiles.slice(i));
        if (!m) throw new SmilesError('Malformed %nn ring closure', i);
        num = parseInt(m[1], 10);
        i += 3;
      } else {
        num = ch.charCodeAt(0) - 48;
        i++;
      }
      const open = ringOpen.get(num);
      if (!open) {
        const slot = { ring: num };
        atoms[prev].nbrOrder.push(slot);
        ringOpen.set(num, { atom: prev, sym: pendingBond, slot });
      } else {
        ringOpen.delete(num);
        if (open.atom === prev) throw new SmilesError('Ring closure to the same atom', i);
        if (bonds.some((b) => (b.a === open.atom && b.b === prev) || (b.a === prev && b.b === open.atom))) {
          throw new SmilesError('Ring closure duplicates an existing bond', i);
        }
        let sym = pendingBond ?? open.sym;
        if (pendingBond && open.sym && pendingBond !== open.sym && !'/\\'.includes(pendingBond) && !'/\\'.includes(open.sym)) {
          throw new SmilesError('Conflicting ring-closure bond symbols', i);
        }
        if (open.sym && '/\\'.includes(open.sym) && !(pendingBond && '/\\'.includes(pendingBond))) {
          // Direction written at the opening atom: from opener to closer.
          const bi = connect(open.atom, prev, open.sym, open.atom, prev);
          void bi;
        } else {
          if (sym && '/\\'.includes(sym)) connect(open.atom, prev, sym, prev, open.atom);
          else connect(open.atom, prev, sym, open.atom, prev);
        }
        const k = atoms[open.atom].nbrOrder.indexOf(open.slot);
        atoms[open.atom].nbrOrder[k] = prev;
        atoms[prev].nbrOrder.push(open.atom);
      }
      pendingBond = null;
      continue;
    }
    if (ch === '[') {
      const end = smiles.indexOf(']', i);
      if (end < 0) throw new SmilesError('Unclosed bracket atom', i);
      const body = smiles.slice(i + 1, end);
      const p = parseBracket(body, i);
      addAtom(p);
      i = end + 1;
      continue;
    }
    if (ch === '*') throw new SmilesError('Wildcard atoms (*) are not supported in the studio', i);
    const two = smiles.slice(i, i + 2);
    const org = ORGANIC.find((s) => smiles.startsWith(s, i));
    if (org && !(org.length === 1 && (two === 'Cl' || two === 'Br'))) {
      addAtom({ element: org, aromatic: false, bracket: false, charge: 0 });
      i += org.length;
      continue;
    }
    if (AROMATIC_ORGANIC.includes(ch)) {
      addAtom({ element: ch.toUpperCase(), aromatic: true, bracket: false, charge: 0 });
      i++;
      continue;
    }
    throw new SmilesError(`Unexpected character "${ch}"`, i);
  }
  if (stack.length) throw new SmilesError('Unclosed branch', smiles.length);
  if (ringOpen.size) throw new SmilesError(`Unclosed ring bond ${[...ringOpen.keys()].join(', ')}`, smiles.length);
  if (pendingBond) throw new SmilesError('SMILES ends with a bond symbol', smiles.length);

  kekulize(atoms, bonds);

  // Build the document.
  const builder = new DocBuilder();
  const ids: AtomId[] = atoms.map((a) =>
    builder.addAtom(a.element, {
      formalCharge: a.charge,
      aromatic: a.aromatic,
      ...(a.isotope ? { isotope: a.isotope } : {}),
      ...(a.bracket ? { explicitHydrogens: a.hcount ?? 0 } : {}),
      ...(a.mapNumber ? { mapNumber: a.mapNumber } : {}),
    }),
  );
  const bondIds = bonds.map((b) => builder.addBond(ids[b.a], ids[b.b], b.order as BondOrder, { aromatic: b.aromatic }));
  const doc = builder.doc;

  // Tetrahedral stereo.
  atoms.forEach((a, ai) => {
    if (!a.chiral) return;
    const order: StereoNeighbour[] = a.nbrOrder.map((n) => (n === 'H' ? 'H' : typeof n === 'number' ? ids[n] : 'H'));
    if (order.length === 3) order.splice(a.hadFrom ? 1 : 0, 0, 'LP');
    if (order.length !== 4) {
      warnings.push(`Chirality mark on atom ${ai + 1} ignored: it does not have four neighbours.`);
      return;
    }
    doc.atoms[ai].stereo = { order, parity: a.chiral === '@' ? 'ccw' : 'cw' };
  });

  // Double-bond stereo from directional marks.
  bonds.forEach((b, bi) => {
    if (b.order !== 2 || b.aromatic) return;
    const side = (atom: number, other: number, towards: boolean): { ref: number; d: number } | null => {
      for (const m of marks) {
        const mb = bonds[m.bond];
        const partner = mb.a === atom ? mb.b : mb.b === atom ? mb.a : -1;
        if (partner < 0 || partner === other) continue;
        // towards: dir(ref -> atom); otherwise dir(atom -> ref)
        const forward = towards ? m.from === partner && m.to === atom : m.from === atom && m.to === partner;
        return { ref: partner, d: forward ? m.sign : -m.sign };
      }
      return null;
    };
    const s1 = side(b.a, b.b, true);
    const s2 = side(b.b, b.a, false);
    if (!s1 || !s2) return;
    doc.bonds[bi].stereo = { refs: [ids[s1.ref], ids[s2.ref]], config: s1.d === s2.d ? 'trans' : 'cis' };
  });
  void bondIds;

  if (options.normalizeNitro !== false) normalizeChargeSeparation(doc, warnings);
  return { doc, warnings };
}

function parseBracket(body: string, pos: number): Omit<PAtom, 'nbrOrder' | 'hadFrom'> {
  let k = 0;
  const m = /^(\d+)/.exec(body);
  let isotope: number | undefined;
  if (m) {
    isotope = parseInt(m[1], 10);
    k += m[1].length;
  }
  let element = '';
  let aromatic = false;
  const rest = body.slice(k);
  const arom = AROMATIC_BRACKET.find((s) => rest.startsWith(s));
  if (arom) {
    element = arom.length === 2 ? arom[0].toUpperCase() + arom[1] : arom.toUpperCase();
    aromatic = true;
    k += arom.length;
  } else {
    const two = rest.slice(0, 2);
    if (two.length === 2 && /[A-Z][a-z]/.test(two) && isElement(two)) {
      element = two;
      k += 2;
    } else if (/[A-Z]/.test(rest[0] ?? '') && isElement(rest[0])) {
      element = rest[0];
      k += 1;
    } else {
      throw new SmilesError(`Unknown element in [${body}]`, pos);
    }
  }
  let chiral: '@' | '@@' | undefined;
  if (body.startsWith('@@', k)) {
    chiral = '@@';
    k += 2;
  } else if (body.startsWith('@', k)) {
    chiral = '@';
    k += 1;
    const th = /^(TH[12]|AL[12]|SP[123]|TB\d+|OH\d+)/.exec(body.slice(k));
    if (th) {
      if (th[1] === 'TH2') chiral = '@@';
      else if (th[1] !== 'TH1') throw new SmilesError('Only tetrahedral chirality is supported', pos);
      k += th[1].length;
    }
  }
  let hcount = 0;
  if (body[k] === 'H') {
    k++;
    const hm = /^(\d+)/.exec(body.slice(k));
    if (hm) {
      hcount = parseInt(hm[1], 10);
      k += hm[1].length;
    } else hcount = 1;
  }
  let charge = 0;
  const cm = /^([+-])(\d+|[+-]*)/.exec(body.slice(k));
  if (cm) {
    const sign = cm[1] === '+' ? 1 : -1;
    if (/^\d+$/.test(cm[2])) charge = sign * parseInt(cm[2], 10);
    else charge = sign * (1 + cm[2].length);
    k += cm[0].length;
  }
  let mapNumber: number | undefined;
  const mm = /^:(\d+)/.exec(body.slice(k));
  if (mm) {
    mapNumber = parseInt(mm[1], 10);
    k += mm[0].length;
  }
  if (k !== body.length) throw new SmilesError(`Could not read bracket atom [${body}]`, pos);
  return { element, aromatic, bracket: true, isotope, charge, hcount, chiral, mapNumber };
}

/** Assign alternating single/double bonds to aromatic systems (perfect matching). */
function kekulize(atoms: PAtom[], bonds: PBond[]): void {
  const aromaticBonds = bonds.map((b, i) => (b.aromatic ? i : -1)).filter((i) => i >= 0);
  if (!aromaticBonds.length) {
    // Aromatic atoms without aromatic bonds (e.g. single "c") still need checking.
    if (atoms.some((a) => a.aromatic)) {
      const lone = atoms.findIndex((a) => a.aromatic);
      if (lone >= 0 && needsDouble(atoms, bonds, lone)) throw new SmilesError('Aromatic atom outside a ring cannot be kekulized', 0);
    }
    return;
  }
  const need = atoms.map((a, i) => (a.aromatic ? needsDouble(atoms, bonds, i) : false));
  const adj = new Map<number, Array<{ nb: number; bond: number }>>();
  for (const bi of aromaticBonds) {
    const b = bonds[bi];
    if (!need[b.a] || !need[b.b]) continue;
    if (!adj.has(b.a)) adj.set(b.a, []);
    if (!adj.has(b.b)) adj.set(b.b, []);
    adj.get(b.a)!.push({ nb: b.b, bond: bi });
    adj.get(b.b)!.push({ nb: b.a, bond: bi });
  }
  const matched = new Map<number, number>(); // atom -> bond
  const targets = atoms.map((_, i) => i).filter((i) => need[i]);
  for (const t of targets) if (!adj.has(t)) throw new SmilesError('Cannot kekulize aromatic system (did you mean [nH]?)', 0);

  const solve = (): boolean => {
    let best = -1;
    let bestOptions: Array<{ nb: number; bond: number }> = [];
    for (const t of targets) {
      if (matched.has(t)) continue;
      const opts = adj.get(t)!.filter((o) => !matched.has(o.nb));
      if (!opts.length) return false;
      if (best < 0 || opts.length < bestOptions.length) {
        best = t;
        bestOptions = opts;
      }
    }
    if (best < 0) return true;
    for (const o of bestOptions) {
      matched.set(best, o.bond);
      matched.set(o.nb, o.bond);
      if (solve()) return true;
      matched.delete(best);
      matched.delete(o.nb);
    }
    return false;
  };
  if (!solve()) throw new SmilesError('Cannot kekulize aromatic system (did you mean [nH]?)', 0);
  const doubles = new Set(matched.values());
  for (const bi of aromaticBonds) bonds[bi].order = doubles.has(bi) ? 2 : 1;
}

function needsDouble(atoms: PAtom[], bonds: PBond[], i: number): boolean {
  const a = atoms[i];
  let arom = 0;
  let other = 0;
  let exoDouble = false;
  for (const b of bonds) {
    if (b.a !== i && b.b !== i) continue;
    if (b.aromatic) arom++;
    else {
      other += b.order;
      if (b.order === 2) exoDouble = true;
    }
  }
  if (exoDouble) return false;
  const h = a.bracket ? a.hcount ?? 0 : 0;
  const used = arom + other + h;
  if (!a.bracket) {
    if (a.element === 'C' || a.element === 'B') return used < (a.element === 'C' ? 4 : 3);
    if (a.element === 'N' || a.element === 'P') return used < 3;
    return false; // o, s
  }
  const vals = allowedValences(a.element, a.charge);
  if (!vals) return false;
  const target = vals.find((v) => v >= used);
  if (target === undefined) return false;
  return target - used >= 1;
}

/**
 * Convert pentavalent nitrogen drawings (nitro, N-oxides written as N=O double bonds) to the
 * charge-separated form that obeys the octet rule. Always reported, never silent.
 */
function normalizeChargeSeparation(doc: MoleculeDocument, warnings: string[]): void {
  const view = new MolView(doc);
  for (let i = 0; i < view.atomCount; i++) {
    const a = doc.atoms[i];
    if (a.element !== 'N' || a.formalCharge !== 0) continue;
    if (view.bondOrderSum(i) + (a.explicitHydrogens ?? 0) !== 5) continue;
    const k = view.nbrs[i].findIndex((j, kk) => view.el(j) === 'O' && doc.bonds[view.nbrBonds[i][kk]].order === 2 && doc.atoms[j].formalCharge === 0);
    if (k < 0) continue;
    const o = view.nbrs[i][k];
    doc.bonds[view.nbrBonds[i][k]].order = 1;
    a.formalCharge = 1;
    doc.atoms[o].formalCharge = -1;
    warnings.push('Pentavalent nitrogen was redrawn in its charge-separated form (N⁺–O⁻), which obeys the octet rule.');
  }
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

export interface WriteSmilesOptions {
  includeStereo?: boolean;
  atomMaps?: boolean;
  /** Restrict output to these atoms (a fragment). */
  atoms?: AtomId[];
  /** Preferred start atom. */
  start?: AtomId;
}

export interface WrittenSmiles {
  smiles: string;
  /** Atom ids in the order they appear in the string. */
  order: AtomId[];
  warnings: string[];
}

const SMILES_DEFAULT_VALENCE: Record<string, number[]> = {
  B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1],
};

export function writeSmiles(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>, options: WriteSmilesOptions = {}): WrittenSmiles {
  const includeStereo = options.includeStereo !== false;
  const view = new MolView(doc);
  const warnings: string[] = [];
  const allowed = options.atoms ? new Set(options.atoms.map((id) => view.idx(id))) : null;
  const inScope = (i: number) => !allowed || allowed.has(i);
  const n = view.atomCount;
  const visited = new Array(n).fill(false);
  const parent = new Array(n).fill(-1);
  const children: number[][] = Array.from({ length: n }, () => []);
  const ringBonds: Array<{ a: number; b: number; bond: number }> = [];
  const treeBond = new Set<number>();
  const roots: number[] = [];
  const visitOrder: number[] = [];

  const startCandidates = [...Array(n).keys()].filter(inScope);
  const pickStart = (comp: number[]) => {
    if (options.start) {
      const s = view.index.get(options.start);
      if (s !== undefined && comp.includes(s)) return s;
    }
    const terminal = comp.find((i) => view.nbrs[i].filter(inScope).length <= 1);
    return terminal ?? comp[0];
  };
  // Components limited to scope.
  const compSeen = new Array(n).fill(false);
  const comps: number[][] = [];
  for (const s of startCandidates) {
    if (compSeen[s]) continue;
    const comp: number[] = [];
    const st = [s];
    compSeen[s] = true;
    while (st.length) {
      const x = st.pop()!;
      comp.push(x);
      for (const y of view.nbrs[x]) if (inScope(y) && !compSeen[y]) { compSeen[y] = true; st.push(y); }
    }
    comps.push(comp.sort((a, b) => a - b));
  }

  const dfs = (root: number) => {
    const stack: Array<{ atom: number; from: number }> = [{ atom: root, from: -1 }];
    while (stack.length) {
      const { atom, from } = stack.pop()!;
      if (visited[atom]) {
        continue;
      }
      visited[atom] = true;
      visitOrder.push(atom);
      if (from >= 0) {
        parent[atom] = from;
        children[from].push(atom);
        treeBond.add(view.bondBetween(atom, from));
      }
      const nbrs = view.nbrs[atom].filter((j) => inScope(j) && j !== from);
      // Push in reverse so the first neighbour is explored first.
      for (let k = nbrs.length - 1; k >= 0; k--) {
        if (!visited[nbrs[k]]) stack.push({ atom: nbrs[k], from: atom });
      }
    }
  };
  for (const comp of comps) {
    const root = pickStart(comp);
    roots.push(root);
    dfs(root);
  }
  // The iterative DFS can attach a child to a later parent; recompute with recursion semantics:
  // any non-tree bond becomes a ring closure.
  for (let bi = 0; bi < view.bonds.length; bi++) {
    const b = view.bonds[bi];
    const a = view.index.get(b.a1)!;
    const c = view.index.get(b.a2)!;
    if (!inScope(a) || !inScope(c)) continue;
    if (!treeBond.has(bi)) ringBonds.push({ a, b: c, bond: bi });
  }

  const pos = new Map<number, number>();
  // Emission order is a pre-order walk of the tree.
  const emitted: number[] = [];
  const preorder = (r: number) => {
    const st = [r];
    while (st.length) {
      const x = st.pop()!;
      pos.set(x, emitted.length);
      emitted.push(x);
      for (let k = children[x].length - 1; k >= 0; k--) st.push(children[x][k]);
    }
  };
  for (const r of roots) preorder(r);

  // Ring closure digits: opened at the earlier atom, closed at the later one.
  const ringAt: Array<Array<{ digit: number; partner: number; bond: number; opening: boolean }>> = Array.from({ length: n }, () => []);
  const sortedRings = ringBonds.map((r) => (pos.get(r.a)! < pos.get(r.b)! ? r : { a: r.b, b: r.a, bond: r.bond }))
    .sort((x, y) => pos.get(x.a)! - pos.get(y.a)! || pos.get(x.b)! - pos.get(y.b)!);
  const inUse = new Set<number>();
  const events: Array<{ at: number; kind: 'open' | 'close'; ring: (typeof sortedRings)[number] }> = [];
  for (const r of sortedRings) {
    events.push({ at: pos.get(r.a)!, kind: 'open', ring: r });
    events.push({ at: pos.get(r.b)!, kind: 'close', ring: r });
  }
  events.sort((x, y) => x.at - y.at || (x.kind === 'close' ? -1 : 1) - (y.kind === 'close' ? -1 : 1));
  const digitOf = new Map<number, number>();
  for (const e of events) {
    if (e.kind === 'close') {
      const d = digitOf.get(e.ring.bond)!;
      ringAt[e.ring.b].push({ digit: d, partner: e.ring.a, bond: e.ring.bond, opening: false });
      inUse.delete(d);
    } else {
      let d = 1;
      while (inUse.has(d)) d++;
      inUse.add(d);
      digitOf.set(e.ring.bond, d);
      ringAt[e.ring.a].push({ digit: d, partner: e.ring.b, bond: e.ring.bond, opening: true });
    }
  }

  // Bond write directions (from -> to) for directional marks.
  const writtenFrom = new Map<number, number>();
  for (let x = 0; x < n; x++) {
    if (parent[x] >= 0) writtenFrom.set(view.bondBetween(x, parent[x]), parent[x]);
  }
  for (const r of sortedRings) writtenFrom.set(r.bond, r.a); // symbol written at opening atom

  const dirSymbol = includeStereo ? assignDirections(view, writtenFrom, inScope, warnings) : new Map<number, '/' | '\\'>();

  const bondSym = (bi: number): string => {
    const d = dirSymbol.get(bi);
    if (d) return d;
    const o = view.bonds[bi].order;
    return o === 2 ? '=' : o === 3 ? '#' : '';
  };

  const atomToken = (x: number): string => {
    const a = view.atoms[x];
    const hImplicit = view.implicitH(x);
    let chiral = '';
    if (includeStereo && a.stereo) {
      const outOrder: StereoNeighbour[] = [];
      if (parent[x] >= 0) outOrder.push(view.atoms[parent[x]].id);
      const stored = a.stereo.order;
      const hasH = stored.includes('H');
      const hasLP = stored.includes('LP');
      if (hasH || hasLP) outOrder.push(hasH ? 'H' : 'LP');
      for (const r of ringAt[x]) outOrder.push(view.atoms[r.partner].id);
      for (const c of children[x]) outOrder.push(view.atoms[c].id);
      const p = permutationParity(stored, outOrder);
      if (p === null) warnings.push(`Stereo at ${a.id} no longer matches its neighbours and was not written.`);
      else {
        const parity = p === 0 ? a.stereo.parity : a.stereo.parity === 'cw' ? 'ccw' : 'cw';
        chiral = parity === 'ccw' ? '@' : '@@';
      }
    }
    const sym = a.element;
    const defaults = SMILES_DEFAULT_VALENCE[sym];
    let organicOk = !!defaults && !a.isotope && a.formalCharge === 0 && !chiral && !(options.atomMaps && a.mapNumber) && !a.radicalElectrons;
    if (organicOk) {
      const used = view.bondOrderSum(x);
      const smilesH = (defaults!.find((v) => v >= used) ?? used) - used;
      if (smilesH !== hImplicit) organicOk = false;
    }
    if (organicOk) return sym;
    let t = '[';
    if (a.isotope) t += a.isotope;
    t += sym + chiral;
    if (hImplicit > 0) t += 'H' + (hImplicit > 1 ? hImplicit : '');
    if (a.formalCharge > 0) t += '+' + (a.formalCharge > 1 ? a.formalCharge : '');
    if (a.formalCharge < 0) t += '-' + (a.formalCharge < -1 ? -a.formalCharge : '');
    if (options.atomMaps && a.mapNumber) t += ':' + a.mapNumber;
    return t + ']';
  };

  const out: string[] = [];
  const write = (x: number): string => {
    let s = atomToken(x);
    for (const r of ringAt[x]) {
      const sym = r.opening ? bondSym(r.bond) : '';
      s += sym + (r.digit > 9 ? '%' + r.digit : String(r.digit));
    }
    const kids = children[x];
    kids.forEach((c, k) => {
      const piece = bondSym(view.bondBetween(x, c)) + write(c);
      s += k < kids.length - 1 ? '(' + piece + ')' : piece;
    });
    return s;
  };
  for (const r of roots) out.push(write(r));
  return { smiles: out.join('.'), order: emitted.map((x) => view.atoms[x].id), warnings };
}

/**
 * 0 if `b` is an even permutation of `a`, 1 if odd, null if they are not permutations.
 */
export function permutationParity<T>(a: readonly T[], b: readonly T[]): 0 | 1 | null {
  if (a.length !== b.length) return null;
  const idx = b.map((x) => a.indexOf(x));
  if (idx.some((k) => k < 0) || new Set(idx).size !== idx.length) return null;
  let swaps = 0;
  const arr = [...idx];
  for (let i = 0; i < arr.length; i++) {
    while (arr[i] !== i) {
      const j = arr[i];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      swaps++;
    }
  }
  return (swaps % 2) as 0 | 1;
}

/** Choose '/' and '\\' for single bonds so every stereo double bond is encoded consistently. */
function assignDirections(view: MolView, writtenFrom: Map<number, number>, inScope: (i: number) => boolean, warnings: string[]): Map<number, '/' | '\\'> {
  interface Constraint { b1: number; b2: number; product: 1 | -1 }
  const constraints: Constraint[] = [];
  const marked = new Set<number>();
  // dir(u -> v) for bond bi expressed as ±v(bi)
  const factor = (bi: number, u: number): 1 | -1 => (writtenFrom.get(bi) === u ? 1 : -1);
  const endMarks = new Map<number, Array<{ bond: number; sub: number; dbl: number }>>();

  view.bonds.forEach((b, bi) => {
    if (b.order !== 2 || !b.stereo) return;
    const A = view.index.get(b.a1)!;
    const B = view.index.get(b.a2)!;
    if (!inScope(A) || !inScope(B)) return;
    const rA = view.index.get(b.stereo.refs[0]);
    const rB = view.index.get(b.stereo.refs[1]);
    if (rA === undefined || rB === undefined) return;
    const bA = view.bondBetween(A, rA);
    const bB = view.bondBetween(B, rB);
    if (bA < 0 || bB < 0 || view.bonds[bA].order !== 1 || view.bonds[bB].order !== 1) {
      warnings.push(`Double-bond stereo on ${b.id} could not be written.`);
      return;
    }
    // dir(rA->A) * dir(B->rB) = trans ? +1 : -1
    // dir(rA->A) = factor(bA, rA) * v(bA); dir(B->rB) = factor(bB, B) * v(bB)
    const target = b.stereo.config === 'trans' ? 1 : -1;
    const product = (target * factor(bA, rA) * factor(bB, B)) as 1 | -1;
    constraints.push({ b1: bA, b2: bB, product });
    marked.add(bA);
    marked.add(bB);
    for (const [end, sub, bond] of [[A, rA, bA], [B, rB, bB]] as const) {
      if (!endMarks.has(end)) endMarks.set(end, []);
      endMarks.get(end)!.push({ bond, sub, dbl: bi });
    }
  });
  // Any other marked bond on a stereo double-bond end must point the opposite way to the ref.
  view.bonds.forEach((b, bi) => {
    if (b.order !== 2 || !b.stereo) return;
    for (const end of [view.index.get(b.a1)!, view.index.get(b.a2)!]) {
      const subs = view.nbrs[end].filter((j) => view.bondBetween(end, j) !== bi);
      const markedSubs = subs.filter((j) => marked.has(view.bondBetween(end, j)));
      for (let x = 1; x < markedSubs.length; x++) {
        const s1 = markedSubs[0];
        const s2 = markedSubs[x];
        const b1 = view.bondBetween(end, s1);
        const b2 = view.bondBetween(end, s2);
        // dir(s1->end) * dir(s2->end) = -1
        constraints.push({ b1, b2, product: (-1 * factor(b1, s1) * factor(b2, s2)) as 1 | -1 });
      }
    }
  });
  const value = new Map<number, 1 | -1>();
  const adj = new Map<number, Array<{ to: number; product: 1 | -1 }>>();
  for (const c of constraints) {
    if (!adj.has(c.b1)) adj.set(c.b1, []);
    if (!adj.has(c.b2)) adj.set(c.b2, []);
    adj.get(c.b1)!.push({ to: c.b2, product: c.product });
    adj.get(c.b2)!.push({ to: c.b1, product: c.product });
  }
  for (const start of adj.keys()) {
    if (value.has(start)) continue;
    value.set(start, 1);
    const q = [start];
    while (q.length) {
      const x = q.shift()!;
      for (const e of adj.get(x)!) {
        const want = (value.get(x)! * e.product) as 1 | -1;
        if (!value.has(e.to)) {
          value.set(e.to, want);
          q.push(e.to);
        } else if (value.get(e.to) !== want) {
          warnings.push('Conflicting double-bond stereo could not be fully encoded in SMILES.');
        }
      }
    }
  }
  const out = new Map<number, '/' | '\\'>();
  for (const [bi, v] of value) out.set(bi, v === 1 ? '/' : '\\');
  return out;
}
