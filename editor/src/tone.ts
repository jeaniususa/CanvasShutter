/**
 * One shared tone response for Contrast, Whites and Blacks. (Highlights and Shadows depend on each
 * pixel's surroundings, so they are a separate stage: see src/local-tone.ts.)
 *
 * Contrast is the curve in src/contrast.ts, around the photo's own mid-tone (`pivot`). Whites and
 * Blacks then move the ends. Every part keeps black at black, white at white and never folds back,
 * so the combination cannot either. The result is baked into a table the shader looks up per pixel.
 */
import { contrastCurve, PIVOT_DEFAULT } from './contrast';

export interface ToneSettings { contrast: number; whites: number; blacks: number; pivot?: number }

export const isNeutral = (s: ToneSettings) => !s.contrast && !s.whites && !s.blacks;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toDisplay = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** Bakes the tone response into `size` evenly spaced output values for inputs 0..1. */
export function buildToneLut(s: ToneSettings, size = 1024): Float32Array {
  const out = new Float32Array(size);
  if (isNeutral(s)) { for (let i = 0; i < size; i++) out[i] = i / (size - 1); return out; }

  // Contrast works in linear light; the table is indexed and stored in display encoding.
  const pivot = s.pivot ?? PIVOT_DEFAULT;
  const shape = (t: number) => {
    const d = Math.min(1, Math.max(0, t));
    return s.contrast ? toDisplay(contrastCurve(toLinear(d), s.contrast, pivot)) : d;
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
