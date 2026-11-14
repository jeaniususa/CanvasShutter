import type { PhotoMeta } from '../library/db';
import { isTouchDevice } from './touch';

interface Handlers { onSelect: (id: string) => void; onRemove: (id: string) => void }

/** Row of thumbnails under the photo: click to switch photos, with a remove control for the current one. */
export class Filmstrip {
  private info = document.createElement('span');
  private removeBtn = document.createElement('button');
  private list = document.createElement('div');
  private urls = new Map<string, string>();
  private current: string | null = null;
  private armed = 0;

  constructor(private root: HTMLElement, private handlers: Handlers) {
    const bar = document.createElement('div'); bar.className = 'film-bar';
    this.info.className = 'film-info';
    this.info.setAttribute('role', 'status');
    this.removeBtn.className = 'link';
    this.removeBtn.addEventListener('click', () => this.clickRemove());
    bar.append(this.info, this.removeBtn);
    this.list.className = 'film-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Photos in your library');
    root.append(bar, this.list);
    this.disarm();
  }

  /** Remove takes two clicks, so a slip cannot delete a photo. */
  private clickRemove() {
    if (!this.current) return;
    if (!this.armed) {
      this.removeBtn.textContent = `${isTouchDevice() ? 'Tap' : 'Click'} again to remove`;
      this.removeBtn.classList.add('danger');
      this.armed = window.setTimeout(() => this.disarm(), 3000);
      return;
    }
    const id = this.current;
    this.disarm();
    this.handlers.onRemove(id);
  }

  private disarm() {
    clearTimeout(this.armed); this.armed = 0;
    this.removeBtn.textContent = 'Remove photo';
    this.removeBtn.classList.remove('danger');
  }

  private url(p: PhotoMeta) {
    const old = this.urls.get(p.id);
    if (old) URL.revokeObjectURL(old);
    const u = URL.createObjectURL(p.thumb);
    this.urls.set(p.id, u);
    return u;
  }

  /** Rebuilds the whole strip. */
  render(photos: PhotoMeta[], current: string | null) {
    this.current = current;
    this.disarm();
    this.root.hidden = photos.length === 0;
    for (const [id, u] of this.urls) if (!photos.some((p) => p.id === id)) { URL.revokeObjectURL(u); this.urls.delete(id); }
    this.list.replaceChildren(...photos.map((p) => {
      const b = document.createElement('button');
      b.className = 'film-item'; b.dataset.id = p.id; b.title = p.name;
      b.setAttribute('role', 'option');
      const img = document.createElement('img');
      // Fixed size from the photo's shape, so the strip does not shift while thumbnails load.
      img.alt = ''; img.draggable = false; img.height = 62; img.width = Math.max(40, Math.round((62 * p.width) / Math.max(1, p.height)));
      img.src = this.urls.get(p.id) ?? this.url(p);
      const dot = document.createElement('span'); dot.className = 'film-dot';
      b.append(img, dot);
      b.addEventListener('click', () => this.handlers.onSelect(p.id));
      return b;
    }));
    for (const p of photos) this.update(p);
    this.select(current);
    this.setInfo(photos.length);
  }

  /** Refreshes one photo's thumbnail and its "has adjustments" dot. */
  update(p: PhotoMeta, newThumb = false) {
    const b = this.list.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
    if (!b) return;
    b.classList.toggle('edited', p.edited);
    b.setAttribute('aria-label', p.name + (p.edited ? ' (adjusted)' : ''));
    if (newThumb) b.querySelector('img')!.src = this.url(p);
  }

  select(id: string | null) {
    this.current = id;
    this.disarm();
    this.removeBtn.hidden = !id;
    for (const b of this.list.querySelectorAll<HTMLElement>('.film-item')) {
      const on = b.dataset.id === id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  setInfo(count: number, extra = '') {
    this.info.textContent = `${count} photo${count === 1 ? '' : 's'}${extra ? ` · ${extra}` : ''}`;
  }
}
