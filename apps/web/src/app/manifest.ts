import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Orbital — molecular studio',
    short_name: 'Orbital',
    description: 'Build or find any molecule, see it in 3D, and learn its IUPAC name with every decision explained on the molecule.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0b0e14',
    theme_color: '#0b0e14',
    categories: ['education', 'science'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Practice', url: '/?panel=practice', description: 'Next practice problem' },
      { name: 'Scan a structure', url: '/?scan=1', description: 'Recognize a drawn structure from a photo' },
    ],
  };
}
