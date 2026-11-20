import { isDefaultParams, type Params } from '../state';
import { buildToneLut } from '../tone';
import { pivotForPixels, PIVOT_DEFAULT } from '../contrast';
import { EXPOSURE_GLSL } from '../exposure';
import { COLOUR_STEP_GLSL } from '../colour-step';
import { LOCAL_TONE_GLSL, SURROUND_SIGMA, FLOOR_STOPS } from '../local-tone';

const TONE_SIZE = 1024;
/** Longer side, in pixels, of the small brightness map used for local Highlights and Shadows. */
const MASK_SIZE = 128;
/** Width of the nearby-colour blur used to rebuild clipped highlights, as a fraction of the longer side. */
const COLOUR_SIGMA = 0.05;
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

// Shared by the main shader and the brightness-map shader, so both see the photo the same way.
const COMMON = `
uniform float u_ev;
uniform float u_temp, u_tint;
uniform vec3 u_lvMaster;                         // RGB levels: black, white, 1/gamma (0..1 units)
uniform vec3 u_lvBlack, u_lvWhite, u_lvInvGamma;  // per-channel levels
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toDisplay(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// Same formula as levelsFn in src/levels.ts: RGB levels first, then each channel's own.
vec3 levels(vec3 c) {
  c = pow(clamp((c - u_lvMaster.x) / (u_lvMaster.y - u_lvMaster.x), 0.0, 1.0), vec3(u_lvMaster.z));
  return pow(clamp((c - u_lvBlack) / (u_lvWhite - u_lvBlack), 0.0, 1.0), u_lvInvGamma);
}

${EXPOSURE_GLSL}

// White balance in linear light: temp trades red against blue, tint trades green against
// magenta. Gains are normalised so overall brightness stays about the same. Exposure follows,
// as a curve that holds white (src/exposure.ts).
vec3 whiteBalance(vec3 lin) {
  vec3 wb = vec3(exp2(0.45 * u_temp + 0.2 * u_tint), exp2(-0.4 * u_tint), exp2(-0.45 * u_temp + 0.2 * u_tint));
  wb /= dot(wb, vec3(0.2126, 0.7152, 0.0722));
  return lin * wb;
}
vec3 balance(vec3 lin) { return expose(whiteBalance(lin), u_ev); }

// Brightness map values are log2 brightness in stops. Without float render targets they are
// stored in 8 bits over FLOOR..0 (about 1/20 stop steps, smooth after the blur).
#ifdef MASK_8BIT
float encMask(float L) { return clamp(L / ${FLOOR_STOPS.toFixed(1)}, 0.0, 1.0); }
float decMask(float v) { return v * ${FLOOR_STOPS.toFixed(1)}; }
#else
float encMask(float L) { return L; }
float decMask(float v) { return v; }
#endif

// How far a colour has lost its hue to clipping: 0 while at most one channel is at white, 1 once
// two are (the middle channel decides). Such pixels have no reliable colour of their own.
float clippedness(vec3 c) { float mid = max(min(c.r, c.g), min(max(c.r, c.g), c.b)); return smoothstep(0.7, 0.97, mid); }
`;

// Pass 1 of the brightness map: the photo, shrunk, after levels, white balance and exposure, as
// log2 brightness (red channel). The other three channels hold the photo's colour (chromaticity,
// weighted), counting only pixels that are reasonably bright and not clipped, so that clipped
// highlights can borrow the colour around them. u_img is a copy of the photo already shrunk.
const MASK_FRAG = (head: string) => `#version 300 es
${head}
precision highp float;
uniform sampler2D u_img;
${COMMON}
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 pre = whiteBalance(toLinear(levels(texture(u_img, v_uv).rgb)));
  vec3 lin = expose(pre, u_ev);
  float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  float sum = pre.r + pre.g + pre.b;
  float w = sum > 0.0 ? (1.0 - clippedness(pre)) * smoothstep(0.02, 0.2, max(pre.r, max(pre.g, pre.b))) : 0.0;
  vec2 xy = sum > 0.0 ? pre.rg / sum : vec2(0.0);
  o = vec4(encMask(log2(max(y, exp2(${FLOOR_STOPS.toFixed(1)})))), w * xy, w);
}`;

// Passes 2 and 3: Gaussian blurs, one direction at a time. Brightness (red) is blurred widely, so
// each pixel's value becomes the brightness of its surroundings; colour (green, blue, alpha) more
// narrowly, so it stays the colour of what is nearby.
const BLUR_FRAG = (head: string) => `#version 300 es
${head}
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_dir;
uniform float u_sigma, u_sigmaColour;
${COMMON}
out vec4 o;
void main() {
  ivec2 size = textureSize(u_src, 0), p = ivec2(gl_FragCoord.xy);
  int r = int(ceil(3.0 * max(u_sigma, u_sigmaColour)));
  float sum = 0.0, wsum = 0.0, csum = 0.0;
  vec3 col = vec3(0.0);
  for (int i = -r; i <= r; i++) {
    vec4 t = texelFetch(u_src, clamp(p + u_dir * i, ivec2(0), size - 1), 0);
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    float wc = exp(-float(i * i) / (2.0 * u_sigmaColour * u_sigmaColour));
    sum += w * decMask(t.r); wsum += w;
    col += wc * t.gba; csum += wc;
  }
  o = vec4(encMask(sum / wsum), col / csum);
}`;

// Processing order: levels -> white balance and exposure (in linear light, src/exposure.ts) ->
// local highlights and shadows (linear light, src/local-tone.ts) -> colour near white
// (src/colour-step.ts) -> one shared tone
// response for contrast, whites and blacks (on brightness, in display space, src/tone.ts) ->
// vibrance and saturation.
const FRAG = (head: string) => `#version 300 es
${head}
precision highp float;
uniform sampler2D u_img;
uniform sampler2D u_tone;   // shared tone response for contrast, whites, blacks
uniform sampler2D u_mask;   // brightness of each pixel's surroundings (log2 stops)
uniform float u_hl, u_sh;   // highlights and shadows, -100..100 (0 and 0 = local stage off)
uniform float u_vib, u_sat; // -1..0 for negative settings, 0..COLOR_GAIN for positive
uniform int u_mode; // 0 = full, 1 = original, 3/4 = clipping after all edits, 5/6 = clipping after levels
uniform vec3 u_clipMask;                          // which channels the levels clipping view shows
uniform float u_recon;      // 1 when darkening: rebuild the colour of clipped highlights from nearby
uniform float u_smooth;     // 1 once the photo has edits: smooth flat areas on the way in, dither on the way out
${COMMON}
${LOCAL_TONE_GLSL}
${COLOUR_STEP_GLSL}
in vec2 v_uv;
out vec4 o;

// A small, fixed pseudo-random number per position (0..1).
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// Debanding. A JPEG keeps 256 levels per channel and stores smooth areas such as skies in 8x8
// blocks that differ by a level or two. Strong edits stretch those steps into visible bands and
// blocks. Where every nearby sample is within DEBAND_LIMIT of this pixel (a flat area, not
// texture or an edge), the pixel is replaced by their average, which restores the in-between
// tones the file rounded away. Five rings (8 to 64 photo pixels; wide glows have steps tens of
// pixels apart), each turned by a per-pixel random angle so no pattern forms.
const float DEBAND_LIMIT = 3.0 / 255.0;
vec3 debanded(vec2 uv) {
  vec3 c = texture(u_img, uv).rgb;
  vec2 size = vec2(textureSize(u_img, 0));
  float a = hash12(uv * size) * 6.2831853;
  const float RINGS[5] = float[](8.0, 16.0, 32.0, 48.0, 64.0);
  for (int i = 0; i < 5; i++) {
    a += 2.39996; // golden angle: each ring points a different way
    vec2 d = vec2(cos(a), sin(a)) * RINGS[i] / size, e = vec2(-d.y * size.y, d.x * size.x) / size; // d turned 90 degrees in photo pixels
    vec3 s1 = texture(u_img, uv + d).rgb, s2 = texture(u_img, uv - d).rgb, s3 = texture(u_img, uv + e).rgb, s4 = texture(u_img, uv - e).rgb;
    vec3 far = max(max(abs(s1 - c), abs(s2 - c)), max(abs(s3 - c), abs(s4 - c)));
    if (max(far.r, max(far.g, far.b)) < DEBAND_LIMIT) c = (s1 + s2 + s3 + s4) * 0.25;
  }
  return c;
}


void main() {
  vec4 t = texture(u_img, v_uv);
  if (u_mode == 1) { o = vec4(t.rgb, 1.0); return; }
  vec3 lv = levels(u_smooth > 0.0 ? debanded(v_uv) : t.rgb);
  // Levels clipping views: black with only clipped-to-white channels showing, or white with
  // clipped-to-black channels removed.
  if (u_mode == 5) { o = vec4(step(vec3(254.5 / 255.0), lv) * u_clipMask, 1.0); return; }
  if (u_mode == 6) { o = vec4(vec3(1.0) - step(lv, vec3(0.5 / 255.0)) * u_clipMask, 1.0); return; }
  vec3 base = whiteBalance(toLinear(lv));
  vec3 lin = expose(base, u_ev);
  // Local highlights and shadows: each pixel moves by an amount that depends on its own brightness
  // and on its surroundings' (see src/local-tone.ts). All channels move together, keeping hue.
  if (u_hl != 0.0 || u_sh != 0.0) {
    float B = decMask(texture(u_mask, vec2(v_uv.x, 1.0 - v_uv.y)).r); // map row 0 is the photo's bottom
    float L = log2(max(dot(lin, vec3(0.2126, 0.7152, 0.0722)), exp2(${FLOOR_STOPS.toFixed(1)})));
    lin *= exp2(localToneDelta(L, B, u_hl, u_sh));
  }
  // Bright colours soften toward white when brightened and regain colour when darkened
  // (src/colour-step.ts). Only the brightness steps above count; levels and white balance do not.
  vec3 col = colourAfter(base, lin);
  // Clipped highlights. Where two or more channels hit white in the photo (a blown sun, its yellow
  // ring), the file has lost the real colour; darkening such pixels as they are turns them grey or
  // olive. As they are darkened, they take on the colour of the unclipped area around them instead,
  // at their own brightness, fading in over the first 1.5 stops of darkening.
  if (u_recon > 0.0) {
    float m0 = max(base.r, max(base.g, base.b)), m1 = max(col.r, max(col.g, col.b));
    float amount = clippedness(base) * clamp(-log2(max(m1, 1e-6) / max(m0, 1e-6)) / 1.5, 0.0, 1.0);
    if (amount > 0.0) {
      vec4 near = texture(u_mask, vec2(v_uv.x, 1.0 - v_uv.y));
      if (near.a > 1e-4) {
        vec3 hue = max(vec3(near.g, near.b, near.a - near.g - near.b) / near.a, vec3(0.0));
        // Same brightness as the pixel has now, in the nearby hue. Where that hue cannot be this
        // bright without passing white, it is paled toward white just enough to fit, so a blown
        // sun stays the brightest thing around it instead of turning into a dark disc.
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        float y = dot(col, LUMA);
        vec3 target = hue * (y / max(dot(hue, LUMA), 1e-6));
        float top = max(target.r, max(target.g, target.b));
        if (top > 1.0) target = mix(vec3(y), target, (1.0 - y) / max(top - y, 1e-6));
        col = mix(col, target, amount * clamp(near.a / 0.05, 0.0, 1.0));
      }
    }
  }
  vec3 c = toDisplay(col);
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
  // Dithering: about one level of fine noise before the result is rounded to 8 bits, so smooth
  // gradients do not turn back into steps. Not in the clipping views, which must stay exact.
  if (u_smooth > 0.0 && u_mode == 0) c = clamp(c + (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.3) - 1.0) / 255.0, 0.0, 1.0);
  if (u_mode == 3) c = step(vec3(254.5 / 255.0), c);
  if (u_mode == 4) c = vec3(1.0) - step(c, vec3(0.5 / 255.0));
  o = vec4(c, 1.0);
}`;

export type RenderMode = 'full' | 'original' | 'clipHigh' | 'clipLow' | 'levelsClipHigh' | 'levelsClipLow';
const MODES: Record<RenderMode, number> = { full: 0, original: 1, clipHigh: 3, clipLow: 4, levelsClipHigh: 5, levelsClipLow: 6 };

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private maskProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private img: WebGLTexture;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private um: Record<string, WebGLUniformLocation | null> = {};
  private ub: Record<string, WebGLUniformLocation | null> = {};
  private tone: WebGLTexture;
  private toneKey = '';
  /** Contrast pivot for the current photo (its own mid-tone), measured once when it loads. */
  private pivot = PIVOT_DEFAULT;
  /** The photo shrunk to the brightness map's size, and the map itself (two buffers for the blur). */
  private small: WebGLTexture;
  private mask: [WebGLTexture, WebGLTexture];
  private fbo: [WebGLFramebuffer, WebGLFramebuffer];
  private maskFormat: [number, number, number];
  private maskW = 1;
  private maskH = 1;
  private maskKey = '';
  private imageSerial = 0;
  imageWidth = 0;
  imageHeight = 0;
  /** True when the photo was larger than the GPU limit and had to be scaled down. */
  downscaled = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    // The brightness map is kept in floating point where the GPU can render to it, else in 8 bits.
    const float = !!gl.getExtension('EXT_color_buffer_float');
    const head = float ? '' : '#define MASK_8BIT';
    this.maskFormat = float ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    this.prog = this.link(VERT, FRAG(head));
    this.maskProg = this.link(VERT, MASK_FRAG(head));
    this.blurProg = this.link(VERT, BLUR_FRAG(head));
    const shared = ['u_ev', 'u_temp', 'u_tint', 'u_lvMaster', 'u_lvBlack', 'u_lvWhite', 'u_lvInvGamma'];
    for (const n of [...shared, 'u_img', 'u_tone', 'u_mask', 'u_hl', 'u_sh', 'u_vib', 'u_sat', 'u_mode', 'u_clipMask', 'u_smooth', 'u_recon']) this.u[n] = gl.getUniformLocation(this.prog, n);
    for (const n of [...shared, 'u_img']) this.um[n] = gl.getUniformLocation(this.maskProg, n);
    for (const n of ['u_src', 'u_dir', 'u_sigma', 'u_sigmaColour']) this.ub[n] = gl.getUniformLocation(this.blurProg, n);
    this.img = this.texture(gl.LINEAR);
    this.tone = this.texture(gl.LINEAR);
    this.small = this.texture(gl.LINEAR);
    this.mask = [this.texture(gl.LINEAR), this.texture(gl.LINEAR)];
    this.fbo = [gl.createFramebuffer()!, gl.createFramebuffer()!];
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    // No UNPACK_FLIP_Y here: browsers ignore it for ImageBitmap, so the shader flips instead.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

    // A small copy of the photo for the brightness map, shrunk by the browser (which averages).
    const k = MASK_SIZE / Math.max(src.width, src.height);
    this.maskW = Math.max(1, Math.round(src.width * k)); this.maskH = Math.max(1, Math.round(src.height * k));
    const c = document.createElement('canvas');
    c.width = this.maskW; c.height = this.maskH;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    this.pivot = pivotForPixels(ctx.getImageData(0, 0, c.width, c.height).data);
    gl.bindTexture(gl.TEXTURE_2D, this.small);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    const [internal, format, type] = this.maskFormat;
    for (const t of this.mask) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.maskW, this.maskH, 0, format, type, null);
    }
    this.imageSerial++;
    this.maskKey = '';
  }

  /** Levels, white balance and exposure uniforms, shared by the main and brightness-map shaders. */
  private setCommon(u: Record<string, WebGLUniformLocation | null>, p: Params) {
    const gl = this.gl, lv = p.levels;
    gl.uniform1f(u.u_ev, p.exposure);
    gl.uniform1f(u.u_temp, colorAmount(p.temp));
    gl.uniform1f(u.u_tint, colorAmount(p.tint));
    gl.uniform3f(u.u_lvMaster, lv.rgb.black / 255, lv.rgb.white / 255, 1 / lv.rgb.gamma);
    gl.uniform3f(u.u_lvBlack, lv.r.black / 255, lv.g.black / 255, lv.b.black / 255);
    gl.uniform3f(u.u_lvWhite, lv.r.white / 255, lv.g.white / 255, lv.b.white / 255);
    gl.uniform3f(u.u_lvInvGamma, 1 / lv.r.gamma, 1 / lv.g.gamma, 1 / lv.b.gamma);
  }

  /**
   * Rebuilds the brightness map of each pixel's surroundings when the photo or anything before the
   * local stage (levels, white balance, exposure) has changed. The result is left in mask[0].
   */
  private updateMask(p: Params) {
    const key = `${this.imageSerial}|${p.exposure}|${p.temp}|${p.tint}|${JSON.stringify(p.levels)}`;
    if (key === this.maskKey) return;
    this.maskKey = key;
    const gl = this.gl;
    gl.viewport(0, 0, this.maskW, this.maskH);
    // Pass 1: shrunk photo -> log2 brightness, into mask[1].
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mask[1], 0);
    gl.useProgram(this.maskProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.small); gl.uniform1i(this.um.u_img, 0);
    this.setCommon(this.um, p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Passes 2 and 3: blur across (mask[1] -> mask[0]), then down (mask[0] -> mask[1]); swapping
    // the pair afterwards leaves the finished map in mask[0].
    gl.useProgram(this.blurProg);
    gl.uniform1f(this.ub.u_sigma, SURROUND_SIGMA * MASK_SIZE);
    gl.uniform1f(this.ub.u_sigmaColour, COLOUR_SIGMA * MASK_SIZE);
    gl.uniform1i(this.ub.u_src, 0);
    const pass = (from: number, to: number, dir: [number, number]) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[to]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mask[to], 0);
      gl.bindTexture(gl.TEXTURE_2D, this.mask[from]);
      gl.uniform2i(this.ub.u_dir, ...dir);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(1, 0, [1, 0]);
    pass(0, 1, [0, 1]);
    this.mask.reverse(); this.fbo.reverse();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    const local = mode !== 'original' && (p.highlights !== 0 || p.shadows !== 0);
    // Darkening can rebuild clipped highlights from the colour map, which lives in the same textures.
    const recon = mode !== 'original' && (p.exposure < 0 || p.highlights < 0 || p.shadows < 0);
    if (local || recon) this.updateMask(p);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.img); gl.uniform1i(this.u.u_img, 0);
    // Contrast, whites and blacks are baked into one table, rebuilt only when one of them (or the photo) changes.
    const toneKey = `${p.contrast},${p.whites},${p.blacks},${this.pivot}`;
    gl.activeTexture(gl.TEXTURE1); // select the tone slot first, so the upload cannot land on another texture's slot
    if (toneKey !== this.toneKey) {
      gl.bindTexture(gl.TEXTURE_2D, this.tone);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TONE_SIZE, 1, 0, gl.RED, gl.FLOAT, buildToneLut({ contrast: p.contrast, whites: p.whites, blacks: p.blacks, pivot: this.pivot }, TONE_SIZE));
      this.toneKey = toneKey;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tone); gl.uniform1i(this.u.u_tone, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.mask[0]); gl.uniform1i(this.u.u_mask, 2);
    gl.uniform1f(this.u.u_hl, local ? p.highlights : 0);
    gl.uniform1f(this.u.u_sh, local ? p.shadows : 0);
    this.setCommon(this.u, p);
    gl.uniform1f(this.u.u_vib, colorAmount(p.vibrance));
    gl.uniform1f(this.u.u_sat, colorAmount(p.saturation));
    gl.uniform3f(this.u.u_clipMask, ...clipMask);
    gl.uniform1i(this.u.u_mode, MODES[mode]);
    // An unedited photo is shown and exported exactly as it is.
    gl.uniform1f(this.u.u_smooth, isDefaultParams(p) ? 0 : 1);
    gl.uniform1f(this.u.u_recon, recon ? 1 : 0);
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
