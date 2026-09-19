/* Orbital service worker (spec §17 "PWA"): the studio, its chemistry engines and fonts work offline.
 * - Pages: network first, falling back to the cached copy (or the studio shell).
 * - Hashed build assets (/_next/static): cache first — their URLs change when they change.
 * - Chemistry engines (/workers, /rdkit, /ocl) and icons: stale-while-revalidate.
 * - /api is never cached: naming verification, the tutor and sharing need the network and say so.
 */
const VERSION = 'orbital-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/rdkit/RDKit_minimal.js', '/rdkit/RDKit_minimal.wasm', '/ocl/resources.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (hit) {
    event.waitUntil(refresh);
    return hit;
  }
  return (await refresh) || Response.error();
}

// The first visit loads its scripts before this worker controls the page; the page sends their URLs
// so the very first session already works offline.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'cache-urls' || !Array.isArray(data.urls)) return;
  const ok = (u) => {
    try {
      const url = new URL(u, self.location.origin);
      return url.origin === self.location.origin && /^\/(_next\/static|workers|rdkit|ocl)\//.test(url.pathname);
    } catch {
      return false;
    }
  };
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      Promise.all(
        data.urls.filter(ok).map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => undefined))),
      ),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (/^\/(workers|rdkit|ocl)\//.test(url.pathname) || /\.(svg|png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});
