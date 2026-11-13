/*
 * Toolbox glue for firmware 3.x (config-driven panels). Loaded after the Toolbox's own
 * inline script, whose globals it uses (instances, schema, bleLib, simpleConfigPresets, ...).
 * The decisions live in /js/od-v3.js (pure, unit-tested); this file only wires them to
 * the page: version gate, panel availability, size limits, migration on connect,
 * config backup / restore, and the 2.x -> 3.x guided update.
 *
 * Nothing here has been run in a browser by its author; see tests/od-v3.test.js for what
 * is covered by unit tests.
 */
/* global OpenDisplayV3, instances:writable, schema, bleLib, simpleConfigPresets, simpleConfigSelections,
   tbFirmwareVersion, tbMode, addLog, tbFlash, collectPacketBytes, parseRawBytes, renderEditor,
   editorMarkClean, toolboxDeviceName, connectToBleDevice, ensureAuthenticatedOnDemand, isAuthError,
   updateTotalBytesDisplay, renderDeviceHome, tbScreen */
'use strict';

const V3 = OpenDisplayV3;
let tbDriveDb = null;              // Map panel_ic_type -> drive entry (od-v3.js buildDriveDb)
let tbDriveDbSource = 'none';      // 'drive-presets.json' | 'presets' | 'none'
let tbInstallGeneration = null;    // generation of the firmware the install screen will flash
let tbInstallGenerationChosen = false; // true when the user picked that version explicitly
let tbLastBackup = null;           // { bytes, meta, savedAt } read before an update
let tbMigrationInFlight = false;
let tbDeviceIdent = null;          // parsed READ_IDENT of the connected 3.x device (od-v3.js parseReadIdent)

// ---- the version gate, as the page sees it ----------------------------------
/** Generation of the CONNECTED device, from its 0x0043 reply. */
function tbDeviceGeneration() {
  return bleLib && bleLib.isConnected ? V3.firmwareGeneration(tbFirmwareVersion) : 'unknown';
}
/**
 * Generation the config being built is FOR (od-v3.js pickerGeneration): the connected device;
 * with nothing connected, an explicitly picked install version, else 3.x.
 */
function tbTargetGeneration() {
  const connected = !!(bleLib && bleLib.isConnected);
  return V3.pickerGeneration({ connected, deviceGen: tbDeviceGeneration(),
    chosenInstallGen: tbInstallGenerationChosen ? tbInstallGeneration : null });
}
/**
 * Firmware-side "needs migration" flag (READ_IDENT / MSD), when the firmware provides it.
 * Interface: bleLib.deviceNeedsMigration (boolean) set by whoever parses READ_IDENT or the
 * advertisement. Absent today, so the config check (no 0xB1 / 0xAE) is what triggers.
 */
function tbDeviceSaysNeedsMigration() {
  return !!(bleLib && bleLib.deviceNeedsMigration);
}

/** Read READ_IDENT (3.x only; 2.x devices never wait on a silent opcode). Cleared on every call. */
async function tbRefreshIdent() {
  tbDeviceIdent = null;
  if (!V3.isConfigDriven(tbDeviceGeneration())) return null;
  try { tbDeviceIdent = V3.parseReadIdent(await bleLib.readIdent(1500)); } catch (e) { tbDeviceIdent = null; }
  if (tbDeviceIdent) bleLib.deviceNeedsMigration = tbDeviceIdent.needsMigration;
  return tbDeviceIdent;
}
/**
 * Drive class of the device the config is for (od-v3.js deviceTargetClass): READ_IDENT fw_target
 * when connected, else the chip / board family; unknown -> the restrictive (BG22) class.
 */
function tbTargetClassInfo() {
  const connected = !!(bleLib && bleLib.isConnected);
  return V3.deviceTargetClass({ identTarget: connected && tbDeviceIdent ? tbDeviceIdent.target : null, target: tbConfigTarget() });
}
function tbTargetClass() { return tbTargetClassInfo().cls; }
/**
 * Inputs planMigration() needs beyond the class: the chip family (READ_IDENT fw_target when
 * connected, else the config's chip) and the BUILTIN_DRIVER bit (0xB3 panels, ESP32 only).
 */
function tbMigrationFacts() {
  const connected = !!(bleLib && bleLib.isConnected);
  const id = connected ? tbDeviceIdent : null;
  return { chip: (id && V3.targetFromIdent(id.target)) || tbConfigTarget() || null,
    builtinDriver: id && id.flags != null ? id.builtinDriver : null };
}
/** Drive limits: what the connected device reports in READ_IDENT, else the class table. */
function tbDriveLimits() {
  const connected = !!(bleLib && bleLib.isConnected);
  return V3.limitsFromIdent(connected ? tbDeviceIdent : null, tbTargetClass()).limits;
}

// ---- drive database -----------------------------------------------------------
async function tbFetchJson(name) {
  try {
    const r = await fetch(name, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
async function tbLoadDriveDb() {
  // drive-presets.json: Firmware_Unified (ESP32, nRF52840, nRF54, BG22).
  // drive-presets-nrf52811.json: Firmware_NRF 3.0, panel ids 0xE000-0xE1FF, nRF52811 only.
  const [generated, nrf52811] = await Promise.all([tbFetchJson('drive-presets.json'), tbFetchJson('drive-presets-nrf52811.json')]);
  const classFiles = nrf52811 ? { nrf52811 } : {};
  try {
    tbDriveDb = V3.buildDriveDb({ generated, classFiles, displays: (simpleConfigPresets && simpleConfigPresets.displays) || [] });
    tbDriveDbSource = generated ? 'drive-presets.json' : 'presets';
  } catch (e) {
    addLog('Panel drive data could not be loaded: ' + e.message + '. Using the built-in presets only.', 'error');
    tbDriveDb = V3.buildDriveDb({ displays: (simpleConfigPresets && simpleConfigPresets.displays) || [] });
    tbDriveDbSource = 'presets';
  }
  tbAnnotateDisplayOptions();
  return tbDriveDb;
}
function tbDriveEntryFor(display) {
  if (!display || !tbDriveDb) return null;
  return V3.driveEntryFor(tbDriveDb, V3.displayPanelIcType(display, tbTargetGeneration()), tbTargetClass());
}
function tbDisplayAvailability(display, gen) {
  return V3.driveAvailability(display, tbDriveDb, gen || tbTargetGeneration(), tbTargetClass());
}
/**
 * Mark display options for the generation the config is for: 3.x panels without drive data
 * are disabled with the reason; unverified ones get "untested on glass". 2.x: unchanged.
 */
function tbAnnotateDisplayOptions() {
  const sel = document.getElementById('displaySelect');
  if (!sel || !simpleConfigPresets) return;
  const gen = tbTargetGeneration();
  for (const o of Array.from(sel.options)) {
    if (!o.value) continue;
    const d = simpleConfigPresets.displays.find(x => x.id === o.value);
    if (!d) continue;
    if (!o.dataset.baseLabel) o.dataset.baseLabel = o.textContent;
    const a = tbDisplayAvailability(d, gen);
    const badge = V3.isConfigDriven(gen) ? V3.badgeText(a) : '';
    o.textContent = o.dataset.baseLabel + (badge ? ' (' + badge + ')' : '');
    o.disabled = !a.selectable;
    o.title = a.selectable ? (a.paletteWarning || '') : a.reason;
  }
  const chosen = sel.selectedOptions[0];
  if (chosen && chosen.disabled) {
    tbFlash(chosen.title || 'That display is not available on firmware 3.x yet.');
    sel.value = '';
    if (typeof handleDisplayChange === 'function') handleDisplayChange();
  }
}
/** Hook for mergeSimpleConfigToFull: make the drive packets match the selected display. */
function tbSyncDrivePackets() {
  const d = simpleConfigSelections && simpleConfigSelections.display;
  if (!d) return;
  const gen = tbTargetGeneration();
  instances.packets = V3.syncDrivePackets(instances.packets, tbDriveEntryFor(d), gen,
    () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6), tbTargetClass());
}

// ---- config size ---------------------------------------------------------------
function tbConfigTarget() {
  const sys = instances && instances.packets && instances.packets.find(p => String(p.pid) === '1' && p.fields);
  const t = sys ? V3.targetFromIcType(sys.fields.ic_type) : 'unknown';
  if (t !== 'unknown') return t;
  const b = simpleConfigSelections && simpleConfigSelections.driverBoard;
  return b && b.installConfig ? V3.targetFromInstallType(b.installConfig.type) : 'unknown';
}
function tbCheckConfigSize(length) {
  return V3.checkConfigSize(length, tbConfigTarget(), tbTargetGeneration());
}
/**
 * Second line of defence before every write to a 3.x device: each drive sequence in the editor
 * model must run on the device's class (BG22: 128 B / 64 steps, no WINDOW/FILL).
 */
function tbCheckDriveFit() {
  if (!V3.isConfigDriven(tbTargetGeneration())) return { ok: true, message: '' };
  const cls = tbTargetClass();
  const r = V3.checkDrivePacketsFit(V3.drivePacketsOf(instances && instances.packets), cls, tbDriveLimits());
  return { ok: r.ok, message: r.ok ? '' : 'Not written: the panel drive data does not run on this device ('
    + (cls === 'bg22' ? 'EFR32BG22' : cls) + '): ' + r.problems.join('; ') + '.' };
}
/** Throws a friendly error when the built config would not fit the device. */
/**
 * A target without a security module (nRF52811) refuses the whole config when it carries a
 * secret (od-v3.js checkSecretsSupported), so say so before writing.
 */
function tbCheckSecrets() {
  const target = tbConfigTarget();
  const r = V3.checkSecretsSupported(instances && instances.packets, target);
  const chip = target === 'nrf52811' ? 'nRF52811' : target;
  return { ok: r.ok, message: r.ok ? '' : 'Not written: this device (' + chip
    + ') does not support encryption, so it refuses a configuration with '
    + r.problems.join(', ') + '. Remove ' + (r.problems.length > 1 ? 'them' : 'it') + ' and write again.' };
}
function tbAssertConfigFits(bytes) {
  const c = tbCheckConfigSize(bytes.length);
  const d = c.ok ? tbCheckDriveFit() : { ok: true };
  const sx = c.ok && d.ok ? tbCheckSecrets() : { ok: true };
  if (!c.ok || !d.ok || !sx.ok) {
    const err = new Error(!c.ok ? c.message : !d.ok ? d.message : sx.message);
    err.tbFriendly = true;
    throw err;
  }
  return c;
}

// ---- schema-derived legacy sizes for the byte-level walker ----------------------
function tbLegacySize(id) {
  const def = schema && schema.packet_types && schema.packet_types[String(id)];
  if (!def) return null;
  let n = 0;
  for (const f of def.fields) {
    const s = parseInt(f.size, 10);
    if (!Number.isFinite(s) || String(s) !== String(f.size).trim()) return null;
    n += s;
  }
  return n;
}

// ---- raw BLE read/write ---------------------------------------------------------
function tbReadRawConfigOnce() {
  return new Promise((resolve, reject) => {
    bleLib.readConfig((bytes, err) => err ? reject(err) : resolve(Uint8Array.from(bytes || [])));
  });
}
async function tbReadRawConfig() {
  try { return await tbReadRawConfigOnce(); } catch (e) {
    if (!isAuthError(e)) throw e;
    await ensureAuthenticatedOnDemand();
    return tbReadRawConfigOnce();
  }
}
async function tbWriteRawConfig(bytes) {
  try { await bleLib.writeConfig(bytes); } catch (e) {
    if (!isAuthError(e)) throw e;
    await ensureAuthenticatedOnDemand();
    await bleLib.writeConfig(bytes);
  }
}
/** Write the editor model, read it back, and check the device kept exactly that. */
async function tbWriteAndVerify({ expectDrive }) {
  const bytes = new Uint8Array(collectPacketBytes());
  tbAssertConfigFits(bytes);
  await tbWriteRawConfig(bytes);
  await bleLib.delay(800);
  const back = await tbReadRawConfig();
  const same = V3.compareConfigs(bytes, back, tbLegacySize);
  if (!same.equal) throw new Error('The device did not keep the configuration as written (' + same.reason + ').');
  if (expectDrive) {
    const v = V3.verifyDriveReadback(back, tbLegacySize);
    if (!v.ok) throw new Error('Read-back check failed: ' + v.reason + '.');
  }
  return back;
}

// ---- migration dialog --------------------------------------------------------------
function tbMigrateDialog() {
  let d = document.getElementById('tbMigrateDialog');
  if (d) return d;
  d = document.createElement('dialog');
  d.className = 'tb-dialog';
  d.id = 'tbMigrateDialog';
  d.setAttribute('aria-labelledby', 'tbMigrateTitle');
  d.innerHTML = '<form method="dialog" id="tbMigrateForm">'
    + '<div class="bt-card__head"><h2 id="tbMigrateTitle"></h2><p id="tbMigrateText"></p></div>'
    + '<ul class="tb-migrate__list" id="tbMigrateList"></ul>'
    + '<label class="tb-dialog__field" id="tbMigratePickWrap" hidden>Which display is it?'
    + '<select id="tbMigratePick"></select></label>'
    + '<p class="tb-field__error" id="tbMigrateError" role="alert"></p>'
    + '<div class="tb-actions"><button type="button" class="bt-btn bt-btn--outline" id="tbMigrateCancel">Not now</button>'
    + '<button type="submit" class="bt-btn bt-btn--primary" id="tbMigrateOk">Add and write</button></div></form>';
  document.body.appendChild(d);
  return d;
}
/**
 * Ask the user. opts: { title, text, lines, pick: [{value,label,disabled,title}], okLabel, infoOnly }
 * Resolves { ok, pick }.
 */
function tbAskMigration(opts) {
  const d = tbMigrateDialog();
  d.querySelector('#tbMigrateTitle').textContent = opts.title;
  d.querySelector('#tbMigrateText').textContent = opts.text || '';
  const list = d.querySelector('#tbMigrateList');
  list.innerHTML = '';
  for (const l of opts.lines || []) { const li = document.createElement('li'); li.textContent = l; list.appendChild(li); }
  const wrap = d.querySelector('#tbMigratePickWrap'), pick = d.querySelector('#tbMigratePick');
  wrap.hidden = !opts.pick;
  pick.innerHTML = '';
  for (const p of opts.pick || []) {
    const o = document.createElement('option');
    o.value = p.value; o.textContent = p.label; o.disabled = !!p.disabled; o.title = p.title || '';
    pick.appendChild(o);
  }
  d.querySelector('#tbMigrateError').textContent = '';
  const ok = d.querySelector('#tbMigrateOk'), cancel = d.querySelector('#tbMigrateCancel');
  ok.textContent = opts.okLabel || 'Add and write';
  ok.hidden = !!opts.infoOnly;
  cancel.textContent = opts.infoOnly ? 'OK' : 'Not now';
  return new Promise(resolve => {
    const finish = (res) => {
      d.querySelector('#tbMigrateForm').onsubmit = null; cancel.onclick = null; d.oncancel = null;
      if (d.open) d.close();
      resolve(res);
    };
    d.querySelector('#tbMigrateForm').onsubmit = (e) => { e.preventDefault(); finish({ ok: true, pick: opts.pick ? pick.value : null }); };
    cancel.onclick = () => finish({ ok: false });
    d.oncancel = (e) => { e.preventDefault(); finish({ ok: false }); };
    d.showModal();
  });
}
/**
 * Maintainer decision: one extra confirmation before 3.x drive data that has not been seen on
 * glass is written. Resolves true when the user accepts. Glass-verified data needs no step.
 */
async function tbConfirmUntested(entry, panelLabel) {
  if (!entry || entry.verified === 'glass') return true;
  const ans = await tbAskMigration({
    title: 'Untested on glass',
    text: 'The firmware 3.x drive data for ' + (panelLabel || 'this panel') + ' was converted from the 2.x driver '
      + 'and has not been seen working on a real panel yet.',
    lines: ['If the display does not draw correctly, you can go back to firmware 2.x.',
      'Save the settings first (Back up) so they can be restored.'],
    okLabel: 'Continue anyway'
  });
  return !!ans.ok;
}
function tbPickableDisplays(gen, board) {
  return (simpleConfigPresets.displays || [])
    .filter(d => !board || (d.connectorPins || []).some(p => (board.connectorPins || []).includes(p)))
    .map(d => {
      const a = tbDisplayAvailability(d, gen);
      const badge = V3.badgeText(a);
      return { value: d.id, label: d.name + (badge ? ' (' + badge + ')' : ''), disabled: !a.selectable, title: a.reason, display: d };
    });
}

/**
 * The auto-migration on connect. A 3.x device whose config has no drive packets (a config
 * carried over from 2.x, e.g. a BG22 after the OTA) gets the drive data for its stored
 * panel_ic_type, after the user confirms; the rest of the config is kept as it is.
 * @returns {Promise<'none'|'declined'|'blocked'|'done'|'failed'>}
 */
async function tbMigrateIfNeeded(opts = {}) {
  if (tbMigrationInFlight) return 'none';
  const gen = tbDeviceGeneration();
  if (!V3.isConfigDriven(gen) || !instances || !instances.packets) return 'none';
  if (!tbDriveDb) await tbLoadDriveDb();
  // The firmware's own verdict and target, when it has them (READ_IDENT; 3.x only, so 2.x devices
  // never wait on a silent opcode). Without it the config check and the chip family decide.
  await tbRefreshIdent();
  const targetClass = tbTargetClass();
  let plan = V3.planMigration({ packets: instances.packets, gen, db: tbDriveDb, deviceSaysNeedsMigration: tbDeviceSaysNeedsMigration(), targetClass, ...tbMigrationFacts() });
  if (!plan.needed) return 'none';
  const ident = V3.identifyPreset(instances.packets, simpleConfigPresets);
  const name = toolboxDeviceName() || 'This display';
  // Stored panel not in the database at all (or no panel_ic_type): ask which display it is.
  if (plan.blocked && !plan.entry && simpleConfigPresets) {
    const pick = tbPickableDisplays(gen, ident.driverBoard);
    const ans = await tbAskMigration({
      title: 'Which display is connected?',
      text: name + ' runs firmware ' + tbFirmwareVersion + ', which drives the panel from its configuration. '
        + 'The stored configuration does not say which panel this is (panel id ' + plan.panelIcType + '). Pick it to add its drive data.',
      pick, okLabel: 'Continue'
    });
    if (!ans.ok) return 'declined';
    const d = simpleConfigPresets.displays.find(x => x.id === ans.pick);
    plan = V3.planMigration({ packets: instances.packets, gen, db: tbDriveDb, panelIcType: d && d.panelIcType, targetClass, ...tbMigrationFacts() });
  }
  if (plan.blocked) {
    await tbAskMigration({ title: 'This display can’t be driven by firmware 3.x yet', text: plan.reason, infoOnly: true });
    return 'blocked';
  }
  const e = plan.entry;
  const lines = V3.describePlan(plan);
  if (e && e.verified !== 'glass') lines.push('This panel’s 3.x drive data is converted from the 2.x driver and untested on glass.');
  if (e && e.paletteVerified === false) lines.push('Its 16-colour palette was not measured on this panel.');
  lines.push('Everything else in the configuration (name, power, buttons, Wi-Fi, encryption) stays as it is.');
  const ans = await tbAskMigration({
    title: opts.restoring ? 'Restore and update the settings' : 'Add the panel drive data',
    text: name + ' runs firmware ' + tbFirmwareVersion + '. '
      + (plan.add.length ? 'It needs the drive data for its panel'
        + (ident.display ? ' (' + ident.display.name + ')' : ' (panel id ' + plan.panelIcType + ')') + ' to show anything. ' : '')
      + 'This will change:',
    lines
  });
  if (!ans.ok) return 'declined';
  if (!(await tbConfirmUntested(e, ident.display ? ident.display.name : 'panel id ' + plan.panelIcType))) return 'declined';
  const before = instances.packets;
  tbMigrationInFlight = true;
  try {
    instances.packets = V3.applyMigration(before, plan, () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    addLog('Writing migrated configuration (' + plan.add.length + ' drive packets added, ' + plan.remove.length + ' removed)…', 'info');
    const back = await tbWriteAndVerify({ expectDrive: plan.add.length > 0 });
    parseRawBytes(back);
    editorMarkClean();
    renderEditor();
    addLog('Migration written and verified by read-back.', 'success');
    tbFlash('Drive data added and verified. Restart the display, then send it an image to check the panel.', 'info');
    return 'done';
  } catch (err) {
    instances.packets = before;
    renderEditor();
    addLog('Migration failed: ' + (err && err.message ? err.message : err), 'error');
    tbFlash('Adding the drive data failed: ' + (err && err.message ? err.message : err));
    return 'failed';
  } finally {
    tbMigrationInFlight = false;
  }
}

// ---- backup / restore ------------------------------------------------------------
function tbDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
/** Read the device's config and save it to a file (and keep it for the update flow). */
async function tbBackupConfig() {
  if (!bleLib || !bleLib.isConnected) await connectToBleDevice();
  const bytes = await tbReadRawConfig();
  const meta = { name: toolboxDeviceName() || '', firmware: tbFirmwareVersion || '', target: tbConfigTarget() };
  const text = V3.makeBackup(bytes, meta);
  tbLastBackup = { bytes, meta, savedAt: Date.now() };
  tbDownload(V3.backupFileName(meta.name), text);
  addLog('Configuration saved to a file (' + bytes.length + ' bytes). It contains the encryption key: keep it private.', 'success');
  return tbLastBackup;
}
function tbPickFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.bin,application/json,application/octet-stream';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}
/**
 * Write a saved config back. On a 3.x device a 2.x config is migrated on the way (confirmed in
 * the dialog); on a 2.x device it is written as it was saved.
 * @param {{bytes:Uint8Array}|null} backup tbLastBackup, or null to ask for a file
 */
async function tbRestoreConfig(backup) {
  let parsed = backup && backup.bytes ? { ok: true, bytes: backup.bytes } : null;
  if (!parsed) {
    const file = await tbPickFile();
    if (!file) return 'cancelled';
    parsed = V3.parseBackup(new Uint8Array(await file.arrayBuffer()));
    if (!parsed.ok) { tbFlash('That file can’t be restored: ' + parsed.error + '.'); return 'failed'; }
  }
  if (!bleLib || !bleLib.isConnected) await connectToBleDevice();
  parseRawBytes(parsed.bytes);
  const gen = tbDeviceGeneration();
  if (V3.isConfigDriven(gen)) {
    const plan = V3.planMigration({ packets: instances.packets, gen, db: tbDriveDb, targetClass: tbTargetClass(), ...tbMigrationFacts() });
    if (plan.needed) return tbMigrateIfNeeded({ restoring: true });
  }
  const ans = await tbAskMigration({
    title: 'Restore the saved settings?',
    text: 'This replaces the configuration on ' + (toolboxDeviceName() || 'the display') + ' with the saved one.',
    lines: [], okLabel: 'Restore'
  });
  if (!ans.ok) return 'declined';
  try {
    const back = await tbWriteAndVerify({ expectDrive: false });
    parseRawBytes(back);
    editorMarkClean();
    renderEditor();
    tbFlash('Settings restored and verified. Restart the display to apply them.', 'info');
    return 'done';
  } catch (err) {
    tbFlash('Restoring failed: ' + (err && err.message ? err.message : err));
    return 'failed';
  }
}

// ---- 2.x -> 3.x guided update ----------------------------------------------------------
/** ESP32 and nRF52840 lose their stored config when 2.x is replaced by 3.x (LittleFS/InternalFS -> NVS). */
function tbUpdateLosesConfig() {
  const from = V3.firmwareGeneration(tbFirmwareVersion);
  const to = tbInstallGeneration;
  const t = tbConfigTarget();
  return from !== to && (from === 'v3' || to === 'v3') && (t === 'esp32' || t === 'nrf52840');
}
function tbRenderUpdateBackupStep() {
  const box = document.getElementById('tbUpdateBackup');
  if (!box) return;
  const show = tbMode === 'update';
  box.hidden = !show;
  if (!show) return;
  const loses = tbUpdateLosesConfig();
  const down = V3.downgradeWarning(V3.firmwareGeneration(tbFirmwareVersion), tbInstallGeneration);
  document.getElementById('tbUpdateBackupText').textContent = down ? down : loses
    ? 'Installing firmware 3.x on this board erases its settings. Save them first; after the install the Toolbox writes them back, with the panel drive data 3.x needs.'
    : 'Optional: save the display’s settings to a file before updating.';
  const st = document.getElementById('tbUpdateBackupStatus');
  st.textContent = tbLastBackup ? 'Saved ' + tbLastBackup.bytes.length + ' bytes from ' + (tbLastBackup.meta.name || 'the display') + '.' : '';
}
/** After an update finished: the done screen offers to restore when settings were (or may be) lost. */
function tbRenderUpdateRestoreStep() {
  const btn = document.getElementById('tbDoneRestoreBtn');
  if (!btn) return;
  btn.hidden = !(tbMode === 'update' && tbLastBackup);
  if (tbMode === 'update' && tbUpdateLosesConfig() && tbInstallGeneration === 'v3') {
    document.getElementById('tbDoneText').textContent = tbLastBackup
      ? 'Firmware 3.x is installed; it started without settings. Connect to restore the saved ones.'
      : 'Firmware 3.x is installed; it started without settings. Set it up again, or restore a saved settings file.';
  }
}

// ---- wiring ----------------------------------------------------------------------------
function tbInitV3() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const guard = fn => async () => {
    try { await fn(); } catch (e) {
      if (/no device selected|cancel/i.test(e && e.message || '')) return;
      tbFlash((e && e.tbFriendly ? '' : 'That didn’t work: ') + (e && e.message ? e.message : e));
    }
  };
  on('tbHomeBackupBtn', guard(tbBackupConfig));
  on('tbHomeRestoreBtn', guard(() => tbRestoreConfig(null)));
  on('editorBackupBtn', guard(tbBackupConfig));
  on('editorRestoreBtn', guard(() => tbRestoreConfig(null)));
  on('tbUpdateBackupBtn', guard(async () => { await tbBackupConfig(); tbRenderUpdateBackupStep(); }));
  on('tbDoneRestoreBtn', guard(async () => {
    const r = await tbRestoreConfig(tbLastBackup);
    if (r === 'done') document.getElementById('tbDoneRestoreBtn').hidden = true;
  }));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tbInitV3);
else tbInitV3();
