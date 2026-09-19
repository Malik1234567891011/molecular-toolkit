// Copies RDKit.js + OpenChemLib resources into public/ and bundles the chemistry worker (IIFE).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const findPkg = (name) => {
  for (let dir = root; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(p, 'package.json'))) return p;
  }
  throw new Error(`Cannot find ${name}`);
};
const rdkitDir = findPkg('@rdkit/rdkit');
const oclDir = findPkg('openchemlib');

mkdirSync(path.join(root, 'public/rdkit'), { recursive: true });
mkdirSync(path.join(root, 'public/ocl'), { recursive: true });
mkdirSync(path.join(root, 'public/workers'), { recursive: true });
for (const f of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) copyFileSync(path.join(rdkitDir, 'dist', f), path.join(root, 'public/rdkit', f));
copyFileSync(path.join(oclDir, 'dist/resources.json'), path.join(root, 'public/ocl/resources.json'));

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: [path.join(root, 'worker/chem.worker.ts')],
  outfile: path.join(root, 'public/workers/chem.worker.js'),
  bundle: true,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};
if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
console.log('assets ready', existsSync(path.join(root, 'public/workers/chem.worker.js')));
