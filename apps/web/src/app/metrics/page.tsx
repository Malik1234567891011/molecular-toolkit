import type { Metadata } from 'next';
import { MetricsDashboard } from '@/components/metrics/MetricsDashboard';

export const metadata: Metadata = {
  title: 'Orbital — product metrics',
  description: 'Privacy-preserving product metrics for Orbital (event names only; no names, molecules or conversations).',
  robots: { index: false },
};

export default function MetricsPage() {
  return <MetricsDashboard />;
}
