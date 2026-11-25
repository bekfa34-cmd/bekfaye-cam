/* Color science core.
   sRGB <-> CIE Lab (D65) for grading, plus the Apple Log camera encodings so
   log footage can be decoded to a display image before a look is applied. */

export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const mix = (a, b, t) => a + (b - a) * t;

export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
};

export const srgbToLinear = (v) => {
  v = clamp(v);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export const linearToSrgb = (v) => {
  v = clamp(v);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

/* ---------- CIE Lab ---------- */
const WHITE_X = 0.95047;
const WHITE_Z = 1.08883;
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const labFInv = (t) => (t > 0.206897 ? t * t * t : (t - 16 / 116) / 7.787);

export function rgbToLab(rgb) {
  const r = srgbToLinear(rgb[0]);
  const g = srgbToLinear(rgb[1]);
  const b = srgbToLinear(rgb[2]);
  const x = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE_X);
  const y = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE_Z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labToRgb(lab) {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const X = WHITE_X * labFInv(fx);
  const Y = labFInv(fy);
  const Z = WHITE_Z * labFInv(fz);
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

export const labChromaL = (lab) => Math.hypot(lab[1], lab[2]);

/* ---------- Apple Log / Apple Log 2 ---------- */
const AL = {
  R0: -0.05641088,
  Rt: 0.01,
  sigma: 47.28711236,
  beta: 0.00964052,
  gamma: 0.08550479,
  delta: 0.69336945,
};
const PT = AL.sigma * (AL.Rt - AL.R0) ** 2;

export function appleLogDecode(p) {
  if (p >= PT) return 2 ** ((p - AL.delta) / AL.gamma) - AL.beta;
  if (p >= 0) return Math.sqrt(p / AL.sigma) + AL.R0;
  return AL.R0;
}

export function appleLogEncode(x) {
  if (x >= AL.Rt) return AL.gamma * Math.log2(x + AL.beta) + AL.delta;
  if (x >= AL.R0) return AL.sigma * (x - AL.R0) ** 2;
  return 0;
}

export const ALOG_CURVE = { ...AL, pivot: PT };

const inv3 = (m) => {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
};

// Camera gamut -> linear sRGB. Apple Log is Rec.2020-encoded (iPhone 15/16 Pro);
// Apple Log 2 uses the wider Apple Wide Gamut primaries (iPhone 17 Pro).
const CAMERA_MATRIX = {
  alog: [
    [1.6605, -0.5876, -0.0728],
    [-0.1246, 1.1329, -0.0083],
    [-0.0182, -0.1006, 1.1187],
  ],
  alog2: [
    [1.7070086035, -0.5189362288, -0.1882318132],
    [-0.1250134641, 1.3146919459, -0.1896556249],
    [-0.0436345642, -0.1912601284, 1.2351355291],
  ],
};

export const cameraMatrix = (space) => CAMERA_MATRIX[space === 'alog2' ? 'alog2' : 'alog'];
export const cameraMatrixInverse = (space) => inv3(cameraMatrix(space));
export const isLogSpace = (space) => space === 'alog' || space === 'alog2';

/* Display transform for log footage: decode, convert to sRGB primaries,
   pull out-of-gamut colours back toward the neutral axis, then roll the
   highlights off softly instead of clipping them. */
const KNEE = 0.72;

export function rollHighlights(x) {
  x = Math.max(0, x);
  if (x <= KNEE) return x;
  const span = 1 - KNEE;
  return KNEE + span * (1 - Math.exp(-(x - KNEE) / span));
}

function gamutSafe(rgb) {
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  if (min >= 0) return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
  const y = luma(rgb[0], rgb[1], rgb[2]);
  const t = clamp(y / Math.max(1e-6, y - min), 0, 1);
  return [
    Math.max(0, y + (rgb[0] - y) * t),
    Math.max(0, y + (rgb[1] - y) * t),
    Math.max(0, y + (rgb[2] - y) * t),
  ];
}

function applyMatrix(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Decode a stored pixel to display sRGB. `space` is sdr | alog | alog2. */
export function toDisplay(rgb, space = 'sdr') {
  if (!isLogSpace(space)) return rgb;
  const linear = applyMatrix(cameraMatrix(space), rgb.map(appleLogDecode));
  const safe = gamutSafe(linear);
  const y = luma(safe[0], safe[1], safe[2]);
  const scale = y > KNEE ? rollHighlights(y) / Math.max(y, 1e-6) : 1;
  return safe.map((v) => linearToSrgb(Math.min(1, v * scale)));
}

/** Encode display sRGB into a camera log space (used for verification and for
    writing log-friendly previews). */
export function fromDisplay(rgb, space = 'sdr') {
  if (!isLogSpace(space)) return rgb;
  let linear = rgb.map(srgbToLinear);
  const y = luma(linear[0], linear[1], linear[2]);
  if (y > 1e-6) {
    const capped = Math.min(y, 0.9999);
    const target = capped <= KNEE ? capped : KNEE - (1 - KNEE) * Math.log(1 - (capped - KNEE) / (1 - KNEE));
    const s = target / y;
    linear = linear.map((v) => v * s);
  }
  return applyMatrix(cameraMatrixInverse(space), linear).map(appleLogEncode);
}
