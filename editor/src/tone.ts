/**
 * One shared tone response for Contrast, Whites and Blacks. (Highlights and Shadows depend on each
 * pixel's surroundings, so they are a separate stage: see src/local-tone.ts.)
 *
 * Contrast raises or lowers the local contrast around the midtones, and the response is the
 * running total of that contrast from
 * black to white. Local contrast is always positive, so the response can never fold back on
 * itself, whatever combination of settings is used. The result is baked into a table that the
 * shader looks up per pixel.
 */
export interface ToneSettings { contrast: number; whites: number; blacks: number }

/** How many stops of local contrast a slider adds at +100 (and removes at -100). */
export const STOPS_AT_FULL = 1.5;

/**
 * Slider position (-100..100) to a local-contrast multiplier. Contrast is handled in stops, so
 * equal slider steps give equal ratios and the two directions mirror each other exactly.
 */
export function gain(slider: number): number {
  return Math.pow(2, STOPS_AT_FULL * Math.max(-1, Math.min(1, slider / 100)));
}

/** Local contrast multiplier at tone `t` (0 = black, 1 = white, display-encoded). */
export function slopeAt(t: number, s: ToneSettings): number {
  const atMid = Math.exp(-(((t - 0.5) / 0.22) ** 2)); // bell centred on the midpoint
  return Math.pow(gain(s.contrast), atMid);
}

export const isNeutral = (s: ToneSettings) => !s.contrast && !s.whites && !s.blacks;

/** Bakes the tone response into `size` evenly spaced output values for inputs 0..1. */
export function buildToneLut(s: ToneSettings, size = 1024): Float32Array {
  const out = new Float32Array(size);
  if (isNeutral(s)) { for (let i = 0; i < size; i++) out[i] = i / (size - 1); return out; }

  // Running total of local contrast, on a fine grid, scaled so black stays black and white stays white.
  const N = 2048, total = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) total[i + 1] = total[i] + slopeAt((i + 0.5) / N, s);
  const shape = (t: number) => {
    const p = Math.min(1, Math.max(0, t)) * N, i = Math.min(N - 1, Math.floor(p));
    return (total[i] + (total[i + 1] - total[i]) * (p - i)) / total[N];
  };

  const w = s.whites / 100, b = s.blacks / 100;
  const crush = b < 0 ? 0.15 * -b : 0;      // Blacks -: darker tones reach pure black sooner
  const lift = b > 0 ? 0.1 * b : 0;         // Blacks +: pure black is raised
  const reach = w > 0 ? 1 - 0.25 * w : 1;   // Whites +: brighter tones reach pure white sooner
  const cap = w < 0 ? 1 + 0.2 * w : 1;      // Whites -: pure white is lowered
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1) - crush) / (reach - crush);
    out[i] = lift + (cap - lift) * shape(t);
  }
  return out;
}

/** How far below white the highlight roll-off can start at high exposure (linear light, 1 = white). */
export const SHOULDER_DEPTH = 0.36;

/**
 * Where the highlight roll-off starts (in linear light, 1 = white) for a given exposure in stops.
 * Raising exposure rolls bright areas off toward white instead of cutting them off flat. At 0 EV
 * or below this returns 1, meaning no roll-off; each further stop halves the remaining distance
 * to the lowest starting point, 1 - SHOULDER_DEPTH.
 */
export function shoulderStart(ev: number): number {
  if (ev <= 0) return 1;
  return 1 - SHOULDER_DEPTH * (1 - Math.pow(2, -ev));
}
