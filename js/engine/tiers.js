/* Quality tiers. Every tier runs at 30 fps; what changes is how many pixels
   go through the grade each frame and how fine the Cinematic blur is.

   Max     4K (3840 on the long edge) — newest Pro phones (iPhone 17 Pro class)
   High    1080p                      — most phones from the last few years
   Medium  720p                       — iPhone 12 class, with room to spare

   Auto picks one from a short GPU timing on this device (the browser does not
   say which iPhone it is), and the camera steps down a tier on its own if the
   picture can't hold 30 fps. The choice can always be overridden. */

import { Viewer } from './gl.js';

export const TIERS = {
  max: { id: 'max', name: 'Max', longEdge: 3840, capW: 3840, capH: 2160, recMax: 90, blur: 2, note: '4K · for the newest Pro iPhones' },
  high: { id: 'high', name: 'High', longEdge: 1920, capW: 1920, capH: 1080, recMax: 240, blur: 1, note: '1080p · most recent phones' },
  medium: { id: 'medium', name: 'Medium', longEdge: 1280, capW: 1280, capH: 720, recMax: 420, blur: 0, note: '720p · easy on older phones' },
};
export const ORDER = ['max', 'high', 'medium'];
const CHOICES = ['auto', 'max', 'high', 'medium'];

const KEY_CHOICE = 'archive-film.tier.choice';
const KEY_BENCH = 'archive-film.tier.bench.v1';

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
};

/* Render the full grade + Cinematic blur + grain at 1080p a dozen times and
   time it, forcing the GPU to finish each frame. Conservative on purpose: a
   phone that passes with margin here holds 30 fps in the real viewfinder. */
export function benchmark() {
  const canvas = document.createElement('canvas');
  const viewer = new Viewer(canvas);
  if (!viewer.ok) return { ms: Infinity, tier: 'medium' };
  const src = document.createElement('canvas');
  src.width = 1920;
  src.height = 1080;
  const g = src.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1920, 1080);
  grad.addColorStop(0, '#203040');
  grad.addColorStop(1, '#e0b080');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1920, 1080);
  viewer.ensureSize(1920, 1080);
  viewer.setSource(src);
  const n = 9;
  const lut = new Float32Array(n * n * n * 3);
  for (let i = 0; i < lut.length; i++) lut[i] = (i % 7) / 7;
  viewer.setLut(lut, n);
  viewer.setOptions({ dof: 1, focusX: 0.5, focusY: 0.5, focusR: 0.25, focusSoft: 0.6, glow: 0.3, grain: 0.3, vignette: 0.2, blurQuality: 2 });
  const gl = viewer.gl;
  const px = new Uint8Array(4);
  const times = [];
  for (let i = 0; i < 14; i++) {
    const t0 = performance.now();
    viewer.render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (i >= 2) times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const ms = times[Math.floor(times.length / 2)];
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  // 4K is four times the pixels of this test, so Max needs a lot of headroom.
  const tier = ms <= 6 ? 'max' : ms <= 16 ? 'high' : 'medium';
  return { ms, tier };
}

export function createTiers() {
  let choice = CHOICES.includes(read(KEY_CHOICE)) ? read(KEY_CHOICE) : 'auto';
  let bench = null;
  try {
    bench = JSON.parse(read(KEY_BENCH) || 'null');
  } catch {
    bench = null;
  }
  // Auto can only step down within a session; it starts again from the
  // benchmark next time.
  let autoCap = null;

  const autoTier = () => {
    if (!bench) {
      bench = benchmark();
      write(KEY_BENCH, JSON.stringify(bench));
    }
    let id = bench.tier;
    if (autoCap && ORDER.indexOf(id) < ORDER.indexOf(autoCap)) id = autoCap;
    return id;
  };

  return {
    get choice() {
      return choice;
    },
    get bench() {
      return bench;
    },
    current() {
      return { ...TIERS[choice === 'auto' ? autoTier() : choice], auto: choice === 'auto' };
    },
    next() {
      choice = CHOICES[(CHOICES.indexOf(choice) + 1) % CHOICES.length];
      autoCap = null;
      write(KEY_CHOICE, choice);
      return this.current();
    },
    /** Called when the camera cannot reach the tier's size (no 4K sensor mode). */
    capAt(id) {
      autoCap = id;
    },
    /** Auto only: drop one tier. Returns the new tier, or null at the bottom. */
    stepDown() {
      if (choice !== 'auto') return null;
      const now = autoTier();
      const i = ORDER.indexOf(now);
      if (i >= ORDER.length - 1) return null;
      autoCap = ORDER[i + 1];
      return this.current();
    },
    rerun() {
      bench = null;
      write(KEY_BENCH, null);
      autoCap = null;
      return this.current();
    },
  };
}
