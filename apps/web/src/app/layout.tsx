import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Orbital — molecular studio',
  description: 'Build or find any molecule, see it in 3D, and move between structure and IUPAC name with every naming decision explained on the molecule.',
  applicationName: 'Orbital',
  appleWebApp: { capable: true, title: 'Orbital', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
    { media: '(prefers-color-scheme: light)', color: '#f6f4ef' },
  ],
};

const themeBoot = `(function(){try{var s=JSON.parse(localStorage.getItem('orbital:ui')||'{}');var t=s.theme||'system';var d=t==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):t;document.documentElement.dataset.theme=d;document.documentElement.dataset.resolvedTheme=d;if(s.motion==='reduced')document.documentElement.dataset.motion='reduced';if(s.contrast==='high')document.documentElement.dataset.contrast='high';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
