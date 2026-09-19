import { perceiveAromaticity } from './aromaticity.ts';
import { mergeDocuments } from './builder.ts';
import { CipRanker, parityForDescriptor, perceiveStereo, stereoNeighbourList } from './cip.ts';
import { MolView } from './graph.ts';
import { permutationParity } from './smiles.ts';
import type { AtomId, BondId, BondOrder, Conformer, MoleculeDocument, StereoNeighbour, Vec2, Vec3 } from './types.ts';

/**
 * Graph edit commands. Every mutation of the canonical molecule goes through `applyCommand`,
 * which returns a new document plus human-readable events (for the provenance log and undo labels).
 */
export type EditCommand =
  | { type: 'addAtom'; element: string; at?: Vec2; at3d?: Vec3; bondTo?: { atomId: AtomId; order: BondOrder }; charge?: number }
  | { type: 'addBond'; a1: AtomId; a2: AtomId; order: BondOrder }
  | { type: 'removeAtoms'; atomIds: AtomId[] }
  | { type: 'removeBonds'; bondIds: BondId[] }
  | { type: 'setBondOrder'; bondId: BondId; order: BondOrder }
  | { type: 'setElement'; atomId: AtomId; element: string }
  | { type: 'setCharge'; atomId: AtomId; charge: number }
  | { type: 'setRadical'; atomId: AtomId; electrons: number }
  | { type: 'setIsotope'; atomId: AtomId; isotope?: number }
  | { type: 'setWedge'; bondId: BondId; from: AtomId; wedge: 'up' | 'down' | 'either' | null }
  | { type: 'setDescriptor'; atomId: AtomId; descriptor: 'R' | 'S' | null }
  | { type: 'setDoubleBondDescriptor'; bondId: BondId; descriptor: 'E' | 'Z' | null }
  | { type: 'invertCentres'; atomIds: AtomId[] }
  | { type: 'mirror' }
  | { type: 'moveAtoms2D'; positions: Record<AtomId, Vec2> }
  | { type: 'setLayout2D'; layout: Record<AtomId, Vec2> }
  | { type: 'addFragment'; fragment: MoleculeDocument; offset?: Vec2; fuse?: { existing: AtomId[]; fragment: AtomId[] }; bondFrom?: { atomId: AtomId; fragmentAtomId: AtomId; order: BondOrder } }
  | { type: 'replaceDocument'; doc: MoleculeDocument; label?: string }
  | { type: 'setTitle'; title: string }
  | { type: 'setConformer'; conformer: Conformer; select?: boolean };

export interface CommandResult {
  doc: MoleculeDocument;
  /** Short label for undo/redo and the provenance log. */
  label: string;
  /** Notes about side effects (stereo dropped, etc.). */
  notes: string[];
  /** Ids created by the command (new atoms first). */
  created: { atoms: AtomId[]; bonds: BondId[] };
  /** Whether graph identity (not just coordinates) may have changed. */
  identityChanged: boolean;
}

export class CommandError extends Error {}

function neighbourSet(view: MolView, i: number): StereoNeighbour[] | null {
  return stereoNeighbourList(view, i);
}

/** Keep stored stereo meaningful after an edit (substituent replaces H in place, etc.). */
function repairStereo(doc: MoleculeDocument, notes: string[]): void {
  const view = new MolView(doc);
  for (let i = 0; i < view.atomCount; i++) {
    const a = doc.atoms[i];
    if (!a.stereo) continue;
    const now = neighbourSet(view, i);
    if (!now) {
      delete a.stereo;
      notes.push(`${a.element} ${a.id} is no longer a stereocentre, so its configuration was cleared.`);
      continue;
    }
    const stored = a.stereo.order;
    const missing = stored.filter((x) => !now.includes(x));
    const added = now.filter((x) => !stored.includes(x));
    if (!missing.length && !added.length) continue;
    if (missing.length === 1 && added.length === 1) {
      a.stereo = { order: stored.map((x) => (x === missing[0] ? added[0] : x)), parity: a.stereo.parity };
      continue;
    }
    delete a.stereo;
    notes.push(`Configuration at ${a.element} ${a.id} was cleared because its neighbours changed.`);
  }
  doc.bonds.forEach((b) => {
    if (!b.stereo) return;
    if (b.order !== 2) {
      delete b.stereo;
      return;
    }
    const subs = (end: AtomId, other: AtomId) => doc.bonds.filter((x) => x !== b && (x.a1 === end || x.a2 === end)).map((x) => (x.a1 === end ? x.a2 : x.a1)).filter((x) => x !== other);
    const s1 = subs(b.a1, b.a2);
    const s2 = subs(b.a2, b.a1);
    let [r1, r2] = b.stereo.refs;
    let config = b.stereo.config;
    // refs may be stored relative to the other end after a bond flip
    if (!s1.includes(r1) && s2.includes(r1) && s1.includes(r2)) [r1, r2] = [r2, r1];
    if (!s1.includes(r1)) {
      if (s1.length === 1) {
        r1 = s1[0];
        config = config === 'cis' ? 'trans' : 'cis';
      } else {
        delete b.stereo;
        return;
      }
    }
    if (!s2.includes(r2)) {
      if (s2.length === 1) {
        r2 = s2[0];
        config = config === 'cis' ? 'trans' : 'cis';
      } else {
        delete b.stereo;
        return;
      }
    }
    b.stereo = { refs: [r1, r2], config };
  });
}

/** Aromaticity + stereo hygiene after any connectivity change. */
export function normalize(doc: MoleculeDocument, notes: string[] = []): MoleculeDocument {
  repairStereo(doc, notes);
  const withArom = perceiveAromaticity(doc);
  // Drop stereo on atoms that are no longer stereogenic (e.g. two identical substituents).
  const stereo = perceiveStereo(withArom);
  for (const id of stereo.staleCentres) {
    const a = withArom.atoms.find((x) => x.id === id);
    if (a?.stereo) {
      delete a.stereo;
      notes.push(`${a.element} ${a.id} is no longer a stereocentre, so its configuration was cleared.`);
    }
  }
  const stereoBondIds = new Set(stereo.bonds.map((b) => b.bondId));
  for (const b of withArom.bonds) if (b.stereo && !stereoBondIds.has(b.id)) delete b.stereo;
  delete withArom.canonicalSmiles;
  delete withArom.inchi;
  delete withArom.inchiKey;
  return withArom;
}

export function applyCommand(input: MoleculeDocument, cmd: EditCommand): CommandResult {
  let doc = structuredClone(input);
  const notes: string[] = [];
  const created = { atoms: [] as AtomId[], bonds: [] as BondId[] };
  let label = '';
  let identityChanged = true;
  const findAtom = (id: AtomId) => {
    const a = doc.atoms.find((x) => x.id === id);
    if (!a) throw new CommandError(`Atom ${id} does not exist`);
    return a;
  };
  const findBond = (id: BondId) => {
    const b = doc.bonds.find((x) => x.id === id);
    if (!b) throw new CommandError(`Bond ${id} does not exist`);
    return b;
  };
  const newAtom = (element: string, charge = 0) => {
    const id = `a${doc.nextAtom++}`;
    doc.atoms.push({ id, element, formalCharge: charge, aromatic: false });
    created.atoms.push(id);
    return id;
  };
  const newBond = (a1: AtomId, a2: AtomId, order: BondOrder) => {
    if (a1 === a2) throw new CommandError('An atom cannot bond to itself');
    if (doc.bonds.some((b) => (b.a1 === a1 && b.a2 === a2) || (b.a1 === a2 && b.a2 === a1))) throw new CommandError('These atoms are already bonded');
    const id = `b${doc.nextBond++}`;
    doc.bonds.push({ id, a1, a2, order, aromatic: false });
    created.bonds.push(id);
    return id;
  };

  switch (cmd.type) {
    case 'addAtom': {
      const id = newAtom(cmd.element, cmd.charge ?? 0);
      if (cmd.at) doc.layout2d[id] = cmd.at;
      if (cmd.bondTo) {
        findAtom(cmd.bondTo.atomId);
        newBond(cmd.bondTo.atomId, id, cmd.bondTo.order);
      }
      if (cmd.at3d && doc.selectedConformerId) {
        doc.conformers = doc.conformers.map((c) => (c.id === doc.selectedConformerId ? { ...c, coordinates: { ...c.coordinates, [id]: cmd.at3d! }, converged: false } : c));
      }
      label = `Add ${cmd.element}`;
      break;
    }
    case 'addBond': {
      findAtom(cmd.a1);
      findAtom(cmd.a2);
      newBond(cmd.a1, cmd.a2, cmd.order);
      label = 'Add bond';
      break;
    }
    case 'removeAtoms': {
      const set = new Set(cmd.atomIds);
      doc.atoms = doc.atoms.filter((a) => !set.has(a.id));
      doc.bonds = doc.bonds.filter((b) => !set.has(b.a1) && !set.has(b.a2));
      for (const id of set) delete doc.layout2d[id];
      doc.conformers = doc.conformers.map((c) => {
        const coords = { ...c.coordinates };
        for (const k of Object.keys(coords)) if (set.has(k) || set.has(k.split('.')[0])) delete coords[k];
        return { ...c, coordinates: coords };
      });
      label = cmd.atomIds.length === 1 ? 'Delete atom' : `Delete ${cmd.atomIds.length} atoms`;
      break;
    }
    case 'removeBonds': {
      const set = new Set(cmd.bondIds);
      doc.bonds = doc.bonds.filter((b) => !set.has(b.id));
      label = cmd.bondIds.length === 1 ? 'Delete bond' : `Delete ${cmd.bondIds.length} bonds`;
      break;
    }
    case 'setBondOrder': {
      const b = findBond(cmd.bondId);
      b.order = cmd.order;
      if (cmd.order !== 1) delete b.wedge;
      if (cmd.order !== 2) delete b.stereo;
      label = ['', 'Single bond', 'Double bond', 'Triple bond'][cmd.order];
      break;
    }
    case 'setElement': {
      const a = findAtom(cmd.atomId);
      a.element = cmd.element;
      delete a.explicitHydrogens;
      label = `Change to ${cmd.element}`;
      break;
    }
    case 'setCharge': {
      const a = findAtom(cmd.atomId);
      a.formalCharge = cmd.charge;
      delete a.explicitHydrogens;
      label = cmd.charge === 0 ? 'Neutralize' : `Set charge ${cmd.charge > 0 ? '+' : ''}${cmd.charge}`;
      break;
    }
    case 'setRadical': {
      const a = findAtom(cmd.atomId);
      if (cmd.electrons) a.radicalElectrons = cmd.electrons;
      else delete a.radicalElectrons;
      label = cmd.electrons ? 'Make radical' : 'Remove radical';
      break;
    }
    case 'setIsotope': {
      const a = findAtom(cmd.atomId);
      if (cmd.isotope) a.isotope = cmd.isotope;
      else delete a.isotope;
      label = 'Set isotope';
      break;
    }
    case 'setWedge': {
      const b = findBond(cmd.bondId);
      if (b.order !== 1) throw new CommandError('Only single bonds can be wedged or hashed');
      if (b.a1 !== cmd.from) {
        const t = b.a1;
        b.a1 = b.a2;
        b.a2 = t;
      }
      if (cmd.wedge) b.wedge = cmd.wedge;
      else delete b.wedge;
      label = cmd.wedge === 'up' ? 'Wedge bond' : cmd.wedge === 'down' ? 'Hashed bond' : cmd.wedge === 'either' ? 'Wavy bond' : 'Plain bond';
      break;
    }
    case 'setDescriptor': {
      const a = findAtom(cmd.atomId);
      const view = new MolView(doc);
      const i = view.idx(a.id);
      const nbrs = stereoNeighbourList(view, i);
      if (!nbrs) throw new CommandError('This atom is not a stereocentre');
      if (cmd.descriptor === null) {
        delete a.stereo;
        label = 'Clear configuration';
        break;
      }
      const cip = new CipRanker(view);
      const ranked = cip.rank(i, nbrs);
      if (ranked.ties) throw new CommandError('CIP rules 1–2 cannot rank these substituents, so R/S cannot be set here');
      a.stereo = { order: nbrs, parity: parityForDescriptor(nbrs, ranked.order as StereoNeighbour[], cmd.descriptor) };
      delete a.stereoUnknown;
      label = `Set ${cmd.descriptor}`;
      break;
    }
    case 'setDoubleBondDescriptor': {
      const b = findBond(cmd.bondId);
      if (cmd.descriptor === null) {
        delete b.stereo;
        label = 'Clear E/Z';
        break;
      }
      const perception = perceiveStereo(doc);
      const sb = perception.bonds.find((x) => x.bondId === b.id);
      if (!sb) throw new CommandError('This double bond cannot have E/Z isomers');
      const [h1, h2] = sb.high;
      const toRef = (h: StereoNeighbour, end: AtomId, other: AtomId): { ref: AtomId; flip: boolean } => {
        if (h !== 'H' && h !== 'LP') return { ref: h, flip: false };
        const alt = doc.bonds.filter((x) => x !== b && (x.a1 === end || x.a2 === end)).map((x) => (x.a1 === end ? x.a2 : x.a1)).find((x) => x !== other);
        if (!alt) throw new CommandError('Cannot express this configuration');
        return { ref: alt, flip: true };
      };
      const r1 = toRef(h1, b.a1, b.a2);
      const r2 = toRef(h2, b.a2, b.a1);
      let config: 'cis' | 'trans' = cmd.descriptor === 'Z' ? 'cis' : 'trans';
      if (r1.flip !== r2.flip) config = config === 'cis' ? 'trans' : 'cis';
      b.stereo = { refs: [r1.ref, r2.ref], config };
      delete b.stereoUnknown;
      label = `Set ${cmd.descriptor}`;
      break;
    }
    case 'invertCentres': {
      for (const id of cmd.atomIds) {
        const a = findAtom(id);
        if (a.stereo) a.stereo = { ...a.stereo, parity: a.stereo.parity === 'cw' ? 'ccw' : 'cw' };
      }
      label = cmd.atomIds.length === 1 ? 'Invert centre' : 'Invert centres';
      break;
    }
    case 'mirror': {
      for (const a of doc.atoms) if (a.stereo) a.stereo = { ...a.stereo, parity: a.stereo.parity === 'cw' ? 'ccw' : 'cw' };
      for (const [id, p] of Object.entries(doc.layout2d)) doc.layout2d[id] = [-p[0], p[1]];
      doc.conformers = doc.conformers.map((c) => {
        const coords: Record<string, Vec3> = {};
        for (const [k, p] of Object.entries(c.coordinates)) coords[k] = [-p[0], p[1], p[2]];
        return { ...c, coordinates: coords };
      });
      label = 'Mirror image';
      break;
    }
    case 'moveAtoms2D': {
      for (const [id, p] of Object.entries(cmd.positions)) {
        findAtom(id);
        doc.layout2d[id] = p;
      }
      label = 'Move';
      identityChanged = false;
      break;
    }
    case 'setLayout2D': {
      doc.layout2d = { ...doc.layout2d, ...cmd.layout };
      label = 'Clean up layout';
      identityChanged = false;
      break;
    }
    case 'addFragment': {
      const merged = mergeDocuments(doc, cmd.fragment, cmd.offset ?? [0, 0]);
      doc = merged.doc;
      for (const a of cmd.fragment.atoms) created.atoms.push(merged.idMap.get(a.id)!);
      if (cmd.fuse) {
        // Replace fragment atoms by existing atoms (fusion / spiro join).
        cmd.fuse.fragment.forEach((fid, k) => {
          const newId = merged.idMap.get(fid)!;
          const target = cmd.fuse!.existing[k];
          for (const b of doc.bonds) {
            if (b.a1 === newId) b.a1 = target;
            if (b.a2 === newId) b.a2 = target;
          }
          doc.atoms = doc.atoms.filter((a) => a.id !== newId);
          delete doc.layout2d[newId];
          created.atoms = created.atoms.filter((x) => x !== newId);
        });
        // Remove duplicate bonds created by fusion (keep the existing, higher-order one).
        const seen = new Map<string, number>();
        doc.bonds = doc.bonds.filter((b) => {
          const key = [b.a1, b.a2].sort().join('|');
          if (b.a1 === b.a2) return false;
          if (seen.has(key)) return false;
          seen.set(key, 1);
          return true;
        });
      }
      if (cmd.bondFrom) {
        newBond(cmd.bondFrom.atomId, merged.idMap.get(cmd.bondFrom.fragmentAtomId)!, cmd.bondFrom.order);
      }
      label = 'Add fragment';
      break;
    }
    case 'replaceDocument': {
      doc = structuredClone(cmd.doc);
      label = cmd.label ?? 'Replace molecule';
      break;
    }
    case 'setTitle': {
      doc.title = cmd.title;
      label = 'Rename';
      identityChanged = false;
      break;
    }
    case 'setConformer': {
      const others = doc.conformers.filter((c) => c.id !== cmd.conformer.id);
      doc.conformers = [...others, cmd.conformer];
      if (cmd.select !== false) doc.selectedConformerId = cmd.conformer.id;
      label = 'Update geometry';
      identityChanged = false;
      break;
    }
  }
  if (identityChanged) doc = normalize(doc, notes);
  const now = Date.now();
  doc.provenance = [...(doc.provenance ?? []).slice(-199), { at: now, kind: identityChanged ? 'edit' : 'conformer', detail: label }];
  return { doc, label, notes, created, identityChanged };
}

/** True when two stereo parities describe the same arrangement (after reordering). */
export function sameParity(o1: StereoNeighbour[], p1: 'cw' | 'ccw', o2: StereoNeighbour[], p2: 'cw' | 'ccw'): boolean {
  const p = permutationParity(o1, o2);
  if (p === null) return false;
  return (p === 0 ? p1 : p1 === 'cw' ? 'ccw' : 'cw') === p2;
}
