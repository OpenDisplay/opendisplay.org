'use strict';
// Fixture: tests/fixtures/unified-release/ is shaped like a Firmware_Unified release per
// docs/RELEASE_ARTEFACTS.md (schema opendisplay-release/1). Binary assets are not stored: their
// content is their own file name, and the manifest's sha256/size match that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const R = require('../.github/scripts/lib/unified-release.js');

const FIXDIR = path.join(__dirname, 'fixtures', 'unified-release');
const FIX = path.join(FIXDIR, 'manifest.json');
const manifest = () => JSON.parse(fs.readFileSync(FIX, 'utf8'));
const SCRIPT = path.join(__dirname, '..', '.github', 'scripts', 'sync-firmware-unified-release.js');

function assetsDir(m = manifest()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'odsync-'));
  const assets = path.join(tmp, 'assets');
  fs.mkdirSync(assets);
  for (const a of m.artefacts) {
    const src = path.join(FIXDIR, a.file);
    fs.writeFileSync(path.join(assets, a.file), fs.existsSync(src) ? fs.readFileSync(src) : a.file);
  }
  fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify(m));
  return { tmp, assets, out: path.join(tmp, 'v3') };
}

test('toolbox keys come from legacy_names and match the existing board presets', () => {
  const k = (target, legacy_names) => R.toolboxKeysForBoard({ target, legacy_names });
  assert.deepEqual(k('esp32-idf', ['esp32-s3-N16R8']), ['esp32-s3-N16R8']);
  assert.deepEqual(k('nordic-zephyr', ['NRF52840']), ['nrf52840']);
  assert.deepEqual(k('nordic-zephyr', ['nrf54lm20a']), ['nrf54lm20']);
  assert.deepEqual(k('nordic-zephyr', ['nrf54l15']), ['nrf54l15']);
  assert.deepEqual(k('efr32bg22-slc', ['opendisplay-bg22']), ['silabs_bg22']);
  assert.deepEqual(k('something-new', ['x']), []);
  // Every ESP32 legacy name in the contract's board table is a real 2.x manifest stem here.
  const bin = path.join(__dirname, '..', 'httpdocs', 'firmware', 'toolbox', 'bin');
  const stems = fs.readdirSync(bin).filter(f => f.endsWith('_full.json')).map(f => f.replace('_full.json', ''));
  for (const n of ['esp32-s3-N16R8', 'esp32-s3-N16R8-extuart', 'esp32-s3-N32R8', 'esp32-s3-N32R8-extuart', 'esp32-s3-N8R8',
    'esp32-s3-N4R2', 'esp32-c3-N4', 'esp32-c3-N16', 'esp32-c6-N4', 'esp32-N4', 'esp32-wrover-e-N4R8']) {
    assert.ok(stems.includes(n), n);
  }
});

test('bareVersion: v3.0.0 and 3.0.0 are the same version', () => {
  assert.equal(R.bareVersion('v3.0.0'), '3.0.0');
  assert.equal(R.bareVersion('3.0.0'), '3.0.0');
  const m = manifest(); m.tag = 'v3.0.0';
  assert.doesNotThrow(() => R.planSync(m));
  m.tag = '3.0.1';
  assert.throws(() => R.planSync(m), /does not match version/);
});

test('plan: flows per board, only USB flows hosted, nothing under 2.x names', () => {
  const p = R.planSync(manifest(), { published_at: '2026-11-11T00:00:00Z' }, '2026-11-11T01:00:00Z');
  const idx = p.outputs['index.json'];
  assert.equal(idx.generation, 'v3');
  assert.equal(idx.version, '3.0.0');
  const s3 = idx.boards['esp32-s3-N16R8'];
  assert.equal(s3.flows['usb-install'].webManifest, 'opendisplay-s3-n16r8-install-manifest.json');
  assert.equal(s3.flows['usb-install'].erasesConfig, true);
  assert.equal(s3.flows['usb-update'].webManifest, 'opendisplay-s3-n16r8-manifest.json');
  assert.equal(s3.flows['usb-update'].erasesConfig, false);
  assert.equal(s3.flows['ble-ota'].hosted, false);
  // c3-n4 ships no usb-update flow in the fixture: none is offered, and nothing falls back.
  assert.equal(idx.boards['esp32-c3-N4'].flows['usb-update'], undefined);
  // nRF52840: two ordered serial-DFU steps.
  assert.deepEqual(idx.boards.nrf52840.flows['usb-install'].files,
    ['opendisplay-xiao_nrf52840-usb-1-sd-erase.zip', 'opendisplay-xiao_nrf52840-usb-2-install.zip']);
  assert.deepEqual(idx.boards.nrf52840.flows['usb-install'].types, ['nrfutil-dfu-zip', 'nrfutil-dfu-zip']);
  assert.equal(idx.boards.silabs_bg22.flows['ble-ota-from-2x'].hosted, false);
  assert.ok(!p.downloads.includes('opendisplay-bg22-ota.gbl'), 'BG22 is not flashed by the website');
  assert.ok(p.downloads.includes('opendisplay-s3-n16r8-merged.bin'));
  assert.equal(p.webManifests.length, 5);
  for (const n of p.downloads) { assert.ok(n.startsWith('opendisplay-'), n); assert.ok(!R.isLegacyName(n), n); }
  assert.equal(p.outputs['firmware-version.json'].repository, 'OpenDisplay/Firmware_Unified');
});

test('unknown artefact types are ignored: the flow that needs one is not offered', () => {
  const m = manifest();
  m.artefacts.find(a => a.file === 'opendisplay-xiao_nrf54l15-merged.hex').type = 'mystery';
  const p = R.planSync(m);
  assert.equal(p.outputs['index.json'].boards.nrf54l15.flows['usb-install'], undefined);
  assert.ok(p.warnings.some(w => /unknown artefact type/.test(w)));
});

test('rejects 2.x releases, 2.x asset names, NVS-overlapping update parts and a wrong schema', () => {
  const m1 = manifest(); m1.version = '2.27.1'; m1.tag = '2.27.1';
  assert.throws(() => R.planSync(m1), /not a 3\.x release/);
  for (const bad of ['esp32-s3-N16R8_full.bin', 'NRF52840.zip', 'nrf54l15-3.0.0.hex', 'opendisplay-bg22-v3.0.0.gbl']) {
    const m2 = manifest(); m2.artefacts[0].file = bad;
    assert.throws(() => R.planSync(m2), /2\.x asset name/, bad);
  }
  const m3 = manifest(); m3.artefacts.find(a => a.file === 'opendisplay-s3-n16r8-app.bin').offset = 0x9000;
  assert.throws(() => R.planSync(m3), /overlaps NVS/);
  const m4 = manifest(); m4.schema = 'opendisplay.release';
  assert.throws(() => R.planSync(m4), /schema/);
  const m5 = manifest(); m5.boards[0].flows['usb-install'].files.push('opendisplay-s3-n16r8-nope.bin');
  assert.throws(() => R.planSync(m5), /not in artefacts/);
});

test('web manifest check: update keeps NVS and does not prompt erase; install is one image at 0', () => {
  const m = manifest();
  const b = m.boards.find(x => x.board === 's3-n16r8');
  const upd = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'opendisplay-s3-n16r8-manifest.json'), 'utf8'));
  assert.deepEqual(R.validateWebManifest(upd, b.flows['usb-update'], m.artefacts, 'update'), []);
  const erasing = JSON.parse(JSON.stringify(upd)); erasing.new_install_prompt_erase = true;
  assert.match(R.validateWebManifest(erasing, b.flows['usb-update'], m.artefacts, 'update').join(), /new_install_prompt_erase/);
  const nvs = JSON.parse(JSON.stringify(upd)); nvs.builds[0].parts[1].offset = 0x9000;
  assert.match(R.validateWebManifest(nvs, b.flows['usb-update'], m.artefacts, 'update').join(), /NVS/);
  const remote = JSON.parse(JSON.stringify(upd)); remote.builds[0].parts[0].path = 'https://example.invalid/x.bin';
  assert.ok(R.validateWebManifest(remote, b.flows['usb-update'], m.artefacts, 'update').length);
  const inst = JSON.parse(fs.readFileSync(path.join(FIXDIR, 'opendisplay-s3-n16r8-install-manifest.json'), 'utf8'));
  assert.deepEqual(R.validateWebManifest(inst, b.flows['usb-install'], m.artefacts, 'install'), []);
});

test('CLI, offline: checks sha256, writes only into its out dir, second run is a no-op', () => {
  const { tmp, assets, out } = assetsDir();
  execFileSync(process.execPath, [SCRIPT, '--manifest', path.join(assets, 'manifest.json'), '--out', out], { stdio: 'pipe' });
  const files = fs.readdirSync(out);
  assert.ok(files.includes('index.json') && files.includes('opendisplay-s3-n16r8-manifest.json'));
  assert.ok(files.includes('opendisplay-xiao_nrf52840-usb-2-install.zip'));
  assert.ok(!files.includes('opendisplay-bg22-ota.gbl'));
  assert.ok(!files.some(f => R.isLegacyName(f)));
  const again = execFileSync(process.execPath, [SCRIPT, '--manifest', path.join(assets, 'manifest.json'), '--out', out]).toString();
  assert.match(again, /Already synced/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI, offline: a tampered asset or a bad web manifest leaves the out dir untouched', () => {
  const { tmp, assets, out } = assetsDir();
  fs.writeFileSync(path.join(assets, 'opendisplay-s3-n16r8-app.bin'), 'tampered');
  let r = spawnSync(process.execPath, [SCRIPT, '--manifest', path.join(assets, 'manifest.json'), '--out', out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /sha256 mismatch|size/);
  assert.ok(!fs.existsSync(out));
  fs.rmSync(tmp, { recursive: true, force: true });
  // A web manifest whose sha matches but whose content prompts an erase on update.
  const m = manifest();
  const f = 'opendisplay-s3-n16r8-manifest.json';
  const bad = JSON.parse(fs.readFileSync(path.join(FIXDIR, f), 'utf8')); bad.new_install_prompt_erase = true;
  const buf = Buffer.from(JSON.stringify(bad));
  const a = m.artefacts.find(x => x.file === f);
  a.size = buf.length; a.sha256 = require('node:crypto').createHash('sha256').update(buf).digest('hex');
  const d = assetsDir(m);
  fs.writeFileSync(path.join(d.assets, f), buf);
  r = spawnSync(process.execPath, [SCRIPT, '--manifest', path.join(d.assets, 'manifest.json'), '--out', d.out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr.toString(), /new_install_prompt_erase/);
  assert.ok(!fs.existsSync(d.out));
  fs.rmSync(d.tmp, { recursive: true, force: true });
});
