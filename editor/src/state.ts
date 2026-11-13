export type Channel = 'rgb' | 'r' | 'g' | 'b';
export const CHANNELS: Channel[] = ['rgb', 'r', 'g', 'b'];

export type LightKey = 'exposure' | 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks';
export type ColorKey = 'temp' | 'tint' | 'vibrance' | 'saturation';
export type SliderKey = LightKey | ColorKey;

/** Levels for one channel: input black point and white point (0-255) and midtone gamma. */
export interface Levels { black: number; white: number; gamma: number }
export const defaultLevels = (): Levels => ({ black: 0, white: 255, gamma: 1 });
export const isDefaultLevels = (l: Levels) => l.black === 0 && l.white === 255 && l.gamma === 1;

export interface Params {
  levels: Record<Channel, Levels>;
  exposure: number; // -5..+5 stops
  contrast: number; // -100..+100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temp: number; // -100 (cooler) .. +100 (warmer)
  tint: number; // -100 (green) .. +100 (magenta)
  vibrance: number;
  saturation: number;
}

export const defaults = (): Params => ({
  levels: { rgb: defaultLevels(), r: defaultLevels(), g: defaultLevels(), b: defaultLevels() },
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0,
});

const NUMBER_KEYS: SliderKey[] = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Turns saved settings (possibly from an older version, or from a backup file) into a complete,
 * valid set: anything missing or malformed falls back to its default.
 */
export function normalizeParams(saved: unknown): Params {
  const d = defaults();
  if (!saved || typeof saved !== 'object') return d;
  const s = saved as Record<string, unknown>;
  for (const k of NUMBER_KEYS) if (isNum(s[k])) d[k] = s[k] as number;
  const levels = (s.levels ?? {}) as Record<string, unknown>;
  for (const ch of CHANNELS) {
    const l = levels[ch] as Partial<Levels> | undefined;
    if (l && isNum(l.black) && isNum(l.white) && isNum(l.gamma) && l.black >= 0 && l.white <= 255 && l.white > l.black && l.gamma > 0) {
      d.levels[ch] = { black: l.black, white: l.white, gamma: l.gamma };
    }
  }
  return d;
}

export const isDefaultParams = (p: Params) => JSON.stringify(normalizeParams(p)) === JSON.stringify(defaults());

/** Holds the current settings plus an undo/redo history of committed states. */
export class Store {
  params: Params = defaults();
  private committed = JSON.stringify(this.params);
  private past: string[] = [];
  private future: string[] = [];
  private subs = new Set<() => void>();

  /** Replaces the settings (e.g. when switching photos) and starts a fresh undo history. */
  load(params: Params) {
    this.params = params;
    this.committed = JSON.stringify(params);
    this.past = []; this.future = [];
    this.emit();
  }

  subscribe(fn: () => void) { this.subs.add(fn); }
  private emit() { for (const fn of this.subs) fn(); }

  /** Live change (e.g. while dragging). Call commit() when the gesture ends. */
  change(fn: (p: Params) => void) { fn(this.params); this.emit(); }

  /** Record the current state as one undo step, if it differs from the last one. */
  commit() {
    const s = JSON.stringify(this.params);
    if (s === this.committed) return;
    this.past.push(this.committed);
    this.future = [];
    this.committed = s;
    this.emit();
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  undo() {
    if (!this.past.length) return;
    this.future.push(this.committed);
    this.committed = this.past.pop()!;
    this.params = JSON.parse(this.committed);
    this.emit();
  }

  redo() {
    if (!this.future.length) return;
    this.past.push(this.committed);
    this.committed = this.future.pop()!;
    this.params = JSON.parse(this.committed);
    this.emit();
  }

  reset() { this.params = defaults(); this.emit(); this.commit(); }
}
