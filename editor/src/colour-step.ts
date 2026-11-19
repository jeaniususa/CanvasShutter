/**
 * Colour near white.
 *
 * Exposure and Highlights/Shadows decide how much brighter or darker each pixel gets, and apply
 * that to all three channels together, which keeps the colour's saturation exactly the same. Real
 * light does not behave like that near white: as a bright colour is pushed toward white its weaker
 * channels catch up and it softens, and when it is brought down it regains its colour.
 *
 * This step re-applies the brightness change channel by channel along the same white-holding
 * curve that Exposure uses (src/exposure.ts). The brightest channel lands exactly where the
 * brightness steps put it; the weaker channels move along the curve by the same internal amount,
 * scaled by UP when brightening and DOWN when darkening. When brightening, the internal amount is
 * measured on the colour's luminance, which stays steady where one channel is clipped and noisy. Because the curve flattens toward white,
 * this mostly affects bright colours; dark and mid colours keep their saturation.
 *
 * Darkening is kept moderate (DOWN 1). The measurements show darkened bright colours gaining more
 * colour than this, in a way that depends on hue; a stronger hue-blind version over-coloured
 * smooth skies. It relies on the debanding in the pipeline to keep JPEG skies smooth.
 *
 * The curve is used only up to SPAN of the way to white. Right next to white it is extremely
 * steep, and photos often have a channel sitting at 254-255 (a sunset's red, for example): there,
 * one level of JPEG noise could swing the colour by several stops and break smooth skies into
 * blotches. Stopping short keeps neighbouring levels within a few hundredths of a stop.
 *
 * Tuned against test-chart measurements of tinted ramps under Exposure, Highlights and Shadows
 * (when brightening: Exposure +1 0.16 stop against 0.45 for leaving saturation unchanged,
 * Highlights +100 0.10 against 0.34, Shadows +100 0.07 against 0.14).
 * Clipped highlights (two channels at white) are handled separately in the pipeline.
 */
import { S, Sinv } from './exposure';

export const UP = 1.8;
/** Strength when darkening (0 = keep saturation as it is). */
export const DOWN = 1.0;
/**
 * Extra darkening strength for colours whose brightest channel is clipped (at white in the photo).
 * That channel was really brighter than the file says, so the colour was really more saturated;
 * as it is darkened it should get richer than its stored ratios suggest (a sunset's yellow-orange
 * ring turns amber, not mustard or olive).
 */
export const CLIPPED_DOWN = 1.5;
/** How far toward white the curve is used (see above). */
export const SPAN = 0.85;
/** Colours whose brightest channel stays below this (linear) are eased out of the step. */
export const FADE_IN = 0.2;
const FLOOR = 1e-6;
const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Brightest-channel range over which a colour counts as clipped (linear). */
const CLIP_FROM = 0.95, CLIP_TO = 1.0;

/**
 * The colour a pixel should have after its brightness changed from `before` to `after` (both
 * linear RGB, `after` being `before` scaled evenly). Returns `after` unchanged when nothing moved.
 */
export function colourAfter(before: [number, number, number], after: [number, number, number]): [number, number, number] {
  const m0 = Math.max(...before), m1 = Math.max(...after);
  if (m0 <= 0 || m1 <= 0 || Math.abs(m1 - m0) < 1e-7) return after;
  const inner = (c: number) => Sinv(Math.min(c, 1) * SPAN);
  // How far the brightness moved. When brightening it is measured on the colour's luminance rather
  // than its brightest channel: a channel at white (jittering by a level of JPEG noise) gets cut
  // off there, which made neighbouring pixels look moved by different amounts and left a mottled
  // texture. Darkening never reaches white, and measuring it on the brightest channel keeps
  // JPEG skies smoother, so it stays that way.
  const y0 = before[0] * LUMA[0] + before[1] * LUMA[1] + before[2] * LUMA[2];
  let k = m1 > m0 ? inner(y0 * m1 / m0) / inner(y0) : inner(m1) / inner(m0);
  const clipped = Math.min(1, Math.max(0, (m0 - CLIP_FROM) / (CLIP_TO - CLIP_FROM)));
  k = Math.pow(k, k >= 1 ? UP : DOWN + CLIPPED_DOWN * clipped * clipped * (3 - 2 * clipped));
  const moved = before.map((c) => S(k * inner(c)));
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
  float y0 = dot(before, vec3(${LUMA.map(f).join(', ')}));
  float k = m1 > m0
    ? curveSinv(min(y0 * m1 / m0, 1.0) * ${f(SPAN)}) / curveSinv(min(y0, 1.0) * ${f(SPAN)})
    : curveSinv(m1 * ${f(SPAN)}) / curveSinv(min(m0, 1.0) * ${f(SPAN)});
  k = pow(k, k >= 1.0 ? ${f(UP)} : ${f(DOWN)} + ${f(CLIPPED_DOWN)} * smoothstep(${f(CLIP_FROM)}, ${f(CLIP_TO)}, m0));
  vec3 b = min(before, vec3(1.0)) * ${f(SPAN)};
  vec3 moved = vec3(curveS(k * curveSinv(b.r)), curveS(k * curveSinv(b.g)), curveS(k * curveSinv(b.b)));
  float top = max(moved.r, max(moved.g, moved.b));
  float w = min(1.0, max(m0, m1) / ${f(FADE_IN)});
  w *= w;
  vec3 keep = max(before / m0, vec3(${FLOOR})), curve = max(moved / top, vec3(${FLOOR}));
  return m1 * pow(keep, vec3(1.0 - w)) * pow(curve, vec3(w));
}`;
