// 4-colour wire codes: 2.x keeps the per-panel-id mapping, 3.x applies 0xB1 code_map once.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ctx = { window: {}, console, navigator: {}, document: {}, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'js', 'ble-common.js'), 'utf8') + ';this.OD = OpenDisplayBLE;', ctx);
const enc = Object.create(ctx.OD.prototype);
enc.log = () => {};

const idx = Uint8Array.from([0, 1, 2, 3]); // black, white, yellow, red
const px = new Uint8Array(16);
const run = (panel, wireMap, codeMap4) => Array.from(enc.buildWireCodes(px, 4, 3, panel, idx, wireMap, codeMap4));

test('2.x: dither wireMap is used as before (code_map ignored when not passed)', () => {
  assert.deepEqual(run(0x1e, [0, 1, 3, 2], null), [0, 1, 3, 2]);
  assert.deepEqual(run(0x40, [0, 1, 2, 3], null), [0, 1, 2, 3]);
});

test('3.x: code_map replaces the per-panel-id swap, never stacks on it', () => {
  assert.deepEqual(run(0x1e, [0, 1, 3, 2], [0, 1, 3, 2]), [0, 1, 3, 2]);
  assert.deepEqual(run(0x40, [0, 1, 2, 3], [0, 1, 3, 2]), [0, 1, 3, 2]);
  assert.deepEqual(run(0x37, [0, 1, 2, 3], [0, 1, 2, 3]), [0, 1, 2, 3]);
});

test('3.x: the RGB fallback path (no dither indices) maps through code_map too', () => {
  const rgba = Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 0, 0, 255]);
  const out = Array.from(enc.buildWireCodes(rgba, 4, 3, 0x40, null, null, [0, 1, 3, 2]));
  const logical = Array.from(enc.buildWireCodes(rgba, 4, 3, 0x40, null, null, null));
  assert.deepEqual(out, logical.map(c => [0, 1, 3, 2][c]));
});

test('other schemes are untouched by codeMap4', () => {
  const gray = Array.from(enc.buildWireCodes(px, 4, 5, 0x28, idx, [3, 2, 1, 0], [0, 1, 3, 2]));
  assert.deepEqual(gray, [3, 2, 1, 0]);
});
