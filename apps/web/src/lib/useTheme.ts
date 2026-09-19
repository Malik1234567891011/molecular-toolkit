'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { useStudio } from './store';

const LIGHT = '(prefers-color-scheme: light)';

function subscribeSystem(cb: () => void) {
  const mq = window.matchMedia(LIGHT);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/**
 * Resolved theme, kept in sync with settings and the OS preference. Hydration uses the server's
 * value ('dark') and then switches, so theme-dependent inline colours never mismatch the HTML.
 */
export function useResolvedTheme(): 'dark' | 'light' {
  const pref = useStudio((s) => s.settings.theme);
  const sys = useSyncExternalStore(subscribeSystem, () => (window.matchMedia(LIGHT).matches ? 'light' : 'dark'), () => 'dark' as const);
  return pref === 'system' ? sys : pref;
}

export function useApplyTheme(): void {
  const theme = useResolvedTheme();
  const motion = useStudio((s) => s.settings.motion);
  const contrast = useStudio((s) => s.settings.contrast);
  const pref = useStudio((s) => s.settings.theme);
  useEffect(() => {
    const el = document.documentElement;
    // Read the real theme here: during hydration `theme` is still the server's placeholder.
    const actual = pref === 'system' ? (window.matchMedia(LIGHT).matches ? 'light' : 'dark') : pref;
    el.dataset.theme = actual;
    el.dataset.resolvedTheme = actual;
    const reduced = motion === 'reduced' || (motion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (reduced) el.dataset.motion = 'reduced';
    else delete el.dataset.motion;
    if (contrast === 'high') el.dataset.contrast = 'high';
    else delete el.dataset.contrast;
    try {
      localStorage.setItem('orbital:ui', JSON.stringify({ theme: pref, motion, contrast }));
    } catch {
      /* ignore */
    }
  }, [theme, motion, contrast, pref]);
}

export function prefersReducedMotion(): boolean {
  const m = useStudio.getState().settings.motion;
  if (m === 'reduced') return true;
  if (m === 'full') return false;
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
