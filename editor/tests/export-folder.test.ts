import { describe, expect, it } from 'vitest';
import { saveInto, type Folder } from '../src/export-folder';

/** A pretend folder that keeps files in memory. */
function fakeFolder(existing: string[] = []) {
  const files = new Map<string, Blob>(existing.map((n) => [n, new Blob(['old'])]));
  const folder = {
    name: 'Exports',
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name) && !opts?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return {
        async createWritable() {
          let data: Blob = new Blob();
          return { async write(b: Blob) { data = b; }, async close() { files.set(name, data); } };
        },
      };
    },
  } as unknown as Folder;
  return { folder, files };
}

describe('export into a folder', () => {
  it('saves a new file under its own name', async () => {
    const { folder, files } = fakeFolder();
    expect(await saveInto(folder, 'beach-edited.jpg', new Blob(['x']))).toBe('beach-edited.jpg');
    expect(files.has('beach-edited.jpg')).toBe(true);
  });
  it('never replaces a file already in the folder', async () => {
    const { folder, files } = fakeFolder(['beach-edited.jpg', 'beach-edited (2).jpg']);
    expect(await saveInto(folder, 'beach-edited.jpg', new Blob(['new']))).toBe('beach-edited (3).jpg');
    expect(await files.get('beach-edited.jpg')!.text()).toBe('old');
  });
});
