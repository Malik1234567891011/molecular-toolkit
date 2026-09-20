#!/usr/bin/env node
/**
 * Delete old API container images from the Vercel registry, keeping the newest few.
 *
 * Every deployment that rebuilds the API stores another ~200 MB image, and the free tier counts
 * the lot (10 GB). Keeping the live one plus a couple to roll back to is enough.
 *
 *   node scripts/prune-images.mjs                     # show what would go
 *   node scripts/prune-images.mjs --yes               # delete them
 *   node scripts/prune-images.mjs --keep 5 --yes
 *   node scripts/prune-images.mjs --deployments --yes # also delete every deployment that
 *                                                     # isn't the one serving the live site
 */
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const keep = Number(args[args.indexOf('--keep') + 1]) || 3;
const confirmed = args.includes('--yes');
const vercel = (...a) => execFileSync('vercel', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** The CLI prints its tables to stderr, so read both streams. */
const vercelText = (...a) => {
  const r = spawnSync('vercel', a, { encoding: 'utf8' });
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
};

const listing = vercelText('vcr', 'image', 'ls', 'api');
const images = [...listing.matchAll(/(image_[A-Za-z0-9]+)\s+([0-9a-f]+)\s+(\S+)\s+Image\s+\S+\s+\S+\s+([\d.]+ ?[KMG]B)/g)]
  .map(([, id, digest, tag, size]) => ({ id, digest, tag: tag === '<none>' ? null : tag, size }));

if (!images.length) {
  console.log('No images found (is this project linked, and does it have a container service?).');
  process.exit(0);
}

// The listing is newest first; anything tagged <none> is already unreferenced.
const keepers = images.slice(0, keep);
const doomed = images.slice(keep);
console.log(`${images.length} images; keeping ${keepers.length}:`);
for (const i of keepers) console.log(`  keep   ${i.tag ?? '-'}  ${i.size}`);
if (!doomed.length) {
  console.log('Nothing to prune.');
  process.exit(0);
}
for (const i of doomed) console.log(`  prune  ${i.tag ?? '-'}  ${i.size}`);

if (!confirmed) {
  console.log('\nRe-run with --yes to delete them.');
  process.exit(0);
}
for (const i of doomed) {
  try {
    vercel('vcr', 'image', 'rm', 'api', i.id, '--yes');
    console.log(`deleted ${i.tag ?? i.id}`);
  } catch (e) {
    console.error(`could not delete ${i.id}: ${String(e.message).split('\n')[0]}`);
  }
}

// Old deployments keep their own copy of every function, which is the other half of the bill.
// --safe leaves the deployment the live domain points at, so production is never touched.
if (args.includes('--deployments')) {
  console.log('\nRemoving deployments that are not serving the live site…');
  const out = vercelText('remove', 'molecular-toolkit', '--safe', '--yes');
  const removed = (out.match(/^- \S+$/gm) ?? []).length;
  console.log(`  ${removed} deployment${removed === 1 ? '' : 's'} removed`);
}
