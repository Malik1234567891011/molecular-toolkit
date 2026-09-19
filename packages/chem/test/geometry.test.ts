import { describe, expect, it } from 'vitest';
import { parseSmiles } from '../src/smiles.ts';
import { MolView } from '../src/graph.ts';
import { localGeometry, updateConformer, angleDeg, dihedralDeg, sideOfBond, isRotatable, completeDirections, alignTo, rotateFragment } from '../src/geometry3d.ts';

const geo = (smi: string, i: number) => localGeometry(new MolView(parseSmiles(smi).doc), i);

describe('VSEPR', () => {
  it('classifies common centres', () => {
    expect(geo('C', 0)).toMatchObject({ hybridization: 'sp3', molecularGeometry: 'tetrahedral', idealAngle: 109.5 });
    expect(geo('N', 0)).toMatchObject({ hybridization: 'sp3', lonePairs: 1, molecularGeometry: 'trigonal pyramidal' });
    expect(geo('O', 0)).toMatchObject({ hybridization: 'sp3', lonePairs: 2, molecularGeometry: 'bent' });
    expect(geo('C=C', 0)).toMatchObject({ hybridization: 'sp2', molecularGeometry: 'trigonal planar' });
    expect(geo('C#C', 0)).toMatchObject({ hybridization: 'sp', molecularGeometry: 'linear' });
    expect(geo('CC(=O)N', 3)).toMatchObject({ hybridization: 'sp2' });
    expect(geo('O=C=O', 1)).toMatchObject({ hybridization: 'sp' });
    expect(geo('c1ccccc1', 0)).toMatchObject({ hybridization: 'sp2' });
    expect(geo('C[CH+]C', 1)).toMatchObject({ hybridization: 'sp2' });
  });
});

describe('placement', () => {
  it('builds a tetrahedral methane and staggered ethane', () => {
    const d = parseSmiles('CC').doc;
    const c = updateConformer(d, undefined, ['a1', 'a2']).coordinates;
    expect(Object.keys(c).length).toBe(8);
    const a = angleDeg(c['a1.h1'], c['a1'], c['a1.h2']);
    expect(Math.abs(a - 109.47)).toBeLessThan(0.5);
    const dih = Math.abs(dihedralDeg(c['a1.h1'], c['a1'], c['a2'], c['a2.h1']));
    expect([60, 180].some((t) => Math.abs(dih - t) < 1)).toBe(true);
    expect(Math.abs(Math.hypot(...c['a1'].map((x, k) => x - c['a2'][k])) - 1.53)).toBeLessThan(0.01);
  });
  it('builds planar ethene', () => {
    const c = updateConformer(parseSmiles('C=C').doc, undefined, ['a1', 'a2']).coordinates;
    const dih = Math.abs(dihedralDeg(c['a1.h1'], c['a1'], c['a2'], c['a2.h1']));
    expect(Math.min(dih, 180 - dih)).toBeLessThan(1);
    expect(Math.abs(angleDeg(c['a1.h1'], c['a1'], c['a2']) - 120)).toBeLessThan(0.5);
  });
  it('completes directions', () => {
    expect(completeDirections([[1, 0, 0]], 2)[0]).toEqual([-1, -0, -0]);
    const three = completeDirections([[1, 0, 0], [-0.5, 0.866, 0]], 3)[0];
    expect(Math.abs(three[1] + 0.866)).toBeLessThan(0.01);
  });
});

describe('bond rotation', () => {
  it('finds rotatable bonds and fragments', () => {
    const d = parseSmiles('CCCC').doc;
    expect(isRotatable(d, 'b2')).toBe(true);
    expect(isRotatable(parseSmiles('C1CCCCC1').doc, 'b1')).toBe(false);
    expect(sideOfBond(d, 'a2', 'a3')?.sort()).toEqual(['a3', 'a4']);
    const c = updateConformer(d, undefined, d.atoms.map((a) => a.id)).coordinates;
    const before = dihedralDeg(c.a1, c.a2, c.a3, c.a4);
    const rot = rotateFragment(c, ['a3', 'a4'], c.a2, c.a3, 60);
    const after = dihedralDeg(rot.a1, rot.a2, rot.a3, rot.a4);
    const diff = ((after - before + 540) % 360) - 180;
    expect(Math.abs(Math.abs(diff) - 60)).toBeLessThan(0.5);
  });
  it('aligns conformers', () => {
    const d = parseSmiles('CCO').doc;
    const c = updateConformer(d, undefined, ['a1', 'a2', 'a3']).coordinates;
    const moved: Record<string, [number, number, number]> = {};
    for (const [k, p] of Object.entries(c)) moved[k] = [p[1] + 5, -p[0], p[2] - 2];
    const back = alignTo(moved, c);
    for (const k of ['a1', 'a2', 'a3']) expect(Math.hypot(...back[k].map((x, i) => x - c[k][i]))).toBeLessThan(1e-3);
  });
});
