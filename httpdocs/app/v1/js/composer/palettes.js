/*
 * palettes.js — ideal wire palettes and the queries that depend on them.
 *
 * Split out of render.js so model.js can ask which ink is lightest without
 * importing the renderer (render.js imports model.js, so the reverse would be
 * a cycle).
 */

/** Ideal wire palettes, index order = dither palette order per scheme. These
 *  are the canonical values the encoder classifies exactly (proven
 *  byte-identical to py-opendisplay in tests/webapp). */
export const IDEAL_PALETTES = {
  0: [[0, 0, 0], [255, 255, 255]],
  1: [[0, 0, 0], [255, 255, 255], [255, 0, 0]],
  2: [[0, 0, 0], [255, 255, 255], [255, 255, 0]],
  3: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0]],
  4: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0]],
  5: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]],
  6: Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17]),
  8: [[0, 0, 0], [255, 255, 255], [255, 255, 0], [255, 0, 0], [0, 0, 255], [0, 255, 0]],
};

export function paletteFor(colorScheme) {
  const p = IDEAL_PALETTES[colorScheme];
  if (!p) throw new Error(`unsupported color scheme ${colorScheme}`);
  return p;
}

/** Relative luminance 0..1 of a palette entry. */
export function luma([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Darkest ink in a scheme — index 0 in every supported palette. */
export function darkestIndex() {
  return 0;
}

/**
 * Lightest ink. NOT always index 1: the grey schemes run dark→light, so white
 * is the LAST entry there (index 1 is dark grey, which would make a useless
 * QR quiet zone or page background).
 */
export function lightestIndex(scheme) {
  const p = paletteFor(scheme);
  let best = 0;
  for (let i = 1; i < p.length; i++) if (luma(p[i]) > luma(p[best])) best = i;
  return best;
}

/** Nearest ink in `scheme` to an RGB triple (Euclidean). */
export function nearestIndex(scheme, rgb) {
  const p = paletteFor(scheme);
  let best = 0;
  let bestDist = Infinity;
  p.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

/** Minimum module-vs-quiet-zone luminance gap for a scannable QR. */
export const QR_MIN_CONTRAST = 0.4;
