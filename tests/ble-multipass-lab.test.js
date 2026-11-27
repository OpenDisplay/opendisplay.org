// 0xB0 Lab is D50/2 deg media-relative (Firmware_Unified #106); the site adapts it to D65 on read.
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

const close = (actual, expected, tol) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tol, `${actual} vs ${expected}`));

test('sRGB red: D50 Lab (54.29, 80.81, 69.89) adapts to D65 (53.24, 80.09, 67.20)', () => {
  close(enc._d50LabToD65([54.2917, 80.8125, 69.8851]), [53.2408, 80.0925, 67.2032], 0.05);
});

test('neutrals and the paper white stay neutral', () => {
  for (const L of [100, 43.7, 5]) close(enc._d50LabToD65([L, 0, 0]), [L, 0, 0], 1e-3);
});

test('extractDriveModes hands out D65 Lab for 0xB0 entries', () => {
  const le16 = (v) => { const u = v < 0 ? v + 65536 : v; return [u & 0xff, u >> 8]; };
  const entry = (codes, lab) => [codes & 0xff, codes >> 8, ...lab.flatMap((x) => le16(Math.round(x * 100)))];
  const b0 = [0, 1, 1, 2, ...entry(0b010101, [100, 0, 0]), ...entry(0b111111, [54.2917, 80.8125, 69.8851])];
  const ae = new Array(37).fill(0);
  ae[1] = 1; ae[2] = 0x63; ae[14] = 10; ae[15] = 3;  // mode 1 "c", scheme 10, 3 passes
  const { modes } = enc.extractDriveModes({ packets: [{ id: 0xB0, data: b0 }, { id: 0xAE, data: ae }] });
  const lab = modes[0].palette.lab;
  close(lab[0], [100, 0, 0], 1e-3);
  close(lab[1], [53.2408, 80.0925, 67.2032], 0.05);
});
