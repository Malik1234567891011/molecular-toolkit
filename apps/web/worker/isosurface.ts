/**
 * Marching tetrahedra on a regular grid (x-major: index = (i·ny + j)·nz + k). Produces an
 * isosurface with smooth normals taken from the field gradient, wound outward (toward lower
 * values). Used for orbital lobes and density surfaces from quantum jobs.
 */

export interface Grid {
  values: Float32Array;
  dims: [number, number, number];
  origin: [number, number, number];
  spacing: number;
}

const CORNERS: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const TETS: number[][] = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];

export function isosurface(grid: Grid, iso: number, sign = 1): { positions: Float32Array; normals: Float32Array } {
  const [nx, ny, nz] = grid.dims;
  const v = grid.values;
  const h = grid.spacing;
  const [ox, oy, oz] = grid.origin;
  const at = (i: number, j: number, k: number) => sign * v[(i * ny + j) * nz + k];
  const grad = (i: number, j: number, k: number): [number, number, number] => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
    const j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
    const k0 = Math.max(0, k - 1), k1 = Math.min(nz - 1, k + 1);
    return [(at(i1, j, k) - at(i0, j, k)) / ((i1 - i0) * h || 1), (at(i, j1, k) - at(i, j0, k)) / ((j1 - j0) * h || 1), (at(i, j, k1) - at(i, j, k0)) / ((k1 - k0) * h || 1)];
  };
  const pos: number[] = [];
  const nor: number[] = [];
  const cp: Array<[number, number, number]> = new Array(8);
  const cv: number[] = new Array(8);
  const cg: Array<[number, number, number]> = new Array(8);
  const vert = (a: number, b: number) => {
    const t = (iso - cv[a]) / (cv[b] - cv[a] || 1e-12);
    const p = cp[a], q = cp[b], g = cg[a], r = cg[b];
    const n: [number, number, number] = [-(g[0] + (r[0] - g[0]) * t), -(g[1] + (r[1] - g[1]) * t), -(g[2] + (r[2] - g[2]) * t)];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return { p: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t] as [number, number, number], n: [n[0] / l, n[1] / l, n[2] / l] as [number, number, number] };
  };
  const tri = (a: ReturnType<typeof vert>, b: ReturnType<typeof vert>, c: ReturnType<typeof vert>) => {
    // Wind so the face normal agrees with the (outward) gradient normal.
    const e1 = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const e2 = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    // Degenerate slivers (a vertex exactly on the surface) carry no area and no orientation.
    if (Math.hypot(fn[0], fn[1], fn[2]) < 1e-9) return;
    const avg = [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]];
    const list = fn[0] * avg[0] + fn[1] * avg[1] + fn[2] * avg[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const x of list) {
      pos.push(x.p[0], x.p[1], x.p[2]);
      nor.push(x.n[0], x.n[1], x.n[2]);
    }
  };
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let k = 0; k < nz - 1; k++) {
        let above = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CORNERS[c];
          const val = at(i + di, j + dj, k + dk);
          cv[c] = val;
          if (val > iso) above++;
        }
        if (above === 0 || above === 8) continue;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CORNERS[c];
          cp[c] = [ox + (i + di) * h, oy + (j + dj) * h, oz + (k + dk) * h];
          cg[c] = grad(i + di, j + dj, k + dk);
        }
        for (const t of TETS) {
          const ins = t.filter((c) => cv[c] > iso);
          const out = t.filter((c) => cv[c] <= iso);
          if (ins.length === 0 || ins.length === 4) continue;
          if (ins.length === 1 || ins.length === 3) {
            const [lone, others] = ins.length === 1 ? [ins[0], out] : [out[0], ins];
            tri(vert(lone, others[0]), vert(lone, others[1]), vert(lone, others[2]));
          } else {
            const a = vert(ins[0], out[0]);
            const b = vert(ins[0], out[1]);
            const c = vert(ins[1], out[1]);
            const d = vert(ins[1], out[0]);
            tri(a, b, c);
            tri(a, c, d);
          }
        }
      }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor) };
}
