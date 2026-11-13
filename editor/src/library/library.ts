import { isDefaultParams, normalizeParams, type Params } from '../state';
import { buildBackup, matchBackup, parseBackup } from './backup';
import { carryOverOlderLibrary, db, type PhotoMeta } from './db';

const THUMB_SIZE = 160; // longest side, in pixels

/** Decodes a stored photo, honouring its rotation tag where the browser supports that option. */
export async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file); // older browsers reject the options argument
  }
}

/** Draws any image source into a small JPEG. */
export async function makeThumb(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const s = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * s)); c.height = Math.max(1, Math.round(height * s));
  c.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.8));
  if (!blob) throw new Error('Could not make a thumbnail.');
  return blob;
}

export interface AddResult { added: PhotoMeta[]; duplicates: string[]; failed: string[] }

/** The stored set of photos and their settings. All data stays in this browser. */
export class Library {
  photos: PhotoMeta[] = [];

  async init() {
    await carryOverOlderLibrary();
    this.photos = (await db.list()).sort((a, b) => a.order - b.order);
    for (const p of this.photos) p.params = normalizeParams(p.params);
  }

  get(id: string | null) { return this.photos.find((p) => p.id === id); }

  async file(id: string): Promise<Blob> {
    const f = await db.file(id);
    if (!f) throw new Error('The stored photo is missing.');
    return f;
  }

  /**
   * Stores photos one at a time (keeps memory use flat for large batches). Files already in the
   * library (same name and size) are skipped; files the browser cannot read are reported.
   */
  async addFiles(files: File[], onProgress: (done: number, total: number) => void): Promise<AddResult> {
    const result: AddResult = { added: [], duplicates: [], failed: [] };
    let order = this.photos.reduce((m, p) => Math.max(m, p.order), 0);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onProgress(i, files.length);
      if (this.photos.some((p) => p.name === f.name && p.size === f.size)) { result.duplicates.push(f.name); continue; }
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await decode(f);
        const meta: PhotoMeta = {
          id: crypto.randomUUID(), name: f.name, size: f.size, type: f.type, order: ++order,
          width: bmp.width, height: bmp.height, params: normalizeParams(null), edited: false,
          thumb: await makeThumb(bmp, bmp.width, bmp.height),
        };
        await db.add(meta, f);
        this.photos.push(meta);
        result.added.push(meta);
      } catch (err) {
        // A full disk stops the whole batch; an unreadable file only skips itself.
        if ((err as DOMException)?.name === 'QuotaExceededError') throw new Error('The browser has run out of storage space for this app.');
        result.failed.push(f.name);
      } finally {
        bmp?.close();
      }
    }
    onProgress(files.length, files.length);
    return result;
  }

  /** Saves a photo's settings and, when given, a fresh thumbnail showing the edited look. */
  async save(id: string, params: Params, thumb?: Blob) {
    const p = this.get(id);
    if (!p) return;
    p.params = params;
    p.edited = !isDefaultParams(params);
    if (thumb) p.thumb = thumb;
    await db.putMeta(p);
  }

  async remove(id: string) {
    await db.remove(id);
    this.photos = this.photos.filter((p) => p.id !== id);
  }

  /** Text of a backup file holding every photo's settings (not the photos themselves). */
  backupText(): string { return JSON.stringify(buildBackup(this.photos), null, 1); }

  /** Applies a backup's settings to photos with the same file name and size. */
  async restore(text: string): Promise<{ restored: string[]; unmatched: number }> {
    const { matches, unmatched } = matchBackup(parseBackup(text), this.photos);
    for (const m of matches) await this.save(m.id, m.params);
    return { restored: matches.map((m) => m.id), unmatched };
  }

  /** Asks the browser not to clear this app's data on its own. Returns false if it will not promise. */
  async keep(): Promise<boolean> {
    try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
  }

  /** Bytes this app is using in the browser, or null if the browser will not say. */
  async usage(): Promise<number | null> {
    try { return (await navigator.storage?.estimate?.())?.usage ?? null; } catch { return null; }
  }
}
