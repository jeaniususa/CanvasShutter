import { describe, expect, it } from 'vitest';
import { buildToneLut, gain, STOPS_AT_FULL, type ToneSettings } from '../src/tone';

const zero: ToneSettings = { contrast: 0, whites: 0, blacks: 0 };
const at = (lut: Float32Array, x: number) => lut[Math.round(x * (lut.length - 1))];

describe('slider strength', () => {
  it('is 1 at zero and mirrors exactly either side of it', () => {
    expect(gain(0)).toBe(1);
    expect(gain(100)).toBeCloseTo(Math.pow(2, STOPS_AT_FULL), 12);
    for (const v of [10, 37, 50, 100]) expect(gain(v) * gain(-v)).toBeCloseTo(1, 12);
  });
  it('gives equal ratios for equal slider steps, and stops at the ends of the range', () => {
    expect(gain(50) / gain(25)).toBeCloseTo(gain(25) / gain(0), 12);
    expect(gain(250)).toBe(gain(100));
    expect(gain(-250)).toBe(gain(-100));
  });
});

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

  it('contrast pivots on the midpoint and keeps black and white', () => {
    for (const c of [-100, -40, 60, 100]) {
      const lut = buildToneLut({ ...zero, contrast: c }, 1025);
      expect(at(lut, 0.5)).toBeCloseTo(0.5, 3);
      expect(lut[0]).toBeCloseTo(0, 6);
      expect(lut[1024]).toBeCloseTo(1, 6);
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
