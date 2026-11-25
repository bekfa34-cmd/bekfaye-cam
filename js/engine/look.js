/* Look model and bake pipeline.
   A "look" is a compact description of a grade: a 1024-entry lightness curve,
   five split-tone bands, a chroma gain, an optional monochrome lock, twelve
   hue-wheel sectors, and skin/sky guidance. The same `grade()` function is used
   for baking the .cube and (through the shader) for the live preview. */

import { clamp, rgbToLab, labToRgb, smoothstep, luma, mix, srgbToLinear, linearToSrgb } from './color.js';
import { BAND_CENTERS } from './analyze.js';

export { BAND_CENTERS };

/* Baseline: how a plain, well-exposed daylight frame distributes its lightness. */
export const CANON_Q = new Float32Array(33);
for (let i = 0; i <= 32; i++) CANON_Q[i] = 0.02 + 0.92 * (i / 32) ** 0.85;

const CANON_SKIN = [14, 22];
const CANON_SKIN_L = 62;
const CANON_SKY = [-8, -24];
const CANON_SKY_L = 72;

/* What plain, ungraded photos measure (bench/run.mjs mode=canon over eleven
   phone and camera frames). A reference is read as its difference from these:
   only what it has beyond a normal photo becomes part of the look. */
export const CANON = {
  chroma: 17.2,
  bandChroma: [9.8, 18.5, 22.7, 20.2, 14.3],
  // chroma-weighted hue share per 10° of Lab hue (0° = magenta-red, 90° = yellow, 270° = blue)
  hue: [1.3, 2.0, 3.4, 6.2, 4.1, 3.4, 6.7, 15.4, 11.1, 7.0, 1.1, 1.0, 0.6, 0.4, 0.4, 0.3, 0.2, 1.1, 4.0, 0.9, 0.9, 2.9, 1.4, 2.3, 3.1, 4.5, 9.4, 2.8, 1.5, 0.1, 0.0, 0.0, 0.1, 0.1, 0.1, 0.2],
  softX: 0.0015,
  softY: 0.0016,
  bleed: 0.0031,
  grain: 0.0019,
  grainChroma: 0.0045,
  // plain photos lean warm (sunlight, skin, earth): median a/b of their
  // near-neutral pixels per band. Only a tint beyond this is the grade.
  casts: [[0, 4.4], [2.2, 5.3], [2.2, 7.1], [1.2, 5.4], [0.5, 4.3]],
};
const HUE_N = 36;
const HUE_STEP = 360 / HUE_N;

/* ---------- curves ---------- */
export function makeTable(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const table = new Float32Array(1024);
  let k = 1;
  for (let j = 0; j < 1024; j++) {
    const x = j / 1023;
    while (k < pts.length - 1 && x > pts[k][0]) k++;
    const [x0, y0] = pts[k - 1];
    const [x1, y1] = pts[k];
    const t = x1 > x0 ? clamp((x - x0) / (x1 - x0)) : 0;
    table[j] = y0 + (y1 - y0) * t;
  }
  for (let j = 1; j < 1024; j++) if (table[j] < table[j - 1]) table[j] = table[j - 1];
  return table;
}

export const curveAt = (table, x) => {
  const pos = clamp(x) * 1023;
  const i = Math.min(1022, Math.floor(pos));
  return table[i] + (table[i + 1] - table[i]) * (pos - i);
};

/* A studio shot on pure white with black clothes has almost no mid-tones, so
   matching its histogram makes a step: every target turns into a threshold
   print. Real film curves stay between ~0.1× and ~3.5× slope; clip there and
   hand the clipped rise to the rest of the curve (like CLAHE's clip limit). */
export function limitSlope(table, lo = 0.1, hi = 3.5) {
  const n = table.length - 1;
  const d = new Float64Array(n);
  let total = 0;
  for (let j = 0; j < n; j++) total += d[j] = Math.max(0, table[j + 1] - table[j]);
  if (total < 1e-6) return table;
  const min = Math.min(lo, total * 0.5) / n;
  const max = Math.max(hi, total * 1.5) / n;
  let kept = 0;
  for (let j = 0; j < n; j++) kept += d[j] = Math.min(max, Math.max(min, d[j]));
  const delta = total - kept;
  // room (or surplus) per step, so the hand-back never crosses a limit
  let room = 0;
  for (let j = 0; j < n; j++) room += delta > 0 ? max - d[j] : d[j] - min;
  if (room > 1e-9) for (let j = 0; j < n; j++) d[j] += delta * (delta > 0 ? max - d[j] : d[j] - min) / room;
  for (let j = 0; j < n; j++) table[j + 1] = table[j] + d[j];
  return table;
}

function curveFromQuantiles(q) {
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
  };
  const sMean = mean(CANON_Q);
  const rMean = mean(q);
  const k = clamp(sd(q) / Math.max(sd(CANON_Q), 0.02), 0.62, 1.48);
  const shift = clamp(rMean - sMean, -0.28, 0.28);
  const affine = (x) => clamp(sMean + shift + (x - sMean) * k);
  const knots = [[0, clamp((q[0] - 0.02) * 0.85, 0, 0.18)]];
  for (let i = 1; i < 32; i++) {
    const x = CANON_Q[i];
    const base = affine(x);
    knots.push([x, clamp(base + clamp(q[i] - base, -0.2, 0.2))]);
  }
  knots.push([1, clamp(1 - Math.max(0, 0.96 - q[32]) * 0.85, 0.82, 1)]);
  const table = limitSlope(makeTable(knots));
  // Anchor mid-grey. A filter should carry a photo's contrast and tint, not
  // punish other footage with its absolute exposure — unanchored, a dark
  // reference halved everything it was applied to.
  // Half of it: a low-key reference should still read darker than a bright one.
  const mid = curveAt(table, 0.5);
  const anchor = clamp((0.5 - mid) * 0.5, -0.12, 0.12);
  if (Math.abs(anchor) > 0.004) {
    for (let j = 0; j < 1024; j++) table[j] = clamp(table[j] + anchor);
  }
  return table;
}

/* ---------- helpers ---------- */
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const gauss =(a, b, base, sigma) => Math.exp(-((a - base[0]) ** 2 + (b - base[1]) ** 2) / (2 * sigma * sigma));
const degrees = (rad) => ((rad * 180) / Math.PI + 360) % 360;
const angleDelta = (h, center) => ((h - center + 540) % 360) - 180;

function moveToward(from, to, max) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  const k = len > max ? max / len : 1;
  return [dx * k, dy * k];
}

function castAt(casts, L) {
  const x = clamp((L - BAND_CENTERS[0]) / (BAND_CENTERS[4] - BAND_CENTERS[0])) * 4;
  const i = Math.min(3, Math.floor(x));
  const t = x - i;
  return [mix(casts[i][0], casts[i + 1][0], t), mix(casts[i][1], casts[i + 1][1], t)];
}

/* ---------- hue map ---------- */
const smoothCircular = (d, passes = 2) => {
  let a = Float32Array.from(d);
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = 0.25 * a[(i + a.length - 1) % a.length] + 0.5 * a[i] + 0.25 * a[(i + 1) % a.length];
    a = b;
  }
  const s = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => v / s);
};

/* Where each hue of a normal photo has to go for its colours to fall the way
   the reference's do: circular histogram matching (the cut on the wheel that
   moves the least), scaled by how narrow the reference palette is. A wide,
   natural palette barely moves anything; a two-colour or one-colour grade
   pulls everything onto its colours, and hues it never shows lose chroma. */
export function hueMap(density, references = 1, trust = 1, evidence = 1) {
  if (!density || density.length !== HUE_N) return null;
  const R = smoothCircular(density);
  const N = smoothCircular(CANON.hue.map((v) => v / 100 * 0.5 + 0.5 / HUE_N));
  // on the raw shares (the thresholds below were measured that way; smoothing
  // first made a two-bin palette look six bins wide)
  const total = density.reduce((a, b) => a + b, 0);
  if (total < 1e-6) return null;
  let entropy = 0;
  for (const v of density) if (v > 1e-6) entropy -= (v / total) * Math.log(v / total);
  entropy /= Math.log(HUE_N);
  // Plain photos measured 0.41–0.77 here; one- and two-colour grades 0.03–0.4.
  // A palette that narrow is the grade, not the subject, so one photo is
  // enough to trust it.
  const strength = clamp((0.42 - entropy) / 0.2, 0, 1) * (0.75 + 0.25 * trust) * evidence;

  let best = null;
  for (let cut = 0; cut < HUE_N; cut++) {
    // cumulative shares starting at `cut`
    const cdfR = new Float32Array(HUE_N + 1);
    for (let k = 0; k < HUE_N; k++) cdfR[k + 1] = cdfR[k] + R[(cut + k) % HUE_N];
    const shift = new Float32Array(HUE_N);
    let cost = 0;
    let acc = 0;
    for (let k = 0; k < HUE_N; k++) {
      const i = (cut + k) % HUE_N;
      const u = acc + N[i] / 2;
      acc += N[i];
      let j = 0;
      while (j < HUE_N - 1 && cdfR[j + 1] < u) j++;
      const t = R[(cut + j) % HUE_N] > 1e-9 ? (u - cdfR[j]) / R[(cut + j) % HUE_N] : 0.5;
      const target = (cut + j + clamp(t, 0, 1)) * HUE_STEP;
      const source = (i + 0.5) * HUE_STEP;
      const d = ((target - source + 540) % 360) - 180;
      shift[i] = d;
      cost += N[i] * Math.abs(d);
    }
    if (!best || cost < best.cost) best = { cost, shift };
  }
  // Neighbouring hues must stay neighbours (jumps band into blotches), and a
  // hue that would have to swing far round the wheel is muted toward the
  // palette rather than turned into some colour in between.
  let raw = Array.from(best.shift, (d) => d * strength);
  for (let pass = 0; pass < 3; pass++) raw = raw.map((d, i) => 0.25 * raw[(i + HUE_N - 1) % HUE_N] + 0.5 * d + 0.25 * raw[(i + 1) % HUE_N]);
  const shift = raw.map((d) => Math.round(clamp(d, -60, 60) * 10) / 10);
  const gain = raw.map((d, i) => {
    const landing = Math.round(((i + 0.5) * HUE_STEP + shift[i]) / HUE_STEP - 0.5 + HUE_N) % HUE_N;
    const presence = R[landing] * HUE_N;
    const missing = clamp(1 - presence / 0.35);
    const far = clamp((Math.abs(d) - 45) / 60);
    return Math.round((1 - 0.5 * strength * missing) * (1 - 0.7 * far) * 1000) / 1000;
  });
  return { shift, gain, strength: Math.round(strength * 1000) / 1000 };
}

const hueAt = (arr, h) => {
  const x = h / HUE_STEP - 0.5;
  const i = Math.floor(x);
  const t = x - i;
  return arr[(i + HUE_N) % HUE_N] * (1 - t) + arr[(i + 1) % HUE_N] * t;
};

/* ---------- look construction ---------- */
export function buildLook(profile) {
  const q = profile.q || CANON_Q;
  const refs = profile.references || 1;
  // One photo mixes its grade with its subject (a grey cliff is muted, a sunny
  // street is warm), so the traits a subject can fake are trusted in part, and
  // more with every reference that agrees.
  const trust = refs / (refs + 0.5);
  const castK = 0.6 + 0.3 * trust;
  const casts = (profile.casts || CANON.casts).map((c, k) => [
    clamp((c[0] - CANON.casts[k][0]) * castK, -30, 30),
    clamp((c[1] - CANON.casts[k][1]) * castK, -30, 30),
  ]);

  const mono = profile.mono
    ? { present: !!profile.mono.present, pure: !!profile.mono.pure, tint: (profile.mono.tint || [0, 0]).slice() }
    : { present: false, pure: false, tint: [0, 0] };

  const chroma = profile.chroma || CANON.chroma;
  const saturation = mono.present ? 0 : profile.mono && profile.mono.near ? 0.32 : clamp((chroma / CANON.chroma) ** trust, 0.12, 1.35 + 0.3 * trust);
  const bandSat = !mono.present && profile.bandChroma
    ? profile.bandChroma.map((c, k) => Math.round(clamp(((c / chroma) / (CANON.bandChroma[k] / CANON.chroma)) ** (0.7 * trust), 0.45, 1.7) * 1000) / 1000)
    : null;
  // A palette that narrow can be the subject (a meadow, a blue sky). A grade
  // that narrows the palette also tints the greys, so it needs that evidence.
  const tint = casts.reduce((s, c) => s + Math.hypot(c[0], c[1]), 0) / casts.length;
  const hue = !mono.present ? hueMap(profile.hueDensity, refs, trust, clamp((tint - 2) / 5, 0, 1)) : null;
  // A one- or two-hue reference never shows a colour stronger than its own:
  // a yellow coat under green night-vision is pale green, not neon green.
  if (hue && profile.chroma90 > 0) hue.ceiling = Math.round(profile.chroma90 * 1.1 * 10) / 10;
  // ...nor stronger than it shows at that brightness (night-vision highlights are pale)
  if (hue && profile.bandChroma) hue.bandCeil = profile.bandChroma.map((c) => Math.round(Math.max(8, c * 2) * 10) / 10);

  const sectors = [];
  if (!mono.present && profile.hueSectors) {
    for (const sec of profile.hueSectors) {
      if (!sec.present || sec.share < 0.035) continue;
      const rad = (sec.center * Math.PI) / 180;
      const neutral = [Math.cos(rad) * 19, Math.sin(rad) * 19];
      // A hue push should nudge an input toward the reference's tint, not
      // re-saturate it. Pushing by the full measured chroma doubled vivid hues,
      // which is why a blue sky came out cyan.
      const push = moveToward(neutral, sec.ab, 6);
      const weight = clamp(sec.share * 1.6, 0, 0.55);
      sectors.push({
        center: sec.center,
        da: push[0] * weight,
        db: push[1] * weight,
        dL: clamp((sec.L - 52) * 0.06, -4, 4) * weight,
        weight,
      });
    }
  }

  const skin = profile.skin && profile.skin.present
    ? {
        present: true,
        base: profile.skin.ab,
        shift: moveToward(CANON_SKIN, profile.skin.ab, 16),
        dL: clamp(profile.skin.L - CANON_SKIN_L, -10, 10),
      }
    : { present: false, base: CANON_SKIN, shift: [0, 0], dL: 0 };

  const sky = profile.sky && profile.sky.present
    ? {
        present: true,
        base: profile.sky.ab,
        shift: moveToward(CANON_SKY, profile.sky.ab, 20),
        dL: clamp(profile.sky.L - CANON_SKY_L, -10, 10),
      }
    : { present: false, base: CANON_SKY, shift: [0, 0], dL: 0 };

  const texture = profile.texture || { blur: 0, glow: 0, grain: 0, vignette: 0, pixel: 0, levels: 0 };
  // Optics beyond a normal photo's own (blur adds in quadrature).
  const beyond = (v, base) => (v > base ? Math.sqrt(v * v - base * base) : 0);
  const optics = 'softX' in texture
    ? {
        softX: r5(beyond(texture.softX ?? CANON.softX, CANON.softX)),
        softY: r5(beyond(texture.softY ?? CANON.softY, CANON.softY)),
        // below ~0.0015 of the frame a smear is just how a JPEG stores colour
        bleed: r5(beyond(texture.bleed || 0, CANON.bleed) >= 0.0015 ? beyond(texture.bleed || 0, CANON.bleed) : 0),
        shift: r5(texture.shift || 0),
        fringe: r5(texture.fringe || 0),
        scan: r5(texture.scan || 0),
        scanPeriod: r5(texture.scanPeriod || 0),
        block: r5(texture.block || 0),
        // capped at heavy-film level: dither or a noise-only frame would read as static
        grainAmount: r5(Math.min(0.05, beyond(texture.grainAmount || 0, CANON.grain))),
        grainChroma: r5(Math.min(0.05, beyond(texture.grainChroma || 0, CANON.grainChroma))),
        grainCell: r5(texture.grainCell || 0),
        letterbox: texture.letterbox || 0,
        // Light from lamps in the dark (optics.js nightLights), inverted with the
        // bench's night test: rendered halation h reads as red ≈ 0.13·h, bloom b
        // lifts the ring ≈ 0.28·b. Offsets are what real clean looks read
        // (hi-fi, Portra, cinematic). Daylight references have no reading: none.
        halation: texture.haloRed == null ? 0 : r5(clamp((texture.haloRed - 0.025) / 0.11)),
        bloom: texture.halo == null ? 0 : r5(0.8 * clamp((texture.halo - 0.09 - 0.55 * Math.max(0, texture.haloRed || 0)) / 0.28)),
        // crisper than a plain photo (edited, oversharpened, hi-fi): sharpen
        // back to that — but not pixel art, whose hard steps read as sharp too
        sharpen: !texture.block && texture.softX != null && texture.softY != null && (texture.softX + texture.softY) / 2 < 0.88 * CANON.softX
          ? r5(clamp(((CANON.softX - (texture.softX + texture.softY) / 2) / CANON.softX) * 1.6, 0, 1))
          : 0,
      }
    : {};

  /* A filter carries the palette of the photo it came from. Two colours in the
     photo means two colours out, so the palette step is switched on for small
     palettes — but only when the colours are actually saturated. A grey ramp is
     monochrome, not a two-colour poster. */
  const palette = (profile.palette || []).filter((p) => p && p.hex);
  const paletteSize = profile.paletteSize || palette.length || 0;
  const vivid = palette.filter((p) => Math.max(p.r, p.g, p.b) - Math.min(p.r, p.g, p.b) >= 0.12).length;
  // Only a genuinely two-colour picture becomes a two-colour filter. Posterising
  // a three- or four-colour photograph was not asked for, and it made normal
  // frames drift — a blue sky was being mapped onto a pale cyan swatch.
  // And only a graphic one: a green-lit photo also has two colours, and posterising
  // it made people into flat green cut-outs. Tinted photos go through the hue map.
  const paletteMix = !mono.pure && paletteSize === 2 && vivid >= 1 && (texture.posterize || texture.block) ? 0.75 : 0;

  const look = {
    // a bright sky or a dark room is partly subject: tone follows the
    // reference most of the way, and further as references agree
    // ...except black and white, where tone is the whole look: in full
    curve: curveFromQuantiles(q.map((v, i) => CANON_Q[i] + (v - CANON_Q[i]) * (mono.present ? 1 : 0.6 + 0.4 * trust))),
    casts,
    saturation,
    bandSat,
    hue,
    mono,
    sectors,
    skin,
    sky,
    texture: {
      // measured resolution (softX/Y) replaces the old soft-focus score
      blur: optics.softX != null ? 0 : clamp(texture.blur || 0, 0, 1),
      glow: clamp(texture.glow || 0, 0, 1),
      // the measured grain amount replaces the old 0–1 score when present
      grain: optics.grainAmount != null ? 0 : clamp(texture.grain || 0, 0, 1),
      vignette: clamp(texture.vignette || 0, 0, 1),
      pixel: 0,
      levels: clamp(texture.levels || 0, 0, 1),
      paletteMix: clamp(paletteMix, 0, 1),
      ...optics,
    },
    meta: {
      name: (profile.style && profile.style.name) || 'Custom colour grade',
      tags: (profile.style && profile.style.tags) || [],
      swatches: palette.length ? palette.slice(0, 4).map((p) => p.hex) : profile.swatches || [],
      references: profile.references || 1,
      monochrome: mono.present,
      paletteSize,
      traits: profile.traits || null,
    },
  };
  // how light falls on skin, measured against what this look already does
  look.skinTone = skinToneFor(profile.skin, look, trust);
  if (look.skinTone) look.skin = { ...look.skin, shift: [0, 0], dL: 0 };
  return look;
}

/* ---------- presets ---------- */
const PRESET_CURVES = {
  y2k: [
    [0, 0.055], [0.1, 0.13], [0.25, 0.28], [0.5, 0.53], [0.72, 0.76], [0.88, 0.92], [1, 0.98],
  ],
  noir: [
    [0, 0.02], [0.12, 0.05], [0.25, 0.14], [0.5, 0.53], [0.72, 0.83], [0.88, 0.96], [1, 1],
  ],
  sepia: [
    [0, 0.1], [0.15, 0.2], [0.4, 0.43], [0.65, 0.67], [0.85, 0.84], [1, 0.93],
  ],
};

export const PRESETS = [
  {
    id: 'y2k',
    label: 'Y2K Orange',
    note: 'Lifted blacks, warm halation, soft focus',
    look: {
      curve: makeTable(PRESET_CURVES.y2k),
      casts: [[2, 4], [4, 9], [5, 13], [4, 10], [2, 6]],
      saturation: 1.14,
      mono: { present: false, pure: false, tint: [0, 0] },
      sectors: [
        { center: 45, da: 3, db: 6, dL: 0, weight: 0.5 },
        { center: 15, da: 2, db: 3, dL: 0, weight: 0.4 },
      ],
      skin: { present: false, base: CANON_SKIN, shift: [0, 0], dL: 0 },
      sky: { present: false, base: CANON_SKY, shift: [0, 0], dL: 0 },
      texture: { blur: 0.55, glow: 0.62, grain: 0.14, vignette: 0.22 },
      meta: { name: 'Y2K dream warm', tags: ['Lifted blacks', 'Halation', 'Soft focus'], swatches: ['#ffb877', '#e08b52', '#8a6a58'], references: 0, monochrome: false },
    },
  },
  {
    id: 'noir',
    label: 'Noir B&W',
    note: 'Hard silver contrast, grain, vignette',
    look: {
      curve: makeTable(PRESET_CURVES.noir),
      casts: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
      saturation: 0,
      mono: { present: true, pure: true, tint: [0, 0] },
      sectors: [],
      skin: { present: false, base: CANON_SKIN, shift: [0, 0], dL: 0 },
      sky: { present: false, base: CANON_SKY, shift: [0, 0], dL: 0 },
      texture: { blur: 0, glow: 0.1, grain: 0.34, vignette: 0.28 },
      meta: { name: 'High-contrast noir', tags: ['Black & white', 'Punchy', 'Grain'], swatches: ['#f2f2f0', '#8d8d8b', '#1b1b1b'], references: 0, monochrome: true },
    },
  },
  {
    id: 'sepia',
    label: 'Vintage Mono',
    note: 'Faded sepia print, soft edges',
    look: {
      curve: makeTable(PRESET_CURVES.sepia),
      casts: [[0, 2], [1, 4], [1, 5], [0, 4], [0, 2]],
      saturation: 0,
      mono: { present: true, pure: false, tint: [2.4, 8.6] },
      sectors: [],
      skin: { present: false, base: CANON_SKIN, shift: [0, 0], dL: 0 },
      sky: { present: false, base: CANON_SKY, shift: [0, 0], dL: 0 },
      texture: { blur: 0.16, glow: 0.2, grain: 0.26, vignette: 0.3 },
      meta: { name: 'Warm sepia mono', tags: ['Sepia', 'Lifted blacks', 'Grain'], swatches: ['#efe0c6', '#b4906a', '#5b4536'], references: 0, monochrome: true },
    },
  },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id) || null;

/* ---------- skin light ---------- */
const SKIN_HUE = 57;
const SKIN_C = 18;

/** How skin-like an input colour is: a hue band and a chroma range, at any
    lightness (deep and pale skin alike). */
export function skinLike(L, a, b) {
  const C = Math.hypot(a, b);
  const h = degrees(Math.atan2(b, a));
  const hue = 1 - smoothstep(16, 30, Math.abs(angleDelta(h, SKIN_HUE)));
  return hue * smoothstep(5, 12, C) * (1 - smoothstep(45, 60, C)) * smoothstep(6, 14, L) * (1 - smoothstep(92, 98, L));
}

function inverseCurve(table, y) {
  let lo = 0;
  let hi = 1023;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < y) lo = mid + 1;
    else hi = mid;
  }
  return lo / 1023;
}

/* How light falls on skin in the reference, as a correction the look adds
   to skin-like colours: an overall skin tint plus a shift from the shadow
   side to the lit side. Measured against what the rest of the look already
   does to plain skin, so only the lighting is added, never twice. Kept as a
   tint + slope (not per lightness) so a dark-skinned reference carries to
   pale skin and the other way round. */
function skinToneFor(skin, look, trust) {
  if (!skin || !skin.present || !skin.bands || look.mono.present) return null;
  const pts = [];
  const rad = (SKIN_HUE * Math.PI) / 180;
  for (const band of skin.bands) {
    if (!band) continue;
    const Lin = inverseCurve(look.curve, band.L / 100) * 100;
    const plain = labToRgb([Lin, Math.cos(rad) * SKIN_C, Math.sin(rad) * SKIN_C]);
    const [Lo, ao, bo] = rgbToLab(grade(plain, look, DEFAULT_ADJUST));
    pts.push({ L: Lo, da: band.a - ao, db: band.b - bo, w: band.n });
  }
  if (!pts.length) return null;
  const W = pts.reduce((s, p) => s + p.w, 0);
  const m = (f) => pts.reduce((s, p) => s + f(p) * p.w, 0) / W;
  const Lc = m((p) => p.L);
  const da = m((p) => p.da);
  const db = m((p) => p.db);
  const vL = m((p) => (p.L - Lc) ** 2);
  // slope per 10 L, only when the skin spans a real range of light
  const sa = vL > 25 ? (m((p) => (p.L - Lc) * (p.da - da)) / vL) * 10 : 0;
  const sb = vL > 25 ? (m((p) => (p.L - Lc) * (p.db - db)) / vL) * 10 : 0;
  // The overall skin tint is mostly the person (skin differs by a few degrees
  // of hue from one person to the next) and the light's tint is already in
  // the casts; the shift from shadow side to lit side is the lighting.
  const k = 0.55 + 0.4 * trust;
  // (bench, skin-only error with/without: teal-orange 15.6→14.4, golden
  // 19.9→17.5, Portra 17.9→17.3; the overall tint at 0.8, not damped further)
  const cap = (v, lim, w = 1) => Math.round(clamp(v * k * w, -lim, lim) * 100) / 100;
  return { a: cap(da, 12, 0.8), b: cap(db, 12, 0.8), sa: cap(sa, 4), sb: cap(sb, 4) };
}

/* ---------- grading ---------- */
const bandSatAt = (bands, L) => {
  if (!bands) return 1;
  const x = clamp((L - BAND_CENTERS[0]) / (BAND_CENTERS[4] - BAND_CENTERS[0])) * 4;
  const i = Math.min(3, Math.floor(x));
  return mix(bands[i], bands[i + 1], x - i);
};

export const DEFAULT_ADJUST = {
  strength: 1,
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  fade: 0,
  mids: 0,
  shadows: 0,
  highlights: 0,
  black: 0,
  white: 0,
  protectSkin: true,
};

export function grade(rgb, look, adj = DEFAULT_ADJUST) {
  const strength = adj.strength ?? 1;
  if (strength <= 0.0005) return [rgb[0], rgb[1], rgb[2]];
  // Past 100%: the look again on top of itself, not an extrapolation (which
  // would push a black-and-white look through grey into opposite colours).
  if (strength > 1) {
    const once = grade(rgb, look, { ...DEFAULT_ADJUST, strength: 1 });
    return grade(once, look, { ...adj, strength: Math.min(1, strength - 1) });
  }

  let [L, a, b] = rgbToLab(rgb);
  const C = Math.hypot(a, b);
  const mono = look.mono.present;

  const skinW =
    !mono && look.skin.present && adj.protectSkin !== false
      ? smoothstep(18, 30, L) * (1 - smoothstep(86, 96, L)) * smoothstep(2, 10, C) * gauss(a, b, look.skin.base, 10)
      : 0;
  const skyW = !mono && look.sky.present ? smoothstep(30, 48, L) * smoothstep(3, 12, C) * gauss(a, b, look.sky.base, 12) : 0;

  let L2 = curveAt(look.curve, L / 100) * 100;
  L2 += skinW * look.skin.dL * 0.6 + skyW * look.sky.dL;

  // Silver retention: bleach-bypass style prints lose colour fastest in the
  // highlights, so the desaturation has to follow luminance, not sit flat.
  const bleach = clamp(look.bleach || 0, 0, 1);
  if (bleach > 0) L2 = clamp(L2 + bleach * (L2 - 50) * 0.1, 0, 100);

  let a2;
  let b2;
  if (mono) {
    L2 = clamp(L2, 0, 100);
    const bell = Math.sin(clamp(L2 / 100) * Math.PI) ** 0.75;
    const cast = castAt(look.casts, L2);
    if (look.mono.pure) {
      a2 = 0;
      b2 = 0;
    } else {
      a2 = (look.mono.tint[0] * 0.72 + cast[0] * 0.28) * bell;
      b2 = (look.mono.tint[1] * 0.72 + cast[1] * 0.28) * bell;
    }
  } else {
    const silver = bleach * smoothstep(32, 88, L2);
    const satK =
      (1 + (look.saturation * (adj.saturation ?? 1) - 1) * (1 - 0.5 * skinW)) * (1 - silver * 0.85) * bandSatAt(look.bandSat, L2);
    // Palette: rotate each hue to where the reference keeps it.
    if (look.hue && C > 1) {
      const h = degrees(Math.atan2(b, a));
      const w = smoothstep(2, 10, C) * (1 - 0.6 * skinW);
      const turn = (hueAt(look.hue.shift, h) * w * Math.PI) / 180;
      const g = 1 + (hueAt(look.hue.gain, h) - 1) * w;
      const ca = Math.cos(turn);
      const sa = Math.sin(turn);
      const a1 = (a * ca - b * sa) * g;
      b = (a * sa + b * ca) * g;
      a = a1;
    }
    const cast = castAt(look.casts, L2);
    let secA = 0;
    let secB = 0;
    let secL = 0;
    if (C > 3 && look.sectors.length) {
      const h = degrees(Math.atan2(b, a));
      const cWeight = smoothstep(3, 12, C) * (1 - 0.75 * skinW);
      for (const sec of look.sectors) {
        const d = Math.abs(angleDelta(h, sec.center));
        if (d >= 50) continue;
        const w = (1 - d / 50) ** 2 * cWeight * sec.weight;
        secA += sec.da * w;
        secB += sec.db * w;
        secL += sec.dL * w;
      }
    }
    a2 = a * satK + cast[0] + skinW * look.skin.shift[0] + skyW * look.sky.shift[0] + secA;
    b2 = b * satK + cast[1] + skinW * look.skin.shift[1] + skyW * look.sky.shift[1] + secB;
    L2 = clamp(L2 + secL + skinW * look.skin.dL * 0.4, 0, 100);
    // the reference's light on skin: tint, plus shadow side → lit side
    if (look.skinTone) {
      const sw = skinLike(L, a, b);
      if (sw > 0.001) {
        const t = clamp((L2 - 55) / 10, -3, 3);
        a2 += sw * (look.skinTone.a + look.skinTone.sa * t);
        b2 += sw * (look.skinTone.b + look.skinTone.sb * t);
      }
    }
    // A one- or two-hue reference never shows a colour stronger than its own at
    // that brightness: soft knee into its ceiling, as far as the palette map is
    // trusted (casts included — they carry most of a green night-vision tint).
    const m = look.hue && look.hue.ceiling ? Math.min(look.hue.ceiling, look.hue.bandCeil ? bandSatAt(look.hue.bandCeil, L2) : Infinity) : 0;
    const C2 = Math.hypot(a2, b2);
    if (m > 0 && C2 > 0.7 * m) {
      const capped = 0.7 * m + 0.3 * m * Math.tanh((C2 - 0.7 * m) / (0.3 * m));
      const k = 1 + (capped / C2 - 1) * look.hue.strength;
      a2 *= k;
      b2 *= k;
    }
  }

  let out = labToRgb([clamp(L2, 0, 100), a2, b2]);

  /* user adjustments, applied display-referred */
  if (adj.exposure) {
    const gain = 2 ** adj.exposure;
    out = out.map((v) => linearToSrgb(srgbToLinear(v) * gain));
  }
  if (adj.fade) {
    const f = clamp(adj.fade, 0, 0.35);
    out = out.map((v) => f + v * (1 - f * 0.85));
  }
  if (adj.mids || adj.shadows || adj.highlights || adj.black || adj.white) {
    const gamma = 2 ** -(adj.mids || 0);
    const lo = clamp(adj.black || 0, 0, 0.45);
    const hi = clamp(1 - (adj.white || 0), 0.55, 1);
    out = out.map((v) => {
      let x = clamp((v - lo) / Math.max(hi - lo, 1e-6));
      x = x ** gamma;
      x += (adj.shadows || 0) * (1 - x) ** 2 * 0.5;
      x *= 1 + (adj.highlights || 0) * 0.5;
      return clamp(x);
    });
  }
  if (adj.contrast !== 1) out = out.map((v) => (v - 0.5) * adj.contrast + 0.5);
  if (adj.saturation !== 1) {
    const y = luma(out[0], out[1], out[2]);
    out = out.map((v) => y + (v - y) * adj.saturation);
  }
  if (adj.temperature) {
    const t = adj.temperature * 0.045;
    out = [out[0] + t, out[1], out[2] - t];
  }

  return [
    clamp(mix(rgb[0], out[0], strength)),
    clamp(mix(rgb[1], out[1], strength)),
    clamp(mix(rgb[2], out[2], strength)),
  ];
}

/* ---------- lattice baking ---------- */
const LATTICE_SMOOTH = 0.5;
const LATTICE_PASSES = 3;

function smoothLattice(values, n) {
  if (n < 3) return values;
  const out = new Float32Array(values.length);
  const idx = (r, g, b) => ((b * n + g) * n + r) * 3;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const i = idx(r, g, b);
        const interior = r > 0 && g > 0 && b > 0 && r < n - 1 && g < n - 1 && b < n - 1;
        for (let c = 0; c < 3; c++) {
          if (!interior) {
            out[i + c] = values[i + c];
            continue;
          }
          const avg =
            (values[idx(r - 1, g, b) + c] +
              values[idx(r + 1, g, b) + c] +
              values[idx(r, g - 1, b) + c] +
              values[idx(r, g + 1, b) + c] +
              values[idx(r, g, b - 1) + c] +
              values[idx(r, g, b + 1) + c]) /
            6;
          out[i + c] = values[i + c] * (1 - LATTICE_SMOOTH) + avg * LATTICE_SMOOTH;
        }
      }
    }
  }
  return out;
}

export function bakeLattice(look, adj, size, decode, onProgress) {
  const values = new Float32Array(size * size * size * 3);
  let k = 0;
  for (let b = 0; b < size; b++) {
    if (onProgress && b % 2 === 0) onProgress(b / size);
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const input = [r / (size - 1), g / (size - 1), b / (size - 1)];
        const display = decode ? decode(input) : input;
        const out = grade(display, look, adj);
        values[k++] = out[0];
        values[k++] = out[1];
        values[k++] = out[2];
      }
    }
  }
  let smoothed = values;
  for (let p = 0; p < LATTICE_PASSES; p++) smoothed = smoothLattice(smoothed, size);
  return smoothed;
}
