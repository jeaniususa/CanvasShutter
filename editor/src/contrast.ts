/**
 * Contrast around the photo's own mid-tone.
 *
 * Contrast bends tones away from (or toward) a pivot. Instead of a fixed mid-grey, the pivot is
 * taken from the photo: where its average brightness sits within its range of brightness. A photo
 * that is mostly dark pivots lower, a mostly bright one higher, up to one stop either side of 18%
 * grey. That way Contrast spreads the tones the photo actually has.
 *
 * Working in linear light, the pivot m is first moved to the middle with y = x^g (g chosen so that
 * m^g = 1/2, which for m = 0.18 is close to a perceptual encoding). There:
 *  - raising contrast adds a gentle S: a pair of parabolas that push quarter-tones down and
 *    three-quarter-tones up by at most 0.095 at +100, keeping black, the pivot and white fixed;
 *  - lowering contrast pulls tones toward the middle along a smooth curve whose slope at the
 *    pivot is 2^(c/100) (one half at -100), again keeping black and white fixed.
 * The result is moved back with the inverse exponent.
 */

/** Pivot range, in linear light: 18% grey, one stop either way. */
export const PIVOT_DEFAULT = 0.18;
export const PIVOT_MIN = 0.09;
export const PIVOT_MAX = 0.36;
/** Strength of the S at +100 (largest push, in the middle-centred space). */
export const S_AT_FULL = 0.095;

/** Contrast applied to a linear-light level x (0..1), for slider c (-100..100) and pivot m. */
export function contrastCurve(x: number, c: number, pivot = PIVOT_DEFAULT): number {
  c = Math.max(-100, Math.min(100, c));
  if (!c || x <= 0) return Math.max(0, x);
  if (x >= 1) return 1;
  const m = Math.max(PIVOT_MIN, Math.min(PIVOT_MAX, pivot));
  const g = -Math.LN2 / Math.log(m);
  const y = Math.pow(x, g);
  let o: number;
  if (c > 0) {
    const bump = y <= 0.5 ? (4 * (y - 0.25)) ** 2 - 1 : 1 - (4 * (y - 0.75)) ** 2;
    o = y + (S_AT_FULL / 100) * c * bump;
  } else {
    const s = Math.pow(2, c / 100), p = 0.5;
    o = y > p ? p + ((y - p) * (1 - p) * s) / ((1 - p) + (y - p) * (s - 1)) : (y * p) / (-y * (s - 1) + s * p);
  }
  return Math.pow(Math.min(1, Math.max(0, o)), 1 / g);
}

/**
 * The pivot for a photo, from its log-brightness: t is where the average sits between the darkest
 * and brightest 0.01% (-1 = at the dark end, +1 = at the bright end), and the pivot is 0.18·4^t,
 * kept within one stop of 18% grey.
 */
export function pivotFromStats(meanLog: number, lowLog: number, highLog: number): number {
  if (!(highLog > lowLog)) return PIVOT_DEFAULT;
  const t = (2 * meanLog - lowLog - highLog) / (highLog - lowLog);
  return Math.max(PIVOT_MIN, Math.min(PIVOT_MAX, PIVOT_DEFAULT * Math.pow(4, t)));
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const LUT8 = Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** The contrast pivot for a photo given as 8-bit RGBA pixels (a small copy is plenty). */
export function pivotForPixels(rgba: ArrayLike<number>): number {
  const n = Math.floor(rgba.length / 4);
  if (!n) return PIVOT_DEFAULT;
  const logs = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * LUT8[rgba[i * 4]] + 0.7152 * LUT8[rgba[i * 4 + 1]] + 0.0722 * LUT8[rgba[i * 4 + 2]];
    const l = Math.log2(Math.max(y, 2 ** -12));
    logs[i] = l; sum += l;
  }
  logs.sort();
  const at = (q: number) => logs[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
  return pivotFromStats(sum / n, at(0.0001), at(0.9999));
}
