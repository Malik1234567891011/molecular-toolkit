/** Style checks for database synonyms (spec §9.3: never present a mis-written name as accepted). */

const PREFIX_RE = /(?:^|[-(\s])(?:di|tri|tetra|penta|hexa|bis|tris)?(?:sec-|tert-|s-|t-)?(isopropyl|isobutyl|isopentyl|neopentyl|methylidene|methoxy|ethoxy|propoxy|methyl|ethyl|propyl|butyl|pentyl|hexyl|heptyl|octyl|nonyl|decyl|ethenyl|ethynyl|vinyl|allyl|phenyl|benzyl|chloro|bromo|fluoro|iodo|hydroxy|amino|nitro|nitroso|cyano|oxo|formyl|carboxy|sulfanyl|mercapto|cyclopropyl|cyclobutyl|cyclopentyl|cyclohexyl)/g;

/**
 * Why a database synonym should not be offered as an accepted answer, or null when it is fine
 * (trivial and trade names, names without locants). Heuristic and deliberately conservative:
 * it only has to catch names that look systematic but break the rules the explanation teaches.
 */
export function synonymStyleIssue(name: string, kind: 'cas-index' | 'systematic' | 'common'): string | null {
  const n = name.toLowerCase();
  if (kind === 'cas-index' || /^[a-z0-9()[\],-]+, [^,]*-$/.test(n)) return 'CAS index name (parent first, inverted) — a database convention, not how names are written';
  if (!/\d/.test(n)) return null;
  const hy = /([a-z]+)-((?:cyclo)?(?:meth|eth|prop|but|pent|hex|hept|oct|non|dec|benz)(?:a|e|y)?n[a-z]*)/.exec(n);
  if (hy) return `Describes this structure, but has a hyphen before the parent name: write ${hy[1]}${hy[2]}, not ${hy[1]}-${hy[2]}`;
  const cited: string[] = [];
  for (const m of n.matchAll(PREFIX_RE)) cited.push(m[1]);
  for (let i = 1; i < cited.length; i++) {
    if (cited[i].localeCompare(cited[i - 1]) < 0) return `Describes this structure, but its prefixes are not in alphabetical order (${cited[i]} should come before ${cited[i - 1]})`;
  }
  return null;
}
