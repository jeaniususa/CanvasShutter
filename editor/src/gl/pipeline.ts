import type { Params } from '../state';
import { buildToneLut, shoulderStart } from '../tone';

const TONE_SIZE = 1024;
/** Strength of the Color sliders (temp, tint, vibrance, saturation): 1.5x on the positive side, 1x on the negative side. */
export const COLOR_GAIN = 1.5;
const colorAmount = (v: number) => (v / 100) * (v > 0 ? COLOR_GAIN : 1);

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = vec2(p.x, 1.0 - p.y); // image row 0 is the top of the photo
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Processing order: levels -> white balance and exposure with a highlight roll-off (in linear
// light) -> one shared tone response for contrast, highlights, shadows, whites and blacks (on
// brightness, in display space) -> vibrance and saturation. The tone math lives in src/tone.ts.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform sampler2D u_tone;   // shared tone response for contrast, highlights, shadows, whites, blacks
uniform float u_ev;
uniform float u_shoulder;   // linear level where the exposure highlight roll-off starts (1 = off)
uniform float u_temp, u_tint, u_vib, u_sat; // -1..0 for negative settings, 0..COLOR_GAIN for positive
uniform int u_mode; // 0 = full, 1 = original, 3/4 = clipping after all edits, 5/6 = clipping after levels
uniform vec3 u_lvMaster;                         // RGB levels: black, white, 1/gamma (0..1 units)
uniform vec3 u_lvBlack, u_lvWhite, u_lvInvGamma;  // per-channel levels
uniform vec3 u_clipMask;                          // which channels the levels clipping view shows
in vec2 v_uv;
out vec4 o;

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toDisplay(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// Same formula as levelsFn in src/levels.ts: RGB levels first, then each channel's own.
vec3 levels(vec3 c) {
  c = pow(clamp((c - u_lvMaster.x) / (u_lvMaster.y - u_lvMaster.x), 0.0, 1.0), vec3(u_lvMaster.z));
  return pow(clamp((c - u_lvBlack) / (u_lvWhite - u_lvBlack), 0.0, 1.0), u_lvInvGamma);
}

// Rolls bright areas off toward white instead of cutting them off flat. The brightest channel is
// compressed and the others follow in proportion, so colours keep their hue.
vec3 shoulder(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  if (u_shoulder >= 1.0 || m <= u_shoulder) return c;
  float room = 1.0 - u_shoulder;
  return c * ((u_shoulder + room * (1.0 - exp(-(m - u_shoulder) / room))) / m);
}

void main() {
  vec4 t = texture(u_img, v_uv);
  if (u_mode == 1) { o = vec4(t.rgb, 1.0); return; }
  vec3 lv = levels(t.rgb);
  // Levels clipping views: black with only clipped-to-white channels showing, or white with
  // clipped-to-black channels removed.
  if (u_mode == 5) { o = vec4(step(vec3(254.5 / 255.0), lv) * u_clipMask, 1.0); return; }
  if (u_mode == 6) { o = vec4(vec3(1.0) - step(lv, vec3(0.5 / 255.0)) * u_clipMask, 1.0); return; }
  // White balance in linear light: temp trades red against blue, tint trades green against
  // magenta. Gains are normalised so overall brightness stays about the same.
  vec3 wb = vec3(exp2(0.45 * u_temp + 0.2 * u_tint), exp2(-0.4 * u_tint), exp2(-0.45 * u_temp + 0.2 * u_tint));
  wb /= dot(wb, vec3(0.2126, 0.7152, 0.0722));
  vec3 c = toDisplay(shoulder(toLinear(lv) * wb * exp2(u_ev)));
  float y = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float y2 = texture(u_tone, vec2((y * 1023.0 + 0.5) / 1024.0, 0.5)).r;
  // Scale colour by the brightness change (keeps hue); near black, shift instead so blacks can lift.
  c = mix(c + (y2 - y), c * (y2 / max(y, 1e-3)), smoothstep(0.0, 0.1, y));
  c = clamp(c, 0.0, 1.0);
  // Saturation scales colour evenly; vibrance acts mostly on colours that are still muted.
  float grey = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  // Each factor stops at zero (fully grey) so strong negative settings cannot invert colours.
  c = mix(vec3(grey), c, max(0.0, 1.0 + u_sat) * max(0.0, 1.0 + u_vib * (1.0 - chroma)));
  c = clamp(c, 0.0, 1.0);
  // Clipping views: black with only the channels that have hit pure white showing,
  // or white with the channels that have hit pure black removed.
  if (u_mode == 3) c = step(vec3(254.5 / 255.0), c);
  if (u_mode == 4) c = vec3(1.0) - step(c, vec3(0.5 / 255.0));
  o = vec4(c, 1.0);
}`;

export type RenderMode = 'full' | 'original' | 'clipHigh' | 'clipLow' | 'levelsClipHigh' | 'levelsClipLow';
const MODES: Record<RenderMode, number> = { full: 0, original: 1, clipHigh: 3, clipLow: 4, levelsClipHigh: 5, levelsClipLow: 6 };

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private img: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private tone: WebGLTexture;
  private toneKey = '';
  imageWidth = 0;
  imageHeight = 0;
  /** True when the photo was larger than the GPU limit and had to be scaled down. */
  downscaled = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.prog = this.link(VERT, FRAG);
    for (const n of ['u_img', 'u_ev', 'u_tone', 'u_shoulder', 'u_temp', 'u_tint', 'u_vib', 'u_sat', 'u_mode', 'u_lvMaster', 'u_lvBlack', 'u_lvWhite', 'u_lvInvGamma', 'u_clipMask']) this.u[n] = gl.getUniformLocation(this.prog, n);
    this.img = this.texture(gl.LINEAR);
    this.tone = this.texture(gl.LINEAR);
    gl.bindVertexArray(gl.createVertexArray());
  }

  private link(vs: string, fs: string) {
    const gl = this.gl, p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    return p;
  }

  private texture(filter: number) {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  setImage(source: ImageBitmap | HTMLCanvasElement) {
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    let src: ImageBitmap | HTMLCanvasElement = source;
    const scale = Math.min(1, max / Math.max(source.width, source.height));
    this.downscaled = scale < 1;
    if (this.downscaled) {
      const c = document.createElement('canvas');
      c.width = Math.floor(source.width * scale); c.height = Math.floor(source.height * scale);
      c.getContext('2d')!.drawImage(source, 0, 0, c.width, c.height);
      src = c;
    }
    this.imageWidth = src.width; this.imageHeight = src.height;
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    // No UNPACK_FLIP_Y here: browsers ignore it for ImageBitmap, so the shader flips instead.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /** Sizes the canvas backing store to fit the image inside `maxDim` pixels. */
  setPreviewSize(maxDim: number) {
    const s = Math.min(1, maxDim / Math.max(this.imageWidth, this.imageHeight));
    this.canvas.width = Math.max(1, Math.round(this.imageWidth * s));
    this.canvas.height = Math.max(1, Math.round(this.imageHeight * s));
  }

  render(p: Params, mode: RenderMode = 'full', clipMask: [number, number, number] = [1, 1, 1]) {
    if (!this.imageWidth) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img); gl.uniform1i(this.u.u_img, 0);
    // The five tone sliders are baked into one table, rebuilt only when one of them changes.
    const toneKey = `${p.contrast},${p.highlights},${p.shadows},${p.whites},${p.blacks}`;
    gl.activeTexture(gl.TEXTURE1); // select the tone slot first, so the upload cannot land on another texture's slot
    if (toneKey !== this.toneKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.tone);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TONE_SIZE, 1, 0, gl.RED, gl.FLOAT, buildToneLut(p, TONE_SIZE));
      this.toneKey = toneKey;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tone); gl.uniform1i(this.u.u_tone, 1);
    gl.uniform1f(this.u.u_ev, p.exposure);
    gl.uniform1f(this.u.u_shoulder, shoulderStart(p.exposure));
    gl.uniform1f(this.u.u_temp, colorAmount(p.temp));
    gl.uniform1f(this.u.u_tint, colorAmount(p.tint));
    gl.uniform1f(this.u.u_vib, colorAmount(p.vibrance));
    gl.uniform1f(this.u.u_sat, colorAmount(p.saturation));
    const lv = p.levels;
    gl.uniform3f(this.u.u_lvMaster, lv.rgb.black / 255, lv.rgb.white / 255, 1 / lv.rgb.gamma);
    gl.uniform3f(this.u.u_lvBlack, lv.r.black / 255, lv.g.black / 255, lv.b.black / 255);
    gl.uniform3f(this.u.u_lvWhite, lv.r.white / 255, lv.g.white / 255, lv.b.white / 255);
    gl.uniform3f(this.u.u_lvInvGamma, 1 / lv.r.gamma, 1 / lv.g.gamma, 1 / lv.b.gamma);
    gl.uniform3f(this.u.u_clipMask, ...clipMask);
    gl.uniform1i(this.u.u_mode, MODES[mode]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Renders at the photo's full size and returns it as an image file. */
  async export(p: Params, type: 'image/png' | 'image/jpeg', quality = 0.92): Promise<Blob> {
    const { width, height } = this.canvas;
    this.canvas.width = this.imageWidth; this.canvas.height = this.imageHeight;
    this.render(p, 'full');
    const blob = await new Promise<Blob | null>((res) => this.canvas.toBlob(res, type, quality));
    this.canvas.width = width; this.canvas.height = height;
    this.render(p, 'full');
    if (!blob) throw new Error('The browser could not encode the image.');
    return blob;
  }
}
