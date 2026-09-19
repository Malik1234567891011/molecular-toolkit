import { describe, expect, it, beforeAll } from 'vitest';
import { parseSmiles, writeSmiles } from '../src/smiles.ts';
import { perceiveStereo } from '../src/cip.ts';
import { rdkit } from './rdkit.ts';

let RD: any;
beforeAll(async () => { RD = await rdkit(); });

const CASES = [
  'N[C@@H](C)C(=O)O', 'N[C@H](C)C(=O)O', 'C[C@H](CC)O', 'C[C@@H](Br)CC', 'C[C@H](Br)[C@@H](C)Br',
  'O[C@H]1[C@H](O)[C@@H](O)[C@H](O)[C@@H](CO)O1', 'CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O', 'CC1=CC[C@@H](CC1=O)C(C)=C',
  'CC(C)Cc1ccc(cc1)[C@@H](C)C(=O)O', 'O=C1CC[C@@H](N2C(=O)c3ccccc3C2=O)C(=O)N1', 'F[C@](Cl)(Br)I', '[2H][C@@H](O)C',
  'C/C=C/C', 'C/C=C\\C', 'C/C=C(/Cl)Br', 'OC(=O)/C=C/C(=O)O', 'CC/C(C)=C(\\C)CC', 'C[C@H]1CCCC[C@@H]1C', 'O[C@@H](C=C)C#C',
  'C[C@@H](O)[C@H](O)C', 'C[C@H](Cl)C(=O)O', 'N[C@@H](Cc1ccccc1)C(=O)O', 'C1C[C@H]2CC[C@@H]1C2', 'C[C@@H]1CC=CC[C@@H]1C',
  'OC[C@@H](O)[C@@H](O)[C@H](O)[C@H](O)C=O', 'C[C@@H](c1ccccc1)N', 'C=C[C@H](C)CC', 'CC[C@@H](C)[C@H](N)C(=O)O',
  'C[S@](=O)c1ccccc1', 'ClC/C=C/C=C/CBr', 'C[C@H](O)/C=C/C',
];

describe('CIP descriptors agree with RDKit', () => {
  for (const smi of CASES) {
    it(smi, () => {
      const doc = parseSmiles(smi).doc;
      const ours = perceiveStereo(doc);
      const mol = RD.get_mol(smi);
      const tags = JSON.parse(mol.get_stereo_tags());
      mol.delete();
      const rdAtoms = new Map<number, string>((tags.CIP_atoms ?? []).map((x: [number, string]) => [x[0], x[1].replace(/[()]/g, '')]));
      for (const c of ours.centres) {
        if (!c.descriptor) continue;
        const idx = doc.atoms.findIndex((a) => a.id === c.atomId);
        expect(`${idx}:${c.descriptor}`).toBe(`${idx}:${rdAtoms.get(idx)}`);
      }
      const ourAssigned = ours.centres.filter((c) => c.descriptor).length;
      const rdAssigned = [...rdAtoms.values()].filter((v) => v === 'R' || v === 'S').length;
      expect(ourAssigned).toBe(rdAssigned);
      const rdBonds = new Map<string, string>((tags.CIP_bonds ?? []).map((x: [number, number, string]) => [[x[0], x[1]].sort().join('-'), x[2].replace(/[()]/g, '')]));
      for (const b of ours.bonds) {
        if (!b.descriptor) continue;
        const i1 = doc.atoms.findIndex((a) => a.id === b.atoms[0]);
        const i2 = doc.atoms.findIndex((a) => a.id === b.atoms[1]);
        expect(b.descriptor).toBe(rdBonds.get([i1, i2].sort().join('-')));
      }
    });
  }
  it('writer output keeps RDKit-canonical identity', () => {
    for (const smi of CASES) {
      const w = writeSmiles(parseSmiles(smi).doc).smiles;
      const a = RD.get_mol(smi); const b = RD.get_mol(w);
      expect(b.get_smiles()).toBe(a.get_smiles());
      a.delete(); b.delete();
    }
  });
});
