'use client';
/** Privacy-preserving product analytics (spec §22): event names + small scalar props only. */
const queue: Array<{ name: string; at: number; props: Record<string, string | number | boolean> }> = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * A random id kept in this browser's storage, so "50 visits" can be read as "6 people, twice a
 * week each". It is not a name, not an account, never leaves this site, and clearing browser
 * data resets it.
 */
function visitorId(): string {
  try {
    let v = localStorage.getItem('orbital:visitor');
    if (!v) {
      v = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('orbital:visitor', v);
    }
    return v;
  } catch {
    return 'anon';
  }
}

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

/**
 * Test runs and scripted browsers would otherwise show up as a crowd of one-visit strangers:
 * every automated context starts with empty storage, so each one looks like a new person.
 * `navigator.webdriver` is set by Playwright, Puppeteer and Selenium; the flag is for anything
 * else (our own e2e runner sets it before the page loads).
 */
function automated(): boolean {
  try {
    return navigator.webdriver === true || localStorage.getItem('orbital:analytics') === 'off';
  } catch {
    return typeof navigator !== 'undefined' && navigator.webdriver === true;
  }
}

export function track(name: string, props: Record<string, string | number | boolean> = {}): void {
  if (automated()) return;
  queue.push({ name, at: Date.now() / 1000, props });
  clearTimeout(timer);
  timer = setTimeout(flush, 2000);
}

function flush(): void {
  if (!queue.length || typeof navigator === 'undefined' || !navigator.onLine) return;
  const events = queue.splice(0, queue.length);
  const body = JSON.stringify({ session: sessionId(), visitor: visitorId(), events });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/api/v1/analytics/events', new Blob([body], { type: 'application/json' }));
    else void fetch('/api/v1/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true });
  } catch {
    /* analytics never breaks the app */
  }
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
