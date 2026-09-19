'use client';
import { useEffect, useState } from 'react';
import { naming } from '@orbital/chem';
import { useStudio, studio, type Settings } from '@/lib/store';
import { deleteAllLocal, exportAllLocal } from '@/lib/persist';
import { deleteAccount, download, exportAccount, refreshAccount, signIn, signOut, syncNow, useAccount } from '@/lib/account';
import { tryApi, type Health } from '@/lib/api';
import { I } from '../ui/icons';

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border bg-panel-raised p-0.5">
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`flex-1 rounded-md px-2 py-1 text-[12px] font-medium ${value === v ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, sub, on, onChange, testid }: { label: string; sub?: string; on: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <span>
        <span className="block text-[13px]">{label}</span>
        {sub && <span className="block text-[11.5px] text-text-3">{sub}</span>}
      </span>
      <button role="switch" aria-checked={on} onClick={() => onChange(!on)} data-testid={testid} className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-border-strong'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-b border-border px-4 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">{title}</h3>
      {children}
    </section>
  );
}

export function SettingsPanel() {
  const settings = useStudio((s) => s.settings);
  const set = (p: Partial<Settings>) => studio().setSettings(p);
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    void tryApi<Health>('/health').then(setHealth);
    void refreshAccount();
  }, []);
  const engine = useStudio((s) => s.analysis?.engine);
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="settings-panel">
      <Block title="Appearance">
        <div className="space-y-1.5">
          <span className="text-[12px] text-text-2">Theme</span>
          <Seg label="Theme" value={settings.theme} onChange={(v) => set({ theme: v })} options={[['system', 'System'], ['dark', 'Dark'], ['light', 'Light']]} />
        </div>
        <div className="space-y-1.5">
          <span className="text-[12px] text-text-2">Motion</span>
          <Seg label="Motion" value={settings.motion} onChange={(v) => set({ motion: v })} options={[['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']]} />
        </div>
        <Toggle label="High contrast" sub="Stronger borders and text" on={settings.contrast === 'high'} onChange={(v) => set({ contrast: v ? 'high' : 'normal' })} testid="toggle-contrast" />
        <Toggle label="Colour-vision-safe atoms" sub="Okabe–Ito palette, symbols always shown" on={settings.colorBlindSafe} onChange={(v) => set({ colorBlindSafe: v })} testid="toggle-cvd" />
      </Block>
      <Block title="Model">
        <Toggle label="Show hydrogens" on={settings.showHydrogens} onChange={(v) => set({ showHydrogens: v })} />
        <Toggle label="Atom labels in 3D" on={settings.showLabels} onChange={(v) => set({ showLabels: v })} />
        <Toggle label="Lone pairs in 2D" on={settings.showLonePairs} onChange={(v) => set({ showLonePairs: v })} />
        <Toggle label="Haptics" sub="Subtle vibration on snaps (touch devices); always paired with a visual" on={settings.haptics} onChange={(v) => set({ haptics: v })} />
        <Toggle label="Chime on Verified" on={settings.sound} onChange={(v) => set({ sound: v })} />
      </Block>
      <Block title="Naming convention">
        <select value={settings.profileId} onChange={(e) => set({ profileId: e.target.value })} className="w-full rounded-lg border border-border bg-panel-raised px-2 py-1.5 text-[13px]" aria-label="Naming convention">
          {naming.PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <p className="text-[11.5px] leading-relaxed text-text-3">Every convention produces names for the same structure; it only changes which accepted form is shown first and used as the model answer.</p>
      </Block>
      <Account />
      <Block title="Your data">
        <p className="text-[12px] leading-relaxed text-text-2">Molecules and progress are saved on this device. Scanned images are never stored. Nothing you type to the tutor is logged.</p>
        <div className="flex gap-1.5">
          <button onClick={async () => download(`orbital-local-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAllLocal(), null, 2), 'application/json')} className="flex-1 rounded-lg border border-border py-1.5 text-[12.5px] hover:border-accent">
            Export all
          </button>
          <DeleteLocal />
        </div>
        <button onClick={() => set({ tourSeen: false })} className="text-[12px] text-accent-strong hover:underline">Show the first-run tips again</button>
      </Block>
      <Block title="About">
        <dl className="mono space-y-0.5 text-[11px] text-text-3">
          <div className="flex justify-between"><dt>Naming engine</dt><dd>{naming.ENGINE_VERSION}</dd></div>
          <div className="flex justify-between"><dt>RDKit (browser)</dt><dd>{engine?.rdkit ?? '—'}</dd></div>
          <div className="flex justify-between"><dt>RDKit (server)</dt><dd>{health?.engine.rdkit ?? 'offline'}</dd></div>
          <div className="flex justify-between"><dt>OPSIN</dt><dd>{health?.engine.opsin ?? 'offline'}</dd></div>
          <div className="flex justify-between"><dt>Tutor</dt><dd>{health ? (health.capabilities.tutor ? 'available' : 'not configured') : 'offline'}</dd></div>
          <div className="flex justify-between"><dt>Quantum jobs</dt><dd>{health ? (health.capabilities.quantum ? 'PySCF' : 'unavailable') : 'offline'}</dd></div>
        </dl>
        <p className="text-[11px] leading-relaxed text-text-3">Name→structure by OPSIN (MIT). Cheminformatics by RDKit (BSD) and OpenChemLib (BSD). Database names from PubChem. 3D by three.js.</p>
      </Block>
    </div>
  );
}

function DeleteLocal() {
  const [armed, setArmed] = useState(false);
  return armed ? (
    <button
      onClick={async () => {
        await deleteAllLocal();
        location.reload();
      }}
      className="flex-1 rounded-lg bg-danger py-1.5 text-[12.5px] font-semibold text-white"
    >
      Confirm delete
    </button>
  ) : (
    <button onClick={() => setArmed(true)} className="flex-1 rounded-lg border border-border py-1.5 text-[12.5px] hover:border-danger">Delete all…</button>
  );
}

function Account() {
  const { user, checked, syncing, lastSync, error } = useAccount();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!checked) return <Block title="Account"><p className="text-[12px] text-text-3">Checking…</p></Block>;
  if (user) {
    return (
      <Block title="Account">
        <div className="flex items-center justify-between text-[13px]">
          <span className="truncate">{user.email}</span>
          <button onClick={() => void signOut()} className="text-[12px] text-text-2 hover:text-text">Sign out</button>
        </div>
        <button onClick={() => void syncNow()} disabled={syncing} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-1.5 text-[12.5px] hover:border-accent disabled:opacity-60">
          <I.Rotate size={13} /> {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {lastSync && <p className="text-[11px] text-text-3">Last synced {new Date(lastSync).toLocaleTimeString()}</p>}
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex gap-1.5">
          <button onClick={() => void exportAccount()} className="flex-1 rounded-lg border border-border py-1.5 text-[12px]">Export account</button>
          {confirmDelete ? (
            <button onClick={() => void deleteAccount()} className="flex-1 rounded-lg bg-danger py-1.5 text-[12px] font-semibold text-white">Delete for good</button>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="flex-1 rounded-lg border border-border py-1.5 text-[12px] hover:border-danger">Delete account…</button>
          )}
        </div>
      </Block>
    );
  }
  return (
    <Block title="Account (optional)">
      <p className="text-[12px] leading-relaxed text-text-2">Only needed to sync molecules and practice across devices.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(email, password, mode);
        }}
        className="space-y-1.5"
      >
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" autoComplete="email" className="w-full rounded-lg border border-border bg-panel-raised px-2.5 py-1.5 text-[13px]" required />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (8+ characters)" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} className="w-full rounded-lg border border-border bg-panel-raised px-2.5 py-1.5 text-[13px]" required />
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <div className="flex gap-1.5">
          <button type="submit" className="flex-1 rounded-lg bg-accent py-1.5 text-[12.5px] font-semibold text-accent-ink">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="rounded-lg px-2 text-[12px] text-text-2 hover:text-text">
            {mode === 'login' ? 'New here?' : 'Have an account?'}
          </button>
        </div>
      </form>
    </Block>
  );
}
