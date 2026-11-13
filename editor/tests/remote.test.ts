import { describe, expect, it } from 'vitest';
import { applyChange, describeControls, resetSection, summarize } from '../src/remote-commands';
import { defaults } from '../src/state';

describe('applyChange', () => {
  it('sets values and reports only what changed', () => {
    const r = applyChange(defaults(), { exposure: 0.5, shadows: 30, contrast: 0 });
    expect(r.params.exposure).toBe(0.5);
    expect(r.params.shadows).toBe(30);
    expect(r.changed).toEqual({ exposure: 0.5, shadows: 30 });
    expect(r.notes).toEqual([]);
  });
  it('does not modify the settings it was given', () => {
    const p = defaults();
    applyChange(p, { exposure: 2, levels: { rgb: { black: 20 } } });
    expect(p).toEqual(defaults());
  });
  it('adjust mode adds to the current value', () => {
    const start = applyChange(defaults(), { exposure: 1, temp: 10 }).params;
    const r = applyChange(start, { exposure: -0.25, temp: 15 }, 'adjust');
    expect(r.params.exposure).toBe(0.75);
    expect(r.params.temp).toBe(25);
  });
  it('clamps to the slider range and says so', () => {
    const r = applyChange(defaults(), { exposure: 9, saturation: -250 });
    expect(r.params.exposure).toBe(5);
    expect(r.params.saturation).toBe(-100);
    expect(r.notes.length).toBe(2);
    expect(r.notes[0]).toMatch(/exposure limited to 5/);
  });
  it('rounds to each slider step', () => {
    const r = applyChange(defaults(), { exposure: 0.333, contrast: 12.6 });
    expect(r.params.exposure).toBe(0.33);
    expect(r.params.contrast).toBe(13);
  });
  it('rejects unknown names and bad values with a helpful message', () => {
    expect(() => applyChange(defaults(), { brightness: 10 })).toThrow(/Unknown slider "brightness".*exposure/);
    expect(() => applyChange(defaults(), { exposure: 'lots' })).toThrow(/needs a number/);
    expect(() => applyChange(defaults(), { exposure: NaN })).toThrow(/needs a number/);
    expect(() => applyChange(defaults(), [1, 2])).toThrow(/must be an object/);
    expect(() => applyChange(defaults(), { levels: { cyan: { black: 1 } } })).toThrow(/Unknown levels channel/);
    expect(() => applyChange(defaults(), { levels: { rgb: { grey: 1 } } })).toThrow(/Unknown levels setting/);
  });
  it('sets levels and keeps black below white', () => {
    const r = applyChange(defaults(), { levels: { rgb: { black: 20, white: 230, gamma: 1.2 }, r: { gamma: 0.9 } } });
    expect(r.params.levels.rgb).toEqual({ black: 20, white: 230, gamma: 1.2 });
    expect(r.params.levels.r).toEqual({ black: 0, white: 255, gamma: 0.9 });
    expect(r.changed).toEqual({ 'levels.rgb.black': 20, 'levels.rgb.white': 230, 'levels.rgb.gamma': 1.2, 'levels.r.gamma': 0.9 });
    const crossed = applyChange(defaults(), { levels: { rgb: { black: 200, white: 100 } } });
    expect(crossed.params.levels.rgb.black).toBeLessThan(crossed.params.levels.rgb.white);
    expect(crossed.notes[0]).toMatch(/black must stay at least 2 below white/);
  });
  it('can move both level points past their old positions in one call', () => {
    const start = applyChange(defaults(), { levels: { rgb: { black: 10, white: 60 } } }).params;
    const r = applyChange(start, { levels: { rgb: { black: 100, white: 200 } } });
    expect(r.params.levels.rgb).toMatchObject({ black: 100, white: 200 });
    expect(r.notes).toEqual([]);
  });
  it('adjusts levels relatively and limits gamma', () => {
    const r = applyChange(defaults(), { levels: { rgb: { black: 5, white: -10, gamma: 50 } } }, 'adjust');
    expect(r.params.levels.rgb.black).toBe(5);
    expect(r.params.levels.rgb.white).toBe(245);
    expect(r.params.levels.rgb.gamma).toBe(9.99);
    expect(r.notes.some((n) => /gamma limited/.test(n))).toBe(true);
  });
});

describe('resetSection', () => {
  const edited = () => applyChange(defaults(), { exposure: 1, temp: 20, levels: { g: { black: 9 } } }).params;
  it('resets one section and leaves the others', () => {
    expect(resetSection(edited(), 'light').exposure).toBe(0);
    expect(resetSection(edited(), 'light').temp).toBe(20);
    expect(resetSection(edited(), 'color').temp).toBe(0);
    expect(resetSection(edited(), 'color').exposure).toBe(1);
    expect(resetSection(edited(), 'levels').levels.g.black).toBe(0);
    expect(resetSection(edited(), 'all')).toEqual(defaults());
  });
  it('rejects an unknown section', () => {
    expect(() => resetSection(defaults(), 'everything' as never)).toThrow(/Unknown section/);
  });
});

describe('descriptions', () => {
  it('lists every slider with its range, and groups current values', () => {
    const c = describeControls();
    expect(c.sliders.map((s) => s.name)).toEqual(['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation']);
    expect(c.sliders[0]).toMatchObject({ min: -5, max: 5, section: 'light' });
    const s = summarize(applyChange(defaults(), { tint: 7 }).params);
    expect(s.color.tint).toBe(7);
    expect(Object.keys(s)).toEqual(['light', 'color', 'levels']);
  });
});
