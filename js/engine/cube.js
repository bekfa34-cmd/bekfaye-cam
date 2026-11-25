/* .cube (Adobe/Iridas 3D LUT) reading, sampling and writing. */

import { clamp } from './color.js';

const SPACE_LABEL = {
  sdr: 'SDR',
  alog: 'AppleLog',
  alog2: 'AppleLog2',
};

export const SPACE_TITLE = {
  sdr: 'standard SDR display RGB',
  alog: 'Apple Log (Rec.2020, iPhone 15/16 Pro)',
  alog2: 'Apple Log 2 (Apple Wide Gamut, iPhone 17 Pro)',
};

export function sanitizeName(name) {
  const clean = (name || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 _-]+/g, '-')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || 'my-look';
}

export function cubeFileName(name, space) {
  return `${sanitizeName(name)}_${SPACE_LABEL[space] || 'SDR'}.cube`;
}

export function serializeCube(values, size, { name, space = 'sdr' } = {}) {
  const title = sanitizeName(name);
  const input = SPACE_TITLE[space] || SPACE_TITLE.sdr;
  const lines = [
    `TITLE "${title}"`,
    '# archive film — one look averaged from your references',
    `# Input: ${input}${space === 'sdr' ? '' : ', decoded to display with a soft highlight rolloff'}`,
    '# Output: standard SDR display RGB',
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  const body = new Array(values.length / 3);
  for (let i = 0, row = 0; i < values.length; i += 3, row++) {
    body[row] = `${values[i].toFixed(6)} ${values[i + 1].toFixed(6)} ${values[i + 2].toFixed(6)}`;
  }
  return `${lines.join('\n')}${body.join('\n')}\n`;
}

/** Trilinear sample of a baked lattice at an RGB position in 0..1. */
export function sampleCube(values, size, rgb) {
  const pos = [clamp(rgb[0]) * (size - 1), clamp(rgb[1]) * (size - 1), clamp(rgb[2]) * (size - 1)];
  const lo = pos.map(Math.floor);
  const hi = lo.map((v, i) => Math.min(size - 1, v + 1));
  const t = pos.map((v, i) => v - lo[i]);
  const out = [0, 0, 0];
  for (let b = 0; b < 2; b++) {
    for (let g = 0; g < 2; g++) {
      for (let r = 0; r < 2; r++) {
        const w = (r ? t[0] : 1 - t[0]) * (g ? t[1] : 1 - t[1]) * (b ? t[2] : 1 - t[2]);
        const idx = ((((b ? hi[2] : lo[2]) * size + (g ? hi[1] : lo[1])) * size + (r ? hi[0] : lo[0])) * 3);
        out[0] += values[idx] * w;
        out[1] += values[idx + 1] * w;
        out[2] += values[idx + 2] * w;
      }
    }
  }
  return out;
}
