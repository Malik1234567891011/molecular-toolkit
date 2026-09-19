import type { Metadata } from 'next';
import { ShareView } from '@/components/share/ShareView';

const API = process.env.ORBITAL_API_URL ?? 'http://127.0.0.1:8710';

async function fetchTitle(id: string): Promise<string | null> {
  try {
    const r = await fetch(`${API}/v1/shares/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { title: string | null; snapshot: { name?: string } };
    return j.snapshot?.name ?? j.title ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const name = await fetchTitle(id);
  return {
    title: name ? `${name} — Orbital` : 'Shared molecule — Orbital',
    description: name ? `${name} in 3D, with its verified name — open it, rotate it, or put it on your desk in AR.` : 'A molecule shared from Orbital.',
  };
}

export default async function SharePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ar?: string }> }) {
  const { id } = await params;
  const { ar } = await searchParams;
  return <ShareView id={id} arFirst={ar === '1'} />;
}
