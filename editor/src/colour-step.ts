/**
 * Colour near white.
 *
 * Exposure and Highlights/Shadows decide how much brighter or darker each pixel gets, and apply
 * that to all three channels together, which keeps the colour's saturation exactly the same. Real
 * light does not behave like that near white: as a bright colour is pushed toward white its weaker
 * channels catch up and it softens, and when it is brought back down it regains its colour.
 *
 * This step re-applies the brightness change channel by channel along the same white-holding
 * curve that Exposure uses (src/exposure.ts). The brightest channel lands exactly where the
 * brightness steps put it; the weaker channels move along the curve by the same internal amount,
 * scaled by UP when brightening and DOWN when darkening. Because the curve flattens toward white,
 * this mostly affects bright colours; dark and mid colours keep their saturation.
 *
 * Tuned against test-chart measurements of tinted ramps under Exposure, Highlights and Shadows
 * (saturation error about 0.18 stop over 608 measured channel values, against 0.31 for leaving
 * saturation unchanged).
 */
import { S, Sinv } from './exposure';

export const UP = 0.6;
export const DOWN = 0.8;
/** Colours whose brightest channel stays below this (linear) are eased out of the step. */
export const FADE_IN = 0.2;
const FLOOR = 1e-6;

/**
 * The colour a pixel should have after its brightness changed from `before` to `after` (both
 * linear RGB, `after` being `before` scaled evenly). Returns `after` unchanged when nothing moved.
 */
export function colourAfter(before: [number, number, number], after: [number, number, number]): [number, number, number] {
  const m0 = Math.max(...before), m1 = Math.max(...after);
  if (m0 <= 0 || m1 <= 0 || Math.abs(m1 - m0) < 1e-7) return after;
  let k = Sinv(Math.min(m1, 1)) / Sinv(Math.min(m0, 1));
  k = Math.pow(k, k >= 1 ? UP : DOWN);
  const moved = before.map((c) => S(k * Sinv(Math.min(c, 1))));
  const top = Math.max(...moved);
  const w = Math.min(1, Math.max(m0, m1) / FADE_IN) ** 2;
  return before.map((c, i) => {
    const keep = Math.max(c / m0, FLOOR), curve = Math.max(moved[i] / top, FLOOR);
    return m1 * Math.pow(keep, 1 - w) * Math.pow(curve, w);
  }) as [number, number, number];
}

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** The same step in GLSL (needs curveS / curveSinv from EXPOSURE_GLSL). */
export const COLOUR_STEP_GLSL = `
vec3 colourAfter(vec3 before, vec3 after) {
  float m0 = max(before.r, max(before.g, before.b)), m1 = max(after.r, max(after.g, after.b));
  if (m0 <= 0.0 || m1 <= 0.0 || abs(m1 - m0) < 1e-7) return after;
  float k = curveSinv(min(m1, 1.0)) / curveSinv(min(m0, 1.0));
  k = pow(k, k >= 1.0 ? ${f(UP)} : ${f(DOWN)});
  vec3 b = min(before, vec3(1.0));
  vec3 moved = vec3(curveS(k * curveSinv(b.r)), curveS(k * curveSinv(b.g)), curveS(k * curveSinv(b.b)));
  float top = max(moved.r, max(moved.g, moved.b));
  float w = min(1.0, max(m0, m1) / ${f(FADE_IN)});
  w *= w;
  vec3 keep = max(before / m0, vec3(${FLOOR})), curve = max(moved / top, vec3(${FLOOR}));
  return m1 * pow(keep, vec3(1.0 - w)) * pow(curve, vec3(w));
}`;
