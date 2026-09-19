#!/usr/bin/env node
/**
 * Starts the whole studio for local development:
 *   api    FastAPI + RDKit + OPSIN        http://localhost:8710
 *   rooms  Yjs relay for study rooms      ws://localhost:8720
 *   web    Next.js studio                 http://localhost:3100
 * Output is prefixed per service; Ctrl-C stops all three.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = path.join(root, 'services/api');
const uvicorn = path.join(apiDir, '.venv/bin/uvicorn');

if (!existsSync(uvicorn) || !existsSync(path.join(root, 'services/opsin/classes/OpsinBridge.class'))) {
  console.error('The Python API or OPSIN is not set up yet. Run:  bash scripts/setup.sh');
  process.exit(1);
}

const services = [
  { name: 'api', color: 35, cmd: uvicorn, args: ['app.main:app', '--port', '8710', '--reload', '--reload-dir', 'app'], cwd: apiDir },
  { name: 'rooms', color: 36, cmd: process.execPath, args: ['server.mjs'], cwd: path.join(root, 'services/rooms') },
  { name: 'web', color: 34, cmd: 'npm', args: ['run', 'dev', '-w', '@orbital/web'], cwd: root },
];

const children = services.map((s) => {
  const child = spawn(s.cmd, s.args, { cwd: s.cwd, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${s.color}m${s.name.padEnd(5)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${tag}exited (${code})\n`);
    if (!stopping) stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
