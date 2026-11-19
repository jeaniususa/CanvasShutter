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
 * curve (darkenWhite), so it barely moves at small settings (none at -0.5, half a stop at -1) and
 * comes down with everything else at strong settings. Holding it fully would make the curve so
 * steep next to white that one level of a JPEG could become eight, and the edge of a blown area
 * (a flat patch at 255) would show as a hard outline; the table keeps that stretch to about two
 * levels at every setting. In the darks S behaves like x^p, so one stop of
 * exposure moves dark tones about p stops; the change tapers smoothly toward white. When
 * brightening, the change also fades out in the deepest blacks (below about TOE in linear light),
 * so pure black is not lifted into noise.
 *
 * The constants were tuned against test-chart measurements of +1 and -1 stop of exposure (about
 * 0.04 stop typical error at +1; 0.17 at -1, where white is deliberately let down for smoothness).
 */
export const P = 1.36;
export const Q = 1.95;
export const TOE = 0.002;
/** Inputs at or above this are treated as white. */
const NEAR_WHITE = 0.999999;
/**
 * Where white sits on the curve when darkening by `stops` (negative), as [stops, position] points
 * joined by straight lines. Chosen so one input level near white never becomes more than about
 * two output levels, while darkening stays steady all the way down.
 */
export const DARKEN_WHITE: ReadonlyArray<readonly [number, number]> = [[0, 1], [-0.5, 0.999], [-1, 0.835], [-1.5, 0.802], [-2, 0.807], [-3, 0.843], [-4, 0.882], [-5, 0.913]];
export function darkenWhite(stops: number): number {
  const t = DARKEN_WHITE, e = Math.max(t[t.length - 1][0], Math.min(0, stops));
  for (let i = 1; i < t.length; i++) if (e >= t[i][0]) { const [x0, y0] = t[i - 1], [x1, y1] = t[i]; return y0 + (y1 - y0) * (e - x0) / (x1 - x0); }
  return t[t.length - 1][1];
}

/** The curve S (internal scale -> 0..1) and its inverse. Shared with src/colour-step.ts. */
export const S = (x: number) => Math.pow(Math.pow(x, Q) / (1 + Math.pow(x, Q)), P / Q);
export const Sinv = (v: number) => { const r = Math.pow(Math.min(v, NEAR_WHITE), Q / P); return Math.pow(r / (1 - r), 1 / Q); };

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
const float DW_X[${DARKEN_WHITE.length}] = float[](${DARKEN_WHITE.map(([x]) => f(x)).join(', ')});
const float DW_Y[${DARKEN_WHITE.length}] = float[](${DARKEN_WHITE.map(([, y]) => f(y)).join(', ')});
float darkenWhite(float stops) {
  float e = clamp(stops, DW_X[${DARKEN_WHITE.length - 1}], 0.0);
  for (int i = 1; i < ${DARKEN_WHITE.length}; i++) if (e >= DW_X[i]) return mix(DW_Y[i - 1], DW_Y[i], (e - DW_X[i - 1]) / (DW_X[i] - DW_X[i - 1]));
  return DW_Y[${DARKEN_WHITE.length - 1}];
}
float curveS(float x) { float xq = pow(x, ${f(Q)}); return pow(xq / (1.0 + xq), ${f(P / Q)}); }
float curveSinv(float v) { float r = pow(clamp(v, 0.0, ${f(NEAR_WHITE)}), ${f(Q / P)}); return pow(r / (1.0 - r), ${f(1 / Q)}); }
float exposeLevel(float v, float stops) {
  if (stops == 0.0 || v <= 0.0) return max(v, 0.0);
  v = min(v, 1.0);
  float w = stops < 0.0 ? darkenWhite(stops) : 1.0;
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
