/**
 * Exposure that holds white.
 *
 * Instead of multiplying the photo by 2^stops (which pushes bright areas past white when raising
 * exposure and greys out white when lowering it), exposure works on an open-ended internal scale:
 *
 *   out = S(2^stops * S⁻¹(in)),   S(x) = (x^q / (1 + x^q))^(p/q)
 *
 * S maps 0..infinity onto 0..1 and only reaches 1 at infinity, so when brightening pure white
 * never moves and nothing can be pushed past white. When darkening, white sits just inside the
 * curve (darkenWhite), so it barely moves at normal settings (0.02 stop at -1) and comes down
 * smoothly with everything else at strong settings, instead of staying at full white while the
 * tones just below it drop away (which would draw a hard edge around blown highlights). In the darks S behaves like x^p, so one stop of
 * exposure moves dark tones about p stops; the change tapers smoothly toward white. When
 * brightening, the change also fades out in the deepest blacks (below about TOE in linear light),
 * so pure black is not lifted into noise.
 *
 * The constants were tuned against test-chart measurements of +1 and -1 stop of exposure
 * (about 0.09 stop typical error over 46 measured tones).
 */
export const P = 1.36;
export const Q = 1.95;
export const TOE = 0.002;
/** Inputs at or above this are treated as white. */
const NEAR_WHITE = 0.999999;
/** Where white sits on the curve when darkening by `stops` (negative): 0.995 down to -1, easing to 0.9 at -5. */
export const darkenWhite = (stops: number) => 0.995 - 0.095 * Math.min(1, Math.max(0, (-stops - 1) / 4));

const S = (x: number) => Math.pow(Math.pow(x, Q) / (1 + Math.pow(x, Q)), P / Q);
const Sinv = (v: number) => { const r = Math.pow(Math.min(v, NEAR_WHITE), Q / P); return Math.pow(r / (1 - r), 1 / Q); };

/** A linear-light level (0..1) after `stops` of exposure. 0 stays 0; 1 stays 1 when brightening. */
export function exposeLevel(v: number, stops: number): number {
  if (!stops || v <= 0) return Math.max(0, v);
  v = Math.min(v, 1);
  if (stops < 0) { const w = darkenWhite(stops); return S(Math.pow(2, stops) * Sinv(v * w)) / w; }
  const out = S(Math.pow(2, stops) * Sinv(v));
  // Brightening: fade the change out toward black.
  return v * Math.pow(out / v, 1 - Math.exp(-v / TOE));
}

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/**
 * The same curve in GLSL, applied to a colour by its brightest channel so hue is kept and no
 * channel can pass white. Built from the same constants as exposeLevel.
 */
export const EXPOSURE_GLSL = `
float exposeLevel(float v, float stops) {
  if (stops == 0.0 || v <= 0.0) return max(v, 0.0);
  v = min(v, 1.0);
  float w = stops < 0.0 ? 0.995 - 0.095 * clamp((-stops - 1.0) / 4.0, 0.0, 1.0) : 1.0; // darkenWhite
  float r = pow(min(v * w, ${f(NEAR_WHITE)}), ${f(Q / P)});
  float x = pow(r / (1.0 - r), ${f(1 / Q)}) * exp2(stops);
  float xq = pow(x, ${f(Q)});
  float o = pow(xq / (1.0 + xq), ${f(P / Q)}) / w;
  if (stops < 0.0) return o;
  return v * pow(o / v, 1.0 - exp(-v / ${f(TOE)}));
}
vec3 expose(vec3 c, float stops) {
  float m = max(c.r, max(c.g, c.b));
  if (stops == 0.0 || m <= 0.0) return c;
  // Colours already past white (e.g. after white balance) move like white does.
  float mm = min(m, 1.0);
  return c * (exposeLevel(mm, stops) / mm);
}`;
