import type { Params } from '../state';

/** Everything about a stored photo except the full-size file. */
export interface PhotoMeta {
  id: string;
  name: string;
  size: number;      // bytes, of the original file
  type: string;
  order: number;     // position in the filmstrip
  width: number;
  height: number;
  params: Params;
  edited: boolean;
  thumb: Blob;       // small JPEG preview
}

const NAME = 'canvasshutter';
/** Storage name used by earlier versions of this app. Its contents are copied across once. */
const OLDER_NAME = 'tone-editor';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      // Two stores, so listing the library never has to load the full-size files.
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('files');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opening = null; reject(r.error ?? new Error('Could not open browser storage.')); };
    r.onblocked = () => { opening = null; reject(new Error('Browser storage is in use by another tab of this app.')); };
  });
  return opening;
}

/** Runs one transaction and resolves with the request's result once the data is safely written. */
async function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = run(t);
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = () => reject(t.error ?? new Error('Browser storage error.'));
    t.onabort = () => reject(t.error ?? new Error('Browser storage is full or unavailable.'));
  });
}

export const db = {
  list: () => tx<PhotoMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll()),
  file: (id: string) => tx<Blob | undefined>(['files'], 'readonly', (t) => t.objectStore('files').get(id)),
  add: (meta: PhotoMeta, file: Blob) => tx<void>(['meta', 'files'], 'readwrite', (t) => { t.objectStore('meta').put(meta); t.objectStore('files').put(file, meta.id); }),
  putMeta: (meta: PhotoMeta) => tx<void>(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(meta); }),
  remove: (id: string) => tx<void>(['meta', 'files'], 'readwrite', (t) => { t.objectStore('meta').delete(id); t.objectStore('files').delete(id); }),
};

/** Reads everything from the storage used by earlier versions, if there is any. */
function readOlder(): Promise<{ metas: PhotoMeta[]; files: Map<string, Blob> } | null> {
  return new Promise((resolve) => {
    const r = indexedDB.open(OLDER_NAME);
    let created = false;
    r.onupgradeneeded = () => { created = true; };   // it did not exist: opening made an empty one
    r.onerror = () => resolve(null);
    r.onsuccess = () => {
      const old = r.result;
      if (created || !old.objectStoreNames.contains('meta') || !old.objectStoreNames.contains('files')) {
        old.close();
        if (created) indexedDB.deleteDatabase(OLDER_NAME); // remove the empty one we just made
        resolve(null);
        return;
      }
      const t = old.transaction(['meta', 'files'], 'readonly');
      const metas = t.objectStore('meta').getAll();
      const files = new Map<string, Blob>();
      const cursor = t.objectStore('files').openCursor();
      cursor.onsuccess = () => { const c = cursor.result; if (c) { files.set(String(c.key), c.value as Blob); c.continue(); } };
      t.oncomplete = () => { old.close(); resolve({ metas: metas.result as PhotoMeta[], files }); };
      t.onerror = t.onabort = () => { old.close(); resolve(null); };
    };
  });
}

/**
 * One-time carry-over: if this storage is empty and an earlier version left a library behind, copy
 * it across. The older storage is left in place. Returns how many photos were copied.
 */
export async function carryOverOlderLibrary(): Promise<number> {
  if ((await db.list()).length) return 0;
  const older = await readOlder();
  if (!older) return 0;
  let copied = 0;
  for (const meta of older.metas) {
    const file = older.files.get(meta.id);
    if (!file) continue;
    await db.add(meta, file);
    copied++;
  }
  return copied;
}
