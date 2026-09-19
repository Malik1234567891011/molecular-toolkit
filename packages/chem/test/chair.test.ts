import { describe, expect, it } from 'vitest';
import { parseSmiles } from '../src/smiles.ts';
import { placeHydrogens, v3 } from '../src/geometry3d.ts';
import { analyzeChair, chairFlipFrames, chairRings } from '../src/chair.ts';
import type { Vec3 } from '../src/types.ts';

function idealMethylcyclohexane(methylAxial: boolean) {
  const doc = parseSmiles('CC1CCCCC1').doc; // a1 methyl, a2..a7 ring
  const coords: Record<string, Vec3> = {};
  const ring = ['a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  ring.forEach((id, k) => {
    const phi = (k * Math.PI) / 3;
    coords[id] = [1.446 * Math.cos(phi), 1.446 * Math.sin(phi), k % 2 === 0 ? 0.25 : -0.25];
  });
  // a2 is an "up" atom: its axial bond points +z, its equatorial bond outward and slightly down.
  coords.a1 = methylAxial ? [1.446, 0, 0.25 + 1.53] : [1.446 + 1.44, 0, 0.25 - 0.51];
  return { doc, coords: placeHydrogens(doc, coords), ring };
}

describe('chair analysis and ring flip', () => {
  it('finds the ring and classifies the methyl', () => {
    const { doc, coords } = idealMethylcyclohexane(false);
    const rings = chairRings(doc);
    expect(rings).toHaveLength(1);
    const a = analyzeChair(doc, coords, rings[0])!;
    expect(a.isChair).toBe(true);
    const me = Object.values(a.substituents).flat().find((s) => s.key === 'a1')!;
    expect(me.position).toBe('equatorial');
  });

  it('flips equatorial to axial, keeps faces and bond lengths', () => {
    const { doc, coords } = idealMethylcyclohexane(false);
    const ring = chairRings(doc)[0];
    const before = analyzeChair(doc, coords, ring)!;
    const flip = chairFlipFrames(doc, coords, ring)!;
    expect(flip.frames.length).toBeGreaterThan(10);
    const last = flip.frames[flip.frames.length - 1];
    const after = analyzeChair(doc, last, ring)!;
    expect(after.isChair).toBe(true);
    for (const id of ring) {
      const b = before.substituents[id];
      const a = after.substituents[id];
      expect(a.length).toBe(b.length);
      for (const s of b) {
        const t = a.find((x) => x.key === s.key)!;
        expect(t.position).not.toBe(s.position);
        // Faces are measured against a plane normal whose sign may differ; compare consistently.
        const same = Math.sign(v3.dot(before.normal, after.normal));
        expect(t.face === s.face).toBe(same > 0);
        expect(v3.dist(last[s.key], last[id])).toBeCloseTo(v3.dist(coords[s.key], coords[id]), 5);
      }
    }
    const me = Object.values(after.substituents).flat().find((s) => s.key === 'a1')!;
    expect(me.position).toBe('axial');
    for (let k = 0; k < 6; k++) {
      const d = v3.dist(last[ring[k]], last[ring[(k + 1) % 6]]);
      expect(d).toBeGreaterThan(1.4);
      expect(d).toBeLessThan(1.7);
    }
  });

  it('ignores aromatic and fused rings', () => {
    expect(chairRings(parseSmiles('c1ccccc1').doc)).toHaveLength(0);
    expect(chairRings(parseSmiles('C1CCC2CCCCC2C1').doc)).toHaveLength(0);
  });
});
