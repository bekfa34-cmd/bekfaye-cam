/* Capture optics.
   What the camera, tape or file did to a picture, measured so the shader can
   do it again: resolution (horizontal and vertical), chroma bleed, colour
   channel shift and lens fringing, scanlines, noise (amount, colour, size),
   pixel blocks, posterized levels and letterbox bars.

   Sizes are fractions of the frame (height, or width for horizontal shifts),
   so a look measured on a 1400 px reference lands the same on a 4K recording. */

const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
const r4 = (v) => Math.round(v * 10000) / 10000;

/* ---------- planes ---------- */
const planesG = (px) => {
  const G = new Float32Array(px.length / 4);
  for (let k = 0, i = 1; k < G.length; k++, i += 4) G[k] = px[i] / 255;
  return G;
};
function planes(px, w, h) {
  const n = w * h;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const B = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let k = 0, i = 0; k < n; k++, i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    L[k] = y;
    R[k] = r;
    B[k] = b;
    Cb[k] = (b - y) * 0.539;
    Cr[k] = (r - y) * 0.635;
  }
  return { L, R, B, Cb, Cr };
}

/* 1D box blur along x (horizontal) or y. */
function blur1(src, w, h, r, horizontal) {
  if (r < 1) return src;
  const out = new Float32Array(src.length);
  const span = 2 * r + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[o + clamp(i, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        out[o + x] = s / span;
        s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / span;
        s += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}
const blur2 = (src, w, h, r) => blur1(blur1(src, w, h, r, true), w, h, r, false);

function quantile(arr, p) {
  if (!arr.length) return 0;
  const s = Float32Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/* ---------- borders and letterbox ---------- */
/** The picture inside any border. Black edges (bars, a screenshot's pillars,
    a scan's frame) are cut on any side; a light frame (an instant print) only
    when it runs round at least three sides, so an overcast sky is not cut.
    Even black bars top and bottom are also a style: the letterbox. */
export function findBars(px, w, h) {
  const line = (horizontal, i, from, to) => {
    let sum = 0;
    let sq = 0;
    let max = 0;
    let lit = 0;
    let n = 0;
    for (let j = from; j < to; j += 2) {
      const k = (horizontal ? i * w + j : j * w + i) * 4;
      const v = (px[k] + px[k + 1] + px[k + 2]) / 765;
      sum += v;
      sq += v * v;
      if (v > max) max = v;
      if (v > 0.12) lit++;
      n++;
    }
    lit /= Math.max(1, n);
    const mean = n ? sum / n : 0;
    return { mean, sd: Math.sqrt(Math.max(0, sq / Math.max(1, n) - mean * mean)), max, lit };
  };
  // A border is flat (encoded black, or an even paper white) and ends at a
  // hard edge; a dark backdrop or a black night sky is neither.
  const dark = (l) => l.mean < 0.035 && l.max < 0.1;
  const light = (l) => l.mean > 0.82 && l.sd < 0.04;
  const run = (test, horizontal, fromEnd, limit, from, to) => {
    const at = (k) => line(horizontal, fromEnd ? (horizontal ? h : w) - 1 - k : k, from, to);
    let k = 0;
    while (k < limit && test(at(k))) k++;
    if (!k) return 0;
    const edge = at(Math.min(k + 1, limit));
    const bar = at(k - 1);
    return Math.abs(edge.mean - bar.mean) > 0.04 ? k : 0;
  };
  const top = run(dark, true, false, h * 0.4, 0, w);
  const bottom = run(dark, true, true, h * 0.4, 0, w);
  const y0d = top >= h * 0.02 ? top : 0;
  const y1d = bottom >= h * 0.02 ? h - bottom : h;
  const left = run(dark, false, false, w * 0.4, y0d, y1d);
  const right = run(dark, false, true, w * 0.4, y0d, y1d);
  let x0 = left >= w * 0.02 ? left : 0;
  let x1 = right >= w * 0.02 ? w - right : w;
  let y0 = y0d;
  let y1 = y1d;
  // light frame: needs three sides
  const lt = run(light, true, false, h * 0.3, x0, x1);
  const lb = run(light, true, true, h * 0.3, x0, x1);
  const ll = run(light, false, false, w * 0.3, y0, y1);
  const lr = run(light, false, true, w * 0.3, y0, y1);
  const sides = [lt >= h * 0.02, lb >= h * 0.02, ll >= w * 0.02, lr >= w * 0.02];
  if (sides.filter(Boolean).length >= 3) {
    if (sides[0]) y0 += lt;
    if (sides[1]) y1 -= lb;
    if (sides[2]) x0 += ll;
    if (sides[3]) x1 -= lr;
  }
  if (x1 - x0 < w * 0.3 || y1 - y0 < h * 0.3) return { x0: 0, y0: 0, x1: w, y1: h, letterbox: 0 };
  // Letterbox as a style needs real bars: even, and the picture starts across
  // the whole width (most of the first row inside is lit), not a dark scene.
  const litAt = (y) => line(true, y, 0, w).lit;
  const barred = top >= h * 0.04 && bottom >= h * 0.04 && Math.abs(top - bottom) < Math.max(top, bottom) * 0.5 && left < w * 0.02 && right < w * 0.02 &&
    litAt(Math.min(h - 1, top + 2)) > 0.5 && litAt(Math.max(0, h - 1 - bottom - 2)) > 0.5;
  const aspect = (x1 - x0) / Math.max(1, y1 - y0);
  // Film stills are often shared already cropped to the wide frame: a picture
  // that is itself cinema-wide (2:1 to 2.8:1) carries the letterbox too.
  const wide = !barred && aspect >= 1.95 && aspect <= 2.8;
  return { x0, y0, x1, y1, letterbox: (barred && aspect > 1.7) || wide ? Math.round(aspect * 100) / 100 : 0 };
}

export function crop(image, box) {
  const { x0, y0, x1, y1 } = box;
  if (x0 === 0 && y0 === 0 && x1 === image.width && y1 === image.height) return image;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y + y0) * image.width + x0) * 4;
    data.set(image.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { data, width: w, height: h };
}

/* ---------- resolution ---------- */
/* How wide an edge is. A gaussian-blurred step of width s has a gradient peak
   proportional to 1/s; blurring it again by a known box widens it to
   sqrt(s² + box²), so the drop in the peak gives s back. */
function edgeSigma(P0, w, h, horizontal, pick = 0.02, minGrad = 0.02) {
  const step = horizontal ? 1 : w;
  // Average along the edge, never across it: noise drops, the edge profile stays.
  const P = blur1(P0, w, h, 2, !horizontal);
  const coarse = blur2(P, w, h, 2);
  const cands = [];
  const strength = [];
  // every other row and column: a quarter of the work, the same edge statistics
  for (let y = 3; y < h - 3; y += 2) {
    for (let x = 3; x < w - 3; x += 2) {
      const k = y * w + x;
      const ga = Math.abs(coarse[k + step] - coarse[k - step]);
      const gb = Math.abs(horizontal ? coarse[k + w] - coarse[k - w] : coarse[k + 1] - coarse[k - 1]);
      if (ga < 2 * gb || ga < minGrad) continue;
      // centre of the edge along the axis
      if (ga < Math.abs(coarse[k + 2 * step] - coarse[k]) || ga < Math.abs(coarse[k] - coarse[k - 2 * step])) continue;
      cands.push(k);
      strength.push(ga);
    }
  }
  if (cands.length < 60) return null;
  const cut = quantile(strength, 1 - Math.min(0.5, Math.max(pick, 300 / cands.length)));
  const edges = cands.filter((_, i) => strength[i] >= cut);
  const grad = (A, k) => {
    // the peak may sit a pixel either side of the coarse centre
    let best = 0;
    for (let d = -1; d <= 1; d++) {
      const j = k + d * step;
      const g = Math.abs(A[j + step] - A[j - step]) * 0.5;
      if (g > best) best = g;
    }
    return best;
  };
  let g0 = 0;
  for (const k of edges) g0 += grad(P, k);
  if (g0 <= 1e-6) return null;
  const SD2 = 0.36; // the central difference itself spreads an ideal edge
  // Probe with growing blurs and read the first one that visibly lowers the
  // peak: too small a probe on a wide edge is all noise, too large a probe
  // starts merging neighbouring edges.
  const ests = [];
  for (const r of [1, 2, 3, 4, 6, 8, 12]) {
    const Br = blur1(P, w, h, r, horizontal);
    let gr = 0;
    for (const k of edges) gr += grad(Br, k);
    const rho = gr / g0;
    if (rho >= 0.9) continue;
    if (rho <= 0.12) break;
    const box2 = (r * (r + 1)) / 3;
    ests.push((box2 * rho * rho) / (1 - rho * rho));
    if (ests.length === 2) break;
  }
  if (!ests.length) return null;
  const s2 = ests.reduce((a, b) => a + b, 0) / ests.length;
  return Math.sqrt(Math.max(0, s2 - SD2));
}

/* ---------- channel shift ---------- */
/* Where the red channel's edges sit relative to blue's, left and right. */
function channelOffsets(R0, B0, L0, w, h) {
  const R = blur1(R0, w, h, 2, false);
  const B = blur1(B0, w, h, 2, false);
  const L = blur1(L0, w, h, 2, false);
  const G = (A, k) => A[k + 1] - A[k - 1];
  const region = (xa, xb) => {
    const cand = [];
    const str = [];
    for (let y = 2; y < h - 2; y += 1) {
      for (let x = Math.max(10, xa); x < Math.min(w - 10, xb); x++) {
        const k = y * w + x;
        const g = Math.abs(G(L, k));
        if (g > 0.04) {
          cand.push(k);
          str.push(g);
        }
      }
    }
    if (cand.length < 40) return null;
    const cut = quantile(str, 0.8);
    const edges = cand.filter((_, i) => str[i] >= cut);
    const corr = [];
    for (let d = -8; d <= 8; d++) {
      let s = 0;
      for (const k of edges) s += G(R, k) * G(B, k - d);
      corr.push(s);
    }
    let bi = 8;
    for (let i = 0; i < corr.length; i++) if (corr[i] > corr[bi]) bi = i;
    if (corr[bi] <= 0) return null;
    let off = bi - 8;
    if (bi > 0 && bi < corr.length - 1) {
      const a = corr[bi - 1];
      const b = corr[bi];
      const c = corr[bi + 1];
      const den = a - 2 * b + c;
      if (den < 0) off += clamp((0.5 * (a - c)) / den, -0.5, 0.5);
    }
    return off;
  };
  // Six strips across the frame; red-vs-blue offset in each, then a line
  // through them: the intercept is a sideways shift (tape, misregistration),
  // the slope is lens fringing (red out, blue in, growing to the edges).
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const off = region(Math.round((i * w) / 6), Math.round(((i + 1) * w) / 6));
    if (off != null) pts.push([((i + 0.5) / 6) * 2 - 1, off]);
  }
  if (pts.length < 4) return { shift: 0, fringe: 0 };
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) * (x - mx);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const shift = my - slope * mx;
  return {
    shift: Math.abs(shift) >= 0.6 ? shift / w : 0,
    // ×1.7: radial fringing reads low strip by strip (bench u_fringe: 3 px read as 1.8)
    fringe: slope >= 1 ? (slope * 1.7) / w : 0,
  };
}

/* ---------- periodic structure ---------- */
function acfPeak(signal, minLag, maxLag) {
  const n = signal.length;
  let mean = 0;
  for (const v of signal) mean += v;
  mean /= n;
  const d = Float32Array.from(signal, (v) => v - mean);
  let v0 = 0;
  for (const v of d) v0 += v * v;
  if (v0 <= 1e-12) return { lag: 0, value: 0, energy: 0 };
  let best = { lag: 0, value: 0 };
  const vals = [];
  for (let lag = 0; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += d[i] * d[i + lag];
    vals.push((s / v0) * (n / (n - lag)));
  }
  const peaks = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (vals[lag] > vals[lag - 1] && vals[lag] >= vals[lag + 1]) {
      // sub-sample peak
      const a = vals[lag - 1];
      const b = vals[lag];
      const c = vals[lag + 1];
      const den = a - 2 * b + c;
      const off = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
      peaks.push({ lag: lag + off, value: b });
    }
  }
  // A periodic signal peaks again at every multiple of its period: take the
  // first peak that is nearly as strong as the strongest.
  const top = peaks.reduce((m, p) => Math.max(m, p.value), 0);
  best = peaks.find((p) => p.value >= top * 0.85) || best;
  return { ...best, energy: v0 / n };
}

function highpass(signal, r) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(signal.length - 1, i + r); j++) {
      s += signal[j];
      n++;
    }
    out[i] = signal[i] - s / n;
  }
  return out;
}

/* Scanlines: a sharp line in the spectrum of the row brightness. Content has a
   broad spectrum; a raster leaves one spike (and its harmonics). */
function scanlines(L, w, h) {
  const rows = new Float32Array(h);
  let mean = 0;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += L[y * w + x];
    rows[y] = s / w;
    mean += rows[y];
  }
  mean /= h;
  const none = { scan: 0, scanPeriod: 0, rows: null };
  if (mean < 0.05 || h < 64) return none;
  const hp = highpass(rows, 8);
  const kMin = Math.max(2, Math.floor(h / 16));
  const kMax = Math.floor(h / 2);
  const power = new Float32Array(kMax + 1);
  for (let k = kMin; k <= kMax; k++) {
    let re = 0;
    let im = 0;
    const f = (2 * Math.PI * k) / h;
    for (let y = 0; y < h; y++) {
      re += hp[y] * Math.cos(f * y);
      im += hp[y] * Math.sin(f * y);
    }
    power[k] = re * re + im * im;
  }
  let kBest = kMin;
  for (let k = kMin; k <= kMax; k++) if (power[k] > power[kBest]) kBest = k;
  const around = [];
  for (let k = Math.max(kMin, kBest - 24); k <= Math.min(kMax, kBest + 24); k++) if (Math.abs(k - kBest) > 2) around.push(power[k]);
  const background = quantile(around, 0.5);
  if (!(power[kBest] > background * 30)) return none;
  // a pattern with sharp dark rows also peaks at half the frequency: that is the period
  let k = kBest;
  const half = Math.round(kBest / 2);
  if (half >= kMin && Math.max(power[half - 1] || 0, power[half], power[half + 1] || 0) > power[kBest] * 0.3) k = half;
  let p = 0;
  let pk = 0;
  for (let j = k - 1; j <= k + 1; j++) {
    if (j < kMin || j > kMax) continue;
    p += power[j];
    pk += power[j] * j;
  }
  // at the row Nyquist (alternate rows) the whole wave lands in the cosine term
  // A grid that repeats across the columns at the same period is pixel blocks
  // (or a halftone), not a raster of lines.
  const cols = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < h; y += 2) c += L[y * w + x];
    cols[x] = c;
  }
  const chp = highpass(cols, 8);
  const colPower = (period) => {
    const kc = w / period;
    let best = 0;
    const bg = [];
    for (let kk = Math.max(2, Math.floor(kc) - 20); kk <= Math.min(Math.floor(w / 2), Math.ceil(kc) + 20); kk++) {
      let re = 0;
      let im = 0;
      const f = (2 * Math.PI * kk) / w;
      for (let x = 0; x < w; x++) {
        re += chp[x] * Math.cos(f * x);
        im += chp[x] * Math.sin(f * x);
      }
      const pw = re * re + im * im;
      if (Math.abs(kk - kc) <= 1.5) best = Math.max(best, pw);
      else bg.push(pw);
    }
    return best / Math.max(1e-12, quantile(bg, 0.5));
  };
  if (colPower(h / k) > 30) return none;
  const amp = ((k * 2 >= h - 1 ? 1 : 2) * Math.sqrt(p)) / h;
  const depth = clamp((2 * amp) / mean, 0, 0.9);
  if (depth < 0.02) return none;
  return { scan: r4(depth), scanPeriod: r4(h / (pk / p) / h), rows: hp };
}

/* Pixel blocks: edges only on a regular grid, nothing inside the cells. */
function blocks(L, w, h) {
  const cols = new Float32Array(w - 1);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w - 1; x++) cols[x] += Math.abs(L[y * w + x + 1] - L[y * w + x]);
  const rows = new Float32Array(h - 1);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w; x += 2) rows[y] += Math.abs(L[(y + 1) * w + x] - L[y * w + x]);
  const axis = (e) => {
    const p = acfPeak(e, 3, Math.min(64, Math.floor(e.length / 4)));
    if (p.value < 0.25 || !p.lag) return null;
    // Upscaled pixel art has whole-pixel cells; a resampled one keeps its fraction.
    const period = Math.abs(p.lag - Math.round(p.lag)) < 0.2 ? Math.round(p.lag) : p.lag;
    // phase: the offset whose grid collects the most edge energy
    let bestPhase = 0;
    let bestSum = -1;
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      for (let x = ph; x < e.length; x += period) s += e[Math.round(x)] || 0;
      if (s > bestSum) {
        bestSum = s;
        bestPhase = ph;
      }
    }
    let on = 0;
    let onN = 0;
    let off = 0;
    let offN = 0;
    for (let i = 0; i < e.length; i++) {
      const t = (((i - bestPhase) % period) + period) % period;
      const dist = Math.min(t, period - t);
      if (dist < 1) {
        on += e[i];
        onN++;
      } else if (dist >= 2) {
        off += e[i];
        offN++;
      }
    }
    return { period, ratio: onN && offN ? on / onN / Math.max(1e-6, off / offN) : 0 };
  };
  const a = axis(cols);
  const b = axis(rows);
  if (!a || !b) return 0;
  if (Math.abs(a.period - b.period) > 0.2 * Math.max(a.period, b.period)) return 0;
  // Resized pixel art keeps soft cell edges (ratio ~3); a JPEG's own 8×8
  // blocking sits at exactly 8 px, so that period needs crisp edges.
  const jpegGrid = Math.abs((a.period + b.period) / 2 - 8) < 0.35;
  if (Math.min(a.ratio, b.ratio) < (jpegGrid ? 5 : 2.6)) return 0;
  return r4((a.period + b.period) / 2 / h);
}

/* Posterized levels: each channel's histogram collapses into a few spikes. */
function levels(px, w, h) {
  const counts = [];
  let comb = 0;
  for (let c = 0; c < 3; c++) {
    const hist = new Float32Array(256);
    let n = 0;
    for (let i = c; i < px.length; i += 16) {
      hist[px[i]]++;
      n++;
    }
    let spikes = 0;
    let excess = 0;
    // pure black/white (clipping, a white backdrop) is not a posterize level
    for (let v = 3; v < 253; v++) {
      let s = 0;
      let m = 0;
      for (let j = Math.max(0, v - 6); j <= Math.min(255, v + 6); j++) {
        if (j === v) continue;
        s += hist[j];
        m++;
      }
      const around = s / m;
      if (hist[v] > around * 4 && hist[v] > n * 0.01) spikes++;
      excess += Math.max(0, hist[v] - around * 1.5);
    }
    counts.push(spikes);
    comb += excess / n / 3;
  }
  counts.sort((a, b) => a - b);
  const n = counts[1];
  return comb > 0.45 && n >= 3 && n <= 16 ? n : 0;
}

/* ---------- noise ---------- */
function noise(P, Cb, Cr, w, h, rows) {
  const E = new Float32Array(P.length);
  const sm = blur2(P, w, h, 2);
  for (let k = 0; k < P.length; k++) E[k] = P[k] - sm[k];
  if (rows) {
    // scanlines are structure, not noise: take the row pattern out first
    const rowsSm = blur1(rows, h, 1, 2, true);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) E[y * w + x] -= rows[y] - rowsSm[y];
  }
  const Eb = new Float32Array(P.length);
  const Er = new Float32Array(P.length);
  const smb = blur2(Cb, w, h, 2);
  const smr = blur2(Cr, w, h, 2);
  for (let k = 0; k < P.length; k++) {
    Eb[k] = Cb[k] - smb[k];
    Er[k] = Cr[k] - smr[k];
  }
  const coarse = blur2(P, w, h, 3);
  const T = 8;
  const tiles = [];
  for (let ty = 1; ty < Math.floor(h / T) - 1; ty++) {
    for (let tx = 1; tx < Math.floor(w / T) - 1; tx++) {
      let e2 = 0;
      let c2 = 0;
      let lag = 0;
      let mean = 0;
      let struct = 0;
      for (let y = ty * T; y < ty * T + T; y++) {
        for (let x = tx * T; x < tx * T + T; x++) {
          const k = y * w + x;
          e2 += E[k] * E[k];
          c2 += Eb[k] * Eb[k] + Er[k] * Er[k];
          lag += E[k] * E[k + 1];
          mean += P[k];
          struct += Math.abs(coarse[k + 1] - coarse[k - 1]) + Math.abs(coarse[k + w] - coarse[k - w]);
        }
      }
      const n = T * T;
      mean /= n;
      if (mean < 0.07 || mean > 0.93) continue;
      tiles.push({ e2: e2 / n, c2: c2 / n / 2, lag: lag / n, struct: struct / n });
    }
  }
  if (tiles.length < 12) return { grainAmount: 0, grainChroma: 0, grainCell: 0 };
  // The flattest tiles carry only noise; textured ones carry the subject.
  tiles.sort((a, b) => a.struct - b.struct);
  const flat = tiles.slice(0, Math.max(8, Math.round(tiles.length * 0.2)));
  const med = (f) => quantile(flat.map(f), 0.5);
  const e2 = med((t) => t.e2);
  const c2 = med((t) => t.c2);
  const rho = med((t) => (t.e2 > 1e-9 ? t.lag / t.e2 : 0));
  const sigma = Math.sqrt(e2);
  const sigmaC = Math.sqrt(c2);
  return {
    grainAmount: r4(sigma),
    // per-channel RGB noise that leaves this much in Cb/Cr
    grainChroma: r4(sigmaC * 1.9),
    grainCell: r4(clamp(1 / (1 - clamp(rho, 0, 0.85)), 1, 8) / h),
  };
}

/* ---------- halation (lights in the dark) ---------- */
/* Film halation shows where a light sits in darkness: a red-orange ring
   around lamps, signs and windows at night. Find highlights whose
   surroundings are dark, and compare a thin ring round them with a ring
   further out — how much brighter, and how much redder, it is. Daylight
   pictures have no such lights and read as unknown (null), not as zero. */
function nightLights(L, R, G, B, w, h) {
  const n = L.length;
  const around = blur2(L, w, h, Math.max(4, Math.round(h * 0.06)));
  const M = new Float32Array(n);
  let count = 0;
  for (let k = 0; k < n; k++) {
    if (L[k] > 0.82 && around[k] < 0.32) {
      M[k] = 1;
      count++;
    }
  }
  if (count < n * 0.0005 || count > n * 0.08) return { halo: null, haloRed: null };
  const r1 = Math.max(2, Math.round(h * 0.012));
  const r2 = Math.max(r1 + 2, Math.round(h * 0.03));
  const r3 = Math.max(r2 + 3, Math.round(h * 0.055));
  const d1 = blur2(M, w, h, r1);
  const d2 = blur2(M, w, h, r2);
  const d3 = blur2(M, w, h, r3);
  let n1 = 0;
  let l1 = 0;
  let red1 = 0;
  let n3 = 0;
  let l3 = 0;
  let red3 = 0;
  for (let k = 0; k < n; k++) {
    if (L[k] > 0.82) continue;
    // redness: red over the mean of green and blue
    const red = R[k] - (G[k] + B[k]) / 2;
    if (d1[k] > 0.001) {
      l1 += L[k];
      red1 += red;
      n1++;
    } else if (d2[k] <= 0.001 && d3[k] > 0.001) {
      l3 += L[k];
      red3 += red;
      n3++;
    }
  }
  if (n1 < 60 || n3 < 60) return { halo: null, haloRed: null };
  return { halo: r4(l1 / n1 - l3 / n3), haloRed: r4(red1 / n1 - red3 / n3) };
}

/* ---------- main ---------- */
export function measureOptics(image) {
  const { data: px, width: w, height: h } = image;
  if (w < 32 || h < 32) return {};
  const { L, R, B, Cb, Cr } = planes(px, w, h);
  const sx = edgeSigma(L, w, h, true);
  const sy = edgeSigma(L, w, h, false);
  const cbx = edgeSigma(Cb, w, h, true, 0.04, 0.006);
  const crx = edgeSigma(Cr, w, h, true, 0.04, 0.006);
  const chromaX = [cbx, crx].filter((v) => v != null);
  const cx = chromaX.length ? Math.max(...chromaX) : null;
  const lumaX = sx == null ? 0.8 : sx;
  const { shift, fringe } = channelOffsets(R, B, L, w, h);
  const scan = scanlines(L, w, h);
  return {
    // no usable edges (fog, flat frame) is unknown, not sharp
    softX: sx == null ? null : r4(sx / h),
    softY: sy == null ? null : r4(sy / h),
    bleed: r4(cx == null ? 0 : Math.sqrt(Math.max(0, cx * cx - lumaX * lumaX)) / h),
    shift: r4(shift),
    fringe: r4(fringe),
    scan: scan.scan,
    scanPeriod: scan.scanPeriod,
    block: blocks(L, w, h),
    posterize: levels(px, w, h),
    ...nightLights(L, R, planesG(px), B, w, h),
    ...noise(L, Cb, Cr, w, h, scan.rows),
  };
}
