export interface Histogram { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array }

const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

/** Reads what the given canvas currently shows (scaled down) and counts values per channel. */
export function measure(source: HTMLCanvasElement): Histogram {
  const s = Math.min(1, 256 / Math.max(source.width, source.height));
  scratch.width = Math.max(1, Math.round(source.width * s));
  scratch.height = Math.max(1, Math.round(source.height * s));
  sctx.drawImage(source, 0, 0, scratch.width, scratch.height);
  const d = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
  const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
  for (let i = 0; i < d.length; i += 4) {
    h.r[d[i]]++; h.g[d[i + 1]]++; h.b[d[i + 2]]++;
    h.l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
  }
  return h;
}

/** Fills one channel's histogram as an area along the bottom of the given rectangle. */
export function drawArea(ctx: CanvasRenderingContext2D, bins: Uint32Array, x: number, y: number, w: number, h: number, color: string) {
  // Scale to a high percentile so one clipped spike does not flatten everything else.
  const sorted = Array.from(bins).sort((a, b) => a - b);
  const peak = Math.max(1, sorted[250]);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  for (let i = 0; i < 256; i++) ctx.lineTo(x + (i / 255) * w, y + h - Math.min(1, bins[i] / peak) * h);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
