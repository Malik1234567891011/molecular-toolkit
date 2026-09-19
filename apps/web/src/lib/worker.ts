'use client';
/** Promise RPC to the chemistry worker (public/workers/chem.worker.js). */
import { WORKER_VERSION } from './asset-version';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function get(): Worker {
  if (worker) return worker;
  worker = new Worker(`/workers/chem.worker.js?v=${WORKER_VERSION}`);
  worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.ok) p.resolve(ev.data.result);
    else p.reject(new Error(ev.data.error ?? 'worker error'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker crashed'));
    pending.clear();
  };
  return worker;
}

export function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  const w = get();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, op, args });
  });
}

export function warmUp(): void {
  call('ping').catch(() => undefined);
}
