import { describe, expect, it } from 'vitest';
import { contributorDocument, parseSmiles, resonanceContributors, writeSmiles } from '../src/index.ts';

const run = (smiles: string) => {
  const doc = parseSmiles(smiles).doc;
  const r = resonanceContributors(doc);
  return { doc, r, smiles: r.contributors.map((c) => writeSmiles(contributorDocument(doc, c)).smiles) };
};

describe('resonance contributors', () => {
  it('finds the equivalent pairs textbooks show', () => {
    for (const s of ['c1ccccc1', 'CC(=O)[O-]', 'C[N+](=O)[O-]', 'C=C[CH2+]', 'C=C[CH2-]']) {
      const { r } = run(s);
      expect(r.contributors.length, s).toBe(2);
      expect(r.equivalent, s).toBe(true);
    }
  });
  it('labels the charge-separated amide form minor', () => {
    const { r, smiles } = run('CC(N)=O');
    expect(smiles).toHaveLength(2);
    expect(r.contributors[0].weight).toBe('major');
    expect(r.contributors[1].weight).toBe('minor');
    expect(smiles[1]).toContain('[O-]');
  });
  it('prefers the oxygen-anion enolate', () => {
    const { r, smiles } = run('CC(=O)[CH2-]');
    const major = r.contributors.findIndex((c) => c.weight === 'major');
    expect(smiles[major]).toContain('[O-]');
  });
  it('delocalizes phenoxide onto ortho and para carbons', () => {
    const { r } = run('[O-]c1ccccc1');
    const carbanions = r.contributors.filter((c) => c.charges.some((q, i) => q < 0 && i !== 0));
    expect(carbanions.length).toBe(3);
  });
  it('gives each new contributor arrows from its parent', () => {
    const { r } = run('CC(N)=O');
    expect(r.contributors[1].parent).toBe(0);
    expect(r.contributors[1].arrows.map((a) => Object.keys(a.from)[0])).toEqual(['lp', 'bond']);
  });
  it('leaves localized molecules alone and never pairs C+ with C−', () => {
    expect(run('CCO').r.contributors).toHaveLength(1);
    expect(run('CC(=O)C').r.contributors).toHaveLength(1);
    const { doc, r } = run('OC(=O)C=C');
    const isC = (i: number) => doc.atoms[i].element === 'C';
    for (const c of r.contributors) {
      const cPlus = c.charges.some((q, i) => q > 0 && isC(i));
      const cMinus = c.charges.some((q, i) => q < 0 && isC(i));
      expect(cPlus && cMinus).toBe(false);
    }
  });
  it('keeps hydrogen counts fixed across contributors', () => {
    const { doc, r } = run('C=C[CH2+]');
    const h = (d: typeof doc) => writeSmiles(d).smiles.replace(/[^H]/g, '').length;
    expect(new Set(r.contributors.map((c) => h(contributorDocument(doc, c)))).size).toBe(1);
  });
});
