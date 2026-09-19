import { describe, expect, it } from 'vitest';
import { parseSmiles, writeSmiles, permutationParity } from '../src/smiles.ts';
import { MolView } from '../src/graph.ts';
import { perceiveRings } from '../src/rings.ts';
import { perceiveAromaticity } from '../src/aromaticity.ts';

const hcounts = (smi: string) => {
  const { doc } = parseSmiles(smi);
  const v = new MolView(doc);
  return doc.atoms.map((_, i) => v.implicitH(i));
};

describe('SMILES parser', () => {
  it('reads simple chains with implicit hydrogens', () => {
    expect(hcounts('CCO')).toEqual([3, 2, 1]);
    expect(hcounts('C=C')).toEqual([2, 2]);
    expect(hcounts('C#N')).toEqual([1, 0]);
    expect(hcounts('CC(=O)O')).toEqual([3, 0, 0, 1]);
  });
  it('kekulizes benzene, pyridine, pyrrole', () => {
    const benz = parseSmiles('c1ccccc1').doc;
    expect(benz.bonds.filter((b) => b.order === 2).length).toBe(3);
    expect(hcounts('c1ccccc1')).toEqual([1, 1, 1, 1, 1, 1]);
    expect(hcounts('c1ccncc1')).toEqual([1, 1, 1, 0, 1, 1]);
    expect(hcounts('c1cc[nH]c1')).toEqual([1, 1, 1, 1, 1]);
    expect(() => parseSmiles('c1ccnc1')).toThrow();
    expect(hcounts('Cn1cnc2c1c(=O)n(C)c(=O)n2C').length).toBe(14);
  });
  it('reads charges, isotopes and bracket hydrogens', () => {
    const { doc } = parseSmiles('[NH4+].[O-]C(=O)C.[2H]C');
    expect(doc.atoms[0].formalCharge).toBe(1);
    expect(doc.atoms[0].explicitHydrogens).toBe(4);
    expect(doc.atoms[1].formalCharge).toBe(-1);
    expect(doc.atoms[5].isotope).toBe(2);
  });
  it('normalizes pentavalent nitro with a warning', () => {
    const r = parseSmiles('CN(=O)=O');
    expect(r.warnings.length).toBe(1);
    expect(r.doc.atoms[1].formalCharge).toBe(1);
  });
  it('reads tetrahedral stereo', () => {
    const { doc } = parseSmiles('N[C@@H](C)C(=O)O');
    expect(doc.atoms[1].stereo).toEqual({ order: ['a1', 'H', 'a3', 'a4'], parity: 'cw' });
    const d2 = parseSmiles('[C@H](F)(Cl)Br').doc;
    expect(d2.atoms[0].stereo?.order).toEqual(['H', 'a2', 'a3', 'a4']);
    const d3 = parseSmiles('C[C@H]1CCCC[C@@H]1C').doc;
    expect(d3.atoms[1].stereo?.order).toEqual(['a1', 'H', 'a7', 'a3']);
  });
  it('reads double bond stereo', () => {
    expect(parseSmiles('F/C=C/F').doc.bonds[1].stereo?.config).toBe('trans');
    expect(parseSmiles('F/C=C\\F').doc.bonds[1].stereo?.config).toBe('cis');
    expect(parseSmiles('C(\\F)=C/F').doc.bonds[1].stereo?.config).toBe('trans');
    expect(parseSmiles('F\\C=C/F').doc.bonds[1].stereo?.config).toBe('cis');
  });
  it('rejects malformed strings', () => {
    for (const bad of ['C(C', 'C)C', 'C1CC', 'C==C', '[Xx]', 'C%1']) expect(() => parseSmiles(bad)).toThrow();
  });
});

describe('SMILES writer', () => {
  const roundTrip = (smi: string) => {
    const a = parseSmiles(smi).doc;
    const w = writeSmiles(a);
    const b = parseSmiles(w.smiles).doc;
    return { a, b, w };
  };
  it('round-trips connectivity and H counts', () => {
    for (const smi of ['CCO', 'c1ccccc1O', 'CC(C)(C)C(=O)OC', 'C1CC2CCC1C2', 'OC(=O)C1=CC=CC=C1', '[NH4+]', 'C[N+](C)(C)C', 'N#CC#N', 'C1CCCCC1CC1CC1']) {
      const { a, b } = roundTrip(smi);
      const va = new MolView(a);
      const vb = new MolView(b);
      expect(b.atoms.length).toBe(a.atoms.length);
      expect(b.bonds.length).toBe(a.bonds.length);
      const ha = a.atoms.map((_, i) => va.implicitH(i)).sort().join();
      const hb = b.atoms.map((_, i) => vb.implicitH(i)).sort().join();
      expect(hb).toBe(ha);
    }
  });
  it('preserves stereo parity through a write', () => {
    for (const smi of ['N[C@@H](C)C(=O)O', 'N[C@H](C)C(=O)O', 'C[C@H]1CCCC[C@@H]1C', 'O[C@@H]1CC[C@H](C)CC1', 'F/C=C/F', 'F/C=C\\F', 'C/C=C/C=C\\C']) {
      const { w } = roundTrip(smi);
      const again = writeSmiles(parseSmiles(w.smiles).doc).smiles;
      expect(again).toBe(w.smiles);
    }
  });
  it('permutation parity', () => {
    expect(permutationParity([1, 2, 3, 4], [1, 2, 3, 4])).toBe(0);
    expect(permutationParity([1, 2, 3, 4], [2, 1, 3, 4])).toBe(1);
    expect(permutationParity([1, 2, 3, 4], [2, 3, 1, 4])).toBe(0);
    expect(permutationParity([1, 2, 3], [1, 2, 4])).toBe(null);
  });
});

describe('rings and aromaticity', () => {
  it('finds SSSR', () => {
    const count = (smi: string) => perceiveRings(new MolView(parseSmiles(smi).doc)).rings.map((r) => r.atoms.length).sort();
    expect(count('C1CCCCC1')).toEqual([6]);
    expect(count('c1ccc2ccccc2c1')).toEqual([6, 6]);
    expect(count('C1CC2CCC1C2')).toEqual([5, 5]);
    expect(count('C12(CCCC1)CCCCC2')).toEqual([5, 6]);
    expect(count('C12C3C4C1C5C2C3C45')).toEqual([4, 4, 4, 4, 4]);
    expect(count('CCC')).toEqual([]);
  });
  it('classifies ring systems', () => {
    const kinds = (smi: string) => perceiveRings(new MolView(parseSmiles(smi).doc)).systems.map((s) => s.kind);
    expect(kinds('C1CC2CCC1C2')).toEqual(['bridged']);
    expect(kinds('C1CCC2CCCCC2C1')).toEqual(['fused']);
    expect(kinds('C1CCC2(C1)CCCC2')).toEqual(['spiro']);
  });
  it('perceives aromaticity', () => {
    const arom = (smi: string) => perceiveAromaticity(parseSmiles(smi).doc).atoms.filter((a) => a.aromatic).length;
    expect(arom('C1=CC=CC=C1')).toBe(6);
    expect(arom('c1ccoc1')).toBe(5);
    expect(arom('c1cc[nH]c1')).toBe(5);
    expect(arom('C1=CCC=C1')).toBe(0);
    expect(arom('C1=CC=CC=CC=C1')).toBe(0);
    expect(arom('c1ccc2ccccc2c1')).toBe(10);
    expect(arom('O=c1cccc[nH]1')).toBe(6);
    expect(arom('Cn1cnc2c1c(=O)n(C)c(=O)n2C')).toBe(9);
    expect(arom('c1ccc2cccc2cc1')).toBe(10);
  });
});
