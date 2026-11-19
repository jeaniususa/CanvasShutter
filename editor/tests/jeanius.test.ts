import { describe, expect, it } from 'vitest';
import { boxBlur, jeaniusLevels, percentile, type RGBAImage } from '../src/jeanius';
import { crc32, makeZip, uniqueNames } from '../src/zip';

/** A test photo: plain background, an oval "face" in skin tones with dark features, optional patches. */
function photo(opts: { bg: [number, number, number]; white?: [number, number, number]; blown?: boolean }): RGBAImage {
  const w = 300, h = 400, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c: [number, number, number] = opts.bg;
    const fx = (x - 150) / 60, fy = (y - 150) / 80;
    if (opts.white && y > 222 && x > 70 && x < 230) c = opts.white;                    // e.g. a white shirt right under the chin
    if (fx * fx + fy * fy < 1) {
      const shade = 0.75 + 0.25 * Math.sin(x / 7) * Math.cos(y / 9);                    // some detail on the face
      c = [Math.round(205 * shade), Math.round(150 * shade), Math.round(120 * shade)];
      if ((Math.abs(x - 128) < 8 || Math.abs(x - 172) < 8) && Math.abs(y - 135) < 4) c = [30, 22, 20]; // eyes
      if (Math.abs(x - 150) < 18 && Math.abs(y - 195) < 3) c = [110, 30, 35];          // mouth
    }
    if (opts.blown && y < 60) c = [255, 255, 255];
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe('jeanius helpers', () => {
  it('percentile interpolates like numpy', () => {
    const v = Float32Array.from([1, 2, 3, 4]);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 50)).toBeCloseTo(2.5, 6);
    expect(percentile(v, 100)).toBe(4);
  });
  it('box blur keeps a flat image flat and spreads a single point evenly', () => {
    const flat = new Float32Array(25).fill(7);
    for (const v of boxBlur(flat, 5, 5, 1)) expect(v).toBeCloseTo(7, 5);
    const dot = new Float32Array(25); dot[12] = 9;
    const out = boxBlur(dot, 5, 5, 1);
    expect(out[12]).toBeCloseTo(1, 5);
    expect(out[0]).toBe(0);
  });
});

describe('jeanius levels', () => {
  it('uses a tinted white on the subject as the white point, removing the cast', () => {
    const r = jeaniusLevels(photo({ bg: [120, 125, 130], white: [235, 215, 180] })); // yellowish "white" shirt
    expect(r.b.white).toBeLessThan(r.r.white - 20);                                       // blue pulled down the most
    expect(Math.abs(r.r.white - 235)).toBeLessThanOrEqual(3);
    expect(Math.abs(r.b.white - 180)).toBeLessThanOrEqual(3);
    expect(r.why.join(' ')).toMatch(/should be white/);
  });
  it('leaves whites at 255 on an already-bright subject', () => {
    const img = photo({ bg: [90, 140, 60] });
    for (let i = 0; i < img.data.length; i += 4) {                                        // push the face's highlights to full
      if (img.data[i] > 190) { img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; }
    }
    const r = jeaniusLevels(img);
    expect([r.r.white, r.g.white, r.b.white]).toEqual([255, 255, 255]);
  });
  it('keeps every black point below its white point and inside 0..255', () => {
    for (const p of [photo({ bg: [20, 20, 20] }), photo({ bg: [250, 250, 250], blown: true }), photo({ bg: [128, 128, 128] })]) {
      const r = jeaniusLevels(p);
      for (const c of [r.r, r.g, r.b]) {
        expect(c.black).toBeGreaterThanOrEqual(0);
        expect(c.white).toBeLessThanOrEqual(255);
        expect(c.white).toBeGreaterThan(c.black);
      }
    }
  });
  it('does not fail on a tiny or flat image', () => {
    const flat: RGBAImage = { data: new Uint8ClampedArray(4 * 4 * 4).fill(128), width: 4, height: 4 };
    const r = jeaniusLevels(flat);
    expect(r.r.white).toBeGreaterThan(r.r.black);
  });
});

describe('zip export', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes a well-formed archive', async () => {
    const zip = makeZip([{ name: 'a.jpg', data: new Uint8Array([1, 2, 3]) }, { name: 'b.jpg', data: new Uint8Array([4]) }]);
    const b = new Uint8Array(await zip.arrayBuffer());
    const v = new DataView(b.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);            // first local header
    const end = b.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);          // end record
    expect(v.getUint16(end + 10, true)).toBe(2);              // two files
    const cd = v.getUint32(end + 16, true);
    expect(v.getUint32(cd, true)).toBe(0x02014b50);           // central directory where the end record says
  });
  it('never repeats a file name', () => {
    expect(uniqueNames(['a.jpg', 'A.jpg', 'a.jpg', 'b'])).toEqual(['a.jpg', 'A (2).jpg', 'a (3).jpg', 'b']);
  });
});
