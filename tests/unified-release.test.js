'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const R = require('../.github/scripts/lib/unified-release.js');

const FIX = path.join(__dirname, 'fixtures', 'unified-release-manifest.json');
const manifest = () => JSON.parse(fs.readFileSync(FIX, 'utf8'));

test('toolbox keys map Firmware_Unified boards onto the existing board presets', () => {
  const k = (target, board) => R.toolboxKeyForImage({ target, board });
  assert.equal(k('esp32-idf', 's3-n16r8'), 'esp32-s3-N16R8');
  assert.equal(k('esp32-idf', 's3-n16r8-extuart'), 'esp32-s3-N16R8-extuart');
  assert.equal(k('esp32-idf', 'c6-n4'), 'esp32-c6-N4');
  assert.equal(k('esp32-idf', 'esp32-n4'), 'esp32-N4');
  assert.equal(k('nordic-zephyr', 'xiao_nrf52840'), 'nrf52840');
  assert.equal(k('nordic-zephyr', 'xiao_nrf54lm20a'), 'nrf54lm20');
  assert.equal(k('efr32bg22-slc', 'bg22'), 'silabs_bg22');
});

test('every existing 2.x ESP32 manifest stem that has a 3.x board maps back to a real file', () => {
  const bin = path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox', 'bin');
  const stems = fs.readdirSync(bin).filter(f => f.endsWith('_full.json')).map(f => f.replace('_full.json', ''));
  for (const b of ['s3-n16r8', 's3-n16r8-extuart', 's3-n32r8', 's3-n32r8-extuart', 's3-n8r8', 'c3-n4', 'c3-n16', 'c6-n4', 'esp32-n4']) {
    assert.ok(stems.includes(R.toolboxKeyForImage({ target: 'esp32-idf', board: b })), b);
  }
});

test('plan: install + NVS-preserving update manifests, nRF/BG22 entries, nothing under 2.x names', () => {
  const p = R.planSync(manifest(), { published_at: '2026-11-11T00:00:00Z' }, '2026-11-11T01:00:00Z');
  const idx = p.outputs['index.json'];
  assert.equal(idx.generation, 'v3');
  assert.equal(idx.boards['esp32-s3-N16R8'].installManifest, 'esp32-s3-n16r8-install.json');
  const upd = p.outputs['esp32-s3-n16r8-update.json'];
  assert.equal(upd.new_install_prompt_erase, false);
  const offs = upd.builds[0].parts.map(x => x.offset);
  assert.deepEqual(offs, [0, 0x8000, 0xe000, 0x10000]);
  assert.ok(offs.every(o => o < 0x9000 || o >= 0xe000), 'no part inside NVS 0x9000-0xDFFF');
  assert.equal(p.outputs['esp32-esp32-n4-update.json'].builds[0].parts[0].offset, 0x1000);
  assert.equal(p.outputs['esp32-s3-n16r8-install.json'].builds[0].parts[0].offset, 0);
  assert.equal(p.outputs['esp32-s3-n16r8-install.json'].builds[0].chipFamily, 'ESP32-S3');
  assert.ok(!idx.boards['esp32-c3-N4'].updateManifest, 'no split parts -> no update manifest');
  assert.ok(p.warnings.some(w => /c3-n4/.test(w)));
  assert.equal(idx.boards.nrf52840.usbInstall, 'opendisplay-xiao_nrf52840-mcuboot-install.uf2');
  assert.equal(idx.boards.nrf52840.otaImage, 'opendisplay-xiao_nrf52840-ota.bin');
  assert.equal(idx.boards.silabs_bg22.gbl, 'opendisplay-bg22.gbl');
  assert.equal(p.outputs['firmware-version.json'].repository, 'OpenDisplay/Firmware_Unified');
  for (const n of p.downloads) assert.ok(n.startsWith('opendisplay-'), n);
});

test('rejects 2.x releases, 2.x asset names and NVS-overlapping parts', () => {
  const m1 = manifest(); m1.version = '2.27.1';
  assert.throws(() => R.planSync(m1), /not a 3\.x release/);
  const m2 = manifest(); m2.images[0].files.merged.name = 'esp32-s3-N16R8_full.bin';
  assert.throws(() => R.planSync(m2), /collides with a 2\.x/);
  const m3 = manifest(); m3.images[0].files.app.offset = 0x9000;
  assert.throws(() => R.planSync(m3), /overlaps NVS/);
  const m4 = manifest(); m4.schema = 'x';
  assert.throws(() => R.planSync(m4), /schema/);
});

test('CLI, offline: writes only into its out dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odsync-'));
  const assets = path.join(tmp, 'assets'); const out = path.join(tmp, 'v3');
  fs.mkdirSync(assets);
  const m = manifest();
  for (const img of m.images) for (const f of Object.values(img.files)) fs.writeFileSync(path.join(assets, f.name), f.name);
  fs.copyFileSync(FIX, path.join(assets, 'manifest.json'));
  const script = path.join(__dirname, '..', '.github', 'scripts', 'sync-firmware-unified-release.js');
  execFileSync(process.execPath, [script, '--manifest', path.join(assets, 'manifest.json'), '--out', out], { stdio: 'pipe' });
  const files = fs.readdirSync(out);
  assert.ok(files.includes('index.json') && files.includes('opendisplay-bg22.gbl'));
  assert.ok(!files.some(f => /_full\.|^NRF52840\./.test(f)));
  // Second run: already synced.
  const again = execFileSync(process.execPath, [script, '--manifest', path.join(assets, 'manifest.json'), '--out', out]).toString();
  assert.match(again, /Already synced/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
