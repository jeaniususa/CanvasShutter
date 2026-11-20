import { describe, expect, it } from 'vitest';
import { contrastCurve, pivotFromStats, pivotForPixels, PIVOT_DEFAULT, PIVOT_MAX, PIVOT_MIN } from '../src/contrast';

describe('contrast curve', () => {
  it('changes nothing at 0 and keeps black, the pivot and white fixed', () => {
    for (let x = 0; x <= 1; x += 0.05) expect(contrastCurve(x, 0)).toBe(x);
    for (const c of [-100, -30, 30, 100]) for (const m of [0.09, 0.18, 0.36]) {
      expect(contrastCurve(0, c, m)).toBe(0);
      expect(contrastCurve(1, c, m)).toBe(1);
      expect(contrastCurve(m, c, m)).toBeCloseTo(m, 9);
    }
  });

  it('spreads tones away from the pivot when raised and toward it when lowered', () => {
    const m = 0.18;
    for (const x of [0.03, 0.08, 0.4, 0.7]) {
      const up = contrastCurve(x, 100, m), down = contrastCurve(x, -100, m);
      if (x < m) { expect(up).toBeLessThan(x); expect(down).toBeGreaterThan(x); }
      else { expect(up).toBeGreaterThan(x); expect(down).toBeLessThan(x); }
    }
  });

  it('never reverses the order of tones, at any setting', () => {
    for (const c of [-100, -50, -10, 10, 50, 100]) for (const m of [0.09, 0.18, 0.36]) {
      let prev = -1;
      for (let i = 0; i <= 4000; i++) { const o = contrastCurve(i / 4000, c, m); expect(o).toBeGreaterThanOrEqual(prev - 1e-12); prev = o; }
    }
  });

  it('has the expected strength: at most 0.095 of push at +100, slope 1/2 at the pivot at -100', () => {
    // In the pivot-centred space y = x^g, +100 moves y = 0.75 to 0.845.
    const m = 0.18, g = -Math.LN2 / Math.log(m), y = (v: number) => v ** g, x = (v: number) => v ** (1 / g);
    expect(y(contrastCurve(x(0.75), 100, m))).toBeCloseTo(0.845, 6);
    expect(y(contrastCurve(x(0.25), 100, m))).toBeCloseTo(0.155, 6);
    const e = 1e-4, slope = (y(contrastCurve(x(0.5 + e), -100, m)) - y(contrastCurve(x(0.5 - e), -100, m))) / (2 * e);
    expect(slope).toBeCloseTo(0.5, 3);
  });
});

describe('contrast pivot', () => {
  it('is 18% grey when the average sits in the middle of the range, one stop either way at most', () => {
    expect(pivotFromStats(-4, -8, 0)).toBeCloseTo(PIVOT_DEFAULT, 12);
    expect(pivotFromStats(-1, -8, 0)).toBe(PIVOT_MAX);
    expect(pivotFromStats(-7.5, -8, 0)).toBe(PIVOT_MIN);
    expect(pivotFromStats(-3, -8, 0)).toBeGreaterThan(PIVOT_DEFAULT);
    expect(pivotFromStats(0, 0, 0)).toBe(PIVOT_DEFAULT);
  });

  it('is lower for a mostly dark photo and higher for a mostly bright one', () => {
    const photo = (darkShare: number) => {
      const px = new Uint8ClampedArray(100 * 4);
      for (let i = 0; i < 100; i++) { const v = i < darkShare ? 20 : 235; px.set([v, v, v, 255], i * 4); }
      px.set([0, 0, 0, 255], 0); px.set([255, 255, 255, 255], 99 * 4); // same range for both
      return pivotForPixels(px);
    };
    expect(photo(85)).toBeLessThan(PIVOT_DEFAULT);
    expect(photo(15)).toBeGreaterThan(PIVOT_DEFAULT);
  });
});
