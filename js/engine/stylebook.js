/* The aesthetic arsenal.

   A stylebook of looks a colourist would actually reach for — film stocks,
   silver processes, cross-process accidents, neon cities, print stocks, tape
   decay — each described as a compact recipe (curve, five split-tone bands,
   chroma, hue pushes, texture) and compiled into the same look model the
   grader and the .cube baker use.

   Recipes are intentionally small and declarative so the director can score
   them against a reference set, then blend the winner with what the references
   actually measure. Nothing here averages: it chooses. */

import { makeTable, curveAt } from './look.js';
import { clamp, labToRgb } from './color.js';

/* ---------- shared building blocks ---------- */

const CURVE = {
  linear: [[0, 0], [0.2, 0.2], [0.4, 0.4], [0.6, 0.6], [0.8, 0.8], [1, 1]],
  film: [[0, 0.035], [0.18, 0.16], [0.42, 0.42], [0.68, 0.7], [0.86, 0.89], [1, 0.97]],
  contrast: [[0, 0.012], [0.2, 0.14], [0.47, 0.48], [0.76, 0.84], [0.92, 0.98], [1, 1]],
  hard: [[0, 0.004], [0.16, 0.06], [0.45, 0.46], [0.78, 0.91], [1, 1]],
  soft: [[0, 0.06], [0.22, 0.24], [0.5, 0.53], [0.78, 0.79], [1, 0.95]],
  matte: [[0, 0.085], [0.2, 0.22], [0.5, 0.51], [0.8, 0.79], [1, 0.92]],
  bright: [[0, 0.04], [0.3, 0.4], [0.6, 0.68], [0.85, 0.9], [1, 1]],
  dark: [[0, 0.008], [0.2, 0.11], [0.45, 0.38], [0.72, 0.7], [1, 0.94]],
  silver: [[0, 0.015], [0.2, 0.2], [0.5, 0.55], [0.78, 0.87], [0.94, 0.98], [1, 1]],
  push: [[0, 0.02], [0.15, 0.1], [0.4, 0.42], [0.7, 0.79], [0.88, 0.96], [1, 1]],
};

/* Five split-tone bands, shadow → highlight, in Lab a/b units. */
const CAST = {
  none: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
  warm: [[0, 1], [1, 3], [2, 6], [3, 7], [2, 5]],
  golden: [[1, 2], [2, 5], [4, 9], [5, 10], [4, 7]],
  amber: [[1, 3], [2, 5], [3, 8], [3, 7], [2, 5]],
  sepia: [[1, 3], [2, 6], [2, 9], [1, 8], [0, 5]],
  cool: [[-2, -3], [-1, -3], [-1, -2], [0, -1], [1, 0]],
  blue: [[-2, -6], [-2, -5], [-1, -4], [0, -3], [1, -2]],
  cyan: [[-4, -4], [-3, -4], [-2, -3], [-1, -2], [-1, -1]],
  teal: [[-5, -6], [-3, -4], [-1, -2], [0, 0], [1, 1]],
  tealOrange: [[-6, -5], [-3, -2], [0, 1], [4, 5], [6, 7]],
  green: [[-3, 2], [-2, 3], [-1, 3], [0, 2], [0, 1]],
  magenta: [[3, -1], [3, 0], [2, 1], [1, 2], [0, 2]],
  rose: [[4, 0], [5, 1], [4, 2], [2, 2], [1, 1]],
  plum: [[2, -3], [3, -2], [4, 1], [4, 3], [3, 4]],
  red: [[3, -1], [4, 0], [3, 1], [2, 1], [1, 1]],
  acid: [[-6, -4], [-2, 0], [0, 3], [3, 7], [5, 9]],
  mint: [[-1, 0], [0, 2], [1, 3], [1, 2], [0, 1]],
  kodak: [[2, -2], [1, 0], [3, 4], [4, 4], [3, 2]],
  kodakCool: [[-2, -3], [0, 0], [2, 2], [3, 3], [2, 1]],
};

const TEX = {
  clean: { blur: 0.02, glow: 0.05, grain: 0.02, vignette: 0.06 },
  film: { blur: 0.06, glow: 0.18, grain: 0.16, vignette: 0.18 },
  grain: { blur: 0.02, glow: 0.08, grain: 0.32, vignette: 0.16 },
  soft: { blur: 0.3, glow: 0.34, grain: 0.1, vignette: 0.24 },
  bloom: { blur: 0.14, glow: 0.58, grain: 0.09, vignette: 0.22 },
  harsh: { blur: 0, glow: 0.1, grain: 0.26, vignette: 0.4 },
  print: { blur: 0.1, glow: 0.12, grain: 0.28, vignette: 0.3 },
  neon: { blur: 0.08, glow: 0.5, grain: 0.12, vignette: 0.3 },
};

/* ---------- the arsenal ---------- */

export const STYLES = [
  /* — silver & monochrome — */
  {
    id: 'bleach-bypass',
    name: 'Bleach bypass',
    family: 'Silver',
    note: 'Silver retained, blacks hard, colour pulled back to a stain',
    tags: ['Silver', 'Desaturated', 'Hard'],
    curve: 'contrast',
    cast: 'warm',
    sat: 0.5,
    bleach: 0.8,
    tex: 'film',
    texAdd: { vignette: 0.26 },
  },
  {
    id: 'enr',
    name: 'ENR',
    family: 'Silver',
    note: 'Bleach bypass with crushed blacks and a cold edge',
    tags: ['Silver', 'Crushed', 'Cold'],
    curve: 'hard',
    cast: 'cool',
    sat: 0.55,
    bleach: 0.9,
    tex: 'film',
    texAdd: { vignette: 0.42 },
  },
  {
    id: 'silver-nitrate',
    name: 'Silver nitrate',
    family: 'Silver',
    note: 'Warm silver print, brown-black, soft highlight roll',
    tags: ['Mono', 'Warm', 'Print'],
    curve: 'silver',
    cast: 'sepia',
    mono: { pure: false, tint: [2, 5] },
    tex: 'print',
  },
  {
    id: 'platinum',
    name: 'Platinum print',
    family: 'Silver',
    note: 'Long greys, soft light, almost no contrast',
    tags: ['Mono', 'Soft', 'Gallery'],
    curve: 'soft',
    cast: 'none',
    mono: { pure: false, tint: [0, 2] },
    tex: 'print',
  },
  {
    id: 'lith',
    name: 'Lith print',
    family: 'Silver',
    note: 'Soot blacks and paper-white highlights, no middle',
    tags: ['Mono', 'Hard', 'Soot'],
    curve: 'hard',
    cast: 'none',
    mono: { pure: true, tint: [0, 0] },
    tex: 'print',
    texAdd: { grain: 0.36 },
  },
  {
    id: 'high-key',
    name: 'High-key silver',
    family: 'Silver',
    note: 'White-on-white, pale and airy',
    tags: ['Mono', 'Bright', 'Soft'],
    curve: 'bright',
    cast: 'none',
    mono: { pure: false, tint: [1, 2] },
    tex: 'soft',
  },
  {
    id: 'noir',
    name: 'Noir',
    family: 'Silver',
    note: 'Hard silver contrast, coarse grain, heavy corners',
    tags: ['Mono', 'Punchy', 'Grain'],
    curve: 'hard',
    cast: 'none',
    mono: { pure: true, tint: [0, 0] },
    tex: 'harsh',
  },
  {
    id: 'sepia-salt',
    name: 'Salt print',
    family: 'Silver',
    note: 'Warm brown print, matte blacks',
    tags: ['Mono', 'Sepia', 'Matte'],
    curve: 'matte',
    cast: 'sepia',
    mono: { pure: false, tint: [3, 9] },
    tex: 'print',
  },
  {
    id: 'cyanotype',
    name: 'Cyanotype',
    family: 'Silver',
    note: 'Blueprint blue, soft and low contrast',
    tags: ['Mono', 'Blue', 'Soft'],
    curve: 'soft',
    cast: 'cyan',
    mono: { pure: false, tint: [-4, -8] },
    tex: 'print',
  },
  {
    id: 'two-strip',
    name: 'Two-strip',
    family: 'Silver',
    note: 'Early two-colour: red and cyan, nothing between',
    tags: ['Mono', 'Cyan', 'Vintage'],
    curve: 'film',
    cast: 'cyan',
    sat: 0.35,
    hues: [[25, 4, 0]],
    tex: 'print',
  },
  {
    id: 'silver-fog',
    name: 'Fogged silver',
    family: 'Silver',
    note: 'Milk-fogged monochrome, lifted and soft',
    tags: ['Mono', 'Fog', 'Lifted'],
    curve: 'matte',
    cast: 'none',
    mono: { pure: false, tint: [1, 3] },
    tex: 'soft',
  },

  /* — film stocks — */
  {
    id: 'kodachrome',
    name: 'Kodachrome 64',
    family: 'Film',
    note: 'Deep reds, navy shadows, slide-film punch',
    tags: ['Slide', 'Reds', 'Punchy'],
    curve: 'contrast',
    cast: 'kodak',
    sat: 1.15,
    tex: 'film',
  },
  {
    id: 'portra-400',
    name: 'Portra 400',
    family: 'Film',
    note: 'Soft pastel range, warm skin, fine grain',
    tags: ['Portrait', 'Warm', 'Pastel'],
    curve: 'soft',
    cast: 'warm',
    sat: 0.95,
    tex: 'film',
  },
  {
    id: 'portra-800',
    name: 'Portra 800',
    family: 'Film',
    note: 'Warmer and softer, halation on every light',
    tags: ['Portrait', 'Halation', 'Warm'],
    curve: 'soft',
    cast: 'amber',
    sat: 0.9,
    tex: 'bloom',
    texAdd: { halation: 0.3, bloom: 0.2 },
  },
  {
    id: 'ektar',
    name: 'Ektar 100',
    family: 'Film',
    note: 'Vivid colour, cool shadows, almost no grain',
    tags: ['Vivid', 'Cool', 'Clean'],
    curve: 'contrast',
    cast: 'kodakCool',
    sat: 1.2,
    tex: 'film',
  },
  {
    id: 'velvia',
    name: 'Velvia 50',
    family: 'Film',
    note: 'Saturated greens, magenta skies, hard contrast',
    tags: ['Vivid', 'Landscape', 'Punchy'],
    curve: 'contrast',
    cast: 'mint',
    sat: 1.35,
    hues: [[130, -2, 4]],
    tex: 'film',
  },
  {
    id: 'ektachrome',
    name: 'Ektachrome',
    family: 'Film',
    note: 'Clean slide film, cool and exact',
    tags: ['Slide', 'Clean', 'Cool'],
    curve: 'linear',
    cast: 'cool',
    sat: 1.05,
    tex: 'clean',
  },
  {
    id: 'cinestill-800t',
    name: 'Cinestill 800T',
    family: 'Film',
    note: 'Tungsten balance, red halation around lights',
    tags: ['Night', 'Halation', 'Teal'],
    curve: 'film',
    cast: 'teal',
    sat: 0.95,
    hues: [[25, 3, 2]],
    tex: 'bloom',
    texAdd: { halation: 0.6, bloom: 0.15 },
  },
  {
    id: 'superia',
    name: 'Superia 400',
    family: 'Film',
    note: 'Green shadows, consumer-film honesty',
    tags: ['Consumer', 'Green', 'Grain'],
    curve: 'film',
    cast: 'green',
    sat: 1.05,
    tex: 'film',
  },
  {
    id: 'expired',
    name: 'Expired stock',
    family: 'Film',
    note: 'Magenta drift, faded blacks, uncertain colour',
    tags: ['Faded', 'Magenta', 'Grain'],
    curve: 'matte',
    cast: 'magenta',
    sat: 0.8,
    tex: 'grain',
  },
  {
    id: 'pro-400h',
    name: 'Pro 400H',
    family: 'Film',
    note: 'Airy mint pastel, very low contrast',
    tags: ['Pastel', 'Mint', 'Airy'],
    curve: 'soft',
    cast: 'mint',
    sat: 0.8,
    tex: 'soft',
  },
  {
    id: 'agfa',
    name: 'Agfa Ultra',
    family: 'Film',
    note: 'Earthy warm colour, coarse grain',
    tags: ['Warm', 'Earthy', 'Grain'],
    curve: 'film',
    cast: 'amber',
    sat: 1.0,
    tex: 'grain',
  },
  {
    id: 'polaroid-600',
    name: 'Polaroid 600',
    family: 'Film',
    note: 'Milky instant film, cyan shadows, soft flash',
    tags: ['Instant', 'Milky', 'Cyan'],
    curve: 'matte',
    cast: 'cyan',
    sat: 0.85,
    tex: 'soft',
  },
  {
    id: 'sx-70',
    name: 'SX-70',
    family: 'Film',
    note: 'Cream instant, faded and warm',
    tags: ['Instant', 'Cream', 'Faded'],
    curve: 'matte',
    cast: 'sepia',
    sat: 0.8,
    tex: 'soft',
  },

  /* — print & process — */
  {
    id: 'bek-palette',
    name: 'Bek palette',
    family: 'Print',
    note: 'Plum shadows, mauve mids, dusty pink and cream',
    tags: ['Plum', 'Dusty pink', 'Cream'],
    curve: 'soft',
    cast: 'plum',
    sat: 0.92,
    tex: 'film',
    texAdd: { glow: 0.24 },
  },
  {
    id: 'bek-club-warm',
    name: 'Club flash',
    family: 'Neon',
    note: 'Direct flash, warm skin, black room',
    tags: ['Flash', 'Warm', 'Night'],
    curve: 'hard',
    cast: 'amber',
    sat: 1.05,
    tex: 'film',
    texAdd: { vignette: 0.34 },
  },
  {
    id: 'cross-process',
    name: 'Cross-process',
    family: 'Print',
    note: 'C41 in E6: cyan shadows, acid yellow highlights',
    tags: ['Cross', 'Cyan', 'Acid'],
    curve: 'contrast',
    cast: 'acid',
    sat: 1.25,
    tex: 'grain',
  },
  {
    id: 'e6-in-c41',
    name: 'E6 in C41',
    family: 'Print',
    note: 'Green mids, blown paper-white highlights',
    tags: ['Cross', 'Green', 'Hard'],
    curve: 'hard',
    cast: 'green',
    sat: 1.1,
    tex: 'print',
  },
  {
    id: 'technicolor',
    name: 'Technicolor',
    family: 'Print',
    note: 'Three-strip saturation, rich primaries',
    tags: ['Saturated', 'Classic', 'Rich'],
    curve: 'contrast',
    cast: 'none',
    sat: 1.5,
    hues: [[25, 3, 1], [240, 0, -2]],
    tex: 'film',
  },
  {
    id: 'editorial-matte',
    name: 'Editorial matte',
    family: 'Print',
    note: 'Magazine grade, lifted black, quiet colour',
    tags: ['Matte', 'Editorial', 'Warm'],
    curve: 'matte',
    cast: 'warm',
    sat: 0.95,
    tex: 'print',
  },
  {
    id: 'risograph',
    name: 'Risograph',
    family: 'Print',
    note: 'Poster inks, flat and loud',
    tags: ['Poster', 'Flat', 'Loud'],
    curve: 'contrast',
    cast: 'rose',
    sat: 1.45,
    tex: 'grain',
  },
  {
    id: 'print-fade',
    name: 'Sun-faded print',
    family: 'Print',
    note: 'Years in a window: warm, low, almost gone',
    tags: ['Faded', 'Warm', 'Low'],
    curve: 'matte',
    cast: 'amber',
    sat: 0.7,
    tex: 'print',
  },

  /* — neon & night — */
  {
    id: 'neon-noir',
    name: 'Neon noir',
    family: 'Neon',
    note: 'Teal night, red neon, wet asphalt',
    tags: ['Night', 'Teal', 'Neon'],
    curve: 'contrast',
    cast: 'tealOrange',
    sat: 1.1,
    tex: 'neon',
    texAdd: { bloom: 0.35, halation: 0.3 },
  },
  {
    id: 'blade-fog',
    name: 'Blade fog',
    family: 'Neon',
    note: 'Orange fog, black silhouette, one figure',
    tags: ['Fog', 'Orange', 'Epic'],
    curve: 'dark',
    cast: 'amber',
    sat: 1.0,
    tex: 'bloom',
    texAdd: { glow: 0.68 },
  },
  {
    id: 'tungsten-corridor',
    name: 'Tungsten corridor',
    family: 'Neon',
    note: 'Green corridor, one red practical, motion blur',
    tags: ['Green', 'Tungsten', 'Film'],
    curve: 'film',
    cast: 'green',
    sat: 0.95,
    hues: [[25, 3, 2]],
    tex: 'grain',
  },
  {
    id: 'red-lamp',
    name: 'Red lamp',
    family: 'Neon',
    note: 'One red practical, everything else black',
    tags: ['Red', 'Dark', 'Mood'],
    curve: 'dark',
    cast: 'red',
    sat: 1.0,
    tex: 'grain',
  },
  {
    id: 'sodium-street',
    name: 'Sodium street',
    family: 'Neon',
    note: 'Sodium orange against a black sky',
    tags: ['Orange', 'Night', 'Street'],
    curve: 'contrast',
    cast: 'golden',
    sat: 0.85,
    tex: 'grain',
  },
  {
    id: 'mercury-lot',
    name: 'Mercury lot',
    family: 'Neon',
    note: 'Green-cyan fluorescents, parking-lot noir',
    tags: ['Green', 'Fluorescent', 'Cold'],
    curve: 'contrast',
    cast: 'green',
    sat: 0.9,
    tex: 'grain',
  },
  {
    id: 'miami-pastel',
    name: 'Miami pastel',
    family: 'Neon',
    note: 'Pink and cyan, soft glow, no hard shadow',
    tags: ['Pink', 'Cyan', 'Glow'],
    curve: 'soft',
    cast: 'rose',
    sat: 1.1,
    hues: [[195, -2, -2]],
    tex: 'bloom',
  },
  {
    id: 'ultraviolet',
    name: 'Ultraviolet',
    family: 'Neon',
    note: 'Purple night, magenta lights, black core',
    tags: ['Purple', 'Magenta', 'Night'],
    curve: 'dark',
    cast: 'magenta',
    sat: 1.15,
    tex: 'neon',
  },
  {
    id: 'behind-the-sound',
    name: 'Behind the Sound',
    family: 'Neon',
    note: 'Teal shadows, warm practicals, 2.39 frame',
    tags: ['Teal', 'Warm', 'Cinema'],
    curve: 'contrast',
    cast: 'tealOrange',
    sat: 0.95,
    tex: 'film',
    texAdd: { vignette: 0.36 },
  },

  /* — warm — */
  {
    id: 'golden-hour',
    name: 'Golden hour',
    family: 'Warm',
    note: 'Low sun, amber bloom, long shadows',
    tags: ['Golden', 'Bloom', 'Soft'],
    curve: 'soft',
    cast: 'golden',
    sat: 1.05,
    tex: 'bloom',
    texAdd: { bloom: 0.35 },
  },
  {
    id: 'desert-clay',
    name: 'Desert clay',
    family: 'Warm',
    note: 'Terracotta dust, bleached sky, dry air',
    tags: ['Earth', 'Terracotta', 'Dust'],
    curve: 'film',
    cast: 'amber',
    sat: 0.9,
    tex: 'grain',
  },
  {
    id: 'amber-tungsten',
    name: 'Amber tungsten',
    family: 'Warm',
    note: 'Warm bulbs in a dark room',
    tags: ['Tungsten', 'Warm', 'Dark'],
    curve: 'dark',
    cast: 'amber',
    sat: 1.0,
    tex: 'film',
  },
  {
    id: 'honey-skin',
    name: 'Honey skin',
    family: 'Warm',
    note: 'Creamy portrait warmth, gentle highlight',
    tags: ['Portrait', 'Cream', 'Soft'],
    curve: 'soft',
    cast: 'warm',
    sat: 0.95,
    tex: 'soft',
    texAdd: { glow: 0.32 },
  },
  {
    id: 'sun-bleached',
    name: 'Sun-bleached',
    family: 'Warm',
    note: 'Faded warm colour, low saturation',
    tags: ['Faded', 'Warm', 'Low'],
    curve: 'matte',
    cast: 'amber',
    sat: 0.65,
    tex: 'print',
  },

  /* — cool — */
  {
    id: 'nordic-noir',
    name: 'Nordic noir',
    family: 'Cool',
    note: 'Cold, desaturated, cyan shadow, no warmth anywhere',
    tags: ['Cold', 'Desaturated', 'Crime'],
    curve: 'dark',
    cast: 'blue',
    sat: 0.7,
    tex: 'grain',
    texAdd: { vignette: 0.34 },
  },
  {
    id: 'clinical',
    name: 'Clinical',
    family: 'Cool',
    note: 'White, clean, almost no colour',
    tags: ['Clean', 'White', 'Cool'],
    curve: 'bright',
    cast: 'cool',
    sat: 0.55,
    tex: 'clean',
  },
  {
    id: 'moonlight',
    name: 'Moonlight',
    family: 'Cool',
    note: 'Blue night, silver highlights, soft edges',
    tags: ['Blue', 'Night', 'Soft'],
    curve: 'dark',
    cast: 'blue',
    sat: 0.6,
    tex: 'soft',
  },
  {
    id: 'ice-blue',
    name: 'Ice blue',
    family: 'Cool',
    note: 'Pale cyan high key',
    tags: ['Cyan', 'High key', 'Pale'],
    curve: 'bright',
    cast: 'cyan',
    sat: 0.8,
    tex: 'soft',
  },

  /* — pastel & dream — */
  {
    id: 'y2k-dream',
    name: 'Y2K dream',
    family: 'Pastel',
    note: 'Peach and pink, halation, soft focus',
    tags: ['Y2K', 'Peach', 'Halation'],
    curve: 'soft',
    cast: 'warm',
    sat: 1.15,
    hues: [[20, 2, 3]],
    tex: 'bloom',
    texAdd: { diffuse: 0.45, bloom: 0.25 },
  },
  {
    id: 'peach-fuzz',
    name: 'Peach fuzz',
    family: 'Pastel',
    note: 'Pastel peach, barely there',
    tags: ['Peach', 'Pastel', 'Soft'],
    curve: 'soft',
    cast: 'rose',
    sat: 0.85,
    tex: 'soft',
  },
  {
    id: 'lilac-haze',
    name: 'Lilac haze',
    family: 'Pastel',
    note: 'Lavender haze, low contrast, dream logic',
    tags: ['Lilac', 'Haze', 'Low'],
    curve: 'matte',
    cast: 'magenta',
    sat: 0.9,
    tex: 'soft',
  },
  {
    id: 'milk-glass',
    name: 'Milk glass',
    family: 'Pastel',
    note: 'White bloom over everything, no edges',
    tags: ['Milky', 'Bloom', 'Airy'],
    curve: 'bright',
    cast: 'none',
    sat: 0.8,
    tex: 'bloom',
    texAdd: { blur: 0.28, diffuse: 0.6 },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    family: 'Pastel',
    note: 'Pink blossom, cream skin, spring light',
    tags: ['Pink', 'Cream', 'Spring'],
    curve: 'soft',
    cast: 'rose',
    sat: 1.0,
    tex: 'film',
  },

  /* — decay & tape — */
  {
    id: 'vhs',
    name: 'VHS',
    family: 'Decay',
    note: 'Tape softness, cyan and magenta bleed',
    tags: ['Tape', 'Bleed', 'Soft'],
    curve: 'matte',
    cast: 'magenta',
    sat: 1.05,
    hues: [[195, -2, -1]],
    tex: 'soft',
    // tape: soft sideways, colour smeared wider still, red off-register,
    // a faint raster and coloured noise (measured off the bench's tape frames)
    texAdd: { grain: 0, blur: 0.06, softX: 0.0042, softY: 0.0014, bleed: 0.009, shift: 0.0025, scan: 0.1, scanPeriod: 0.0042, grainAmount: 0.013, grainChroma: 0.016, grainCell: 0.003 },
  },
  {
    id: 'dv-cam',
    name: 'DV cam',
    family: 'Decay',
    note: 'Early digital: hard, green, noisy',
    tags: ['Digital', 'Green', 'Hard'],
    curve: 'hard',
    cast: 'green',
    sat: 0.95,
    tex: 'grain',
    texAdd: { grain: 0, softX: 0.0016, softY: 0.0016, bleed: 0.004, fringe: 0.003, grainAmount: 0.006, grainChroma: 0.012, grainCell: 0.002 },
  },
  {
    id: 'hi8',
    name: 'Hi8',
    family: 'Decay',
    note: 'Home tape: warm, soft, noisy',
    tags: ['Tape', 'Warm', 'Noisy'],
    curve: 'matte',
    cast: 'amber',
    sat: 0.9,
    tex: 'soft',
    texAdd: { grain: 0, blur: 0.08, softX: 0.003, softY: 0.0012, bleed: 0.006, shift: 0.0012, scan: 0.05, scanPeriod: 0.004, grainAmount: 0.011, grainChroma: 0.01, grainCell: 0.0025 },
  },
  {
    id: 'horror-green',
    name: 'Horror green',
    family: 'Decay',
    note: 'Sickly green, crushed blacks, clinical dread',
    tags: ['Green', 'Crushed', 'Dread'],
    curve: 'dark',
    cast: 'green',
    sat: 0.85,
    tex: 'grain',
    texAdd: { vignette: 0.42 },
  },
  {
    id: 'rust',
    name: 'Rust',
    family: 'Decay',
    note: 'Oxide orange, decayed blacks, corroded light',
    tags: ['Orange', 'Rust', 'Dark'],
    curve: 'dark',
    cast: 'amber',
    sat: 0.85,
    tex: 'print',
  },
];

export const FAMILIES = ['All', ...Array.from(new Set(STYLES.map((s) => s.family)))];
export const STYLE_BY_ID = new Map(STYLES.map((s) => [s.id, s]));
export const styleById = (id) => STYLE_BY_ID.get(id) || null;

/* ---------- compile a recipe into a look ---------- */

const hex = (rgb) =>
  `#${rgb
    .map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0'))
    .join('')}`;

const SWATCH_L = [22, 54, 86];
const SWATCH_BAND = [0, 2, 4];

export function swatchesFor(casts, mono) {
  return SWATCH_L.map((L, i) => {
    const [a, b] = mono && mono.present ? [mono.tint[0] * 0.9, mono.tint[1] * 0.9] : casts[SWATCH_BAND[i]];
    return hex(labToRgb([L, a * 1.7, b * 1.7]));
  });
}

const compiled = new Map();

export function compileStyle(style) {
  if (compiled.has(style.id)) return compiled.get(style.id);
  const casts = (CAST[style.cast] || CAST.none).map((c) => [c[0], c[1]]);
  const mono = style.mono
    ? { present: true, pure: style.mono.pure !== false, tint: style.mono.tint || [0, 0] }
    : { present: false, pure: false, tint: [0, 0] };
  const look = {
    curve: makeTable(CURVE[style.curve] || CURVE.film),
    casts,
    saturation: mono.present ? 0 : style.sat ?? 1,
    bleach: style.bleach || 0,
    mono,
    sectors: (style.hues || []).map(([center, da, db]) => ({ center, da, db, dL: 0, weight: style.hueWeight ?? 0.55 })),
    skin: { present: false, base: [14, 22], shift: [0, 0], dL: 0 },
    sky: { present: false, base: [-8, -24], shift: [0, 0], dL: 0 },
    texture: { ...TEX[style.tex || 'film'], ...(style.texAdd || {}) },
    meta: {
      name: style.name,
      tags: (style.tags || []).slice(),
      swatches: swatchesFor(casts, mono),
      references: 0,
      monochrome: mono.present,
      styleId: style.id,
      note: style.note,
      family: style.family,
    },
  };
  compiled.set(style.id, look);
  return look;
}

/* ---------- scoring against a reference profile ---------- */

export function scoreStyle(style, profile) {
  if (!profile || !profile.q) return 0;
  const look = compileStyle(style);
  let tone = 0;
  for (let i = 2; i <= 30; i += 2) {
    const x = profile.q[i];
    tone += Math.abs(curveAt(look.curve, x) - x);
  }
  tone /= 15;

  let cast = 0;
  for (let b = 0; b < 5; b++) {
    const ref = profile.casts?.[b] || [0, 0];
    cast += Math.hypot(look.casts[b][0] - ref[0], look.casts[b][1] - ref[1]);
  }
  cast /= 5 * 26;

  const lookChroma = look.mono.present ? 0 : look.saturation * 24;
  const refChroma = profile.mono?.present ? 0 : profile.chroma || 0;
  const chroma = Math.abs(lookChroma - refChroma) / 40;

  const refTex = profile.texture || { grain: 0, glow: 0, blur: 0 };
  const tex =
    (Math.abs(look.texture.grain - (refTex.grain || 0)) +
      Math.abs(look.texture.glow - (refTex.glow || 0)) +
      Math.abs(look.texture.blur - (refTex.blur || 0))) /
    3;

  const monoPen = look.mono.present !== !!profile.mono?.present ? 0.55 : 0;
  return clamp(1 - (tone * 1.5 + cast * 0.65 + chroma * 0.5 + tex * 0.35 + monoPen));
}

export function matchStyles(profile, limit = 8) {
  return STYLES.map((style) => ({ style, score: scoreStyle(style, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
