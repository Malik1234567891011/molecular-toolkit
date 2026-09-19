/**
 * Most acidic proton (spec §14 "pKa/acidity visualization"). A textbook-table classifier, not a
 * predictor: each kind of acidic H gets an approximate aqueous pKa and the reason its conjugate
 * base is (or isn't) stabilized. Values are the ones course tables use.
 */
import { MolView } from './graph.ts';
import type { AtomId, MoleculeDocument } from './types.ts';

export interface AcidSite {
  atomId: AtomId;
  element: string;
  pKa: number;
  kind: string;
  reason: string;
}

const HALOGEN = new Set(['F', 'Cl', 'Br', 'I']);

export function acidSites(doc: Pick<MoleculeDocument, 'atoms' | 'bonds'>): AcidSite[] {
  const v = new MolView(doc);
  const n = doc.atoms.length;
  const el = (i: number) => doc.atoms[i].element;
  const order = (i: number, j: number) => {
    const b = v.bondBetween(i, j);
    return b < 0 ? 0 : v.bonds[b].order;
  };
  const isCarbonyl = (c: number) => el(c) === 'C' && v.nbrs[c].some((o) => el(o) === 'O' && order(c, o) === 2);
  const aromatic = (i: number) => doc.atoms[i].aromatic;
  const hasNitroOnRing = (i: number) => {
    const ring = new Set<number>([i]);
    const stack = [i];
    while (stack.length) {
      const x = stack.pop()!;
      for (const y of v.nbrs[x]) if (aromatic(y) && !ring.has(y)) {
        ring.add(y);
        stack.push(y);
      }
    }
    return [...ring].some((r) => v.nbrs[r].some((y) => el(y) === 'N' && doc.atoms[y].formalCharge === 1 && v.nbrs[y].filter((o) => el(o) === 'O').length === 2));
  };
  const sites: AcidSite[] = [];
  const add = (i: number, pKa: number, kind: string, reason: string) => sites.push({ atomId: doc.atoms[i].id, element: el(i), pKa, kind, reason });
  for (let i = 0; i < n; i++) {
    if (v.totalH(i) === 0) continue;
    const e = el(i);
    const q = doc.atoms[i].formalCharge;
    const nb = v.nbrs[i].filter((j) => el(j) !== 'H');
    if (HALOGEN.has(e) && nb.length === 0) {
      add(i, e === 'F' ? 3.2 : e === 'Cl' ? -7 : e === 'Br' ? -9 : -10, `hydrogen ${e === 'F' ? 'fluoride' : e === 'Cl' ? 'chloride' : e === 'Br' ? 'bromide' : 'iodide'}`, e === 'F' ? 'HF is weak because the small F⁻ holds its charge tightly and the H–F bond is very strong.' : `The large ${e}⁻ ion spreads its charge over a big volume — a very stable conjugate base.`);
      continue;
    }
    if (e === 'O') {
      if (q === 1) {
        add(i, -2, 'oxonium ion', 'A positively charged oxygen gives up H⁺ very easily — the conjugate base is a neutral molecule.');
        continue;
      }
      if (nb.length === 0) {
        add(i, 15.7, 'water', 'Hydroxide’s charge sits on one oxygen with no delocalization.');
        continue;
      }
      const c = nb[0];
      if (isCarbonyl(c)) {
        const alpha = v.nbrs[c].filter((x) => el(x) === 'C' && x !== i);
        const pulls = alpha.reduce((s, a) => s + v.nbrs[a].filter((h) => HALOGEN.has(el(h))).length, 0);
        const fluoro = alpha.reduce((s, a) => s + v.nbrs[a].filter((h) => el(h) === 'F').length, 0);
        const pKa = Math.max(0.2, 4.8 - fluoro * 1.5 - (pulls - fluoro) * 1.9);
        add(i, Number(pKa.toFixed(1)), 'carboxylic acid', `The carboxylate’s negative charge is shared equally by two oxygens (resonance)${pulls ? '; nearby halogens pull electron density away (induction), lowering the pKa further' : ''}.`);
      } else if (aromatic(c)) {
        const nitro = hasNitroOnRing(c);
        add(i, nitro ? 7.2 : 10, 'phenol', `The phenoxide’s charge delocalizes into the aromatic ring${nitro ? ' and onto the nitro group' : ''}.`);
      } else if (v.nbrs[c].some((x) => el(x) === 'C' && order(c, x) === 2)) {
        add(i, 11, 'enol', 'The enolate charge is shared between oxygen and carbon (resonance).');
      } else {
        const subs = v.nbrs[c].filter((x) => el(x) === 'C').length;
        add(i, subs >= 3 ? 18 : subs === 0 ? 15.5 : 16, 'alcohol', 'The alkoxide’s charge sits on one oxygen with no resonance; alkyl groups slightly destabilize it.');
      }
      continue;
    }
    if (e === 'S') {
      add(i, nb.some((c) => aromatic(c)) ? 6.6 : 10.5, 'thiol', 'Sulfur is large: the thiolate’s charge is spread over a big, polarizable atom — more acidic than the matching alcohol.');
      continue;
    }
    if (e === 'N') {
      if (q === 1) {
        const arom = aromatic(i) || nb.some((c) => aromatic(c));
        add(i, aromatic(i) ? 5.2 : arom ? 4.6 : 10.6, aromatic(i) ? 'pyridinium ion' : arom ? 'anilinium ion' : 'ammonium ion', 'A positively charged nitrogen loses H⁺ to give a neutral amine.');
      } else if (nb.some((c) => isCarbonyl(c))) {
        add(i, 17, 'amide N–H', 'The amide anion is stabilized by resonance with the C=O, but nitrogen holds negative charge less well than oxygen.');
      } else {
        add(i, 38, 'amine N–H', 'Nitrogen is less electronegative than oxygen, so the amide ion (R₂N⁻) is a very strong base.');
      }
      continue;
    }
    if (e === 'C') {
      const triple = v.nbrs[i].some((j) => order(i, j) === 3);
      if (triple) {
        add(i, 25, 'terminal alkyne C–H', 'An sp carbon has 50% s character: the acetylide’s lone pair is held close to the nucleus.');
        continue;
      }
      const carbonyls = nb.filter((c) => isCarbonyl(c));
      const nitrile = nb.some((c) => el(c) === 'C' && v.nbrs[c].some((x) => el(x) === 'N' && order(c, x) === 3));
      const nitro = nb.some((x) => el(x) === 'N' && doc.atoms[x].formalCharge === 1 && v.nbrs[x].filter((o) => el(o) === 'O').length === 2);
      if (carbonyls.length >= 2) {
        add(i, 9, 'α-H between two C=O', 'The enolate charge delocalizes onto both carbonyl oxygens.');
      } else if (nitro) {
        add(i, 10, 'α-H to a nitro group', 'The nitronate charge delocalizes onto the nitro oxygens.');
      } else if (carbonyls.length === 1) {
        const c = carbonyls[0];
        const ester = v.nbrs[c].some((x) => el(x) === 'O' && order(c, x) === 1);
        const aldehyde = v.totalH(c) > 0;
        add(i, ester ? 25 : aldehyde ? 17 : 19.5, `α-H to ${ester ? 'an ester' : aldehyde ? 'an aldehyde' : 'a ketone'}`, 'Removing it gives an enolate: the charge spreads onto the carbonyl oxygen.');
      } else if (nitrile) {
        add(i, 25, 'α-H to a nitrile', 'The anion is stabilized by resonance with the C≡N.');
      } else if (aromatic(i)) {
        add(i, 43, 'aromatic C–H', 'The aryl anion’s lone pair is in an sp² orbital, not delocalized in the ring.');
      } else if (nb.some((c) => aromatic(c) && el(c) === 'C')) {
        add(i, 41, 'benzylic C–H', 'The benzylic anion delocalizes into the ring, but carbon holds charge poorly.');
      } else if (v.nbrs[i].some((j) => order(i, j) === 2 && el(j) === 'O')) {
        add(i, 40, 'aldehyde (formyl) C–H', 'Not acidic: the acyl anion’s lone pair sits in an sp² orbital in the molecular plane, at right angles to the C=O π bond, so the carbonyl cannot spread the charge. In aldehydes the acidic hydrogens are the α-H’s, when there are any.');
      } else if (v.nbrs[i].some((j) => order(i, j) === 2)) {
        add(i, 44, 'vinylic C–H', 'An sp² carbanion, not delocalized.');
      } else if (nb.some((c) => v.nbrs[c].some((x) => x !== i && order(c, x) === 2 && el(x) === 'C'))) {
        add(i, 43, 'allylic C–H', 'The allyl anion is resonance-stabilized, but carbon holds charge poorly.');
      } else {
        add(i, 50, 'alkane C–H', 'An sp³ carbanion has no stabilization at all.');
      }
    }
  }
  sites.sort((a, b) => a.pKa - b.pKa);
  return sites;
}
