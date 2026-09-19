'use client';
/** Chemistry API client. Every call degrades gracefully: callers get `null` when offline. */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

export async function api<T>(path: string, body?: unknown, opts: { timeout?: number; method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? 15000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      credentials: 'same-origin',
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j?.error?.message ?? j?.detail ?? msg;
      } catch {
        /* ignore */
      }
      throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function tryApi<T>(path: string, body?: unknown, opts?: { timeout?: number; method?: string; signal?: AbortSignal }): Promise<T | null> {
  if (!isOnline()) return null;
  try {
    return await api<T>(path, body, opts);
  } catch {
    return null;
  }
}

export interface Health {
  ok: boolean;
  engine: { rdkit: string; opsin: string; standardization: string };
  capabilities: { opsin: boolean; pubchem: boolean; tutor: boolean; stout: boolean; quantum: boolean; ocsr: { available: boolean; reason?: string } };
}

export interface ResolveCandidate {
  canonicalSmiles: string;
  inchi: string;
  inchiKey: string;
  formula: string;
  sources: string[];
  stereo: { centres: number; unspecifiedCentres: number[]; unspecifiedDoubleBonds: number[]; complete: boolean };
  cid?: number;
  pubchemTitle?: string;
  iupacName?: string;
  inputName?: string;
}

export interface ResolveResponse {
  input: { raw: string; normalized: string; changes: string[]; interpretedAs: string[] };
  status: 'resolved' | 'ambiguous' | 'failed';
  candidates: ResolveCandidate[];
  agreement: string | null;
  suggestions: Array<{ name: string; source: string }>;
  opsin: { status: string; message: string; flags: string[] } | null;
  pubchem: string;
  warnings: string[];
}

export interface GenerateResponse {
  identifiers: { canonicalSmiles: string; inchi: string; inchiKey: string; formula: string };
  stereo: { complete: boolean; unspecifiedCentres: number[]; unspecifiedDoubleBonds: number[] };
  course: Array<{ name: string; kind: string; status: string; provenance: string; message?: string; parsedSmiles?: string }>;
  database: { status: string; cid?: number; iupacName?: string; title?: string; synonyms?: string[]; synonymDetails?: Array<{ name: string; checked: boolean; kind: 'cas-index' | 'systematic' | 'common' }>; iupacVerified?: boolean; reason?: string };
  ml: { status: string; reason?: string; name?: string; provenance?: string };
  engine: { opsin: string; rdkit: string; standardization: string };
}

export interface CheckAnswerResponse {
  verdict: 'correct' | 'stereo' | 'isomer' | 'different' | 'unparseable';
  message?: string;
  suggestions?: string[];
  normalized: string;
  changes?: string[];
  answerSmiles?: string;
  targetSmiles?: string;
  answerFormula?: string;
  targetFormula?: string;
}
