// Rotation oracle: hand-authored asymmetric fixtures with EXPECTED CANVAS
// LAYOUTS enumerated by hand, breaking the circularity of deriving fixtures
// from the same formulas the encoder uses (canvasFromNative is checked here
// against the hand layouts before the randomized suites rely on it).
//
// Convention under test (the shipped Display Tool contract): the canvas holds
// the panel's NATIVE image rotated COUNTERCLOCKWISE by `rotation` quarter
// turns; the encoder applies the inverse (clockwise) to recover native order.
//
// Native 3x2 fixture (letters = palette indices 0..5, scheme 4 so every cell
// is distinct under nibble packing):
//
//        x=0 x=1 x=2
//   y=0 [ A   B   C ]      A=0 B=1 C=2
//   y=1 [ D   E   F ]      D=3 E=4 F=5
//
// rotation 1 (canvas = native rotated 90° CCW, 2 wide x 3 tall):
//   right column (C,F) rises to the top row:
//        [ C   F ]
//        [ B   E ]
//        [ A   D ]
//
// rotation 2 (180°):
//        [ F   E   D ]
//        [ C   B   A ]
//
// rotation 3 (canvas = native rotated 90° CW, 2 wide x 3 tall):
//   left column (A,D) rises to the top, reversed:
//        [ D   A ]
//        [ E   B ]
//        [ F   C ]
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBleInstance, makeFakeCanvas } from './lib/load-ble-common.mjs';
import { refBwgbry } from './lib/reference-encoders.mjs';
import { PAINT_PALETTES, paintRgba, canvasFromNative } from './lib/fixtures.mjs';

const [A, B, C, D, E, F] = [0, 1, 2, 3, 4, 5];
const NATIVE = [A, B, C, D, E, F]; // 3x2 row-major
const NATIVE_W = 3;
const NATIVE_H = 2;

const HAND_CANVAS = {
  0: { w: 3, h: 2, indices: [A, B, C, D, E, F] },
  1: { w: 2, h: 3, indices: [C, F, B, E, A, D] },
  2: { w: 3, h: 2, indices: [F, E, D, C, B, A] },
  3: { w: 2, h: 3, indices: [D, A, E, B, F, C] },
};

const ble = makeBleInstance();

for (const rotation of [0, 1, 2, 3]) {
  test(`canvasFromNative matches the hand-enumerated layout (rot ${rotation})`, () => {
    const derived = canvasFromNative(NATIVE, NATIVE_W, NATIVE_H, rotation);
    const hand = HAND_CANVAS[rotation];
    assert.equal(derived.w, hand.w);
    assert.equal(derived.h, hand.h);
    assert.deepEqual(derived.indices, hand.indices);
  });

  test(`encoder recovers native order from the hand layout (rot ${rotation})`, () => {
    const hand = HAND_CANVAS[rotation];
    const rgba = paintRgba(hand.indices, PAINT_PALETTES[4]);
    const canvas = makeFakeCanvas(hand.w, hand.h, rgba);
    const bytes = Uint8Array.from(
      ble.encodeCanvasToByteData(canvas, 4, rotation, NATIVE_W, NATIVE_H, null),
    );
    assert.deepEqual(bytes, refBwgbry(NATIVE, NATIVE_W, NATIVE_H));
  });
}

// Coordinate sentinels: a single set pixel distinguishes row/column transposition
// and MSB/LSB packing mistakes that symmetric fixtures could mask.
test('sentinel pixel (1,0) vs (0,1) land in distinct, correct mono bits', () => {
  const w = 9;
  const h = 3; // odd width: 2 bytes per row
  const at = (x, y) => {
    const native = new Array(w * h).fill(0);
    native[y * w + x] = 1;
    const rgba = paintRgba(native, PAINT_PALETTES[0]);
    return Uint8Array.from(
      ble.encodeCanvasToByteData(makeFakeCanvas(w, h, rgba), 0, 0, w, h, null),
    );
  };
  const p10 = at(1, 0);
  const p01 = at(0, 1);
  // (1,0): row 0, second MSB of byte 0. (0,1): row 1 starts at byte 2 (row-padded).
  assert.equal(p10[0], 0b01000000);
  assert.equal(p10[2], 0);
  assert.equal(p01[0], 0);
  assert.equal(p01[2], 0b10000000);
});
