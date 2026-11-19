/**
 * Saving straight into a folder the user picks, for "Export all". Chrome, Edge and Opera on a
 * computer let a page do this (after the user picks the folder and allows it); Safari and Firefox
 * do not yet, and there the editor falls back to one ZIP file in the Downloads folder.
 */

type FolderPicker = (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;

/** The part of a folder handle used here, so tests can stand in for a real folder. */
export type Folder = Pick<FileSystemDirectoryHandle, 'getFileHandle' | 'name'>;

/**
 * Asks the user to pick a folder. Returns the folder, null if they cancelled, or 'unsupported' if
 * this browser (or this page) cannot save into a folder. Call it straight from a click.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null | 'unsupported'> {
  const picker = (window as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  if (typeof picker !== 'function') return 'unsupported';
  try {
    // The same id makes the picker open where the user saved last time.
    return await picker({ id: 'canvasshutter-export', mode: 'readwrite', startIn: 'pictures' });
  } catch (err) {
    return (err as DOMException)?.name === 'AbortError' ? null : 'unsupported';
  }
}

/** "name.jpg", then "name (2).jpg", "name (3).jpg"… */
function candidate(name: string, n: number): string {
  if (n === 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Writes a file into the folder without replacing anything already there. Returns the name used. */
export async function saveInto(folder: Folder, name: string, data: Blob): Promise<string> {
  for (let n = 1; ; n++) {
    const tryName = candidate(name, n);
    try {
      await folder.getFileHandle(tryName); // already there: try the next name
    } catch (err) {
      if ((err as DOMException)?.name !== 'NotFoundError') throw err;
      const handle = await folder.getFileHandle(tryName, { create: true });
      const out = await handle.createWritable();
      await out.write(data);
      await out.close();
      return tryName;
    }
  }
}
