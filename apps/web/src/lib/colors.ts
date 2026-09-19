import { element } from '@orbital/chem';

/** CPK-like atom colours adjusted for contrast per theme (spec §15). Carbon is never pure black on dark. */
const DARK: Record<string, string> = {
  C: '#5b6273', H: '#eef1f6', N: '#4f7bff', O: '#ff4d4d', F: '#62e39a', Cl: '#3ccf6e', Br: '#c0573a', I: '#a45cf0',
  S: '#f2cc4c', P: '#ff9533', B: '#ffb7a8', Si: '#e8c49a', Na: '#b07cf5', K: '#9a5cf0', Li: '#d39cff', Mg: '#86e05a', Se: '#ffb030',
};
const LIGHT: Record<string, string> = {
  C: '#2e333d', H: '#ffffff', N: '#2451e0', O: '#e0272f', F: '#1fa860', Cl: '#18a34a', Br: '#9c3a22', I: '#7a2fd0',
  S: '#d6a300', P: '#e06c00', B: '#e08f7c', Si: '#b89468', Na: '#8a4fe0', K: '#7234d0', Li: '#b46ff0', Mg: '#4ea52a', Se: '#e08a00',
};
/** Okabe–Ito based palette for colour-vision-safe mode (atoms also always show symbols there). */
const CVD: Record<string, string> = { C: '#5f6570', H: '#f0f0f0', N: '#0072b2', O: '#d55e00', F: '#009e73', Cl: '#009e73', Br: '#cc79a7', I: '#cc79a7', S: '#f0e442', P: '#e69f00' };

export function atomColor(el: string, theme: 'dark' | 'light', cvd = false): string {
  if (cvd && CVD[el]) return CVD[el];
  const t = theme === 'dark' ? DARK : LIGHT;
  if (t[el]) return t[el];
  try {
    return `#${element(el).color}`;
  } catch {
    return '#ff1493';
  }
}

/** Substituent / token palette: distinct, accessible hues (never the accent, which means "Verified"). */
export const SUB_PALETTE = ['#f59f00', '#12b886', '#4dabf7', '#f06595', '#94d82d', '#22b8cf', '#ff922b', '#b197fc'];

export function subColor(i: number): string {
  return SUB_PALETTE[i % SUB_PALETTE.length];
}
