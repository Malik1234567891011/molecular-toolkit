import type { MolView } from './graph.ts';

export interface Ring {
  /** Atom indices in cyclic order. */
  atoms: number[];
  /** Bond indices in cyclic order (bonds[k] joins atoms[k] and atoms[k+1]). */
  bonds: number[];
}

export interface RingSystem {
  rings: Ring[];
  atoms: number[];
  bonds: number[];
  kind: 'monocycle' | 'fused' | 'bridged' | 'spiro' | 'polycyclic';
}

export interface RingInfo {
  rings: Ring[];
  systems: RingSystem[];
  atomRings: number[][];
  bondRings: number[][];
  inRing(i: number): boolean;
  bondInRing(b: number): boolean;
  /** Smallest ring size containing atom i (0 if acyclic). */
  smallestRing(i: number): number;
}

/**
 * Smallest set of smallest rings via Horton candidates + GF(2) elimination.
 * Molecules in scope are small, so the simple approach is exact and fast.
 */
export function perceiveRings(view: MolView): RingInfo {
  const n = view.atomCount;
  const m = view.bonds.length;
  // Ring bonds = bonds not bridges. Work only on the cyclic core.
  const cyclic = findCyclicBonds(view);
  const components = view.components();
  let nullity = 0;
  for (const comp of components) {
    const set = new Set(comp);
    let e = 0;
    for (let bi = 0; bi < m; bi++) {
      const b = view.bonds[bi];
      if (set.has(view.index.get(b.a1)!)) e++;
    }
    nullity += e - comp.length + 1;
  }
  const rings: Ring[] = [];
  if (nullity > 0) {
    const candidates = hortonCandidates(view, cyclic);
    candidates.sort((a, b) => a.bonds.length - b.bonds.length);
    const basis: bigint[] = [];
    const pivots: number[] = [];
    for (const c of candidates) {
      let vec = 0n;
      for (const bi of c.bonds) vec ^= 1n << BigInt(bi);
      // Reduce against basis.
      for (let k = 0; k < basis.length; k++) {
        if ((vec >> BigInt(pivots[k])) & 1n) vec ^= basis[k];
      }
      if (vec === 0n) continue;
      let p = 0;
      while (!((vec >> BigInt(p)) & 1n)) p++;
      // Keep basis in reduced form.
      for (let k = 0; k < basis.length; k++) if ((basis[k] >> BigInt(p)) & 1n) basis[k] ^= vec;
      basis.push(vec);
      pivots.push(p);
      rings.push(c);
      if (rings.length === nullity) break;
    }
  }
  const atomRings: number[][] = Array.from({ length: n }, () => []);
  const bondRings: number[][] = Array.from({ length: m }, () => []);
  rings.forEach((r, ri) => {
    r.atoms.forEach((a) => atomRings[a].push(ri));
    r.bonds.forEach((b) => bondRings[b].push(ri));
  });
  const systems = ringSystems(rings);
  return {
    rings,
    systems,
    atomRings,
    bondRings,
    inRing: (i) => atomRings[i].length > 0,
    bondInRing: (b) => cyclic.has(b),
    smallestRing: (i) => (atomRings[i].length ? Math.min(...atomRings[i].map((r) => rings[r].atoms.length)) : 0),
  };
}

function findCyclicBonds(view: MolView): Set<number> {
  // Tarjan bridge finding; non-bridge bonds are ring bonds.
  const n = view.atomCount;
  const disc = new Array(n).fill(-1);
  const low = new Array(n).fill(0);
  const bridges = new Set<number>();
  let t = 0;
  for (let s = 0; s < n; s++) {
    if (disc[s] >= 0) continue;
    const stack: Array<{ v: number; parentBond: number; k: number }> = [{ v: s, parentBond: -1, k: 0 }];
    disc[s] = low[s] = t++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.k < view.nbrs[top.v].length) {
        const w = view.nbrs[top.v][top.k];
        const bi = view.nbrBonds[top.v][top.k];
        top.k++;
        if (bi === top.parentBond) continue;
        if (disc[w] < 0) {
          disc[w] = low[w] = t++;
          stack.push({ v: w, parentBond: bi, k: 0 });
        } else {
          low[top.v] = Math.min(low[top.v], disc[w]);
        }
      } else {
        stack.pop();
        if (stack.length) {
          const p = stack[stack.length - 1];
          low[p.v] = Math.min(low[p.v], low[top.v]);
          if (low[top.v] > disc[p.v]) bridges.add(top.parentBond);
        }
      }
    }
  }
  const cyclic = new Set<number>();
  for (let bi = 0; bi < view.bonds.length; bi++) if (!bridges.has(bi)) cyclic.add(bi);
  return cyclic;
}

function hortonCandidates(view: MolView, cyclic: Set<number>): Ring[] {
  const n = view.atomCount;
  const out: Ring[] = [];
  const seen = new Set<string>();
  const cyclicAtoms = new Set<number>();
  for (const bi of cyclic) {
    cyclicAtoms.add(view.index.get(view.bonds[bi].a1)!);
    cyclicAtoms.add(view.index.get(view.bonds[bi].a2)!);
  }
  const nb = (v: number) => view.nbrs[v].map((w, k) => ({ w, b: view.nbrBonds[v][k] })).filter((e) => cyclic.has(e.b));
  for (const root of cyclicAtoms) {
    // BFS shortest-path tree from root over cyclic bonds.
    const dist = new Array(n).fill(-1);
    const pred = new Array(n).fill(-1);
    const predBond = new Array(n).fill(-1);
    dist[root] = 0;
    const q = [root];
    while (q.length) {
      const v = q.shift()!;
      for (const { w, b } of nb(v)) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          pred[w] = v;
          predBond[w] = b;
          q.push(w);
        }
      }
    }
    const pathTo = (v: number): { atoms: number[]; bonds: number[] } => {
      const atoms = [v];
      const bonds: number[] = [];
      while (v !== root) {
        bonds.push(predBond[v]);
        v = pred[v];
        atoms.push(v);
      }
      return { atoms: atoms.reverse(), bonds: bonds.reverse() };
    };
    for (const bi of cyclic) {
      const x = view.index.get(view.bonds[bi].a1)!;
      const y = view.index.get(view.bonds[bi].a2)!;
      if (dist[x] < 0 || dist[y] < 0) continue;
      const px = pathTo(x);
      const py = pathTo(y);
      // Paths must share only the root.
      const sx = new Set(px.atoms);
      if (py.atoms.some((a) => a !== root && sx.has(a))) continue;
      if (px.bonds.includes(bi) || py.bonds.includes(bi)) continue;
      const atoms = [...px.atoms, ...py.atoms.slice(1).reverse()];
      const bonds = [...px.bonds, bi, ...py.bonds.slice().reverse()];
      if (atoms.length < 3) continue;
      const key = [...bonds].sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ atoms, bonds });
    }
  }
  // Normalise bond order so bonds[k] joins atoms[k] and atoms[k+1].
  return out.map((r) => orderRing(view, r.atoms));
}

export function orderRing(view: MolView, atoms: number[]): Ring {
  const bonds: number[] = [];
  for (let k = 0; k < atoms.length; k++) {
    bonds.push(view.bondBetween(atoms[k], atoms[(k + 1) % atoms.length]));
  }
  return { atoms, bonds };
}

function ringSystems(rings: Ring[]): RingSystem[] {
  const parent = rings.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (rings[i].atoms.some((a) => rings[j].atoms.includes(a))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  rings.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });
  const out: RingSystem[] = [];
  for (const idxs of groups.values()) {
    const rs = idxs.map((i) => rings[i]);
    const atoms = [...new Set(rs.flatMap((r) => r.atoms))].sort((a, b) => a - b);
    const bonds = [...new Set(rs.flatMap((r) => r.bonds))].sort((a, b) => a - b);
    let kind: RingSystem['kind'] = 'monocycle';
    if (rs.length === 2) {
      const shared = rs[0].atoms.filter((a) => rs[1].atoms.includes(a)).length;
      kind = shared === 1 ? 'spiro' : shared === 2 ? 'fused' : 'bridged';
    } else if (rs.length > 2) kind = 'polycyclic';
    out.push({ rings: rs, atoms, bonds, kind });
  }
  return out;
}
