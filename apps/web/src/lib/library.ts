/** Curated molecule library (spec §14): common course molecules, drugs and natural products. */
export interface LibraryItem {
  name: string;
  smiles: string;
  category: 'Course staples' | 'Stereochemistry' | 'Rings & conformations' | 'Aromatics' | 'Drugs' | 'Natural products';
  why: string;
}

export const LIBRARY: LibraryItem[] = [
  { name: 'ethanol', smiles: 'CCO', category: 'Course staples', why: 'The simplest alcohol you meet daily; compare its boiling point with dimethyl ether, its constitutional isomer.' },
  { name: 'acetone', smiles: 'CC(C)=O', category: 'Course staples', why: 'A planar sp² carbonyl carbon between two sp³ methyls — measure the 120° angle.' },
  { name: 'acetic acid', smiles: 'CC(=O)O', category: 'Course staples', why: 'Its conjugate base is resonance-stabilized, which is why it is ~10¹¹ times more acidic than ethanol.' },
  { name: 'ethyl acetate', smiles: 'CCOC(C)=O', category: 'Course staples', why: 'A classic ester: see how the name splits into the alkyl group and the -oate.' },
  { name: '3-ethyl-2-methylhexane', smiles: 'CCCC(CC)C(C)C', category: 'Course staples', why: 'Two six-carbon chains compete for parent; the one with more substituents wins.' },
  { name: '4-methylpentan-2-one', smiles: 'CC(C)CC(C)=O', category: 'Course staples', why: 'The ketone gets the lowest locant, so numbering starts at the end nearer the C=O.' },
  { name: 'acetonitrile', smiles: 'CC#N', category: 'Course staples', why: 'A linear sp carbon: 180° about the C≡N.' },
  { name: '(R)-butan-2-ol', smiles: 'C[C@@H](O)CC', category: 'Stereochemistry', why: 'The textbook first stereocentre — rotate it so H points away and read R.' },
  { name: '(S)-alanine', smiles: 'C[C@H](N)C(=O)O', category: 'Stereochemistry', why: 'L-amino acids are S (except cysteine): compare CIP with the Fischer convention.' },
  { name: 'D-glyceraldehyde', smiles: 'O=C[C@H](O)CO', category: 'Stereochemistry', why: 'The reference for D/L sugars: OH on the right in the Fischer projection.' },
  { name: 'meso-2,3-dibromobutane', smiles: 'C[C@@H](Br)[C@H](C)Br', category: 'Stereochemistry', why: 'Two stereocentres, yet achiral: an internal mirror plane.' },
  { name: '(E)-but-2-ene', smiles: 'C/C=C/C', category: 'Stereochemistry', why: 'Rigid C=C: E and Z are different compounds that never interconvert at room temperature.' },
  { name: '(Z)-but-2-ene', smiles: 'C/C=C\\C', category: 'Stereochemistry', why: 'Same connectivity as E, different shape — the simplest diastereomers.' },
  { name: 'carvone (R)', smiles: 'CC(=C)[C@@H]1CC=C(C)C(=O)C1', category: 'Stereochemistry', why: 'R-carvone smells of spearmint; its enantiomer smells of caraway.' },
  { name: 'cyclohexane', smiles: 'C1CCCCC1', category: 'Rings & conformations', why: 'Six axial and six equatorial hydrogens — flip the chair and watch them swap.' },
  { name: 'methylcyclohexane', smiles: 'CC1CCCCC1', category: 'Rings & conformations', why: 'The equatorial chair is favoured (1,3-diaxial strain in the axial one).' },
  { name: 'tert-butylcyclohexane', smiles: 'CC(C)(C)C1CCCCC1', category: 'Rings & conformations', why: 'So bulky it locks the ring: the axial chair is almost never populated.' },
  { name: 'cis-1,2-dimethylcyclohexane', smiles: 'C[C@H]1CCCC[C@H]1C', category: 'Rings & conformations', why: 'One methyl axial, one equatorial in both chairs.' },
  { name: 'butane', smiles: 'CCCC', category: 'Rings & conformations', why: 'Rotate C2–C3: anti, gauche and eclipsed on one energy curve.' },
  { name: 'benzene', smiles: 'c1ccccc1', category: 'Aromatics', why: 'Six equal C–C bonds: aromaticity, not alternating single and double bonds.' },
  { name: 'phenol', smiles: 'Oc1ccccc1', category: 'Aromatics', why: 'A retained IUPAC name; far more acidic than cyclohexanol thanks to resonance.' },
  { name: 'toluene', smiles: 'Cc1ccccc1', category: 'Aromatics', why: 'Common name accepted in courses; systematic methylbenzene.' },
  { name: 'pyridine', smiles: 'c1ccncc1', category: 'Aromatics', why: 'Nitrogen\'s lone pair sits in the ring plane — basic, but not part of the aromatic sextet.' },
  { name: 'naphthalene', smiles: 'c1ccc2ccccc2c1', category: 'Aromatics', why: 'Fused rings have their own numbering, including locants like 4a.' },
  { name: 'aspirin', smiles: 'CC(=O)Oc1ccccc1C(=O)O', category: 'Drugs', why: 'An ester and a carboxylic acid on one ring — which one is the suffix?' },
  { name: 'ibuprofen', smiles: 'CC(C)Cc1ccc(cc1)C(C)C(=O)O', category: 'Drugs', why: 'Sold as a racemate; only the S enantiomer is active (the body converts R to S).' },
  { name: 'paracetamol', smiles: 'CC(=O)Nc1ccc(O)cc1', category: 'Drugs', why: 'Amide + phenol: a good test of suffix priority.' },
  { name: 'caffeine', smiles: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C', category: 'Drugs', why: 'A purine with three N-methyls; its systematic name is a fused-ring workout.' },
  { name: 'nicotine', smiles: 'CN1CCC[C@H]1c1cccnc1', category: 'Natural products', why: 'Two nitrogen heterocycles and one stereocentre (S in nature).' },
  { name: 'menthol', smiles: 'CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O', category: 'Natural products', why: 'All three substituents equatorial in the preferred chair.' },
  { name: 'limonene (R)', smiles: 'CC1=CC[C@@H](CC1)C(C)=C', category: 'Natural products', why: 'The orange-peel enantiomer; (S) smells of pine.' },
  { name: 'vanillin', smiles: 'COc1cc(C=O)ccc1O', category: 'Natural products', why: 'Aldehyde, ether and phenol on one benzene ring.' },
  { name: 'glucose (β-D)', smiles: 'OC[C@H]1O[C@@H](O)[C@H](O)[C@@H](O)[C@@H]1O', category: 'Natural products', why: 'Every OH equatorial in the chair — the most stable aldohexose.' },
];
