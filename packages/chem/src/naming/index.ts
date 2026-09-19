import { perceiveStereo } from '../cip.ts';
import { MolView } from '../graph.ts';
import { sameConstitution } from '../isomorphism.ts';
import { parseSmiles } from '../smiles.ts';
import type { MoleculeDocument } from '../types.ts';
import { COMMON_NAMES } from './common.ts';
import { nameGroup, NamingUnsupported, prepareForNaming, runEngine } from './engine.ts';
import { ENGINE_VERSION, PROFILE_2013, PROFILE_MODERN_COURSE, PROFILE_TEXTBOOK, PROFILES, type NamingProfile } from './profile.ts';
import type { AlternativeName, NamingResult } from './types.ts';

export * from './types.ts';
export { PROFILES, PROFILE_2013, PROFILE_TEXTBOOK, PROFILE_MODERN_COURSE, ENGINE_VERSION, type NamingProfile } from './profile.ts';
export { runEngine, nameGroup, NamingUnsupported, prepareForNaming } from './engine.ts';
export { COMMON_NAMES } from './common.ts';
export { CG_LABEL, SENIORITY } from './groups.ts';

const commonDocs = new Map<string, MoleculeDocument>();
function commonDoc(smiles: string): MoleculeDocument {
  let d = commonDocs.get(smiles);
  if (!d) {
    d = parseSmiles(smiles).doc;
    commonDocs.set(smiles, d);
  }
  return d;
}

/** Structure → name with the course engine, plus accepted alternative forms (spec §9.3). */
export function nameMolecule(doc: MoleculeDocument, profile: NamingProfile = PROFILE_2013, withAlternatives = true): NamingResult {
  const warnings: string[] = [];
  let main: ReturnType<typeof runEngine> | null = null;
  let reason: string | undefined;
  try {
    main = runEngine(doc, profile);
  } catch (e) {
    if (e instanceof NamingUnsupported) reason = e.message;
    else reason = `the course engine hit an internal error (${(e as Error).message})`;
  }
  const alternatives: AlternativeName[] = [];
  const add = (a: AlternativeName) => {
    if (!a.name || a.name === main?.name || alternatives.some((x) => x.name === a.name)) return;
    alternatives.push(a);
  };
  if (withAlternatives) {
    for (const p of PROFILES) {
      if (p.id === profile.id) continue;
      try {
        const r = runEngine(doc, p);
        add({
          name: r.name,
          kind: p.id === PROFILE_TEXTBOOK.id ? 'traditional-locants' : p.id === PROFILE_MODERN_COURSE.id ? 'common-prefixes' : 'systematic',
          note: p.id === PROFILE_TEXTBOOK.id ? 'classic textbook style (1979/1993 rules)' : p.id === PROFILE_MODERN_COURSE.id ? 'with common substituent prefixes' : 'IUPAC 2013 preferred-name style',
          profileId: p.id,
        });
      } catch {
        /* profile cannot name it either */
      }
    }
    if (main) {
      const n = main.name;
      const single = /^\((\d+[a-z]?)([RSEZ])\)-(.*)$/.exec(n);
      if (single) add({ name: `(${single[2]})-${single[3]}`, kind: 'stereo-variant', note: 'stereodescriptor without its locant' });
      const cisTrans = alkeneCisTrans(doc, n);
      if (cisTrans) add({ name: cisTrans, kind: 'stereo-variant', note: 'cis/trans for a disubstituted alkene' });
      for (const f of functionalClass(doc)) add(f);
      const omp = orthoMetaPara(n);
      if (omp) add({ name: omp, kind: 'traditional-locants', note: 'o/m/p for a disubstituted benzene' });
      if (n === 'prop-1-ene' || n === 'prop-1-yne') add({ name: n.replace('-1-', ''), kind: 'traditional-locants', note: 'locant omitted (only one position possible)' });
    }
    for (const c of commonNames(doc)) add(c);
  }
  return {
    ok: !!main,
    name: main?.name,
    tokens: main?.tokens,
    trace: main?.trace,
    alternatives,
    unsupportedReason: main ? undefined : reason,
    warnings: [...warnings, ...(main?.warnings ?? [])],
    engineVersion: ENGINE_VERSION,
  };
}

function alkeneCisTrans(doc: MoleculeDocument, name: string): string | null {
  const st = perceiveStereo(prepareForNaming(doc));
  const specified = st.bonds.filter((b) => b.descriptor);
  if (specified.length !== 1 || st.centres.some((c) => c.descriptor)) return null;
  const view = new MolView(prepareForNaming(doc));
  const b = specified[0];
  const [x, y] = b.atoms.map((id) => view.idx(id));
  const heavySubs = (i: number, j: number) => view.nbrs[i].filter((k) => k !== j && view.el(k) !== 'H').length;
  if (heavySubs(x, y) !== 1 || heavySubs(y, x) !== 1) return null;
  const m = /^\((?:\d+)?([EZ])\)-(.*)$/.exec(name);
  if (!m) return null;
  return `${m[1] === 'Z' ? 'cis' : 'trans'}-${m[2]}`;
}

function orthoMetaPara(name: string): string | null {
  const m = /^(1,2|1,3|1,4)-(di[a-z]+)benzene$/.exec(name);
  if (m) return `${m[1] === '1,2' ? 'o' : m[1] === '1,3' ? 'm' : 'p'}-${m[2]}benzene`;
  const m2 = /^1-([a-z]+)-(2|3|4)-([a-z]+)benzene$/.exec(name);
  if (m2) return `${m2[2] === '2' ? 'o' : m2[2] === '3' ? 'm' : 'p'}-${m2[1]}${m2[3]}benzene`;
  return null;
}

/** Functional-class names: ethers, alcohols, alkyl halides and simple amines. */
function functionalClass(input: MoleculeDocument): AlternativeName[] {
  const doc = prepareForNaming(input);
  const view = new MolView(doc);
  if (view.components().length !== 1) return [];
  const hetero = doc.atoms.map((a, i) => i).filter((i) => view.el(i) !== 'C');
  const out: AlternativeName[] = [];
  const common = PROFILE_MODERN_COURSE;
  const hasMultiple = doc.bonds.some((b) => b.order > 1 && !b.aromatic);
  if (doc.atoms.some((a) => a.stereo) || doc.bonds.some((b) => b.stereo)) return out;
  try {
    if (hetero.length === 1) {
      const x = hetero[0];
      const el = view.el(x);
      const nb = view.nbrs[x];
      if (el === 'O' && nb.length === 2 && nb.every((j) => view.el(j) === 'C') && !hasMultiple) {
        const names = nb.map((j) => nameGroup(doc, doc.atoms[j].id, doc.atoms[x].id, common)).sort();
        const phrase = names[0] === names[1] ? `di${names[0]}` : `${names[0]} ${names[1]}`;
        out.push({ name: `${phrase} ether`, kind: 'functional-class', note: 'functional-class ether name' });
      }
      if (el === 'O' && nb.length === 1 && view.totalH(x) === 1 && !hasMultiple && view.el(nb[0]) === 'C' && !view.atoms[nb[0]].aromatic) {
        out.push({ name: `${nameGroup(doc, doc.atoms[nb[0]].id, doc.atoms[x].id, common)} alcohol`, kind: 'functional-class', note: 'functional-class alcohol name' });
      }
      if (['Cl', 'Br', 'I', 'F'].includes(el) && nb.length === 1 && !hasMultiple && !view.atoms[nb[0]].aromatic) {
        const halide = { F: 'fluoride', Cl: 'chloride', Br: 'bromide', I: 'iodide' }[el as 'F'];
        out.push({ name: `${nameGroup(doc, doc.atoms[nb[0]].id, doc.atoms[x].id, common)} ${halide}`, kind: 'functional-class', note: 'functional-class alkyl halide name' });
      }
      if (el === 'N' && doc.atoms[x].formalCharge === 0 && nb.every((j) => view.el(j) === 'C' && !view.atoms[j].aromatic) && !hasMultiple && nb.length >= 1) {
        const names = nb.map((j) => nameGroup(doc, doc.atoms[j].id, doc.atoms[x].id, common)).sort();
        const counts = new Map<string, number>();
        for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
        const mult = ['', '', 'di', 'tri'];
        const parts = [...counts.entries()].map(([n, c]) => (c > 1 ? `${mult[c]}${n}` : n));
        if (parts.every((p) => !/[\d(-]/.test(p))) out.push({ name: `${parts.join('')}amine`, kind: 'functional-class', note: 'common alkylamine name' });
      }
    }
  } catch {
    /* group could not be named — skip the alternative */
  }
  return out;
}

function commonNames(input: MoleculeDocument): AlternativeName[] {
  const doc = prepareForNaming(input);
  const out: AlternativeName[] = [];
  const specified = doc.atoms.some((a) => a.stereo) || doc.bonds.some((b) => b.stereo);
  for (const e of COMMON_NAMES) {
    const ref = commonDoc(e.smiles);
    if (ref.atoms.length !== doc.atoms.length) continue;
    if (!sameConstitution(doc, ref)) continue;
    const refSpecified = ref.atoms.some((a) => a.stereo) || ref.bonds.some((b) => b.stereo);
    if (refSpecified) {
      const a = perceiveStereo(doc);
      const b = perceiveStereo(ref);
      const da = [...a.centres.map((c) => c.descriptor ?? '?'), ...a.bonds.map((x) => x.descriptor ?? '?')].sort().join();
      const db = [...b.centres.map((c) => c.descriptor ?? '?'), ...b.bonds.map((x) => x.descriptor ?? '?')].sort().join();
      if (da !== db) continue;
    } else if (specified) continue;
    out.push({ name: e.name, kind: 'retained', note: e.pin ? 'retained name (also the IUPAC preferred name)' : e.note ? `accepted common name (${e.note})` : 'accepted common name' });
  }
  return out;
}
