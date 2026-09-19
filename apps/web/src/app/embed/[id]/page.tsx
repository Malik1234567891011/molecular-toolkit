import { ShareView } from '@/components/share/ShareView';

export const metadata = { title: 'Orbital embed', robots: { index: false } };

export default async function EmbedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShareView id={id} embed />;
}
