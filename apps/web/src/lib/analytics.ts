'use client';
/** Privacy-preserving product analytics (spec §22): event names + small scalar props only. */
const queue: Array<{ name: string; at: number; props: Record<string, string | number | boolean> }> = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function sessionId(): string {
  try {
    let s = sessionStorage.getItem('orbital:session');
    if (!s) {
      s = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('orbital:session', s);
    }
    return s;
  } catch {
    return 'anon';
  }
}

export function track(name: string, props: Record<string, string | number | boolean> = {}): void {
  queue.push({ name, at: Date.now() / 1000, props });
  clearTimeout(timer);
  timer = setTimeout(flush, 2000);
}

function flush(): void {
  if (!queue.length || typeof navigator === 'undefined' || !navigator.onLine) return;
  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({ session: sessionId(), events });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/api/v1/analytics/events', new Blob([body], { type: 'application/json' }));
    else void fetch('/api/v1/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
  } catch {
    /* analytics never breaks the app */
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
