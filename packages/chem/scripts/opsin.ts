// Minimal OPSIN bridge client for Node scripts and tests.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const opsinDir = path.resolve(here, '../../../services/opsin');

export interface OpsinResult { status: 'SUCCESS' | 'WARNING' | 'FAILURE'; smiles: string; message: string; flags: string[] }

export class Opsin {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters = new Map<string, (r: OpsinResult) => void>();
  private seq = 0;
  ready: Promise<void>;
  constructor() {
    this.proc = spawn('java', ['-Xss4m', '-cp', `${opsinDir}/classes:${opsinDir}/opsin-core-2.9.0-jar-with-dependencies.jar`, 'OpsinBridge'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let readyResolve: () => void;
    this.ready = new Promise((r) => (readyResolve = r));
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => {
      this.buf += d;
      let k: number;
      while ((k = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, k);
        this.buf = this.buf.slice(k + 1);
        if (line.startsWith('READY')) { readyResolve(); continue; }
        const [id, status, smiles, message, flags] = line.split('\t');
        const w = this.waiters.get(id);
        if (w) { this.waiters.delete(id); w({ status: status as OpsinResult['status'], smiles: smiles ?? '', message: message ?? '', flags: (flags ?? '').split(',').filter(Boolean) }); }
      }
    });
    this.proc.stderr.on('data', () => {});
  }
  async parse(name: string): Promise<OpsinResult> {
    await this.ready;
    const id = String(++this.seq);
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.proc.stdin.write(`${id}\t${name.replace(/[\t\n]/g, ' ')}\n`);
    });
  }
  close() { this.proc.stdin.end(); this.proc.kill(); }
}
