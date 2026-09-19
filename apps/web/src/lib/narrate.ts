'use client';
/**
 * Screen-reader narration (spec §15 "Accessibility"): what the student selected, what changed, and
 * what the molecule is — in words, never colour alone.
 */
import { MolView, element as elementInfo, neighbourIds, prettyFormula, type AtomId, type BondId, type MoleculeDocument } from '@orbital/chem';
import type { Analysis } from './types';

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const ORDER = ['', 'single', 'double', 'triple'];
const n = (k: number) => COUNT[k] ?? String(k);

export function elementName(symbol: string): string {
  return (elementInfo(symbol)?.name ?? symbol).toLowerCase();
}

function chargeWords(q: number): string {
  if (q === 0) return 'formal charge zero';
  return `formal charge ${q > 0 ? 'plus' : 'minus'} ${n(Math.abs(q))}`;
}

/** "Selected oxygen, atom 4, two single bonds, one hydrogen, formal charge zero". */
export function describeAtom(doc: MoleculeDocument, analysis: Analysis | null, id: AtomId): string {
  const v = new MolView(doc);
  const i = v.index.get(id);
  if (i === undefined) return '';
  const a = doc.atoms[i];
  const byOrder = [0, 0, 0, 0];
  for (const b of v.nbrBonds[i]) byOrder[doc.bonds[b].order]++;
  const bonds = [1, 2, 3].filter((o) => byOrder[o]).map((o) => `${n(byOrder[o])} ${ORDER[o]} bond${byOrder[o] > 1 ? 's' : ''}`);
  const h = v.implicitH(i);
  const parts = [`Selected ${elementName(a.element)}, atom ${i + 1}`, bonds.length ? bonds.join(', ') : 'no bonds', `${n(h)} hydrogen${h === 1 ? '' : 's'}`, chargeWords(a.formalCharge)];
  const centre = analysis?.stereo.centres.find((c) => c.atomId === id);
  if (centre) parts.push(centre.descriptor ? `stereocentre ${centre.descriptor}` : 'stereocentre, configuration not specified');
  const locant = analysis?.naming?.trace?.numbering.locantOf[id];
  if (locant) parts.push(`locant ${locant} in the name`);
  const group = analysis?.groups.find((g) => g.atomIds.includes(id));
  if (group) parts.push(`part of the ${group.label}`);
  return parts.join(', ') + '.';
}

export function describeBond(doc: MoleculeDocument, id: BondId): string {
  const v = new MolView(doc);
  const b = doc.bonds.find((x) => x.id === id);
  if (!b) return '';
  const i = v.index.get(b.a1)!;
  const j = v.index.get(b.a2)!;
  const kind = b.aromatic ? 'aromatic' : ORDER[b.order];
  const stereo = b.wedge ? (b.wedge === 'up' ? ', wedged toward you' : b.wedge === 'down' ? ', hashed away from you' : ', wavy') : '';
  return `Selected ${kind} bond between ${elementName(doc.atoms[i].element)} ${i + 1} and ${elementName(doc.atoms[j].element)} ${j + 1}${stereo}. Press 1, 2 or 3 to change its order.`;
}

/** "2-methylbutan-2-ol, C5H12O: a butane chain; methyl at 2; hydroxy at 2 (the suffix)". */
export function describeMolecule(doc: MoleculeDocument, analysis: Analysis | null, name?: string): string {
  if (!doc.atoms.length) return 'Empty canvas.';
  const parts: string[] = [];
  const nm = name ?? analysis?.naming?.name;
  const f = analysis?.formula;
  parts.push(`${nm ?? 'Unnamed molecule'}${f ? `, ${prettyFormula(f.counts, f.charge).replace(/[₀-₉]/g, (d) => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(d)))}` : ''}`);
  const t = analysis?.naming?.trace;
  if (t) {
    parts.push(`${t.parent.label}${t.parent.kind === 'ring' ? '' : ` (${t.parent.root})`}`);
    for (const s of t.substituents) parts.push(`${s.text} at ${s.locant}`);
    if (t.principalGroup.kind) {
      // Where the suffix group sits: its own locant, or that of the parent atom it hangs from.
      const loc = t.principalGroup.atomIds.map((id) => t.numbering.locantOf[id] ?? neighbourIds(doc, id).map((x) => t.numbering.locantOf[x]).find(Boolean)).find(Boolean);
      parts.push(`${t.principalGroup.label}${loc ? ` at ${loc}` : ''} as the suffix`);
    }
    for (const st of t.stereo) parts.push(`${st.descriptor}${st.locant ? ` at ${st.locant}` : ''}`);
  } else {
    parts.push(`${doc.atoms.length} heavy atom${doc.atoms.length === 1 ? '' : 's'}`);
  }
  return parts.join('; ') + '.';
}
