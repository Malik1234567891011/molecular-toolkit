'use client';
/**
 * Optional accounts (spec §20): everything works without one; signing in only adds cross-device
 * sync of recent molecules, practice progress and settings. Last writer wins per document.
 */
import { create } from 'zustand';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { api, ApiError, tryApi } from './api';
import { studio } from './store';
import type { RecentEntry } from './persist';

interface AccountState {
  user: { id: string; email: string; courseProfile?: string } | null;
  checked: boolean;
  syncing: boolean;
  lastSync: number | null;
  error: string | null;
}

export const useAccount = create<AccountState>(() => ({ user: null, checked: false, syncing: false, lastSync: null, error: null }));

export async function refreshAccount(): Promise<void> {
  const r = await tryApi<{ user: AccountState['user'] }>('/auth/me');
  useAccount.setState({ user: r?.user ?? null, checked: true });
}

export async function signIn(email: string, password: string, mode: 'login' | 'register'): Promise<boolean> {
  useAccount.setState({ error: null });
  try {
    const r = await api<{ user: AccountState['user'] }>(`/auth/${mode}`, { email, password });
    useAccount.setState({ user: r.user, checked: true });
    await syncNow();
    return true;
  } catch (e) {
    useAccount.setState({ error: e instanceof ApiError ? e.message : 'Could not reach the server.' });
    return false;
  }
}

export async function signOut(): Promise<void> {
  await tryApi('/auth/logout', {});
  useAccount.setState({ user: null });
}

export async function deleteAccount(): Promise<boolean> {
  try {
    await api('/account', undefined, { method: 'DELETE' });
    useAccount.setState({ user: null });
    return true;
  } catch {
    return false;
  }
}

export async function exportAccount(): Promise<void> {
  const data = await api<unknown>('/account/export');
  download(`orbital-account-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
}

export function download(filename: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Push local recents/practice/settings, merge what the server has. */
export async function syncNow(): Promise<void> {
  if (!useAccount.getState().user) return;
  useAccount.setState({ syncing: true, error: null });
  try {
    const recents = (await idbGet<RecentEntry[]>('orbital:recents')) ?? [];
    const merged = await api<{ docs: Array<{ id: string; updated: number; body: RecentEntry; deleted: boolean }> }>('/sync/docs', {
      docs: recents.map((r) => ({ id: r.id, updated: r.updated, body: r })),
    });
    const byId = new Map(recents.map((r) => [r.id, r]));
    for (const d of merged.docs) {
      if (d.deleted) byId.delete(d.id);
      else if (!byId.has(d.id) || (byId.get(d.id)!.updated ?? 0) < d.updated) byId.set(d.id, d.body);
    }
    await idbSet('orbital:recents', [...byId.values()].sort((a, b) => b.updated - a.updated).slice(0, 80));
    const practice = await idbGet<Record<string, unknown>>('orbital:practice');
    const pUpdated = Number((practice as { updatedAt?: number } | undefined)?.updatedAt ?? Date.now());
    const p = await api<{ body: Record<string, unknown> }>('/sync/state', { key: 'practice', body: practice ?? {}, updated: pUpdated });
    if (p.body && Object.keys(p.body).length) await idbSet('orbital:practice', p.body);
    await api('/sync/state', { key: 'settings', body: studio().settings as unknown as Record<string, unknown>, updated: Date.now() });
    useAccount.setState({ lastSync: Date.now() });
  } catch (e) {
    useAccount.setState({ error: e instanceof ApiError ? e.message : 'Sync failed — your data is still safe on this device.' });
  } finally {
    useAccount.setState({ syncing: false });
  }
}
