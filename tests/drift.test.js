// Drift guard: the files this site vendors must equal their sources.
//
//   tests/fixtures/sec2_vectors.json  <- py-opendisplay tests/fixtures/ and Firmware_Unified tests/host/fixtures/
//   tests/fixtures/user_texts.json    <- py-opendisplay tests/fixtures/
//   toolbox/drive-presets.json        <- Firmware_Unified panels/generated/drive_presets.json (via sync-drive-presets.py)
//   toolbox/drive-presets-nrf52811.json <- Firmware_NRF presets/drive_presets_nrf52811.json (same slimming)
//
// The source checkouts are found through OPENDISPLAY_PY_DIR, OPENDISPLAY_FW_DIR and
// OPENDISPLAY_FW_NRF52811_DIR, or as sibling folders named after their repositories. A test
// whose source is not checked out is skipped with the reason, so CI without them still passes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SYNC = path.join(REPO, '.github', 'scripts', 'sync-drive-presets.py');
const TOOLBOX = path.join(REPO, 'httpdocs', 'firmware', 'toolbox');

function checkout(envName, sibling, marker) {
  const dir = process.env[envName] || path.join(REPO, '..', sibling);
  return fs.existsSync(path.join(dir, marker)) ? dir : null;
}
const PY = checkout('OPENDISPLAY_PY_DIR', 'py-opendisplay', 'tests/fixtures/user_texts.json');
const FW = checkout('OPENDISPLAY_FW_DIR', 'Firmware_Unified', 'panels/generated/drive_presets.json');
const NRF = checkout('OPENDISPLAY_FW_NRF52811_DIR', 'Firmware_NRF', 'presets/drive_presets_nrf52811.json');
const skip = (dir, envName) => (dir ? false : `source not checked out (set ${envName})`);
const read = f => fs.readFileSync(f);

test('sec2_vectors.json equals py-opendisplay', { skip: skip(PY, 'OPENDISPLAY_PY_DIR') }, () => {
  const src = path.join(PY, 'tests', 'fixtures', 'sec2_vectors.json');
  assert.ok(read(src).equals(read(path.join(__dirname, 'fixtures', 'sec2_vectors.json'))), 'stale: copy it from ' + src);
});

test('sec2_vectors.json equals Firmware_Unified', { skip: skip(FW, 'OPENDISPLAY_FW_DIR') }, () => {
  const src = path.join(FW, 'tests', 'host', 'fixtures', 'sec2_vectors.json');
  assert.ok(read(src).equals(read(path.join(__dirname, 'fixtures', 'sec2_vectors.json'))), 'differs from ' + src);
});

test('user_texts.json equals py-opendisplay', { skip: skip(PY, 'OPENDISPLAY_PY_DIR') }, () => {
  const src = path.join(PY, 'tests', 'fixtures', 'user_texts.json');
  assert.ok(read(src).equals(read(path.join(__dirname, 'fixtures', 'user_texts.json'))), 'stale: copy it from ' + src);
});

function syncCheck(args) {
  const r = spawnSync('python3', [SYNC, ...args, '--check'], { encoding: 'utf8' });
  if (r.error) return { skipped: 'python3 not available' };
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

test('drive-presets.json is up to date with Firmware_Unified', { skip: skip(FW, 'OPENDISPLAY_FW_DIR') }, (t) => {
  const r = syncCheck([FW]);
  if (r.skipped) return t.skip(r.skipped);
  assert.ok(r.ok, r.out);
});

test('drive-presets-nrf52811.json is up to date with Firmware_NRF', { skip: skip(NRF, 'OPENDISPLAY_FW_NRF52811_DIR') }, (t) => {
  const r = syncCheck(['--src', path.join(NRF, 'presets', 'drive_presets_nrf52811.json'),
    '--out', path.join(TOOLBOX, 'drive-presets-nrf52811.json')]);
  if (r.skipped) return t.skip(r.skipped);
  assert.ok(r.ok, r.out);
});
