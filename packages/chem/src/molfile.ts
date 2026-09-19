import { DocBuilder } from './builder.ts';
import { isElement } from './elements.ts';
import { MolView } from './graph.ts';
import { doubleBondStereoFrom2D, stereoFromConformer, stereoFromWedges } from './stereo-geometry.ts';
import type { BondOrder, Conformer, MoleculeDocument, Vec3 } from './types.ts';

export class MolfileError extends Error {}

const pad = (s: string | number, n: number, right = false) => {
  const t = String(s);
  return right ? t.padEnd(n) : t.padStart(n);
};
const f4 = (x: number) => x.toFixed(4).padStart(10);

export interface WriteMolfileOptions {
  /** Use 3D coordinates from this conformer (heavy atoms only unless includeHydrogens). */
  conformer?: Conformer;
  includeHydrogens?: boolean;
  title?: string;
}

interface Flat {
  symbols: string[];
  charges: number[];
  isotopes: (number | undefined)[];
  radicals: (number | undefined)[];
  coords: Vec3[];
  bonds: Array<{ a: number; b: number; order: number; stereo: number }>;
}

function flatten(doc: MoleculeDocument, options: WriteMolfileOptions): Flat {
  const view = new MolView(doc);
  const conf = options.conformer;
  const symbols: string[] = [];
  const charges: number[] = [];
  const isotopes: (number | undefined)[] = [];
  const radicals: (number | undefined)[] = [];
  const coords: Vec3[] = [];
  const bonds: Flat['bonds'] = [];
  doc.atoms.forEach((a) => {
    symbols.push(a.element);
    charges.push(a.formalCharge);
    isotopes.push(a.isotope);
    radicals.push(a.radicalElectrons);
    if (conf?.coordinates[a.id]) coords.push(conf.coordinates[a.id]);
    else {
      const p = doc.layout2d[a.id] ?? [0, 0];
      coords.push([p[0], p[1], 0]);
    }
  });
  doc.bonds.forEach((b) => {
    let stereo = 0;
    if (!conf) {
      if (b.order === 1 && b.wedge === 'up') stereo = 1;
      if (b.order === 1 && b.wedge === 'down') stereo = 6;
      if (b.order === 1 && b.wedge === 'either') stereo = 4;
      if (b.order === 2 && b.stereoUnknown) stereo = 3;
    }
    bonds.push({ a: view.idx(b.a1), b: view.idx(b.a2), order: b.order, stereo });
  });
  if (conf && options.includeHydrogens) {
    doc.atoms.forEach((a, i) => {
      for (let k = 1; k <= 4; k++) {
        const key = `${a.id}.h${k}`;
        const p = conf.coordinates[key];
        if (!p) continue;
        symbols.push('H');
        charges.push(0);
        isotopes.push(undefined);
        radicals.push(undefined);
        coords.push(p);
        bonds.push({ a: i, b: symbols.length - 1, order: 1, stereo: 0 });
      }
    });
  }
  return { symbols, charges, isotopes, radicals, coords, bonds };
}

export function writeMolfileV2000(doc: MoleculeDocument, options: WriteMolfileOptions = {}): string {
  const f = flatten(doc, options);
  if (f.symbols.length > 999 || f.bonds.length > 999) return writeMolfileV3000(doc, options);
  const chiral = doc.atoms.some((a) => a.stereo) ? 1 : 0;
  const lines: string[] = [];
  lines.push(options.title ?? doc.title ?? '');
  lines.push(`  Orbital          ${options.conformer ? '3D' : '2D'}`);
  lines.push('');
  lines.push(`${pad(f.symbols.length, 3)}${pad(f.bonds.length, 3)}  0  0${pad(chiral, 3)}  0  0  0  0  0999 V2000`);
  f.symbols.forEach((s, i) => {
    const [x, y, z] = f.coords[i];
    lines.push(`${f4(x)}${f4(y)}${f4(z)} ${pad(s, 3, true)} 0  0  0  0  0  0  0  0  0  0  0  0`);
  });
  f.bonds.forEach((b) => lines.push(`${pad(b.a + 1, 3)}${pad(b.b + 1, 3)}${pad(b.order, 3)}${pad(b.stereo, 3)}`));
  const chg = f.charges.map((c, i) => [i, c] as const).filter(([, c]) => c !== 0);
  for (let k = 0; k < chg.length; k += 8) {
    const part = chg.slice(k, k + 8);
    lines.push(`M  CHG${pad(part.length, 3)}` + part.map(([i, c]) => `${pad(i + 1, 4)}${pad(c, 4)}`).join(''));
  }
  const iso = f.isotopes.map((m, i) => [i, m] as const).filter(([, m]) => m);
  for (let k = 0; k < iso.length; k += 8) {
    const part = iso.slice(k, k + 8);
    lines.push(`M  ISO${pad(part.length, 3)}` + part.map(([i, m]) => `${pad(i + 1, 4)}${pad(m!, 4)}`).join(''));
  }
  const rad = f.radicals.map((r, i) => [i, r] as const).filter(([, r]) => r);
  for (let k = 0; k < rad.length; k += 8) {
    const part = rad.slice(k, k + 8);
    // MDL radical codes: 1 singlet, 2 doublet, 3 triplet
    lines.push(`M  RAD${pad(part.length, 3)}` + part.map(([i, r]) => `${pad(i + 1, 4)}${pad(r === 1 ? 2 : 3, 4)}`).join(''));
  }
  lines.push('M  END');
  return lines.join('\n') + '\n';
}

export function writeMolfileV3000(doc: MoleculeDocument, options: WriteMolfileOptions = {}): string {
  const f = flatten(doc, options);
  const chiral = doc.atoms.some((a) => a.stereo) ? 1 : 0;
  const lines: string[] = [];
  lines.push(options.title ?? doc.title ?? '');
  lines.push(`  Orbital          ${options.conformer ? '3D' : '2D'}`);
  lines.push('');
  lines.push('  0  0  0     0  0            999 V3000');
  lines.push('M  V30 BEGIN CTAB');
  lines.push(`M  V30 COUNTS ${f.symbols.length} ${f.bonds.length} 0 0 ${chiral}`);
  lines.push('M  V30 BEGIN ATOM');
  f.symbols.forEach((s, i) => {
    const [x, y, z] = f.coords[i];
    let extra = '';
    if (f.charges[i]) extra += ` CHG=${f.charges[i]}`;
    if (f.isotopes[i]) extra += ` MASS=${f.isotopes[i]}`;
    if (f.radicals[i]) extra += ` RAD=${f.radicals[i] === 1 ? 2 : 3}`;
    lines.push(`M  V30 ${i + 1} ${s} ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 0${extra}`);
  });
  lines.push('M  V30 END ATOM');
  lines.push('M  V30 BEGIN BOND');
  f.bonds.forEach((b, k) => {
    const cfg = b.stereo === 1 ? ' CFG=1' : b.stereo === 6 ? ' CFG=3' : b.stereo === 4 || b.stereo === 3 ? ' CFG=2' : '';
    lines.push(`M  V30 ${k + 1} ${b.order} ${b.a + 1} ${b.b + 1}${cfg}`);
  });
  lines.push('M  V30 END BOND');
  lines.push('M  V30 END CTAB');
  lines.push('M  END');
  return lines.join('\n') + '\n';
}

export function writeSdf(docs: Array<{ doc: MoleculeDocument; props?: Record<string, string>; conformer?: Conformer }>): string {
  return docs
    .map(({ doc, props, conformer }) => {
      let s = writeMolfileV2000(doc, { conformer, includeHydrogens: !!conformer });
      for (const [k, v] of Object.entries(props ?? {})) s += `> <${k}>\n${v}\n\n`;
      return s + '$$$$\n';
    })
    .join('');
}

export interface ParsedMolfile {
  doc: MoleculeDocument;
  is3D: boolean;
  props: Record<string, string>;
  warnings: string[];
}

export function parseMolfile(text: string): ParsedMolfile {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.length < 4) throw new MolfileError('Molfile is too short');
  const counts = lines[3];
  const isV3000 = counts.includes('V3000');
  const b = new DocBuilder();
  b.doc.title = lines[0].trim() || undefined;
  const coords: Vec3[] = [];
  const bondStereo: number[] = [];
  const warnings: string[] = [];
  let end = 0;
  if (!isV3000) {
    const na = parseInt(counts.slice(0, 3), 10);
    const nb = parseInt(counts.slice(3, 6), 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) throw new MolfileError('Bad counts line');
    for (let i = 0; i < na; i++) {
      const l = lines[4 + i];
      if (l === undefined) throw new MolfileError('Truncated atom block');
      const x = parseFloat(l.slice(0, 10));
      const y = parseFloat(l.slice(10, 20));
      const z = parseFloat(l.slice(20, 30));
      let sym = l.slice(31, 34).trim();
      if (sym === 'D') sym = 'H';
      if (!isElement(sym)) throw new MolfileError(`Unsupported atom symbol "${sym}"`);
      const chgCode = parseInt(l.slice(36, 39), 10) || 0;
      const charge = chgCode ? [0, 3, 2, 1, 0, -1, -2, -3][chgCode] ?? 0 : 0;
      b.addAtom(sym, { formalCharge: charge });
      coords.push([x, y, z]);
    }
    for (let k = 0; k < nb; k++) {
      const l = lines[4 + na + k];
      if (l === undefined) throw new MolfileError('Truncated bond block');
      const a1 = parseInt(l.slice(0, 3), 10) - 1;
      const a2 = parseInt(l.slice(3, 6), 10) - 1;
      const type = parseInt(l.slice(6, 9), 10);
      const stereo = parseInt(l.slice(9, 12), 10) || 0;
      if (type < 1 || type > 4) throw new MolfileError(`Unsupported bond type ${type}`);
      const order = (type === 4 ? 1 : type) as BondOrder;
      b.addBond(b.doc.atoms[a1].id, b.doc.atoms[a2].id, order, type === 4 ? { aromatic: true } : {});
      bondStereo.push(stereo);
    }
    // Property block.
    let chgSeen = false;
    for (let li = 4 + na + nb; li < lines.length; li++) {
      const l = lines[li];
      end = li;
      if (l.startsWith('M  END')) break;
      const entries = (from: number) => {
        const n = parseInt(l.slice(6, 9), 10);
        const out: Array<[number, number]> = [];
        for (let e = 0; e < n; e++) out.push([parseInt(l.slice(from + e * 8, from + e * 8 + 4), 10) - 1, parseInt(l.slice(from + e * 8 + 4, from + e * 8 + 8), 10)]);
        return out;
      };
      if (l.startsWith('M  CHG')) {
        if (!chgSeen) b.doc.atoms.forEach((a) => (a.formalCharge = 0));
        chgSeen = true;
        for (const [i, v] of entries(9)) b.doc.atoms[i].formalCharge = v;
      } else if (l.startsWith('M  ISO')) {
        for (const [i, v] of entries(9)) b.doc.atoms[i].isotope = v;
      } else if (l.startsWith('M  RAD')) {
        for (const [i, v] of entries(9)) b.doc.atoms[i].radicalElectrons = v === 2 ? 1 : 2;
      }
    }
  } else {
    let mode = '';
    for (let li = 4; li < lines.length; li++) {
      const l = lines[li];
      end = li;
      if (l.startsWith('M  END')) break;
      if (!l.startsWith('M  V30 ')) continue;
      const body = l.slice(7).trim();
      if (body.startsWith('BEGIN ATOM')) { mode = 'atom'; continue; }
      if (body.startsWith('BEGIN BOND')) { mode = 'bond'; continue; }
      if (body.startsWith('END')) { mode = ''; continue; }
      const parts = body.split(/\s+/);
      if (mode === 'atom') {
        let sym = parts[1];
        if (sym === 'D') sym = 'H';
        if (!isElement(sym)) throw new MolfileError(`Unsupported atom symbol "${sym}"`);
        const props: Record<string, string> = {};
        for (const p of parts.slice(6)) {
          const [k, v] = p.split('=');
          if (v !== undefined) props[k] = v;
        }
        const rad = props.RAD ? parseInt(props.RAD, 10) : 0;
        b.addAtom(sym, {
          formalCharge: props.CHG ? parseInt(props.CHG, 10) : 0,
          ...(props.MASS ? { isotope: parseInt(props.MASS, 10) } : {}),
          ...(rad ? { radicalElectrons: rad === 2 ? 1 : 2 } : {}),
        });
        coords.push([parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4])]);
      } else if (mode === 'bond') {
        const type = parseInt(parts[1], 10);
        const a1 = parseInt(parts[2], 10) - 1;
        const a2 = parseInt(parts[3], 10) - 1;
        const cfgPart = parts.find((p) => p.startsWith('CFG='));
        const cfg = cfgPart ? parseInt(cfgPart.slice(4), 10) : 0;
        const order = (type === 4 ? 1 : type) as BondOrder;
        b.addBond(b.doc.atoms[a1].id, b.doc.atoms[a2].id, order, type === 4 ? { aromatic: true } : {});
        bondStereo.push(cfg === 1 ? 1 : cfg === 3 ? 6 : cfg === 2 ? (order === 2 ? 3 : 4) : 0);
      }
    }
  }
  const props: Record<string, string> = {};
  for (let li = end + 1; li < lines.length; li++) {
    const m = /^>\s*<([^>]+)>/.exec(lines[li]);
    if (m) {
      const vals: string[] = [];
      li++;
      while (li < lines.length && lines[li].trim() !== '' && !lines[li].startsWith('$$$$')) vals.push(lines[li++]);
      props[m[1]] = vals.join('\n');
    }
  }
  const doc = b.doc;
  if (doc.bonds.some((x) => x.aromatic)) {
    throw new MolfileError('Aromatic (type 4) bonds in molfiles are not supported; please export a Kekulé structure.');
  }
  const is3D = coords.some((c) => Math.abs(c[2]) > 1e-3);
  doc.bonds.forEach((bd, k) => {
    const s = bondStereo[k];
    if (bd.order === 1 && s === 1) bd.wedge = 'up';
    if (bd.order === 1 && s === 6) bd.wedge = 'down';
    if (bd.order === 1 && s === 4) bd.wedge = 'either';
    if (bd.order === 2 && s === 3) bd.stereoUnknown = true;
  });
  let result: MoleculeDocument;
  if (is3D) {
    const conf: Conformer = { id: 'import', coordinates: {}, method: 'imported coordinates' };
    doc.atoms.forEach((a, i) => (conf.coordinates[a.id] = coords[i]));
    result = stereoFromConformer(doc, conf);
    result.conformers = [conf];
    result.selectedConformerId = conf.id;
  } else {
    doc.atoms.forEach((a, i) => (doc.layout2d[a.id] = [coords[i][0], coords[i][1]]));
    const w = stereoFromWedges(doc);
    w.warnings.forEach((x) => warnings.push(x.message));
    result = doubleBondStereoFrom2D(w.doc);
  }
  return { doc: result, is3D, props, warnings };
}

export function parseSdf(text: string): ParsedMolfile[] {
  return text
    .split(/^\$\$\$\$\s*$/m)
    .map((s, i) => (i === 0 ? s : s.replace(/^\r?\n/, '')))
    .filter((s) => s.trim().length > 0)
    .map((s) => parseMolfile(s));
}
