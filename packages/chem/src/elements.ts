/** Periodic-table data used across the studio: masses, colours, radii and valence models. */

export interface ElementInfo {
  z: number;
  symbol: string;
  name: string;
  /** Standard atomic weight (g/mol). */
  mass: number;
  /** Mass of the most abundant isotope, for exact (monoisotopic) mass. */
  monoisotopicMass: number;
  /** Jmol/CPK reference colour (hex, no #). Themes adjust these for contrast. */
  color: string;
  covalentRadius: number;
  vdwRadius: number;
  electronegativity?: number;
  group: number;
  period: number;
}

const RAW: Array<[string, string, number]> = [
  ['H', 'hydrogen', 1.008], ['He', 'helium', 4.0026], ['Li', 'lithium', 6.94], ['Be', 'beryllium', 9.0122],
  ['B', 'boron', 10.81], ['C', 'carbon', 12.011], ['N', 'nitrogen', 14.007], ['O', 'oxygen', 15.999],
  ['F', 'fluorine', 18.998], ['Ne', 'neon', 20.18], ['Na', 'sodium', 22.99], ['Mg', 'magnesium', 24.305],
  ['Al', 'aluminium', 26.982], ['Si', 'silicon', 28.085], ['P', 'phosphorus', 30.974], ['S', 'sulfur', 32.06],
  ['Cl', 'chlorine', 35.45], ['Ar', 'argon', 39.95], ['K', 'potassium', 39.098], ['Ca', 'calcium', 40.078],
  ['Sc', 'scandium', 44.956], ['Ti', 'titanium', 47.867], ['V', 'vanadium', 50.942], ['Cr', 'chromium', 51.996],
  ['Mn', 'manganese', 54.938], ['Fe', 'iron', 55.845], ['Co', 'cobalt', 58.933], ['Ni', 'nickel', 58.693],
  ['Cu', 'copper', 63.546], ['Zn', 'zinc', 65.38], ['Ga', 'gallium', 69.723], ['Ge', 'germanium', 72.63],
  ['As', 'arsenic', 74.922], ['Se', 'selenium', 78.971], ['Br', 'bromine', 79.904], ['Kr', 'krypton', 83.798],
  ['Rb', 'rubidium', 85.468], ['Sr', 'strontium', 87.62], ['Y', 'yttrium', 88.906], ['Zr', 'zirconium', 91.224],
  ['Nb', 'niobium', 92.906], ['Mo', 'molybdenum', 95.95], ['Tc', 'technetium', 98], ['Ru', 'ruthenium', 101.07],
  ['Rh', 'rhodium', 102.91], ['Pd', 'palladium', 106.42], ['Ag', 'silver', 107.87], ['Cd', 'cadmium', 112.41],
  ['In', 'indium', 114.82], ['Sn', 'tin', 118.71], ['Sb', 'antimony', 121.76], ['Te', 'tellurium', 127.6],
  ['I', 'iodine', 126.9], ['Xe', 'xenon', 131.29], ['Cs', 'caesium', 132.91], ['Ba', 'barium', 137.33],
  ['La', 'lanthanum', 138.91], ['Ce', 'cerium', 140.12], ['Pr', 'praseodymium', 140.91], ['Nd', 'neodymium', 144.24],
  ['Pm', 'promethium', 145], ['Sm', 'samarium', 150.36], ['Eu', 'europium', 151.96], ['Gd', 'gadolinium', 157.25],
  ['Tb', 'terbium', 158.93], ['Dy', 'dysprosium', 162.5], ['Ho', 'holmium', 164.93], ['Er', 'erbium', 167.26],
  ['Tm', 'thulium', 168.93], ['Yb', 'ytterbium', 173.05], ['Lu', 'lutetium', 174.97], ['Hf', 'hafnium', 178.49],
  ['Ta', 'tantalum', 180.95], ['W', 'tungsten', 183.84], ['Re', 'rhenium', 186.21], ['Os', 'osmium', 190.23],
  ['Ir', 'iridium', 192.22], ['Pt', 'platinum', 195.08], ['Au', 'gold', 196.97], ['Hg', 'mercury', 200.59],
  ['Tl', 'thallium', 204.38], ['Pb', 'lead', 207.2], ['Bi', 'bismuth', 208.98], ['Po', 'polonium', 209],
  ['At', 'astatine', 210], ['Rn', 'radon', 222], ['Fr', 'francium', 223], ['Ra', 'radium', 226],
  ['Ac', 'actinium', 227], ['Th', 'thorium', 232.04], ['Pa', 'protactinium', 231.04], ['U', 'uranium', 238.03],
  ['Np', 'neptunium', 237], ['Pu', 'plutonium', 244], ['Am', 'americium', 243], ['Cm', 'curium', 247],
  ['Bk', 'berkelium', 247], ['Cf', 'californium', 251], ['Es', 'einsteinium', 252], ['Fm', 'fermium', 257],
  ['Md', 'mendelevium', 258], ['No', 'nobelium', 259], ['Lr', 'lawrencium', 266], ['Rf', 'rutherfordium', 267],
  ['Db', 'dubnium', 268], ['Sg', 'seaborgium', 269], ['Bh', 'bohrium', 270], ['Hs', 'hassium', 269],
  ['Mt', 'meitnerium', 278], ['Ds', 'darmstadtium', 281], ['Rg', 'roentgenium', 282], ['Cn', 'copernicium', 285],
  ['Nh', 'nihonium', 286], ['Fl', 'flerovium', 289], ['Mc', 'moscovium', 290], ['Lv', 'livermorium', 293],
  ['Ts', 'tennessine', 294], ['Og', 'oganesson', 294],
];

const MONO: Record<string, number> = {
  H: 1.00782503223, He: 4.00260325413, Li: 7.0160034366, Be: 9.012183065, B: 11.00930536, C: 12,
  N: 14.00307400443, O: 15.99491461957, F: 18.99840316273, Ne: 19.9924401762, Na: 22.989769282,
  Mg: 23.985041697, Al: 26.98153853, Si: 27.97692653465, P: 30.97376199842, S: 31.9720711744,
  Cl: 34.968852682, Ar: 39.9623831237, K: 38.9637064864, Ca: 39.962590863, Fe: 55.93493633,
  Co: 58.93319429, Ni: 57.93534241, Cu: 62.92959772, Zn: 63.92914201, Ga: 68.9255735, Ge: 73.921177761,
  As: 74.92159457, Se: 79.9165218, Br: 78.9183376, Kr: 83.9114977282, Rb: 84.9117897379, Sr: 87.9056125,
  Pd: 105.9034804, Ag: 106.9050916, Cd: 113.90336509, Sn: 119.90220163, Sb: 120.903812, Te: 129.906222748,
  I: 126.9044719, Xe: 131.9041550856, Cs: 132.905451961, Ba: 137.905247, Pt: 194.9647917,
  Au: 196.96656879, Hg: 201.9706434, Pb: 207.9766525, Bi: 208.9803991,
};

/** Exact isotope masses used for labelled atoms (deuterium, 13C, 15N, 18O …). */
const ISOTOPE_MASS: Record<string, number> = {
  '1H': 1.00782503223, '2H': 2.01410177812, '3H': 3.0160492779, '12C': 12, '13C': 13.00335483507,
  '14C': 14.0032419884, '14N': 14.00307400443, '15N': 15.00010889888, '16O': 15.99491461957,
  '17O': 16.9991317565, '18O': 17.99915961286, '19F': 18.99840316273, '31P': 30.97376199842,
  '32S': 31.9720711744, '34S': 33.967867004, '35Cl': 34.968852682, '37Cl': 36.965902602,
  '79Br': 78.9183376, '81Br': 80.9162897, '127I': 126.9044719, '11C': 11.0114336, '18F': 18.0009373,
};

const JMOL: Record<string, string> = {
  H: 'FFFFFF', He: 'D9FFFF', Li: 'CC80FF', Be: 'C2FF00', B: 'FFB5B5', C: '909090', N: '3050F8', O: 'FF0D0D',
  F: '90E050', Ne: 'B3E3F5', Na: 'AB5CF2', Mg: '8AFF00', Al: 'BFA6A6', Si: 'F0C8A0', P: 'FF8000', S: 'FFFF30',
  Cl: '1FF01F', Ar: '80D1E3', K: '8F40D4', Ca: '3DFF00', Sc: 'E6E6E6', Ti: 'BFC2C7', V: 'A6A6AB', Cr: '8A99C7',
  Mn: '9C7AC7', Fe: 'E06633', Co: 'F090A0', Ni: '50D050', Cu: 'C88033', Zn: '7D80B0', Ga: 'C28F8F', Ge: '668F8F',
  As: 'BD80E3', Se: 'FFA100', Br: 'A62929', Kr: '5CB8D1', Rb: '702EB0', Sr: '00FF00', Y: '94FFFF', Zr: '94E0E0',
  Nb: '73C2C9', Mo: '54B5B5', Tc: '3B9E9E', Ru: '248F8F', Rh: '0A7D8C', Pd: '006985', Ag: 'C0C0C0', Cd: 'FFD98F',
  In: 'A67573', Sn: '668080', Sb: '9E63B5', Te: 'D47A00', I: '940094', Xe: '429EB0', Cs: '57178F', Ba: '00C900',
  La: '70D4FF', Ce: 'FFFFC7', Pr: 'D9FFC7', Nd: 'C7FFC7', Pm: 'A3FFC7', Sm: '8FFFC7', Eu: '61FFC7', Gd: '45FFC7',
  Tb: '30FFC7', Dy: '1FFFC7', Ho: '00FF9C', Er: '00E675', Tm: '00D452', Yb: '00BF38', Lu: '00AB24', Hf: '4DC2FF',
  Ta: '4DA6FF', W: '2194D6', Re: '267DAB', Os: '266696', Ir: '175487', Pt: 'D0D0E0', Au: 'FFD123', Hg: 'B8B8D0',
  Tl: 'A6544D', Pb: '575961', Bi: '9E4FB5', Po: 'AB5C00', At: '754F45', Rn: '428296', Fr: '420066', Ra: '007D00',
  Ac: '70ABFA', Th: '00BAFF', Pa: '00A1FF', U: '008FFF', Np: '0080FF', Pu: '006BFF', Am: '545CF2', Cm: '785CE3',
  Bk: '8A4FE3', Cf: 'A136D4', Es: 'B31FD4', Fm: 'B31FBA', Md: 'B30DA6', No: 'BD0D87', Lr: 'C70066', Rf: 'CC0059',
  Db: 'D1004F', Sg: 'D90045', Bh: 'E00038', Hs: 'E6002E', Mt: 'EB0026',
};

/** Covalent radii (Å), Cordero et al. 2008 (sp3 carbon). */
const COVALENT: Record<string, number> = {
  H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Ne: 0.58, Na: 1.66,
  Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Fe: 1.32, Co: 1.26,
  Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.2, As: 1.19, Se: 1.2, Br: 1.2, Kr: 1.16, Rb: 2.2, Sr: 1.95,
  Pd: 1.39, Ag: 1.45, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.4, Cs: 2.44, Ba: 2.15, Pt: 1.36, Au: 1.36,
  Hg: 1.32, Pb: 1.46, Bi: 1.48,
};

/** Van der Waals radii (Å), Bondi / Alvarez. */
const VDW: Record<string, number> = {
  H: 1.2, He: 1.4, Li: 1.82, B: 1.92, C: 1.7, N: 1.55, O: 1.52, F: 1.47, Ne: 1.54, Na: 2.27, Mg: 1.73,
  Al: 1.84, Si: 2.1, P: 1.8, S: 1.8, Cl: 1.75, Ar: 1.88, K: 2.75, Ca: 2.31, Ni: 1.63, Cu: 1.4, Zn: 1.39,
  Ga: 1.87, Ge: 2.11, As: 1.85, Se: 1.9, Br: 1.85, Kr: 2.02, Pd: 1.63, Ag: 1.72, Sn: 2.17, Sb: 2.06,
  Te: 2.06, I: 1.98, Xe: 2.16, Pt: 1.75, Au: 1.66, Hg: 1.55, Pb: 2.02,
};

/** Pauling electronegativities for common elements. */
const EN: Record<string, number> = {
  H: 2.2, Li: 0.98, Be: 1.57, B: 2.04, C: 2.55, N: 3.04, O: 3.44, F: 3.98, Na: 0.93, Mg: 1.31, Al: 1.61,
  Si: 1.9, P: 2.19, S: 2.58, Cl: 3.16, K: 0.82, Ca: 1.0, Fe: 1.83, Cu: 1.9, Zn: 1.65, Ge: 2.01, As: 2.18,
  Se: 2.55, Br: 2.96, Sn: 1.96, Sb: 2.05, Te: 2.1, I: 2.66, Cs: 0.79, Pt: 2.28, Au: 2.54, Hg: 2.0,
};

function groupAndPeriod(z: number): { group: number; period: number } {
  const periods = [2, 10, 18, 36, 54, 86, 118];
  let period = 1;
  while (z > periods[period - 1]) period++;
  const start = period === 1 ? 1 : periods[period - 2] + 1;
  const pos = z - start; // 0-based position in period
  if (period === 1) return { group: z === 1 ? 1 : 18, period };
  if (period <= 3) return { group: pos < 2 ? pos + 1 : pos + 11, period };
  if (period <= 5) return { group: pos + 1, period };
  // Periods 6 and 7 include the f-block (group 3 for La–Lu / Ac–Lr in this table).
  if (pos < 2) return { group: pos + 1, period };
  if (pos < 17) return { group: 3, period };
  return { group: pos - 14 + 1, period };
}

export const ELEMENTS: ElementInfo[] = RAW.map(([symbol, name, mass], i) => {
  const z = i + 1;
  const gp = groupAndPeriod(z);
  return {
    z,
    symbol,
    name,
    mass,
    monoisotopicMass: MONO[symbol] ?? mass,
    color: JMOL[symbol] ?? 'FF1493',
    covalentRadius: COVALENT[symbol] ?? 1.5,
    vdwRadius: VDW[symbol] ?? 2.0,
    electronegativity: EN[symbol],
    group: gp.group,
    period: gp.period,
  };
});

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));

export function element(symbol: string): ElementInfo {
  const e = BY_SYMBOL.get(symbol);
  if (!e) throw new Error(`Unknown element ${symbol}`);
  return e;
}

export function isElement(symbol: string): boolean {
  return BY_SYMBOL.has(symbol);
}

export function atomicNumber(symbol: string): number {
  return BY_SYMBOL.get(symbol)?.z ?? 0;
}

export function symbolForZ(z: number): string | undefined {
  return ELEMENTS[z - 1]?.symbol;
}

export function isotopeMass(symbol: string, isotope?: number): number {
  if (!isotope) return element(symbol).monoisotopicMass;
  return ISOTOPE_MASS[`${isotope}${symbol}`] ?? isotope;
}

/** Elements inside the verified instructional scope (spec §4). */
export const COURSE_SCOPE_ELEMENTS = new Set(['H', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I']);

/** Frequent atoms shown on the element rail. */
export const RAIL_ELEMENTS = ['C', 'N', 'O', 'S', 'P', 'F', 'Cl', 'Br', 'I', 'H'];

/**
 * Allowed valences of neutral main-group atoms. The first entry is the "typical" state used to
 * teach; later entries are hypervalent states that are allowed with an explanatory note.
 */
const NEUTRAL_VALENCES: Record<string, number[]> = {
  H: [1], He: [0], Li: [1], Be: [2], B: [3], C: [4], N: [3], O: [2], F: [1], Ne: [0],
  Na: [1], Mg: [2], Al: [3], Si: [4], P: [3, 5], S: [2, 4, 6], Cl: [1, 3, 5, 7], Ar: [0],
  K: [1], Ca: [2], Ga: [3], Ge: [4], As: [3, 5], Se: [2, 4, 6], Br: [1, 3, 5], Kr: [0, 2],
  Rb: [1], Sr: [2], In: [3], Sn: [4, 2], Sb: [3, 5], Te: [2, 4, 6], I: [1, 3, 5, 7], Xe: [0, 2, 4, 6],
  Cs: [1], Ba: [2], Tl: [3, 1], Pb: [4, 2], Bi: [3, 5],
};

/** Elements that receive implicit hydrogens from the valence model (SMILES organic subset+). */
export const IMPLICIT_H_ELEMENTS = new Set(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I', 'Si', 'Se', 'As', 'Ge', 'Te']);

/**
 * Allowed valences for an element in a given charge state, using the isoelectronic rule
 * (N⁺ behaves like C, O⁺ like N, C⁻ like N, O⁻ like F …). Returns undefined when the
 * element has no simple valence model (transition metals etc.).
 */
export function allowedValences(symbol: string, charge = 0): number[] | undefined {
  const base = NEUTRAL_VALENCES[symbol];
  if (charge === 0) return base;
  const z = atomicNumber(symbol);
  if (!z) return undefined;
  const iso = symbolForZ(z - charge);
  if (!iso) return undefined;
  const e0 = element(symbol);
  const e1 = BY_SYMBOL.get(iso);
  if (!e1) return undefined;
  // The isoelectronic partner must be in the same period, or be the preceding noble gas.
  const sameRow = e1.period === e0.period || (e1.group === 18 && e1.period === e0.period - 1)
    || (e0.group === 18 && e1.period === e0.period + 1);
  if (!sameRow && e0.period > 1) return undefined;
  const v = NEUTRAL_VALENCES[iso];
  if (!v) return undefined;
  // A cation of a hypervalent-capable element (S⁺, P⁺) keeps only octet-compatible states.
  return v;
}

export function typicalValence(symbol: string, charge = 0): number | undefined {
  return allowedValences(symbol, charge)?.[0];
}
