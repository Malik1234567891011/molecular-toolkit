/**
 * Choosing a default camera for a molecule. Looking along the axis of least spread makes flat
 * molecules face the viewer, but can line up a bond with the line of sight and hide one atom
 * behind another (the OH of 2-methylbutan-2-ol sitting on C2). Here candidate directions near
 * that axis are scored by how much atoms overlap on screen, and the least-cluttered one wins;
 * the up vector then lays the molecule's long axis horizontally, to suit wide canvases.
 */
type V = [number, number, number];

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function basis(d: V): [V, V] {
  const helper: V = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(helper, d));
  return [u, cross(d, u)];
}

function sphere(n: number): V[] {
  const out: V[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return out;
}

export function bestView(coords: Record<string, V>, heavy: Set<string>, center: V, normal: V): { dir: V; up: V } {
  let keys = Object.keys(coords);
  if (keys.length > 150) keys = keys.filter((k) => heavy.has(k));
  const pts = keys.map((k) => [coords[k][0] - center[0], coords[k][1] - center[1], coords[k][2] - center[2]] as V);
  const isHeavy = keys.map((k) => heavy.has(k));
  const n = norm(normal);
  const cap = Math.cos((55 * Math.PI) / 180);
  const candidates: V[] = [n, ...sphere(260).filter((d) => Math.abs(dot(d, n)) >= cap)];

  let best = n;
  let bestScore = Infinity;
  for (const d of candidates) {
    const [u, v] = basis(d);
    const xy = pts.map((p) => [dot(p, u), dot(p, v)]);
    let penalty = 0;
    for (let i = 0; i < xy.length; i++) {
      for (let j = i + 1; j < xy.length; j++) {
        const both = isHeavy[i] && isHeavy[j];
        const one = isHeavy[i] || isHeavy[j];
        const R = both ? 1.05 : one ? 0.75 : 0.5;
        const r = Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
        if (r < R) penalty += (both ? 1 : one ? 0.35 : 0.1) * ((R - r) / R) ** 2;
      }
    }
    // Prefer staying face-on when the clutter is about the same.
    penalty += 0.35 * (1 - Math.abs(dot(d, n)));
    if (penalty < bestScore - 1e-9) {
      bestScore = penalty;
      best = d;
    }
  }

  // Long axis horizontal: the up vector is perpendicular to the in-plane principal axis.
  const [u, v] = basis(best);
  const hv = pts.filter((_, k) => isHeavy[k]);
  const src = hv.length >= 2 ? hv : pts;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of src) {
    const x = dot(p, u);
    const y = dot(p, v);
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const major: V = norm([
    u[0] * Math.cos(theta) + v[0] * Math.sin(theta),
    u[1] * Math.cos(theta) + v[1] * Math.sin(theta),
    u[2] * Math.cos(theta) + v[2] * Math.sin(theta),
  ]);
  let up = norm(cross(best, major));
  if (up[1] < 0) up = [-up[0], -up[1], -up[2]];
  return { dir: best, up };
}
