// West looks: colour looks baked into 33^3 LUTs (r fastest, as engine gl.js setLut expects) plus viewer options
// (grain, vignette, halation...). Ported from v2.1. Dropped: Fisheye, Line, Blue Ink, Red Pen (need spatial/edge shaders).

export const MAIN_LUT = [
  [4, 8, 22, 36, 52, 70, 90, 112, 130, 148, 168, 189, 206, 220, 232, 242, 246],
  [3, 9, 20, 31, 46, 63, 80, 99, 120, 139, 156, 176, 193, 206, 219, 234, 244],
  [1, 4, 10, 17, 28, 45, 64, 80, 98, 123, 148, 168, 180, 190, 199, 209, 216],
];

const N = 33;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const sat = (c, s) => { const l = lum(c); return c.map((v) => l + (v - l) * s); };
const mulv = (c, m) => c.map((v, i) => v * m[i]);
const mixv = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const powv = (c, p) => c.map((v, i) => Math.pow(Math.max(v, 0), p[i]));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** fn: [r,g,b] 0..1 -> [r,g,b] 0..1. Returns Float32Array(N^3*3), r fastest. */
export function bakeLut(fn, n = N) {
  const out = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const c = fn([r / (n - 1), g / (n - 1), b / (n - 1)]);
    out[i++] = clamp01(c[0]); out[i++] = clamp01(c[1]); out[i++] = clamp01(c[2]);
  }
  return out;
}

function curve(ch, v) {
  const p = clamp01(v) * 16, k = Math.min(15, Math.floor(p));
  return (MAIN_LUT[ch][k] + (MAIN_LUT[ch][k + 1] - MAIN_LUT[ch][k]) * (p - k)) / 255;
}
const main = (c) => [curve(0, c[0]), curve(1, c[1]), curve(2, c[2])];

// lazy LUT per look: baked on first read (33^3 is ~36k px, cheap, but no need to pay for all up front)
function mk(id, name, fn, options = {}) {
  let cache = null;
  return { id, name, options, get lut() { return fn ? cache || (cache = bakeLut(fn)) : null; } };
}

export const WEST_LOOKS = [
  mk('original', 'Original', null),
  mk('main', 'Main', main, { bloom: 0.2, halation: 0.3, halTint: [1, 0.7, 0.25], grain: 0.3, vignette: 0.25 }),
  mk('green', 'Muted Green', (o) => {
    const c = mulv(sat(o, 0.55), [0.86, 1, 0.84]);
    return mixv(c, powv(c, [1.3, 1.15, 1.4]), 0.7);
  }, { grain: 0.3, vignette: 0.6 }),
  mk('pink', 'Muted Pink', (o) => {
    const c = mulv(sat(o, 0.5), [1, 0.86, 0.9]).map((v, i) => v + [0.04, 0, 0.03][i]);
    return mixv(c, powv(c, [1.2, 1.35, 1.3]), 0.7);
  }, { grain: 0.3, vignette: 0.6 }),
  mk('bw', 'B&W', (o) => { const v = smooth(0.04, 0.96, lum(o)); return [v, v, v]; }, { grain: 0.4 }),
  mk('film', 'Film', (o) => {
    let c = mixv(o, mulv(o, [0.85, 1, 1.1]), 1 - smooth(0, 0.5, lum(o)));
    c = mixv(c, mulv(c, [1.12, 1, 0.85]), smooth(0.4, 1, lum(c)));
    return c.map((v) => ((v - 0.5) * 1.12 + 0.5) * 0.9 + 0.06);
  }, { halation: 0.6, halTint: [1, 0.35, 0.1], grain: 0.5, vignette: 0.6 }),
  mk('leak', 'Film Leak', (o) => main(o).map((v) => v * 0.95), { bloom: 0.35, halation: 0.9, halTint: [1, 0.45, 0.1], grain: 0.3, vignette: 0.25 }),
  mk('pinhole', 'Pinhole', (o) => mulv(sat(o, 0.9), [1.05, 0.95, 0.8]), { blur: 0.25, vignette: 1, grain: 0.3 }),
  mk('dream', 'Dream', (o) => mulv(sat(o, 1.25), [1.05, 1, 0.94]).map((v) => v * 0.94 + 0.04), { glow: 0.6, diffuse: 0.6, bloom: 0.3, vignette: 0.7 }),
  mk('flash', 'Flash', (o) => mulv(sat(o.map((v) => (v - 0.45) * 1.25 + 0.5), 1.15), [1.08, 1, 0.9]), { vignette: 0.7, grain: 0.35 }),
  mk('threshold', 'Threshold', (o) => (lum(o) >= 0.45 ? [0.96, 0.9, 0.78] : [0.12, 0.07, 0.04])),
  mk('pixel', 'Pixelate', null, { pixel: 1 }),
];
