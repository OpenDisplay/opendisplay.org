/*
 * Firmware_Unified (3.x) release -> toolbox files. Pure: no network, no fs.
 * The CLI (../sync-firmware-unified-release.js) does the I/O; tests/unified-release.test.js
 * drives this module with tests/fixtures/unified-release/manifest.json.
 *
 * INPUT CONTRACT: Firmware_Unified docs/RELEASE_ARTEFACTS.md (schema `opendisplay-release/1`,
 * written against commit 7a3f409 of that file). Every release carries `manifest.json`:
 *   { schema, repository, version (bare X.Y.Z), tag (as pushed), commit, signing,
 *     boards:    [{ board, target, chip, legacy_names[], flows: { <flow>: { files[], web_manifest?,
 *                   erases_config, requires?, protocol? } } }],
 *     artefacts: [{ file, board, type, offset|null, size, sha256, load_address? }] }
 * Rules taken from that document and enforced here:
 *   - read the manifest, never pattern-match file names to find files;
 *   - an unknown artefact `type` is ignored, never guessed at (a flow that needs one is dropped);
 *   - a missing flow means nothing is offered for it: there is no fallback to another flow;
 *   - a 3.x file never carries a 2.x asset name.
 *
 * OUTPUT (all under httpdocs/firmware/toolbox/v3/, never under the 2.x bin/ and firmware/
 * paths and never with 2.x asset names, so a 2.x flasher path can not pick up a 3.x image):
 *   v3/<asset name>            the files of the USB flows, upstream names unchanged, including
 *                              the upstream esp-web-tools manifests (validated, not regenerated)
 *   v3/index.json              what the toolbox reads: toolbox board key -> board + flows
 *   v3/firmware-version.json   { repository, tag, version, published_at, synced_at }
 * BLE OTA files are listed in index.json (for reference) but not hosted: the toolbox does not
 * OTA, and Home Assistant / py-opendisplay read the release directly.
 */
'use strict';

const REPOSITORY = 'OpenDisplay/Firmware_Unified';
const SCHEMA = 'opendisplay-release/1';
const KNOWN_TYPES = new Set(['merged', 'bootloader', 'partition-table', 'ota-data', 'app',
  'web-manifest-update', 'web-manifest-install', 'merged-hex', 'ota', 'smp-dfu-zip',
  'nrfutil-dfu-zip', 'gbl', 's37', 'hex', 'bootloader-s37']);
const KNOWN_FLOWS = ['usb-install', 'usb-update', 'ble-ota', 'ble-ota-from-2x'];
/** Flows whose files the website hosts (it flashes over USB only). */
const HOSTED_FLOWS = ['usb-install', 'usb-update'];
const NVS_START = 0x9000, NVS_END = 0xE000;  // ESP32 NVS (config + key); 0xE000 is otadata
const BOARDLESS = new Set(['manifest.json', 'SHA256SUMS', 'LICENSE', 'NOTICE.md']);
// RELEASE_ARTEFACTS.md § 1 rule 2: names the 2.x updaters match. A 3.x file must never take one.
const LEGACY_NAME_PATTERNS = [/_full\.(bin|json)$/, /^NRF52840\./, /^nrf54l15-/, /^nrf54lm20a-/,
  /^opendisplay-bg22-v/, /^bootloader-apploader-v/, /app_update\.bin$/, /^EPD-nRF52-/, /^esp32-.*\.bin$/];

/** Leading `v` optional on either side: "v3.0.0" and "3.0.0" are the same version. */
function bareVersion(v) { return String(v == null ? '' : v).trim().replace(/^v/i, ''); }

/**
 * Toolbox install keys for one manifest board. The toolbox key is what board presets carry:
 * the ESP32 manifest stem (bin/<stem>_full.json, which is what `legacy_names` lists) or the
 * install type for the others. Unknown targets map to nothing and stay on 2.x.
 */
function toolboxKeysForBoard(b) {
  const names = Array.isArray(b.legacy_names) ? b.legacy_names : [];
  if (b.target === 'esp32-idf') return names.filter(n => /^esp32-[A-Za-z0-9-]+$/.test(n));
  if (b.target === 'nordic-zephyr') {
    const out = [];
    for (const n of names) {
      const l = String(n).toLowerCase();
      if (l === 'nrf52840') out.push('nrf52840');
      else if (l === 'nrf54l15') out.push('nrf54l15');
      else if (l === 'nrf54lm20a' || l === 'nrf54lm20') out.push('nrf54lm20');
    }
    return out;
  }
  if (b.target === 'efr32bg22-slc') return ['silabs_bg22'];
  return [];
}

function isLegacyName(name) { return LEGACY_NAME_PATTERNS.some(re => re.test(name)); }

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.schema !== SCHEMA) errors.push(`schema ${JSON.stringify(m.schema)} != ${SCHEMA}`);
  if (m.repository && m.repository !== REPOSITORY) errors.push(`repository ${m.repository} != ${REPOSITORY}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) errors.push('version missing or not bare X.Y.Z');
  if (parseInt(String(m.version || '0'), 10) < 3) errors.push(`version ${m.version} is not a 3.x release; 2.x stays with OpenDisplay/Firmware`);
  if (m.tag != null && bareVersion(m.tag) !== String(m.version)) errors.push(`tag ${m.tag} does not match version ${m.version}`);
  if (!Array.isArray(m.boards) || !m.boards.length) errors.push('no boards');
  if (!Array.isArray(m.artefacts)) errors.push('no artefacts');
  const byFile = new Map();
  for (const a of m.artefacts || []) {
    if (!a || typeof a.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(a.file)) { errors.push(`bad artefact file name ${a && a.file}`); continue; }
    if (isLegacyName(a.file)) errors.push(`${a.file} collides with a 2.x asset name`);
    if (!BOARDLESS.has(a.file) && !/^MANIFEST-/.test(a.file) && !a.file.startsWith(`opendisplay-${a.board}-`)) {
      errors.push(`${a.file}: not opendisplay-<board>-<kind> for board ${a.board}`);
    }
    if (a.sha256 != null && !/^[0-9a-f]{64}$/.test(a.sha256)) errors.push(`${a.file}: bad sha256`);
    if (byFile.has(a.file)) errors.push(`${a.file}: listed twice`);
    byFile.set(a.file, a);
  }
  for (const b of m.boards || []) {
    const flows = (b && b.flows) || {};
    for (const [name, f] of Object.entries(flows)) {
      if (!KNOWN_FLOWS.includes(name)) continue;
      for (const file of [...(f.files || []), ...(f.web_manifest ? [f.web_manifest] : [])]) {
        if (!byFile.has(file)) errors.push(`${b.board}.${name}: ${file} is not in artefacts`);
      }
      if (b.target === 'esp32-idf' && name === 'usb-update') {
        for (const file of f.files || []) {
          const a = byFile.get(file);
          if (!a) continue;
          const end = Number.isInteger(a.size) ? a.offset + a.size : a.offset + 1;
          if (!Number.isInteger(a.offset)) errors.push(`${file}: update part without an integer offset`);
          else if (a.offset < NVS_END && end > NVS_START) errors.push(`${file}: 0x${a.offset.toString(16)}+${a.size} overlaps NVS 0x9000-0xDFFF`);
        }
        if (f.erases_config !== false) errors.push(`${b.board}.usb-update must have erases_config: false`);
      }
    }
  }
  return errors;
}

/**
 * Check an upstream esp-web-tools manifest against its flow and the artefact table.
 * kind: 'install' | 'update'. Returns a list of problems (empty = fine).
 */
function validateWebManifest(json, flow, artefacts, kind) {
  const errs = [];
  const byFile = new Map((artefacts || []).map(a => [a.file, a]));
  const builds = json && Array.isArray(json.builds) ? json.builds : null;
  if (!builds || builds.length !== 1) return ['web manifest needs exactly one build'];
  const parts = builds[0].parts || [];
  const names = parts.map(p => String(p.path || '').split('/').pop());
  if (JSON.stringify(names) !== JSON.stringify(flow.files || [])) errs.push(`parts ${names.join(',')} != flow files ${(flow.files || []).join(',')}`);
  parts.forEach((p, i) => {
    if (/^[a-z]+:|^\/|\.\./i.test(String(p.path || ''))) errs.push(`part ${p.path}: must be a bare file name next to the manifest`);
    const a = byFile.get(names[i]);
    if (a && Number.isInteger(a.offset) && p.offset !== a.offset) errs.push(`part ${names[i]}: offset ${p.offset} != artefact ${a.offset}`);
    if (kind === 'update' && Number.isInteger(p.offset)) {
      const size = a && Number.isInteger(a.size) ? a.size : 1;
      if (p.offset < NVS_END && p.offset + size > NVS_START) errs.push(`part ${names[i]} overlaps NVS`);
    }
  });
  if (kind === 'update' && json.new_install_prompt_erase !== false) errs.push('update manifest must set new_install_prompt_erase: false');
  if (kind === 'install' && !(parts.length === 1 && parts[0].offset === 0)) errs.push('install manifest must be one merged image at 0');
  return errs;
}

/**
 * @param {object} manifest release manifest.json
 * @param {object} release  { published_at } from the GitHub release (optional)
 * @param {string} syncedAt ISO time (injected for tests)
 * @returns {{ downloads: string[], webManifests: {file,board,kind,flow}[], outputs: Record<string, object>, warnings: string[] }}
 *   downloads: asset names to fetch into v3/ (web manifests included); webManifests: the ones the
 *   CLI must check with validateWebManifest after download; outputs: path (relative to v3/) -> JSON
 */
function planSync(manifest, release = {}, syncedAt = new Date().toISOString()) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error('release manifest rejected:\n  ' + errors.join('\n  '));
  const v = manifest.version;
  const byFile = new Map(manifest.artefacts.map(a => [a.file, a]));
  const downloads = new Set();
  const webManifests = [];
  const warnings = [];
  const index = { schema: 'opendisplay-toolbox-v3/1', repository: REPOSITORY, version: v, tag: manifest.tag || v, generation: 'v3', boards: {} };
  for (const b of manifest.boards) {
    const keys = toolboxKeysForBoard(b);
    if (!keys.length) { warnings.push(`no toolbox board for ${b.target}/${b.board}; skipped`); continue; }
    const flows = {};
    for (const name of KNOWN_FLOWS) {
      const f = b.flows && b.flows[name];
      if (!f) continue;  // missing flow: nothing offered, no fallback
      const files = (f.files || []).map(file => byFile.get(file));
      const unknown = files.filter(a => !KNOWN_TYPES.has(a.type));
      if (unknown.length) { warnings.push(`${b.board}.${name}: unknown artefact type ${unknown.map(a => a.type).join(',')}; flow not offered`); continue; }
      const out = { files: f.files.slice(), types: files.map(a => a.type), erasesConfig: f.erases_config !== false };
      if (f.requires) out.requires = f.requires;
      if (f.protocol) out.protocol = f.protocol;
      if (f.web_manifest) out.webManifest = f.web_manifest;
      out.hosted = HOSTED_FLOWS.includes(name);
      if (out.hosted) {
        f.files.forEach(x => downloads.add(x));
        if (f.web_manifest) {
          downloads.add(f.web_manifest);
          webManifests.push({ file: f.web_manifest, board: b.board, kind: name === 'usb-update' ? 'update' : 'install', flow: f });
        }
      }
      flows[name] = out;
    }
    const entry = { board: b.board, target: b.target, chip: b.chip, flows };
    for (const key of keys) {
      if (index.boards[key]) warnings.push(`two boards for ${key}; keeping ${index.boards[key].board}`);
      else index.boards[key] = entry;
    }
  }
  const outputs = {
    'index.json': index,
    'firmware-version.json': { repository: REPOSITORY, tag: index.tag, version: v, published_at: release.published_at || null, synced_at: syncedAt }
  };
  return { downloads: Array.from(downloads).sort(), webManifests, outputs, warnings };
}

/** Artefact entry for a file (sha256 / size checks in the CLI). */
function artefactFor(manifest, file) {
  return (manifest.artefacts || []).find(a => a.file === file) || null;
}

module.exports = { REPOSITORY, SCHEMA, KNOWN_TYPES, KNOWN_FLOWS, bareVersion, isLegacyName, toolboxKeysForBoard, validateManifest, validateWebManifest, planSync, artefactFor };
