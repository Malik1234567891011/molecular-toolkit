import { describe, expect, it } from 'vitest';
import { parseCondensed } from '../src/condensed.ts';
import { parseSmiles } from '../src/smiles.ts';
import { sameConstitution } from '../src/isomorphism.ts';
import { computeFormula, formulaString } from '../src/formula.ts';

const reads = (text: string, smiles: string) => {
  const got = parseCondensed(text);
  expect(got, `${text} did not parse`).not.toBeNull();
  const want = parseSmiles(smiles).doc;
  const same = sameConstitution(got!.doc, want);
  if (!same) {
    throw new Error(`${text} → ${formulaString(computeFormula(got!.doc).counts)} (expected ${smiles} = ${formulaString(computeFormula(want).counts)})`);
  }
};

describe('condensed structural formulas', () => {
  it.each([
    ['HN(CH3)2', 'CNC'],              // the one my sister's tester typed
    ['(CH3)2NH', 'CNC'],
    ['CH3CH2OH', 'CCO'],
    ['C2H5OH', 'CCO'],
    ['CH3OH', 'CO'],
    ['CH3COOH', 'CC(=O)O'],
    ['CH3CHO', 'CC=O'],
    ['CH3COCH3', 'CC(=O)C'],
    ['CH3CH(OH)CH3', 'CC(O)C'],
    ['(CH3)3COH', 'CC(C)(C)O'],
    ['CH3(CH2)4CH3', 'CCCCCC'],
    ['CH3CH=CH2', 'CC=C'],
    ['CH3C≡CH', 'CC#C'],
    ['CH3CN', 'CC#N'],
    ['CCl4', 'ClC(Cl)(Cl)Cl'],
    ['CHCl3', 'ClC(Cl)Cl'],
    ['CH3NH2', 'CN'],
    ['NH3', 'N'],
    ['H2O', 'O'],
    ['CH4', 'C'],
    ['CH3OCH3', 'COC'],
    ['CH3CONH2', 'CC(=O)N'],
    ['NH2CH2COOH', 'NCC(=O)O'],      // glycine
    ['C6H5OH', 'Oc1ccccc1'],         // phenol
    ['CH3CH2CH2CH3', 'CCCC'],
    ['CO2', 'O=C=O'],
    ['(CH3)2CHCH3', 'CC(C)C'],
  ])('%s → %s', (text, smiles) => reads(text, smiles));

  it('leaves molecular formulas, names and SMILES alone', () => {
    for (const other of ['C5H10', 'C6H14', 'C8H10N4O2', 'benzene', 'dimethylamine', 'CCO', 'c1ccccc1', '2-methylpentane']) {
      expect(parseCondensed(other), `${other} should not be read as a condensed formula`).toBeNull();
    }
  });

  it('refuses structures whose valences cannot work', () => {
    expect(parseCondensed('CH5')).toBeNull();
    expect(parseCondensed('CH3CH5')).toBeNull();
  });
});
