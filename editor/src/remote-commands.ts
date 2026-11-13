/**
 * The editor's command layer: turns a requested change ("set shadows to 30", "nudge exposure by
 * +0.3") into new, valid settings. No browser APIs here, so it can be tested on its own and reused
 * by any way of connecting to the editor (the Claude bridge today, others later).
 */
import { setBlack, setGamma, setWhite, GAMMA_MAX, GAMMA_MIN } from './levels';
import { CHANNELS, defaultLevels, defaults, type Channel, type Params, type SliderKey } from './state';
import { COLOR, LIGHT } from './ui/sliders';

export type Mode = 'set' | 'adjust';
export type Section = 'all' | 'levels' | 'light' | 'color';

const SLIDERS = [...LIGHT.map((d) => ({ ...d, section: 'light' as const })), ...COLOR.map((d) => ({ ...d, section: 'color' as const }))];
const BY_KEY = new Map(SLIDERS.map((d) => [d.key as string, d]));
const LEVEL_FIELDS = ['black', 'white', 'gamma'] as const;

/** What can be changed, with ranges. Sent to Claude so it knows the vocabulary. */
export function describeControls() {
  return {
    sliders: SLIDERS.map((d) => ({ name: d.key, section: d.section, min: d.min, max: d.max, step: d.step })),
    levels: {
      channels: CHANNELS,
      black: { min: 0, max: 253, note: 'input black point; always at least 2 below white' },
      white: { min: 2, max: 255, note: 'input white point' },
      gamma: { min: GAMMA_MIN, max: GAMMA_MAX, note: 'midtones; above 1 brightens, below 1 darkens' },
    },
  };
}

export interface ChangeResult { params: Params; changed: Record<string, number>; notes: string[] }

/**
 * Applies a change to a copy of the settings. `change` may hold slider names with numbers and a
 * `levels` object keyed by channel. In 'set' mode numbers are new values; in 'adjust' mode they are
 * added to the current values. Out-of-range results are clamped (and noted); unknown names throw.
 */
export function applyChange(current: Params, change: unknown, mode: Mode = 'set'): ChangeResult {
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('The change must be an object of slider names and numbers.');
  const params: Params = structuredClone(current);
  const changed: Record<string, number> = {}, notes: string[] = [];
  const num = (name: string, v: unknown) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${name}" needs a number.`); return v; };

  for (const [name, raw] of Object.entries(change as Record<string, unknown>)) {
    if (name === 'levels') continue;
    const def = BY_KEY.get(name);
    if (!def) throw new Error(`Unknown slider "${name}". Valid sliders: ${SLIDERS.map((d) => d.key).join(', ')}. Levels go under "levels".`);
    const key = def.key as SliderKey;
    const wanted = mode === 'adjust' ? params[key] + num(name, raw) : num(name, raw);
    const value = Number((Math.round(Math.min(def.max, Math.max(def.min, wanted)) / def.step) * def.step).toFixed(def.digits));
    if (Math.abs(value - wanted) > def.step / 2) notes.push(`${name} limited to ${value} (range ${def.min} to ${def.max})`);
    if (value !== params[key]) changed[name] = value;
    params[key] = value;
  }

  const levels = (change as Record<string, unknown>).levels;
  if (levels !== undefined) {
    if (!levels || typeof levels !== 'object' || Array.isArray(levels)) throw new Error('"levels" must be an object keyed by channel (rgb, r, g, b).');
    for (const [ch, raw] of Object.entries(levels as Record<string, unknown>)) {
      if (!CHANNELS.includes(ch as Channel)) throw new Error(`Unknown levels channel "${ch}". Valid channels: ${CHANNELS.join(', ')}.`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`levels.${ch} must be an object with black, white and/or gamma.`);
      const fields = raw as Record<string, unknown>;
      for (const f of Object.keys(fields)) if (!LEVEL_FIELDS.includes(f as (typeof LEVEL_FIELDS)[number])) throw new Error(`Unknown levels setting "${f}". Valid settings: black, white, gamma.`);
      const l = params.levels[ch as Channel], before = { ...l };
      const want = (f: (typeof LEVEL_FIELDS)[number]) => (fields[f] === undefined ? before[f] : mode === 'adjust' ? before[f] + num(`levels.${ch}.${f}`, fields[f]) : num(`levels.${ch}.${f}`, fields[f]));
      const [b, w, g] = [want('black'), want('white'), want('gamma')];
      l.black = 0; l.white = 255;         // widen first, so the order of the two points cannot block either
      setWhite(l, w); setBlack(l, b); setGamma(l, g);
      if (l.black !== Math.round(b) || l.white !== Math.round(w)) notes.push(`levels.${ch} limited to black ${l.black}, white ${l.white} (black must stay at least 2 below white)`);
      if (Math.abs(l.gamma - g) > 0.005) notes.push(`levels.${ch}.gamma limited to ${l.gamma} (range ${GAMMA_MIN} to ${GAMMA_MAX})`);
      for (const f of LEVEL_FIELDS) if (l[f] !== before[f]) changed[`levels.${ch}.${f}`] = l[f];
    }
  }
  return { params, changed, notes };
}

/** Returns a copy with one section (or everything) back at its defaults. */
export function resetSection(current: Params, section: Section = 'all'): Params {
  if (section === 'all') return defaults();
  const params: Params = structuredClone(current);
  if (section === 'levels') for (const ch of CHANNELS) params.levels[ch] = defaultLevels();
  else if (section === 'light') for (const d of LIGHT) params[d.key] = 0;
  else if (section === 'color') for (const d of COLOR) params[d.key] = 0;
  else throw new Error(`Unknown section "${section}". Valid sections: all, levels, light, color.`);
  return params;
}

/** The settings Claude is shown: sliders grouped by section, plus levels. */
export function summarize(params: Params) {
  return {
    light: Object.fromEntries(LIGHT.map((d) => [d.key, params[d.key]])),
    color: Object.fromEntries(COLOR.map((d) => [d.key, params[d.key]])),
    levels: params.levels,
  };
}
