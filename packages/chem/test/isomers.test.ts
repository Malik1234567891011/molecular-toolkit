import { describe, expect, it } from 'vitest';
import { enumerateIsomers } from '../src/isomers.ts';
import { computeFormula } from '../src/formula.ts';
import { writeSmiles } from '../src/smiles.ts';

const count = (formula: Record<string, number>) => enumerateIsomers(formula).total;

describe('constitutional isomers from the formula', () => {
  // The alkane series is the classic check: 1, 1, 1, 2, 3, 5, 9, 18, 35, 75.
  it.each([
    [1, 4, 1], [2, 6, 1], [3, 8, 1], [4, 10, 2], [5, 12, 3],
    [6, 14, 5], [7, 16, 9], [8, 18, 18], [9, 20, 35], [10, 22, 75],
  ])('C%iH%i has %i isomers', (c, h, expected) => {
    expect(count({ C: c, H: h })).toBe(expected);
  });

  it.each([
    [{ C: 3, H: 6 }, 2],   // propene, cyclopropane
    [{ C: 4, H: 8 }, 5],   // 3 butenes + cyclobutane + methylcyclopropane
    [{ C: 5, H: 10 }, 10], // 5 pentenes + 5 cyclopentane skeletons
    [{ C: 2, H: 2 }, 1],   // ethyne
    [{ C: 2, H: 6, O: 1 }, 2], // ethanol, dimethyl ether
    [{ C: 3, H: 8, O: 1 }, 3], // two propanols + methoxyethane
    [{ C: 4, H: 10, O: 1 }, 7], // four butanols + three ethers
    [{ C: 2, H: 4, O: 1 }, 3], // acetaldehyde, oxirane, ethenol
    [{ C: 1, H: 4 }, 1],
    [{ H: 2, O: 1 }, 1],
  ])('%o has %i isomers', (formula, expected) => {
    expect(count(formula)).toBe(expected);
  });

  it('every isomer really has the formula asked for, and they are all different', () => {
    const { isomers } = enumerateIsomers({ C: 5, H: 10 });
    const smiles = new Set<string>();
    for (const doc of isomers) {
      const f = computeFormula(doc);
      expect(f.counts).toEqual({ C: 5, H: 10 });
      smiles.add(writeSmiles(doc, { includeStereo: false }).smiles);
    }
    // Different constitutions can still print the same SMILES only if they are the same graph.
    expect(smiles.size).toBe(isomers.length);
  });

  it('puts unbranched chains first and rings last for C5H10', () => {
    const { isomers } = enumerateIsomers({ C: 5, H: 10 });
    const first = isomers[0];
    expect(first.bonds.length).toBe(4); // a chain: one fewer bond than atoms
    expect(first.atoms.every((a) => first.bonds.filter((b) => b.a1 === a.id || b.a2 === a.id).length <= 2)).toBe(true);
    expect(isomers.at(-1)!.bonds.length).toBe(5); // a ring has as many bonds as atoms
  });

  it('explains itself instead of guessing when a formula is impossible', () => {
    expect(enumerateIsomers({ C: 5, H: 14 }).note).toMatch(/No connected structure/);
    expect(enumerateIsomers({ C: 2, H: 7 }).note).toMatch(/don’t balance|No neutral/);
    expect(enumerateIsomers({ C: 30, H: 62 }).note).toMatch(/up to/);
  });
});
