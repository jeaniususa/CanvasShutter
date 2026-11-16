import { Pipeline } from './gl/pipeline';
import { measure } from './histogram';
import { Library, decode, makeThumb } from './library/library';
import { EditorCommands } from './commands';
import { Remote, type LinkState } from './remote';
import { CHANNELS, Store, defaultLevels, defaults, normalizeParams } from './state';
import { Filmstrip } from './ui/filmstrip';
import { LevelsEditor, type LevelsClip } from './ui/levels';
import { COLOR, LIGHT, buildSliders, type ClipView } from './ui/sliders';
import { setupChat } from './ui/chat';
import { isTouchDevice } from './ui/touch';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), view = $<HTMLCanvasElement>('view'), empty = $('empty'), badge = $('badge'), notice = $('notice');
const fileInput = $<HTMLInputElement>('file');

const store = new Store();
let levelsClip: LevelsClip = null;
const levelsEditor = new LevelsEditor($('levels'), store, (c) => { if (JSON.stringify(c) !== JSON.stringify(levelsClip)) { levelsClip = c; schedule(); } });
let clipView: ClipView | null = null;
buildSliders($('color-sliders'), store, COLOR);
buildSliders($('sliders'), store, LIGHT, (v) => { if (v !== clipView) { clipView = v; schedule(); } });

let pipeline: Pipeline | null = null;
let fileName = 'photo';

const library = new Library();
const filmstrip = new Filmstrip($('filmstrip'), { onSelect: (id) => void showPhoto(id), onRemove: (id) => void removePhoto(id) });
let currentId: string | null = null; // photo on screen
let loadingPhoto = false;            // true while a photo's saved settings are being applied
let dirty = false;                   // settings changed since the last save
let saveTimer = 0;
let loadToken = 0;
let showOriginal = false;
let queued = false;

let noticeTimer = 0;
function say(msg: string, ms = 5000) {
  notice.textContent = msg; notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { notice.hidden = true; }, ms);
}

function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; draw(); });
}

function draw() {
  $<HTMLButtonElement>('undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !store.canRedo;
  if (!pipeline || !pipeline.imageWidth || view.hidden) return; // no photo on screen: the histogram stays blank
  pipeline.render(store.params, 'full');
  drawHistogram();
  if (showOriginal) pipeline.render(store.params, 'original');
  else if (levelsClip) {
    const ch = levelsClip.channel;
    pipeline.render(store.params, levelsClip.view === 'high' ? 'levelsClipHigh' : 'levelsClipLow', ch === 'rgb' ? [1, 1, 1] : [+(ch === 'r'), +(ch === 'g'), +(ch === 'b')]);
  } else if (clipView) pipeline.render(store.params, clipView === 'high' ? 'clipHigh' : 'clipLow');
  const clipping = levelsClip?.view ?? clipView;
  badge.textContent = showOriginal ? 'Original' : clipping === 'high' ? 'Clipped highlights' : 'Clipped shadows';
  badge.hidden = !showOriginal && !clipping;
}

/** The histogram in Levels follows the photo as it is edited. */
function drawHistogram() {
  levelsEditor.setLiveHistogram(measure(view));
}

/**
 * Sizes the photo to fit the window as it is right now. Called once per photo, so later window
 * resizes leave it alone; the exception is a phone or tablet being turned (see below).
 */
function fitPreview() {
  zoom = 0;
  applyZoom();
}

/** How much the photo is zoomed: 0 means "fit to the window", otherwise 1 = the photo's real pixels. */
let zoom = 0;
const ZOOM_STEPS = [0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** The scale at which the whole photo fits the window as it is right now. */
function fitScale(): number {
  if (!pipeline?.imageWidth) return 1;
  const r = stage.getBoundingClientRect();
  const pad = 2 * parseFloat(getComputedStyle(stage).paddingLeft); // 40 on desktop, less on small screens
  return Math.min(1, (r.width - pad) / pipeline.imageWidth, (r.height - pad) / pipeline.imageHeight);
}

/**
 * Sizes the photo for the current zoom. Only the photo changes size; the rest of the page does not.
 * The point of the photo under (anchorX, anchorY), in window coordinates, stays where it is.
 */
function applyZoom(anchorX?: number, anchorY?: number) {
  if (!pipeline?.imageWidth) return;
  const s = stage.getBoundingClientRect();
  const ax = anchorX ?? s.left + s.width / 2, ay = anchorY ?? s.top + s.height / 2;
  const old = view.getBoundingClientRect();
  const fx = old.width ? Math.min(1, Math.max(0, (ax - old.left) / old.width)) : 0.5;
  const fy = old.height ? Math.min(1, Math.max(0, (ay - old.top) / old.height)) : 0.5;

  const scale = zoom || fitScale();
  const w = Math.max(1, Math.round(pipeline.imageWidth * scale)), h = Math.max(1, Math.round(pipeline.imageHeight * scale));
  view.style.width = `${w}px`; view.style.height = `${h}px`;
  pipeline.setPreviewSize(Math.max(w, h) * (devicePixelRatio || 1)); // never more than the photo's real pixels
  view.classList.toggle('pixels', scale > 1);

  const now = view.getBoundingClientRect();
  stage.scrollLeft += now.left + fx * now.width - ax;
  stage.scrollTop += now.top + fy * now.height - ay;
  schedule();
}

/** Zooms to a new scale, kept between "fit" and the largest step. */
function setZoom(scale: number, anchorX?: number, anchorY?: number) {
  const fit = fitScale();
  zoom = scale <= fit * 1.001 ? 0 : Math.min(MAX_ZOOM, scale);
  applyZoom(anchorX, anchorY);
}

/** Cmd/Ctrl + and −: step through the usual zoom levels, starting from "fit". */
function stepZoom(direction: 1 | -1) {
  if (!pipeline?.imageWidth || view.hidden) return;
  const fit = fitScale(), current = zoom || fit;
  const steps = ZOOM_STEPS.filter((z) => z > fit * 1.001);
  const next = direction > 0
    ? steps.find((z) => z > current * 1.001) ?? MAX_ZOOM
    : [...steps].reverse().find((z) => z < current * 0.999) ?? 0;
  setZoom(next);
  say(zoom ? `Zoom ${Math.round(zoom * 100)}%` : 'Zoom: fit to window', 1500);
}

/** The scale at which the photo fills the whole window, edge to edge (some of it goes off screen). */
function fillScale(): number {
  if (!pipeline?.imageWidth) return 1;
  const r = stage.getBoundingClientRect();
  return Math.min(MAX_ZOOM, Math.max(r.width / pipeline.imageWidth, r.height / pipeline.imageHeight));
}

/** Where the mouse last was over the photo, so the space bar can zoom in on that spot. */
let pointer: { x: number; y: number } | null = null;
view.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; });
view.addEventListener('pointerleave', () => { pointer = null; });

/** Space bar: fit to window → fill the window → 100% → back to fit. */
function cycleZoom() {
  if (!pipeline?.imageWidth || view.hidden) return;
  const fit = fitScale(), current = zoom || fit;
  const views = [
    { scale: fit, label: 'Zoom: fit to window' },
    { scale: fillScale(), label: 'Zoom: fill the window' },
    { scale: 1, label: 'Zoom 100%' },
  ].sort((a, b) => a.scale - b.scale)
    .filter((v, i, all) => v.scale >= fit && (i === 0 || v.scale > all[i - 1].scale * 1.01)); // a small photo can make two the same
  const next = views.find((v) => v.scale > current * 1.01) ?? views[0];
  setZoom(next.scale, pointer?.x, pointer?.y);
  say(next.label, 1500);
}

/** Puts a decoded photo on screen. Returns false if the graphics setup failed. */
function display(source: ImageBitmap, name: string): boolean {
  try {
    pipeline ??= new Pipeline(view);
  } catch (err) {
    say((err as Error).message, 15000);
    return false;
  }
  pipeline.setImage(source);
  fileName = name.replace(/\.[^.]+$/, '') || 'photo';
  empty.hidden = true; view.hidden = false;
  fitPreview();
  pipeline.render(defaults(), 'original');
  levelsEditor.setHistogram(measure(view)); // the unedited photo, for the Auto button
  if (pipeline.downscaled) say(`This photo is larger than your graphics card allows, so it was scaled down to ${pipeline.imageWidth} × ${pipeline.imageHeight}.`, 9000);
  return true;
}

const remember = (id: string | null) => { try { id ? localStorage.setItem('library.current', id) : localStorage.removeItem('library.current'); } catch { /* ignore */ } };

/** Switches to a photo from the library, applying its own saved settings. */
async function showPhoto(id: string) {
  if (id === currentId) return;
  const token = ++loadToken;
  await saveNow();
  const meta = library.get(id);
  if (!meta) return;
  let bmp: ImageBitmap;
  try {
    bmp = await decode(await library.file(id));
  } catch {
    say(`Could not open "${meta.name}" from the library.`, 8000);
    return;
  }
  if (token !== loadToken) { bmp.close(); return; } // another photo was chosen meanwhile
  const ok = display(bmp, meta.name);
  bmp.close();
  if (!ok) return;
  currentId = id;
  remember(id);
  loadingPhoto = true;
  store.load(normalizeParams(meta.params));
  loadingPhoto = false;
  filmstrip.select(id);
  schedule();
}

function showEmpty() {
  currentId = null; remember(null);
  view.hidden = true; empty.hidden = false;
  levelsEditor.setHistogram(null);
  loadingPhoto = true; store.load(defaults()); loadingPhoto = false;
}

const PENDING = 'library.pending';

/**
 * Last-moment safety net. Saving to the library takes a few moments, which a closing tab does not
 * wait for, so unsaved settings are also written to a small instant store. They are moved into the
 * library the next time the app starts (see start()).
 */
function stashUnsaved() {
  if (!dirty || !currentId) return;
  try { localStorage.setItem(PENDING, JSON.stringify({ id: currentId, params: store.params })); } catch { /* ignore */ }
}
const clearStash = (id: string) => {
  try { if (JSON.parse(localStorage.getItem(PENDING) ?? 'null')?.id === id) localStorage.removeItem(PENDING); } catch { /* ignore */ }
};

/** Writes the current photo's settings and an up-to-date thumbnail to the library. */
async function saveNow() {
  clearTimeout(saveTimer);
  if (!dirty || !currentId || !pipeline) return;
  dirty = false;
  const id = currentId, params = structuredClone(store.params);
  try {
    pipeline.render(params, 'full');
    const thumb = makeThumb(view, view.width, view.height); // reads the canvas now, encodes later
    draw();                                                  // put back whatever view was showing
    await library.save(id, params, await thumb);
    if (!dirty) clearStash(id); // nothing newer is waiting, so the safety copy is no longer needed
    const meta = library.get(id);
    if (meta) filmstrip.update(meta, true);
    void refreshLibraryInfo();
  } catch (err) {
    dirty = true;
    say(`Could not save your edits: ${(err as Error).message}`, 10000);
  }
}

async function refreshLibraryInfo() {
  const used = await library.usage();
  const n = library.photos.length, edited = library.photos.filter((p) => p.edited).length;
  $('library-info').textContent = n
    ? `${n} photo${n === 1 ? '' : 's'}, ${edited} with adjustments${used !== null ? ` · ${(used / 1048576).toFixed(used < 104857600 ? 1 : 0)} MB stored in this browser` : ''}. The backup holds the adjustments, not the photos.`
    : 'No photos yet.';
  $<HTMLButtonElement>('backup').disabled = !n;
  $<HTMLButtonElement>('restore').disabled = !n;
}

async function addFiles(files: File[]) {
  if (!files.length) return;
  const before = library.photos.length;
  let result;
  try {
    result = await library.addFiles(files, (done, total) => {
      $('filmstrip').hidden = false;
      filmstrip.setInfo(library.photos.length, done < total ? `Adding ${done + 1} of ${total}…` : '');
    });
  } catch (err) {
    say((err as Error).message, 12000);
    result = { added: library.photos.slice(before), duplicates: [], failed: [] };
  }
  filmstrip.render(library.photos, currentId);
  if (result.added.length) {
    await showPhoto(result.added[0].id);
    if (!(await library.keep())) $('library-warn').hidden = false;
  }
  const notes: string[] = [];
  if (result.added.length > 1) notes.push(`Added ${result.added.length} photos.`);
  if (result.duplicates.length) notes.push(`${result.duplicates.length} already in the library.`);
  if (result.failed.length) notes.push(`Could not read: ${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? ` and ${result.failed.length - 3} more` : ''}.`);
  if (notes.length) say(notes.join(' '), 9000);
  void refreshLibraryInfo();
}

async function removePhoto(id: string) {
  const i = library.photos.findIndex((p) => p.id === id);
  if (i < 0) return;
  dirty = false; // nothing to save for a photo that is going away
  await library.remove(id);
  const next = library.photos[Math.min(i, library.photos.length - 1)];
  currentId = null;
  filmstrip.render(library.photos, null);
  if (next) await showPhoto(next.id); else showEmpty();
  void refreshLibraryInfo();
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function backupEdits() {
  await saveNow();
  download(new Blob([library.backupText()], { type: 'application/json' }), `canvasshutter-backup-${new Date().toISOString().slice(0, 10)}.json`);
  say('Backup saved to your downloads. It holds the adjustments, not the photos.', 7000);
}

async function restoreEdits(file: File | undefined | null) {
  if (!file) return;
  try {
    await saveNow();
    const { restored, unmatched } = await library.restore(await file.text());
    for (const id of restored) { const m = library.get(id); if (m) filmstrip.update(m); }
    if (currentId && restored.includes(currentId)) {
      loadingPhoto = true; store.load(normalizeParams(library.get(currentId)!.params)); loadingPhoto = false;
      dirty = true; void saveNow(); // refresh the current photo's thumbnail
    }
    say(`Restored adjustments for ${restored.length} photo${restored.length === 1 ? '' : 's'}.${unmatched ? ` ${unmatched} in the backup did not match a photo in the library.` : ''}`, 9000);
    void refreshLibraryInfo();
  } catch (err) {
    say((err as Error).message, 9000);
  }
}

function sampleImage() {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 800;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 520);
  sky.addColorStop(0, '#27457a'); sky.addColorStop(0.7, '#e9a66b'); sky.addColorStop(1, '#f6dfb0');
  g.fillStyle = sky; g.fillRect(0, 0, 1200, 520);
  const sun = g.createRadialGradient(820, 430, 0, 820, 430, 260);
  sun.addColorStop(0, 'rgba(255,255,240,1)'); sun.addColorStop(0.15, 'rgba(255,230,170,.8)'); sun.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = sun; g.fillRect(0, 0, 1200, 520);
  const land = g.createLinearGradient(0, 520, 0, 800);
  land.addColorStop(0, '#2c3a2a'); land.addColorStop(1, '#070908');
  g.fillStyle = land; g.fillRect(0, 520, 1200, 280);
  g.fillStyle = '#10160f';
  g.beginPath(); g.moveTo(0, 560);
  for (let x = 0; x <= 1200; x += 40) g.lineTo(x, 500 - 60 * Math.sin(x / 130) - 30 * Math.sin(x / 47));
  g.lineTo(1200, 620); g.lineTo(0, 620); g.fill();
  for (let i = 0; i < 11; i++) { const v = Math.round((i / 10) * 255); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(40 + i * 60, 700, 60, 60); }
  c.toBlob((b) => { if (b) void addFiles([new File([b], 'test-image.png', { type: 'image/png' })]); }, 'image/png');
}

/** Renders at full size and hands the file to the browser to save. Throws if there is no photo. */
async function exportFile(type: 'image/png' | 'image/jpeg') {
  if (!pipeline?.imageWidth) throw new Error('Open a photo first.');
  const blob = await pipeline.export(store.params, type);
  const name = `${fileName}-edited.${type === 'image/png' ? 'png' : 'jpg'}`;
  download(blob, name);
  schedule();
  return { fileName: name, width: pipeline.imageWidth, height: pipeline.imageHeight, bytes: blob.size };
}

async function exportAs(type: 'image/png' | 'image/jpeg') {
  try { await exportFile(type); } catch (err) { say((err as Error).message, 8000); }
}

/** A JPEG of the photo as currently edited, for Claude to look at. */
async function previewJpeg(maxSide: number) {
  if (!pipeline?.imageWidth) throw new Error('Open a photo first.');
  pipeline.render(store.params, 'full');
  const s = Math.min(1, maxSide / Math.max(view.width, view.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(view.width * s)); c.height = Math.max(1, Math.round(view.height * s));
  c.getContext('2d')!.drawImage(view, 0, 0, c.width, c.height); // read the canvas now, before anything else draws
  draw();
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('The browser could not encode the preview.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { jpegBase64: btoa(bin), width: c.width, height: c.height };
}

/** Histogram of the photo as currently edited. */
function editedHistogram() {
  if (!pipeline?.imageWidth) throw new Error('Open a photo first.');
  pipeline.render(store.params, 'full');
  const h = measure(view);
  draw();
  return h;
}

// What an assistant may do in this editor. Shared by the built-in AI chat and the Claude Code bridge.
const commands = new EditorCommands({
  store, library, currentId: () => currentId, showPhoto, saveNow, preview: previewJpeg, histogram: editedHistogram,
  exportPhoto: (f) => exportFile(f === 'jpeg' ? 'image/jpeg' : 'image/png'),
});

// The AI chat built into the editor. Nothing is sent anywhere until the user connects an AI account and asks.
setupChat(commands);

// Link to the local Claude Code bridge (the advanced option). Off until the user switches it on.
const linkText: Record<LinkState, string> = {
  off: 'Off. Claude Code cannot see or change anything here.',
  waiting: 'Waiting for Claude Code… (the bridge starts when Claude Code loads this project)',
  connected: 'Connected. Claude Code can read and change this editor.',
};
const remote = new Remote(commands, (state) => { $('claude-status').textContent = linkText[state]; $('claude-dot').dataset.state = state; });
const claudeToggle = $<HTMLInputElement>('claude-toggle');
let claudeOn = false;
try { claudeOn = localStorage.getItem('claude.enabled') === '1'; } catch { /* ignore */ }
claudeToggle.checked = claudeOn;
if (claudeOn) $<HTMLDetailsElement>('sub-claude-code').open = true; // keep a link that is switched on in plain sight
remote.setEnabled(claudeOn);
claudeToggle.addEventListener('change', () => {
  try { localStorage.setItem('claude.enabled', claudeToggle.checked ? '1' : '0'); } catch { /* ignore */ }
  remote.setEnabled(claudeToggle.checked);
});

function setOriginal(on: boolean) { if (showOriginal !== on) { showOriginal = on; $('before').classList.toggle('primary', on); schedule(); } }

store.subscribe(schedule);
// Autosave: shortly after each change, and at once when the tab is hidden or closed.
store.subscribe(() => {
  if (!currentId || loadingPhoto) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 400);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { stashUnsaved(); void saveNow(); } });
addEventListener('pagehide', () => { stashUnsaved(); void saveNow(); });
addEventListener('resize', schedule); // redraws the histogram; the photo keeps its size
// Turning a phone or tablet swaps the layout, so there the photo is fitted again.
matchMedia('(orientation: portrait)').addEventListener('change', () => { placeFilmstrip(); if (isTouchDevice()) { fitPreview(); schedule(); } });

/*
 * On a phone held upright (or a narrow window) the thumbnails sit at the top of the controls, so the
 * photo gets more of the screen. Everywhere else they stay under the photo. The strip is moved, not
 * copied, so it keeps working as before.
 */
const narrow = matchMedia('(max-width: 760px)');
const sideways = matchMedia('(max-height: 500px) and (orientation: landscape) and (pointer: coarse)');
function placeFilmstrip() {
  const strip = $('filmstrip'), panel = $('panel'), work = $('work');
  const inPanel = narrow.matches && !sideways.matches;
  if (inPanel && strip.parentElement !== panel) panel.querySelector('header.toolbar')!.after(strip);
  else if (!inPanel && strip.parentElement !== work) work.insertBefore(strip, $('ai-open'));
  else return;
  if (isTouchDevice()) { fitPreview(); schedule(); } // the photo's area changed size
}
placeFilmstrip();
narrow.addEventListener('change', placeFilmstrip);
sideways.addEventListener('change', placeFilmstrip);

$('open').addEventListener('click', () => fileInput.click());
$('open-empty').addEventListener('click', () => fileInput.click());
$('sample').addEventListener('click', sampleImage);
fileInput.addEventListener('change', () => { void addFiles([...(fileInput.files ?? [])]); fileInput.value = ''; });
const backupInput = $<HTMLInputElement>('backup-file');
$('backup').addEventListener('click', () => void backupEdits());
$('restore').addEventListener('click', () => backupInput.click());
backupInput.addEventListener('change', () => { void restoreEdits(backupInput.files?.[0]); backupInput.value = ''; });
$('undo').addEventListener('click', () => store.undo());
$('redo').addEventListener('click', () => store.redo());
$('reset-all').addEventListener('click', () => store.reset());
$('reset-levels').addEventListener('click', () => { store.change((p) => { for (const ch of CHANNELS) p.levels[ch] = defaultLevels(); }); store.commit(); });
$('reset-light').addEventListener('click', () => { store.change((p) => { for (const d of LIGHT) p[d.key] = 0; }); store.commit(); });
$('reset-color').addEventListener('click', () => { store.change((p) => { for (const d of COLOR) p[d.key] = 0; }); store.commit(); });

// Each section opens and closes from its header; the choice is remembered between visits.
for (const d of document.querySelectorAll<HTMLDetailsElement>('details.section')) {
  const key = `section.${d.id}`;
  let saved: string | null = null;
  try { saved = localStorage.getItem(key); } catch { /* storage unavailable: use defaults */ }
  if (saved !== null) d.open = saved === '1';
  d.addEventListener('toggle', () => { try { localStorage.setItem(key, d.open ? '1' : '0'); } catch { /* ignore */ } });
}

$('export-png').addEventListener('click', () => exportAs('image/png'));
$('export-jpg').addEventListener('click', () => exportAs('image/jpeg'));

const before = $('before');
before.addEventListener('pointerdown', () => setOriginal(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) before.addEventListener(ev, () => setOriginal(false));
before.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') setOriginal(true); });
before.addEventListener('keyup', () => setOriginal(false));

addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches?.('input');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); }
  // Cmd/Ctrl + − 0 zoom only the photo, instead of the whole page.
  else if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); stepZoom(1); }
  else if (mod && !e.altKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); stepZoom(-1); }
  else if (mod && !e.altKey && e.key === '0') { e.preventDefault(); if (zoom) { fitPreview(); say('Zoom: fit to window', 1500); } }
  // Space cycles the zoom, unless it is meant for a button, box or slider that has the keyboard.
  else if (e.key === ' ' && !mod && !e.altKey && !(e.target as HTMLElement).closest?.('input, textarea, select, button, summary, a, [role=slider], [contenteditable]')) {
    e.preventDefault(); // otherwise the page would scroll
    if (!e.repeat) cycleZoom();
  }
  else if (!typing && !mod && e.key === '\\') setOriginal(true);
  else if (!typing && !mod && e.key.toLowerCase() === 'o') fileInput.click();
  else if (!mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target as HTMLElement).closest?.('input, select, [role=slider]')) {
    // Left/Right step through the library when no slider or box has the keyboard.
    const i = library.photos.findIndex((p) => p.id === currentId);
    const next = library.photos[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { e.preventDefault(); void showPhoto(next.id); }
  }
});
addEventListener('keyup', (e) => { if (e.key === '\\') setOriginal(false); });

// A trackpad pinch (or Ctrl + scroll wheel) over the photo zooms the photo around the pointer, not the page.
stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return; // an ordinary scroll moves around a zoomed-in photo
  e.preventDefault();
  if (!pipeline?.imageWidth || view.hidden) return;
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // some mice report lines, not pixels
  setZoom((zoom || fitScale()) * Math.exp(-delta * 0.01), e.clientX, e.clientY);
}, { passive: false });
// Safari on a Mac reports a trackpad pinch as its own "gesture" events instead.
type Gesture = Event & { scale: number; clientX: number; clientY: number };
let pinchStart = 0;
// iPads send the same events for a two-finger pinch on the screen; those are left alone.
stage.addEventListener('gesturestart', (e) => { if (isTouchDevice()) return; e.preventDefault(); pinchStart = zoom || fitScale(); });
stage.addEventListener('gesturechange', (e) => {
  if (isTouchDevice()) return;
  e.preventDefault();
  const g = e as Gesture;
  if (pipeline?.imageWidth && !view.hidden) setZoom(pinchStart * g.scale, g.clientX, g.clientY);
});
stage.addEventListener('gestureend', (e) => { if (!isTouchDevice()) e.preventDefault(); });

addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('dragover'); });
addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragover'); void addFiles([...(e.dataTransfer?.files ?? [])]); });

/** Start-up: reopen the library and the photo that was open last time. */
async function start() {
  try {
    await library.init();
  } catch (err) {
    say(`Your photo library could not be opened: ${(err as Error).message}`, 15000);
  }
  // Settings that were stashed as the tab closed last time: move them into the library now.
  let recovered: string | null = null;
  try {
    const pending = JSON.parse(localStorage.getItem(PENDING) ?? 'null');
    if (pending && library.get(pending.id)) { await library.save(pending.id, normalizeParams(pending.params)); recovered = pending.id; }
    localStorage.removeItem(PENDING);
  } catch { /* a damaged stash is ignored */ }
  filmstrip.render(library.photos, null);
  void refreshLibraryInfo();
  if (library.photos.length) {
    let last: string | null = null;
    try { last = localStorage.getItem('library.current'); } catch { /* ignore */ }
    await showPhoto((library.get(last) ?? library.photos[0]).id);
    if (recovered && recovered === currentId) { dirty = true; void saveNow(); } // refresh its thumbnail too
    if (!(await library.keep())) $('library-warn').hidden = false;
  } else {
    empty.hidden = false; // shown only once we know the library is empty, so it never flashes on return visits
    if (new URLSearchParams(location.search).has('sample')) sampleImage();
  }
}

draw();
void start();
