#!/usr/bin/env node
/**
 * Delete old API container images from the Vercel registry, keeping the newest few.
 *
 * Every deployment that rebuilds the API stores another ~200 MB image, and the free tier counts
 * the lot (10 GB). Keeping the live one plus a couple to roll back to is enough.
 *
 *   node scripts/prune-images.mjs          # show what would go
 *   node scripts/prune-images.mjs --yes    # delete them
 *   node scripts/prune-images.mjs --keep 5 --yes
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const keep = Number(args[args.indexOf('--keep') + 1]) || 3;
const confirmed = args.includes('--yes');
const vercel = (...a) => execFileSync('vercel', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const listing = vercel('vcr', 'image', 'ls', 'api');
const images = [...listing.matchAll(/(image_[A-Za-z0-9]+)\s+([0-9a-f]+)\s+(\S+)?\s+\w+\s+\w+\s+\w+\s+([\d.]+\w+)/g)]
  .map(([, id, digest, tag, size]) => ({ id, digest, tag, size }));

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
