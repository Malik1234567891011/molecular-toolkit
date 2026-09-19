'use client';
/**
 * Optional soft chime when a name is Verified (spec §15 "Sound & haptics": off by default). The
 * Verified badge is always the visual twin.
 */
import { useStudio } from './store';

let ctx: AudioContext | null = null;

export function chime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.01;
    // Two soft sine partials a fifth-plus apart, short bell-like decay.
    for (const [freq, delay, gain] of [[880, 0, 0.05], [1318.5, 0.085, 0.035]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(gain, t + delay + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.7);
      osc.connect(g).connect(ctx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.75);
    }
  } catch {
    /* no audio available */
  }
}

/** Chime once per newly verified structure while the setting is on (one listener however often it's mounted). */
let watchers = 0;
let unsubscribe: (() => void) | null = null;
let lastChimed = '';

export function watchVerifiedChime(): () => void {
  watchers++;
  unsubscribe ??= useStudio.subscribe((s) => {
    const v = s.verification;
    if (!s.settings.sound || !v || v.status !== 'done' || !v.primary?.verified || v.inchiKey === lastChimed) return;
    lastChimed = v.inchiKey;
    chime();
  });
  return () => {
    if (--watchers > 0) return;
    unsubscribe?.();
    unsubscribe = null;
  };
}
