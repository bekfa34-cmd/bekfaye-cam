/* References in, look out. One pure function shared by the app and the test
   bench, so what the bench measures is exactly what the phone builds. */

import { analyze, combine } from './analyze.js';
import { buildLook } from './look.js';
import { matchStyles, swatchesFor } from './stylebook.js';

/** One reference (a photo, or a clip's frames) → one profile. Yields between
    frames so a phone keeps drawing while a clip is read. */
export async function profileFromCanvases(canvases) {
  const profiles = [];
  // Tape, lens and grain do not change shot to shot: a clip measures them on
  // four of its frames and its colour on all of them (half the time on a phone).
  const every = Math.max(1, Math.round(canvases.length / 4));
  for (const [i, canvas] of canvases.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 0));
    try {
      const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
      profiles.push(analyze(pixels, { optics: canvases.length <= 4 || i % every === Math.floor(every / 2) }));
    } catch {
      /* a flat frame carries no grade — skip it */
    }
  }
  if (!profiles.length) throw new Error('That frame is too flat to read a look from.');
  return combine(profiles);
}

const hexToRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function mulberry(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/* Several references → one new look. An average goes muddy (a warm photo and
   a cool one average to nothing), so: tone follows where they agree, each
   tint band keeps its strength (and when two photos pull a band opposite
   ways, the stronger one has it — teal shadows from one, amber highlights
   from another), the palette is the union of theirs, texture keeps the
   character any of them brings, and colour + black-and-white meet as a
   half-desaturated look. `seed` re-deals the weights for Remix. */
export function merge(profiles, seed = 0) {
  const n = profiles.length;
  if (n === 1) return profiles[0];
  const rand = mulberry(seed * 2654435761 + 7);
  let w = profiles.map(() => (seed ? 0.25 - Math.log(Math.max(1e-6, rand())) : 1));
  const total = w.reduce((a, b) => a + b, 0);
  w = w.map((v) => v / total);
  const wmean = (f) => profiles.reduce((s, p, i) => s + f(p) * w[i], 0);
  const base = combine(profiles);

  const q = new Float32Array(33);
  for (let i = 0; i <= 32; i++) q[i] = wmean((p) => p.q[i]);
  const casts = Array.from({ length: 5 }, (_, band) => {
    const va = wmean((p) => p.casts[band][0]);
    const vb = wmean((p) => p.casts[band][1]);
    const mag = wmean((p) => Math.hypot(p.casts[band][0], p.casts[band][1]));
    const len = Math.hypot(va, vb);
    if (mag < 1e-6) return [0, 0];
    if (len < mag * 0.4) {
      // they disagree: the strongest reference owns this band
      let best = 0;
      profiles.forEach((p, i) => {
        if (Math.hypot(...p.casts[band]) * w[i] > Math.hypot(...profiles[best].casts[band]) * w[best]) best = i;
      });
      return profiles[best].casts[band].slice();
    }
    return [(va / len) * mag, (vb / len) * mag];
  });

  const monoW = wmean((p) => (p.mono.present ? 1 : 0));
  const monoSet = profiles.filter((p) => p.mono.present);
  const mono = monoW >= 0.75
    ? { present: true, pure: monoSet.filter((p) => p.mono.pure).length * 2 >= monoSet.length, tint: [0, 1].map((k) => monoSet.reduce((s, p) => s + p.mono.tint[k], 0) / monoSet.length) }
    : { present: false, pure: false, tint: [0, 0] };
  mono.tinted = mono.present && !mono.pure;
  mono.near = !mono.present && wmean((p) => (p.mono.near ? 1 : 0)) >= 0.5;
  // colour photos carry the colour; black-and-white ones pull it down
  const colour = profiles.filter((p) => !p.mono.present);
  const colourW = colour.length ? w.filter((_, i) => !profiles[i].mono.present).reduce((a, b) => a + b, 0) : 1;
  const chroma = colour.length
    ? Math.exp(profiles.reduce((s, p, i) => (p.mono.present ? s : s + Math.log(Math.max(1, p.chroma)) * (w[i] / colourW)), 0)) * (1 - 0.5 * monoW)
    : base.chroma;
  const bandChroma = [0, 1, 2, 3, 4].map((k) => {
    const list = profiles.map((p, i) => [p.bandChroma ? p.bandChroma[k] : p.chroma, w[i], p.mono.present]).filter((x) => !x[2]);
    const tw = list.reduce((s, x) => s + x[1], 0);
    return tw ? list.reduce((s, x) => s + x[0] * x[1], 0) / tw : chroma;
  });
  const hueDensity = profiles[0].hueDensity
    ? profiles[0].hueDensity.map((_, k) => profiles.reduce((s, p, i) => s + (p.hueDensity ? p.hueDensity[k] : 0) * w[i] * (p.mono.present ? 0 : 1), 0))
    : null;

  // Texture: a look keeps the grain, softness or tape marks any photo brings,
  // pulled a little toward the set.
  const texture = { ...base.texture };
  for (const key of Object.keys(base.texture)) {
    const has = profiles.map((p, i) => [p.texture[key], w[i]]).filter(([v]) => typeof v === 'number');
    if (!has.length) continue;
    const tw = has.reduce((s, [, x]) => s + x, 0);
    const m = has.reduce((s, [v, x]) => s + v * x, 0) / tw;
    // toward the strongest (by size: a shift can point either way)
    const strongest = has.reduce((b, [v]) => (Math.abs(v) > Math.abs(b) ? v : b), 0);
    texture[key] = m + 0.5 * (strongest - m);
  }
  // All-or-nothing traits follow the majority, with that majority's value.
  for (const key of ['letterbox', 'block', 'posterize', 'scanPeriod']) {
    const holders = profiles.map((p, i) => [p.texture[key] || 0, w[i]]).filter(([v]) => v > 0);
    const share = holders.reduce((s, [, x]) => s + x, 0);
    texture[key] = share >= 0.5 ? holders.sort((a, b) => b[1] - a[1])[0][0] : 0;
  }
  if (!texture.posterize) texture.levels = 0;
  if (!texture.scanPeriod) texture.scan = 0;

  return { ...base, q, casts, mono, chroma, bandChroma, hueDensity, texture, blackFloor: q[0], whiteCeiling: q[32], range: q[30] - q[2], references: n };
}

/** refs: [{ profile, kind, frames }] → { look, name, note } */
export function lookFromRefs(refs, { seed = 0 } = {}) {
  const profiles = refs.map((ref) => ref.profile);
  const profile = merge(profiles, seed);
  const look = buildLook(profile);
  look.meta.swatches = swatchesFor(look.casts, look.mono);

  const count = refs.length;
  const clip = refs[0] && refs[0].kind === 'clip' ? refs[0] : null;
  const read = clip ? `${clip.frames} frames across your clip` : count > 1 ? `${count} photos` : 'your photo';

  // The grade itself is always measured from the references, so it is the
  // closest match we can make. The name says which film stock it sits nearest;
  // several photos that lean different ways are named as a blend.
  const best = matchStyles(profile, 1)[0];
  const each = count > 1 ? refs.map((ref) => matchStyles(ref.profile, 1)[0]).filter((m) => m && m.score >= 0.42) : [];
  const stocks = [...new Set(each.map((m) => m.style.name))];
  let name;
  let note;
  if (stocks.length > 1) {
    name = `Blend · ${stocks.slice(0, 2).join(' + ')}${stocks.length > 2 ? ` +${stocks.length - 2}` : ''}`;
    note = `Your ${count} photos lean different ways (${stocks.join(', ')}), so this blends them — measured from ${read}.`;
  } else if (best && best.score >= 0.42) {
    name = best.style.name;
    note = `${best.style.note} — matched to ${read}.`;
  } else {
    name = 'Your reference look';
    note = `Measured straight off ${read}, with no stock borrowed.`;
  }
  // Say what kind of capture it is when that is the look's character.
  const t = look.texture || {};
  const capture = t.block ? 'Pixel' : t.scan > 0.03 || t.bleed > 0.004 || (t.softX > 0.003 && t.softX > 1.6 * (t.softY || 0)) ? 'Tape'
    : t.letterbox ? 'Widescreen' : (t.grainAmount || 0) > 0.012 ? 'Grainy' : t.sharpen > 0.2 ? 'Crisp' : '';
  if (capture && !name.startsWith('Blend')) name = `${capture} · ${name}`;
  look.meta.name = name;
  return { look, name, note, profile };
}

const OPTICS = ['softX', 'softY', 'bleed', 'shift', 'fringe', 'scan', 'grainAmount', 'grainChroma', 'sharpen', 'bloom', 'halation', 'diffuse'];

/** Shader options for a look (texture, optics, palette); the LUT carries the
    colour. `strength` scales the texture the way it scales the grade. */
export function lookOptions(look, strength = 1) {
  const base = { log: 'sdr', seed: 3, gain: [1, 1, 1], zoom: 1, crop: [0, 0, 1, 1], bypass: false, monitor: 0 };
  const off = { blur: 0, glow: 0, grain: 0, vignette: 0, pixel: 0, levels: 0, palette: [[0, 0, 0]], paletteMix: 0, softX: 0, softY: 0, bleed: 0, shift: 0, fringe: 0, scan: 0, scanPeriod: 0, block: 0, grainAmount: 0, grainChroma: 0, grainCell: 0, letterbox: 0, sharpen: 0, bloom: 0, halation: 0, diffuse: 0, halTint: [1, 0.32, 0.12] };
  if (!look) return { ...base, ...off };
  // past 100% the look is pushed beyond the (cautious) read of the references
  const k = Math.max(0, Math.min(1.5, strength));
  const tex = look.texture || {};
  const mix = tex.paletteMix || 0;
  const colours = ((look.meta && look.meta.swatches) || []).map(hexToRgb).filter(Boolean).slice(0, 4);
  // 0–1 amounts stay within 0–1 when pushed (posterize past 1 means fewer than no levels)
  const unit = (v) => Math.min(1, (v || 0) * k);
  const out = {
    ...base,
    ...off,
    blur: unit(tex.blur),
    glow: unit(tex.glow),
    grain: unit(tex.grain),
    vignette: unit(tex.vignette),
    pixel: tex.pixel || 0,
    levels: unit(tex.levels),
    scanPeriod: tex.scanPeriod || 0,
    grainCell: tex.grainCell || 0,
    // blocks and bars are all-or-nothing: they stay until the look is mostly off
    block: k >= 0.5 ? tex.block || 0 : 0,
    letterbox: k >= 0.5 ? tex.letterbox || 0 : 0,
    ...(mix > 0.001 && colours.length >= 2 ? { palette: colours, paletteMix: unit(mix) } : {}),
  };
  for (const key of OPTICS) out[key] = (tex[key] || 0) * k;
  out.scan = Math.min(0.9, out.scan);
  for (const key of ['sharpen', 'bloom', 'halation', 'diffuse']) out[key] = Math.min(1, out[key]);
  if (Array.isArray(tex.halTint) && tex.halTint.length === 3) out.halTint = tex.halTint;
  return out;
}
