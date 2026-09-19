/// <reference lib="webworker" />
/**
 * Chemistry worker: keeps the UI thread at 60 fps (spec §16 "Web Workers").
 * - Orbital chem core: validation, facts, stereo, naming engine + trace.
 * - RDKit.js (MinimalLib, BSD-3): canonical SMILES, InChI/InChIKey, descriptors, CoordGen 2D, SVG, MCS.
 * - OpenChemLib (BSD-3): 3D conformers and MMFF94s+ relaxation / single-point energies.
 */
import * as OCL from 'openchemlib';
import {
  computeFormula, detectFunctionalGroups, summarizeGroups, validateDocument, perceiveStereo, stereoMismatches, writeSmiles, writeMolfileV2000,
  parseMolfile, parseSmiles, MolView, localGeometry, placeHydrogens, rotateFragment, sideOfBond, alignTo, wedgesFromStereo,
  naming, type MoleculeDocument, type Vec3, type Conformer, type Vec2,
} from '@orbital/chem';

declare const self: DedicatedWorkerGlobalScope;
declare function importScripts(...urls: string[]): void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const initRDKitModule: (opts: any) => Promise<any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RD: any = null;
let rdkitVersion = '';
let ready: Promise<void> | null = null;

function init(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    importScripts('/rdkit/RDKit_minimal.js');
    RD = await initRDKitModule({ locateFile: () => '/rdkit/RDKit_minimal.wasm' });
    RD.prefer_coordgen(true);
    rdkitVersion = RD.version();
    await OCL.Resources.registerFromUrl('/ocl/resources.json');
  })();
  return ready;
}

// ---------------------------------------------------------------------------------------------

function rdMolFromDoc(doc: MoleculeDocument) {
  const smi = writeSmiles(doc).smiles;
  const mol = RD.get_mol(smi);
  return { mol, smiles: smi };
}

function identifiers(doc: MoleculeDocument) {
  if (!doc.atoms.length) return null;
  const { mol, smiles } = rdMolFromDoc(doc);
  if (!mol || !mol.is_valid()) {
    mol?.delete();
    return { valid: false, smiles };
  }
  try {
    const canonical = mol.get_smiles();
    const inchi = mol.get_inchi();
    const inchiKey = inchi ? RD.get_inchikey_for_inchi(inchi) : '';
    const d = JSON.parse(mol.get_descriptors());
    return {
      valid: true,
      smiles,
      canonicalSmiles: canonical,
      inchi,
      inchiKey,
      descriptors: {
        exactMass: d.exactmw, molarMass: d.amw, logP: d.CrippenClogP, tpsa: d.tpsa, hbd: d.NumHBD, hba: d.NumHBA,
        rotatableBonds: d.NumRotatableBonds, rings: d.NumRings, aromaticRings: d.NumAromaticRings, fractionCSP3: d.FractionCSP3,
      },
    };
  } finally {
    mol.delete();
  }
}

function analyze(doc: MoleculeDocument, profileId: string) {
  const t0 = performance.now();
  const view = new MolView(doc);
  const formula = computeFormula(doc);
  const validation = validateDocument(doc);
  const groups = detectFunctionalGroups(doc);
  const stereo = perceiveStereo(doc);
  const geometry: Record<string, ReturnType<typeof localGeometry>> = {};
  doc.atoms.forEach((a, i) => (geometry[a.id] = localGeometry(view, i)));
  const implicitH: Record<string, number> = {};
  doc.atoms.forEach((a, i) => (implicitH[a.id] = view.implicitH(i)));
  const ids = identifiers(doc);
  const profile = naming.PROFILES.find((p) => p.id === profileId) ?? naming.PROFILE_2013;
  let name: ReturnType<typeof naming.nameMolecule> | null = null;
  if (doc.atoms.length && !validation.some((v) => v.severity === 'error')) {
    try {
      name = naming.nameMolecule(doc, profile);
    } catch (e) {
      name = { ok: false, alternatives: [], warnings: [], unsupportedReason: `internal error: ${(e as Error).message}`, engineVersion: naming.ENGINE_VERSION };
    }
  }
  return {
    formula, validation, groups, groupSummary: summarizeGroups(groups), stereo, geometry, implicitH, identifiers: ids, naming: name,
    engine: { rdkit: rdkitVersion, naming: naming.ENGINE_VERSION }, ms: performance.now() - t0,
  };
}

function layout2d(doc: MoleculeDocument): { layout: Record<string, Vec2>; doc: MoleculeDocument } {
  const mb = writeMolfileV2000(doc);
  const mol = RD.get_mol(mb, JSON.stringify({ removeHs: false, sanitize: true }));
  if (!mol || !mol.is_valid()) throw new Error('RDKit could not lay out this structure');
  mol.set_new_coords(true);
  mol.normalize_depiction(1, 1.5);
  mol.straighten_depiction(false);
  const out = mol.get_molblock();
  mol.delete();
  const parsed = parseMolfile(out).doc;
  const layout: Record<string, Vec2> = {};
  doc.atoms.forEach((a, i) => {
    const p = parsed.layout2d[parsed.atoms[i].id];
    layout[a.id] = [p[0], p[1]];
  });
  const next = wedgesFromStereo({ ...doc, layout2d: layout });
  return { layout, doc: next };
}

function svg(doc: MoleculeDocument, width: number, height: number, highlight?: string[], dark?: boolean) {
  if (!doc.atoms.length) return '';
  const { mol } = rdMolFromDoc(doc);
  if (!mol || !mol.is_valid()) return '';
  try {
    const order = writeSmiles(doc).order;
    const atoms = (highlight ?? []).map((id) => order.indexOf(id)).filter((k) => k >= 0);
    const details: Record<string, unknown> = {
      width, height, bondLineWidth: 1.6, addStereoAnnotation: true, clearBackground: false, fixedFontSize: 14,
      atoms, highlightColour: [0.43, 0.42, 0.98, 0.35],
    };
    if (dark) details.backgroundColour = [0, 0, 0, 0];
    let s: string = mol.get_svg_with_highlights(JSON.stringify(details));
    if (dark) s = s.replace(/#000000/g, '#E6E8EE').replace(/fill:#FFFFFF/g, 'fill:none');
    return s;
  } finally {
    mol.delete();
  }
}

// ---------------------------------------------------------------------------------------------
// 3D with OpenChemLib (MMFF94s+)

interface OclBuild {
  mol: OCL.Molecule;
  keys: string[]; // coordinate key for each OCL atom
}

/** Build an OCL molecule with explicit hydrogens in our key order, coordinates from `coords`. */
function oclFromCoords(doc: MoleculeDocument, coords: Record<string, Vec3>): OclBuild {
  const view = new MolView(doc);
  const mol = new OCL.Molecule(doc.atoms.length * 3, doc.atoms.length * 3);
  const keys: string[] = [];
  const idx = new Map<string, number>();
  doc.atoms.forEach((a) => {
    const i = mol.addAtom(OCL.Molecule.getAtomicNoFromLabel(a.element));
    mol.setAtomCharge(i, a.formalCharge);
    if (a.isotope) mol.setAtomMass(i, a.isotope);
    const p = coords[a.id] ?? [0, 0, 0];
    mol.setAtomX(i, p[0]);
    mol.setAtomY(i, p[1]);
    mol.setAtomZ(i, p[2]);
    keys.push(a.id);
    idx.set(a.id, i);
  });
  doc.bonds.forEach((b) => {
    const bi = mol.addBond(idx.get(b.a1)!, idx.get(b.a2)!);
    mol.setBondOrder(bi, b.order);
  });
  doc.atoms.forEach((a, ai) => {
    const h = view.implicitH(ai);
    for (let k = 1; k <= h; k++) {
      const key = `${a.id}.h${k}`;
      const p = coords[key];
      const i = mol.addAtom(1);
      mol.setAtomX(i, p ? p[0] : 0);
      mol.setAtomY(i, p ? p[1] : 0);
      mol.setAtomZ(i, p ? p[2] : 0);
      mol.addBond(idx.get(a.id)!, i);
      keys.push(key);
    }
  });
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  return { mol, keys };
}

function readCoords(b: OclBuild): Record<string, Vec3> {
  const out: Record<string, Vec3> = {};
  b.keys.forEach((k, i) => (out[k] = [b.mol.getAtomX(i), b.mol.getAtomY(i), b.mol.getAtomZ(i)]));
  return out;
}

function relax(doc: MoleculeDocument, coords: Record<string, Vec3>, maxIts = 600): { coords: Record<string, Vec3>; energy: number; converged: boolean; method: string } {
  const full = placeHydrogens(doc, coords, doc.atoms.filter((a) => !coords[`${a.id}.h1`] && new MolView(doc).implicitH(new MolView(doc).idx(a.id)) > 0).map((a) => a.id));
  // A force field keeps the handedness it starts from; if the idealized placement contradicts
  // a stored R/S or E/Z, rebuild from the graph instead of minimizing the wrong isomer.
  const wrong = stereoMismatches(doc, full);
  if (wrong.centres.length || wrong.bonds.length) return freshConformer(doc, coords);
  const b = oclFromCoords(doc, full);
  const ff = new OCL.ForceFieldMMFF94(b.mol, OCL.ForceFieldMMFF94.MMFF94SPLUS, {});
  const code = ff.minimise({ maxIts, gradTol: 1e-4, funcTol: 1e-6 });
  const out = readCoords(b);
  const after = stereoMismatches(doc, out);
  if (after.centres.length || after.bonds.length) return freshConformer(doc, coords);
  return { coords: out, energy: ff.getTotalEnergy(), converged: code === 0, method: 'MMFF94s+ (OpenChemLib), gas phase' };
}

function energy(doc: MoleculeDocument, coords: Record<string, Vec3>): number {
  const b = oclFromCoords(doc, coords);
  const ff = new OCL.ForceFieldMMFF94(b.mol, OCL.ForceFieldMMFF94.MMFF94SPLUS, {});
  return ff.getTotalEnergy();
}

/** Fresh conformer honouring stored stereo, checked against the graph (retries other seeds). */
function freshConformer(doc: MoleculeDocument, previous?: Record<string, Vec3>, seed0?: number): { coords: Record<string, Vec3>; energy: number; converged: boolean; method: string } {
  let last: ReturnType<typeof freshConformerOnce> | null = null;
  for (const seed of [seed0 ?? 42, 7, 1234, 99]) {
    last = freshConformerOnce(doc, previous, seed);
    const wrong = stereoMismatches(doc, last.coords);
    if (!wrong.centres.length && !wrong.bonds.length) return last;
  }
  throw new Error('no conformer matched the stored stereochemistry');
}

function freshConformerOnce(doc: MoleculeDocument, previous: Record<string, Vec3> | undefined, seed: number): { coords: Record<string, Vec3>; energy: number; converged: boolean; method: string } {
  const w = writeSmiles(doc);
  const mol = OCL.Molecule.fromSmiles(w.smiles);
  mol.addImplicitHydrogens();
  mol.ensureHelperArrays(OCL.Molecule.cHelperNeighbours);
  const gen = new OCL.ConformerGenerator(seed);
  const conf = gen.getOneConformerAsMolecule(mol);
  if (!conf) throw new Error('No conformer could be generated');
  const ff = new OCL.ForceFieldMMFF94(conf, OCL.ForceFieldMMFF94.MMFF94SPLUS, {});
  const code = ff.minimise({ maxIts: 2000 });
  const coords: Record<string, Vec3> = {};
  const heavy = w.order.length;
  // Heavy atoms keep SMILES order; hydrogens follow, each bonded to its parent.
  for (let i = 0; i < conf.getAllAtoms(); i++) {
    const p: Vec3 = [conf.getAtomX(i), conf.getAtomY(i), conf.getAtomZ(i)];
    if (i < heavy) coords[w.order[i]] = p;
  }
  const hCount = new Map<string, number>();
  for (let i = heavy; i < conf.getAllAtoms(); i++) {
    if (conf.getAtomicNo(i) !== 1) continue;
    const parent = conf.getConnAtom(i, 0);
    if (parent < 0 || parent >= heavy) continue;
    const pid = w.order[parent];
    const n = (hCount.get(pid) ?? 0) + 1;
    hCount.set(pid, n);
    coords[`${pid}.h${n}`] = [conf.getAtomX(i), conf.getAtomY(i), conf.getAtomZ(i)];
  }
  // Sanity: element sequence must match (OCL keeps SMILES atom order).
  for (let i = 0; i < heavy; i++) {
    const a = doc.atoms.find((x) => x.id === w.order[i])!;
    if (OCL.Molecule.getAtomicNoFromLabel(a.element) !== conf.getAtomicNo(i)) throw new Error('Atom order mismatch between SMILES and conformer');
  }
  const aligned = previous ? alignTo(coords, previous) : coords;
  return { coords: aligned, energy: ff.getTotalEnergy(), converged: code === 0, method: 'OpenChemLib conformer generator + MMFF94s+, gas phase' };
}

function scan(doc: MoleculeDocument, coords: Record<string, Vec3>, dihedral: [string, string, string, string], step = 10) {
  const [, b, c] = dihedral;
  const side = sideOfBond(doc, b, c);
  if (!side) throw new Error('Ring bonds cannot rotate freely');
  const angles: number[] = [];
  const energies: number[] = [];
  const bld = oclFromCoords(doc, coords);
  const ff0 = new OCL.ForceFieldMMFF94(bld.mol, OCL.ForceFieldMMFF94.MMFF94SPLUS, {});
  void ff0;
  for (let ang = 0; ang < 360; ang += step) {
    const rot = rotateFragment(coords, side, coords[b], coords[c], ang);
    angles.push(ang);
    energies.push(energy(doc, rot));
  }
  const min = Math.min(...energies);
  return { angles, energies: energies.map((e) => e - min), method: 'MMFF94s+ single points (rigid rotation), relative energies in kcal/mol' };
}

function mcsHighlight(docs: MoleculeDocument[]): string[][] {
  // Atoms NOT in the maximum common substructure: the differing region of each candidate.
  if (docs.length < 2) return docs.map(() => []);
  const list = new RD.MolList();
  const mols = docs.map((d) => RD.get_mol(writeSmiles(d).smiles));
  mols.forEach((m: unknown) => list.append(m));
  try {
    const res = JSON.parse(RD.get_mcs_as_json(list, JSON.stringify({ Timeout: 2 })));
    const q = RD.get_qmol(res.smarts);
    const out = docs.map((d, k) => {
      const order = writeSmiles(d).order;
      const match = JSON.parse(mols[k].get_substruct_match(q));
      const inMcs = new Set<number>(match.atoms ?? []);
      return order.filter((_, i) => !inMcs.has(i));
    });
    q.delete();
    return out;
  } catch {
    return docs.map(() => []);
  } finally {
    mols.forEach((m: { delete(): void }) => m.delete());
    list.delete();
  }
}

function inchiKeyOfSmiles(smiles: string): string | null {
  const m = RD.get_mol(smiles);
  if (!m || !m.is_valid()) return null;
  const inchi = m.get_inchi();
  m.delete();
  return inchi ? RD.get_inchikey_for_inchi(inchi) : null;
}

// ---------------------------------------------------------------------------------------------

type Req = { id: number; op: string; args: Record<string, unknown> };

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, op, args } = ev.data;
  try {
    await init();
    let result: unknown;
    switch (op) {
      case 'ping':
        result = { rdkit: rdkitVersion, ocl: OCL.version };
        break;
      case 'analyze':
        result = analyze(args.doc as MoleculeDocument, args.profileId as string);
        break;
      case 'layout2d':
        result = layout2d(args.doc as MoleculeDocument);
        break;
      case 'svg':
        result = svg(args.doc as MoleculeDocument, (args.width as number) ?? 240, (args.height as number) ?? 180, args.highlight as string[] | undefined, args.dark as boolean);
        break;
      case 'relax':
        result = relax(args.doc as MoleculeDocument, args.coords as Record<string, Vec3>, (args.maxIts as number) ?? 600);
        break;
      case 'fresh':
        result = freshConformer(args.doc as MoleculeDocument, args.previous as Record<string, Vec3> | undefined, args.seed as number | undefined);
        break;
      case 'energy':
        result = energy(args.doc as MoleculeDocument, args.coords as Record<string, Vec3>);
        break;
      case 'scan':
        result = scan(args.doc as MoleculeDocument, args.coords as Record<string, Vec3>, args.dihedral as [string, string, string, string], (args.step as number) ?? 10);
        break;
      case 'mcs':
        result = mcsHighlight(args.docs as MoleculeDocument[]);
        break;
      case 'inchikey':
        result = inchiKeyOfSmiles(args.smiles as string);
        break;
      case 'parse': {
        const text = String(args.text ?? '');
        result = text.includes('M  END') ? parseMolfile(text) : parseSmiles(text);
        break;
      }
      default:
        throw new Error(`Unknown op ${op}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e as Error).message ?? String(e) });
  }
};

export type { Conformer };
