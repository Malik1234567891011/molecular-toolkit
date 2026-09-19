'use client';
import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(cb: () => void) {
  const m = matchMedia(QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}

/** Phone layout (spec §6 "Mobile"): below Tailwind's md breakpoint. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(QUERY).matches, () => false);
}
