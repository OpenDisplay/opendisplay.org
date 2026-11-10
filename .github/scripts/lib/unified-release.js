/*
 * Firmware_Unified (3.x) release -> toolbox files. Pure: no network, no fs.
 * The CLI (../sync-firmware-unified-release.js) does the I/O; tests/unified-release.test.js
 * drives this module with tests/fixtures/unified-release-manifest.json.
 *
 * INPUT CONTRACT (assumed; to be reconciled with Firmware_Unified docs/RELEASE_ARTEFACTS.md,
 * which did not exist yet when this was written). A release carries `manifest.json`:
 *
 *   {
 *     "schema": "opendisplay.release", "schema_version": 1,
 *     "version": "3.0.0", "tag": "v3.0.0", "commit": "abc1234",
 *     "images": [
 *       { "target": "esp32-idf", "board": "s3-n16r8", "chip": "esp32s3",
 *         "files": {
 *           "merged":          { "name": "opendisplay-s3-n16r8-merged.bin", "offset": 0, "sha256": "…", "size": 1 },
 *           "bootloader":      { "name": "…-bootloader.bin", "offset": 0 },
 *           "partition_table": { "name": "…-partition-table.bin", "offset": 32768 },
 *           "ota_data":        { "name": "…-ota_data_initial.bin", "offset": 57344 },
 *           "app":             { "name": "…-app.bin", "offset": 65536 } } },
 *       { "target": "nordic-zephyr", "board": "xiao_nrf52840",
 *         "files": { "usb_install": { "name": "…-mcuboot-install.uf2" },   one-time, over USB
 *                    "serial_dfu":  { "name": "…-dfu.zip" },              Adafruit serial DFU package
 *                    "ota":         { "name": "…-ota.bin" } } },           MCUboot image for BLE OTA
 *       { "target": "nordic-zephyr", "board": "xiao_nrf54l15", "files": { "merged_hex": { "name": "….hex" }, "ota": {…} } },
 *       { "target": "efr32bg22-slc", "board": "bg22", "files": { "ota": { "name": "opendisplay-bg22.gbl" } } }
 *     ]
 *   }
 *
 * OUTPUT (all under httpdocs/firmware/toolbox/v3/, never under the 2.x bin/ and firmware/
 * paths and never with 2.x asset names, so a 2.x flasher path can not pick up a 3.x image):
 *   v3/<asset name>                    the release files, upstream names unchanged
 *   v3/esp32-<board>-install.json      ESP Web Tools manifest, merged image at 0 (fresh install, erases)
 *   v3/esp32-<board>-update.json       ESP Web Tools manifest, bootloader + partition table + otadata + app,
 *                                      NOT 0x9000-0xDFFF, so the 3.x NVS (config + key) survives an update
 *   v3/index.json                      what the toolbox reads: per toolbox install key -> files
 *   v3/firmware-version.json           { repository, tag, version, published_at, synced_at }
 */
'use strict';

const REPOSITORY = 'OpenDisplay/Firmware_Unified';
const SCHEMA = 'opendisplay.release';
const CHIP_FAMILY = { esp32: 'ESP32', esp32s3: 'ESP32-S3', esp32c3: 'ESP32-C3', esp32c6: 'ESP32-C6' };

/**
 * Toolbox install key -> Firmware_Unified board. The toolbox key is what board presets already
 * carry: the ESP32 manifest stem (bin/<stem>_full.json) or the install type.
 * Boards missing here (esp32-s3-N4R2, esp32-wrover-e-N4R8: no 3.x build) stay on 2.x.
 */
function toolboxKeyForImage(img) {
  if (img.target === 'esp32-idf') {
    const b = String(img.board);
    const m = /^(s3|c3|c6)-(.*)$/.exec(b);
    // s3-n16r8 -> esp32-s3-N16R8, s3-n16r8-extuart -> esp32-s3-N16R8-extuart, esp32-n4 -> esp32-N4
    const up = s => s.replace(/^(n\d+(?:r\d+)?)/, x => x.toUpperCase());
    if (m) return 'esp32-' + m[1] + '-' + up(m[2]);
    const c = /^esp32-(.*)$/.exec(b);
    return c ? 'esp32-' + up(c[1]) : null;
  }
  if (img.target === 'nordic-zephyr') {
    if (/nrf52840/.test(img.board)) return 'nrf52840';
    if (/nrf54l15/.test(img.board)) return 'nrf54l15';
    if (/nrf54lm20/.test(img.board)) return 'nrf54lm20';
    return null;
  }
  if (img.target === 'efr32bg22-slc') return 'silabs_bg22';
  return null;
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.schema !== SCHEMA) errors.push(`schema ${JSON.stringify(m.schema)} != ${SCHEMA}`);
  if (m.schema_version !== 1) errors.push(`unsupported schema_version ${m.schema_version}`);
  if (!/^\d+\.\d+\.\d+/.test(String(m.version || ''))) errors.push('version missing or not semver');
  const major = parseInt(String(m.version || '0'), 10);
  if (major < 3) errors.push(`version ${m.version} is not a 3.x release; 2.x stays with OpenDisplay/Firmware`);
  if (!Array.isArray(m.images) || !m.images.length) errors.push('no images');
  for (const img of m.images || []) {
    const where = `${img.target}/${img.board}`;
    if (!img.files || typeof img.files !== 'object') { errors.push(where + ': no files'); continue; }
    for (const [k, f] of Object.entries(img.files)) {
      if (!f || typeof f.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(f.name)) errors.push(`${where}.${k}: bad file name`);
      // Never let a 3.x file take a 2.x toolbox name.
      else if (/_full\.(bin|json)$/.test(f.name) || /^NRF52840\.(uf2|zip)$/.test(f.name) || /^nrf54l(15|m20a)\.hex$/.test(f.name)) {
        errors.push(`${where}.${k}: ${f.name} collides with a 2.x toolbox asset name`);
      }
    }
    if (img.target === 'esp32-idf') {
      if (!CHIP_FAMILY[img.chip]) errors.push(where + ': unknown chip ' + img.chip);
      if (!img.files.merged) errors.push(where + ': no merged image');
      const upd = ['bootloader', 'partition_table', 'ota_data', 'app'];
      if (upd.some(k => img.files[k]) && !upd.every(k => img.files[k] && Number.isInteger(img.files[k].offset))) {
        errors.push(where + ': update parts incomplete (need bootloader, partition_table, ota_data, app with offsets)');
      }
      for (const k of upd) {
        const f = img.files[k];
        if (f && Number.isInteger(f.offset) && f.offset >= 0x9000 && f.offset < 0xe000) errors.push(`${where}.${k}: offset 0x${f.offset.toString(16)} overlaps NVS`);
      }
    }
  }
  return errors;
}

function espManifest(version, family, parts, erase) {
  return {
    name: 'OpenDisplay Firmware 3',
    version,
    home_assistant_domain: 'open_display',
    new_install_prompt_erase: !!erase,
    new_install_improv_wait_time: 0,
    builds: [{ chipFamily: family, parts }]
  };
}

/**
 * @param {object} manifest release manifest.json
 * @param {object} release  { published_at } from the GitHub release (optional)
 * @param {string} syncedAt ISO time (injected for tests)
 * @returns {{ downloads: string[], outputs: Record<string, object>, warnings: string[] }}
 *   downloads: asset names to fetch into v3/; outputs: path (relative to v3/) -> JSON to write
 */
function planSync(manifest, release = {}, syncedAt = new Date().toISOString()) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error('release manifest rejected:\n  ' + errors.join('\n  '));
  const v = manifest.version;
  const downloads = new Set();
  const outputs = {};
  const warnings = [];
  const index = { repository: REPOSITORY, version: v, tag: manifest.tag || 'v' + v, generation: 'v3', boards: {} };
  for (const img of manifest.images) {
    const key = toolboxKeyForImage(img);
    if (!key) { warnings.push(`no toolbox board for ${img.target}/${img.board}; skipped`); continue; }
    const f = img.files;
    const entry = { target: img.target, board: img.board };
    for (const x of Object.values(f)) downloads.add(x.name);
    if (img.target === 'esp32-idf') {
      const family = CHIP_FAMILY[img.chip];
      const inst = `esp32-${img.board}-install.json`;
      outputs[inst] = espManifest(v, family, [{ path: f.merged.name, offset: 0 }], true);
      entry.installManifest = inst;
      if (f.app) {
        const upd = `esp32-${img.board}-update.json`;
        outputs[upd] = espManifest(v, family,
          ['bootloader', 'partition_table', 'ota_data', 'app'].map(k => ({ path: f[k].name, offset: f[k].offset })), false);
        entry.updateManifest = upd;
        entry.appImage = f.app.name;  // for BLE (SMP) OTA tools
      } else {
        warnings.push(`${img.board}: no split parts; a web update would have to erase the settings`);
      }
    } else if (key === 'nrf52840') {
      if (f.serial_dfu) entry.serialDfu = f.serial_dfu.name;
      if (f.usb_install) entry.usbInstall = f.usb_install.name;
      if (f.ota) entry.otaImage = f.ota.name;
      if (!f.serial_dfu && !f.usb_install) warnings.push(img.board + ': nothing installable over USB');
    } else if (key === 'nrf54l15' || key === 'nrf54lm20') {
      if (f.merged_hex) entry.hex = f.merged_hex.name;
      if (f.ota) entry.otaImage = f.ota.name;
    } else if (key === 'silabs_bg22') {
      if (f.ota) entry.gbl = f.ota.name;
    }
    if (index.boards[key]) warnings.push(`two images for ${key}; keeping the first`);
    else index.boards[key] = entry;
  }
  outputs['index.json'] = index;
  outputs['firmware-version.json'] = {
    repository: REPOSITORY, tag: index.tag, version: v,
    published_at: release.published_at || null, synced_at: syncedAt
  };
  return { downloads: Array.from(downloads).sort(), outputs, warnings };
}

module.exports = { REPOSITORY, SCHEMA, CHIP_FAMILY, toolboxKeyForImage, validateManifest, planSync };
