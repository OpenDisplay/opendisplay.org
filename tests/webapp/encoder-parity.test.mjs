// M-S spike (a): encoder byte-parity proof for the Web OD App plan.
//
// Claim under test: painting wasm-dithered palette indices back onto a canvas
// as exact ideal-palette RGB, then calling the UNMODIFIED ble-common.js
// encodeCanvasToByteData(), produces bytes identical to py-opendisplay's
// packing (the Python sender that real devices already accept).
//
// Run: node --test tests/webapp/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBleInstance,
  makeFakeCanvas,
} from './lib/load-ble-common.mjs';
import {
  refMono,
  refBwr,
  refBwy,
  refBwry,
  bwryCodes,
  refBwgbry,
  refBwgbrySplit,
  refGray4,
  gray4Codes,
  refGray16,
} from './lib/reference-encoders.mjs';
import {
  PAINT_PALETTES,
  makeIndices,
  paintRgba,
  canvasFromNative,
} from './lib/fixtures.mjs';

const ble = makeBleInstance();

// Panel geometries: byte-aligned, odd width (row padding), and the real
// 122-wide EP213 case the library's own comments call out.
const SIZES = [
  [16, 8],
  [13, 7],
  [122, 6],
];
const ROTATIONS = [0, 1, 2, 3];

const REFS = {
  0: (idx, w, h) => refMono(idx, w, h),
  1: (idx, w, h) => refBwr(idx, w, h),
  2: (idx, w, h) => refBwy(idx, w, h),
  3: (idx, w, h) => refBwry(idx, w, h, bwryCodes(null)),
  4: (idx, w, h) => refBwgbry(idx, w, h),
  5: (idx, w, h, panelIcType) => refGray4(idx, w, h, gray4Codes(panelIcType)),
  6: (idx, w, h) => refGray16(idx, w, h),
  8: (idx, w, h) => refBwgbrySplit(idx, w, h),
};

function encodeViaBle(nativeIdx, nativeW, nativeH, scheme, rotation, panelIcType = null, alpha = 255) {
  const { indices, w, h } = canvasFromNative(nativeIdx, nativeW, nativeH, rotation);
  const rgba = paintRgba(indices, PAINT_PALETTES[scheme], { alpha });
  const canvas = makeFakeCanvas(w, h, rgba);
  const bytes = ble.encodeCanvasToByteData(canvas, scheme, rotation, nativeW, nativeH, panelIcType);
  return Uint8Array.from(bytes);
}

for (const scheme of [0, 1, 2, 3, 4, 5, 6, 8]) {
  const paletteSize = PAINT_PALETTES[scheme].length;
  for (const [w, h] of SIZES) {
    for (const rotation of ROTATIONS) {
      test(`scheme ${scheme} ${w}x${h} rot ${rotation}: ble-common matches python reference`, () => {
        const native = makeIndices(w, h, paletteSize, scheme * 1000 + w * 10 + rotation);
        const expected = REFS[scheme](native, w, h, null);
        const actual = encodeViaBle(native, w, h, scheme, rotation);
        assert.deepEqual(actual, expected);
      });
    }
  }
}

test('scheme 5 gray LUT v2 (panelIcType 0x28 and 0x48) matches reference', () => {
  for (const panel of [0x28, 0x48]) {
    const native = makeIndices(13, 7, 4, 500 + panel);
    const expected = refGray4(native, 13, 7, gray4Codes(panel));
    const actual = encodeViaBle(native, 13, 7, 5, 0, panel);
    assert.deepEqual(actual, expected, `panel 0x${panel.toString(16)}`);
  }
});

test('scheme 5 base LUT differs from v2 (LUT actually exercised)', () => {
  const native = makeIndices(16, 8, 4, 42);
  assert.notDeepEqual(
    refGray4(native, 16, 8, gray4Codes(null)),
    refGray4(native, 16, 8, gray4Codes(0x28)),
  );
});

test('encoder ignores alpha: alpha 0 encodes same as alpha 255 (hazard is compositing, not encoding)', () => {
  const native = makeIndices(16, 8, 6, 7);
  assert.deepEqual(
    encodeViaBle(native, 16, 8, 4, 0, null, 0),
    encodeViaBle(native, 16, 8, 4, 0, null, 255),
  );
});

// KNOWN PARITY GAP (documented, not a harness bug): py-opendisplay swaps
// yellow/red wire codes for BWRY panels 0x1D/0x1E (u8Colors_4clr), while
// ble-common's scheme-3 encoder ignores panelIcType. The app-side remedy under
// the no-modification constraint: paint yellow<->red swapped for those panels
// so the fixed encoder emits the panel-native codes.
test('BWRY panel 0x1D: raw ble-common output MISMATCHES python (documents the gap)', () => {
  const native = makeIndices(16, 8, 4, 99);
  const expected = refBwry(native, 16, 8, bwryCodes(0x1d));
  const actual = encodeViaBle(native, 16, 8, 3, 0, 0x1d);
  assert.notDeepEqual(actual, expected);
});

for (const panel of [0x1d, 0x1e]) {
  for (const rotation of ROTATIONS) {
    test(`BWRY panel 0x${panel.toString(16)} rot ${rotation} odd width: paint-swap restores byte parity`, () => {
      const native = makeIndices(13, 7, 4, 99 + panel + rotation);
      const expected = refBwry(native, 13, 7, bwryCodes(panel));
      // Swap the painted colors for indices 2 (yellow) and 3 (red): the encoder
      // then classifies swapped names and stores the panel-native codes. The
      // swap belongs in the send-canvas RGB lookup only — canonical indices
      // and the preview stay unswapped.
      const swapped = native.map((i) => (i === 2 ? 3 : i === 3 ? 2 : i));
      const actual = encodeViaBle(swapped, 13, 7, 3, rotation, panel);
      assert.deepEqual(actual, expected);
    });
  }
}

// Structured fixtures: every palette entry exercised in order, constant frames,
// and a full EP213-sized frame with exact output lengths.
for (const scheme of [0, 1, 2, 3, 4, 5, 6, 8]) {
  const paletteSize = PAINT_PALETTES[scheme].length;
  test(`scheme ${scheme}: palette-cycling, all-zero, all-max fixtures match`, () => {
    const w = 13;
    const h = 7;
    const cycle = Array.from({ length: w * h }, (_, i) => i % paletteSize);
    const zeros = new Array(w * h).fill(0);
    const maxed = new Array(w * h).fill(paletteSize - 1);
    for (const native of [cycle, zeros, maxed]) {
      assert.deepEqual(
        encodeViaBle(native, w, h, scheme, 0),
        REFS[scheme](native, w, h, null),
      );
    }
  });
}

test('EP213 full frame 122x250: mono and BWR lengths and bytes match', () => {
  const mono = makeIndices(122, 250, 2, 213);
  const monoBytes = encodeViaBle(mono, 122, 250, 0, 0);
  assert.equal(monoBytes.length, Math.ceil(122 / 8) * 250); // 16 bytes/row, row-padded
  assert.deepEqual(monoBytes, refMono(mono, 122, 250));

  const bwr = makeIndices(122, 250, 3, 214);
  const bwrBytes = encodeViaBle(bwr, 122, 250, 1, 0);
  assert.equal(bwrBytes.length, Math.ceil(122 / 8) * 250 * 2);
  assert.deepEqual(bwrBytes, refBwr(bwr, 122, 250));
});

test('EP213 122x250 rotated canvas (250x122) recovers native frame', () => {
  const native = makeIndices(122, 250, 2, 215);
  assert.deepEqual(encodeViaBle(native, 122, 250, 0, 1), refMono(native, 122, 250));
});

// Fail-open evidence for the adapter's hard-reject rule: scheme 7 silently
// falls through to the monochrome branch instead of erroring.
test('scheme 7 falls through to mono encoding (adapter MUST reject before encode)', () => {
  const native = makeIndices(16, 8, 2, 3);
  const rgba = paintRgba(native, PAINT_PALETTES[0]);
  const canvas = makeFakeCanvas(16, 8, rgba);
  const bytes = Uint8Array.from(ble.encodeCanvasToByteData(canvas, 7, 0, 16, 8, null));
  assert.deepEqual(bytes, refMono(native, 16, 8));
});
