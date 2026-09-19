/**
 * Round-trip verification of the course-rule engine (spec §21):
 *   structure → engine name → OPSIN → structure, compared by RDKit canonical isomeric SMILES.
 *
 * Usage: node --experimental-strip-types scripts/verify-corpus.ts [profile] [--only=substring] [--json=out.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSmiles } from '../src/smiles.ts';
import { runEngine } from '../src/naming/engine.ts';
import { PROFILES } from '../src/naming/profile.ts';
import { Opsin } from './opsin.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const profileId = args.find((a) => !a.startsWith('--')) ?? 'iupac-2013';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const jsonOut = args.find((a) => a.startsWith('--json='))?.slice(7);
const profiles = profileId === 'all' ? PROFILES : PROFILES.filter((p) => p.id === profileId);
if (!profiles.length) throw new Error(`Unknown profile ${profileId}`);

interface Item { category: string; input: string; smiles: string; source: 'curated' | 'generated' }

const RD = await require('@rdkit/rdkit')();
const canon = (smi: string): string | null => {
  const m = RD.get_mol(smi);
  if (!m || !m.is_valid()) return null;
  const s = m.get_smiles();
  m.delete();
  return s;
};

const opsin = new Opsin();
const items: Item[] = [];
let category = 'misc';
for (const line of readFileSync(path.join(root, 'corpus/curated-names.txt'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  if (t.startsWith('#')) {
    if (!t.startsWith('# Curated') && !t.startsWith('# Ground')) category = t.slice(1).trim();
    continue;
  }
  const r = await opsin.parse(t);
  if (r.status === 'FAILURE' || !r.smiles) {
    console.log(`  [corpus] OPSIN cannot parse curated name "${t}": ${r.message}`);
    continue;
  }
  items.push({ category, input: t, smiles: r.smiles, source: 'curated' });
}
const genPath = path.join(root, 'corpus/generated.json');
if (existsSync(genPath)) {
  for (const g of JSON.parse(readFileSync(genPath, 'utf8')) as Array<{ category: string; smiles: string }>) {
    items.push({ category: g.category, input: g.smiles, smiles: g.smiles, source: 'generated' });
  }
}

const report: any[] = [];
for (const profile of profiles) {
  let pass = 0, fail = 0, unsupported = 0, agree = 0, curated = 0;
  const failures: string[] = [];
  const unsup = new Map<string, number>();
  const seen = new Set<string>();
  for (const it of items) {
    if (only && !it.input.includes(only) && !it.category.includes(only)) continue;
    const truth = canon(it.smiles);
    if (!truth || seen.has(truth + profile.id)) continue;
    seen.add(truth + profile.id);
    let name: string;
    try {
      const doc = parseSmiles(it.smiles).doc;
      name = runEngine(doc, profile).name;
    } catch (e: any) {
      unsupported++;
      const reason = String(e.message).replace(/\(\d+ atoms?, \d+ rings?\)/, '(…)');
      unsup.set(reason, (unsup.get(reason) ?? 0) + 1);
      report.push({ profile: profile.id, category: it.category, input: it.input, status: 'unsupported', reason: e.message });
      continue;
    }
    const back = await opsin.parse(name);
    const got = back.smiles ? canon(back.smiles) : null;
    const ok = got === truth;
    if (ok) pass++;
    else {
      fail++;
      failures.push(`${it.category.padEnd(22)} ${it.input.padEnd(38)} → ${name}   [${back.status === 'FAILURE' ? 'OPSIN: ' + back.message.slice(0, 80) : 'got ' + got + ' want ' + truth}]`);
    }
    if (it.source === 'curated') {
      curated++;
      if (name === it.input) agree++;
    }
    report.push({ profile: profile.id, category: it.category, input: it.input, name, status: ok ? 'verified' : 'failed', truth, got });
  }
  const total = pass + fail + unsupported;
  console.log(`\n=== ${profile.label} (${profile.id}) ===`);
  console.log(`structures: ${total}   verified: ${pass} (${((100 * pass) / total).toFixed(1)}%)   wrong: ${fail}   declined: ${unsupported}`);
  console.log(`exact string match with curated name: ${agree}/${curated}`);
  if (failures.length) {
    console.log('\nWRONG (name does not round-trip):');
    for (const f of failures.slice(0, 200)) console.log('  ' + f);
  }
  if (unsup.size) {
    console.log('\nDECLINED (reason → count):');
    for (const [r, n] of [...unsup.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${r}`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
opsin.close();
