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
const db = V3.buildDriveDb({ generated, displays: presets.displays });

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

test('config size limit per target and generation', () => {
  assert.equal(V3.configSizeLimit('bg22', 'v3'), 3120);
  assert.equal(V3.configSizeLimit('bg22', 'v2'), 2048);
  assert.equal(V3.configSizeLimit('bg22', 'unknown'), 2048);
  assert.equal(V3.configSizeLimit('nrf52811', 'v2'), 512);
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
    if (e.legacy && e.legacy.color_scheme != null) assert.equal(Number(d.config.color_scheme), e.legacy.color_scheme, d.id + ' color_scheme');
  }
});

test('drive db: blocked entries are not usable and say why; the 4.2in palette is flagged', () => {
  const blocked = db.get(14);  // ep154-152x152: SEQ_MAX
  assert.equal(blocked.usable, false);
  assert.equal(blocked.packets.length, 0);
  assert.match(blocked.blockedReason, /SEQ_MAX/);
  assert.equal(db.get(58).paletteVerified, false);
  const alias = db.get(1004);
  assert.equal(alias.aliasOf, '0x003A');
  assert.equal(alias.packets.length, db.get(58).packets.length);
});

test('driveAvailability: 3.x blocks undriveable panels, badges unverified ones, 2.x is untouched', () => {
  const byId = id => presets.displays.find(d => d.id === id);
  const a = V3.driveAvailability(byId('ep154-152x152'), db, 'v3');
  assert.equal(a.selectable, false);
  assert.match(a.reason, /firmware 2\.x/);
  assert.equal(V3.driveAvailability(byId('ep154-152x152'), db, 'v2').selectable, true);
  assert.equal(V3.driveAvailability(byId('ep29yr-168x384'), db, 'v3').badge, null);
  assert.equal(V3.driveAvailability(byId('ep42-400x300'), db, 'v3').badge, 'untested');
  assert.equal(V3.badgeText(V3.driveAvailability(byId('ep42-400x300'), db, 'v3')), 'untested on glass');
  assert.ok(V3.driveAvailability(byId('ep42yr-400x300'), db, 'v3').paletteWarning);
  // FastEPD / IT8951 boards are not drive-packet panels.
  assert.equal(V3.driveAvailability(byId('m5-paper-960x540'), db, 'v3').selectable, true);
  // Without the generated file, a panel without inline drive data is blocked on 3.x.
  assert.equal(V3.driveAvailability(byId('ep42-400x300'), dbFallback, 'v3').selectable, false);
});

test('syncDrivePackets: switching panels removes the previous panel\'s packets', () => {
  const base = [{ pid: '32', fields: { panel_ic_type: '30' } }, { pid: '178', raw: 'aabb' }, { pid: '46', rawLegacy: '00' }];
  const after29 = V3.syncDrivePackets(base, db.get(30), 'v3');
  assert.equal(after29.filter(p => V3.isDrivePid(p.pid)).length, 6);
  assert.ok(after29.some(p => p.pid === '178'), '0xB2 kept');
  assert.ok(!after29.some(p => p.pid === '46'), 'burned dropped on v3');
  const afterMono = V3.syncDrivePackets(after29, db.get(2), 'v3');
  const drive = afterMono.filter(p => V3.isDrivePid(p.pid));
  assert.deepEqual(drive.map(p => p.raw).sort(), db.get(2).packets.map(p => p.raw).sort());
  // A panel with no data on v3 leaves no stale drive packets behind.
  assert.equal(V3.syncDrivePackets(after29, null, 'v3').filter(p => V3.isDrivePid(p.pid)).length, 0);
  assert.equal(V3.syncDrivePackets(after29, db.get(14), 'v3').filter(p => V3.isDrivePid(p.pid)).length, 0);
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
  const plan = V3.planMigration({ packets: pk, gen: 'v3', db });
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
  pk[2].fields.panel_ic_type = '14';
  const plan = V3.planMigration({ packets: pk, gen: 'v3', db });
  assert.equal(plan.needed, true);
  assert.equal(plan.blocked, true);
  assert.equal(plan.add.length, 0);
  assert.match(plan.reason, /blank/);
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
  assert.deepEqual(V3.codeMapFromPackets(db.get(30).packets.map(p => ({ pid: p.pid, raw: p.raw }))), [0, 1, 3, 2]);
  assert.deepEqual(V3.wireMapFromCodeMap([0, 1, 3, 2]), [0, 1, 3, 2]);
  assert.equal(V3.wireMapFromCodeMap([0, 1, 1, 2]), null);
  assert.equal(V3.wireMapFromCodeMap([0, 1, 2]), null);
  assert.equal(V3.wireMapFromCodeMap(null), null);
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
