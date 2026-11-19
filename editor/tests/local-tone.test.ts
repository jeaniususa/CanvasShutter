import { describe, expect, it } from 'vitest';
import { localToneDelta, LOCAL_TONE_GLSL, FLOOR_STOPS, MAX_LIFT, MAX_PULL, remaining } from '../src/local-tone';

/** log2 of linear light for an sRGB level 0..100. */
const L = (level: number) => { const v = level / 100; return Math.log2(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); };
const MID = L(30); // surroundings of an average photo

describe('local highlights and shadows', () => {
  it('does nothing at zero', () => {
    for (const lv of [1, 9, 50, 96, 100]) for (const b of [-8, -2, 0]) expect(localToneDelta(L(lv), b, 0, 0)).toBe(0);
  });

  it('shadows lift dark tones most and leave white alone', () => {
    const d = [9, 26, 43, 61, 96].map((lv) => localToneDelta(L(lv), MID, 0, 100));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
    expect(d[0]).toBeGreaterThan(2);           // deep darks: more than two stops at +100
    expect(d[4]).toBeLessThan(0.05);           // near white: almost nothing
    expect(localToneDelta(0, MID, 0, 100)).toBe(0);
  });

  it('shadows lift a dark tone more when its surroundings are bright', () => {
    const dark = localToneDelta(L(9), L(12), 0, 100), bright = localToneDelta(L(9), L(88), 0, 100);
    expect(bright - dark).toBeGreaterThan(1);
  });

  it('negative highlights pull a bright tone down more when its surroundings are dark', () => {
    const dark = localToneDelta(L(96), L(12), -100, 0), bright = localToneDelta(L(96), L(88), -100, 0);
    expect(dark).toBeLessThan(bright - 1);
    expect(bright).toBeLessThan(0);
  });

  it('positive highlights brighten without pushing white further', () => {
    expect(localToneDelta(L(61), MID, 100, 0)).toBeGreaterThan(0.5);
    expect(localToneDelta(0, MID, 100, 0)).toBe(0);
  });

  it('grows steadily with the slider, in the right direction', () => {
    for (const lv of [5, 17, 43, 78, 95]) for (const b of [-7, MID, -0.3]) {
      let prevS = 0, prevH = 0;
      for (let v = 10; v <= 100; v += 10) {
        const sUp = localToneDelta(L(lv), b, 0, v), hDown = localToneDelta(L(lv), b, -v, 0);
        expect(sUp).toBeGreaterThanOrEqual(prevS - 1e-9); expect(hDown).toBeLessThanOrEqual(prevH + 1e-9);
        prevS = sUp; prevH = hDown;
      }
    }
    expect(localToneDelta(L(17), MID, 0, -100)).toBeLessThan(0);
  });

  it('recovers in steps: the second half of the slider does at least as much as the first', () => {
    for (const lv of [61, 78, 87]) for (const b of [-7, MID]) {
      const half = localToneDelta(L(lv), b, -50, 0), full = localToneDelta(L(lv), b, -100, 0);
      expect(half / full).toBeGreaterThan(0.3);
      expect(half / full).toBeLessThanOrEqual(0.55);
    }
    expect(remaining(0, 0.4, 2)).toBe(1);
    expect(remaining(0.25, 0.4, 2)).toBeCloseTo(0.6, 9);   // first step done
    expect(remaining(1, 0.4, 2)).toBeLessThan(remaining(0.75, 0.4, 2));
  });

  it('never reverses the order of tones', () => {
    for (const b of [-11, -9, -7, -5, MID, -1, -0.2]) for (const [h, s] of [[-100, 0], [-50, 0], [0, 100], [0, 50], [-100, 100], [100, -100], [100, 0], [0, -100]]) {
      let prev = -Infinity;
      for (let l = FLOOR_STOPS; l <= 0; l += 0.05) {
        const out = l + localToneDelta(l, b, h, s);
        expect(out).toBeGreaterThan(prev - 1e-6);
        prev = out;
      }
    }
  });

  it('using both sliders is gentler than adding them up', () => {
    const lv = L(9), both = localToneDelta(lv, MID, -100, 100);
    expect(both).toBeLessThanOrEqual(localToneDelta(lv, MID, -100, 0) + localToneDelta(lv, MID, 0, 100) + 1e-9);
  });

  it('keeps every change within its limits, even in extreme scenes', () => {
    for (const l of [FLOOR_STOPS, -8, -2, 0]) for (const b of [FLOOR_STOPS, -6, 0]) {
      expect(localToneDelta(l, b, 0, 100)).toBeLessThanOrEqual(MAX_LIFT);
      expect(localToneDelta(l, b, -100, 0)).toBeGreaterThanOrEqual(-MAX_PULL - 1e-9);
    }
  });

  it('stays finite for pure black and out-of-range values', () => {
    for (const v of [-Infinity, -40, FLOOR_STOPS, 0, 3]) for (const s of [-250, 250]) {
      const d = localToneDelta(v, MID, s, s);
      expect(Number.isFinite(d)).toBe(true);
      expect(Math.abs(d)).toBeLessThan(6);
    }
  });

  it('is written to GLSL with the same constants', () => {
    expect(LOCAL_TONE_GLSL).toContain('float localToneDelta(float L, float B, float hl, float sh)');
    expect(LOCAL_TONE_GLSL).not.toMatch(/undefined|NaN/);
  });
});
