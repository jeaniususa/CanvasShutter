import type { Levels } from './state';

export const GAMMA_MIN = 0.1;
export const GAMMA_MAX = 9.99;
/** Black and white points always stay at least this far apart. */
export const MIN_GAP = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Maps a 0..1 input through one channel's levels: stretch black..white to 0..1, then apply the
 * midtone gamma. The shader in gl/pipeline.ts uses the same formula.
 */
export function levelsFn(l: Levels): (x: number) => number {
  const span = l.white - l.black;
  return (x) => Math.pow(clamp((x * 255 - l.black) / span, 0, 1), 1 / l.gamma);
}

/** Where the midtone handle sits between the black and white handles (0..1) for a given gamma. */
export const gammaToFraction = (gamma: number) => Math.pow(0.5, gamma);

/** Gamma for a midtone handle placed at `fraction` of the way from black to white. */
export function fractionToGamma(fraction: number): number {
  const g = Math.log(clamp(fraction, 1e-4, 1 - 1e-4)) / Math.log(0.5);
  return Number(clamp(g, GAMMA_MIN, GAMMA_MAX).toFixed(2));
}

export function setBlack(l: Levels, v: number) { l.black = clamp(Math.round(v), 0, l.white - MIN_GAP); }
export function setWhite(l: Levels, v: number) { l.white = clamp(Math.round(v), l.black + MIN_GAP, 255); }
export function setGamma(l: Levels, g: number) { l.gamma = Number(clamp(g, GAMMA_MIN, GAMMA_MAX).toFixed(2)); }

/**
 * Picks black and white points that discard a small share (0.1% by default) of the darkest and
 * brightest pixels in a 256-bin histogram.
 */
export function autoLevels(bins: ArrayLike<number>, clip = 0.001): { black: number; white: number } {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins[i];
  if (!total) return { black: 0, white: 255 };
  const limit = total * clip;
  let black = 0, white = 255, sum = 0;
  for (let i = 0; i < 256; i++) { sum += bins[i]; if (sum > limit) { black = i; break; } }
  sum = 0;
  for (let i = 255; i >= 0; i--) { sum += bins[i]; if (sum > limit) { white = i; break; } }
  if (white - black < MIN_GAP) return { black: 0, white: 255 };
  return { black, white };
}
