import { describe, expect, it } from 'vitest';
import { exposeLevel, EXPOSURE_GLSL, darkenWhite } from '../src/exposure';

/** Linear light for an sRGB level 0..100. */
const lin = (level: number) => { const v = level / 100; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const stopsMoved = (level: number, ev: number) => Math.log2(exposeLevel(lin(level), ev) / lin(level));

describe('exposure that holds white', () => {
  it('changes nothing at 0 stops', () => {
    for (let v = 0; v <= 1; v += 0.01) expect(exposeLevel(v, 0)).toBe(v);
  });

  it('never moves pure black; holds white when brightening and nearly holds it at -1', () => {
    for (const ev of [-5, -1, -0.2, 0.2, 1, 5]) expect(exposeLevel(0, ev)).toBe(0);
    for (const ev of [0.2, 1, 5]) expect(exposeLevel(1, ev)).toBeCloseTo(1, 5);
    expect(Math.log2(exposeLevel(1, -1))).toBeGreaterThan(-0.05);
    expect(exposeLevel(1, -5)).toBeLessThan(exposeLevel(1, -1));
  });

  it('darkens smoothly up to white, with no hard step just below it', () => {
    const code = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    for (let ev = -0.25; ev >= -5; ev -= 0.25) {
      // 8-bit 254 and 255 must stay close after darkening, or blown highlights get a hard edge.
      expect(code(exposeLevel(1, ev)) - code(exposeLevel(lin(254 / 2.55), ev))).toBeLessThan(10);
    }
  });

  it('gets steadily darker as the slider goes down, white included', () => {
    for (const v of [0.01, 0.2, 0.7, 0.99, 1]) {
      let prev = Infinity;
      for (let ev = -0.01; ev >= -5; ev -= 0.01) { const o = exposeLevel(v, ev); expect(o).toBeLessThanOrEqual(prev + 1e-12); prev = o; }
    }
    expect(darkenWhite(-1)).toBe(0.995);
    expect(darkenWhite(-5)).toBeCloseTo(0.9, 12);
  });

  it('moves dark tones about 1.4 stops per stop and tapers toward white', () => {
    expect(stopsMoved(13, 1)).toBeGreaterThan(1.25);
    expect(stopsMoved(13, 1)).toBeLessThan(1.5);
    expect(stopsMoved(65, 1)).toBeGreaterThan(0.6);
    expect(stopsMoved(65, 1)).toBeLessThan(0.95);
    expect(stopsMoved(91, 1)).toBeLessThan(0.3);
    expect(stopsMoved(30, -1)).toBeLessThan(-1.25);
    expect(stopsMoved(91, -1)).toBeGreaterThan(-0.7);
  });

  it('never pushes anything past white, at any setting', () => {
    for (const ev of [1, 3, 5]) for (let v = 0; v < 1; v += 0.001) expect(exposeLevel(v, ev)).toBeLessThan(1);
  });

  it('never reverses the order of tones', () => {
    for (const ev of [-5, -3, -1, -0.3, 0.3, 1, 3, 5]) {
      let prev = -1;
      for (let i = 0; i <= 20000; i++) { const o = exposeLevel(i / 20000, ev); expect(o).toBeGreaterThanOrEqual(prev - 1e-12); prev = o; }
    }
  });

  it('gets steadily brighter as the slider rises', () => {
    for (const level of [5, 30, 70, 95]) {
      let prev = -Infinity;
      for (let ev = -5; ev <= 5; ev += 0.25) { const o = exposeLevel(lin(level), ev); expect(o).toBeGreaterThanOrEqual(prev); prev = o; }
    }
  });

  it('is written to GLSL', () => {
    expect(EXPOSURE_GLSL).toContain('float exposeLevel(float v, float stops)');
    expect(EXPOSURE_GLSL).toContain('vec3 expose(vec3 c, float stops)');
    expect(EXPOSURE_GLSL).not.toMatch(/undefined|NaN/);
  });
});
