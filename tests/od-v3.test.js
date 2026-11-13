// Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V3 = require('../httpdocs/js/od-v3.js');

const TOOLBOX = path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox');
const presets = JSON.parse(fs.readFileSync(path.join(TOOLBOX, 'simple-config-presets.json'), 'utf8'));
const generated = JSON.parse(fs.readFileSync(path.join(TOOLBOX, 'drive-presets.json'), 'utf8'));
const dbFallback = V3.buildDriveDb({ displays: presets.displays });
const nrf52811Doc = JSON.parse(fs.readFileSync(path.join(TOOLBOX, 'drive-presets-nrf52811.json'), 'utf8'));
const db = V3.buildDriveDb({ generated, classFiles: { nrf52811: nrf52811Doc }, displays: presets.displays });

// Legacy body sizes from the schema the toolbox ships (pid -> bytes).
const SIZES = { 1: 22, 2: 22, 4: 30, 32: 46, 33: 22, 35: 30, 36: 30, 37: 30, 38: 160, 39: 64, 40: 32, 41: 32, 42: 32, 43: 32, 44: 288, 45: 128 };
const legacySize = id => SIZES[id] != null ? SIZES[id] : null;

function frame(packets) {
  // packets: [{id, body:Uint8Array}] -> outer blob
  const out = [0, 0, 1];
  let n = 0;
  for (const p of packets) {
    out.push(n++ & 0xff, p.id);
    if (p.id >= 0x80) out.push(p.body.length & 0xff, p.body.length >> 8);
    out.push(...p.body);
  }
  const total = out.length + 2;
  out[0] = total & 0xff; out[1] = total >> 8;
  const b = Uint8Array.from([...out, 0, 0]);
  const crc = V3.outerCrc(b);
  b[b.length - 2] = crc & 0xff; b[b.length - 1] = crc >> 8;
  return b;
}
const zeros = n => new Uint8Array(n);

test('firmwareGeneration: the single version gate', () => {
  assert.equal(V3.firmwareGeneration({ major: 2, minor: 27 }), 'v2');
  assert.equal(V3.firmwareGeneration({ major: 1, minor: 1 }), 'v2');      // Firmware_NRF54 1.x
  assert.equal(V3.firmwareGeneration({ major: 3, minor: 0, patch: 0 }), 'v3');
  assert.equal(V3.firmwareGeneration({ major: 9, minor: 9 }), 'v3');      // Unified lab stamp
  assert.equal(V3.firmwareGeneration('3.0.1'), 'v3');
  assert.equal(V3.firmwareGeneration('v3.1.0'), 'v3');
  assert.equal(V3.firmwareGeneration('2.27.1'), 'v2');
  assert.equal(V3.firmwareGeneration({ major: 0, minor: 2 }), 'unknown'); // Unified preview
  assert.equal(V3.firmwareGeneration(''), 'unknown');
  assert.equal(V3.firmwareGeneration(null), 'unknown');
  assert.equal(V3.isConfigDriven('v3'), true);
  assert.equal(V3.isConfigDriven('unknown'), false);
});

test('pickerGeneration / defaultInstallGeneration: follow the device, 3.x when nothing is connected', () => {
  assert.equal(V3.pickerGeneration({ connected: false }), 'v3');
  assert.equal(V3.pickerGeneration({}), 'v3');
  assert.equal(V3.pickerGeneration({ connected: false, chosenInstallGen: 'v2' }), 'v2');
  assert.equal(V3.pickerGeneration({ connected: true, deviceGen: 'v2' }), 'v2');
  assert.equal(V3.pickerGeneration({ connected: true, deviceGen: 'v3', chosenInstallGen: 'v2' }), 'v3');
  assert.equal(V3.pickerGeneration({ connected: true, deviceGen: 'unknown' }), 'unknown');
  assert.equal(V3.defaultInstallGeneration({ connected: false }), 'v3');
  assert.equal(V3.defaultInstallGeneration({ connected: true, deviceGen: 'v3' }), 'v3');
  assert.equal(V3.defaultInstallGeneration({ connected: true, deviceGen: 'v2' }), 'v2');
});

test('downgradeWarning: 3.x -> 2.x is allowed, with the rewrite warning', () => {
  assert.match(V3.downgradeWarning('v3', 'v2'), /allowed, but the configuration must be rewritten for 2\.x/);
  assert.equal(V3.downgradeWarning('v2', 'v3'), '');
  assert.equal(V3.downgradeWarning('v3', 'v3'), '');
  assert.equal(V3.downgradeWarning('unknown', 'v2'), '');
});

test('config size limit per target and generation', () => {
  assert.equal(V3.configSizeLimit('bg22', 'v3'), 3120);
  assert.equal(V3.configSizeLimit('bg22', 'v2'), 2048);
  assert.equal(V3.configSizeLimit('bg22', 'unknown'), 2048);
  assert.equal(V3.configSizeLimit('nrf52811', 'v2'), 512);
  assert.equal(V3.configSizeLimit('nrf52811', 'v3'), 2000);
  assert.equal(V3.configSizeLimit('esp32', 'v3'), 4096);
  assert.equal(V3.configSizeLimit('nrf52840', 'v2'), 4096);
  assert.equal(V3.configSizeLimit('nrf54', 'v3'), 4096);
  assert.equal(V3.targetFromIcType('0x6'), 'bg22');
  assert.equal(V3.targetFromIcType(5), 'nrf52811');
  assert.equal(V3.targetFromIcType(9), 'esp32');
  assert.equal(V3.targetFromInstallType('silabs_bg22'), 'bg22');
  const over = V3.checkConfigSize(2144, 'bg22', 'v2');
  assert.equal(over.ok, false);
  assert.match(over.message, /2048/);
  assert.equal(V3.checkConfigSize(2144, 'bg22', 'v3').ok, true);
});

test('drive db: fallback from the six inline presets', () => {
  assert.equal(dbFallback.size, 6);
  for (const t of [28, 30, 54, 56, 58, 64]) assert.ok(dbFallback.get(t).usable, 'panel ' + t);
});

test('drive db: generated file covers every bb_epaper preset, glass entries match the inline presets byte for byte', () => {
  for (const d of presets.displays) {
    if (!V3.panelNeedsDriveData(d.panelIcType)) continue;
    const e = db.get(Number(d.panelIcType));
    assert.ok(e, d.id + ' has an entry');
    if (d.drivePackets) {
      assert.equal(e.status, 'glass', d.id);
      const a = d.drivePackets.map(p => p.pid + ':' + p.raw.toLowerCase()).sort();
      const b = e.packets.map(p => p.pid + ':' + p.raw).sort();
      assert.deepEqual(b, a, d.id);
    }
    // The 2.x fields an old client keys on must agree with what the preset writes into 0x20.
    // (A 3.x-only display never meets a 2.x client.)
    if (!d.v3Only && e.legacy && e.legacy.color_scheme != null) assert.equal(Number(d.config.color_scheme), e.legacy.color_scheme, d.id + ' color_scheme');
  }
});

// A schema-minor-0 style document whose top level is blocked (the generator may emit this again
// for a panel no class can drive). Independent of the shipped data, so it cannot go stale.
const blockedDoc = {
  schema: 'opendisplay.drive_presets', schema_version: 1,
  panels: { '0x0063': { panel_ic_type: 99, name: 'FIXTURE_BLOCKED', status: 'blocked', verified: 'untested',
    blocked_on: ['SEQ_MAX'], modes_blocked: [{ name: 'full', blocked_on: ['SEQ_MAX'], seq_bytes: 600, steps: 120 }], packets: [] } }
};
// Per-class fixture: driveable on the default class, blocked on BG22 by the generator (no shipped
// panel is blocked on any class since schema_minor 2; the data-driven path must keep working).
// It also carries a minor-1 `alternatives[]` entry, which must be ignored.
const p2 = generated.panels['0x0002'];
const classDoc = {
  schema: 'opendisplay.drive_presets', schema_version: 1, schema_minor: 2,
  panels: { '0x0002': Object.assign({}, p2, {
    targets: { default: p2.targets.default, bg22: { status: 'blocked', verified: 'untested', blocked_on: ['WINDOW'], packets: [] } },
    alternatives: [{ target_class: 'bg22', variant: 'single_init', status: 'alternative', verified: 'untested', packets: p2.targets.bg22.packets }]
  }) }
};

test('drive db: blocked entries are not usable and say why; the 4.2in palette is flagged', () => {
  const fx = V3.buildDriveDb({ generated: blockedDoc });
  const blocked = fx.get(99);
  assert.equal(blocked.usable, false);
  assert.equal(blocked.packets.length, 0);
  assert.match(blocked.blockedReason, /SEQ_MAX/);
  for (const cls of ['default', 'bg22', null]) {
    const e = V3.driveEntryFor(fx, 99, cls);
    assert.equal(e.usable, false, String(cls));
    assert.equal(e.packets.length, 0, String(cls));
  }
  // Data-driven per-class block: nothing usable on BG22, reason says so, the alternative is ignored.
  const cx = V3.buildDriveDb({ generated: classDoc });
  const bg = V3.driveEntryFor(cx, 2, 'bg22');
  assert.equal(bg.usable, false);
  assert.equal(bg.packets.length, 0);
  assert.equal(bg.targetClass, 'bg22');
  assert.match(bg.blockedReason, /^Not available on this target \(EFR32BG22\): the drive data needs WINDOW\.$/);
  assert.equal(V3.driveEntryFor(cx, 2, null).usable, false);
  assert.equal(V3.driveEntryFor(cx, 2, 'default').usable, true);
  // Shipped data (schema_minor 2): every Firmware_Unified panel is driveable on both classes
  // (drive-presets-nrf52811.json panels are nRF52811-only, see the nRF52811 tests).
  for (const [t, e] of db) {
    if (e.onlyClass) continue;
    for (const cls of ['default', 'bg22']) assert.ok(V3.driveEntryFor(db, t, cls).usable, t + ' ' + cls);
  }
  assert.equal(db.get(58).paletteVerified, false);
  const alias = db.get(1004);
  assert.equal(alias.aliasOf, '0x003A');
  assert.equal(alias.packets.length, db.get(58).packets.length);
});

test('driveAvailability: 3.x blocks undriveable panels per target class, badges unverified ones, 2.x is untouched', () => {
  const byId = id => presets.displays.find(d => d.id === id);
  const cx = V3.buildDriveDb({ generated: classDoc });
  const ep42 = byId('ep42-400x300');
  const a = V3.driveAvailability(ep42, cx, 'v3', 'bg22');
  assert.equal(a.selectable, false);
  assert.match(a.reason, /Not available on this target \(EFR32BG22\)/);
  assert.match(a.reason, /firmware 2\.x/);
  assert.equal(V3.badgeText(a), 'not on this target');
  // Unknown class = the restrictive one.
  assert.equal(V3.driveAvailability(ep42, cx, 'v3', null).selectable, false);
  assert.equal(V3.driveAvailability(ep42, cx, 'v3', 'default').selectable, true);
  assert.equal(V3.driveAvailability(ep42, cx, 'v2', 'bg22').selectable, true);
  // Shipped: the formerly BG22-blocked ep154 is selectable on BG22 now.
  assert.equal(V3.driveAvailability(byId('ep154-152x152'), db, 'v3', 'bg22').selectable, true);
  for (const cls of ['default', 'bg22']) {
    assert.equal(V3.driveAvailability(byId('ep29yr-168x384'), db, 'v3', cls).badge, null, cls);
    assert.equal(V3.driveAvailability(byId('ep42-400x300'), db, 'v3', cls).badge, 'untested', cls);
    assert.equal(V3.badgeText(V3.driveAvailability(byId('ep42-400x300'), db, 'v3', cls)), 'untested on glass');
    assert.ok(V3.driveAvailability(byId('ep42yr-400x300'), db, 'v3', cls).paletteWarning);
    // FastEPD / IT8951 boards are not drive-packet panels.
    assert.equal(V3.driveAvailability(byId('m5-paper-960x540'), db, 'v3', cls).selectable, true);
    // Without the generated file, a panel without inline drive data is blocked on 3.x.
    assert.equal(V3.driveAvailability(byId('ep42-400x300'), dbFallback, 'v3', cls).selectable, false);
  }
});

test('deviceTargetClass: READ_IDENT fw_target first, chip family second, restrictive otherwise', () => {
  assert.deepEqual(V3.deviceTargetClass({ identTarget: 0x03 }), { cls: 'bg22', how: 'read-ident', restrictive: false });
  assert.equal(V3.deviceTargetClass({ identTarget: 0x01 }).cls, 'default');
  assert.equal(V3.deviceTargetClass({ identTarget: 0x02 }).cls, 'default');
  assert.equal(V3.deviceTargetClass({ identTarget: 0x01, target: 'esp32' }).how, 'read-ident');
  assert.deepEqual(V3.deviceTargetClass({ target: 'esp32' }), { cls: 'default', how: 'chip', restrictive: false });
  assert.equal(V3.deviceTargetClass({ target: 'nrf54' }).cls, 'default');
  assert.equal(V3.deviceTargetClass({ target: 'bg22' }).cls, 'bg22');
  assert.equal(V3.deviceTargetClass({ identTarget: 6, target: 'bg22' }).cls, 'bg22');      // not a fw_target value
  assert.deepEqual(V3.deviceTargetClass({ identTarget: 0x01, target: 'bg22' }), { cls: 'bg22', how: 'conflict', restrictive: true });
  assert.deepEqual(V3.deviceTargetClass({}), { cls: 'bg22', how: 'unknown', restrictive: true });
  assert.deepEqual(V3.deviceTargetClass({ identTarget: 0x04, target: 'nrf52811' }), { cls: 'nrf52811', how: 'read-ident', restrictive: false });
  assert.equal(V3.deviceTargetClass({ target: 'nrf52811' }).cls, 'nrf52811');
  assert.equal(V3.deviceTargetClass({ target: V3.targetFromIcType(6) }).cls, 'bg22');
});

test('checkDrivePacketsFit: the pre-write gate per class (128 steps, WINDOW/FILL, sleep 20 B; no byte cap)', () => {
  // Every shipped per-class view fits its own class; 0x0002's default data does not fit BG22 (WINDOW).
  for (const [k, e] of Object.entries(generated.panels)) {
    for (const [cls, v] of Object.entries(e.targets || {})) {
      if (v.packets.length) assert.ok(V3.checkDrivePacketsFit(v.packets, cls).ok, k + ' ' + cls);
    }
  }
  const d2 = V3.checkDrivePacketsFit(generated.panels['0x0002'].packets, 'bg22');
  assert.equal(d2.ok, false);
  assert.ok(d2.problems.some(p => /WINDOW\/FILL/.test(p)));
  assert.equal(V3.checkDrivePacketsFit(generated.panels['0x0002'].packets, 'default').ok, true);
  const head = n => '00' + '00' + '66756c6c0000000000000000' + '01' + '01' + '00' + '00' + '00' + 'ff'.repeat(8) + '00'.repeat(8) + V3.bytesToHex([n & 0xff, n >> 8]);
  // Sequences stream from storage: a long sequence is fine on both classes (here 4 x 255 B steps).
  const long = ('ff20' + 'aa'.repeat(254)).repeat(4) + '0000';
  assert.equal(long.length / 2, 1026);
  for (const cls of ['default', 'bg22']) assert.equal(V3.checkDrivePacketsFit([{ pid: '174', raw: head(1026) + long }], cls).ok, true, cls);
  // 128 steps incl. END is the bound on every class.
  const steps = n => '0112'.repeat(n - 1) + '0000';
  for (const cls of ['default', 'bg22']) {
    assert.equal(V3.checkDrivePacketsFit([{ pid: '174', raw: head(256) + steps(128) }], cls).ok, true, cls);
    const r = V3.checkDrivePacketsFit([{ pid: '174', raw: head(258) + steps(129) }], cls);
    assert.equal(r.ok, false, cls);
    assert.match(r.problems[0], /129 steps, limit 128/);
  }
  // The sleep sequence is a 20 B RAM copy (PROTOCOL_CHANGES_3.0 row 18; was 16 B).
  const sleep = n => '00'.repeat(12) + V3.bytesToHex([n]);
  assert.equal(V3.checkDrivePacketsFit([{ pid: '177', raw: sleep(16) + '0110'.repeat(7) + '0000' }], 'bg22').ok, true);
  assert.equal(V3.checkDrivePacketsFit([{ pid: '177', raw: sleep(20) + '0110'.repeat(9) + '0000' }], 'bg22').ok, true);
  assert.match(V3.checkDrivePacketsFit([{ pid: '177', raw: sleep(22) + '0110'.repeat(10) + '0000' }], 'default').problems[0], /22 B sequence, limit 20 B/);
  // Malformed / unknown escapes are refused, not guessed at; so is a sequence with no END.
  assert.equal(V3.checkDrivePacketsFit([{ pid: '174', raw: head(4) + '00800000' }], 'default').ok, false);
  assert.equal(V3.checkDrivePacketsFit([{ pid: '174', raw: head(2) + '0112' }], 'default').ok, false);
  assert.equal(V3.checkDrivePacketsFit([{ pid: '174', raw: head(9) + '0112' }], 'default').ok, false);  // seq_len lies
  // Unknown class name = the restrictive class.
  assert.equal(V3.checkDrivePacketsFit(generated.panels['0x0002'].packets, 'nonsense').ok, false);
});

test('syncDrivePackets: switching panels removes the previous panel\'s packets', () => {
  const base = [{ pid: '32', fields: { panel_ic_type: '30' } }, { pid: '178', raw: 'aabb' }, { pid: '46', rawLegacy: '00' }];
  const after29 = V3.syncDrivePackets(base, db.get(30), 'v3', null, 'default');
  assert.equal(after29.filter(p => V3.isDrivePid(p.pid)).length, 6);
  assert.ok(after29.some(p => p.pid === '178'), '0xB2 kept');
  assert.ok(!after29.some(p => p.pid === '46'), 'burned dropped on v3');
  const afterMono = V3.syncDrivePackets(after29, db.get(2), 'v3', null, 'default');
  const drive = afterMono.filter(p => V3.isDrivePid(p.pid));
  assert.deepEqual(drive.map(p => p.raw).sort(), db.get(2).packets.map(p => p.raw).sort());
  // A panel with no data on v3 leaves no stale drive packets behind.
  assert.equal(V3.syncDrivePackets(after29, null, 'v3').filter(p => V3.isDrivePid(p.pid)).length, 0);
  assert.equal(V3.syncDrivePackets(after29, V3.driveEntryFor(V3.buildDriveDb({ generated: classDoc }), 2, 'bg22'), 'v3', null, 'bg22').filter(p => V3.isDrivePid(p.pid)).length, 0);
  // Default-class packets handed over for a BG22 (or an unknown class) are not added.
  assert.equal(V3.syncDrivePackets(after29, db.get(2), 'v3', null, 'bg22').filter(p => V3.isDrivePid(p.pid)).length, 0);
  assert.equal(V3.syncDrivePackets(after29, db.get(2), 'v3').filter(p => V3.isDrivePid(p.pid)).length, 0);
  assert.equal(V3.syncDrivePackets(after29, db.get(2), 'v3', null, 'default').filter(p => V3.isDrivePid(p.pid)).length, 4);
  const bg2 = V3.syncDrivePackets(after29, V3.driveEntryFor(db, 2, 'bg22'), 'v3', null, 'bg22').filter(p => V3.isDrivePid(p.pid));
  assert.deepEqual(bg2.map(p => p.raw), generated.panels['0x0002'].targets.bg22.packets.map(p => p.body_hex));
  // v2: never adds, keeps burned packets.
  const v2 = V3.syncDrivePackets(base, db.get(30), 'v2');
  assert.equal(v2.filter(p => V3.isDrivePid(p.pid)).length, 0);
  assert.ok(v2.some(p => p.pid === '46'));
});

const carried2x = () => [
  { pid: '1', fields: { ic_type: '0x6' } },
  { pid: '2', fields: { manufacturer_id: '0x0' } },
  { pid: '32', fields: { panel_ic_type: '0x1e', pixel_width: '0xa8', pixel_height: '0x180', color_scheme: '0x3' } },
  { pid: '38', fields: { ssid: 'home' } },
  { pid: '39', fields: { encryption_enabled: '0x1', encryption_key: '00112233445566778899aabbccddeeff' } },
  { pid: '178', raw: '0102' },
  { pid: '47', rawLegacy: '00'.repeat(541) }
];

test('planMigration / applyMigration: adds drive data, keeps everything else', () => {
  const pk = carried2x();
  assert.equal(V3.planMigration({ packets: pk, gen: 'v2', db }).needed, false);
  const plan = V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: 'bg22' });
  assert.equal(plan.needed, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.panelIcType, 30);
  assert.equal(plan.add.length, 6);
  assert.equal(plan.remove.length, 1);
  assert.ok(V3.describePlan(plan).some(l => /colour16/.test(l)));
  const out = V3.applyMigration(pk, plan);
  for (const pid of ['1', '2', '32', '38', '39', '178']) assert.ok(out.some(p => p.pid === pid), 'kept ' + pid);
  assert.equal(out.find(p => p.pid === '39').fields.encryption_key, '00112233445566778899aabbccddeeff');
  assert.ok(V3.hasPanelPacket(out));
  assert.equal(V3.planMigration({ packets: out, gen: 'v3', db }).needed, false);
  // Device flag forces a refresh even when packets exist.
  assert.equal(V3.planMigration({ packets: out, gen: 'v3', db, deviceSaysNeedsMigration: true }).needed, true);
});

test('planMigration: blocked panel is reported, never written', () => {
  const pk = carried2x();
  pk[2].fields.panel_ic_type = '99';
  const fx = V3.planMigration({ packets: pk, gen: 'v3', db: V3.buildDriveDb({ generated: blockedDoc }), targetClass: 'default' });
  assert.equal(fx.needed, true);
  assert.equal(fx.blocked, true);
  assert.equal(fx.add.length, 0);
  assert.match(fx.reason, /blank/);
  // BG22 device + a panel the data blocks on BG22: nothing to write, the reason says why.
  const cx = V3.buildDriveDb({ generated: classDoc });
  pk[2].fields.panel_ic_type = '2';
  const plan = V3.planMigration({ packets: pk, gen: 'v3', db: cx, targetClass: 'bg22' });
  assert.equal(plan.needed, true);
  assert.equal(plan.blocked, true);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.targetClass, 'bg22');
  assert.match(plan.reason, /^Not available on this target \(EFR32BG22\)/);
  assert.throws(() => V3.applyMigration(pk, Object.assign({}, plan, { add: db.get(2).packets })), /does not run on this target/);
  // Unknown class: restrictive, same answer.
  assert.equal(V3.planMigration({ packets: pk, gen: 'v3', db: cx }).blocked, true);
  // Default-class device: the same panel migrates.
  const d = V3.planMigration({ packets: pk, gen: 'v3', db: cx, targetClass: 'default' });
  assert.equal(d.blocked, false);
  assert.deepEqual(d.add.map(p => p.raw), p2.targets.default.packets.map(p => p.body_hex));
});

test('planMigration: per-class packets; BG22 gets targets.bg22', () => {
  const pk = carried2x();
  pk[2].fields.panel_ic_type = '2';
  const raw = (pl) => pl.add.map(p => p.raw);
  // BG22 + available panel: the bg22-class packets (no WINDOW), not the default ones.
  const bg = V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: 'bg22' });
  assert.equal(bg.blocked, false);
  assert.deepEqual(raw(bg), generated.panels['0x0002'].targets.bg22.packets.map(p => p.body_hex));
  assert.notDeepEqual(raw(bg), generated.panels['0x0002'].packets.map(p => p.body_hex));
  assert.ok(V3.checkDrivePacketsFit(bg.add, 'bg22').ok);
  // Default-class device: the default packets.
  const df = V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: 'default' });
  assert.deepEqual(raw(df), generated.panels['0x0002'].targets.default.packets.map(p => p.body_hex));
  // Unknown class: the restrictive (bg22) packets.
  assert.deepEqual(raw(V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: null })), raw(bg));
  // A BG22 config already holding default-class drive data needs migrating (the device refuses it).
  const wrong = V3.applyMigration(pk, df);
  assert.equal(V3.planMigration({ packets: wrong, gen: 'v3', db, targetClass: 'default' }).needed, false);
  const fix = V3.planMigration({ packets: wrong, gen: 'v3', db, targetClass: 'bg22' });
  assert.equal(fix.needed, true);
  assert.match(fix.reason, /do not run on this target/);
  assert.deepEqual(raw(fix), raw(bg));
  // The formerly BG22-blocked ep154 (0x000E) now migrates on BG22 with its bg22-class packets.
  pk[2].fields.panel_ic_type = '14';
  const e14 = V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: 'bg22' });
  assert.equal(e14.blocked, false);
  assert.deepEqual(raw(e14), generated.panels['0x000E'].targets.bg22.packets.map(p => p.body_hex));
});

test('identifyPreset: simple-config index first, unambiguous match second, candidates otherwise', () => {
  const board = presets.driverBoards.find(b => b.id === 'm3-pro-silabs');
  const disp = presets.displays.find(d => d.id === 'ep29yr-168x384');
  const pk = carried2x();
  pk[1].fields.simple_config_driver_index = String(board.index);
  pk[1].fields.simple_config_display_index = String(disp.index);
  let r = V3.identifyPreset(pk, presets);
  assert.equal(r.driverBoard.id, 'm3-pro-silabs');
  assert.equal(r.display.id, 'ep29yr-168x384');
  assert.equal(r.how.display, 'simple-config-index');
  // No indexes: the panel id + size is unique among presets.
  r = V3.identifyPreset(carried2x(), presets);
  assert.equal(r.display.id, 'ep29yr-168x384');
  assert.equal(r.how.display, 'panel-match');
  // Index contradicted by the stored panel: not trusted.
  const pk2 = carried2x();
  pk2[1].fields.simple_config_display_index = String(presets.displays.find(d => d.id === 'ep42-400x300').index);
  assert.equal(V3.identifyPreset(pk2, presets).display.id, 'ep29yr-168x384');
  // Spectra 66 has two presets of the same size class -> ambiguous.
  const pk3 = carried2x();
  pk3[2].fields = { panel_ic_type: '66', pixel_width: '0', pixel_height: '0' };
  const r3 = V3.identifyPreset(pk3, presets);
  assert.equal(r3.display, null);
  assert.ok(r3.candidates.displays.length >= 2);
});

test('walkConfig / compareConfigs / verifyDriveReadback', () => {
  const b1 = V3.hexToBytes(db.get(30).packets.find(p => p.pid === '177').raw);
  const ae = V3.hexToBytes(db.get(30).packets.find(p => p.pid === '174').raw);
  const blob = frame([{ id: 1, body: zeros(22) }, { id: 32, body: zeros(46) }, { id: 0x2e, body: zeros(157) }, { id: 0xb1, body: b1 }, { id: 0xae, body: ae }]);
  const w = V3.walkConfig(blob, legacySize);
  assert.equal(w.ok, true);
  assert.equal(w.crcOk, true);
  assert.deepEqual(w.packets.map(p => p.id), [1, 32, 0x2e, 0xb1, 0xae]);
  assert.equal(V3.compareConfigs(blob, blob, legacySize).equal, true);
  // Renumbered packet `number` bytes are still the same config.
  const renum = Uint8Array.from(blob); renum[3] = 7;
  assert.equal(V3.compareConfigs(blob, renum, legacySize).equal, true);
  const changed = Uint8Array.from(blob); changed[10] ^= 1;
  assert.equal(V3.compareConfigs(blob, changed, legacySize).equal, false);
  assert.equal(V3.verifyDriveReadback(blob, legacySize).ok, true);
  const noDrive = frame([{ id: 1, body: zeros(22) }]);
  assert.equal(V3.verifyDriveReadback(noDrive, legacySize).ok, false);
  // Unknown legacy id: the rest of the blob is a tail, kept verbatim.
  const unk = frame([{ id: 1, body: zeros(22) }, { id: 0x50, body: Uint8Array.of(1, 2, 3) }]);
  const wu = V3.walkConfig(unk, legacySize);
  assert.equal(wu.tail.id, 0x50);
  assert.equal(wu.tail.bytes, '50010203');
});

test('backup file round trip, raw .bin accepted, damage detected', () => {
  const blob = frame([{ id: 1, body: zeros(22) }, { id: 39, body: zeros(64) }]);
  const text = V3.makeBackup(blob, { name: 'OD123456', firmware: '2.27.1', target: 'esp32' });
  const back = V3.parseBackup(text);
  assert.equal(back.ok, true);
  assert.deepEqual(Array.from(back.bytes), Array.from(blob));
  assert.equal(back.meta.firmware, '2.27.1');
  assert.equal(V3.parseBackup(blob).ok, true);
  assert.equal(V3.parseBackup(new TextEncoder().encode(text)).ok, true);
  const bad = Uint8Array.from(blob); bad[5] ^= 0xff;
  assert.match(V3.parseBackup(bad).error, /CRC/);
  assert.equal(V3.parseBackup('{"format":"x"}').ok, false);
  assert.match(V3.backupFileName('OD12 34', new Date('2026-11-10T00:00:00Z')), /^opendisplay-config-OD1234-2026-11-10\.json$/);
});

test('code_map -> 4-colour wire map (3.x)', () => {
  assert.deepEqual(V3.codeMapFromPackets(db.get(30).packets.map(p => ({ pid: p.pid, raw: p.raw }))), [0, 1, 2, 3]);
  assert.deepEqual(V3.wireMapFromCodeMap([0, 1, 3, 2]), [0, 1, 3, 2]);
  assert.equal(V3.wireMapFromCodeMap([0, 1, 1, 2]), null);
  assert.equal(V3.wireMapFromCodeMap([0, 1, 2]), null);
  assert.equal(V3.wireMapFromCodeMap(null), null);
});

// Measured on glass 2026-11-13 (BG22 on 3.0, full mode): raw 2 draws yellow, raw 3 red, so these
// six BWRY panels need the identity map. [0, 1, 3, 2] swapped yellow and red on every one of them.
test('glass BWRY panels carry the identity code_map, in the database and the website presets', () => {
  for (const id of [0x001C, 0x001E, 0x0036, 0x0038, 0x003A, 0x0040]) {
    const key = '0x' + id.toString(16).toUpperCase().padStart(4, '0');
    const fromDb = generated.panels[key].packets.map(p => ({ pid: String(p.id), raw: p.body_hex }));
    assert.deepEqual(V3.codeMapFromPackets(fromDb), [0, 1, 2, 3], key + ' drive-presets.json');
    const disp = presets.displays.find(d => Number(d.panelIcType) === id && Array.isArray(d.drivePackets));
    assert.ok(disp, key + ': website preset with drive packets');
    assert.deepEqual(V3.codeMapFromPackets(disp.drivePackets), [0, 1, 2, 3], key + ' ' + disp.id);
  }
});

test('decodeDrivePacket summaries', () => {
  const ae = db.get(30).packets.filter(p => p.pid === '174').map(p => V3.decodeDrivePacket(p.pid, p.raw));
  assert.deepEqual(ae.map(m => m.modeName), ['full', 'colour16']);
  assert.equal(ae[1].passes, 3);
});

test('parseReadIdent: records and the optional flags byte', () => {
  const rec = [0x1e, 0, 168, 0, 0x80, 1, 3];
  const withFlags = V3.parseReadIdent([0, 0x46, 4, 6, 1, ...rec, 0x03]);
  assert.equal(withFlags.displays[0].panelIcType, 30);
  assert.equal(withFlags.displays[0].height, 384);
  assert.equal(withFlags.configDriven, true);
  assert.equal(withFlags.needsMigration, true);
  const noFlags = V3.parseReadIdent([0, 0x46, 4, 6, 1, ...rec]);
  assert.equal(noFlags.flags, null);
  assert.equal(noFlags.needsMigration, false);
  assert.equal(V3.parseReadIdent([0, 0x46, 4, 6, 0, 0x01]).configDriven, true);
  assert.equal(V3.parseReadIdent([0, 0x43, 1]), null);
  assert.equal(V3.parseReadIdent(null), null);
});

test('compareVersions: a leading v is ignored, so v3.0.0 sorts above 2.x like 3.0.0', () => {
  assert.equal(V3.compareVersions('v3.0.0', '3.0.0'), 0);
  assert.ok(V3.compareVersions('v3.0.0', '2.27.1') > 0);
  assert.ok(V3.compareVersions('3.0.0', 'v2.27.1') > 0);
  assert.ok(V3.compareVersions('3.0.1', 'v3.0.0') > 0);
  assert.ok(V3.compareVersions('2.9', '2.10') < 0);
  const sorted = ['2.27.1', 'v3.0.0', '2.3.0', '3.1.0'].sort((a, b) => V3.compareVersions(b, a));
  assert.deepEqual(sorted, ['3.1.0', 'v3.0.0', '2.27.1', '2.3.0']);
});

// ---- nRF52811 (Firmware_NRF 3.0) -------------------------------------------------------------
const nrfDisplays = presets.displays.filter(d => (d.connectorPins || []).includes(124));
const GLASS_NRF = ['ssd1619-420-bwr', 'uc8179-750-bwr', 'uc8151-029-bwr', 'ssd1619-029-bwr', 'ssd1619-016-bwr', 'uc8151-027-bwr',
  'uc43-430-bwr', 'ssd1619-013-bwr', 'ssd1619-022-lite-bwr', 'ssd1619-420-bwy', 'el022-160x296-bwr'];

test('nRF52811: only displays with a glass-checked 3.0 preset are offered on 3.x', () => {
  for (const d of nrfDisplays) {
    const t = V3.displayPanelIcType(d, 'v3');
    if (!GLASS_NRF.includes(d.id)) {
      // No preset ships for it: refused on 3.x (there is no built-in driver), still fine on 2.x.
      const a = V3.driveAvailability(d, db, 'v3', 'nrf52811');
      assert.equal(a.selectable, false, d.id + ' must not be offered on 3.x');
      assert.equal(V3.badgeText(a), 'not yet on 3.x', d.id);
      if (!d.v3Only) assert.equal(V3.driveAvailability(d, db, 'v2', 'nrf52811').selectable, true, d.id + ' on 2.x');
      continue;
    }
    assert.ok(t >= 0xE000 && t <= 0xE1FF, d.id + ' 3.0 id ' + t);
    assert.ok(V3.panelNeedsDriveData(t), d.id);
    const e = db.get(t);
    assert.ok(e && e.classes && e.classes.nrf52811, d.id + ' has nRF52811 drive data');
    const a = V3.driveAvailability(d, db, 'v3', 'nrf52811');
    if (GLASS_NRF.includes(d.id)) {
      assert.ok(a.selectable, d.id + ': ' + a.reason);
      assert.equal(V3.badgeText(a), '', d.id + ' is glass');
    }
    // Firmware_NRF data never reaches another class.
    assert.equal(V3.driveAvailability(d, db, 'v3', 'default').selectable, false, d.id + ' on ESP32');
    assert.equal(V3.driveEntryFor(db, t, 'bg22').usable, false);
  }
});

test('nRF52811: 2.x keeps the 2.x id; 3.x-only displays are not offered on 2.x', () => {
  const d29 = presets.displays.find(d => d.id === 'ssd1619-029-bwr');
  assert.equal(V3.displayPanelIcType(d29, 'v2'), 1016);
  assert.equal(V3.displayPanelIcType(d29, 'v3'), 0xE011);
  assert.equal(V3.driveAvailability(d29, db, 'v2', 'nrf52811').selectable, true);
  const bwy = presets.displays.find(d => d.id === 'ssd1619-420-bwy');
  assert.equal(V3.driveAvailability(bwy, db, 'v2', 'nrf52811').selectable, false);
  assert.equal(V3.driveAvailability(bwy, db, 'v3', 'nrf52811').selectable, true);
  // Checked on glass (7.4in tag): selectable.
  const u79 = presets.displays.find(d => d.id === 'uc8179-750-bwr');
  assert.equal(V3.driveAvailability(u79, db, 'v3', 'nrf52811').selectable, true);
  // No preset checked on a panel: refused with a reason, not hidden.
  const u22 = presets.displays.find(d => d.id === 'ssd1619-022-bwr');
  const a = V3.driveAvailability(u22, db, 'v3', 'nrf52811');
  assert.equal(a.selectable, false);
  assert.match(a.reason, /checked on a real panel/);
});

test('nRF52811: a 2.x config is migrated to the 3.0 preset id with its drive packets', () => {
  assert.equal(V3.nrf52811PanelFor(db, 1016), 0xE011);
  assert.equal(V3.nrf52811PanelFor(db, 1001), 0xE002);
  assert.equal(V3.nrf52811PanelFor(db, 57), null);
  const pk = [{ pid: '1', fields: { ic_type: '5' } }, { pid: '32', fields: { panel_ic_type: '1016' } }];
  const plan = V3.planMigration({ packets: pk, gen: 'v3', db, targetClass: 'nrf52811' });
  assert.equal(plan.needed, true); assert.equal(plan.blocked, false);
  assert.equal(plan.panelIcType, 0xE011);
  assert.deepEqual(plan.add.map(p => p.pid).sort(), ['174', '177']);
  const out = V3.applyMigration(pk, plan);
  assert.equal(Number(out.find(p => p.pid === '32').fields.panel_ic_type), 0xE011);
  // Already migrated: nothing to do.
  const again = V3.planMigration({ packets: out, gen: 'v3', db, targetClass: 'nrf52811' });
  assert.equal(again.needed, false, again.reason);
});

test('nRF52811 has no encryption: board presets say so, and a config with secrets is refused', () => {
  for (const id of ['m3-nrf', 'm3-lite-nrf']) {
    assert.equal(presets.driverBoards.find(b => b.id === id).supportsEncryption, false, id);
  }
  assert.equal(V3.targetSupportsEncryption('nrf52811'), false);
  assert.equal(V3.targetSupportsEncryption('esp32'), true);
  const key = { pid: '39', fields: { encryption_enabled: '0x1', encryption_key: 'ab'.repeat(16) } };
  assert.deepEqual(V3.checkSecretsSupported([key], 'nrf52811').problems, ['encryption (security config 0x27)']);
  assert.equal(V3.checkSecretsSupported([key], 'esp32').ok, true);
  const off = { pid: '39', fields: { encryption_enabled: '0x0', encryption_key: '0'.repeat(32) } };
  assert.equal(V3.checkSecretsSupported([off], 'nrf52811').ok, true);
  const wifi = { pid: '38', fields: { ssid: 'x', password: 'secret' } };
  const fm = { pid: '45', fields: { eik: '01' + '00'.repeat(31) } };
  assert.equal(V3.checkSecretsSupported([wifi, fm], 'nrf52811').problems.length, 2);
});

test('m3-nrf board: NFC bus, NFC and flash packets match the firmware-tested layout', () => {
  const b = presets.driverBoards.find(x => x.id === 'm3-nrf');
  assert.equal(Number(b.dataBus.bus_type), 1);                  // I2C
  assert.deepEqual([b.dataBus.pin_1, b.dataBus.pin_2, b.dataBus.pin_3].map(Number), [9, 8, 10]);   // SCL, SDA, power
  assert.equal(Number(b.nfcConfig.field_detect_pin), 11);
  assert.equal(Number(b.nfcConfig.adv_button_byte_index), 10);
  assert.notEqual(Number(b.nfcConfig.adv_button_byte_index), Number(b.buttons.button_data_byte_index));
  assert.deepEqual([b.flashConfig.mosi_pin, b.flashConfig.sck_pin, b.flashConfig.cs_pin].map(Number), [15, 14, 12]);
  assert.equal(Number(b.flashConfig.flags) & 1, 1);
});
