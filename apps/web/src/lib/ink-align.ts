/**
 * Snap a recognized structure onto the drawing it came from (spec §12: "predicted atoms/bonds
 * aligned over" the photo). A multimodal reader gets the topology right but places atoms only
 * roughly, so the overlay floats beside the lines it describes. The ink in the image is the
 * ground truth: search the shift and scale of the whole overlay that puts its bonds on the most
 * ink, and apply it only when it clearly beats where the reader put them.
 */
interface Pt { x: number; y: number; deleted?: boolean }
interface Bd { a: number; b: number; deleted?: boolean }

export interface InkTransform { cx: number; cy: number; sx: number; sy: number; dx: number; dy: number }

async function inkMap(url: string, width = 360): Promise<{ w: number; h: number; d: Float32Array } | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const w = width;
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * width));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  // Paper is light, ink is dark: estimate the paper level so photos of grey paper work too.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255;
  const sorted = Float32Array.from(lum).sort();
  const paper = sorted[Math.floor(sorted.length * 0.6)];
  let d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = Math.max(0, paper - lum[i] - 0.08) / Math.max(0.2, paper);
  // Two box blurs widen thin lines into a smooth basin the search can climb.
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    const r = 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            s += d[yy * w + xx];
            n++;
          }
        }
        out[y * w + x] = s / n;
      }
    }
    d = out;
  }
  return { w, h, d };
}

export async function alignToInk(url: string, atoms: Pt[], bonds: Bd[]): Promise<InkTransform | null> {
  const map = await inkMap(url);
  const live = bonds.filter((b) => !b.deleted && atoms[b.a] && atoms[b.b] && !atoms[b.a].deleted && !atoms[b.b].deleted);
  if (!map || live.length < 2) return null;
  const { w, h, d } = map;
  const samples: Array<[number, number]> = [];
  for (const b of live) {
    const p = atoms[b.a];
    const q = atoms[b.b];
    // Skip the ends: labelled atoms (OH, NH2) sit on text, not on lines.
    for (let t = 0.2; t <= 0.8001; t += 0.1) samples.push([p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t]);
  }
  const pts = atoms.filter((a) => !a.deleted);
  const cx = pts.reduce((s, a) => s + a.x, 0) / pts.length;
  const cy = pts.reduce((s, a) => s + a.y, 0) / pts.length;
  const score = (sx: number, sy: number, dx: number, dy: number) => {
    let s = 0;
    for (const [x, y] of samples) {
      const X = Math.round((cx + (x - cx) * sx + dx) * (w - 1));
      const Y = Math.round((cy + (y - cy) * sy + dy) * (h - 1));
      if (X >= 0 && Y >= 0 && X < w && Y < h) s += d[Y * w + X];
    }
    return s / samples.length;
  };
  const base = score(1, 1, 0, 0);
  let best = { sx: 1, sy: 1, dx: 0, dy: 0, v: base };
  for (let s = 0.8; s <= 1.2001; s += 0.04) {
    for (let dx = -0.15; dx <= 0.1501; dx += 0.01) {
      for (let dy = -0.15; dy <= 0.1501; dy += 0.01) {
        const v = score(s, s, dx, dy);
        if (v > best.v) best = { sx: s, sy: s, dx, dy, v };
      }
    }
  }
  // Local refinement, letting width and height scale separately.
  for (let round = 0; round < 3; round++) {
    const step = [0.004, 0.002, 0.001][round];
    const sstep = [0.02, 0.01, 0.005][round];
    const c0 = { ...best };
    for (let sx = c0.sx - 2 * sstep; sx <= c0.sx + 2 * sstep + 1e-9; sx += sstep) {
      for (let sy = c0.sy - 2 * sstep; sy <= c0.sy + 2 * sstep + 1e-9; sy += sstep) {
        for (let dx = c0.dx - 3 * step; dx <= c0.dx + 3 * step + 1e-9; dx += step) {
          for (let dy = c0.dy - 3 * step; dy <= c0.dy + 3 * step + 1e-9; dy += step) {
            const v = score(sx, sy, dx, dy);
            if (v > best.v) best = { sx, sy, dx, dy, v };
          }
        }
      }
    }
  }
  // Move only when the bonds now clearly sit on ink.
  if (best.v < 0.12 || best.v < base * 1.2) return null;
  return { cx, cy, sx: best.sx, sy: best.sy, dx: best.dx, dy: best.dy };
}

export function applyInk<T extends Pt>(atoms: T[], t: InkTransform): T[] {
  return atoms.map((a) => ({ ...a, x: t.cx + (a.x - t.cx) * t.sx + t.dx, y: t.cy + (a.y - t.cy) * t.sy + t.dy }));
}
