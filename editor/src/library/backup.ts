import { normalizeParams, type Params } from '../state';

/** What a backup needs to know about a photo: enough to recognise it again, plus its settings. */
export interface BackupPhoto { name: string; size: number; params: Params }
export const APP_ID = 'canvasshutter';
/** Marker written by earlier versions of this app; their backup files are still accepted. */
const OLDER_APP_IDS = ['tone-editor'];

export interface Backup { app: typeof APP_ID; version: 1; savedAt: string; photos: BackupPhoto[] }

/** Builds the backup file contents. The photos themselves are not included, only their settings. */
export function buildBackup(photos: BackupPhoto[], now = new Date()): Backup {
  return { app: APP_ID, version: 1, savedAt: now.toISOString(), photos: photos.map(({ name, size, params }) => ({ name, size, params })) };
}

/** Reads a backup file's text. Throws an Error with a plain-language message if it is not one. */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not a backup from this app.'); }
  const b = data as (Omit<Partial<Backup>, 'app'> & { app?: unknown }) | null;
  if (!b || typeof b.app !== 'string' || ![APP_ID, ...OLDER_APP_IDS].includes(b.app) || !Array.isArray(b.photos)) throw new Error('That file is not a backup from this app.');
  if (b.version !== 1) throw new Error('That backup was made by a newer version of this app.');
  const photos = b.photos
    .filter((p) => p && typeof p.name === 'string' && typeof p.size === 'number')
    .map((p) => ({ name: p.name, size: p.size, params: normalizeParams(p.params) }));
  return { app: APP_ID, version: 1, savedAt: typeof b.savedAt === 'string' ? b.savedAt : '', photos };
}

/**
 * Pairs backup entries with library photos that have the same file name and size.
 * Returns the settings to apply per photo id and how many backup entries had no match.
 */
export function matchBackup(backup: Backup, library: { id: string; name: string; size: number }[]): { matches: { id: string; params: Params }[]; unmatched: number } {
  const key = (p: { name: string; size: number }) => `${p.size}:${p.name}`;
  const byKey = new Map(library.map((p) => [key(p), p.id]));
  const matches: { id: string; params: Params }[] = [];
  let unmatched = 0;
  for (const p of backup.photos) {
    const id = byKey.get(key(p));
    if (id) matches.push({ id, params: p.params }); else unmatched++;
  }
  return { matches, unmatched };
}
