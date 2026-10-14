// Golden-fixture parity: ble-common's encoder vs bytes produced by EXECUTING
// py-opendisplay's real encoders (tests/webapp/fixtures/golden.json, generated
// by tools/generate_golden.py; the JSON records the py-opendisplay revision).
// This closes the "JS reference vs JS production" gap — the expected bytes here
// never passed through any JavaScript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeBleInstance, makeFakeCanvas } from './lib/load-ble-common.mjs';
import { PAINT_PALETTES, makeIndices, paintRgba } from './lib/fixtures.mjs';

const golden = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden.json'), 'utf8'),
);

const ble = makeBleInstance();

// Golden case name -> how to reproduce it through ble-common. `paintSwap` is
// the app-side BWRY remedy for panels whose native code table swaps yellow/red.
const CASES = {
  mono: { scheme: 0, panelIcType: null },
  bwr: { scheme: 1, panelIcType: null },
  bwy: { scheme: 2, panelIcType: null },
  bwry_default: { scheme: 3, panelIcType: null },
  bwry_0x1d: { scheme: 3, panelIcType: 0x1d, paintSwap: true },
  bwry_0x1e: { scheme: 3, panelIcType: 0x1e, paintSwap: true },
  bwgbry: { scheme: 4, panelIcType: null },
  bwgbry_split: { scheme: 8, panelIcType: null },
  gray4_base: { scheme: 5, panelIcType: null },
  gray4_v2: { scheme: 5, panelIcType: 0x28 },
  gray16: { scheme: 6, panelIcType: null },
};

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

for (const c of golden.cases) {
  const spec = CASES[c.name];
  test(`golden(py-opendisplay@${golden.revision.slice(0, 8)}): ${c.name}`, () => {
    assert.ok(spec, `unmapped golden case ${c.name}`);
    let indices = makeIndices(c.width, c.height, c.paletteSize, c.seed);
    if (spec.paintSwap) {
      indices = indices.map((i) => (i === 2 ? 3 : i === 3 ? 2 : i));
    }
    const rgba = paintRgba(indices, PAINT_PALETTES[spec.scheme]);
    const canvas = makeFakeCanvas(c.width, c.height, rgba);
    const bytes = Uint8Array.from(
      ble.encodeCanvasToByteData(canvas, spec.scheme, 0, c.width, c.height, spec.panelIcType),
    );
    assert.deepEqual(bytes, hexToBytes(c.bytesHex));
  });
}

test('golden fixtures cover every supported scheme', () => {
  const schemes = new Set(golden.cases.map((c) => CASES[c.name]?.scheme));
  assert.deepEqual([...schemes].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 8]);
});
