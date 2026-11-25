/* Bek. Faye v3 copy: adds viewer.pre / viewer.post hooks in render() and onLost/onRestored. Otherwise verbatim. */
/* WebGL2 viewer.
   Two passes: (1) decode the source (SDR or Apple Log) and look it up in the
   3D LUT, into an offscreen texture; (2) composite the optical texture
   (soft focus, halation, grain, vignette) and the before/after split. */

import { cameraMatrix, isLogSpace } from './color.js';

const VERT = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 vUv;
void main() {
  vec2 p = P[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}
float alogDecode(float p) {
  const float R0 = -0.05641088;
  const float RT = 0.01;
  const float SG = 47.28711236;
  const float BE = 0.00964052;
  const float GA = 0.08550479;
  const float DE = 0.69336945;
  float pivot = SG * (RT - R0) * (RT - R0);
  if (p >= pivot) return exp2((p - DE) / GA) - BE;
  return p >= 0.0 ? sqrt(p / SG) + R0 : R0;
}
`;

const GRADE_FRAG = `${COMMON}
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform mat3 uCam;
uniform int uLog;
uniform bool uHasLut;
uniform vec3 uGain;
uniform float uZoom;
uniform vec4 uCrop;
uniform bool uBypass;
out vec4 fragColor;

vec3 decodeSource(vec3 c) {
  if (uLog == 0) return c;
  vec3 lin = vec3(alogDecode(c.r), alogDecode(c.g), alogDecode(c.b));
  lin = uCam * lin;
  float mn = min(lin.r, min(lin.g, lin.b));
  if (mn < 0.0) {
    float y = luma(lin);
    float t = clamp(y / max(1e-6, y - mn), 0.0, 1.0);
    lin = max(vec3(0.0), y + (lin - y) * t);
  }
  float y = luma(lin);
  if (y > 0.72) {
    float span = 0.28;
    lin *= (0.72 + span * (1.0 - exp(-(y - 0.72) / span))) / max(y, 1e-6);
  }
  return toSrgb(clamp(lin, 0.0, 1.0));
}

void main() {
  // Digital zoom and exposure/white balance gain sit before the LUT, exactly
  // where a camera would expose through the look rather than after it.
  vec2 suv = (vUv - 0.5) / max(uZoom, 0.01) + 0.5;
  // uCrop is the sensor window the format asked for: a 2.39 frame really is
  // a centre crop of the sensor, not the full frame squashed to shape.
  suv = uCrop.xy + suv * (uCrop.zw - uCrop.xy);
  vec4 s = texture(uSrc, suv);
  vec3 d = decodeSource(s.rgb) * uGain;
  vec3 g = (uHasLut && !uBypass) ? texture(uLut, clamp(d, 0.0, 1.0)).rgb : clamp(d, 0.0, 1.0);
  fragColor = vec4(g, 1.0);
}`;

/* The lights of the graded frame, for bloom and halation: what is above
   0.6, with clipped light counted ~8× brighter (film sees a lamp as far
   brighter than a white wall). Stored at 1/8 so it fits 8 bits. */
const HIGH_FRAG = `${COMMON}
uniform sampler2D uGraded;
out vec4 fragColor;
void main() {
  vec3 c = textureLod(uGraded, vUv, 0.0).rgb;
  float hot = 1.0 + 7.0 * smoothstep(0.9, 1.0, luma(c));
  fragColor = vec4(max(c - 0.6, 0.0) / 0.4 * hot / 8.0, 1.0);
}`;

const COMPOSITE_FRAG = `${COMMON}
uniform sampler2D uGraded;
uniform sampler2D uSrc;
uniform sampler2D uHigh;
uniform mat3 uCam;
uniform int uLog;
uniform vec2 uRes;
uniform float uSplit;
uniform bool uCompare;
uniform float uBlur;
uniform float uDof;
uniform float uFocusX;
uniform float uFocusY;
uniform float uFocusR;
uniform float uFocusSoft;
uniform float uGlow;
uniform float uGrain;
uniform float uVignette;
uniform float uPixel;
uniform float uLevels;
uniform vec3 uPal[4];
uniform int uPalCount;
uniform float uPalMix;
uniform float uSeed;
uniform vec3 uGain;
uniform float uZoom;
uniform vec4 uCrop;
uniform int uMonitor;
uniform float uZebra;
uniform float uPeak;
uniform int uQuality;
uniform int uDofMode;
uniform float uFocusAspect;
uniform vec2 uSoft;
uniform float uBleed;
uniform float uShift;
uniform float uFringe;
uniform float uScan;
uniform float uScanPeriod;
uniform float uBlock;
uniform float uGrainAmt;
uniform float uGrainChroma;
uniform float uGrainCell;
uniform float uLetterbox;
uniform float uSharpen;
uniform float uBloom;
uniform float uHalation;
uniform vec3 uHalTint;
uniform float uDiffuse;
out vec4 fragColor;

const vec2 DIRS[12] = vec2[12](
  vec2(1.0, 0.0), vec2(0.5, 0.866), vec2(-0.5, 0.866), vec2(-1.0, 0.0),
  vec2(-0.5, -0.866), vec2(0.5, -0.866),
  vec2(0.707, 0.707), vec2(-0.707, 0.707), vec2(-0.707, -0.707), vec2(0.707, -0.707),
  vec2(0.26, 0.966), vec2(0.966, 0.26)
);

vec3 decodeSource(vec3 c) {
  if (uLog == 0) return c;
  vec3 lin = vec3(alogDecode(c.r), alogDecode(c.g), alogDecode(c.b));
  lin = uCam * lin;
  float mn = min(lin.r, min(lin.g, lin.b));
  if (mn < 0.0) {
    float y = luma(lin);
    float t = clamp(y / max(1e-6, y - mn), 0.0, 1.0);
    lin = max(vec3(0.0), y + (lin - y) * t);
  }
  return toSrgb(clamp(lin, 0.0, 1.0));
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.017);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/* Blur taps scale with the quality tier: 6 on Medium, 12 on High, and a
   second inner ring (24) on Max, which smooths out the ringing a single ring
   leaves on strong background blur. */
vec3 sampleSoft(vec2 uv, float radius) {
  vec3 sum = vec3(0.0);
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 k = radius * vec2(1.0 / aspect, 1.0);
  int n = uQuality == 0 ? 6 : 12;
  float count = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    sum += textureLod(uGraded, clamp(uv + DIRS[i] * k, vec2(0.001), vec2(0.999)), 0.0).rgb;
    count += 1.0;
  }
  if (uQuality >= 2) {
    for (int i = 0; i < 12; i++) {
      sum += textureLod(uGraded, clamp(uv + DIRS[i].yx * k * 0.5, vec2(0.001), vec2(0.999)), 0.0).rgb;
      count += 1.0;
    }
  }
  return sum / count;
}

/* Resolution: an elliptical gaussian (sigma per axis, as a fraction of the
   frame height) from a centre tap and two rings. */
/* Wide blurs read a pre-shrunk copy (mip level ~ log2 sigma, made in
   Viewer.mips), so taps far apart blend instead of showing as ghost copies. */
float lodFor(float sigmaPx) {
  return max(0.0, log2(max(sigmaPx, 1.0)) - 1.0);
}

vec3 sampleRes(vec2 uv, vec2 sigma) {
  vec2 s = sigma * vec2(uRes.y / max(uRes.x, 1.0), 1.0);
  float lod = lodFor(max(sigma.x, sigma.y) * uRes.y);
  vec3 sum = textureLod(uGraded, uv, lod).rgb;
  float wsum = 1.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a));
    sum += 0.607 * textureLod(uGraded, clamp(uv + d * s * 1.1, vec2(0.001), vec2(0.999)), lod).rgb;
    vec2 e = vec2(cos(a + 0.392699), sin(a + 0.392699));
    sum += 0.27 * textureLod(uGraded, clamp(uv + e * s * 2.2, vec2(0.001), vec2(0.999)), lod).rgb;
    wsum += 0.877;
  }
  return sum / wsum;
}

/* Tape and early video carry far less colour than detail: chroma smears
   sideways while luma stays put. */
vec3 bleedChroma(vec2 uv, vec3 color) {
  float sx = uBleed * uRes.y / max(uRes.x, 1.0);
  float lod = lodFor(uBleed * uRes.y * 0.6);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float t = float(i) * 0.6;
    float w = exp(-0.5 * t * t);
    acc += w * textureLod(uGraded, clamp(uv + vec2(t * sx, 0.0), vec2(0.001), vec2(0.999)), lod).rgb;
    wsum += w;
  }
  vec3 smear = acc / wsum;
  return smear + (luma(color) - luma(smear));
}

/* Light spilling out of the picture's brightest parts, read from the
   pre-shrunk copies (Viewer.mips) so it is smooth and costs a few taps.
   Levels are counted from a 540-line frame, so the spread is the same share
   of the picture at 720p and at 4K. */
vec3 spill(vec2 uv, float first, float last) {
  float base = log2(max(uRes.y, 1.0) / 540.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float l = mix(first, last, float(i) / 3.0);
    acc += textureLod(uHigh, uv, max(0.0, l + base)).rgb * 8.0;
  }
  return acc * 0.25;
}

/* Value noise: one random value per cell, smoothly joined. */
float cellNoise(vec2 p, float salt) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i + salt);
  float b = hash(i + vec2(1.0, 0.0) + salt);
  float c = hash(i + vec2(0.0, 1.0) + salt);
  float d = hash(i + vec2(1.0, 1.0) + salt);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5;
}

/* Few-colour frames: map every pixel onto the filter's own palette. A photo
   with two colours therefore outputs two colours, not a posterized approximation. */
vec3 mapPalette(vec3 c) {
  if (uPalCount < 2 || uPalMix <= 0.001) return c;
  float best = 1e9;
  vec3 pick = uPal[0];
  for (int i = 0; i < 4; i++) {
    if (i >= uPalCount) break;
    vec3 d = c - uPal[i];
    float dist = dot(d * d, vec3(0.45, 0.9, 0.35));
    if (dist < best) {
      best = dist;
      pick = uPal[i];
    }
  }
  return mix(c, pick, uPalMix);
}

/* Monitoring overlays live in the composite pass only, and the app forces them
   off while recording so the file stays clean. */
vec3 monitorColor(vec3 c, vec2 uv) {
  float y = luma(c);
  if (uMonitor == 1) {
    if (y > 0.97) return vec3(1.0, 0.16, 0.12);       // clipped
    if (y > 0.80) return vec3(0.98, 0.56, 0.82);      // bright highlight
    if (y > 0.55) return vec3(0.36, 0.85, 0.38);      // skin / mid
    if (y > 0.30) return vec3(0.26, 0.55, 0.95);      // lower mid
    if (y > 0.08) return vec3(0.55, 0.26, 0.86);      // shadow
    return vec3(0.12, 0.10, 0.34);                    // near black
  }
  if (uMonitor == 2) {
    if (y < uZebra) return c;
    float stripe = step(0.5, fract((uv.x * uRes.x + uv.y * uRes.y) * 0.09));
    return mix(c, vec3(1.0, 0.22, 0.18), 0.55 * stripe);
  }
  if (uMonitor == 3) {
    vec2 px = 1.0 / uRes;
    float l0 = luma(textureLod(uGraded, uv, 0.0).rgb);
    float lx = luma(textureLod(uGraded, uv + vec2(px.x, 0.0), 0.0).rgb) + luma(textureLod(uGraded, uv - vec2(px.x, 0.0), 0.0).rgb);
    float ly = luma(textureLod(uGraded, uv + vec2(0.0, px.y), 0.0).rgb) + luma(textureLod(uGraded, uv - vec2(0.0, px.y), 0.0).rgb);
    float edge = abs(l0 * 2.0 - lx) + abs(l0 * 2.0 - ly);
    if (edge > uPeak) return mix(c, vec3(0.32, 1.0, 0.46), 0.85);
    return c;
  }
  return c;
}

void main() {
  vec2 uv = vUv;
  bool before = uCompare && uv.x < uSplit;
  if (before) {
    vec2 suv = (uv - 0.5) / max(uZoom, 0.01) + 0.5;
    suv = uCrop.xy + suv * (uCrop.zw - uCrop.xy);
    fragColor = vec4(clamp(decodeSource(texture(uSrc, suv).rgb) * uGain, 0.0, 1.0), 1.0);
    return;
  }

  // Letterbox: the reference's wide frame, on landscape output only.
  float frameAspect = uRes.x / max(uRes.y, 1.0);
  if (uLetterbox > 0.0 && frameAspect >= 1.0 && frameAspect < uLetterbox - 0.01) {
    float bar = 0.5 * (1.0 - frameAspect / uLetterbox);
    if (uv.y < bar || uv.y > 1.0 - bar) {
      fragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
  }

  // Pixel blocks: one sample per cell, cells sized against the frame height.
  if (uBlock > 0.0005) {
    vec2 cell = vec2(uBlock * uRes.y / max(uRes.x, 1.0), uBlock);
    uv = (floor(uv / cell) + 0.5) * cell;
  }

  vec3 base = textureLod(uGraded, uv, 0.0).rgb;
  vec3 color = base;

  if (uSoft.x + uSoft.y > 0.0002) color = sampleRes(uv, uSoft);
  else if (uSharpen > 0.01) {
    // unsharp mask at about a pixel: the crisp, edited end of the range
    vec3 soft = sampleRes(uv, vec2(1.1 / max(uRes.y, 1.0)));
    color = clamp(color + (color - soft) * uSharpen * 1.4, 0.0, 1.0);
  }
  if (uBleed > 0.0005) color = bleedChroma(uv, color);
  if (abs(uShift) + uFringe > 0.0002) {
    // red and blue land apart: a sideways tape shift plus lens fringing that grows to the edges
    vec2 d = vec2(uShift, 0.0) + 2.0 * uFringe * (uv - 0.5);
    // on a softened frame, shift the softened channels (sharp ones would put
    // crisp red/blue ghosts back onto a soft picture)
    float lod = lodFor(max(uSoft.x, uSoft.y) * uRes.y * 2.0);
    vec3 at = textureLod(uGraded, uv, lod).rgb;
    color.r += textureLod(uGraded, clamp(uv - d * 0.5, vec2(0.0), vec2(1.0)), lod).r - at.r;
    color.b += textureLod(uGraded, clamp(uv + d * 0.5, vec2(0.0), vec2(1.0)), lod).b - at.b;
  }

  if (uBlur > 0.005) {
    vec3 soft = sampleSoft(uv, 0.004 + uBlur * 0.032);
    color = mix(color, soft, uBlur * 0.82);
  }

  /* Depth of field, not a global softening: a sharp band sits on the focus
     plane and blur grows away from it, so near and far parts of the same frame
     resolve differently — a subject on the plane stays crisp while distance
     either side of it goes soft. Only genuine fine structure gets a little
     protection, so an edge does not melt completely. */
  if (uDof > 0.005) {
    /* A subject, not a band: the sharp area is an upright oval (people are
       taller than wide) on the point the app tracks or you tapped.
       Depth blur: softening ramps in gradually and keeps growing with
       distance, the way a background falls away behind a subject.
       Plain blur: a short soft edge, then one even blur everywhere else. */
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 delta = vec2((uv.x - uFocusX) * aspect, (uv.y - uFocusY) / max(uFocusAspect, 0.5));
    float dist = length(delta);
    float inner = uFocusR;
    if (uDofMode == 1) {
      float amt = uDof * smoothstep(inner, inner + 0.03 + uFocusSoft * 0.05, dist);
      if (amt > 0.004) color = mix(color, sampleSoft(uv, 0.010 + uFocusSoft * 0.014), amt);
    } else {
      float outer = inner + 0.08 + uFocusSoft * 0.40;
      float ramp = smoothstep(inner, outer, dist);
      float far = clamp((dist - inner) / 0.9, 0.0, 1.0);
      float amt = uDof * ramp;
      if (amt > 0.004) color = mix(color, sampleSoft(uv, 0.004 + amt * (0.016 + far * 0.016)), amt);
    }
  }

  // Diffusion (a Pro-Mist / dreamy veil): a wide soft copy laid over the
  // picture, more over the brights, so detail stays but contrast melts.
  if (uDiffuse > 0.005) {
    float base = log2(max(uRes.y, 1.0) / 540.0);
    vec3 veil = 0.5 * textureLod(uGraded, uv, max(0.0, 2.5 + base)).rgb + 0.5 * textureLod(uGraded, uv, max(0.0, 4.0 + base)).rgb;
    color = mix(color, veil, uDiffuse * 0.35);
    color = 1.0 - (1.0 - color) * (1.0 - veil * veil * uDiffuse * 0.65);
  }
  // Bloom: white light spreading wide from the highlights.
  if (uBloom > 0.005) {
    vec3 b = spill(uv, 2.0, 5.5);
    color = 1.0 - (1.0 - color) * (1.0 - clamp(b * uBloom * 0.8, 0.0, 1.0));
  }
  // Halation: film's red-orange fringe close around bright light, from light
  // bouncing off the film base back through the red layer.
  if (uHalation > 0.005) {
    // only outside the light: where the spill is brighter than the pixel itself
    float h = max(luma(spill(uv, 1.0, 3.5)) * 0.35 - 0.55 * luma(color), 0.0);
    color += uHalTint * h * uHalation * 1.5;
  }

  if (uGlow > 0.005) {
    vec3 halo = sampleSoft(uv, 0.02 + uGlow * 0.06);
    float bright = max(0.0, luma(halo) - 0.42);
    color += halo * bright * uGlow * 0.9 * vec3(1.06, 0.98, 0.82);
    color = 1.0 - (1.0 - color) * (1.0 - clamp(halo * bright * uGlow * 0.55, 0.0, 1.0));
  }

  if (uVignette > 0.005) {
    vec2 p = uv * 2.0 - 1.0;
    float r2 = dot(p, p);
    float mask = 1.0 - uVignette * 0.55 * smoothstep(0.35, 1.7, r2);
    color *= mask;
  }

  color = mapPalette(color);

  if (uPixel > 0.005) {
    // Blocky frames: snap to a coarse grid, the block size scaled to 1080 lines.
    float aspect = uRes.x / max(uRes.y, 1.0);
    float cell = 1.0 + uPixel * 9.0;
    vec2 blk = floor(vec2(uv.x * aspect, uv.y) * 1080.0 / cell) * cell / (1080.0);
    vec2 buv = vec2(blk.x / aspect, blk.y);
    color = mix(color, sampleSoft(buv, 0.0), uPixel * 0.85);
  }

  if (uLevels > 0.005) {
    // Few-colour frames: posterize each channel toward a small set of levels.
    float n = mix(18.0, 4.0, uLevels);
    vec3 post = floor(color * n + 0.5) / n;
    color = mix(color, post, uLevels);
  }

  if (uGrain > 0.005) {
    // Two octaves, sized against a 1080-line reference rather than the raw
    // pixel grid, so a 1080p preview and a 4K recording carry the same grain.
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 gp = vec2(uv.x * aspect, uv.y) * 1080.0;
    float fine = hash(gp + uSeed * 37.0) - 0.5;
    float coarse = hash(gp * 0.55 + uSeed * 11.0) - 0.5;
    float mid = 0.35 + 0.65 * sin(clamp(luma(color), 0.0, 1.0) * 3.14159);
    color += (fine * 0.66 + coarse * 0.34) * uGrain * 0.3 * mid;
  }

  if (uScan > 0.002) {
    float period = max(2.0, uScanPeriod * uRes.y);
    // whole rows (not pixel centres): a 2-row raster otherwise lands on the
    // wave's zero crossings and vanishes
    color *= 1.0 - uScan * (0.5 - 0.5 * cos(6.28318 * floor(gl_FragCoord.y) / period));
  }

  if (uGrainAmt + uGrainChroma > 0.0005) {
    // Measured noise: its strength (std), how coloured it is, and its size.
    float cell = max(1.0, uGrainCell * uRes.y);
    vec2 gp = gl_FragCoord.xy / cell + uSeed * 17.0;
    float k = cell > 1.4 ? 1.7 : 1.0;
    float y = hash(gp) - 0.5;
    vec3 c = vec3(hash(gp + 41.3), hash(gp + 77.9), hash(gp + 13.1)) - 0.5;
    if (cell > 1.4) {
      y = cellNoise(gp, 0.0);
      c = vec3(cellNoise(gp, 41.3), cellNoise(gp, 77.9), cellNoise(gp, 13.1));
    }
    float tone = 0.6 + 0.4 * sin(clamp(luma(color), 0.0, 1.0) * 3.14159);
    color += (vec3(y) * uGrainAmt + c * uGrainChroma) / 0.2887 * k * tone;
  }

  // Triangular dither keeps smooth skies from banding once the frame is baked
  // into an 8-bit recording or JPEG.
  color += (hash(gl_FragCoord.xy + uSeed * 5.0) - 0.5) / 255.0;

  color = monitorColor(clamp(color, 0.0, 1.0), uv);

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function program(gl, frag) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, VERT);
  const f = compile(gl, gl.FRAGMENT_SHADER, frag);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

const palFlat = (pal) => {
  const flat = (Array.isArray(pal) ? pal : []).slice(0, 4).flat();
  return flat.length >= 3 ? flat : [0, 0, 0];
};

function flatColumnMajor(m) {
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.ok = !!this.gl;
    this.pre = null; // (gl, srcTex, w, h) => texture|null
    this.post = null; // (gl, tex, w, h, time) => void
    this.onLost = null;
    this.onRestored = null;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; if (this.onLost) this.onLost(); });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; if (this.onRestored) this.onRestored(); });
    this.options = {
      log: 'sdr',
      split: 0.5,
      compare: false,
      blur: 0,
      glow: 0,
      grain: 0,
      vignette: 0,
      palette: [[0, 0, 0], [1, 1, 1], [0, 0, 0], [0, 0, 0]],
      paletteMix: 0,
      seed: 1,
      gain: [1, 1, 1],
      zoom: 1,
      crop: [0, 0, 1, 1],
      bypass: false,
      monitor: 0,
      zebra: 0.88,
      peak: 0.22,
    };
    this.targets = new Map();
    this.lutTex = null;
    this.lutSize = 0;
    this.empty = null;
    if (!this.ok) return;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      this.gradeProgram = program(gl, GRADE_FRAG);
      this.compositeProgram = program(gl, COMPOSITE_FRAG);
      this.highProgram = program(gl, HIGH_FRAG);
    } catch (err) {
      console.error(err);
      this.ok = false;
      return;
    }
    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 10, 10, 255]));
    this.empty = gl.createVertexArray();
    this.dummyLut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.dummyLut);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 1, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.srcW = 1;
    this.srcH = 1;
  }

  setSource(source) {
    if (!this.ok) return;
    const gl = this.gl;
    const w = source.videoWidth || source.naturalWidth || source.width || 1;
    const h = source.videoHeight || source.naturalHeight || source.height || 1;
    this.srcW = w;
    this.srcH = h;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (err) {
      /* a video frame may not be ready yet; the next frame will upload */
    }
  }

  setLut(values, size) {
    if (!this.ok) return;
    const gl = this.gl;
    const data = new Uint8Array(size * size * size * 3);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 255);
    }
    if (!this.lutTex) {
      this.lutTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.lutSize = size;
  }

  clearLut() {
    if (!this.ok) return;
    this.lutTex = null;
    this.lutSize = 0;
  }

  setOptions(options) {
    if (!this.options) return;
    Object.assign(this.options, options);
  }

  ensureSize(w, h) {
    if (!this.ok) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  target(w, h, slot = 'a') {
    const key = `${w}x${h}:${slot}`;
    let t = this.targets.get(key);
    if (t) {
      // most recently used goes last, so eviction never takes a texture this frame reads
      this.targets.delete(key);
      this.targets.set(key, t);
      return t;
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    t = { tex, fbo };
    this.targets.set(key, t);
    if (this.targets.size > 8) {
      const [firstKey, first] = this.targets.entries().next().value;
      if (firstKey !== key) {
        gl.deleteFramebuffer(first.fbo);
        gl.deleteTexture(first.tex);
        this.targets.delete(firstKey);
      }
    }
    return t;
  }

  render() {
    if (!this.ok) return;
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;
    const target = this.target(w, h);
    const opts = this.options;
    const srcTex = (this.pre && this.pre(gl, this.srcTex, w, h)) || this.srcTex;

    gl.useProgram(this.gradeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex || this.dummyLut);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uLut'), 1);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uHasLut'), this.lutTex ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uLog'), opts.log === 'alog' ? 1 : opts.log === 'alog2' ? 2 : 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.gradeProgram, 'uCam'), false, flatColumnMajor(cameraMatrix(opts.log)));
    gl.uniform3f(gl.getUniformLocation(this.gradeProgram, 'uGain'), opts.gain[0], opts.gain[1], opts.gain[2]);
    gl.uniform1f(gl.getUniformLocation(this.gradeProgram, 'uZoom'), opts.zoom || 1);
    gl.uniform4fv(gl.getUniformLocation(this.gradeProgram, 'uCrop'), opts.crop || [0, 0, 1, 1]);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uBypass'), opts.bypass ? 1 : 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.mips(target, opts, h);
    const high = this.lights(target, opts, w, h);

    const postT = this.post ? this.target(w, h, 'post') : null;
    gl.useProgram(this.compositeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, postT ? postT.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uGraded'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uSrc'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, high);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uHigh'), 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(gl.getUniformLocation(this.compositeProgram, 'uRes'), w, h);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uSplit'), opts.split);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uCompare'), opts.compare ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uBlur'), opts.blur);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uDof'), opts.dof || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusX'), opts.focusX ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusY'), opts.focusY ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusR'), opts.focusR ?? 0.3);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusSoft'), opts.focusSoft ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uGlow'), opts.glow);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uGrain'), opts.grain);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uVignette'), opts.vignette);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uPixel'), opts.pixel || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uLevels'), opts.levels || 0);
    gl.uniform3fv(gl.getUniformLocation(this.compositeProgram, 'uPal[0]'), palFlat(opts.palette));
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uPalCount'), Math.min(4, (opts.palette || []).length));
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uPalMix'), opts.paletteMix || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uSeed'), opts.seed);
    gl.uniform3f(gl.getUniformLocation(this.compositeProgram, 'uGain'), opts.gain[0], opts.gain[1], opts.gain[2]);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uZoom'), opts.zoom || 1);
    gl.uniform4fv(gl.getUniformLocation(this.compositeProgram, 'uCrop'), opts.crop || [0, 0, 1, 1]);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uMonitor'), opts.monitor || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uZebra'), opts.zebra ?? 0.88);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uPeak'), opts.peak ?? 0.22);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uQuality'), opts.blurQuality ?? 1);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uDofMode'), opts.dofMode || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusAspect'), opts.focusAspect || 1);
    this.opticsUniforms(opts);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uLog'), opts.log === 'alog' ? 1 : opts.log === 'alog2' ? 2 : 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.compositeProgram, 'uCam'), false, flatColumnMajor(cameraMatrix(opts.log)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (postT) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.post(gl, postT.tex, w, h, performance.now() / 1000);
    }
  }

  opticsUniforms(opts) {
    const gl = this.gl;
    const p = this.compositeProgram;
    const u = (name) => gl.getUniformLocation(p, name);
    gl.uniform2f(u('uSoft'), opts.softX || 0, opts.softY || 0);
    gl.uniform1f(u('uBleed'), opts.bleed || 0);
    gl.uniform1f(u('uShift'), opts.shift || 0);
    gl.uniform1f(u('uFringe'), opts.fringe || 0);
    gl.uniform1f(u('uScan'), opts.scan || 0);
    gl.uniform1f(u('uScanPeriod'), opts.scanPeriod || 0);
    gl.uniform1f(u('uBlock'), opts.block || 0);
    gl.uniform1f(u('uGrainAmt'), opts.grainAmount || 0);
    gl.uniform1f(u('uGrainChroma'), opts.grainChroma || 0);
    gl.uniform1f(u('uGrainCell'), opts.grainCell || 0);
    gl.uniform1f(u('uLetterbox'), opts.letterbox || 0);
    gl.uniform1f(u('uSharpen'), opts.sharpen || 0);
    gl.uniform1f(u('uBloom'), opts.bloom || 0);
    gl.uniform1f(u('uHalation'), opts.halation || 0);
    gl.uniform3fv(u('uHalTint'), opts.halTint || [1, 0.32, 0.12]);
    gl.uniform1f(u('uDiffuse'), opts.diffuse || 0);
  }

  /* The light pyramid for bloom and halation (HIGH_FRAG, then mipmaps). Off
     when no look uses them: a 1×1 placeholder keeps the sampler valid. */
  lights(target, opts, w, h) {
    const gl = this.gl;
    if ((opts.bloom || 0) + (opts.halation || 0) <= 0.005) {
      if (!this.noLight) {
        this.noLight = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.noLight);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      return this.noLight;
    }
    const t = this.target(w, h, 'light');
    gl.useProgram(this.highProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(gl.getUniformLocation(this.highProgram, 'uGraded'), 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return t.tex;
  }

  /* Pre-shrunk copies of the graded frame for wide blurs (see lodFor). */
  mips(target, opts, h) {
    const gl = this.gl;
    const sigmaPx = Math.max(opts.softX || 0, opts.softY || 0, opts.bleed || 0) * h;
    const light = (opts.diffuse || 0) > 0.005;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    if (sigmaPx > 2 || light) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
  }

  /** Render the current frame at an arbitrary size and return it as a canvas. */
  capture(width, height) {
    if (!this.ok) return null;
    const gl = this.gl;
    const target = this.target(width, height);
    const opts = this.options;
    gl.useProgram(this.gradeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uSrc'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex || this.dummyLut);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uLut'), 1);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uHasLut'), this.lutTex ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uLog'), opts.log === 'alog' ? 1 : opts.log === 'alog2' ? 2 : 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.gradeProgram, 'uCam'), false, flatColumnMajor(cameraMatrix(opts.log)));
    gl.uniform3f(gl.getUniformLocation(this.gradeProgram, 'uGain'), opts.gain[0], opts.gain[1], opts.gain[2]);
    gl.uniform1f(gl.getUniformLocation(this.gradeProgram, 'uZoom'), opts.zoom || 1);
    gl.uniform4fv(gl.getUniformLocation(this.gradeProgram, 'uCrop'), opts.crop || [0, 0, 1, 1]);
    gl.uniform1i(gl.getUniformLocation(this.gradeProgram, 'uBypass'), opts.bypass ? 1 : 0);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.mips(target, opts, height);
    const high = this.lights(target, opts, width, height);

    const out = this.target(width, height, 'b');
    gl.useProgram(this.compositeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uGraded'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uSrc'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, high);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uHigh'), 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(gl.getUniformLocation(this.compositeProgram, 'uRes'), width, height);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uCompare'), 0);
    gl.uniform3f(gl.getUniformLocation(this.compositeProgram, 'uGain'), opts.gain[0], opts.gain[1], opts.gain[2]);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uZoom'), opts.zoom || 1);
    gl.uniform4fv(gl.getUniformLocation(this.compositeProgram, 'uCrop'), opts.crop || [0, 0, 1, 1]);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uMonitor'), 0);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uQuality'), opts.blurQuality ?? 1);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uDofMode'), opts.dofMode || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusAspect'), opts.focusAspect || 1);
    this.opticsUniforms(opts);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uBlur'), opts.blur);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uDof'), opts.dof || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusX'), opts.focusX ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusY'), opts.focusY ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusR'), opts.focusR ?? 0.3);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uFocusSoft'), opts.focusSoft ?? 0.5);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uGlow'), opts.glow);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uGrain'), opts.grain);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uVignette'), opts.vignette);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uPixel'), opts.pixel || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uLevels'), opts.levels || 0);
    gl.uniform3fv(gl.getUniformLocation(this.compositeProgram, 'uPal[0]'), palFlat(opts.palette));
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uPalCount'), Math.min(4, (opts.palette || []).length));
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uPalMix'), opts.paletteMix || 0);
    gl.uniform1f(gl.getUniformLocation(this.compositeProgram, 'uSeed'), 7);
    gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'uLog'), opts.log === 'alog' ? 1 : opts.log === 'alog2' ? 2 : 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.compositeProgram, 'uCam'), false, flatColumnMajor(cameraMatrix(opts.log)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * rowBytes;
      img.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
    }
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
}

export { isLogSpace };
