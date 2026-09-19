// Shared RDKit.js loader for tests (Node).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let mod: any;
export async function rdkit(): Promise<any> {
  if (mod) return mod;
  const init = require('@rdkit/rdkit');
  mod = await init();
  return mod;
}
