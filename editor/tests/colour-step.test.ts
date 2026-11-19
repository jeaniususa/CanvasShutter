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

  it('brings colour back when a bright colour is darkened', () => {
    const c: RGB = [0.89, 0.19, 0.19];
    expect(spread(colourAfter(c, scale(c, 0.6)))).toBeLessThan(spread(c) * 0.9);
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

  it('is written to GLSL', () => {
    expect(COLOUR_STEP_GLSL).toContain('vec3 colourAfter(vec3 before, vec3 after)');
    expect(COLOUR_STEP_GLSL).not.toMatch(/undefined|NaN/);
  });
});
