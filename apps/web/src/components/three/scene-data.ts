import { MolView, type AtomId, type MoleculeDocument, type Vec3 } from '@orbital/chem';
import { element } from '@orbital/chem';
import type { RenderStyle } from '@/lib/store';

export interface RAtom {
  key: string; // atom id or '<id>.h<k>'
  atomId: AtomId; // heavy atom id (for H: parent)
  isH: boolean;
  element: string;
  radius: number;
}

export interface RBond {
  key: string;
  a: string;
  b: string;
  order: number;
  bondId?: string;
  /** Neighbour key used to orient multiple-bond offsets. */
  planeRef?: string;
}

const KIT_RADIUS: Record<string, number> = { H: 0.2, C: 0.32, N: 0.31, O: 0.3, F: 0.27, Cl: 0.36, Br: 0.4, I: 0.45, S: 0.38, P: 0.38 };

export function atomRadius(el: string, style: RenderStyle): number {
  if (style === 'spacefill') {
    try {
      return element(el).vdwRadius;
    } catch {
      return 1.8;
    }
  }
  if (style === 'licorice') return el === 'H' ? 0.09 : 0.13;
  return KIT_RADIUS[el] ?? 0.4;
}

export function buildScene(doc: MoleculeDocument, style: RenderStyle, showH: boolean): { atoms: RAtom[]; bonds: RBond[] } {
  const view = new MolView(doc);
  const atoms: RAtom[] = [];
  const bonds: RBond[] = [];
  doc.atoms.forEach((a, i) => {
    atoms.push({ key: a.id, atomId: a.id, isH: a.element === 'H', element: a.element, radius: atomRadius(a.element, style) });
    if (showH) {
      const h = view.implicitH(i);
      for (let k = 1; k <= h; k++) {
        const key = `${a.id}.h${k}`;
        atoms.push({ key, atomId: a.id, isH: true, element: 'H', radius: atomRadius('H', style) });
        bonds.push({ key: `${a.id}~h${k}`, a: a.id, b: key, order: 1 });
      }
    }
  });
  for (const b of doc.bonds) {
    const i = view.idx(b.a1);
    const j = view.idx(b.a2);
    let planeRef: string | undefined;
    if (b.order > 1) {
      const nb = view.nbrs[i].find((x) => x !== j) ?? view.nbrs[j].find((x) => x !== i);
      if (nb !== undefined) planeRef = doc.atoms[nb].id;
      else if (view.implicitH(i) > 0) planeRef = `${b.a1}.h1`;
      else if (view.implicitH(j) > 0) planeRef = `${b.a2}.h1`;
    }
    bonds.push({ key: b.id, a: b.a1, b: b.a2, order: b.order, bondId: b.id, planeRef });
  }
  return { atoms, bonds };
}

export function boundingSphere(coords: Record<string, Vec3>): { center: Vec3; radius: number } {
  const keys = Object.keys(coords);
  if (!keys.length) return { center: [0, 0, 0], radius: 3 };
  let c: Vec3 = [0, 0, 0];
  for (const k of keys) c = [c[0] + coords[k][0], c[1] + coords[k][1], c[2] + coords[k][2]];
  c = [c[0] / keys.length, c[1] / keys.length, c[2] / keys.length];
  let r = 0;
  for (const k of keys) r = Math.max(r, Math.hypot(coords[k][0] - c[0], coords[k][1] - c[1], coords[k][2] - c[2]));
  return { center: c, radius: Math.max(r + 1.2, 2.5) };
}
