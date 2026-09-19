import type { NextConfig } from 'next';

const API = process.env.ORBITAL_API_URL ?? 'http://127.0.0.1:8710';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@orbital/chem'],
  devIndicators: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API}/v1/:path*` }];
  },
  async redirects() {
    return [{ source: '/guide', destination: '/?guide', permanent: false }];
  },
  async headers() {
    return [
      { source: '/rdkit/:file*', headers: [{ key: 'Cache-Control', value: 'public, max-age=604800' }] },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ];
  },
};

export default config;
