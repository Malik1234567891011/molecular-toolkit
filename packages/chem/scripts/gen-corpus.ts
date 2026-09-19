/**
 * Programmatic stress corpus for the naming engine (spec §21 "gold corpus" + deliberate traps).
 * Deterministic: a fixed seed drives substituent and stereo choices.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSmiles, writeSmiles } from '../src/smiles.ts';
import { perceiveStereo } from '../src/cip.ts';
import { applyCommand } from '../src/commands.ts';
import { MolView } from '../src/graph.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RD = await require('@rdkit/rdkit')();

let seed = 20260918;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];

const out = new Map<string, { category: string; smiles: string }>();
const canon = (smi: string): string | null => {
  const m = RD.get_mol(smi);
  if (!m || !m.is_valid()) return null;
  const s = m.get_smiles();
  m.delete();
  return s;
};
const add = (category: string, smi: string) => {
  const c = canon(smi);
  if (!c || out.has(c)) return;
  out.set(c, { category, smiles: c });
};

/** Give every stereocentre / stereo double bond a random configuration. */
const withRandomStereo = (smi: string): string | null => {
  try {
    let doc = parseSmiles(smi).doc;
    const st = perceiveStereo(doc);
    for (const c of st.centres) {
      if (c.needsHigherRules) continue;
      doc = applyCommand(doc, { type: 'setDescriptor', atomId: c.atomId, descriptor: rand() < 0.5 ? 'R' : 'S' }).doc;
    }
    for (const b of perceiveStereo(doc).bonds) {
      doc = applyCommand(doc, { type: 'setDoubleBondDescriptor', bondId: b.bondId, descriptor: rand() < 0.5 ? 'E' : 'Z' }).doc;
    }
    return writeSmiles(doc).smiles;
  } catch {
    return null;
  }
};

// ---- Alkane skeletons C1–C8 (all isomers) by growth.
const skeletons = new Set<string>(['C']);
let frontier = ['C'];
for (let n = 2; n <= 8; n++) {
  const next = new Set<string>();
  for (const s of frontier) {
    const m = RD.get_mol(s);
    const nAtoms = m.get_num_atoms();
    m.delete();
    for (let k = 0; k < nAtoms; k++) {
      // Attach a carbon to atom k via atom-mapped SMILES trick: use RDKit to add a branch.
      const mol = RD.get_mol(s);
      const mb = mol.get_molblock();
      mol.delete();
      const lines = mb.split('\n');
      const counts = lines[3];
      const na = parseInt(counts.slice(0, 3), 10);
      const nb = parseInt(counts.slice(3, 6), 10);
      const atomLines = lines.slice(4, 4 + na);
      const bondLines = lines.slice(4 + na, 4 + na + nb);
      atomLines.push('    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0');
      bondLines.push(`${String(k + 1).padStart(3)}${String(na + 1).padStart(3)}  1  0`);
      const newMb = [lines[0], lines[1], lines[2], `${String(na + 1).padStart(3)}${String(nb + 1).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`, ...atomLines, ...bondLines, 'M  END'].join('\n');
      const nm = RD.get_mol(newMb);
      if (!nm || !nm.is_valid()) continue;
      const smi = nm.get_smiles();
      nm.delete();
      if (!smi.includes('C(C)(C)(C)C') || true) next.add(smi);
    }
  }
  frontier = [...next].filter((s) => {
    const m = RD.get_mol(s);
    const ok = m && m.is_valid();
    m?.delete();
    return ok;
  });
  for (const s of frontier) skeletons.add(s);
}
for (const s of skeletons) add('alkane isomers', s);
const smallSkeletons = [...skeletons].filter((s) => (s.match(/C/g) ?? []).length <= 6);

// ---- Functionalise small skeletons at every position.
const GROUPS: Array<[string, string]> = [
  ['O', 'alcohols'], ['Cl', 'haloalkanes'], ['Br', 'haloalkanes'], ['N', 'amines'], ['OC', 'ethers'],
  ['C(=O)O', 'acids'], ['C=O', 'aldehydes'], ['C#N', 'nitriles'], ['NC', 'amines'], ['S', 'thiols'], ['C(=O)OC', 'esters'], ['C(=O)N', 'amides'],
];
for (const s of smallSkeletons) {
  const base = parseSmiles(s).doc;
  for (const at of base.atoms) {
    for (const [g, cat] of GROUPS) {
      try {
        const frag = parseSmiles(g).doc;
        const d = applyCommand(base, { type: 'addFragment', fragment: frag, bondFrom: { atomId: at.id, fragmentAtomId: frag.atoms[0].id, order: 1 } }).doc;
        add(cat, writeSmiles(d).smiles);
      } catch {
        /* over-valent */
      }
    }
  }
}

// ---- Two groups on small skeletons (competition for the principal group and numbering traps).
const PAIRS = ['O', 'Cl', 'Br', 'N', 'C=C', 'C#C', 'OC', 'C(=O)O', 'C=O', 'F'];
for (let t = 0; t < 700; t++) {
  const s = pick(smallSkeletons.filter((x) => x.length >= 3));
  const doc = parseSmiles(s).doc;
  const a = pick(doc.atoms).id;
  const b = pick(doc.atoms).id;
  const g1 = pick(PAIRS);
  const g2 = pick(PAIRS);
  let d = doc;
  const attach = (at: string, g: string) => {
    const frag = parseSmiles(g).doc;
    d = applyCommand(d, { type: 'addFragment', fragment: frag, bondFrom: { atomId: at, fragmentAtomId: frag.atoms[0].id, order: 1 } }).doc;
  };
  try {
    attach(a, g1);
    attach(b, g2);
    const smi = writeSmiles(d).smiles;
    add('multifunctional chains', smi);
    const st = withRandomStereo(smi);
    if (st) add('stereo chains', st);
  } catch {
    /* over-valent combinations are skipped */
  }
}

// ---- Alkenes / alkynes with stereo.
for (let t = 0; t < 250; t++) {
  const len = 3 + Math.floor(rand() * 6);
  const pos = 1 + Math.floor(rand() * (len - 1));
  let smi = '';
  for (let i = 0; i < len; i++) {
    smi += 'C';
    if (i === pos - 1) smi += rand() < 0.8 ? '=' : '#';
    if (rand() < 0.25 && i > 0 && i < len - 1) smi += `(${pick(['C', 'CC', 'Cl', 'O', 'C(C)C', 'Br'])})`;
  }
  const st = withRandomStereo(smi);
  if (st) add('alkenes/alkynes', st);
}

// ---- Rings with substituents.
const RINGS = ['C1CC1', 'C1CCC1', 'C1CCCC1', 'C1CCCCC1', 'C1CCCCCC1', 'C1=CCCCC1', 'C1=CCCC1', 'c1ccccc1', 'C1CCOC1', 'C1CCNCC1', 'c1ccncc1', 'c1ccoc1', 'c1ccsc1', 'c1cc[nH]c1', 'C1CC2CCC1C2', 'c1ccc2ccccc2c1', 'C1CCC2(CC1)CCC2', 'C1CCOCC1', 'C1COCCN1', 'c1cnc[nH]1', 'c1cncnc1', 'C1CC2CCCC2C1', 'O1CC1', 'C1CCCCCCC1', 'c1ccc2[nH]ccc2c1', 'c1ccc2ncccc2c1'];
const SUBS = ['C', 'CC', 'C(C)C', 'C(C)(C)C', 'Cl', 'Br', 'F', 'I', 'O', 'N', '[N+](=O)[O-]', 'OC', 'C(=O)O', 'C=O', 'C#N', 'C(C)=O', 'C(=O)OC', 'C=C', 'N(C)C', 'S', 'C(F)(F)F', 'CO', 'C(=O)N', 'OC(C)=O', 'CCO', 'c1ccccc1'];
for (let t = 0; t < 900; t++) {
  const r = pick(RINGS);
  let d = parseSmiles(r).doc;
  const nSubs = 1 + Math.floor(rand() * 3);
  try {
    for (let k = 0; k < nSubs; k++) {
      const v = new MolView(d);
      const cand = d.atoms.filter((a, i) => (a.element === 'C' || a.element === 'N') && v.implicitH(i) > 0);
      if (!cand.length) break;
      const at = pick(cand).id;
      const frag = parseSmiles(pick(SUBS)).doc;
      d = applyCommand(d, { type: 'addFragment', fragment: frag, bondFrom: { atomId: at, fragmentAtomId: frag.atoms[0].id, order: 1 } }).doc;
    }
    const smi = writeSmiles(d).smiles;
    add('ring compounds', smi);
    const st = withRandomStereo(smi);
    if (st) add('ring stereo', st);
  } catch {
    /* skip */
  }
}

// ---- Esters, amides, amines, ethers from two fragments.
const ALKYL = ['C', 'CC', 'CCC', 'C(C)C', 'CCCC', 'CC(C)C', 'C(C)CC', 'C(C)(C)C', 'c1ccccc1', 'Cc1ccccc1', 'C1CCCCC1', 'CC=C', 'CCCl'];
for (let t = 0; t < 300; t++) {
  const a = pick(ALKYL);
  const b = pick(ALKYL);
  const kind = pick(['ester', 'amide', 'amine', 'ether', 'tertamine', 'ketone', 'sulfide']);
  const acyl = a === 'c1ccccc1' ? 'c1ccccc1C(=O)' : `${a}C(=O)`;
  const smi =
    kind === 'ester' ? `${acyl}O${b}` :
    kind === 'amide' ? `${acyl}N${b}` :
    kind === 'amine' ? `${a}N${b}` :
    kind === 'tertamine' ? `${a}N(C)${b}` :
    kind === 'ketone' ? `${a}C(=O)${b}` :
    kind === 'sulfide' ? `${a}S${b}` : `${a}O${b}`;
  add(`${kind}s`, smi);
}

// ---- Deliberate traps (spec §21).
const TRAPS = [
  'CCC(CC)C(C)CC', 'CC(C)C(CC)CC(C)C', 'CCCC(C(C)C)C(C)CCC', 'CCC(C)(CC)C(C)(C)C', 'C=CC(C#C)CC', 'CC(=C)CC=C', 'OCC=CC=O',
  'CC(O)CC(C)(C)O', 'OC1CCC(O)CC1', 'CC1CC(C)CC(C)C1', 'ClC1=CC=CC=C1Br', 'OCC(CO)(CO)CO', 'CCC(C)C(C)C(C)CC',
  'C[C@H](Br)[C@@H](Br)C', 'C[C@H](Br)[C@H](Br)C', 'O[C@H]1CCCC[C@@H]1O', 'O[C@H]1CCCC[C@H]1O', 'C/C=C/C=C/C', 'C/C=C\\C=C/C',
  'CC(C)(C)C1CCC(CC1)C', 'C[C@@H]1CC[C@@H](CC1)C(C)(C)C', 'C1CC1C1CC1', 'CC(C)C(C)(C)C(C)C', 'CCCC(CC)(CC)CCCC',
];
for (const t of TRAPS) add('traps', t);

const list = [...out.values()];
writeFileSync(path.resolve(here, '../../../corpus/generated.json'), JSON.stringify(list, null, 0));
const counts = new Map<string, number>();
for (const x of list) counts.set(x.category, (counts.get(x.category) ?? 0) + 1);
console.log(`generated ${list.length} unique structures`);
for (const [k, v] of counts) console.log(`  ${k}: ${v}`);
