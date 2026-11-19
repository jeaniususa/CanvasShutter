import { describe, expect, it } from 'vitest';
import { colourAfter, COLOUR_STEP_GLSL } from '../src/colour-step';

type RGB = [number, number, number];
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const spread = (c: RGB) => Math.min(...c) / Math.max(...c); // 1 = grey, lower = more colourful

describe('colour near white', () => {
  it('changes nothing when brightness did not change', () => {
    const c: RGB = [0.8, 0.3, 0.2];
    expect(colourAfter(c, c)).toEqual(c);
  });

  it('keeps greys grey', () => {
    for (const k of [0.3, 0.7, 1.3, 2]) {
      const out = colourAfter([0.4, 0.4, 0.4], scale([0.4, 0.4, 0.4], k));
      expect(out[0]).toBeCloseTo(out[1], 9); expect(out[1]).toBeCloseTo(out[2], 9);
    }
  });

  it('puts the brightest channel exactly where the brightness steps put it', () => {
    const c: RGB = [0.2, 0.7, 0.3];
    for (const k of [0.5, 1.3]) expect(Math.max(...colourAfter(c, scale(c, k)))).toBeCloseTo(0.7 * k, 9);
  });

  it('softens a bright colour as it is pushed toward white', () => {
    const c: RGB = [0.6, 0.13, 0.13];
    expect(spread(colourAfter(c, scale(c, 1.5)))).toBeGreaterThan(spread(c) * 1.1);
  });

  it('brings colour back, moderately, when a bright colour is darkened', () => {
    const c: RGB = [0.89, 0.19, 0.19];
    for (const k of [0.3, 0.6]) {
      const s = spread(colourAfter(c, scale(c, k)));
      expect(s).toBeLessThan(spread(c) * 0.95);
      expect(s).toBeGreaterThan(spread(c) * 0.3);
    }
  });

  it('leaves dark colours nearly as they were', () => {
    const c: RGB = [0.05, 0.015, 0.015];
    expect(Math.abs(Math.log2(spread(colourAfter(c, scale(c, 2))) / spread(c)))).toBeLessThan(0.15);
  });

  it('keeps the order of the channels, so hue does not flip', () => {
    for (const c of [[0.9, 0.5, 0.2], [0.1, 0.6, 0.35], [0.3, 0.2, 0.95]] as RGB[]) for (const k of [0.3, 0.8, 1.05, 1.5]) {
      const out = colourAfter(c, scale(c, k));
      const order = (x: RGB) => [0, 1, 2].sort((a, b) => x[a] - x[b]).join();
      expect(order(out)).toBe(order(c));
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('stays smooth next to white: one level of noise cannot swing the colour', () => {
    // A sunset sky: the red channel sits at 254-255 while green and blue vary.
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    for (const k of [0.5, 0.7, 1.3, 2]) for (const [g, b] of [[140, 0], [100, 20], [200, 180], [250, 240], [255, 250]]) {
      const a: RGB = [lin(255), lin(g), lin(b)], c: RGB = [lin(254), lin(g), lin(b)];
      const ra = colourAfter(a, scale(a, k)), rc = colourAfter(c, scale(c, k));
      for (const i of [1, 2]) if (a[i] > 0) expect(Math.abs(Math.log2((ra[i] / ra[0]) / (rc[i] / rc[0])))).toBeLessThan(0.1);
    }
  });

  it('keeps near-white colours near white instead of flipping hue', () => {
    for (const k of [0.4, 0.6, 1.5]) {
      const sun: RGB = [1, 1, 0.93], out = colourAfter(sun, scale(sun, k));
      expect(out[0]).toBeGreaterThanOrEqual(out[2]); expect(out[1]).toBeGreaterThanOrEqual(out[2]);
      expect(Math.abs(out[0] - out[1])).toBeLessThan(1e-9);
    }
  });

  it('darkens colours with a clipped channel richer, since their real colour was stronger', () => {
    const clippedOrange: RGB = [1, 0.4, 0], openOrange: RGB = [0.9, 0.36, 0];
    const a = colourAfter(clippedOrange, scale(clippedOrange, 0.25)), b = colourAfter(openOrange, scale(openOrange, 0.25));
    expect(a[1] / a[0]).toBeLessThan(b[1] / b[0]);
  });

  it('brightening treats neighbouring pixels alike where a clipped channel jitters (no mottling)', () => {
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    // Brightening only. Darkening still measures on the brightest channel and does vary with this
    // jitter; in flat areas the debanding in the pipeline averages it away first, and renders of a
    // JPEG sunset were smoother that way than with a luminance-based darkening.
    for (const k of [2 ** 0.15, 2 ** 0.4, 2 ** 0.7, 2 ** 1.5]) {
      const ratios = [252, 253, 254, 255].map((r) => { const a: RGB = [lin(r), lin(140), lin(2)]; const o = colourAfter(a, scale(a, k)); return o[1] / o[0]; });
      // The input itself differs by about 2.7% across these levels; brightening must not add to that.
      expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.05);
    }
  });

  it('is written to GLSL', () => {
    expect(COLOUR_STEP_GLSL).toContain('vec3 colourAfter(vec3 before, vec3 after)');
    expect(COLOUR_STEP_GLSL).not.toMatch(/undefined|NaN/);
  });
});
