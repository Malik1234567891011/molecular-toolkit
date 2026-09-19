import { describe, expect, it } from 'vitest';
import { acidSites, parseSmiles } from '../src/index.ts';

const top = (smiles: string) => acidSites(parseSmiles(smiles).doc)[0];

describe('most acidic proton', () => {
  it('ranks textbook classes in the textbook order', () => {
    expect(top('CC(=O)O').kind).toBe('carboxylic acid');
    expect(top('Oc1ccccc1').kind).toBe('phenol');
    expect(top('CCO').kind).toBe('alcohol');
    expect(top('C#CC').kind).toBe('terminal alkyne C–H');
    expect(top('CC(=O)CC(C)=O').kind).toBe('α-H between two C=O');
    expect(top('CCN').kind).toBe('amine N–H');
    expect(top('CC').kind).toBe('alkane C–H');
  });
  it('lowers carboxylic acid pKa with α-halogens', () => {
    expect(top('OC(=O)CCl').pKa).toBeLessThan(top('CC(=O)O').pKa);
    expect(top('OC(=O)C(F)(F)F').pKa).toBeLessThan(top('OC(=O)CCl').pKa);
  });
  it('points at the heavy atom carrying the proton', () => {
    const doc = parseSmiles('CC(=O)O').doc;
    const site = acidSites(doc)[0];
    expect(doc.atoms.find((a) => a.id === site.atomId)?.element).toBe('O');
  });
});
