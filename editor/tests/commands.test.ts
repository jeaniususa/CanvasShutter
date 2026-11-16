import { describe, expect, it } from 'vitest';
import { EditorCommands, type EditorApi } from '../src/commands';
import { Store, defaults } from '../src/state';

/** A stand-in for the app with two photos in the library and the first one open. */
function fakeApp() {
  const photo = (id: string, name: string) => ({ id, name, size: 2 * 1048576, type: 'image/jpeg', order: 0, width: 300, height: 200, params: defaults(), edited: false, thumb: null as never });
  const photos = [photo('p1', 'one.jpg'), photo('p2', 'two.jpg')];
  const store = new Store();
  let current: string | null = 'p1';
  const saved: string[] = [];
  const api: EditorApi = {
    store,
    library: { photos, get: (id) => photos.find((p) => p.id === id) },
    currentId: () => current,
    showPhoto: async (id) => { current = id; store.load(defaults()); },
    saveNow: async () => { saved.push(`${current}:${store.params.temp}`); },
    preview: async (maxSide) => ({ jpegBase64: 'AAAA', width: maxSide, height: 1 }),
    histogram: () => { throw new Error('not used here'); },
    exportPhoto: async (format) => ({ fileName: `one-edited.${format === 'jpeg' ? 'jpg' : 'png'}`, width: 300, height: 200, bytes: 9 }),
  };
  return { commands: new EditorCommands(api), store, saved, close: () => { current = null; } };
}

describe('editor commands', () => {
  it('reports what is open and changes the sliders as one undo step', async () => {
    const { commands, store } = fakeApp();
    const status = await commands.run('status') as { openPhoto: { name: string }; photosInLibrary: number };
    expect(status.openPhoto.name).toBe('one.jpg');
    expect(status.photosInLibrary).toBe(2);
    const r = await commands.run('set_adjustments', { change: { exposure: 0.5 } }) as { changed: Record<string, number>; canUndo: boolean };
    expect(r.changed).toEqual({ exposure: 0.5 });
    expect(r.canUndo).toBe(true);
    await commands.run('set_adjustments', { change: { exposure: 0.25 }, mode: 'adjust' });
    expect(store.params.exposure).toBe(0.75);
    await commands.run('undo');
    expect(store.params.exposure).toBe(0.5);
  });
  it('runs commands one at a time, in the order they were sent', async () => {
    const { commands, store } = fakeApp();
    const all = await Promise.all([
      commands.run('set_adjustments', { change: { temp: 10 } }),
      commands.run('set_adjustments', { change: { temp: 5 }, mode: 'adjust' }),
      commands.run('get_preview', { maxSide: 99999 }),
    ]);
    expect(store.params.temp).toBe(15);
    expect((all[2] as { width: number }).width).toBe(1568); // limited to the largest preview allowed
  });
  it('applies one change to every photo, saves each, and comes back to the open photo', async () => {
    const { commands, saved } = fakeApp();
    const r = await commands.run('apply_to_photos', { photos: 'all', change: { temp: 20 } }) as { requested: number; updated: number };
    expect(r).toMatchObject({ requested: 2, updated: 2 });
    expect(saved).toEqual(['p1:20', 'p2:20']);
    expect(((await commands.run('status')) as { openPhoto: { id: string } }).openPhoto.id).toBe('p1');
  });
  it('explains what is wrong when there is no photo or the request is not understood', async () => {
    const { commands, close } = fakeApp();
    const message = async (p: Promise<unknown>) => { try { await p; return ''; } catch (err) { return (err as Error).message; } };
    expect(await message(commands.run('open_photo', { photo: 'three.jpg' }))).toMatch(/No photo named "three.jpg"/);
    expect(await message(commands.run('set_adjustments', { change: { brightness: 1 } }))).toMatch(/Unknown slider/);
    expect(await message(commands.run('fly'))).toMatch(/Unknown command/);
    close();
    expect(await message(commands.run('set_adjustments', { change: { temp: 1 } }))).toMatch(/No photo is open/);
    // A failed command does not block the ones after it.
    expect(((await commands.run('status')) as { openPhoto: unknown }).openPhoto).toBe(null);
  });
});
