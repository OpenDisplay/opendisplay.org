// Fixture generation for the encoder-parity spike: deterministic index images,
// ideal-palette paint-back (exactly what the web app's dither.js will paint),
// and the inverse of ble-common's rotation transform so a rotated canvas
// round-trips to a known native-orientation image.

// Deterministic PRNG (LCG) — no Math.random so fixtures are stable.
export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

export function makeIndices(w, h, paletteSize, seed) {
  const rng = makeRng(seed);
  const out = new Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rng() % paletteSize;
  return out;
}

// Ideal paint-back palettes: index order = dither palette order per scheme,
// RGB values = the canonical colors ble-common's detectColor classifies exactly.
export const PAINT_PALETTES = {
  0: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  1: [
    [0, 0, 0],
    [255, 255, 255],
    [255, 0, 0],
  ],
  2: [
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 0],
  ],
  3: [
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 0],
    [255, 0, 0],
  ],
  // BWGBRY dither order: black, white, yellow, red, blue, green
  4: [
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 0],
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ],
  5: [
    [0, 0, 0],
    [85, 85, 85],
    [170, 170, 170],
    [255, 255, 255],
  ],
  6: Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17]),
  8: [
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 0],
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ],
};

export function paintRgba(indices, palette, { alpha = 255 } = {}) {
  const out = new Uint8ClampedArray(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const [r, g, b] = palette[indices[i]];
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = alpha;
  }
  return out;
}

// ble-common's encoder maps canvas (x, y) -> native (dstX, dstY):
//   rotation 1: dstX = canvasH - 1 - y, dstY = x
//   rotation 2: dstX = canvasW - 1 - x, dstY = canvasH - 1 - y
//   rotation 3: dstX = y,               dstY = canvasW - 1 - x
// Given a native-orientation index image (nativeW x nativeH), build the canvas
// image the composer would hold, such that the encoder reproduces the native
// image exactly. For rotations 1/3 the canvas is nativeH x nativeW.
export function canvasFromNative(native, nativeW, nativeH, rotation) {
  if (rotation === 0) {
    return { indices: native, w: nativeW, h: nativeH };
  }
  const canvasW = rotation === 2 ? nativeW : nativeH;
  const canvasH = rotation === 2 ? nativeH : nativeW;
  const canvas = new Array(canvasW * canvasH);
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      let dstX;
      let dstY;
      if (rotation === 1) {
        dstX = canvasH - 1 - y;
        dstY = x;
      } else if (rotation === 2) {
        dstX = canvasW - 1 - x;
        dstY = canvasH - 1 - y;
      } else {
        dstX = y;
        dstY = canvasW - 1 - x;
      }
      canvas[y * canvasW + x] = native[dstY * nativeW + dstX];
    }
  }
  return { indices: canvas, w: canvasW, h: canvasH };
}
