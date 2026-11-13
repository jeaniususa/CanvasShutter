/**
 * Link between this editor tab and the local Claude bridge (the editor-mcp program).
 * The tab dials out to the bridge on this computer, receives commands, runs them through the
 * command layer, and answers. Off unless the user switches it on.
 */
import type { Histogram } from './histogram';
import type { Library } from './library/library';
import { applyChange, describeControls, resetSection, summarize, type Mode, type Section } from './remote-commands';
import { isDefaultParams, type Store } from './state';

/** The bridge's local port. Change both sides together: VITE_BRIDGE_PORT here (at build time) and EDITOR_BRIDGE_PORT for the bridge. */
const BRIDGE_PORT = Number(import.meta.env.VITE_BRIDGE_PORT) || 8765;
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const RETRY_MS = 4000;

/** What the link needs from the app. Supplied by main.ts. */
export interface EditorApi {
  store: Store;
  library: Library;
  currentId(): string | null;
  showPhoto(id: string): Promise<void>;
  saveNow(): Promise<void>;
  preview(maxSide: number): Promise<{ jpegBase64: string; width: number; height: number }>;
  histogram(): Histogram;
  exportPhoto(format: 'png' | 'jpeg'): Promise<{ fileName: string; width: number; height: number; bytes: number }>;
}

export type LinkState = 'off' | 'waiting' | 'connected';

export class Remote {
  private ws: WebSocket | null = null;
  private timer = 0;
  private enabled = false;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private api: EditorApi, private onState: (s: LinkState) => void) {}

  setEnabled(on: boolean) {
    this.enabled = on;
    clearTimeout(this.timer);
    if (on) this.connect();
    else { this.ws?.close(); this.ws = null; this.onState('off'); }
  }

  private connect() {
    if (!this.enabled || this.ws) return;
    this.onState('waiting');
    let ws: WebSocket;
    try { ws = new WebSocket(BRIDGE_URL); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) this.onState('connected'); };
    ws.onmessage = (e) => { void this.handle(ws, String(e.data)); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.retry(); } };
    ws.onerror = () => ws.close();
  }

  private retry() {
    if (!this.enabled) return;
    this.onState('waiting');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), RETRY_MS);
  }

  private async handle(ws: WebSocket, text: string) {
    let msg: { id?: unknown; method?: unknown; params?: unknown };
    try { msg = JSON.parse(text); } catch { return; }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const { id, method } = msg;
    // Commands run one at a time, in the order they arrive.
    const run = this.busy.then(() => this.run(method, (msg.params ?? {}) as Record<string, unknown>));
    this.busy = run.catch(() => undefined);
    try { ws.send(JSON.stringify({ id, ok: true, result: await run })); }
    catch (err) { ws.send(JSON.stringify({ id, ok: false, error: err instanceof Error ? err.message : String(err) })); }
  }

  private current() {
    const meta = this.api.library.get(this.api.currentId());
    if (!meta) throw new Error('No photo is open in the editor. Add or select a photo first.');
    return meta;
  }

  /** Finds a library photo by id or by file name. */
  private find(ref: unknown) {
    if (typeof ref !== 'string' || !ref) throw new Error('A photo must be given by name or id.');
    const photos = this.api.library.photos;
    const byId = photos.find((p) => p.id === ref);
    if (byId) return byId;
    const byName = photos.filter((p) => p.name === ref);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`More than one photo is named "${ref}". Use its id instead.`);
    throw new Error(`No photo named "${ref}" in the library.`);
  }

  private state() {
    const meta = this.api.library.get(this.api.currentId());
    return {
      openPhoto: meta ? { id: meta.id, name: meta.name, width: meta.width, height: meta.height } : null,
      adjustments: meta ? summarize(this.api.store.params) : null,
      canUndo: this.api.store.canUndo, canRedo: this.api.store.canRedo,
    };
  }

  private change(change: unknown, mode: Mode) {
    const r = applyChange(this.api.store.params, change, mode);
    this.api.store.change((p) => Object.assign(p, r.params));
    this.api.store.commit();
    return r;
  }

  private async run(method: string, a: Record<string, unknown>): Promise<unknown> {
    const { store, library } = this.api;
    const mode: Mode = a.mode === 'adjust' ? 'adjust' : 'set';
    switch (method) {
      case 'status':
        return { ...this.state(), photosInLibrary: library.photos.length, controls: describeControls() };
      case 'get_adjustments':
        this.current();
        return { ...this.state(), controls: describeControls() };
      case 'set_adjustments': {
        this.current();
        const r = this.change(a.change, mode);
        return { changed: r.changed, notes: r.notes, ...this.state() };
      }
      case 'reset': {
        this.current();
        const next = resetSection(store.params, (a.section ?? 'all') as Section);
        store.change((p) => Object.assign(p, next)); store.commit();
        return this.state();
      }
      case 'undo': this.current(); if (!store.canUndo) throw new Error('Nothing to undo on this photo.'); store.undo(); return this.state();
      case 'redo': this.current(); if (!store.canRedo) throw new Error('Nothing to redo on this photo.'); store.redo(); return this.state();
      case 'get_preview': {
        const meta = this.current();
        const max = Math.min(1568, Math.max(256, Number(a.maxSide) || 1024));
        return { photo: meta.name, ...(await this.api.preview(max)) };
      }
      case 'get_histogram': {
        const meta = this.current();
        return { photo: meta.name, scale: '0 = black, 255 = white', channels: summarizeHistogram(this.api.histogram()) };
      }
      case 'list_photos':
        return { openPhotoId: this.api.currentId(), photos: library.photos.map((p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, megabytes: +(p.size / 1048576).toFixed(1), hasAdjustments: p.edited })) };
      case 'open_photo': {
        const meta = this.find(a.photo);
        await this.api.showPhoto(meta.id);
        if (this.api.currentId() !== meta.id) throw new Error(`Could not open "${meta.name}".`);
        return this.state();
      }
      case 'apply_to_photos': {
        const targets = a.photos === 'all' ? [...library.photos] : (Array.isArray(a.photos) ? a.photos : []).map((p) => this.find(p));
        if (!targets.length) throw new Error('No photos were given. Pass a list of names or ids, or "all".');
        applyChange(store.params, a.change, mode); // validate once before touching anything
        const original = this.api.currentId(), results: { name: string; ok: boolean; changed?: Record<string, number>; notes?: string[]; error?: string }[] = [];
        for (const meta of targets) {
          try {
            await this.api.showPhoto(meta.id);
            if (this.api.currentId() !== meta.id) throw new Error('could not be opened');
            const r = this.change(a.change, mode);
            await this.api.saveNow();
            results.push({ name: meta.name, ok: true, changed: r.changed, notes: r.notes.length ? r.notes : undefined });
          } catch (err) {
            results.push({ name: meta.name, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (original && original !== this.api.currentId()) await this.api.showPhoto(original);
        return { requested: targets.length, updated: results.filter((r) => r.ok).length, results };
      }
      case 'export': {
        const meta = this.current();
        const format = a.format === 'jpeg' || a.format === 'jpg' ? 'jpeg' : 'png';
        return { photo: meta.name, edited: !isDefaultParams(store.params), savedTo: 'the browser\'s Downloads folder', ...(await this.api.exportPhoto(format)) };
      }
      default:
        throw new Error(`Unknown command "${method}".`);
    }
  }
}

/** Compact per-channel numbers: enough to judge exposure and clipping without the picture. */
export function summarizeHistogram(h: Histogram) {
  const one = (bins: Uint32Array) => {
    let total = 0, sum = 0;
    for (let i = 0; i < 256; i++) { total += bins[i]; sum += bins[i] * i; }
    if (!total) return null;
    const at = (q: number) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += bins[i]; if (acc >= total * q) return i; } return 255; };
    const pct = (n: number) => +((n / total) * 100).toFixed(2);
    return { mean: +(sum / total).toFixed(1), p1: at(0.01), p10: at(0.1), median: at(0.5), p90: at(0.9), p99: at(0.99), percentPureBlack: pct(bins[0]), percentPureWhite: pct(bins[255]) };
  };
  return { brightness: one(h.l), red: one(h.r), green: one(h.g), blue: one(h.b) };
}
