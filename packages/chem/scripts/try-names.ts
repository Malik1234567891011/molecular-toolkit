import { parseSmiles } from '../src/smiles.ts';
import { runEngine } from '../src/naming/engine.ts';
import { PROFILE_2013, PROFILE_TEXTBOOK, PROFILE_MODERN_COURSE } from '../src/naming/profile.ts';
const profile = process.argv[2] === 'textbook' ? PROFILE_TEXTBOOK : process.argv[2] === 'modern' ? PROFILE_MODERN_COURSE : PROFILE_2013;
const list = (process.argv[3] ?? '').split(' ').filter(Boolean);
const DEFAULT = ['CCCCCC', 'CC(C)CC(CC)CCC', 'CCC(CC)C(C)CCC', 'CC(C)C(C)C', 'CCO', 'CC(O)C', 'CC(C)(O)CC', 'OCC(O)CO', 'CC=CC', 'C=CC=C', 'C#CCC=C', 'CC(=O)C', 'CCC(=O)O', 'CC(C)C(=O)O', 'OC(=O)CCC(=O)O', 'CC=O', 'C1CCCCC1', 'CC1CCCCC1', 'OC1CCCCC1', 'CC1CCCCC1O', 'C1=CCCCC1', 'c1ccccc1', 'Cc1ccccc1', 'Oc1ccccc1', 'Cc1ccc(O)cc1', 'Clc1ccccc1Cl', 'OC(=O)c1ccccc1', 'CCOC(=O)C', 'CCOC(=O)CC', 'COC(=O)c1ccccc1', 'CC(=O)N', 'CC(=O)NC', 'CN(C)C=O', 'CCN', 'CCNC', 'CCN(C)C', 'Nc1ccccc1', 'CCOCC', 'COC', 'CCC#N', 'N#Cc1ccccc1', 'CC(=O)Cl', 'CC(=O)OC(C)=O', 'C1CCOC1', 'C1CCNCC1', 'c1ccncc1', 'c1cc[nH]c1', 'c1ccoc1', 'CC(C)Cl', 'CC(C)(C)Br', 'ClCCl', 'C[C@H](O)CC', 'C/C=C/C', 'C/C=C\\C', 'C[C@@H](Cl)[C@H](C)O', 'C1CC2CCC1C2', 'C1CCC2(CC1)CCCC2', 'c1ccc2ccccc2c1', 'CC(C)c1ccccc1', 'CC(=O)c1ccccc1', 'O=C1CCCCC1', 'O=C1CCCO1', 'CCCC(=O)CC(C)C', 'CC(O)CC(=O)O', 'NCCO', 'OCCCl', 'CC(C)CO', 'C=CCO', 'CC(C)=C', 'C[C@H]1CC[C@@H](C)CC1', 'C[C@H]1CC[C@H](C)CC1', '[Na+].CC(=O)[O-]', 'CC[O-].[Na+]', 'C[C+](C)C', 'C[NH3+]', 'CCOc1ccccc1', 'OC(=O)C(O)C(O)C(=O)O', 'CC(Cl)C(=O)O', 'O=CC1CCCCC1', 'OC(=O)C1CCCCC1', 'CCCCCC(CC)CC(C)C', 'CC(C)CC(C)(C)C'];
for (const smi of list.length ? list : DEFAULT) {
  try {
    const r = runEngine(parseSmiles(smi).doc, profile);
    console.log(smi.padEnd(34), r.name);
  } catch (e: any) {
    console.log(smi.padEnd(34), 'ERROR:', e.message);
  }
}
