// OpenDisplay dithering front-end for @opendisplay/epaper-dithering (Rust/WASM core).
// Publishes window.OpenDisplayDither and fires 'opendisplay-dither-ready' once loaded.
import { ditherImage, DitherMode, Palette, VERSION } from './vendor/epaper-dithering.js';

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

// epaper-dithering 7 ships no palettes. These files are copied from py-opendisplay
// (src/opendisplay/palettes/), which owns them; tests/drift.test.js keeps them equal.
// Entry order is the palette-index order wireMap() and the encoders expect.
async function loadPalette(file) {
  const res = await fetch(new URL(`./vendor/palettes/${file}`, import.meta.url));
  if (!res.ok) throw new Error(`palette ${file}: HTTP ${res.status}`);
  return Palette.fromJson(await res.text());
}

// Idealised palette per firmware colour scheme. Mirrors IDEAL_PALETTE_FILES in
// py-opendisplay/src/opendisplay/display_palettes.py.
const IDEAL_FILES = {
  0: 'ideal_mono.json',
  1: 'ideal_bwr.json',
  2: 'ideal_bwy.json',
  3: 'ideal_bwry.json',
  4: 'ideal_bwgbry.json',
  5: 'ideal_grayscale_4.json',
  6: 'ideal_grayscale_16.json',
  7: 'ideal_seven_color.json',
  8: 'ideal_bwgbry.json', // same inks as 4; only the plane packing differs
};

// Measured palettes, keyed for the UI. `scheme` is the canonical firmware wire value.
const MEASURED_FILES = [
  { id: 'spectra73v2', label: 'Spectra 7.3" 6-color', scheme: 4, file: 'spectra6_7in3_v2.json' },
  { id: 'bwry397', label: 'BWRY 3.97" 800x480', scheme: 3, file: 'ep397yr_bwry.json' },
];

// panel_ic_type + color_scheme -> measured palette id.
// Mirrors MEASURED_PALETTE_FILES in py-opendisplay/src/opendisplay/display_palettes.py.
const PANEL_PALETTES = new Map([
  ['35:4', 'spectra73v2'],
  ['66:8', 'spectra73v2'], // 13.3" Spectra 6, borrows the 7.3" measurement
  ['55:3', 'bwry397'],
]);

const files = [...new Set([...Object.values(IDEAL_FILES), ...MEASURED_FILES.map((m) => m.file)])];
const loaded = new Map(await Promise.all(files.map(async (f) => [f, await loadPalette(f)])));
const IDEAL = new Map(Object.entries(IDEAL_FILES).map(([s, f]) => [Number(s), loaded.get(f)]));
const MEASURED = MEASURED_FILES.map(({ file, ...m }) => ({ ...m, palette: loaded.get(file) }));
const MEASURED_BY_ID = new Map(MEASURED.map((m) => [m.id, m]));

// Palette index -> value written on the wire, per color scheme.
// Index order comes from the palette files (black, white, yellow, red, blue, green...).
// Schemes 1/2 encode a 2-bit code: bit0 = plane1, bit1 = plane2.
const GRAY4_LUT = [3, 1, 2, 0];
const GRAY4_LUT_V2 = [3, 2, 1, 0];
const GRAY4_PANELS_V2 = new Set([0x28, 0x48]);
const BWRY_CODES = [0, 1, 2, 3];
const BWRY_CODES_SWAPPED = [0, 1, 3, 2];
const BWRY_PANELS_SWAPPED = new Set([0x1d, 0x1e]);
const IDENTITY_16 = Array.from({ length: 16 }, (_, i) => i);

// BWRY driven multi-pass for 16 colours. Packing is identical to scheme 3
// (2bpp, one plane); the extra colours come from one frame PER PASS, so a
// pixel's colour is set by its code in every pass.
const BWRY16 = 10;

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
    // Scheme 10's "wire value" is the PALETTE INDEX, not a panel code: the
    // multi-pass encoder looks each index up in the device's per-pass code
    // triples (config packet 0xB0) to build one frame per pass. Mapping it
    // here would corrupt that lookup, so the table stays identity.
    case BWRY16: return IDENTITY_16;
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
 * Build a library Palette from a device's measured multi-pass palette.
 *
 * This is the path scheme 10 takes instead of a scheme table. The colours are
 * PER-UNIT -- two same-part-number 2.9" panels differ by dE00 6.40, and a
 * palette tuned on one measured 19% worse on the other -- so there is no
 * correct static table to fall back to. The device carries its own in config
 * packet 0xB0, and that is what must be dithered against.
 *
 * The entries stay unnamed: they are blended pigment states from several
 * passes, not inks, so there is no nominal colour to snap or anchor to.
 *
 * @param {number[][]} lab CIELAB D65, media-relative (paper white = L* 100), in
 *   palette-index order -- what extractDriveModes() reads from 0xB0
 * @returns {Palette}
 */
function devicePaletteToPalette(lab) {
  if (!Array.isArray(lab) || lab.length < 2) {
    throw new Error(`device palette needs at least 2 colours, got ${lab ? lab.length : 0}`);
  }
  return new Palette(lab.map(([L, a, b]) => ({ appearance: [L, a, b] })), true);
}

/**
 * Measured palette for a connected panel, or null when none is measured.
 * @param {number|null} panelIcType
 * @param {number} scheme
 */
function paletteForPanel(panelIcType, scheme) {
  if (panelIcType == null) return null;
  const id = PANEL_PALETTES.get(`${Number(panelIcType)}:${Number(scheme)}`);
  return id ? MEASURED_BY_ID.get(id) : null;
}

function idealFor(scheme) {
  const palette = IDEAL.get(Number(scheme));
  if (!palette) throw new Error(`no palette for colour scheme ${scheme}`);
  return palette;
}

/**
 * Ideal sRGB colors for a scheme, in palette-index order.
 *
 * `devicePalette` is required for scheme 10 and ignored otherwise: there is no
 * honest static default for it (see devicePaletteToPalette).
 * @param {number} scheme
 * @param {number[][]} [devicePalette] Device Lab, as for devicePaletteToPalette
 */
function idealPalette(scheme, devicePalette = null) {
  if (Number(scheme) === BWRY16) {
    if (!devicePalette) {
      throw new Error(
        'colour scheme 10 (bwry16) has no ideal palette: its 16 colours are ' +
        'per-unit and must be read from the device (config packet 0xB0)',
      );
    }
    return devicePaletteToPalette(devicePalette).previewRgb();
  }
  return idealFor(scheme).previewRgb();
}

/**
 * Human-readable color names for a scheme, in palette-index order.
 * @param {number} scheme
 * @param {number} [count] Entry count, for scheme 10
 */
function paletteNames(scheme, count = 16) {
  // e0..eN rather than invented hues: these are blended pigment states, not
  // inks, and most are near-neutral. Naming them would imply a gamut BWRY does
  // not have -- it has no green or blue pigment at all.
  if (Number(scheme) === BWRY16) {
    return Array.from({ length: count }, (_, i) => `e${i}`);
  }
  return idealFor(scheme).entries.map((e) => e.name);
}

/**
 * Choose an algorithm for "Auto" by sniffing image content. Flat graphics quantise
 * cleanly with a direct map; continuous tone needs error diffusion.
 * Tone and gamut stay under the caller's control so their sliders remain live.
 * @param {ImageData} imageData
 * @returns {{mode:string,serpentine:boolean}}
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
 * @param {number} opts.scheme Firmware color scheme (0-8, or 10 with devicePalette)
 * @param {number|null} [opts.panelIcType]
 * @param {string} [opts.mode] Mode value from MODES ('auto' by default)
 * @param {string} [opts.paletteId] 'auto' | 'ideal' | measured palette id
 * @param {boolean} [opts.realistic] Preview using measured colours instead of ideal
 * @param {number} [opts.tone] Black-point lift, 0 (off) to 1
 * @param {number} [opts.gamut] Gamut compression, 0 (off) to 1
 * @param {number[][]} [opts.devicePalette] Device Lab for scheme 10
 * @returns {{indices:Uint8Array,preview:Array,wireMap:number[],ms:number,modeValue:string,measuredId:string|null,counts:Uint32Array,names:string[]}}
 */
function dither(imageData, opts = {}) {
  const scheme = Number(opts.scheme ?? 0);
  const panelIcType = opts.panelIcType ?? null;
  const devicePalette = opts.devicePalette || null;

  if (scheme === BWRY16 && !devicePalette) {
    throw new Error(
      'colour scheme 10 (bwry16) needs opts.devicePalette: its 16 colours are ' +
      'per-unit, so they must come from the connected device (config packet ' +
      '0xB0) rather than a built-in table',
    );
  }

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

  const options = {
    mode,
    serpentine: auto ? auto.serpentine : opts.serpentine !== false,
    exposure: num(opts.exposure, 1),
    saturation: num(opts.saturation, 1),
    shadows: num(opts.shadows, 0),
    highlights: num(opts.highlights, 0),
    tone: unit(opts.tone),
    gamut: unit(opts.gamut),
  };

  // A device palette outranks everything: it is a real measurement of THIS
  // unit, where the bundled files are either idealised or measured on a
  // different panel.
  let target;
  if (devicePalette) target = devicePaletteToPalette(devicePalette);
  else if (measured) target = measured.palette;
  else target = idealFor(scheme);

  const started = performance.now();
  const result = ditherImage(
    { width: imageData.width, height: imageData.height, data: imageData.data },
    target,
    options,
  );
  const ms = performance.now() - started;

  // With a device palette the measured colours ARE the honest preview, so
  // there is no idealised alternative to fall back to.
  const preview = (devicePalette || (measured && opts.realistic))
    ? result.palette
    : idealFor(scheme).previewRgb();

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
    names: paletteNames(scheme, result.palette.length),
    devicePaletteUsed: Boolean(devicePalette),
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

/** 0..1 strength; anything else (a 6.x 'auto'/'off' from saved settings) is off. */
function unit(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
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
  DitherMode,
  dither,
  paint,
  wireMap,
  canonicalScheme,
  paletteForPanel,
  idealPalette,
  paletteNames,
  devicePaletteToPalette,
  BWRY16,
  pickAuto,
};
window.dispatchEvent(new Event('opendisplay-dither-ready'));
