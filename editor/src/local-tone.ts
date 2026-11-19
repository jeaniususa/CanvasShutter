/**
 * Local Highlights and Shadows.
 *
 * Each pixel is adjusted by how bright it is AND by how bright its surroundings are, so the same
 * tone can be treated differently in different parts of the photo. A dark doorway in a bright
 * street is lifted more than the same dark tone in a night scene, and a bright window in a dark
 * room is pulled down more than the same tone in a bright sky. This keeps detail in both ends
 * without flattening the whole picture the way a single global curve does.
 *
 * Everything works in stops: L is a pixel's brightness as log2 of linear light (0 = white) and B
 * is the same for its surroundings (a wide blur of the photo's log-brightness, see SURROUND_SIGMA).
 * The result is a change in stops applied to all three channels together, so colours keep their hue.
 *
 * The constants were tuned against test-chart measurements of how strong this kind of adjustment
 * should be at each tone and surround (about 0.14 stop typical error over 72 measured points).
 */

/** Width of the surroundings blur, as a fraction of the photo's longer side. */
export const SURROUND_SIGMA = 0.22;
/** Darkest brightness considered, in stops below white. Pure black is treated as this. */
export const FLOOR_STOPS = -12;
/** Largest "darker/brighter than the surroundings" difference that still adds strength. */
export const MAX_REL = 6;

export const K = {
  // Shadows: strongest in deep darks, fading out toward white.
  sPivot: -0.8, sSpan: 6, sLift: 1.67, sRel: 0.37, sDarken: 2.08, sFade: 0.7,
  // Highlights: strongest in bright tones, with a small even part across the range.
  hPivot: -4.45, hSpan: 3.4, hBase: 0.28, hRecover: 0.33, hRel: 0.24, hBoost: 1.0, hFade: 0.82,
} as const;

const sat = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Change in stops for a pixel at log-brightness `L` whose surroundings are at `B`, for slider
 * values `highlights` and `shadows` (-100..100).
 */
export function localToneDelta(L: number, B: number, highlights: number, shadows: number): number {
  L = Math.max(FLOOR_STOPS, Math.min(0, L));
  const s = Math.max(-1, Math.min(1, shadows / 100)), h = Math.max(-1, Math.min(1, highlights / 100));
  const toWhite = 1 - Math.pow(2, L); // 0 at white, close to 1 in the darks
  let d = 0;
  if (s) {
    const dark = sat((K.sPivot - L) / K.sSpan);
    // Lifting: more for pixels darker than their surroundings. Darkening: by tone only.
    const amount = s > 0 ? K.sLift * dark + K.sRel * Math.min(Math.max(B - L, 0), MAX_REL) * (0.3 + 0.7 * dark) : K.sDarken * dark;
    d += s * amount * Math.pow(toWhite, K.sFade);
  }
  if (h) {
    const bright = sat((L - K.hPivot) / K.hSpan);
    if (h < 0) d += h * (K.hBase + K.hRecover * bright + K.hRel * Math.min(Math.max(L - B, 0), MAX_REL) * bright);
    else d += h * (K.hBase + K.hBoost * bright) * Math.pow(toWhite, K.hFade);
  }
  return d;
}

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/** The same function in GLSL, built from the same constants so the two can never drift apart. */
export const LOCAL_TONE_GLSL = `
float localToneDelta(float L, float B, float hl, float sh) {
  L = clamp(L, ${f(FLOOR_STOPS)}, 0.0);
  hl = clamp(hl / 100.0, -1.0, 1.0);
  sh = clamp(sh / 100.0, -1.0, 1.0);
  float toWhite = 1.0 - exp2(L);
  float d = 0.0;
  if (sh != 0.0) {
    float dark = clamp((${f(K.sPivot)} - L) / ${f(K.sSpan)}, 0.0, 1.0);
    float amount = sh > 0.0
      ? ${f(K.sLift)} * dark + ${f(K.sRel)} * min(max(B - L, 0.0), ${f(MAX_REL)}) * (0.3 + 0.7 * dark)
      : ${f(K.sDarken)} * dark;
    d += sh * amount * pow(toWhite, ${f(K.sFade)});
  }
  if (hl != 0.0) {
    float bright = clamp((L - ${f(K.hPivot)}) / ${f(K.hSpan)}, 0.0, 1.0);
    if (hl < 0.0) d += hl * (${f(K.hBase)} + ${f(K.hRecover)} * bright + ${f(K.hRel)} * min(max(L - B, 0.0), ${f(MAX_REL)}) * bright);
    else d += hl * (${f(K.hBase)} + ${f(K.hBoost)} * bright) * pow(toWhite, ${f(K.hFade)});
  }
  return d;
}`;
