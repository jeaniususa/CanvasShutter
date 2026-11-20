import { describe, expect, it } from 'vitest';
import { buildToneLut, type ToneSettings } from '../src/tone';

const zero: ToneSettings = { contrast: 0, whites: 0, blacks: 0 };
const at = (lut: Float32Array, x: number) => lut[Math.round(x * (lut.length - 1))];

describe('tone response', () => {
  it('leaves the image unchanged when every slider is zero', () => {
    const lut = buildToneLut(zero, 256);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBeCloseTo(i / 255, 6);
  });

  it('never folds back on itself, at any combination of extremes', () => {
    const v = [-100, 0, 100];
    for (const contrast of v) for (const whites of v) for (const blacks of v) {
      const lut = buildToneLut({ contrast, whites, blacks }, 512);
      for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-7);
      expect(lut[0]).toBeGreaterThanOrEqual(0);
      expect(lut[lut.length - 1]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('contrast pivots on the photo\'s mid-tone and keeps black and white', () => {
    const disp = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    for (const pivot of [0.09, 0.18, 0.36]) for (const c of [-100, -40, 60, 100]) {
      const lut = buildToneLut({ ...zero, contrast: c, pivot }, 4097);
      expect(at(lut, disp(pivot))).toBeCloseTo(disp(pivot), 3);
      expect(lut[0]).toBeCloseTo(0, 6);
      expect(lut[4096]).toBeCloseTo(1, 6);
    }
    const up = buildToneLut({ ...zero, contrast: 60 }, 1025), down = buildToneLut({ ...zero, contrast: -60 }, 1025);
    expect(at(up, 0.25)).toBeLessThan(0.25); expect(at(up, 0.75)).toBeGreaterThan(0.75);
    expect(at(down, 0.25)).toBeGreaterThan(0.25); expect(at(down, 0.75)).toBeLessThan(0.75);
  });

  it('whites and blacks move the ends', () => {
    expect(buildToneLut({ ...zero, whites: 100 }, 1025)[800]).toBeCloseTo(1, 6);       // bright tones clip to white
    expect(buildToneLut({ ...zero, whites: -100 }, 1025)[1024]).toBeCloseTo(0.8, 6);   // white is lowered
    expect(buildToneLut({ ...zero, blacks: -100 }, 1025)[150]).toBeCloseTo(0, 6);      // dark tones crush to black
    expect(buildToneLut({ ...zero, blacks: 100 }, 1025)[0]).toBeCloseTo(0.1, 6);       // black is lifted
  });
});
