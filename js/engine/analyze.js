/* Reference analysis.
   Reads a decoded frame once and describes it the way a colourist would:
   tone distribution, where the shadows/mids/highlights sit, the palette around
   the hue wheel, whether it is monochrome (and how it is tinted), the skin and
   sky regions, and how much blur, halation, grain and vignette it carries. */

import { clamp, rgbToLab, smoothstep, luma } from './color.js';
import { findBars, crop, measureOptics } from './optics.js';

export const HUE_BINS = 36;
const SECTOR_COUNT = 12;
export const SECTOR_CENTERS = Array.from({ length: SECTOR_COUNT }, (_, i) => i * 30 + 15);
const BAND_EDGES = [22, 42, 62, 82]; // L* splits -> 5 split-tone bands

const BAND_CENTERS = [12, 32, 52, 72, 90];
export { BAND_CENTERS };

const deg = (rad) => ((rad * 180) / Math.PI + 360) % 360;
const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ---------- spatial texture ---------- */
function boxBlur(grid, w, h, radius) {
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += grid[y * w + clamp(i, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / span;
      sum += grid[y * w + Math.min(w - 1, x + radius + 1)] - grid[y * w + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += tmp[clamp(i, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / span;
      sum += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

function analyzeTexture(px, width, height) {
  const gw = Math.min(384, width);
  const gh = Math.max(8, Math.min(320, Math.round((height * gw) / width)));
  if (gw < 8 || gh < 8) return { blur: 0, glow: 0, grain: 0, vignette: 0, sharpness: 0.5 };

  const n = gw * gh;
  const lum = new Float32Array(n);
  const warmth = new Float32Array(n);
  for (let gy = 0; gy < gh; gy++) {
    const sy = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / gh));
    for (let gx = 0; gx < gw; gx++) {
      const sx = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / gw));
      const i = (sy * width + sx) * 4;
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const k = gy * gw + gx;
      lum[k] = luma(r, g, b);
      warmth[k] = Math.max(0, (r - b) * 0.7 + (g - b) * 0.3);
    }
  }

  const soft = boxBlur(lum, gw, gh, 1);
  const wide = boxBlur(lum, gw, gh, 4);

  let gradSum = 0;
  let lapSum = 0;
  let count = 0;
  let halo = 0;
  let specular = 0;
  const gradMap = new Float32Array(n);
  const grads = [];
  const flats = [];
  // per quadrant: a ring around the middle, and the far corner
  const ringLum = [0, 0, 0, 0];
  const ringN = [0, 0, 0, 0];
  const cornerLum = [0, 0, 0, 0];
  const cornerN = [0, 0, 0, 0];

  for (let y = 1; y < gh - 1; y++) {
    const ny = (y / (gh - 1)) * 2 - 1;
    for (let x = 1; x < gw - 1; x++) {
      const nx = (x / (gw - 1)) * 2 - 1;
      const r2 = nx * nx + ny * ny;
      const k = y * gw + x;
      const c = lum[k];
      const quad = (nx < 0 ? 0 : 1) + (ny < 0 ? 0 : 2);
      if (r2 > 0.2 && r2 < 0.55) {
        ringLum[quad] += c;
        ringN[quad]++;
      } else if (r2 > 1.25) {
        cornerLum[quad] += c;
        cornerN[quad]++;
      }

      const gx = Math.abs(lum[k + 1] - lum[k - 1]) * 0.5;
      const gy = Math.abs(lum[k + gw] - lum[k - gw]) * 0.5;
      const grad = Math.hypot(gx, gy);
      const lap = Math.abs(4 * c - lum[k - 1] - lum[k + 1] - lum[k - gw] - lum[k + gw]);
      gradSum += grad;
      lapSum += lap;
      if (count % 4 === 0) grads.push(grad);
      count++;

      const macroGrad = Math.hypot(soft[k + 1] - soft[k - 1], soft[k + gw] - soft[k - gw]);
      if (macroGrad < 0.035 && c > 0.08 && c < 0.92) flats.push(Math.abs(c - soft[k]));

      // Halation is light spilling past a highlight into darker surroundings.
      // Measuring "large bright areas" instead made every white-background
      // frame glow, which is what smeared the reference filters.
      gradMap[k] = grad;

      const spill = wide[k] - soft[k];
      if (spill > 0.02 && c > 0.04 && c < 0.93) {
        halo += Math.min(0.4, spill) * (1 - 0.7 * Math.abs(c - 0.45));
      }
      if (c > 0.94) specular++;
    }
  }

  const meanGrad = count ? gradSum / count : 0;
  const meanLap = count ? lapSum / count : 0;

  // Crispness comes from the strongest edges in the frame, not the average
  // gradient: a portrait with big flat areas still has crisp edges, and only a
  // frame whose edges are genuinely soft should read as blurred.
  grads.sort((a, b) => a - b);
  const p98 = grads.length ? grads[Math.min(grads.length - 1, Math.round(grads.length * 0.98))] : 0;
  const sharpness = clamp(p98 / 0.24, 0, 1);

  // Acutance on real edges only: compare the gradient at pixel scale with the
  // gradient of that same edge once it is softened. Both are measured on the
  // strongest edges, so flat sky, white backdrops and halftone dots cannot
  // decide whether a frame is sharp.
  const edgeCut = grads.length ? grads[Math.min(grads.length - 1, Math.round(grads.length * 0.75))] : 0;
  let fineSum = 0;
  let coarseSum = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const k = y * gw + x;
      if (gradMap[k] < edgeCut) continue;
      fineSum += gradMap[k];
      coarseSum += Math.hypot(soft[k + 1] - soft[k - 1], soft[k + gw] - soft[k - gw]) * 0.5;
    }
  }
  // Photographic edges are gradual at pixel scale, so this ratio sits near 1 on
  // almost everything. Only the softest frames get any blur at all, and the
  // amount is capped: these files cannot resolve defocus finely enough to
  // justify smearing a sharp photo.
  const fine = coarseSum > 1e-6 ? fineSum / coarseSum : 1;
  const blur = clamp((1.45 - fine) / 0.45, 0, 1) * 0.3;
  const medFlat = flats.length > 24 ? median(flats) : 0;
  const grain = clamp((medFlat - 0.0055) / 0.028, 0, 1);
  const glow = clamp((count ? halo / count : 0) * 5.5, 0, 1);

  // A vignette darkens all four corners against the middle. A bright subject
  // or a sky darkens one or two, so the weakest corner decides. The shader's
  // vignette takes 0.55 × its amount off a corner.
  let fall = 1;
  for (let qd = 0; qd < 4; qd++) {
    const ring = ringN[qd] ? ringLum[qd] / ringN[qd] : 0;
    const corner = cornerN[qd] ? cornerLum[qd] / cornerN[qd] : ring;
    fall = Math.min(fall, ring > 0.08 ? 1 - corner / ring : 0);
  }
  const vignette = clamp((fall - 0.06) / 0.55, 0, 1);

  /* skin: is the texture of the skin visible, or does the light gloss it over? */
  const skinLaps = [];
  const skinLs = [];
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const k = y * gw + x;
      const c = lum[k];
      if (warmth[k] > 0.05 && warmth[k] < 0.36 && c > 0.24 && c < 0.92) {
        skinLaps.push(Math.abs(4 * c - lum[k - 1] - lum[k + 1] - lum[k - gw] - lum[k + gw]));
        skinLs.push(c);
      }
    }
  }
  const at = (arr, p) => arr[Math.min(arr.length - 1, Math.round(p * (arr.length - 1)))];
  let skinDetail = 0.5;
  let skinGloss = 0.3;
  if (skinLaps.length > n * 0.01) {
    skinLaps.sort((a, b) => a - b);
    skinLs.sort((a, b) => a - b);
    skinDetail = clamp(at(skinLaps, 0.5) / 0.018, 0, 1);
    skinGloss = clamp((at(skinLs, 0.97) - at(skinLs, 0.5)) / 0.26, 0, 1) * (1 - skinDetail * 0.45);
  }

  /* light: hard light has crisp falloff and speculars; soft light has neither */
  const specFrac = count ? specular / count : 0;
  const hardness = clamp(0.55 * clamp(p98 / 0.16, 0, 1) + 0.45 * clamp(specFrac / 0.05, 0, 1), 0, 1);

  return {
    blur: r3(blur),
    glow: r3(glow),
    grain: r3(grain),
    vignette: r3(vignette),
    sharpness: r3(sharpness),
    fine: r3(fine),
    specular: r3(specFrac),
    hardness: r3(hardness),
    skinDetail: r3(skinDetail),
    skinGloss: r3(skinGloss),
  };
}

/* Palette extraction: greedy clustering in plain RGB. The count is what the
   filter is allowed to carry — a photo with two colours gets two, not six. */
function extractPalette(px, width, height) {
  const step = Math.max(1, Math.round(Math.sqrt((width * height) / 12000)));
  const clusters = [];
  const MERGE = 0.07;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      if (px[i + 3] < 250) continue;
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      let best = null;
      let bestD = 1e9;
      for (const cl of clusters) {
        const d = (cl.r - r) ** 2 + (cl.g - g) ** 2 + (cl.b - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = cl;
        }
      }
      if (best && bestD < MERGE * MERGE) {
        const nn = best.n + 1;
        best.r += (r - best.r) / nn;
        best.g += (g - best.g) / nn;
        best.b += (b - best.b) / nn;
        best.n = nn;
      } else if (clusters.length < 16) {
        clusters.push({ r, g, b, n: 1 });
      } else if (best) {
        best.n++;
      }
    }
  }
  const total = clusters.reduce((s, c) => s + c.n, 0) || 1;
  const out = [];
  for (const c of clusters.sort((a, b) => b.n - a.n)) {
    const share = c.n / total;
    if (share < 0.04) continue;
    if (out.some((o) => Math.hypot(o.r - c.r, o.g - c.g, o.b - c.b) < 0.09)) continue;
    out.push({
      hex: `#${[c.r, c.g, c.b].map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('')}`,
      r: r3(c.r),
      g: r3(c.g),
      b: r3(c.b),
      share: r3(share),
    });
    if (out.length >= 6) break;
  }
  if (!out.length) out.push({ hex: '#808080', r: 0.5, g: 0.5, b: 0.5, share: 1 });
  return out;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/* ---------- style naming ---------- */
function classify(info) {
  const { q, casts, meanChroma, mono, blackFloor, whiteCeiling, texture, skin, sky } = info;
  const tags = [];
  const range = q[30] - q[2];
  const mid = q[16];
  const midB = casts[2][1];
  const shadowB = casts[0][1];
  const highB = casts[4][1];
  let name = 'Custom colour grade';

  if (mono.pure) {
    name = range > 0.74 ? 'High-contrast noir' : blackFloor > 0.07 ? 'Matte silver print' : 'Classic silver B&W';
    tags.push('Black & white');
  } else if (mono.tinted) {
    const hue = deg(Math.atan2(mono.tint[1], mono.tint[0]));
    if (hue >= 35 && hue <= 105) {
      name = 'Warm sepia mono';
      tags.push('Sepia');
    } else if (hue >= 180 && hue <= 270) {
      name = 'Cool cyanotype mono';
      tags.push('Cyanotype');
    } else {
      name = 'Tinted monochrome';
      tags.push('Tinted mono');
    }
  } else if (midB > 8 && (texture.blur > 0.18 || texture.glow > 0.25)) {
    name = 'Y2K dream warm';
    tags.push('Y2K aesthetic');
  } else if (shadowB < -3 && highB > 4) {
    name = 'Cinema teal & orange';
    tags.push('Teal & orange');
  } else if (blackFloor > 0.07 && meanChroma < 18) {
    name = 'Faded analogue film';
    tags.push('Faded film');
  } else if (midB > 6) {
    name = 'Golden warm grade';
    tags.push('Warm golden');
  } else if (midB < -6) {
    name = 'Cool mood grade';
    tags.push('Cool mood');
  } else if (meanChroma > 32) {
    name = 'Vivid chromatic pop';
    tags.push('Vivid');
  }

  if (range < 0.62) tags.push('Soft contrast');
  else if (range > 0.86) tags.push('Punchy');
  else tags.push('Balanced contrast');
  if (blackFloor > 0.065) tags.push('Lifted blacks');
  if (whiteCeiling < 0.91) tags.push('Soft highlights');
  if (mid < 0.36) tags.push('Low-key');
  else if (mid > 0.64) tags.push('High-key');

  if (!mono.present) {
    const [ca, cb] = casts[2];
    if (Math.hypot(ca, cb) >= 3) {
      if (Math.abs(cb) >= Math.abs(ca)) tags.push(cb > 0 ? 'Amber cast' : 'Blue cast');
      else tags.push(ca > 0 ? 'Rose cast' : 'Green cast');
    } else tags.push('Neutral balance');
  }

  if (skin.present) tags.push('Skin tone');
  if (sky.present) tags.push('Sky');
  if (texture.blur > 0.15) tags.push('Soft focus');
  if (texture.glow > 0.22) tags.push('Halation');
  if (texture.grain > 0.18) tags.push('Grain');
  if (texture.vignette > 0.18) tags.push('Vignette');

  return { name, tags: tags.slice(0, 7) };
}

/* ---------- main ---------- */
export function analyze(source, { optics = true } = {}) {
  // Letterbox bars are a frame around the picture, not part of its tone: read
  // the picture inside them, and remember the shape.
  const bars = findBars(source.data, source.width, source.height);
  const image = crop(source, bars);
  const px = image.data;
  const width = image.width;
  const height = image.height;
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / 45000));

  const Ls = [];
  const As = [];
  const Bs = [];
  const samples = { r: [], g: [], b: [] };

  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (px[i + 3] < 250) continue;
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const [l, a, bb] = rgbToLab([r, g, b]);
    Ls.push(l);
    As.push(a);
    Bs.push(bb);
    if (samples.r.length < 1600) {
      samples.r.push(r);
      samples.g.push(g);
      samples.b.push(b);
    }
  }
  if (Ls.length < 16) throw new Error('That frame has too few visible pixels to read.');

  const sortedL = Float32Array.from(Ls).sort();
  const quantile = (arr, p) => {
    const x = clamp(p) * (arr.length - 1);
    const i = Math.floor(x);
    const t = x - i;
    return arr[i] * (1 - t) + arr[Math.min(arr.length - 1, i + 1)] * t;
  };
  const q = new Float32Array(33);
  for (let i = 0; i <= 32; i++) q[i] = quantile(sortedL, i / 32) / 100;

  const chromas = new Float32Array(Ls.length);
  let chromaSum = 0;
  for (let i = 0; i < Ls.length; i++) {
    chromas[i] = Math.hypot(As[i], Bs[i]);
    chromaSum += chromas[i];
  }
  const meanChroma = chromaSum / Ls.length;
  const sortedChroma = chromas.slice().sort();
  const chroma90 = quantile(sortedChroma, 0.9);

  /* split-tone bands */
  const buckets = [[], [], [], [], []];
  for (let i = 0; i < Ls.length; i++) {
    const l = Ls[i];
    buckets[l < BAND_EDGES[0] ? 0 : l < BAND_EDGES[1] ? 1 : l < BAND_EDGES[2] ? 2 : l < BAND_EDGES[3] ? 3 : 4].push(i);
  }
  const medianAB = (idx) => {
    if (!idx.length) return [0, 0];
    return [median(idx.map((i) => As[i])), median(idx.map((i) => Bs[i]))];
  };
  const casts = buckets.map((idx) => {
    const neutral = idx.filter((i) => {
      const c = Math.hypot(As[i], Bs[i]);
      const h = deg(Math.atan2(Bs[i], As[i]));
      return c < 12 && !(h > 200 && h < 300);
    });
    return medianAB(neutral.length >= 24 ? neutral : idx);
  });

  /* monochrome detection */
  const allAB = [];
  for (let i = 0; i < Ls.length; i += 3) allAB.push([As[i], Bs[i]]);
  const medA = median(allAB.map((p) => p[0]));
  const medB = median(allAB.map((p) => p[1]));
  const spread =
    allAB.length > 0
      ? Math.hypot(
          median(allAB.map((p) => Math.abs(p[0] - medA))),
          median(allAB.map((p) => Math.abs(p[1] - medB)))
        )
      : 0;
  const pure = chroma90 < 4.2 && meanChroma < 2.8;
  // Tight enough that a saturated two-colour poster (a pink figure on black)
  // is not mistaken for a tinted black-and-white photograph — and that a muted
  // colour photo (brown rock, pale sky) is not either: in a toned print almost
  // every pixel sits on the one tint.
  // Hue coherence: how much of the picture's colour points one way (1 = all
  // of it). A toned print is one hue at every brightness; a muted photo is
  // brown rock against blue sky.
  let sa = 0;
  let sb = 0;
  let sc = 0;
  for (let i = 0; i < Ls.length; i += 2) {
    const c = chromas[i];
    if (c < 2) continue;
    sa += As[i];
    sb += Bs[i];
    sc += c;
  }
  const coherence = sc > 0 ? Math.hypot(sa, sb) / sc : 0;
  // ...and in a toned print the tint depends on brightness alone: take out
  // the mean tint at each brightness and almost nothing is left, while a warm
  // colour photo still has objects of different colour at the same brightness.
  const binA = new Float32Array(10);
  const binB = new Float32Array(10);
  const binN = new Float32Array(10);
  const binOf = (l) => Math.min(9, Math.max(0, Math.floor(l / 10)));
  for (let i = 0; i < Ls.length; i += 2) {
    const k = binOf(Ls[i]);
    binA[k] += As[i];
    binB[k] += Bs[i];
    binN[k]++;
  }
  const resid = [];
  for (let i = 0; i < Ls.length; i += 4) {
    const k = binOf(Ls[i]);
    if (binN[k] < 8 || Ls[i] < 12) continue;
    resid.push(Math.hypot(As[i] - binA[k] / binN[k], Bs[i] - binB[k] / binN[k]));
  }
  const toneResidual = resid.length ? median(resid) : 99;
  // bench probe: real sepia prints (Pinterest) coherence ≥0.99 with residual
  // 1.1–2.3, synthetic toning 0.4–0.7; golden-hour colour photos residual ≥3.2;
  // Polaroid/Portra coherence ≤0.91. Real prints carry a strong tint, hence
  // the generous chroma cap.
  // In between (a hazy, heavily warmed photo reads the same as a stained
  // print) the look keeps a little colour instead of going all-or-nothing.
  const toned = !pure && chroma90 < 45 && coherence > 0.985;
  const tinted = toned && toneResidual < 1.6;
  const nearMono = toned && !tinted && toneResidual < 2.6;
  const mono = {
    present: pure || tinted,
    pure,
    tinted,
    near: nearMono,
    coherence: r3(coherence),
    toneResidual: r3(toneResidual),
    tint: pure ? [0, 0] : [medA, medB],
  };

  /* hue wheel */
  const wheel = Array.from({ length: SECTOR_COUNT }, () => ({ a: [], b: [], l: [], c: [], n: 0, rgb: null }));
  for (let i = 0; i < Ls.length; i++) {
    const c = chromas[i];
    if (c < 5) continue;
    const h = deg(Math.atan2(Bs[i], As[i]));
    let best = 0;
    let bestD = 999;
    for (let s = 0; s < SECTOR_COUNT; s++) {
      const d = Math.abs(angleDelta(h, SECTOR_CENTERS[s]));
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    const sec = wheel[best];
    sec.a.push(As[i]);
    sec.b.push(Bs[i]);
    sec.l.push(Ls[i]);
    sec.c.push(c);
    sec.n++;
  }
  const hueSectors = wheel.map((sec, i) => {
    const share = sec.n / Ls.length;
    if (!sec.n || share < 0.012) {
      return { center: SECTOR_CENTERS[i], present: false, share: 0, ab: [0, 0], L: 50, chroma: 0 };
    }
    return {
      center: SECTOR_CENTERS[i],
      present: true,
      share,
      ab: [median(sec.a), median(sec.b)],
      L: median(sec.l),
      chroma: median(sec.c),
    };
  });

  /* skin: compact hue/chroma region at any lightness — deep brown to pale
     skin share a hue band; only how light it is differs */
  const skinHits = [];
  for (let i = 0; i < Ls.length; i += 2) {
    const c = chromas[i];
    const h = deg(Math.atan2(Bs[i], As[i]));
    if (h >= 30 && h <= 80 && c >= 6 && c <= 45 && Ls[i] >= 10 && Ls[i] <= 94) skinHits.push(i);
  }
  let skin = { present: false };
  if (!mono.present && skinHits.length / Ls.length >= 0.012) {
    const ab = [median(skinHits.map((i) => As[i])), median(skinHits.map((i) => Bs[i]))];
    const s =
      Math.hypot(
        median(skinHits.map((i) => Math.abs(As[i] - ab[0]))),
        median(skinHits.map((i) => Math.abs(Bs[i] - ab[1])))
      ) || 0;
    if (s < 12) {
      // how the light falls on it: skin colour in lightness bands, shadow
      // side to lit side
      const edges = [10, 25, 40, 55, 70, 85, 101];
      const bands = edges.slice(0, -1).map(() => ({ a: 0, b: 0, l: 0, n: 0 }));
      for (const i of skinHits) {
        const k = edges.findIndex((e, j) => Ls[i] >= e && Ls[i] < edges[j + 1]);
        if (k < 0) continue;
        bands[k].a += As[i];
        bands[k].b += Bs[i];
        bands[k].l += Ls[i];
        bands[k].n++;
      }
      skin = {
        present: true,
        ab,
        L: median(skinHits.map((i) => Ls[i])),
        share: skinHits.length / Ls.length,
        bands: bands.map((b) => (b.n >= 12 ? { L: r3(b.l / b.n), a: r3(b.a / b.n), b: r3(b.b / b.n), n: b.n } : null)),
      };
    }
  }

  /* sky: blue-cyan pixels in the upper half of the frame */
  const skyHits = [];
  for (let p = 0; p < total; p += stride * 2) {
    const i = p * 4;
    if (px[i + 3] < 250) continue;
    const row = Math.floor(p / width);
    if (row > height * 0.55) continue;
    const lab = rgbToLab([px[i] / 255, px[i + 1] / 255, px[i + 2] / 255]);
    const c = Math.hypot(lab[1], lab[2]);
    const h = deg(Math.atan2(lab[2], lab[1]));
    if (c >= 4.5 && h >= 200 && h <= 300 && lab[0] >= 38) skyHits.push(lab);
  }
  let sky = { present: false };
  if (!mono.present && skyHits.length >= 60 && skyHits.length / Math.max(1, Ls.length / 2) >= 0.02) {
    sky = {
      present: true,
      ab: [median(skyHits.map((p) => p[1])), median(skyHits.map((p) => p[2]))],
      L: median(skyHits.map((p) => p[0])),
      share: skyHits.length / Ls.length,
    };
  }

  /* hue distribution (chroma-weighted, 10° bins) and chroma per lightness band:
     what colours the picture is allowed to have, and how loud each one is */
  const hueDensity = new Float32Array(HUE_BINS);
  const hueChromaSum = new Float32Array(HUE_BINS);
  const hueCount = new Float32Array(HUE_BINS);
  const bandC = new Float32Array(5);
  const bandN = new Float32Array(5);
  for (let i = 0; i < Ls.length; i++) {
    const c = chromas[i];
    const l = Ls[i];
    const band = l < BAND_EDGES[0] ? 0 : l < BAND_EDGES[1] ? 1 : l < BAND_EDGES[2] ? 2 : l < BAND_EDGES[3] ? 3 : 4;
    bandC[band] += c;
    bandN[band]++;
    if (c < 4) continue;
    const bin = Math.floor(deg(Math.atan2(Bs[i], As[i])) / (360 / HUE_BINS)) % HUE_BINS;
    hueDensity[bin] += Math.min(c, 45);
    hueChromaSum[bin] += c;
    hueCount[bin]++;
  }
  const hueTotal = hueDensity.reduce((s, v) => s + v, 0);
  const hueChroma = Array.from(hueChromaSum, (s, i) => (hueCount[i] ? r3(s / hueCount[i]) : 0));
  const bandChroma = Array.from(bandC, (s, i) => (bandN[i] >= 20 ? r3(s / bandN[i]) : meanChroma));

  const texture = { ...analyzeTexture(px, width, height), ...(optics ? measureOptics(image) : {}), letterbox: bars.letterbox };
  if (optics) texture.levels = texture.posterize ? r3(clamp((18 - texture.posterize) / 14)) : 0;
  const palette = extractPalette(px, width, height);
  const paletteSize = palette.length;
  const traits = {
    light: texture.hardness >= 0.5 ? 'hard' : 'soft',
    hardness: texture.hardness,
    skinDetail: texture.skinDetail,
    skinGloss: texture.skinGloss,
    skyBlue: sky.present ? r3(clamp((-sky.ab[1] - 4) / 22, 0, 1)) : 0,
    skyBright: sky.present ? r3(clamp(sky.L / 100, 0, 1)) : 0,
    paletteSize,
  };
  const blackFloor = q[0];
  const whiteCeiling = q[32];
  const style = classify({ q, casts, meanChroma, mono, blackFloor, whiteCeiling, texture, skin, sky });

  return {
    q,
    casts,
    chroma: meanChroma,
    chroma90,
    range: q[30] - q[2],
    blackFloor,
    whiteCeiling,
    mono,
    hueSectors,
    skin,
    sky,
    texture,
    style,
    hueDensity: Array.from(hueDensity, (v) => r3(hueTotal > 0 ? v / hueTotal : 0)),
    hueChroma,
    bandChroma,
    samples: Ls.length,
    swatches: palette.slice(0, 4).map((p) => p.hex),
    palette,
    paletteSize,
    traits,
  };
}

function buildSwatches(hueSectors, skin, sky) {
  const out = [];
  const push = (lab) => {
    if (out.length >= 6 || !lab) return;
    out.push(`hsl(${Math.round(deg(Math.atan2(lab[1], lab[0])))}, ${Math.round(
      clamp(Math.hypot(lab[1], lab[2]) / 45) * 55
    )}%, ${Math.round(clamp(0.16 + (lab[0] / 100) * 0.7) * 100)}%)`);
  };
  hueSectors
    .filter((s) => s.present && s.share >= 0.03)
    .sort((a, b) => b.share - a.share)
    .slice(0, 4)
    .forEach((s) => push(s.ab));
  if (skin.present) push(skin.ab);
  if (sky.present) push(sky.ab);
  return out;
}

/* ---------- averaging ---------- */
const meanOf = (list, get) => list.reduce((sum, item) => sum + get(item), 0) / list.length;

export function combine(profiles) {
  const list = profiles.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0], references: 1 };

  const q = new Float32Array(33);
  for (let i = 0; i <= 32; i++) q[i] = meanOf(list, (p) => p.q[i]);
  const casts = Array.from({ length: 5 }, (_, band) => [
    meanOf(list, (p) => p.casts[band][0]),
    meanOf(list, (p) => p.casts[band][1]),
  ]);
  const hueSectors = SECTOR_CENTERS.map((center, i) => {
    const present = list.map((p) => p.hueSectors[i]).filter((s) => s && s.present);
    if (!present.length) return { center, present: false, share: 0, ab: [0, 0], L: 50, chroma: 0 };
    return {
      center,
      present: true,
      share: meanOf(present, (s) => s.share),
      ab: [meanOf(present, (s) => s.ab[0]), meanOf(present, (s) => s.ab[1])],
      L: meanOf(present, (s) => s.L),
      chroma: meanOf(present, (s) => s.chroma),
    };
  });

  const monoList = list.filter((p) => p.mono.present);
  const pureCount = monoList.filter((p) => p.mono.pure).length;
  const isMono = monoList.length > list.length / 2;
  const isPure = isMono && pureCount > list.length / 2;
  const mono = {
    present: isMono,
    pure: isPure,
    tinted: isMono && !isPure,
    near: !isMono && list.filter((p) => p.mono.near).length * 2 > list.length,
    tint: isMono && !isPure
      ? [meanOf(monoList, (p) => p.mono.tint[0]), meanOf(monoList, (p) => p.mono.tint[1])]
      : [0, 0],
  };

  const mergeRegion = (key) => {
    const present = list.map((p) => p[key]).filter((r) => r && r.present);
    if (!present.length) return { present: false };
    const out = {
      present: true,
      ab: [meanOf(present, (r) => r.ab[0]), meanOf(present, (r) => r.ab[1])],
      L: meanOf(present, (r) => r.L),
      share: meanOf(present, (r) => r.share || 0),
    };
    if (present.some((r) => r.bands)) {
      out.bands = [0, 1, 2, 3, 4, 5].map((k) => {
        const got = present.map((r) => r.bands && r.bands[k]).filter(Boolean);
        const n = got.reduce((s, g) => s + g.n, 0);
        if (!n) return null;
        const wsum = (f) => got.reduce((s, g) => s + f(g) * g.n, 0) / n;
        return { L: wsum((g) => g.L), a: wsum((g) => g.a), b: wsum((g) => g.b), n };
      });
    }
    return out;
  };

  const chroma = meanOf(list, (p) => p.chroma);
  // every measured trait, averaged (frames of one clip, or the base of a merge)
  const texture = {};
  // (a clip measures its optics on some frames only: average over those)
  const keys = new Set(list.flatMap((p) => Object.keys(p.texture)));
  for (const key of keys) {
    const has = list.filter((p) => typeof p.texture[key] === 'number');
    if (has.length) texture[key] = meanOf(has, (p) => p.texture[key]);
  }
  // bars and blocks are a frame's shape, not an amount: keep the common one
  for (const key of ['letterbox', 'block', 'posterize']) {
    const measured = list.filter((p) => typeof p.texture[key] === 'number');
    const vals = measured.map((p) => p.texture[key]).filter(Boolean);
    texture[key] = vals.length * 2 > measured.length ? vals.sort((a, b) => a - b)[vals.length >> 1] : 0;
  }
  const blackFloor = meanOf(list, (p) => p.blackFloor);
  const whiteCeiling = meanOf(list, (p) => p.whiteCeiling);
  const skin = mergeRegion('skin');
  const sky = mergeRegion('sky');
  const style = classify({
    q,
    casts,
    meanChroma: chroma,
    mono,
    blackFloor,
    whiteCeiling,
    texture,
    skin,
    sky,
  });

  const palette = [];
  for (const p of list) {
    for (const sw of p.palette || []) {
      if (palette.length >= 4) break;
      if (palette.some((o) => Math.hypot(o.r - sw.r, o.g - sw.g, o.b - sw.b) < 0.1)) continue;
      palette.push(sw);
    }
  }
  const paletteSize = palette.length || 2;
  const traits = {
    light: texture.hardness >= 0.5 ? 'hard' : 'soft',
    hardness: meanOf(list, (p) => (p.traits ? p.traits.hardness : 0.5)),
    skinDetail: meanOf(list, (p) => (p.traits ? p.traits.skinDetail : 0.5)),
    skinGloss: meanOf(list, (p) => (p.traits ? p.traits.skinGloss : 0.3)),
    skyBlue: meanOf(list, (p) => (p.traits ? p.traits.skyBlue : 0)),
    skyBright: meanOf(list, (p) => (p.traits ? p.traits.skyBright : 0)),
    paletteSize,
  };

  return {
    q,
    casts,
    chroma,
    hueDensity: list[0].hueDensity ? list[0].hueDensity.map((_, k) => meanOf(list, (p) => (p.hueDensity ? p.hueDensity[k] : 0))) : null,
    hueChroma: list[0].hueChroma ? list[0].hueChroma.map((_, k) => meanOf(list, (p) => (p.hueChroma ? p.hueChroma[k] : 0))) : null,
    bandChroma: list[0].bandChroma ? [0, 1, 2, 3, 4].map((k) => meanOf(list, (p) => (p.bandChroma ? p.bandChroma[k] : p.chroma))) : null,
    chroma90: meanOf(list, (p) => p.chroma90),
    range: q[30] - q[2],
    blackFloor,
    whiteCeiling,
    mono,
    hueSectors,
    skin,
    sky,
    texture,
    style,
    swatches: palette.map((p) => p.hex),
    palette,
    paletteSize,
    traits,
    samples: list.reduce((n, p) => n + (p.samples || 0), 0),
    references: list.length,
  };
}

/** Analyze a canvas / video frame source. */
export function analyzeSource(source) {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 1100 / Math.max(source.width, source.height));
  c.width = Math.max(1, Math.round(source.width * scale));
  c.height = Math.max(1, Math.round(source.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { profile: analyze(ctx.getImageData(0, 0, c.width, c.height)), canvas: c };
}

export { smoothstep, luma };
