/** Numerical terms, multiplying prefixes and euphony helpers for IUPAC names. */

const UNITS = ['', 'hen', 'do', 'tri', 'tetra', 'penta', 'hexa', 'hepta', 'octa', 'nona'];
const TENS = ['', 'deca', 'cosa', 'triaconta', 'tetraconta', 'pentaconta', 'hexaconta', 'heptaconta', 'octaconta', 'nonaconta'];

/** Numerical term used for chain lengths ("but", "pent", "icos" …) — without the final ane. */
export function chainStem(n: number): string {
  const fixed: Record<number, string> = {
    1: 'meth', 2: 'eth', 3: 'prop', 4: 'but', 5: 'pent', 6: 'hex', 7: 'hept', 8: 'oct', 9: 'non', 10: 'dec',
    11: 'undec', 20: 'icos', 21: 'henicos', 22: 'docos', 23: 'tricos',
  };
  if (fixed[n]) return fixed[n];
  if (n < 1 || n > 99) throw new Error(`Chain length ${n} is outside the supported range`);
  const u = n % 10;
  const t = Math.floor(n / 10);
  let unit = UNITS[u];
  if (n === 11) unit = 'un';
  let tens = TENS[t];
  if (t === 2 && u > 0) tens = 'cosa';
  if (t === 1) tens = 'deca';
  let s = unit + tens;
  // 'icosa' after a unit keeps the i: tricosa, but 'docosa' etc. are already fine.
  if (t === 2 && u > 0 && !['hen', 'do', 'tri'].includes(unit)) s = unit + 'cosa';
  // Remove the terminal 'a' (numerical term → hydrocarbon stem).
  return s.replace(/a$/, '');
}

const SIMPLE = ['', 'mono', 'di', 'tri', 'tetra', 'penta', 'hexa', 'hepta', 'octa', 'nona', 'deca', 'undeca', 'dodeca'];
const COMPLEX = ['', '', 'bis', 'tris', 'tetrakis', 'pentakis', 'hexakis', 'heptakis', 'octakis', 'nonakis', 'decakis'];

export function multiplier(n: number): string {
  if (n <= 1) return '';
  return SIMPLE[n] ?? `${n}-`;
}

export function complexMultiplier(n: number): string {
  if (n <= 1) return '';
  return COMPLEX[n] ?? `${n}-kis`;
}

/** Numerical term with 'a' kept, for "buta-1,3-diene", "hexa-2,4-diene". */
export function chainStemWithA(n: number): string {
  return chainStem(n) + 'a';
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/** Join a hydride name ending in 'e' with a suffix, eliding the e before a vowel. */
export function elide(base: string, next: string): string {
  const first = next.replace(/^[-\d,'\s]+/, '')[0];
  if (base.endsWith('e') && first && VOWELS.has(first)) return base.slice(0, -1) + next;
  return base + next;
}

/** "2,3" formatting of locants (numbers or strings like "N"). */
export function locantList(locants: Array<number | string>): string {
  return locants.map(String).join(',');
}

export function sortLocants(locs: Array<number | string>): Array<number | string> {
  return [...locs].sort((a, b) => {
    const na = typeof a === 'number' ? a : Number.NaN;
    const nb = typeof b === 'number' ? b : Number.NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

/** Compare two ascending locant lists term by term: <0 if a is lower (better). */
export function compareLocantSets(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** First point of difference between two locant lists, for explanations. */
export function firstDifference(a: number[], b: number[]): { index: number; a: number; b: number } | null {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return { index: i, a: a[i], b: b[i] };
  return null;
}

/** Sort key for alphanumerical ordering of prefixes (P-14.5): letters only, italics removed. */
export function alphaKey(prefix: string): string {
  return prefix
    .replace(/\b(sec|tert|cis|trans|[NOS])-/g, '')
    .replace(/\((\d+[A-Za-z]?)(,\d+[A-Za-z]?)*[RSEZrs]*\)/g, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
}

/** Enclosing marks by nesting depth: ( ) then [ ] then { } then ( ) … */
export function enclose(s: string, depth: number): string {
  const marks: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}']];
  const [o, c] = marks[depth % 3];
  return o + s + c;
}

/** Deepest nesting level of enclosing marks already used inside s (−1 when none). */
export function nestingDepth(s: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of s) {
    if ('([{'.includes(ch)) {
      depth++;
      max = Math.max(max, depth);
    } else if (')]}'.includes(ch)) depth--;
  }
  return max - 1;
}
