/*
 * dither.js — palette selection and ideal-palette paint-back (plan §6, M3).
 *
 * THE LOAD-BEARING IDEA (proven byte-exact by the M-S(a) spike): the wasm
 * dither returns palette INDICES; painting those back as the exact ideal wire
 * colours makes `ble-common.js`'s nearest-colour classification lossless, so
 * the packed bytes match py-opendisplay without touching the shared library.
 *
 * Preview and send therefore differ deliberately:
 *   preview → MEASURED ink colours (what the panel will really look like)
 *   send    → IDEAL wire colours (what the encoder must classify)
 */
import { paletteFor } from './palettes.js';

/**
 * Measured per-panel palettes, mirroring py-opendisplay's
 * display_palettes.DISPLAY_PALETTE_MAP. Keyed "panelIcType:colorScheme".
 * A panel with no measurement falls back to the ideal ColorScheme.
 */
const MEASURED_PALETTES = {
  '35:4': 'SPECTRA_7_3_6COLOR',    // 7.3" Spectra 6-colour
  '39:0': 'MONO_4_26',             // 4.26" mono
  '33:1': 'SOLUM_BWR',             // Solum 2.6" BWR
  '55:3': 'BWRY_3_97',             // 3.97" BWRY
  '66:8': 'SPECTRA_7_3_6COLOR_V2', // 13.3" dual-controller Spectra 6
};

/**
 * BWRY panels whose native 4-colour code table swaps yellow and red
 * (bb_epaper u8Colors_4clr). py-opendisplay handles this with a code table;
 * `ble-common.js` ignores panelIcType entirely, so the app compensates by
 * painting indices 2 and 3 in each other's colour — the fixed encoder then
 * emits the panel-native codes. Verified byte-exact against Python goldens.
 * See FINDINGS_WEB_OD_APP_SPIKE.md, finding 1.
 */
const BWRY_SWAPPED_PANELS = new Set([0x1d, 0x1e]);

export function needsBwryPaintSwap(colorScheme, panelIcType) {
  return colorScheme === 3 && BWRY_SWAPPED_PANELS.has(Number(panelIcType));
}

/**
 * Choose what to dither against.
 * @returns {{target: any, measured: boolean}} `target` is passed straight to
 *          ditherImage: either a measured ColorPalette or the ColorScheme int.
 */
export function ditherTarget(lib, { colorScheme, panelIcType, useMeasured }) {
  if (useMeasured) {
    const name = MEASURED_PALETTES[`${Number(panelIcType)}:${colorScheme}`];
    if (name && lib[name]) return { target: lib[name], measured: true };
  }
  return { target: colorScheme, measured: false };
}

/**
 * Paint dither indices back as RGBA.
 * @param {Uint8Array} indices  one palette index per pixel
 * @param {number[][]} palette  RGB triples, index order == dither order
 * @param {{swapBwry?: boolean}} opts
 * @returns {Uint8ClampedArray} opaque RGBA
 */
export function paintIndices(indices, palette, { swapBwry = false } = {}) {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    let idx = indices[i];
    if (swapBwry) idx = idx === 2 ? 3 : idx === 3 ? 2 : idx;
    const rgb = palette[idx] ?? palette[0];
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = 255; // opaque: transparency would encode as black
  }
  return out;
}

/** Normalise the library's [{r,g,b}] palette to [[r,g,b]]. */
export function toRgbTriples(palette) {
  return palette.map((c) => (Array.isArray(c) ? c : [c.r, c.g, c.b]));
}

/** RGBA for the on-screen preview: MEASURED inks when we dithered against
 *  them, so the preview shows what the panel will actually look like. */
export function paintPreview(indices, measuredPalette) {
  return paintIndices(indices, measuredPalette, { swapBwry: false });
}

/** RGBA for the send canvas: ALWAYS the ideal wire palette (plus the BWRY
 *  panel swap where the encoder needs it). */
export function paintForSend(indices, colorScheme, panelIcType) {
  return paintIndices(indices, paletteFor(colorScheme), {
    swapBwry: needsBwryPaintSwap(colorScheme, panelIcType),
  });
}
