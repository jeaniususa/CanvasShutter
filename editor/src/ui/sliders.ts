import type { SliderKey, Store } from '../state';

export type ClipView = 'high' | 'low';
export interface Def { key: SliderKey; label: string; min: number; max: number; step: number; keyStep: number; digits: number; clip?: ClipView; /** CSS gradient painted along the rail, left to right. */ ramp?: string }

export const LIGHT: Def[] = [
  { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.01, keyStep: 0.1, digits: 2, clip: 'high' },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, keyStep: 1, digits: 0 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, clip: 'high' },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, clip: 'low' },
  { key: 'whites', label: 'Whites', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, clip: 'high' },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, clip: 'low' },
];

export const COLOR: Def[] = [
  { key: 'temp', label: 'Temp', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, ramp: 'linear-gradient(90deg, #2f7bff, #c9c9c9, #ffd21f)' },
  { key: 'tint', label: 'Tint', min: -100, max: 100, step: 1, keyStep: 1, digits: 0, ramp: 'linear-gradient(90deg, #2fbf4a, #c9c9c9, #a24bff)' },
  { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, keyStep: 1, digits: 0 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, keyStep: 1, digits: 0 },
];

const fmt = (v: number, d: Def) => (v > 0 ? '+' : '') + v.toFixed(d.digits);

/**
 * Builds one row per slider definition. Drag to adjust, Shift-drag for fine control, double-click to reset.
 * Holding Alt/Option during a drag asks for the clipping view via `onClip`.
 */
export function buildSliders(root: HTMLElement, store: Store, defs: Def[], onClip: (view: ClipView | null) => void = () => {}) {
  const updaters: (() => void)[] = [];
  let held: ClipView | null = null; // clipping view of the slider being dragged, if it has one
  const altChange = (e: KeyboardEvent) => { if (e.key === 'Alt' && held) { e.preventDefault(); onClip(e.type === 'keydown' ? held : null); } };
  addEventListener('keydown', altChange);
  addEventListener('keyup', altChange);
  addEventListener('blur', () => { if (held) onClip(null); });
  for (const d of defs) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `<span class="slider-label">${d.label}</span>
      <div class="slider-track" tabindex="0" role="slider" aria-label="${d.label}" aria-valuemin="${d.min}" aria-valuemax="${d.max}">
        <div class="slider-rail"></div><div class="slider-fill"></div><div class="slider-thumb"></div>
      </div>
      <input class="slider-value" type="text" inputmode="decimal" aria-label="${d.label} value">`;
    root.append(row);
    const track = row.querySelector<HTMLElement>('.slider-track')!;
    const fill = row.querySelector<HTMLElement>('.slider-fill')!;
    const thumb = row.querySelector<HTMLElement>('.slider-thumb')!;
    const input = row.querySelector<HTMLInputElement>('.slider-value')!;
    if (d.ramp) { row.classList.add('ramped'); row.querySelector<HTMLElement>('.slider-rail')!.style.background = d.ramp; }

    const set = (v: number) => {
      const snapped = Math.round(Math.min(d.max, Math.max(d.min, v)) / d.step) * d.step;
      store.change((p) => { p[d.key] = Number(snapped.toFixed(d.digits)); });
    };
    const update = () => {
      const v = store.params[d.key];
      const t = (v - d.min) / (d.max - d.min);
      thumb.style.left = `${t * 100}%`;
      fill.style.left = `${Math.min(t, 0.5) * 100}%`;
      fill.style.width = `${Math.abs(t - 0.5) * 100}%`;
      track.setAttribute('aria-valuenow', String(v));
      if (document.activeElement !== input) input.value = fmt(v, d);
      row.classList.toggle('modified', v !== 0);
    };
    updaters.push(update);

    let lastX = 0, exact = 0;
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      track.setPointerCapture(e.pointerId);
      track.focus();
      const r = track.getBoundingClientRect();
      // Clicking the rail jumps to that spot; grabbing the thumb keeps the current value.
      exact = e.target === thumb ? store.params[d.key] : d.min + ((e.clientX - r.left) / r.width) * (d.max - d.min);
      lastX = e.clientX;
      held = d.clip ?? null;
      onClip(e.altKey ? held : null);
      set(exact);
    });
    track.addEventListener('pointermove', (e) => {
      if (!track.hasPointerCapture(e.pointerId)) return;
      const r = track.getBoundingClientRect();
      exact += ((e.clientX - lastX) / r.width) * (d.max - d.min) * (e.shiftKey ? 0.2 : 1);
      exact = Math.min(d.max, Math.max(d.min, exact));
      lastX = e.clientX;
      onClip(e.altKey ? held : null);
      set(exact);
    });
    const end = (e: PointerEvent) => { if (track.hasPointerCapture(e.pointerId)) { track.releasePointerCapture(e.pointerId); held = null; onClip(null); store.commit(); } };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    row.addEventListener('dblclick', (e) => { if (e.target !== input) { set(0); store.commit(); } });
    track.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      set(store.params[d.key] + dir * d.keyStep * (e.shiftKey ? 10 : 1));
      store.commit();
    });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!Number.isNaN(v)) { set(v); store.commit(); }
      input.blur(); update();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('focus', () => input.select());
  }
  const all = () => updaters.forEach((u) => u());
  store.subscribe(all);
  all();
}
