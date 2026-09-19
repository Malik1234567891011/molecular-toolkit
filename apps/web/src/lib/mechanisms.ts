/**
 * Curated mechanism library (spec §12 "Mechanisms"): human-authored electron-pushing arrows.
 * The tutor may narrate these, never invent them. Atoms are addressed by SMILES atom-map
 * numbers so arrows stay attached to the right atoms whatever the layout.
 */

/** Where electrons come from: a lone pair on an atom, or an existing bond. */
export type ArrowFrom = { lp: number } | { bond: [number, number] };
/** Where they go: onto an atom (new lone pair / new bond to it) or into a bond position. */
export type ArrowTo = { atom: number } | { bond: [number, number] };

export interface Arrow {
  from: ArrowFrom;
  to: ArrowTo;
  /** +1 bows upward (default), −1 downward. */
  bend?: 1 | -1;
}

export interface Species {
  smiles: string;
  /** Optional hand layout (map number → [x, y], y up) when the automatic 2D layout reads poorly. */
  coords?: Record<number, [number, number]>;
  label?: string;
}

export interface MechStep {
  title: string;
  caption: string;
  species: Species[];
  arrows: Arrow[];
  /** Partial bonds to show dashed (transition states). */
  partial?: Array<[number, number]>;
}

export interface Mechanism {
  id: 'sn2' | 'sn1' | 'e2' | 'e1' | 'hbr-addition' | 'carbonyl-addition' | 'diels-alder' | 'eas-bromination' | 'acid-base';
  title: string;
  summary: string;
  overall: string;
  rate?: string;
  steps: MechStep[];
  has3d?: boolean;
}

const HEX = (r: number, deg: number, dx = 0): [number, number] => [dx + r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];

export const MECHANISMS: Mechanism[] = [
  {
    id: 'sn2',
    title: 'SN2 — bimolecular substitution',
    summary: 'Backside attack in one concerted step; the carbon inverts like an umbrella in the wind.',
    overall: 'CH₃CH₂Br + HO⁻ → CH₃CH₂OH + Br⁻',
    rate: 'rate = k[substrate][nucleophile]',
    has3d: true,
    steps: [
      {
        title: 'Backside attack',
        caption: 'Hydroxide’s lone pair attacks the carbon from the side opposite bromine (180°). As the new C–O bond forms, the C–Br electrons leave with bromide — making and breaking happen together.',
        species: [
          { smiles: '[OH-:1]', coords: { 1: [-2.6, -0.1] } },
          { smiles: '[CH3:5][CH2:2][Br:3]', coords: { 5: [-0.55, 1.05], 2: [0, 0], 3: [1.55, 0] } },
        ],
        arrows: [{ from: { lp: 1 }, to: { atom: 2 } }, { from: { bond: [2, 3] }, to: { atom: 3 } }],
      },
      {
        title: 'Products',
        caption: 'No intermediate is formed. The three groups on carbon flip to the other side (Walden inversion): a stereocentre that reacts by SN2 comes out with the opposite configuration.',
        species: [{ smiles: '[OH:1][CH2:2][CH3:5]' }, { smiles: '[Br-:3]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'sn1',
    title: 'SN1 — unimolecular substitution',
    summary: 'Slow ionization to a flat carbocation, then fast capture by the nucleophile from either face.',
    overall: '(CH₃)₃CBr + 2 H₂O → (CH₃)₃COH + H₃O⁺ + Br⁻',
    rate: 'rate = k[substrate]',
    steps: [
      {
        title: 'Ionization (slow)',
        caption: 'The C–Br bond breaks heterolytically: both electrons leave with bromide. The tertiary carbocation is stabilized by its three alkyl groups. This step alone sets the rate.',
        species: [{ smiles: '[CH3:5][C:1]([CH3:6])([CH3:7])[Br:2]' }],
        arrows: [{ from: { bond: [1, 2] }, to: { atom: 2 } }],
      },
      {
        title: 'Nucleophilic capture',
        caption: 'Water attacks the planar carbocation. It can approach either face, so a stereocentre here would come out racemized.',
        species: [{ smiles: '[CH3:5][C+:1]([CH3:6])[CH3:7]' }, { smiles: '[OH2:3]' }, { smiles: '[Br-:2]' }],
        arrows: [{ from: { lp: 3 }, to: { atom: 1 } }],
      },
      {
        title: 'Deprotonation',
        caption: 'A second water removes a proton from the oxonium ion; the O–H electrons stay on oxygen.',
        species: [{ smiles: '[CH3:5][C:1]([CH3:6])([CH3:7])[OH+:3][H:4]' }, { smiles: '[OH2:8]' }],
        arrows: [{ from: { lp: 8 }, to: { atom: 4 } }, { from: { bond: [3, 4] }, to: { atom: 3 } }],
      },
      {
        title: 'Products',
        caption: '2-Methylpropan-2-ol and hydronium. Polar protic solvents and tertiary substrates favour SN1.',
        species: [{ smiles: '[CH3:5][C:1]([CH3:6])([CH3:7])[OH:3]' }, { smiles: '[H:4][OH2+:8]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'e2',
    title: 'E2 — bimolecular elimination',
    summary: 'A strong base removes a β-hydrogen as the leaving group departs, all in one step.',
    overall: '(CH₃)₂CHBr + CH₃CH₂O⁻ → CH₂=CHCH₃ + CH₃CH₂OH + Br⁻',
    rate: 'rate = k[substrate][base]',
    steps: [
      {
        title: 'Concerted elimination',
        caption: 'Ethoxide takes a β-hydrogen; those C–H electrons become the new π bond; bromide leaves with the C–Br electrons. The H and Br must be anti-periplanar (180° dihedral).',
        species: [
          { smiles: '[CH3:8][CH2:9][O-:1]', coords: { 8: [-4.6, 1.5], 9: [-3.7, 0.8], 1: [-2.7, 0.8] } },
          { smiles: '[H:2][CH2:3][CH:4]([CH3:6])[Br:5]', coords: { 2: [-1.35, 0.8], 3: [0, 0.8], 4: [1.3, 0], 6: [2.6, 0.8], 5: [1.3, -1.35] } },
        ],
        arrows: [{ from: { lp: 1 }, to: { atom: 2 } }, { from: { bond: [2, 3] }, to: { bond: [3, 4] } }, { from: { bond: [4, 5] }, to: { atom: 5 }, bend: -1 }],
      },
      {
        title: 'Products',
        caption: 'Propene, ethanol and bromide. Bulky bases favour the less substituted alkene (Hofmann); small bases the more substituted one (Zaitsev).',
        species: [{ smiles: '[CH2:3]=[CH:4][CH3:6]' }, { smiles: '[CH3:8][CH2:9][O:1][H:2]' }, { smiles: '[Br-:5]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'e1',
    title: 'E1 — unimolecular elimination',
    summary: 'Ionization to a carbocation, then a weak base removes a β-hydrogen.',
    overall: '(CH₃)₃CBr → (CH₃)₂C=CH₂ + HBr (via H₂O)',
    rate: 'rate = k[substrate]',
    steps: [
      {
        title: 'Ionization (slow)',
        caption: 'As in SN1, the leaving group departs first, giving a carbocation.',
        species: [{ smiles: '[H:3][CH2:7][C:1]([CH3:5])([CH3:6])[Br:2]' }],
        arrows: [{ from: { bond: [1, 2] }, to: { atom: 2 } }],
      },
      {
        title: 'Loss of a β-proton',
        caption: 'Water (a weak base) removes a hydrogen on the carbon next to C⁺; the C–H electrons form the π bond.',
        species: [{ smiles: '[H:3][CH2:7][C+:1]([CH3:5])[CH3:6]' }, { smiles: '[OH2:8]' }],
        arrows: [{ from: { lp: 8 }, to: { atom: 3 } }, { from: { bond: [3, 7] }, to: { bond: [7, 1] } }],
      },
      {
        title: 'Products',
        caption: '2-Methylpropene. E1 competes with SN1; heat favours elimination.',
        species: [{ smiles: '[CH2:7]=[C:1]([CH3:5])[CH3:6]' }, { smiles: '[H:3][OH2+:8]' }, { smiles: '[Br-:2]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'hbr-addition',
    title: 'Electrophilic addition of HBr',
    summary: 'The π bond grabs a proton to give the more stable carbocation (Markovnikov), then bromide adds.',
    overall: 'CH₂=CHCH₃ + HBr → CH₃CHBrCH₃',
    steps: [
      {
        title: 'Protonation',
        caption: 'The π electrons attack H of H–Br. The proton adds to the CH₂ end so the positive charge sits on the secondary carbon — the more stable carbocation (Markovnikov’s rule).',
        species: [{ smiles: '[CH2:1]=[CH:2][CH3:3]' }, { smiles: '[H:4][Br:5]' }],
        arrows: [{ from: { bond: [1, 2] }, to: { atom: 4 } }, { from: { bond: [4, 5] }, to: { atom: 5 } }],
      },
      {
        title: 'Bromide capture',
        caption: 'Bromide’s lone pair bonds to the carbocation.',
        species: [{ smiles: '[H:4][CH2:1][CH+:2][CH3:3]' }, { smiles: '[Br-:5]' }],
        arrows: [{ from: { lp: 5 }, to: { atom: 2 } }],
      },
      {
        title: 'Product',
        caption: '2-Bromopropane.',
        species: [{ smiles: '[H:4][CH2:1][CH:2]([Br:5])[CH3:3]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'carbonyl-addition',
    title: 'Nucleophilic addition to a carbonyl',
    summary: 'Cyanide adds to the electrophilic C=O carbon; the alkoxide is then protonated.',
    overall: 'CH₃CHO + HCN → CH₃CH(OH)CN',
    steps: [
      {
        title: 'Nucleophilic attack',
        caption: 'The carbon lone pair of cyanide attacks the partially positive carbonyl carbon; the C=O π electrons move onto oxygen.',
        species: [{ smiles: '[C-:1]#[N:2]' }, { smiles: '[CH3:3][CH:4]=[O:5]' }],
        arrows: [{ from: { lp: 1 }, to: { atom: 4 } }, { from: { bond: [4, 5] }, to: { atom: 5 } }],
      },
      {
        title: 'Protonation',
        caption: 'The alkoxide takes a proton from HCN, regenerating cyanide — so cyanide acts catalytically.',
        species: [{ smiles: '[N:2]#[C:1][CH:4]([CH3:3])[O-:5]' }, { smiles: '[H:6][C:7]#[N:8]' }],
        arrows: [{ from: { lp: 5 }, to: { atom: 6 } }, { from: { bond: [6, 7] }, to: { atom: 7 } }],
      },
      {
        title: 'Products',
        caption: '2-Hydroxypropanenitrile (a cyanohydrin). Attack on either face of the flat carbonyl gives both enantiomers.',
        species: [{ smiles: '[N:2]#[C:1][CH:4]([CH3:3])[O:5][H:6]' }, { smiles: '[C-:7]#[N:8]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'diels-alder',
    title: 'Diels–Alder [4+2] cycloaddition',
    summary: 'Six electrons move around a ring in one step: two new σ bonds and a new π bond.',
    overall: 'CH₂=CH–CH=CH₂ + CH₂=CH₂ → cyclohexene',
    steps: [
      {
        title: 'Concerted cycloaddition',
        caption: 'The diene must be s-cis. Each π bond shifts one position around the ring: C1=C2 → C2=C3, C3=C4 → C4–C5, and the dienophile’s π → C6–C1.',
        species: [
          { smiles: '[CH2:1]=[CH:2][CH:3]=[CH2:4]', coords: { 1: HEX(1, 120), 2: HEX(1, 180), 3: HEX(1, 240), 4: HEX(1, 300) } },
          { smiles: '[CH2:5]=[CH2:6]', coords: { 5: HEX(1, 0, 0.9), 6: HEX(1, 60, 0.9) } },
        ],
        arrows: [{ from: { bond: [1, 2] }, to: { bond: [2, 3] }, bend: -1 }, { from: { bond: [3, 4] }, to: { bond: [4, 5] }, bend: -1 }, { from: { bond: [5, 6] }, to: { bond: [6, 1] }, bend: 1 }],
      },
      {
        title: 'Product',
        caption: 'Cyclohexene. Substituents keep their relative geometry (the reaction is stereospecific).',
        species: [{ smiles: '[CH2:1]1[CH:2]=[CH:3][CH2:4][CH2:5][CH2:6]1', coords: { 1: HEX(1, 120), 2: HEX(1, 180), 3: HEX(1, 240), 4: HEX(1, 300), 5: HEX(1, 0), 6: HEX(1, 60) } }],
        arrows: [],
      },
    ],
  },
  {
    id: 'eas-bromination',
    title: 'Electrophilic aromatic substitution (bromination)',
    summary: 'The ring attacks an activated bromine, loses aromaticity briefly, then regains it by losing H⁺.',
    overall: 'C₆H₆ + Br₂ —FeBr₃→ C₆H₅Br + HBr',
    steps: [
      {
        title: 'Attack on the electrophile (slow)',
        caption: 'FeBr₃ polarizes Br₂. A π bond of the ring attacks the outer bromine; the Br–Br electrons move to the bromine held by iron. Aromaticity is lost — this is the slow step.',
        species: [{ smiles: '[CH:1]1=[CH:2][CH:3]=[CH:4][CH:5]=[CH:6]1' }, { smiles: '[Br:7][Br+:8][Fe-](Br)(Br)Br' }],
        arrows: [{ from: { bond: [1, 2] }, to: { atom: 7 } }, { from: { bond: [7, 8] }, to: { atom: 8 } }],
      },
      {
        title: 'Loss of H⁺',
        caption: 'The arenium ion (σ-complex) is resonance-stabilized but not aromatic. FeBr₄⁻ removes the proton from the sp³ carbon and the C–H electrons restore the aromatic π system.',
        species: [{ smiles: '[C:1]1([H:9])([Br:7])[CH+:2][CH:3]=[CH:4][CH:5]=[CH:6]1' }, { smiles: '[Br-:8]' }],
        arrows: [{ from: { lp: 8 }, to: { atom: 9 } }, { from: { bond: [1, 9] }, to: { bond: [1, 2] } }],
      },
      {
        title: 'Products',
        caption: 'Bromobenzene and HBr; FeBr₃ is regenerated. Substitution, not addition, because aromaticity is worth keeping.',
        species: [{ smiles: '[Br:7][C:1]1=[CH:2][CH:3]=[CH:4][CH:5]=[CH:6]1' }, { smiles: '[H:9][Br:8]' }],
        arrows: [],
      },
    ],
  },
  {
    id: 'acid-base',
    title: 'Acid–base and resonance (acetic acid)',
    summary: 'Proton transfer to hydroxide, then the carboxylate’s charge is shared by two oxygens.',
    overall: 'CH₃COOH + HO⁻ → CH₃COO⁻ + H₂O',
    steps: [
      {
        title: 'Proton transfer',
        caption: 'Hydroxide’s lone pair takes the acidic O–H proton; the O–H bond electrons stay on oxygen.',
        species: [{ smiles: '[CH3:5][C:1](=[O:2])[O:3][H:4]' }, { smiles: '[OH-:6]' }],
        arrows: [{ from: { lp: 6 }, to: { atom: 4 } }, { from: { bond: [3, 4] }, to: { atom: 3 } }],
      },
      {
        title: 'Resonance',
        caption: 'The negative charge is not stuck on one oxygen: a lone pair forms a π bond while the C=O π electrons move out. The real acetate is a hybrid of both drawings.',
        species: [{ smiles: '[CH3:5][C:1](=[O:2])[O-:3]' }, { smiles: '[H:4][OH:6]' }],
        arrows: [{ from: { lp: 3 }, to: { bond: [1, 3] } }, { from: { bond: [1, 2] }, to: { atom: 2 } }],
      },
      {
        title: 'Equivalent contributor',
        caption: 'Two identical C–O bonds (≈1.26 Å, between single and double). This delocalization is why acetic acid (pKa 4.76) is ~10¹¹ times more acidic than ethanol (pKa 16).',
        species: [{ smiles: '[CH3:5][C:1]([O-:2])=[O:3]' }, { smiles: '[H:4][OH:6]' }],
        arrows: [],
      },
    ],
  },
];
