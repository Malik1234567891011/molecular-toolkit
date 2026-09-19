'use client';
/** Tiny event bus for imperative UI signals (camera fit, haptics, focus). */
type Handler = (payload?: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

export const bus = {
  on(event: string, h: Handler): () => void {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(h);
    return () => handlers.get(event)?.delete(h);
  },
  emit(event: string, payload?: unknown): void {
    for (const h of handlers.get(event) ?? []) h(payload);
  },
};

/** Subtle haptics on touch devices, always paired with a visual (spec §6/§15). */
export function haptic(kind: 'snap' | 'boundary' | 'success'): void {
  try {
    if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
    navigator.vibrate(kind === 'snap' ? 8 : kind === 'boundary' ? [12, 40, 12] : [10, 30, 18]);
  } catch {
    /* ignore */
  }
}
