'use client';
import { useEffect, useState } from 'react';
import { useStudio } from './store';

function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Resolved theme, kept in sync with settings and the OS preference; mirrors onto <html>. */
export function useResolvedTheme(): 'dark' | 'light' {
  const pref = useStudio((s) => s.settings.theme);
  const [sys, setSys] = useState<'dark' | 'light'>(() => (typeof document !== 'undefined' && document.documentElement.dataset.resolvedTheme === 'light' ? 'light' : systemTheme()));
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => setSys(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return pref === 'system' ? sys : pref;
}

export function useApplyTheme(): void {
  const theme = useResolvedTheme();
  const motion = useStudio((s) => s.settings.motion);
  const contrast = useStudio((s) => s.settings.contrast);
  const pref = useStudio((s) => s.settings.theme);
  useEffect(() => {
    const el = document.documentElement;
    el.dataset.theme = theme;
    el.dataset.resolvedTheme = theme;
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
