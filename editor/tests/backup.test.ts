import { describe, expect, it } from 'vitest';
import { buildBackup, matchBackup, parseBackup } from '../src/library/backup';
import { Store, defaults, isDefaultParams, normalizeParams } from '../src/state';

const edited = () => { const p = defaults(); p.exposure = 1.25; p.temp = -30; p.levels.rgb = { black: 12, white: 240, gamma: 1.4 }; return p; };

describe('normalizeParams', () => {
  it('returns defaults for nothing or nonsense', () => {
    for (const bad of [null, undefined, 42, 'x', []]) expect(normalizeParams(bad)).toEqual(defaults());
  });
  it('keeps valid settings unchanged', () => {
    expect(normalizeParams(edited())).toEqual(edited());
  });
  it('fills in fields an older version did not save', () => {
    const old = { exposure: 0.5, contrast: 20, somethingRemoved: [1, 2, 3] }; // no levels, no colour sliders, one field this version does not know
    const p = normalizeParams(old);
    expect(p.exposure).toBe(0.5);
    expect(p.contrast).toBe(20);
    expect(p.levels).toEqual(defaults().levels);
    expect(p.saturation).toBe(0);
  });
  it('drops malformed values instead of passing them on', () => {
    const p = normalizeParams({ exposure: 'lots', tint: NaN, levels: { rgb: { black: 200, white: 100, gamma: 1 }, r: { black: 0, white: 255, gamma: 0 } } });
    expect(p).toEqual(defaults());
  });
  it('tells edited from untouched', () => {
    expect(isDefaultParams(defaults())).toBe(true);
    expect(isDefaultParams(edited())).toBe(false);
  });
});

describe('Store.load', () => {
  it('replaces settings and clears undo history', () => {
    const s = new Store();
    s.change((p) => { p.exposure = 2; }); s.commit();
    s.load(edited());
    expect(s.params.exposure).toBe(1.25);
    expect(s.canUndo).toBe(false);
    s.change((p) => { p.exposure = 3; }); s.commit();
    s.undo();
    expect(s.params.exposure).toBe(1.25);
  });
});

describe('backup', () => {
  const photos = [
    { id: 'a', name: 'beach.jpg', size: 1000, params: edited() },
    { id: 'b', name: 'city.jpg', size: 2000, params: defaults() },
  ];
  it('round-trips settings through the file text', () => {
    const text = JSON.stringify(buildBackup(photos, new Date('2026-11-12T00:00:00Z')));
    const b = parseBackup(text);
    expect(b.savedAt).toBe('2026-11-12T00:00:00.000Z');
    expect(b.photos).toEqual([{ name: 'beach.jpg', size: 1000, params: edited() }, { name: 'city.jpg', size: 2000, params: defaults() }]);
    expect(text).not.toContain('"id"');
  });
  it('matches by file name and size, and counts what it could not place', () => {
    const b = buildBackup([...photos, { name: 'gone.jpg', size: 5, params: edited() }]);
    const lib = [{ id: 'x', name: 'beach.jpg', size: 1000 }, { id: 'y', name: 'city.jpg', size: 9999 }];
    const { matches, unmatched } = matchBackup(b, lib);
    expect(matches).toEqual([{ id: 'x', params: edited() }]);
    expect(unmatched).toBe(2); // city.jpg has a different size, gone.jpg is not in the library
  });
  it('rejects files that are not backups, with a readable message', () => {
    for (const bad of ['not json', '{}', '{"app":"other","photos":[]}', 'null']) expect(() => parseBackup(bad)).toThrow(/not a backup/);
    expect(() => parseBackup('{"app":"canvasshutter","version":2,"photos":[]}')).toThrow(/newer version/);
  });
  it('repairs damaged settings inside an otherwise valid backup', () => {
    const b = parseBackup('{"app":"canvasshutter","version":1,"photos":[{"name":"a.jpg","size":1,"params":{"exposure":"x"}},{"size":3}]}');
    expect(b.photos).toEqual([{ name: 'a.jpg', size: 1, params: defaults() }]);
  });
  it('still accepts backup files written by earlier versions of the app', () => {
    const b = parseBackup('{"app":"tone-editor","version":1,"photos":[{"name":"a.jpg","size":1,"params":{"exposure":0.5}}]}');
    expect(b.app).toBe('canvasshutter');
    expect(b.photos[0].params.exposure).toBe(0.5);
  });
});
