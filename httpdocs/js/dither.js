// OpenDisplay dithering front-end for @opendisplay/epaper-dithering (Rust/WASM core).
// Publishes window.OpenDisplayDither and fires 'opendisplay-dither-ready' once loaded.
import {
  ditherImage,
  ColorScheme,
  DitherMode,
  getPalette,
  SPECTRA_7_3_6COLOR,
  SPECTRA_7_3_6COLOR_V2,
  BWRY_3_97,
  BWRY_4_2,
  MONO_4_26,
  SOLUM_BWR,
  HANSHOW_BWR,
  HANSHOW_BWY,
  VERSION,
} from './vendor/epaper-dithering.js';

const MODES = [
  { value: 'auto', label: 'Auto', mode: null },
  { value: 'none', label: 'None — direct map', mode: DitherMode.NONE },
  { value: 'ordered', label: 'Ordered — Bayer 4x4', mode: DitherMode.ORDERED },
  { value: 'floyd-steinberg', label: 'Floyd-Steinberg', mode: DitherMode.FLOYD_STEINBERG },
  { value: 'burkes', label: 'Burkes', mode: DitherMode.BURKES },
  { value: 'atkinson', label: 'Atkinson', mode: DitherMode.ATKINSON },
  { value: 'stucki', label: 'Stucki', mode: DitherMode.STUCKI },
  { value: 'sierra', label: 'Sierra', mode: DitherMode.SIERRA },
  { value: 'sierra-lite', label: 'Sierra Lite', mode: DitherMode.SIERRA_LITE },
  { value: 'jarvis-judice-ninke', label: 'Jarvis-Judice-Ninke', mode: DitherMode.JARVIS_JUDICE_NINKE },
  { value: 'dizzy', label: 'Dizzy — pseudo-random', mode: DitherMode.DIZZY },
];
const MODE_BY_VALUE = new Map(MODES.map((m) => [m.value, m]));

// Measured palettes, keyed for the UI. `scheme` is the canonical firmware wire value.
const MEASURED = [
  { id: 'spectra73v2', label: 'Spectra 7.3" 6-color v2', scheme: 4, palette: SPECTRA_7_3_6COLOR_V2 },
  { id: 'spectra73', label: 'Spectra 7.3" 6-color', scheme: 4, palette: SPECTRA_7_3_6COLOR },
  { id: 'bwry397', label: 'BWRY 3.97" 800x480', scheme: 3, palette: BWRY_3_97 },
  { id: 'bwry42', label: 'BWRY 4.2"', scheme: 3, palette: BWRY_4_2 },
  { id: 'mono426', label: 'Mono 4.26"', scheme: 0, palette: MONO_4_26 },
  { id: 'solumbwr', label: 'Solum BWR', scheme: 1, palette: SOLUM_BWR },
  { id: 'hanshowbwr', label: 'Hanshow BWR', scheme: 1, palette: HANSHOW_BWR },
  { id: 'hanshowbwy', label: 'Hanshow BWY', scheme: 2, palette: HANSHOW_BWY },
];
const MEASURED_BY_ID = new Map(MEASURED.map((m) => [m.id, m]));

// panel_ic_type + color_scheme -> measured palette id.
// Mirrors DISPLAY_PALETTE_MAP in py-opendisplay/src/opendisplay/display_palettes.py.
const PANEL_PALETTES = new Map([
  ['35:4', 'spectra73'],
  ['39:0', 'mono426'],
  ['33:1', 'solumbwr'],
  ['55:3', 'bwry397'],
]);

// Palette index -> value written on the wire, per color scheme.
// Index order comes from the library palette (black, white, yellow, red, blue, green...).
// Schemes 1/2 encode a 2-bit code: bit0 = plane1, bit1 = plane2.
const GRAY4_LUT = [3, 1, 2, 0];
const GRAY4_LUT_V2 = [3, 2, 1, 0];
const GRAY4_PANELS_V2 = new Set([0x28, 0x48]);
const BWRY_CODES = [0, 1, 2, 3];
const BWRY_CODES_SWAPPED = [0, 1, 3, 2];
const BWRY_PANELS_SWAPPED = new Set([0x1d, 0x1e]);
const IDENTITY_16 = Array.from({ length: 16 }, (_, i) => i);

/**
 * Palette-index to wire-value table for a scheme, honouring per-panel quirks.
 * @param {number} scheme Firmware color scheme (0-8)
 * @param {number|null} panelIcType Panel IC type, or null when unknown
 * @returns {number[]}
 */
function wireMap(scheme, panelIcType = null) {
  const panel = panelIcType != null ? Number(panelIcType) : NaN;
  switch (Number(scheme)) {
    case 0: return [0, 1];
    case 1: return [0, 1, 3];
    case 2: return [0, 1, 2];
    case 3: return BWRY_PANELS_SWAPPED.has(panel) ? BWRY_CODES_SWAPPED : BWRY_CODES;
    case 4:
    case 8: return [0, 1, 2, 3, 5, 6];
    case 5: return GRAY4_PANELS_V2.has(panel) ? GRAY4_LUT_V2 : GRAY4_LUT;
    case 6: return IDENTITY_16;
    case 7: return [0, 1, 2, 3, 4, 5, 6];
    default: return IDENTITY_16;
  }
}

/**
 * Scheme 8 (bwgbry_split) is Spectra 6 with split half-plane packing: same inks,
 * same palette index order, only the wire layout differs. Measured palettes are
 * therefore shared with scheme 4.
 * @param {number} scheme
 * @returns {number}
 */
function canonicalScheme(scheme) {
  return Number(scheme) === 8 ? 4 : Number(scheme);
}

/**
 * Measured palette for a connected panel, or null when none is calibrated.
 * @param {number|null} panelIcType
 * @param {number} scheme
 */
function paletteForPanel(panelIcType, scheme) {
  if (panelIcType == null) return null;
  const id = PANEL_PALETTES.get(`${Number(panelIcType)}:${canonicalScheme(scheme)}`);
  return id ? MEASURED_BY_ID.get(id) : null;
}

/** Ideal sRGB colors for a scheme, in palette-index order. */
function idealPalette(scheme) {
  return Object.values(getPalette(Number(scheme)).colors);
}

/** Human-readable color names for a scheme, in palette-index order. */
function paletteNames(scheme) {
  return Object.keys(getPalette(Number(scheme)).colors);
}

/**
 * Choose an algorithm for "Auto" by sniffing image content. Flat graphics quantise
 * cleanly with a direct map; continuous tone needs error diffusion.
 * Tone and gamut stay under the caller's control so their sliders remain live.
 * @param {ImageData} imageData
 * @returns {{mode:number,serpentine:boolean}}
 */
function pickAuto(imageData) {
  const data = imageData.data;
  const total = imageData.width * imageData.height;
  const step = Math.max(1, Math.floor(total / 20000));
  const seen = new Set();
  for (let i = 0; i < total; i += step) {
    const p = i * 4;
    // 5 bits per channel is coarse enough to ignore JPEG noise but keeps flat art distinct.
    seen.add(((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3));
    if (seen.size > 24) break;
  }
  return seen.size <= 24
    ? { mode: DitherMode.NONE, serpentine: false }
    : { mode: DitherMode.BURKES, serpentine: true };
}

/**
 * Dither an ImageData buffer.
 * @param {ImageData|{width:number,height:number,data:Uint8ClampedArray}} imageData
 * @param {object} opts
 * @param {number} opts.scheme Firmware color scheme (0-8)
 * @param {number|null} [opts.panelIcType]
 * @param {string} [opts.mode] Mode value from MODES ('auto' by default)
 * @param {string} [opts.paletteId] 'auto' | 'ideal' | measured palette id
 * @param {boolean} [opts.realistic] Preview using measured RGB instead of ideal
 * @returns {{indices:Uint8Array,preview:Array,wireMap:number[],ms:number,modeValue:string,measuredId:string|null,counts:Uint32Array,names:string[]}}
 */
function dither(imageData, opts = {}) {
  const scheme = Number(opts.scheme ?? 0);
  const panelIcType = opts.panelIcType ?? null;

  const paletteId = opts.paletteId || 'auto';
  let measured = null;
  if (paletteId === 'auto') {
    measured = paletteForPanel(panelIcType, scheme);
  } else if (paletteId !== 'ideal') {
    const chosen = MEASURED_BY_ID.get(paletteId);
    if (chosen && chosen.scheme === canonicalScheme(scheme)) measured = chosen;
  }

  const modeValue = opts.mode || 'auto';
  const auto = modeValue === 'auto' ? pickAuto(imageData) : null;
  const entry = MODE_BY_VALUE.get(modeValue);
  const mode = auto ? auto.mode : (entry ? entry.mode : DitherMode.BURKES);

  const settings = {
    mode,
    serpentine: auto ? auto.serpentine : opts.serpentine !== false,
    exposure: num(opts.exposure, 1),
    saturation: num(opts.saturation, 1),
    shadows: num(opts.shadows, 0),
    highlights: num(opts.highlights, 0),
    tone: opts.tone ?? 'auto',
    gamut: opts.gamut ?? 'auto',
  };

  const started = performance.now();
  const result = ditherImage(
    { width: imageData.width, height: imageData.height, data: imageData.data },
    measured ? measured.palette : Number(scheme),
    settings,
  );
  const ms = performance.now() - started;

  const ideal = idealPalette(scheme);
  const preview = (measured && opts.realistic) ? result.palette : ideal;

  const counts = new Uint32Array(result.palette.length);
  for (let i = 0; i < result.indices.length; i++) counts[result.indices[i]]++;

  return {
    indices: result.indices,
    preview,
    wireMap: wireMap(scheme, panelIcType),
    ms,
    modeValue: auto ? modeLabelFor(mode) : modeValue,
    measuredId: measured ? measured.id : null,
    counts,
    names: paletteNames(scheme),
  };
}

function modeLabelFor(mode) {
  const found = MODES.find((m) => m.mode === mode);
  return found ? found.value : 'burkes';
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Paint palette indices onto a canvas context using the given preview colors. */
function paint(ctx, width, height, indices, preview) {
  const out = ctx.createImageData(width, height);
  const data = out.data;
  for (let i = 0; i < indices.length; i++) {
    const c = preview[indices[i]] || preview[0];
    const p = i * 4;
    data[p] = c.r;
    data[p + 1] = c.g;
    data[p + 2] = c.b;
    data[p + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

window.OpenDisplayDither = {
  VERSION,
  MODES,
  MEASURED,
  ColorScheme,
  DitherMode,
  dither,
  paint,
  wireMap,
  canonicalScheme,
  paletteForPanel,
  idealPalette,
  paletteNames,
  pickAuto,
};
window.dispatchEvent(new Event('opendisplay-dither-ready'));
