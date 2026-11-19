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
 * Recovery happens in steps. For Shadows + and Highlights -, the gap between a pixel and a level
 * set by its surroundings is closed in four steps that fill one after another as the slider moves:
 * the first quarter of the slider completes the first step, the next quarter the second, and so
 * on, with later steps stronger than earlier ones. Small settings stay gentle; large ones keep
 * recovering instead of running out, and using both sliders together does not double up.
 *
 * The constants were tuned against test-chart measurements of how strong this kind of adjustment
 * should be at each tone, surround and slider setting (about 0.14 stop typical error over 344
 * measured points, using the surroundings exactly as this app measures them, and including both
 * sliders used together), with the rule that tones never swap order.
 */

/** Width of the surroundings blur, as a fraction of the photo's longer side. */
export const SURROUND_SIGMA = 0.22;
/** Darkest brightness considered, in stops below white. Pure black is treated as this. */
export const FLOOR_STOPS = -12;
/** Largest change each recovery may make, in stops (approached smoothly, never passed). */
export const MAX_LIFT = 5;
export const MAX_PULL = 4;

/**
 * How strongly the surroundings count. The blurred brightness map is gentler than what is measured,
 * so its distance from a typical level (SURROUND_REF stops) is scaled up by this much.
 */
export const SURROUND_GAIN = 2.243;
export const SURROUND_REF = -3;

export const K = {
  // Shadows. Lift: close the gap below (surroundings + sOff) in steps, plus a lift that grows into the darks.
  sOff: 0.602, sStep: 0.042, sGrow: 1.477, sLift: 2.593,
  sPivot: -1.433, sSpan: 8.196, sDarken: 3.308, sFade: 0.88,
  // Highlights -: close the gap above (hMix * surroundings + hOff) in steps, easing off near white
  // unless the pixel is far brighter than its surroundings, plus an even part that grows with brightness.
  hMix: 0.495, hOff: -0.489, hStep: 0.056, hGrow: 2.004, hEase: 0.917,
  nPivot: -1.603, nSpan: 2.182, nShape: 0.677, hEven: 0.75, eLo: -12.788, eSpan: 11.612,
  // Highlights +: brighten, strongest in bright tones, fading to nothing at white (hFade 1 keeps the
  // fade gentle enough that tones near white never swap order).
  hPivot: -4.45, hSpan: 3.4, hBase: 0.28, hBoost: 1.0, hFade: 1.0,
} as const;

/** Softness, in stops, of the edge where a pixel starts to count as darker/brighter than its target. */
const SOFT = 0.6;
const sat = (x: number) => Math.min(1, Math.max(0, x));
/** Smooth max(z, 0). */
const softGap = (z: number) => (z > 20 * SOFT ? z : SOFT * Math.log1p(Math.exp(z / SOFT)));
/** Identity for small changes, approaching but never passing `m`. */
const limit = (d: number, m: number) => d / Math.pow(1 + (d / m) ** 4, 0.25);

/**
 * Share of a gap still open after the recovery steps for slider amount `a` (0..1). Step k fills
 * as the slider goes from k/4 to (k+1)/4 and closes `step * grow^k` of what is left (at most 95%).
 */
export function remaining(a: number, step: number, grow: number): number {
  let keep = 1;
  for (let k = 0; k < 4; k++) keep *= 1 - Math.min(0.95, step * grow ** k) * sat(4 * a - k);
  return keep;
}

/**
 * Change in stops for a pixel at log-brightness `L` whose surroundings are at `B`, for slider
 * values `highlights` and `shadows` (-100..100).
 */
export function localToneDelta(L: number, B: number, highlights: number, shadows: number): number {
  L = Math.max(FLOOR_STOPS, Math.min(0, L));
  B = SURROUND_REF + SURROUND_GAIN * (B - SURROUND_REF);
  const s = Math.max(-1, Math.min(1, shadows / 100)), h = Math.max(-1, Math.min(1, highlights / 100));
  const toWhite = 1 - Math.pow(2, L); // 0 at white, close to 1 in the darks
  let d = 0;
  if (s) {
    const dark = sat((K.sPivot - L) / K.sSpan);
    if (s > 0) {
      const gap = softGap(B + K.sOff - L);
      d += limit((gap * (1 - remaining(s, K.sStep, K.sGrow)) + s * K.sLift * dark) * Math.pow(toWhite, K.sFade), MAX_LIFT);
    } else d += s * K.sDarken * dark * Math.pow(toWhite, K.sFade);
  }
  if (h < 0) {
    const gap = softGap(L - (K.hMix * B + K.hOff));
    const bright = sat((L - K.nPivot) / K.nSpan);
    const ease = 1 - (1 - toWhite) * Math.exp(-gap / K.hEase);
    const pull = gap * (1 - remaining(-h, K.hStep, K.hGrow)) * (K.nShape + (1 - K.nShape) * bright) * ease;
    d -= limit(pull - h * K.hEven * sat((L - K.eLo) / K.eSpan), MAX_PULL);
  } else if (h > 0) {
    const bright = sat((L - K.hPivot) / K.hSpan);
    d += h * (K.hBase + K.hBoost * bright) * Math.pow(toWhite, K.hFade);
  }
  return d;
}

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

/**
 * The same function in GLSL, built from the same constants so the two can never drift apart.
 * (limitTo squares instead of calling pow on d / m, because GLSL's pow is not defined for negative bases.)
 */
export const LOCAL_TONE_GLSL = `
float softGap(float z) { return z > ${f(20 * SOFT)} ? z : ${f(SOFT)} * log(1.0 + exp(z / ${f(SOFT)})); }
float limitTo(float d, float m) { float x = d / m; x *= x; return d / pow(1.0 + x * x, 0.25); }
float remaining(float a, float st, float grow) {
  float keep = 1.0;
  for (int k = 0; k < 4; k++) keep *= 1.0 - min(0.95, st * pow(grow, float(k))) * clamp(4.0 * a - float(k), 0.0, 1.0);
  return keep;
}
float localToneDelta(float L, float B, float hl, float sh) {
  L = clamp(L, ${f(FLOOR_STOPS)}, 0.0);
  B = ${f(SURROUND_REF)} + ${f(SURROUND_GAIN)} * (B - ${f(SURROUND_REF)});
  hl = clamp(hl / 100.0, -1.0, 1.0);
  sh = clamp(sh / 100.0, -1.0, 1.0);
  float toWhite = 1.0 - exp2(L);
  float d = 0.0;
  if (sh != 0.0) {
    float dark = clamp((${f(K.sPivot)} - L) / ${f(K.sSpan)}, 0.0, 1.0);
    if (sh > 0.0) {
      float gap = softGap(B + ${f(K.sOff)} - L);
      d += limitTo((gap * (1.0 - remaining(sh, ${f(K.sStep)}, ${f(K.sGrow)})) + sh * ${f(K.sLift)} * dark) * pow(toWhite, ${f(K.sFade)}), ${f(MAX_LIFT)});
    } else d += sh * ${f(K.sDarken)} * dark * pow(toWhite, ${f(K.sFade)});
  }
  if (hl < 0.0) {
    float gap = softGap(L - (${f(K.hMix)} * B + ${f(K.hOff)}));
    float bright = clamp((L - ${f(K.nPivot)}) / ${f(K.nSpan)}, 0.0, 1.0);
    float ease = 1.0 - (1.0 - toWhite) * exp(-gap / ${f(K.hEase)});
    float pull = gap * (1.0 - remaining(-hl, ${f(K.hStep)}, ${f(K.hGrow)})) * (${f(K.nShape)} + ${f(1 - K.nShape)} * bright) * ease;
    d -= limitTo(pull - hl * ${f(K.hEven)} * clamp((L - ${f(K.eLo)}) / ${f(K.eSpan)}, 0.0, 1.0), ${f(MAX_PULL)});
  } else if (hl > 0.0) {
    float bright = clamp((L - ${f(K.hPivot)}) / ${f(K.hSpan)}, 0.0, 1.0);
    d += hl * (${f(K.hBase)} + ${f(K.hBoost)} * bright) * pow(toWhite, ${f(K.hFade)});
  }
  return d;
}`;
