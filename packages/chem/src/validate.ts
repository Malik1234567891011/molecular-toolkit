import type { EditCommand } from './commands.ts';
import { perceiveStereo } from './cip.ts';
import { allowedValences, COURSE_SCOPE_ELEMENTS, element } from './elements.ts';
import { MolView, valenceState } from './graph.ts';
import { perceiveRings } from './rings.ts';
import type { AtomId, BondId, MoleculeDocument } from './types.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationFix {
  label: string;
  command: EditCommand;
}

export interface ValidationIssue {
  severity: Severity;
  code: 'overvalent' | 'hypervalent' | 'radical' | 'fragments' | 'unspecified-stereo' | 'outside-scope' | 'ring-strain' | 'unusual-charge' | 'empty' | 'isolated-atom';
  atomIds: AtomId[];
  bondIds?: BondId[];
  title: string;
  message: string;
  fixes: ValidationFix[];
}

const CHARGE_WORD = (q: number) => (q === 0 ? 'Neutral' : q > 0 ? (q === 1 ? 'Positively charged' : `+${q}`) : q === -1 ? 'Negatively charged' : `${q}`);

function ionName(el: string, q: number): string | null {
  if (el === 'O' && q === 1) return 'an oxonium ion';
  if (el === 'N' && q === 1) return 'an ammonium ion';
  if (el === 'C' && q === 1) return 'a carbocation';
  if (el === 'C' && q === -1) return 'a carbanion';
  if (el === 'O' && q === -1) return 'an alkoxide';
  if (el === 'S' && q === 1) return 'a sulfonium ion';
  if (el === 'N' && q === -1) return 'an amide anion';
  return null;
}

/**
 * Teaching copy for an atom that would exceed its valence (spec §7 invalid-action behaviour).
 * `used` is the bond-order sum the author is attempting.
 */
export function explainValence(el: string, charge: number, used: number): { title: string; message: string } {
  const e = element(el);
  const allowed = allowedValences(el, charge);
  const typical = allowed?.[0] ?? 0;
  const name = e.name;
  const Name = name[0].toUpperCase() + name.slice(1);
  const qWord = CHARGE_WORD(charge);
  if (el === 'C' && charge === 0) {
    return {
      title: 'Carbon already has four bonds',
      message: 'Neutral carbon already has four bonds here — it has four valence electrons to share and no low-lying d orbitals, so a fifth bond isn\'t possible. Replace a bond, add the group to a neighbour, or remove an atom.',
    };
  }
  // A charge is only offered when it genuinely makes the attempted structure valid (spec §7:
  // never suggest a charge merely to force an arbitrary structure).
  if (el === 'O' && charge === 0) {
    return {
      title: 'Oxygen already has two bonds',
      message: used === 3
        ? 'Neutral oxygen already has its typical two bonds and two lone pairs. Replace a bond, remove an atom, or explicitly make it O⁺ — an oxonium ion, where oxygen shares one lone pair to form a third bond (as in H₃O⁺ or a protonated alcohol).'
        : `Neutral oxygen forms two bonds and keeps two lone pairs. Even as O⁺ (an oxonium ion) it forms only three, so ${used} bonds to oxygen isn't possible. Remove bonds, or put oxygen somewhere with fewer neighbours.`,
    };
  }
  if (el === 'N' && charge === 0) {
    return {
      title: 'Nitrogen already has three bonds',
      message: used === 4
        ? 'Neutral nitrogen forms three bonds and keeps one lone pair. A fourth bond would use that lone pair, which makes it an ammonium nitrogen (N⁺). Remove a bond, or make it N⁺ if you mean an ammonium ion.'
        : `Neutral nitrogen forms three bonds and keeps one lone pair; even as N⁺ (ammonium) it forms only four, so ${used} bonds to nitrogen isn't possible. Remove bonds or choose a different atom.`,
    };
  }
  if (el === 'H') {
    return { title: 'Hydrogen forms one bond', message: 'Hydrogen has only a 1s orbital to share, so it forms exactly one bond.' };
  }
  if (['F', 'Cl', 'Br', 'I'].includes(el) && charge === 0) {
    return {
      title: `${Name} forms one bond here`,
      message: `In organic molecules neutral ${name} forms a single bond; its other three electron pairs are lone pairs. Remove a bond or attach the group to a different atom.`,
    };
  }
  const ion = ionName(el, charge);
  return {
    title: `${Name} is over its bond limit`,
    message: `${qWord} ${name}${ion ? ` (${ion})` : ''} typically forms ${typical} bond${typical === 1 ? '' : 's'}; this would give it ${used}. Remove or change a bond, or reconsider the charge.`,
  };
}

export function validateDocument(doc: MoleculeDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const view = new MolView(doc);
  if (!doc.atoms.length) {
    return [{ severity: 'info', code: 'empty', atomIds: [], title: 'Empty canvas', message: 'Try typing caffeine, or draw a hexagon.', fixes: [] }];
  }
  for (let i = 0; i < view.atomCount; i++) {
    const a = doc.atoms[i];
    const st = valenceState(view, i);
    if (st.overValent) {
      const { title, message } = explainValence(a.element, a.formalCharge, st.used);
      const fixes: ValidationFix[] = [];
      // Highest-order bond can be reduced.
      const multi = view.nbrBonds[i].map((bi) => doc.bonds[bi]).filter((b) => b.order > 1).sort((x, y) => y.order - x.order)[0];
      if (multi) fixes.push({ label: `Make that bond ${multi.order === 3 ? 'double' : 'single'}`, command: { type: 'setBondOrder', bondId: multi.id, order: (multi.order - 1) as 1 | 2 } });
      const last = doc.bonds.filter((b) => b.a1 === a.id || b.a2 === a.id).at(-1);
      if (last) fixes.push({ label: 'Remove the newest bond', command: { type: 'removeBonds', bondIds: [last.id] } });
      if (a.element === 'N' && a.formalCharge === 0 && st.used === 4) fixes.push({ label: 'Make it N⁺ (ammonium)', command: { type: 'setCharge', atomId: a.id, charge: 1 } });
      if (a.element === 'O' && a.formalCharge === 0 && st.used === 3) fixes.push({ label: 'Make it O⁺ (oxonium)', command: { type: 'setCharge', atomId: a.id, charge: 1 } });
      issues.push({ severity: 'error', code: 'overvalent', atomIds: [a.id], title, message, fixes });
    } else if (st.hypervalent && (a.element === 'S' || a.element === 'P' || a.element === 'Se')) {
      issues.push({
        severity: 'info',
        code: 'hypervalent',
        atomIds: [a.id],
        title: `${element(a.element).name[0].toUpperCase()}${element(a.element).name.slice(1)} drawn with an expanded octet`,
        message: `This ${element(a.element).name} is drawn with ${st.used} bonds — the conventional way to draw sulfoxides, sulfones, phosphates and similar groups. Modern bonding models describe these with charge separation rather than d-orbital participation. It is allowed.`,
        fixes: [],
      });
    }
    if (a.radicalElectrons) {
      issues.push({ severity: 'info', code: 'radical', atomIds: [a.id], title: 'Radical', message: `This ${element(a.element).name} carries ${a.radicalElectrons === 1 ? 'an unpaired electron' : 'two unpaired electrons'}.`, fixes: [{ label: 'Remove the unpaired electron', command: { type: 'setRadical', atomId: a.id, electrons: 0 } }] });
    }
    if (Math.abs(a.formalCharge) > 1 && ['C', 'N', 'O'].includes(a.element)) {
      issues.push({ severity: 'warning', code: 'unusual-charge', atomIds: [a.id], title: 'Unusual charge', message: `A formal charge of ${a.formalCharge} on ${element(a.element).name} is very unusual in organic chemistry.`, fixes: [{ label: 'Neutralize', command: { type: 'setCharge', atomId: a.id, charge: 0 } }] });
    }
    if (!COURSE_SCOPE_ELEMENTS.has(a.element)) {
      issues.push({ severity: 'info', code: 'outside-scope', atomIds: [a.id], title: 'Outside verified course scope', message: `${element(a.element).name[0].toUpperCase()}${element(a.element).name.slice(1)} can be displayed, but naming and explanations for it are outside the verified course scope.`, fixes: [] });
    }
  }
  const comps = view.components();
  if (comps.length > 1) {
    issues.push({ severity: 'info', code: 'fragments', atomIds: [], title: `${comps.length} separate species`, message: `The canvas holds ${comps.length} disconnected species (for example a salt, or a molecule you have not finished). Each one is named separately.`, fixes: [] });
  }
  const rings = perceiveRings(view);
  for (const r of rings.rings) {
    if (r.atoms.length <= 4) {
      issues.push({
        severity: 'warning',
        code: 'ring-strain',
        atomIds: r.atoms.map((x) => doc.atoms[x].id),
        title: `${r.atoms.length === 3 ? 'Three' : 'Four'}-membered ring: strained`,
        message: r.atoms.length === 3
          ? 'Ring bond angles are forced to about 60° instead of the tetrahedral 109.5°, so this ring stores a lot of strain energy (≈115 kJ/mol for cyclopropane).'
          : 'Ring bond angles are near 90° instead of 109.5°, so this ring is strained (≈110 kJ/mol for cyclobutane).',
        fixes: [],
      });
    }
  }
  const stereo = perceiveStereo(doc, rings);
  const unspecified = stereo.centres.filter((c) => !c.specified && !c.needsHigherRules).map((c) => c.atomId);
  const unspecifiedBonds = stereo.bonds.filter((b) => !b.specified).map((b) => b.bondId);
  if (unspecified.length || unspecifiedBonds.length) {
    const parts: string[] = [];
    if (unspecified.length) parts.push(`${unspecified.length} stereocentre${unspecified.length > 1 ? 's' : ''}`);
    if (unspecifiedBonds.length) parts.push(`${unspecifiedBonds.length} stereogenic double bond${unspecifiedBonds.length > 1 ? 's' : ''}`);
    issues.push({
      severity: 'info',
      code: 'unspecified-stereo',
      atomIds: unspecified,
      bondIds: unspecifiedBonds,
      title: 'Stereochemistry not specified',
      message: `This structure has ${parts.join(' and ')} with no configuration chosen, so it stands for every stereoisomer. Choose R/S or E/Z to name one specific isomer.`,
      fixes: [],
    });
  }
  return issues;
}

/** Would adding `extraOrder` bond order to atom `atomId` exceed its allowed valence? */
export function wouldExceedValence(doc: MoleculeDocument, atomId: AtomId, extraOrder: number): { exceeds: boolean; hypervalentOnly: boolean; title: string; message: string } {
  const view = new MolView(doc);
  const i = view.idx(atomId);
  const a = doc.atoms[i];
  const allowed = allowedValences(a.element, a.formalCharge);
  if (!allowed) return { exceeds: false, hypervalentOnly: false, title: '', message: '' };
  const used = view.bondOrderSum(i) + (a.radicalElectrons ?? 0) + (a.explicitHydrogens ?? 0) + extraOrder;
  const max = Math.max(...allowed);
  const typical = allowed[0];
  const { title, message } = explainValence(a.element, a.formalCharge, used);
  return { exceeds: used > max, hypervalentOnly: used > typical && used <= max, title, message };
}
