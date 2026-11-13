import { Pipeline } from './gl/pipeline';
import { drawArea, measure } from './histogram';
import { Library, decode, makeThumb } from './library/library';
import { Remote, type LinkState } from './remote';
import { CHANNELS, Store, defaultLevels, defaults, normalizeParams } from './state';
import { Filmstrip } from './ui/filmstrip';
import { LevelsEditor, type LevelsClip } from './ui/levels';
import { COLOR, LIGHT, buildSliders, type ClipView } from './ui/sliders';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), view = $<HTMLCanvasElement>('view'), empty = $('empty'), badge = $('badge'), notice = $('notice');
const histCanvas = $<HTMLCanvasElement>('histogram'), fileInput = $<HTMLInputElement>('file');

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
  if (!pipeline || !pipeline.imageWidth) return;
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

function drawHistogram() {
  const r = histCanvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  histCanvas.width = Math.round(r.width * dpr); histCanvas.height = Math.round(r.height * dpr);
  const g = histCanvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const h = measure(view);
  g.globalCompositeOperation = 'lighter';
  drawArea(g, h.r, 0, 4, r.width, r.height - 4, 'rgba(255,80,70,0.75)');
  drawArea(g, h.g, 0, 4, r.width, r.height - 4, 'rgba(70,200,100,0.75)');
  drawArea(g, h.b, 0, 4, r.width, r.height - 4, 'rgba(80,130,255,0.75)');
  g.globalCompositeOperation = 'source-over';
}

/** Sizes the photo to fit the window as it is right now. Called once per photo, so later window resizes leave it alone. */
function fitPreview() {
  if (!pipeline) return;
  const r = stage.getBoundingClientRect();
  const fit = Math.min(1, (r.width - 40) / pipeline.imageWidth, (r.height - 40) / pipeline.imageHeight);
  const w = Math.max(1, Math.round(pipeline.imageWidth * fit)), h = Math.max(1, Math.round(pipeline.imageHeight * fit));
  view.style.width = `${w}px`; view.style.height = `${h}px`;
  pipeline.setPreviewSize(Math.max(w, h) * (devicePixelRatio || 1));
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
  levelsEditor.setHistogram(measure(view)); // the levels histogram shows the unedited photo
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

// Link to the local Claude bridge. Off until the user switches it on in the Claude section.
const linkText: Record<LinkState, string> = {
  off: 'Off. Claude cannot see or change anything here.',
  waiting: 'Waiting for Claude Code… (the bridge starts when Claude Code loads this project)',
  connected: 'Connected. Claude can read and change this editor.',
};
const remote = new Remote(
  { store, library, currentId: () => currentId, showPhoto, saveNow, preview: previewJpeg, histogram: editedHistogram,
    exportPhoto: (f) => exportFile(f === 'jpeg' ? 'image/jpeg' : 'image/png') },
  (state) => { $('claude-status').textContent = linkText[state]; $('claude-dot').dataset.state = state; },
);
const claudeToggle = $<HTMLInputElement>('claude-toggle');
let claudeOn = false;
try { claudeOn = localStorage.getItem('claude.enabled') === '1'; } catch { /* ignore */ }
claudeToggle.checked = claudeOn;
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
