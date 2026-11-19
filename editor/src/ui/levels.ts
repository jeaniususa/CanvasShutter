import { drawArea, type Histogram } from '../histogram';
import { autoLevels, fractionToGamma, gammaToFraction, setBlack, setGamma, setWhite } from '../levels';
import { CHANNELS, defaultLevels, isDefaultLevels, type Channel, type Levels, type Store } from '../state';
import { onDoubleTap } from './touch';

type Handle = 'black' | 'mid' | 'white';
export type LevelsClip = { view: 'high' | 'low'; channel: Channel } | null;

const NAMES: Record<Channel, string> = { rgb: 'RGB', r: 'Red', g: 'Green', b: 'Blue' };
const SHORT: Record<Channel, string> = { rgb: 'RGB', r: 'R', g: 'G', b: 'B' };
const HIST: Record<Channel, keyof Histogram> = { rgb: 'l', r: 'r', g: 'g', b: 'b' };
const FILL: Record<Channel, string> = { rgb: '#c9c9cf', r: '#ff6b61', g: '#5fd27a', b: '#6aa5ff' };
const LABEL: Record<Handle, string> = { black: 'Black point', mid: 'Midtones', white: 'White point' };

/**
 * Levels control: a live red, green and blue histogram of the edited photo, with black point, midtone and white point
 * handles underneath. Holding Alt/Option while dragging the white or black handle asks for the
 * clipping view through `onClip`.
 */
export class LevelsEditor {
  channel: Channel = 'rgb';
  private hist: Histogram | null = null; // the unedited photo, used by Auto
  private live: Histogram | null = null; // the photo as it looks now, drawn on screen
  // Channel picker: a row of buttons rather than a drop-down menu. Safari's native menu could
  // swallow the next press on a handle after a channel was picked.
  private channelRow = document.createElement('div');
  private channelButtons = {} as Record<Channel, HTMLButtonElement>;
  private auto = document.createElement('button');
  private jeanius = document.createElement('button');
  private canvas = document.createElement('canvas');
  private strip = document.createElement('div');
  private handles = {} as Record<Handle, HTMLElement>;
  private inputs = {} as Record<Handle, HTMLInputElement>;
  private dragging: Handle | null = null;

  constructor(root: HTMLElement, private store: Store, private onClip: (c: LevelsClip) => void, private onJeanius?: () => void) {
    const top = document.createElement('div'); top.className = 'levels-top';
    this.channelRow.className = 'levels-channels';
    this.channelRow.setAttribute('role', 'group');
    this.channelRow.setAttribute('aria-label', 'Levels channel');
    for (const ch of CHANNELS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `ch-${ch}`; b.title = NAMES[ch];
      b.addEventListener('click', () => { this.channel = ch; this.update(); });
      this.channelRow.append(b); this.channelButtons[ch] = b;
    }
    this.auto.textContent = 'Auto';
    this.auto.title = 'Set the black and white points from the photo';
    this.auto.addEventListener('click', () => this.runAuto());
    this.jeanius.textContent = 'Jeanius';
    this.jeanius.className = 'jeanius';
    this.jeanius.title = "Set the red, green and blue levels in Jean's style, from the photo's subject";
    this.jeanius.addEventListener('click', () => this.onJeanius?.());
    top.append(this.channelRow, this.auto, this.jeanius);

    const plot = document.createElement('div'); plot.className = 'levels-plot';
    this.canvas.className = 'levels-canvas';
    this.canvas.setAttribute('aria-label', 'Histogram of the edited photo');
    this.strip.className = 'levels-strip';
    plot.append(this.canvas, this.strip);

    const values = document.createElement('div'); values.className = 'levels-values';
    for (const h of ['black', 'mid', 'white'] as Handle[]) {
      const el = document.createElement('div');
      el.className = `levels-handle ${h}`; el.tabIndex = 0;
      el.setAttribute('role', 'slider'); el.setAttribute('aria-label', LABEL[h]); el.title = LABEL[h];
      this.strip.append(el); this.handles[h] = el;
      el.addEventListener('pointerdown', (e) => this.onDown(h, e));
      el.addEventListener('pointermove', (e) => this.onMove(h, e));
      el.addEventListener('pointerup', (e) => this.onUp(h, e));
      el.addEventListener('pointercancel', (e) => this.onUp(h, e));
      // Safari: Option-drag would start a selection or a drag-and-drop and cancel the press.
      for (const ev of ['dragstart', 'selectstart']) el.addEventListener(ev, (e) => e.preventDefault());
      const reset = () => this.edit((l) => { const d = defaultLevels(); if (h === 'mid') l.gamma = d.gamma; else if (h === 'black') setBlack(l, d.black); else setWhite(l, d.white); });
      el.addEventListener('dblclick', reset);
      onDoubleTap(el, reset);
      el.addEventListener('keydown', (e) => this.onKey(h, e));

      const input = document.createElement('input');
      input.type = 'text'; input.inputMode = 'decimal'; input.className = `levels-value ${h}`;
      input.setAttribute('aria-label', `${LABEL[h]} value`);
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        if (!Number.isNaN(v)) this.edit((l) => (h === 'mid' ? setGamma(l, v) : h === 'black' ? setBlack(l, v) : setWhite(l, v)));
        input.blur(); this.update();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('focus', () => input.select());
      values.append(input); this.inputs[h] = input;
    }
    root.append(top, plot, values);

    const alt = (e: KeyboardEvent) => { if (e.key === 'Alt' && this.dragging) { e.preventDefault(); this.clip(e.type === 'keydown'); } };
    addEventListener('keydown', alt);
    addEventListener('keyup', alt);
    addEventListener('blur', () => { if (this.dragging) this.clip(false); });
    new ResizeObserver(() => this.update()).observe(this.canvas);
    store.subscribe(() => this.update());
    this.update();
  }

  /** Histogram of the unedited photo, measured once when it loads. */
  setHistogram(h: Histogram | null) { this.hist = h; this.live = null; this.update(); }
  /** Histogram of the photo as it looks now, with every edit; redrawn whenever the photo is. */
  setLiveHistogram(h: Histogram | null) { this.live = h; this.update(); }

  private get levels(): Levels { return this.store.params.levels[this.channel]; }
  private edit(fn: (l: Levels) => void) { this.store.change((p) => fn(p.levels[this.channel])); this.store.commit(); }

  private runAuto() {
    if (!this.hist) return;
    const { black, white } = autoLevels(this.hist[HIST[this.channel]]);
    this.edit((l) => { l.black = 0; l.white = 255; setWhite(l, white); setBlack(l, black); });
  }

  /** Shows or hides the clipping view for the handle being dragged (the midtone handle has none). */
  private clip(on: boolean) {
    const view = this.dragging === 'white' ? 'high' : this.dragging === 'black' ? 'low' : null;
    this.onClip(on && view ? { view, channel: this.channel } : null);
  }

  private valueAt(e: PointerEvent) {
    const r = this.strip.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * 255;
  }

  private apply(h: Handle, v: number) {
    this.store.change((p) => {
      const l = p.levels[this.channel];
      if (h === 'black') setBlack(l, v);
      else if (h === 'white') setWhite(l, v);
      else l.gamma = fractionToGamma((v - l.black) / (l.white - l.black));
    });
  }

  private grab = 0; // offset between the pointer and the handle's value, so it does not jump on press

  private onDown(h: Handle, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // the handle takes the press itself: no text selection or focus tug-of-war
    const el = this.handles[h];
    el.setPointerCapture(e.pointerId); el.focus();
    const l = this.levels;
    const current = h === 'black' ? l.black : h === 'white' ? l.white : l.black + gammaToFraction(l.gamma) * (l.white - l.black);
    this.grab = current - this.valueAt(e);
    this.dragging = h;
    this.clip(e.altKey);
  }

  private onMove(h: Handle, e: PointerEvent) {
    if (this.dragging !== h || !this.handles[h].hasPointerCapture(e.pointerId)) return;
    this.apply(h, this.valueAt(e) + this.grab);
    this.clip(e.altKey);
  }

  private onUp(h: Handle, e: PointerEvent) {
    if (this.dragging !== h) return;
    if (this.handles[h].hasPointerCapture(e.pointerId)) this.handles[h].releasePointerCapture(e.pointerId);
    this.clip(false);
    this.dragging = null;
    this.store.commit();
  }

  private onKey(h: Handle, e: KeyboardEvent) {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const big = e.shiftKey ? 10 : 1;
    // Moving the midtone handle right darkens (lower gamma), matching what dragging it does.
    this.edit((l) => (h === 'mid' ? setGamma(l, l.gamma - dir * 0.01 * big) : h === 'black' ? setBlack(l, l.black + dir * big) : setWhite(l, l.white + dir * big)));
  }

  private update() {
    const l = this.levels;
    const pos = { black: l.black / 255, white: l.white / 255, mid: (l.black + gammaToFraction(l.gamma) * (l.white - l.black)) / 255 };
    const text = { black: String(l.black), mid: l.gamma.toFixed(2), white: String(l.white) };
    const now = { black: l.black, mid: l.gamma, white: l.white };
    for (const h of ['black', 'mid', 'white'] as Handle[]) {
      this.handles[h].style.left = `${pos[h] * 100}%`;
      this.handles[h].setAttribute('aria-valuenow', String(now[h]));
      this.handles[h].setAttribute('aria-valuetext', text[h]);
      if (document.activeElement !== this.inputs[h]) this.inputs[h].value = text[h];
    }
    // A dot marks each channel that has been changed. Only touched when something differs, as this
    // runs on every step of a drag.
    for (const ch of CHANNELS) {
      const b = this.channelButtons[ch], edited = !isDefaultLevels(this.store.params.levels[ch]);
      const label = SHORT[ch] + (edited ? ' •' : ''), name = NAMES[ch] + (edited ? ' (changed)' : '');
      if (b.textContent !== label) b.textContent = label;
      if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
      const on = String(ch === this.channel);
      if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
    }
    this.auto.disabled = !this.hist;
    this.jeanius.disabled = !this.hist || !this.onJeanius;
    this.draw();
  }

  private draw() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const h = this.live ?? this.hist;
    if (!h) return;
    if (this.channel === 'rgb') {
      // Red, green and blue on top of each other; where all three overlap they add up to white.
      g.globalCompositeOperation = 'lighter';
      drawArea(g, h.r, 0, 4, r.width, r.height - 4, 'rgba(255,80,70,0.75)');
      drawArea(g, h.g, 0, 4, r.width, r.height - 4, 'rgba(70,200,100,0.75)');
      drawArea(g, h.b, 0, 4, r.width, r.height - 4, 'rgba(80,130,255,0.75)');
      g.globalCompositeOperation = 'source-over';
    } else drawArea(g, h[HIST[this.channel]], 0, 4, r.width, r.height - 4, FILL[this.channel]);
  }
}
