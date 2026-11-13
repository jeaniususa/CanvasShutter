import { describe, expect, it } from 'vitest';
import { autoLevels, fractionToGamma, gammaToFraction, levelsFn, setBlack, setGamma, setWhite, GAMMA_MAX, GAMMA_MIN, MIN_GAP } from '../src/levels';
import { defaultLevels, defaults, isDefaultLevels } from '../src/state';

describe('levels math', () => {
  it('defaults leave values unchanged', () => {
    const f = levelsFn(defaultLevels());
    for (let i = 0; i <= 255; i++) expect(f(i / 255)).toBeCloseTo(i / 255, 12);
    expect(isDefaultLevels(defaults().levels.rgb)).toBe(true);
  });
  it('stretches black..white to the full range and clips outside it', () => {
    const f = levelsFn({ black: 50, white: 200, gamma: 1 });
    expect(f(50 / 255)).toBe(0);
    expect(f(20 / 255)).toBe(0);
    expect(f(200 / 255)).toBe(1);
    expect(f(240 / 255)).toBe(1);
    expect(f(125 / 255)).toBeCloseTo(0.5, 12);
  });
  it('gamma above 1 brightens midtones, below 1 darkens, ends stay put', () => {
    const up = levelsFn({ black: 0, white: 255, gamma: 2 }), down = levelsFn({ black: 0, white: 255, gamma: 0.5 });
    expect(up(0.25)).toBeCloseTo(0.5, 12);
    expect(down(0.5)).toBeCloseTo(0.25, 12);
    for (const f of [up, down]) { expect(f(0)).toBe(0); expect(f(1)).toBe(1); }
  });
  it('the midtone handle position maps to mid grey', () => {
    for (const gamma of [0.4, 1, 1.8, 3]) {
      const l = { black: 30, white: 220, gamma };
      const handle = (l.black + gammaToFraction(gamma) * (l.white - l.black)) / 255;
      expect(levelsFn(l)(handle)).toBeCloseTo(0.5, 10);
    }
  });
});

describe('levels handles', () => {
  it('gamma and handle position convert back and forth', () => {
    expect(gammaToFraction(1)).toBe(0.5);
    for (const g of [0.25, 0.5, 1, 2, 4.5]) expect(fractionToGamma(gammaToFraction(g))).toBeCloseTo(g, 2);
  });
  it('limits gamma to its range', () => {
    expect(fractionToGamma(0)).toBe(GAMMA_MAX);
    expect(fractionToGamma(1)).toBe(GAMMA_MIN);
    const l = defaultLevels(); setGamma(l, 50); expect(l.gamma).toBe(GAMMA_MAX); setGamma(l, 0); expect(l.gamma).toBe(GAMMA_MIN);
  });
  it('keeps black below white', () => {
    const l = { black: 0, white: 100, gamma: 1 };
    setBlack(l, 180); expect(l.black).toBe(100 - MIN_GAP);
    setWhite(l, 10); expect(l.white).toBe(l.black + MIN_GAP);
    setBlack(l, -20); expect(l.black).toBe(0);
    setWhite(l, 999); expect(l.white).toBe(255);
  });
});

describe('auto levels', () => {
  it('finds the ends of the histogram, ignoring a tiny tail', () => {
    const bins = new Uint32Array(256);
    for (let i = 40; i <= 210; i++) bins[i] = 1000;
    bins[5] = 1; bins[250] = 1; // stray pixels, under the 0.1% cut-off
    expect(autoLevels(bins)).toEqual({ black: 40, white: 210 });
  });
  it('falls back to the full range for an empty or single-value histogram', () => {
    expect(autoLevels(new Uint32Array(256))).toEqual({ black: 0, white: 255 });
    const flat = new Uint32Array(256); flat[128] = 500;
    expect(autoLevels(flat)).toEqual({ black: 0, white: 255 });
  });
});
