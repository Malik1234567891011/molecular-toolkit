import { element, isotopeMass } from './elements.ts';
import { MolView } from './graph.ts';
import { perceiveRings } from './rings.ts';
import type { MoleculeDocument } from './types.ts';

export interface FormulaInfo {
  /** Hill-order formula without charge, e.g. "C2H6O". */
  formula: string;
  /** Element counts. */
  counts: Record<string, number>;
  charge: number;
  /** Average molar mass (g/mol). */
  molarMass: number;
  /** Monoisotopic mass (Da). */
  exactMass: number;
  /** Rings + π bonds, counted on the graph. */
  degreeOfUnsaturation: number;
  heavyAtoms: number;
  fragments: number;
}

export function hillOrder(counts: Record<string, number>): string[] {
  const els = Object.keys(counts).filter((e) => counts[e] > 0);
  if (els.includes('C')) {
    const rest = els.filter((e) => e !== 'C' && e !== 'H').sort();
    return ['C', ...(els.includes('H') ? ['H'] : []), ...rest];
  }
  return els.sort();
}

export function formulaString(counts: Record<string, number>, charge = 0): string {
  let s = hillOrder(counts).map((e) => e + (counts[e] > 1 ? counts[e] : '')).join('');
  if (charge) s += (Math.abs(charge) > 1 ? Math.abs(charge) : '') + (charge > 0 ? '+' : '-');
  return s;
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
export function prettyFormula(counts: Record<string, number>, charge = 0): string {
  let s = hillOrder(counts)
    .map((e) => e + (counts[e] > 1 ? String(counts[e]).replace(/\d/g, (d) => SUB[+d]) : ''))
    .join('');
  if (charge) {
    const sup = '⁰¹²³⁴⁵⁶⁷⁸⁹';
    s += (Math.abs(charge) > 1 ? String(Math.abs(charge)).replace(/\d/g, (d) => sup[+d]) : '') + (charge > 0 ? '⁺' : '⁻');
  }
  return s;
}

export function computeFormula(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>): FormulaInfo {
  const view = new MolView(doc);
  const counts: Record<string, number> = {};
  let charge = 0;
  let molarMass = 0;
  let exactMass = 0;
  let heavy = 0;
  const hMass = element('H').mass;
  const hExact = isotopeMass('H');
  doc.atoms.forEach((a, i) => {
    counts[a.element] = (counts[a.element] ?? 0) + 1;
    charge += a.formalCharge;
    const e = element(a.element);
    molarMass += a.isotope ? isotopeMass(a.element, a.isotope) : e.mass;
    exactMass += isotopeMass(a.element, a.isotope);
    if (a.element !== 'H') heavy++;
    const h = view.implicitH(i);
    if (h) {
      counts.H = (counts.H ?? 0) + h;
      molarMass += h * hMass;
      exactMass += h * hExact;
    }
  });
  // Electron mass correction for ions (5.486e-4 Da per electron).
  exactMass -= charge * 0.000548579909;
  const rings = perceiveRings(view);
  let pi = 0;
  for (const b of doc.bonds) pi += b.order - 1;
  return {
    formula: formulaString(counts),
    counts,
    charge,
    molarMass,
    exactMass,
    degreeOfUnsaturation: rings.rings.length + pi,
    heavyAtoms: heavy,
    fragments: view.components().length,
  };
}
