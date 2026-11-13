// The firmware additions the website did not know yet (PROTOCOL_CHANGES_3.0 rows 3-7, 13, 14,
// 18; SECURITY_V2 § 5.2): extended READ_IDENT, limits from the device, the new NACK bytes,
// ACTION_INFO's 10th byte.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V3 = require('../httpdocs/js/od-v3.js');

const ident = (target, flags, tail) => Uint8Array.from([0x00, 0x46, 0x00, target, 0x01,
  0xb8, 0x0b, 0x28, 0x01, 0x80, 0x00, 0x01, flags, ...(tail || [])]);

test('READ_IDENT: the full 3.0 tail (flags, max_config, max_seq_steps, escapes)', () => {
  const r = V3.parseReadIdent(ident(0x03, 0x08 | 0x10 | 0x04, [0xd0, 0x0f, 0x80, 0x00, 0x00]));
  assert.equal(r.target, 3); assert.equal(r.targetName, 'EFR32BG22');
  assert.equal(r.displays.length, 1); assert.equal(r.displays[0].panelIcType, 3000);
  assert.equal(r.builtinDriver, true); assert.equal(r.sec2, true); assert.equal(r.claimed, true);
  assert.equal(r.claimMode, false); assert.equal(r.legacySecretsOpen, false); assert.equal(r.needsMigration, false);
  assert.equal(r.maxConfig, 4048); assert.equal(r.maxSeqSteps, 128); assert.equal(r.escapes, 0);
});

test('READ_IDENT: every SEC bit lands on its own field (bits 3-6, not 2)', () => {
  const names = { 0x08: 'sec2', 0x10: 'claimed', 0x20: 'claimMode', 0x40: 'legacySecretsOpen', 0x04: 'builtinDriver', 0x02: 'needsMigration' };
  for (const [bit, name] of Object.entries(names)) {
    const r = V3.parseReadIdent(ident(1, Number(bit)));
    for (const other of Object.values(names)) assert.equal(r[other], other === name, `${name} vs ${other}`);
  }
});

test('READ_IDENT: a 2.x reply (no tail) and a short tail parse without guessing', () => {
  const old = V3.parseReadIdent(Uint8Array.from([0x00, 0x46, 0x00, 0x01, 0x00]));
  assert.equal(old.flags, null); assert.equal(old.sec2, false); assert.equal(old.maxConfig, null);
  const short = V3.parseReadIdent(ident(1, 0x01, [0x00, 0x10]));
  assert.equal(short.maxConfig, 4096); assert.equal(short.maxSeqSteps, null); assert.equal(short.escapes, null);
  assert.equal(V3.parseReadIdent(Uint8Array.from([0x00, 0x47, 0, 0, 0])), null);
});

test('fw_target: one value per family, 0x05 nRF52840 is new; 0x01 is ESP32 only', () => {
  assert.equal(V3.targetFromIdent(0x01), 'esp32');
  assert.equal(V3.targetFromIdent(0x05), 'nrf52840');
  assert.equal(V3.targetFromIdent(0x03), 'bg22');
  assert.equal(V3.targetFromIdent(0x04), 'nrf52811');   // Firmware_NRF 3.0
  assert.equal(V3.targetClassFromIdent(0x04), 'nrf52811');
  assert.equal(V3.targetClassFromIdent(0x05), 'default');
  assert.equal(V3.deviceTargetClass({ identTarget: 0x05, target: 'nrf52840' }).how, 'read-ident');
});

test('limits come from the device; the table is the fallback', () => {
  const dev = V3.limitsFromIdent(V3.parseReadIdent(ident(1, 0x01, [0x00, 0x10, 0x40, 0x00, 0x00])));
  assert.equal(dev.how, 'device'); assert.equal(dev.limits.max_steps, 64); assert.equal(dev.limits.window, false);
  assert.equal(dev.maxConfig, 4096);
  const tab = V3.limitsFromIdent(V3.parseReadIdent(Uint8Array.from([0x00, 0x46, 0x00, 0x03, 0x00])));
  assert.equal(tab.how, 'table'); assert.equal(tab.cls, 'bg22'); assert.equal(tab.limits.sleep_max, 20);
  assert.equal(V3.limitsFromIdent(null, 'default').cls, 'default');
  // The device limit feeds the pre-write gate.
  const head = n => '00' + '00' + '66756c6c0000000000000000' + '01' + '01' + '00' + '00' + '00' + 'ff'.repeat(8) + '00'.repeat(8) + V3.bytesToHex([n & 0xff, n >> 8]);
  const seq = '0110'.repeat(70) + '0000';
  const p = [{ pid: '174', raw: head(seq.length / 2) + seq }];
  assert.equal(V3.checkDrivePacketsFit(p, 'default').ok, true);
  assert.equal(V3.checkDrivePacketsFit(p, dev.cls, dev.limits).ok, false);
});

test('NACK bytes: NEEDS_MIGRATION, PANEL_BUSY, drive PANEL_BUSY, CONFIG_WRITE_BUSY, 0x10/0x11', () => {
  assert.equal(V3.explainNack([0xff, 0x70, 0x08, 0x00]).kind, 'needs_migration');
  assert.equal(V3.explainNack([0xff, 0x80, 0x08, 0x00]).kind, 'needs_migration');
  const pb = V3.explainNack([0xff, 0x76, 0x09, 0x00]);
  assert.equal(pb.kind, 'panel_busy'); assert.equal(pb.retry, true);
  const db = V3.explainNack([0xff, 0x85, 0x08, 0x02]);
  assert.equal(db.kind, 'panel_busy'); assert.equal(db.mode, 2);
  assert.equal(V3.explainNack([0xff, 0x41, 0x01, 0x00]).kind, 'config_busy');
  assert.equal(V3.explainNack([0xff, 0x42, 0x01, 0x00]).retry, true);
  assert.equal(V3.explainNack([0xff, 0x41, 0x10, 0x00]).kind, 'secrets_need_key');
  assert.equal(V3.explainNack([0xff, 0x41, 0x11, 0x00]).kind, 'key_mismatch');
  assert.equal(V3.explainNack([0xff, 0x41, 0x00, 0x00]).kind, 'failed');
  assert.equal(V3.explainNack([0x00, 0x41]), null);
});

test('ACTION_INFO: 9-byte replies still parse; byte 9 is the table count', () => {
  const nine = V3.parseActionInfo([0x00, 0x4c, 1, 4, 3, 1, 0]);
  assert.equal(nine, null, 'too short');
  const old = V3.parseActionInfo([0x00, 0x4c, 4, 3, 1, 0, 5, 9, 0xfb]);
  assert.equal(old.tables, null); assert.equal(old.entries, 4); assert.equal(old.lastTempC, -5);
  const neu = V3.parseActionInfo([0x00, 0x4c, 4, 3, 1, 2, 0, 0, 21, 2]);
  assert.equal(neu.tables, 2); assert.equal(neu.extraTables, true); assert.equal(neu.rejected, 2);
  assert.equal(neu.lastTempC, 21);
});

test('the reconnect wait after a config write is at least 30 s', () => {
  assert.ok(V3.RECONNECT_AFTER_CONFIG_MS >= 30000);
});

test('0xB3 for native-controller panels (IT8951 / parallel) from native_controllers, ESP32 only', () => {
  const fs = require('node:fs'), path = require('node:path');
  const gen = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox', 'drive-presets.json'), 'utf8'));
  assert.ok(gen.native_controllers && Object.keys(gen.native_controllers).length >= 6, 'vendored file keeps native_controllers');
  const db = V3.buildDriveDb({ generated: gen });
  const n = V3.nativeControllerFor(db, 3000);
  assert.equal(n.controllerClass, 'IT8951');
  assert.equal(n.packets[0].pid, '179');
  const disp = { uid: 'd', pid: '32', fields: { panel_ic_type: '3000' } };
  const plan = V3.planMigration({ packets: [disp], gen: 'v3', db, targetClass: 'default', chip: 'esp32' });
  assert.equal(plan.needed, true); assert.equal(plan.native, true);
  assert.equal(plan.add.length, 1); assert.equal(plan.add[0].pid, '179');
  assert.match(plan.add[0].summary.text, /IT8951/);
  const out = V3.applyMigration([disp], plan, () => 'u');
  assert.equal(out.filter(p => p.pid === '179').length, 1);
  // Already there and the device drives it: nothing to do.
  const again = V3.planMigration({ packets: out, gen: 'v3', db, targetClass: 'default', chip: 'esp32', builtinDriver: true });
  assert.equal(again.needed, false);
  // Present but the device says it has no builtin driver: replace, never append a second.
  const fix = V3.planMigration({ packets: out, gen: 'v3', db, targetClass: 'default', chip: 'esp32', builtinDriver: false });
  assert.equal(fix.needed, true); assert.equal(fix.remove.length, 1);
  assert.equal(V3.applyMigration(out, fix, () => 'v').filter(p => p.pid === '179').length, 1);
  // Not an ESP32: blocked with a reason.
  const nrf = V3.planMigration({ packets: [disp], gen: 'v3', db, targetClass: 'default', chip: 'nrf52840' });
  assert.equal(nrf.blocked, true); assert.match(nrf.reason, /only by ESP32/);
});
