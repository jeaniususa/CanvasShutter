/**
 * Jeanius levels: Jean's per-channel Levels style, set automatically.
 *
 * It finds the photo's subject (faces and skin tones first, then sharp detail near the middle), the
 * shadows just around it, and anything on or next to the subject that should be white. Then, for
 * the red, green and blue channels separately:
 *  - White point: on the "should be white" area if there is one (this also removes a color cast),
 *    otherwise a little above the brightest light on the subject. If the subject's highlights are
 *    already at full brightness, the white point stays at 255.
 *  - Black point: where a few of the subject's darkest pixels clip. On an already-bright photo the
 *    contrast comes from the shadows around the subject instead. If the subject already has true
 *    black, the shadows are left alone and only the white points correct the color.
 *  - Midtones stay at 1.00.
 *
 * Fitted on eight of Jean's own edits (average 5.6 levels out of 255 from her values). Pure maths on
 * pixel arrays, with no browser calls, so it can be tested on its own. Mirrors auto_levels.py.
 */

export interface RGBAImage { data: Uint8ClampedArray | Uint8Array; width: number; height: number }
export interface ChannelPoints { black: number; white: number }
export interface JeaniusResult { r: ChannelPoints; g: ChannelPoints; b: ChannelPoints; why: string[] }

const BLACK_PCT = 0.1;         // % of the subject's pixels that clip at the black end
const WHITE_PCT = 99.9;        // the subject's brightest light, ignoring stray pixels
const HEADROOM = 0.94;         // white point sits ~6% above that light
const WHITE_REF_PCT = 95;      // white point = this percentile of the "should be white" area
const BRIGHT_LEVEL = 250;      // subject highlights this bright = an already-bright photo
const BRIGHT_BLACK_PCT = 3;    // on bright photos, % of the shadows around the subject that clip
const TRUE_BLACK = 5;          // a channel this dark on the subject = shadows already black

const WORK_SIDE = 320;         // analysis size (long side, pixels)
const WHITE_MIN_AREA = 0.01;   // white pixels on/around the subject must cover 1% of the photo
const WHITE_MAX_CHROMA = 0.3;  // (max-min)/max of a "white" pixel: near-neutral, allowing a cast

/** Mean over a (2r+1)² window, edges extended. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
  const cx = (x: number) => (x < 0 ? 0 : x >= w ? w - 1 : x), cy = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[row + cx(i)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      s += src[row + cx(x + r + 1)] - src[row + cx(x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[cy(i) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (k * k);
      s += tmp[cy(y + r + 1) * w + x] - tmp[cy(y - r) * w + x];
    }
  }
  return out;
}

/** Percentile with linear interpolation (like numpy's default). */
export function percentile(values: Float32Array, q: number): number {
  if (!values.length) return 0;
  const s = Float32Array.from(values).sort();
  const pos = ((s.length - 1) * q) / 100, lo = Math.floor(pos), hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** The same, for 0-255 values counted in a 256-bin histogram. */
function histPercentile(bins: Uint32Array, total: number, q: number): number {
  if (!total) return 0;
  const pos = ((total - 1) * q) / 100, lo = Math.floor(pos);
  const at = (rank: number) => { let c = 0; for (let v = 0; v < 256; v++) { c += bins[v]; if (c > rank) return v; } return 255; };
  const a = at(lo), b = at(Math.min(total - 1, lo + 1));
  return a + (b - a) * (pos - lo);
}

/** Area-average downscale to WORK_SIDE on the long side, as three float planes. */
function shrink(img: RGBAImage) {
  const scale = Math.min(1, WORK_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let sr = 0, sg = 0, sb = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.width + xx) * 4;
        sr += img.data[i]; sg += img.data[i + 1]; sb += img.data[i + 2];
      }
      const n = (y1 - y0) * (x1 - x0), j = y * w + x;
      r[j] = sr / n; g[j] = sg / n; b[j] = sb / n;
    }
  }
  return { w, h, r, g, b };
}

/** Connected region of `mask` containing `seed` (4 neighbours). */
function grow(mask: Uint8Array, w: number, h: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h), stack = [seed];
  while (stack.length) {
    const i = stack.pop()!;
    if (!mask[i] || out[i]) continue;
    out[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (y + 1 < h) stack.push(i + w);
    if (y > 0) stack.push(i - w);
    if (x + 1 < w) stack.push(i + 1);
    if (x > 0) stack.push(i - 1);
  }
  return out;
}

/** Areas found in the photo, at analysis size: subject, shadows around it, should-be-white (or null). */
export interface Areas { w: number; h: number; focal: Uint8Array; ring: Uint8Array; white: Uint8Array | null }

export function detect(img: RGBAImage): Areas {
  const { w, h, r: R, g: G, b: B } = shrink(img);
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
  const rad = Math.max(2, Math.round(Math.min(w, h) * 0.03));

  // 1. Subject: sharp detail + skin tones + a pull toward the middle, never blown-out areas.
  const lap = new Float32Array(n);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x;
    lap[i] = Math.abs(4 * luma[i] - luma[i - w] - luma[i + w] - luma[i - 1] - luma[i + 1]);
  }
  const sharp = boxBlur(lap, w, h, rad);
  const sharpTop = percentile(sharp, 99) + 1e-6;
  const skin = new Float32Array(n), blown = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = R[i], g = G[i], b = B[i];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const d = Math.max(77 - cb, cb - 127, 133 - cr, cr - 173, 0);
    skin[i] = luma[i] > 40 && luma[i] < 245 ? Math.exp(-d / 6) : 0;
    blown[i] = Math.max(r, g, b) >= 250 ? 1 : 0;
  }
  const skinB = boxBlur(skin, w, h, rad), blownB = boxBlur(blown, w, h, rad);
  let sal: Float32Array = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const c = Math.exp(-(((x - w / 2) / (0.45 * w)) ** 2 + ((y - h / 2) / (0.45 * h)) ** 2));
    sal[i] = (0.5 * Math.min(1, Math.max(0, sharp[i] / sharpTop)) + 0.9 * skinB[i]) * (0.4 + 0.6 * c) * (1 - blownB[i]);
  }
  sal = boxBlur(sal, w, h, rad);
  let peak = 0;
  for (let i = 1; i < n; i++) if (sal[i] > sal[peak]) peak = i;
  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i++) strong[i] = sal[i] >= 0.6 * sal[peak] ? 1 : 0;
  const focal = grow(strong, w, h, peak);

  // 2. Shadows: the area just around the subject.
  const focalF = Float32Array.from(focal);
  const near = boxBlur(focalF, w, h, 3 * rad), ring = new Uint8Array(n);
  for (let i = 0; i < n; i++) ring[i] = near[i] > 0.02 && !focal[i] ? 1 : 0;

  // 3. Should be white: bright, near-neutral, not blown, on or right around the subject.
  const mx = new Float32Array(n);
  for (let i = 0; i < n; i++) mx[i] = Math.max(R[i], G[i], B[i]);
  const bright60 = percentile(mx, 60), raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = mx[i], mn = Math.min(R[i], G[i], B[i]);
    raw[i] = m > bright60 && (m - mn) / (m + 1e-6) < WHITE_MAX_CHROMA && m < 250 && m > 120 ? 1 : 0;
  }
  const rawB = boxBlur(raw, w, h, 1);
  let white: Uint8Array | null = new Uint8Array(n), count = 0;
  for (let i = 0; i < n; i++) if (rawB[i] > 0.5 && (focal[i] || ring[i])) { white[i] = 1; count++; }
  if (count / n < WHITE_MIN_AREA) white = null;
  return { w, h, focal, ring, white };
}

/** Per-channel histograms of the full image's pixels that fall in a mask (mask at analysis size). */
function maskedHist(img: RGBAImage, a: Areas, mask: Uint8Array) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let total = 0;
  for (let y = 0; y < img.height; y++) {
    const my = Math.min(a.h - 1, Math.floor(((y + 0.5) * a.h) / img.height));
    for (let x = 0; x < img.width; x++) {
      const mxx = Math.min(a.w - 1, Math.floor(((x + 0.5) * a.w) / img.width));
      if (!mask[my * a.w + mxx]) continue;
      const i = (y * img.width + x) * 4;
      hist[0][img.data[i]]++; hist[1][img.data[i + 1]]++; hist[2][img.data[i + 2]]++;
      total++;
    }
  }
  return { hist, total, pct: (ch: number, q: number) => histPercentile(hist[ch], total, q) };
}

/** Jean's rule, given the areas. */
export function suggest(img: RGBAImage, a: Areas): JeaniusResult {
  const f = maskedHist(img, a, a.focal);
  const ringStats = maskedHist(img, a, a.ring);
  const s = ringStats.total ? ringStats : f;
  const ref = a.white ? maskedHist(img, a, a.white) : null;
  const bright = [0, 1, 2].every((c) => f.pct(c, WHITE_PCT) >= BRIGHT_LEVEL);
  const lows = [0, 1, 2].map((c) => f.pct(c, BLACK_PCT));
  const trueBlack = !bright && Math.min(...lows) <= TRUE_BLACK ? Math.round(Math.min(...lows)) : null;

  const why: string[] = [];
  if (trueBlack !== null) why.push('The subject already has true black, so the shadows are left alone and the color is fixed in the highlights.');
  if (bright) why.push('Bright photo: whites stay at 255 and the contrast comes from the shadows around the subject.');
  else if (ref) why.push('Found something that should be white on the subject, so the white points are set on it.');
  else why.push('White points set just above the brightest light on the subject.');

  const pts = [0, 1, 2].map((c): ChannelPoints => {
    let black: number, white: number;
    if (bright) { black = s.pct(c, BRIGHT_BLACK_PCT); white = 255; }
    else {
      black = f.pct(c, BLACK_PCT);
      white = ref ? ref.pct(c, WHITE_REF_PCT) : f.pct(c, WHITE_PCT) / HEADROOM;
    }
    black = Math.round(Math.max(0, black)); white = Math.round(Math.min(255, white));
    if (trueBlack !== null) black = trueBlack;
    white = Math.max(white, Math.min(255, black + 10));
    return { black, white };
  });
  return { r: pts[0], g: pts[1], b: pts[2], why };
}

/** Finds the areas and applies the rule in one go. */
export function jeaniusLevels(img: RGBAImage): JeaniusResult {
  return suggest(img, detect(img));
}
