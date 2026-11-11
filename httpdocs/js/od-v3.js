/*
 * OpenDisplay 3.x config-driven helpers (pure functions, no DOM, no BLE).
 *
 * Shared by the Toolbox, the BLE tester and the designer, and kept free of
 * browser APIs so it runs under plain `node` (tests/od-v3.test.js) and so the
 * Home Assistant integration / py-opendisplay can mirror it line by line.
 *
 * The model it works on is the Toolbox's editor model:
 *   packets = [{ pid: '32', fields: {...} }          legacy fixed-size packet
 *             | { pid: '174', raw: 'hex body' }       length-prefixed 0x80+ packet
 *             | { pid: '46', rawLegacy: 'hex body' }  burned / unknown legacy packet kept verbatim
 *             | { pid: '99', rawTail: 'hex' }]        unknown legacy id: rest of the blob, verbatim
 *
 * Firmware contract: Firmware_Unified shared/protocol/opendisplay_structs.h
 * (config minor 1.6: 0xAE display_mode, 0xAF display_lut, 0xB0
 * display_calibration, 0xB1 display_panel, 0xB2 action_table) and
 * docs/BG22_CONFIG_DRIVEN_PANEL.md.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplayV3 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- small helpers -------------------------------------------------------
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }
  function hexToBytes(hex) {
    const s = String(hex || '').replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    return Array.from(bytes, b => (b & 0xff).toString(16).padStart(2, '0')).join('');
  }

  // ---- packet ids ------------------------------------------------------------
  const PID = Object.freeze({
    SYSTEM: '1', MANUFACTURER: '2', POWER: '4', DISPLAY: '32',
    DISPLAY_MODE: '174', DISPLAY_LUT: '175', DISPLAY_CALIBRATION: '176', DISPLAY_PANEL: '177',
    ACTION_TABLE: '178'
  });
  /** 0xAE-0xB1: the packets that describe ONE panel. 0xB2 (actions) is not panel data. */
  const DRIVE_PIDS = Object.freeze(['174', '175', '176', '177']);
  /** Burned lab-draft ids 0x2E-0x31 and the body sizes those builds wrote (od_config_tlv.h). */
  const BURNED_SIZES = Object.freeze({ 46: 157, 47: 541, 48: 116, 49: 36 });
  const LEN_PREFIXED_MIN = 0x80;

  function normalizePid(p) {
    if (p == null) return null;
    if (typeof p === 'number') return String(p);
    const s = String(p).trim();
    const n = num(s);
    return n == null ? null : String(n);
  }
  function isDrivePid(pid) { return DRIVE_PIDS.includes(normalizePid(pid)); }
  function isBurnedPid(pid) { return Object.prototype.hasOwnProperty.call(BURNED_SIZES, normalizePid(pid)); }

  // ---- firmware generation gate --------------------------------------------
  /**
   * THE version gate. Everything that behaves differently for 3.x devices asks this.
   *
   *   'v3'      firmware major >= 3 (Firmware_Unified 3.0+; lab builds stamped 9.9.x count too):
   *             config-driven. Presets write 0xAE-0xB1; panel_ic_type in 0x20 is informational.
   *   'v2'      major 1 or 2 (OpenDisplay/Firmware 2.x, Firmware_Silabs 2.x, Firmware_NRF54 1.x,
   *             Firmware_NRF): bb_epaper / panel_ic_type. Nothing new is written.
   *   'unknown' no answer to 0x0043, or major 0 (pre-release Unified previews).
   *             Treated like 'v2' for writing (conservative), but callers may warn.
   *
   * @param {{major:number}|string|number|null} info versionInfo from readFirmwareVersion(),
   *        a "3.0.1" / "v3.0.1" string, or a bare major.
   */
  function firmwareGeneration(info) {
    let major = null;
    if (info == null) major = null;
    else if (typeof info === 'number') major = info;
    else if (typeof info === 'string') {
      const m = info.trim().match(/^v?(\d+)(?:\.|$)/i);
      major = m ? parseInt(m[1], 10) : null;
    } else if (typeof info === 'object') major = num(info.major);
    if (major == null || !Number.isFinite(major) || major <= 0) return 'unknown';
    return major >= 3 ? 'v3' : 'v2';
  }
  function isConfigDriven(gen) { return gen === 'v3'; }

  /**
   * Compare two version strings numerically, part by part. A leading "v" is ignored on either
   * side, so a "v3.0.0" release tag and a "3.0.0" one sort the same (Firmware_Unified
   * RELEASE_ARTEFACTS.md § 1 rule 5). Without this, "v3.0.0" parsed as 0 and sorted below 2.x.
   * @returns {number} <0, 0 or >0
   */
  function compareVersions(a, b) {
    const parts = v => String(v == null ? '' : v).trim().replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const pa = parts(a), pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // ---- targets and config size limits ---------------------------------------
  /** system_config (0x01) ic_type -> target family. */
  function targetFromIcType(ic) {
    switch (num(ic)) {
      case 1: return 'nrf52840';
      case 2: case 3: case 4: case 9: return 'esp32';
      case 5: return 'nrf52811';
      case 6: return 'bg22';
      case 7: case 8: return 'nrf54';
      default: return 'unknown';
    }
  }
  /** installConfig.type of a board preset -> target family. */
  function targetFromInstallType(type) {
    switch (String(type || '')) {
      case 'esp32': return 'esp32';
      case 'nrf52840': return 'nrf52840';
      case 'nrf52811': return 'nrf52811';
      case 'silabs_bg22': return 'bg22';
      case 'nrf54l15': case 'nrf54lm20': return 'nrf54';
      default: return 'unknown';
    }
  }
  const TARGET_LABEL = { esp32: 'ESP32', nrf52840: 'nRF52840', nrf52811: 'nRF52811 (Firmware_NRF)', bg22: 'EFR32BG22', nrf54: 'nRF54', unknown: 'this device' };
  /**
   * Largest config (outer packet, header + CRC included) the target stores.
   *   BG22 3.x 3120 (shared/profiles.cmake), BG22 2.x 2048 (Firmware_Silabs, truncates silently),
   *   legacy Firmware_NRF (nRF52811) 512, ESP32 / nRF52840 / nRF54 4096.
   * BG22 with an unknown generation gets the 2.x cap: the smaller one is the safe one.
   */
  function configSizeLimit(target, gen) {
    switch (target) {
      case 'bg22': return gen === 'v3' ? 3120 : 2048;
      case 'nrf52811': return 512;
      case 'esp32': case 'nrf52840': case 'nrf54': return 4096;
      default: return 4096;
    }
  }
  function checkConfigSize(length, target, gen) {
    const limit = configSizeLimit(target, gen);
    const ok = length <= limit;
    const genText = gen === 'v3' ? ' 3.x' : gen === 'v2' ? ' 2.x' : '';
    const who = (TARGET_LABEL[target] || TARGET_LABEL.unknown) + (target === 'unknown' ? '' : genText);
    return {
      ok, limit, length, target, who,
      message: ok ? `${length} of ${limit} bytes (${who})`
        : `This configuration is ${length} bytes, but ${who} stores at most ${limit} bytes. ` +
          `Remove ${length - limit} bytes (for example an unused drive mode, Wi-Fi or Find My) before writing.`
    };
  }

  // ---- target classes (drive interpreter limits) ------------------------------
  /**
   * The od_epd interpreter differs per target, so drive data is derived per class
   * (Firmware_Unified panels/README.md "Target classes", drive_presets.json `target_classes`):
   *   default  ESP32, nRF52840, nRF54: sequences up to 512 B / 96 steps, WINDOW/FILL escapes.
   *   bg22     EFR32BG22: 128 B / 64 steps, no WINDOW/FILL.
   * The sleep sequence (0xB1 tail) is capped at 16 B everywhere (OD_EPD_SLEEP_SEQ_MAX).
   * They are the client's own copy on purpose: the pre-write check must not trust the file it checks.
   */
  const TARGET_CLASS_LIMITS = Object.freeze({
    default: Object.freeze({ seq_max: 512, max_steps: 96, window: true, sleep_max: 16 }),
    bg22: Object.freeze({ seq_max: 128, max_steps: 64, window: false, sleep_max: 16 })
  });
  /** The class used when the device's class cannot be determined: the smallest interpreter. */
  const RESTRICTIVE_CLASS = 'bg22';
  const TARGET_CLASS_LABEL = { default: 'ESP32 / nRF', bg22: 'EFR32BG22' };
  /**
   * READ_IDENT (0x0046) fw_target byte -> class. Values per Firmware_Unified
   * docs/PROTOCOL_CHANGES_3.0.md row 5 (PROVISIONAL, awaiting the maintainer): 0x01 FIRMWARE
   * (ESP32 and nRF52840), 0x02 NRF54, 0x03 SILABS (BG22), 0x04 NRF52811 (reserved, never 3.x).
   * Anything else is unknown (null).
   */
  function targetClassFromIdent(fwTarget) {
    switch (num(fwTarget)) {
      case 0x01: case 0x02: return 'default';
      case 0x03: return 'bg22';
      default: return null;
    }
  }
  /** targetFromIcType() / targetFromInstallType() family -> class, or null when unknown. */
  function targetClassFromTarget(target) {
    switch (String(target || '')) {
      case 'bg22': return 'bg22';
      case 'esp32': case 'nrf52840': case 'nrf54': return 'default';
      default: return null;
    }
  }
  /**
   * The drive class of a device. READ_IDENT's fw_target wins when it is a known value; the
   * chip family (0x01 ic_type or the board preset) is the fallback. Because the fw_target values
   * are provisional, a disagreement between the two picks the restrictive class, and so does
   * "cannot tell" -- BG22 data runs on every target, default data does not run on BG22.
   * @param {{identTarget?:number|null, target?:string|null}} o
   * @returns {{cls:string, how:string, restrictive:boolean}}
   */
  function deviceTargetClass({ identTarget = null, target = null } = {}) {
    const a = targetClassFromIdent(identTarget);
    const b = targetClassFromTarget(target);
    if (a && b && a !== b) return { cls: RESTRICTIVE_CLASS, how: 'conflict', restrictive: true };
    if (a) return { cls: a, how: 'read-ident', restrictive: false };
    if (b) return { cls: b, how: 'chip', restrictive: false };
    return { cls: RESTRICTIVE_CLASS, how: 'unknown', restrictive: true };
  }
  function normalizeClass(cls) {
    return Object.prototype.hasOwnProperty.call(TARGET_CLASS_LIMITS, cls) ? cls : RESTRICTIVE_CLASS;
  }

  /**
   * Walk one drive sequence (od_epd.h grammar). Returns { ok, bytes, steps, window, error }.
   * `steps` counts END like od_epd's cap does (panels/tools/pdlib.py count_steps).
   * An unknown escape (including the reserved 0x80+ range, which the firmware refuses
   * wholesale today) is an error: the caller must not write what it cannot vouch for.
   */
  function walkSequence(seq) {
    const s = seq instanceof Uint8Array ? seq : Uint8Array.from(seq || []);
    const res = { ok: false, bytes: s.length, steps: 0, window: false, error: '' };
    const ARGS = { 1: 0, 3: 0, 4: 0, 5: 2, 6: 2, 7: 2, 8: 1, 9: 2, 0x0A: 3, 0x0B: 4, 0x0D: 3 };
    let i = 0;
    while (i < s.length) {
      const n = s[i];
      if (n) {
        if (i + 1 + n > s.length) { res.error = 'step overruns the sequence'; return res; }
        res.steps++; i += 1 + n; continue;
      }
      if (i + 1 >= s.length) { res.error = 'truncated escape'; return res; }
      const e = s[i + 1];
      if (e === 0) { res.steps++; res.ok = true; return res; }
      let len;
      if (e === 0x02 || e === 0x0C) {
        if (i + 2 >= s.length) { res.error = 'truncated escape'; return res; }
        len = 3 + 2 * s[i + 2];
      } else if (Object.prototype.hasOwnProperty.call(ARGS, e)) {
        len = 2 + ARGS[e];
      } else { res.error = 'unknown escape 0x' + e.toString(16); return res; }
      if (i + len > s.length) { res.error = 'truncated escape'; return res; }
      if (e === 0x0C || e === 0x0D) res.window = true;
      res.steps++; i += len;
    }
    res.error = 'sequence has no END';
    return res;
  }
  /**
   * Second line of defence before a write: does every drive sequence in `packets` run on
   * `cls`? Checks each 0xAE mode sequence (bytes, steps, WINDOW/FILL) and each 0xB1 sleep
   * sequence. Accepts editor-model ({pid, raw}) or generated ({id, body_hex}) packets.
   * @returns {{ok:boolean, cls:string, problems:string[]}}
   */
  function checkDrivePacketsFit(packets, cls, limitsOverride) {
    const c = normalizeClass(cls);
    const L = Object.assign({}, TARGET_CLASS_LIMITS[c], limitsOverride || {});
    const problems = [];
    for (const p of packets || []) {
      if (!p) continue;
      const pid = Number(normalizePid(p.pid != null ? p.pid : p.id));
      const raw = p.raw != null ? p.raw : p.body_hex;
      if (raw == null || (pid !== 0xAE && pid !== 0xB1)) continue;
      const b = hexToBytes(raw);
      let seq, what, cap;
      if (pid === 0xAE) {
        if (b.length < 37) { problems.push('0xAE body shorter than its 37-byte head'); continue; }
        const len = b[35] | (b[36] << 8);
        if (37 + len !== b.length) { problems.push('0xAE mode ' + b[1] + ': seq_len ' + len + ' does not match the body'); continue; }
        seq = b.subarray(37); what = 'mode ' + b[1]; cap = L.seq_max;
      } else {
        if (b.length < 13) { problems.push('0xB1 body shorter than its 13-byte head'); continue; }
        if (13 + b[12] !== b.length) { problems.push('0xB1: sleep_seq_len ' + b[12] + ' does not match the body'); continue; }
        if (!b[12]) continue;
        seq = b.subarray(13); what = 'sleep sequence'; cap = L.sleep_max;
      }
      const w = walkSequence(seq);
      if (!w.ok) { problems.push(what + ': ' + w.error); continue; }
      if (w.bytes > cap) problems.push(what + ' needs a ' + w.bytes + ' B sequence, limit ' + cap + ' B');
      if (pid === 0xAE && w.steps > L.max_steps) problems.push(what + ' needs ' + w.steps + ' steps, limit ' + L.max_steps);
      if (w.window && !L.window) problems.push(what + ' uses WINDOW/FILL, which this target does not implement');
    }
    return { ok: problems.length === 0, cls: c, problems };
  }

  // ---- panel drive database --------------------------------------------------
  const VERIFIED = Object.freeze(['glass', 'equivalent', 'untested']);
  /**
   * Does a panel need drive packets under 3.x? bb_epaper SPI panels (panel_ic_type < 1000) do:
   * 3.0 links no bb_epaper anywhere. Firmware_NRF native panels (1000-2999) only run on the
   * legacy nRF52811 fleet, which never gets 3.x. FastEPD / IT8951 / parallel panels (>= 3000)
   * are driven by their own path, not by drive packets (today).
   */
  function panelNeedsDriveData(panelIcType) {
    const t = num(panelIcType);
    return t != null && t > 0 && t < 1000;
  }
  function normalizeVerified(v) {
    const s = String(v == null ? '' : v).toLowerCase();
    if (s === 'glass' || s === 'verified' || s === 'true') return 'glass';
    if (s === 'equivalent' || s === 'derived') return 'equivalent';
    return 'untested';
  }
  function normalizePacketList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const p of list) {
      if (!p) continue;
      const pid = normalizePid(p.pid != null ? p.pid : (p.id != null ? p.id : p.type));
      const raw = p.raw != null ? p.raw : (p.body != null ? p.body : p.hex);
      if (pid == null || raw == null) continue;
      const n = Number(pid);
      if (n < LEN_PREFIXED_MIN || n > 0xff) continue;  // drive presets are 0x80+ only
      out.push({ pid, raw: String(raw).replace(/[^0-9a-f]/gi, '').toLowerCase() });
    }
    return out;
  }
  /** Statuses whose packets may be written to a device. 'differs' (replay mismatch) is not. */
  const USABLE_STATUS = Object.freeze(['glass', 'equivalent']);
  /**
   * One panel of Firmware_Unified panels/generated/drive_presets.json (schema
   * "opendisplay.drive_presets" v1, panels/README.md). `panels` is the whole map so an
   * `alias_of` entry can borrow its target's packets.
   */
  /**
   * The drive fields of one view of a panel (top level, targets.<class> or an alternative)
   * -> the fields an entry carries. `cls` is the class the packets are for, or null for the
   * top level of a schema-minor-0 file.
   */
  function driveView(src, cls) {
    const status = String(src.status || (src.packets && src.packets.length ? 'equivalent' : 'blocked'));
    const packets = normalizePacketList((src.packets || []).map(p => ({ pid: p.id != null ? p.id : p.pid, raw: p.body_hex != null ? p.body_hex : p.raw })));
    let usable = (USABLE_STATUS.includes(status) || status === 'alternative') && packets.length > 0;
    let blockedReason = '';
    // The client's own caps, not the file's `limits`: the check must not trust the data it checks.
    const limits = cls ? Object.assign({}, TARGET_CLASS_LIMITS[normalizeClass(cls)]) : null;
    if (usable && cls) {
      // Second line of defence: the generator says these fit; check it anyway.
      const fit = checkDrivePacketsFit(packets, cls);
      if (!fit.ok) { usable = false; blockedReason = 'Not available on this target: ' + fit.problems.join('; ') + '.'; }
    }
    if (!usable && !blockedReason) {
      const on = (src.blocked_on || []).join(', ');
      const full = (src.modes_blocked || []).find(m => m && m.name === 'full') || (src.modes_blocked || [])[0];
      if (status === 'blocked' && cls && limits && full && (full.seq_bytes > limits.seq_max || full.steps > limits.max_steps)) {
        const need = [], lim = [];
        if (full.seq_bytes > limits.seq_max) { need.push(full.seq_bytes + ' B sequence'); lim.push(limits.seq_max + ' B'); }
        if (full.steps > limits.max_steps) { need.push(full.steps + ' steps'); lim.push(limits.max_steps + ' steps'); }
        blockedReason = 'Not available on this target (needs ' + need.join(' / ') + ', limit ' + lim.join(' / ') + ' on ' + (TARGET_CLASS_LABEL[cls] || cls) + ').';
      } else {
        blockedReason = status === 'blocked'
          ? 'Not yet available for firmware 3.x: the drive sequence needs a firmware change (' + (on || 'unspecified') + ').'
          : status === 'differs' ? 'Not yet available for firmware 3.x: the converted drive data does not match the 2.x driver.'
          : 'Not yet available for firmware 3.x: no drive data (' + status + ').';
      }
    }
    return {
      status,
      verified: normalizeVerified(src.verified != null ? src.verified : status),
      usable,
      blockedReason,
      blockedOn: src.blocked_on || [],
      requiresEscapes: src.requires_escapes || [],
      modes: src.modes || [],
      modesBlocked: src.modes_blocked || [],
      targetClass: cls || null,
      limits,
      packets: usable ? packets : []
    };
  }
  function entryFromGenerated(key, e, panels) {
    if (!e) return null;
    const t = num(e.panel_ic_type != null ? e.panel_ic_type : (e.legacy && e.legacy.panel_ic_type != null ? e.legacy.panel_ic_type : key));
    if (t == null) return null;
    let src = e;
    if (e.alias_of && panels && panels[e.alias_of]) src = panels[e.alias_of];
    const notes = Array.isArray(e.notes) ? e.notes : (e.notes ? [String(e.notes)] : []);
    // The generator states palette doubts in plain text; surface them as a flag the UI can show.
    const paletteDoubt = notes.some(n => /palette/i.test(n) && /not measured|doubt|borrowed|unverified/i.test(n));
    const meta = {
      panelIcType: t,
      name: e.name || '',
      legacy: e.legacy || null,
      notes,
      paletteVerified: paletteDoubt ? false : null,
      aliasOf: e.alias_of || null,
      source: 'drive_presets.json'
    };
    // schema_minor >= 1: one view per target class, plus opt-in alternatives (never automatic).
    const classes = {};
    for (const [cls, view] of Object.entries(src.targets || {})) {
      if (!Object.prototype.hasOwnProperty.call(TARGET_CLASS_LIMITS, cls) || !view) continue;
      classes[cls] = Object.assign({}, meta, driveView(view, cls));
    }
    const alternatives = (src.alternatives || []).filter(a => a && a.target_class).map(a => Object.assign({}, meta, driveView(a, a.target_class), {
      alternative: true,
      variant: a.variant || 'alternative',
      equivalent: a.equivalent === true,
      verified: 'untested',
      warning: 'Untested, not equivalent to 2.x behaviour: ' + (a.variant === 'single_init' ? 'single-init variant (one init block, as bb_epaper re-sends after a refresh)' : String(a.variant || 'alternative')) + '. Never seen on a real panel.'
    }));
    // The top level is the default class (README "Field rules"). Kept for display / 2.x-era callers.
    return Object.assign({}, meta, driveView(src, Object.keys(classes).length ? 'default' : null), { classes, alternatives });
  }
  /**
   * One lookup table, two sources:
   *  - `generated`: Firmware_Unified panels/generated/drive_presets.json (vendored as
   *    toolbox/drive-presets.json by .github/scripts/sync-drive-presets.sh). Wins when present.
   *  - `displays`: the six toolbox display presets that carry drivePackets inline (fallback
   *    until the generated file exists). Their status comes from display.driveVerified.
   * @returns {Map<number, object>} panel_ic_type -> entry
   */
  function buildDriveDb({ generated = null, displays = [] } = {}) {
    const db = new Map();
    for (const d of displays || []) {
      if (!d || !Array.isArray(d.drivePackets) || !d.drivePackets.length) continue;
      const t = num(d.panelIcType);
      if (t == null || db.has(t)) continue;
      const packets = normalizePacketList(d.drivePackets);
      db.set(t, {
        panelIcType: t,
        name: d.name || '',
        status: normalizeVerified(d.driveVerified) === 'glass' ? 'glass' : 'equivalent',
        verified: normalizeVerified(d.driveVerified),
        usable: packets.length > 0,
        blockedReason: '',
        blockedOn: [], requiresEscapes: [], modes: [], modesBlocked: [],
        legacy: { panel_ic_type: t, color_scheme: d.config ? num(d.config.color_scheme) : null },
        notes: d.driveNotes ? [String(d.driveNotes)] : [],
        paletteVerified: d.drivePaletteVerified != null ? !!d.drivePaletteVerified : null,
        aliasOf: null,
        source: 'simple-config-presets.json',
        packets
      });
    }
    if (generated) {
      if (generated.schema != null && generated.schema !== 'opendisplay.drive_presets') {
        throw new Error('drive presets: unexpected schema ' + generated.schema);
      }
      if (generated.schema_version != null && Number(generated.schema_version) !== 1) {
        throw new Error('drive presets: unsupported schema_version ' + generated.schema_version);
      }
      const panels = generated.panels || {};
      for (const [k, e] of Object.entries(panels)) {
        const entry = entryFromGenerated(k, e, panels);
        if (entry) db.set(entry.panelIcType, entry);
      }
    }
    return db;
  }
  /**
   * THE lookup for writing: the drive entry of panel `t` for target class `cls`.
   *  - `cls` null / unknown -> the restrictive class (bg22).
   *  - Per-class data (targets.<cls>) when the file has it. An entry without per-class data
   *    (inline presets, schema minor 0) is used only if its packets pass checkDrivePacketsFit.
   *  - A panel blocked on `cls` returns a non-usable entry whose blockedReason says what it
   *    needs; `alternative` names an opt-in variant when one exists.
   *  - `allowAlternative: true` (an explicit user opt-in, never a default) returns that
   *    variant instead, flagged `alternative: true` with its `warning`.
   * @returns {object|null} entry with targetClass, usable, packets, blockedReason
   */
  function driveEntryFor(db, panelIcType, cls, { allowAlternative = false } = {}) {
    const t = num(panelIcType);
    const top = (db && t != null && db.get(t)) || null;
    if (!top) return null;
    const c = normalizeClass(cls);
    let ce = top.classes && top.classes[c];
    if (!ce) {
      // No per-class view: only the class-independent packets, and only if they fit this class.
      ce = Object.assign({}, top, { targetClass: c, limits: Object.assign({}, TARGET_CLASS_LIMITS[c]) });
      if (ce.usable) {
        const fit = checkDrivePacketsFit(ce.packets, c);
        if (!fit.ok) Object.assign(ce, { usable: false, packets: [], blockedReason: 'Not available on this target: ' + fit.problems.join('; ') + '.' });
      }
    }
    if (ce.usable) return ce;
    const alt = (top.alternatives || []).find(a => a.targetClass === c && a.usable) || null;
    if (alt && allowAlternative) return alt;
    if (alt) return Object.assign({}, ce, { alternativeAvailable: true, alternative: false, alternativeEntry: alt });
    return ce;
  }
  /**
   * Can this display preset be chosen for a device of generation `gen` and drive class `cls`?
   * 3.x + bb_epaper panel without drive data for that class -> not selectable (the device would
   * stay dark). `opts.allowAlternative` is the user's explicit opt-in to an untested variant.
   */
  function driveAvailability(display, db, gen, cls, opts = {}) {
    const t = display ? num(display.panelIcType) : null;
    const needsDrive = panelNeedsDriveData(t);
    const entry = driveEntryFor(db, t, cls, opts);
    const res = { selectable: true, needsDrive, entry, badge: null, reason: '', targetClass: normalizeClass(cls) };
    if (!isConfigDriven(gen) || !needsDrive) return res;
    if (!entry || !entry.usable) {
      res.selectable = false;
      res.reason = entry && entry.blockedReason ? entry.blockedReason
        : 'Not yet available for firmware 3.x: no drive data for panel_ic_type ' + t + '.';
      if (entry && entry.alternativeAvailable) {
        res.alternativeAvailable = true;
        res.reason += ' An untested single-init alternative exists (opt-in; not equivalent to 2.x behaviour).';
      }
      res.reason += ' Keep this display on firmware 2.x for now.';
      return res;
    }
    if (entry.alternative) { res.badge = 'alternative'; res.warning = entry.warning; }
    // 'equivalent' is host-proven (replay matches the 2.x driver byte for byte) but has never
    // been seen on a real panel: the UI calls it "untested on glass", same as 'untested'.
    else if (entry.verified !== 'glass') res.badge = 'untested';
    if (entry.paletteVerified === false) res.paletteWarning = '16-colour palette not measured on this panel (borrowed from the 2.9in)';
    return res;
  }
  function badgeText(avail) {
    if (!avail) return '';
    if (!avail.selectable) return avail.targetClass === 'bg22' && avail.entry ? 'not on this target' : 'not yet on 3.x';
    if (avail.badge === 'alternative') return 'UNTESTED alternative, not 2.x-equivalent';
    if (avail.badge === 'untested') return 'untested on glass';
    return '';
  }

  // ---- drive packets in a config ---------------------------------------------
  function drivePacketsOf(packets) { return (packets || []).filter(p => p && p.raw != null && isDrivePid(p.pid)); }
  function hasPanelPacket(packets) { return drivePacketsOf(packets).some(p => normalizePid(p.pid) === PID.DISPLAY_PANEL); }
  function hasModePacket(packets) { return drivePacketsOf(packets).some(p => normalizePid(p.pid) === PID.DISPLAY_MODE); }

  /**
   * Make a config's drive packets match `entry` (the selected panel) for generation `gen`.
   * - Always removes EVERY 0xAE-0xB1 packet: they all describe the previously configured panel,
   *   whether a preset or the device put them there.
   * - v3: removes burned 0x2E-0x31 (ignored by 3.x, up to 850 B against a 3120 B cap) and appends
   *   the entry's packets.
   * - v2 / unknown: adds nothing, keeps burned packets byte-for-byte.
   * 0xB2 and every other packet are left untouched.
   */
  function syncDrivePackets(packets, entry, gen, makeUid, cls) {
    const uid = makeUid || (() => Math.random().toString(36).slice(2, 10));
    const v3 = isConfigDriven(gen);
    const kept = (packets || []).filter(p => {
      if (isDrivePid(p.pid) && p.raw != null) return false;
      if (v3 && isBurnedPid(p.pid)) return false;
      return true;
    });
    // Packets that do not run on the device's class (no class given = the restrictive one)
    // are not added: the device would refuse them and stay blank anyway.
    if (v3 && entry && entry.usable !== false && entry.packets && checkDrivePacketsFit(entry.packets, cls).ok) {
      for (const dp of entry.packets) kept.push({ uid: uid(), pid: dp.pid, raw: dp.raw, fields: {}, _simpleDrive: true });
    }
    return kept;
  }

  // ---- decoding drive packets for display -------------------------------------
  function decodeDrivePacket(pid, raw) {
    const b = hexToBytes(raw);
    const id = Number(normalizePid(pid));
    const out = { pid: String(id), id: '0x' + id.toString(16).toUpperCase(), size: b.length };
    if (id === 0xAE && b.length >= 37) {
      const nameBytes = b.slice(2, 14);
      const z = nameBytes.indexOf(0);
      out.kind = 'display_mode';
      out.instance = b[0]; out.modeIndex = b[1];
      out.modeName = String.fromCharCode.apply(null, Array.from(z >= 0 ? nameBytes.slice(0, z) : nameBytes));
      out.colorScheme = b[14]; out.passes = b[15];
      out.tempMin = (b[16] << 24) >> 24; out.tempMax = (b[17] << 24) >> 24;
      out.text = `Drive mode ${b[1]} "${out.modeName}" (${b[15]} pass${b[15] === 1 ? '' : 'es'})`;
    } else if (id === 0xAF && b.length >= 4) {
      out.kind = 'display_lut'; out.instance = b[0]; out.lutSlot = b[1];
      out.text = `Waveform slot ${b[1]} (${b.length - 4} bytes)`;
    } else if (id === 0xB0 && b.length >= 4) {
      out.kind = 'display_calibration'; out.instance = b[0]; out.modeIndex = b[1]; out.entries = b[3];
      out.text = `Colour palette for mode ${b[1]} (${b[3]} colours)`;
    } else if (id === 0xB1 && b.length >= 13) {
      out.kind = 'display_panel'; out.instance = b[0]; out.panelFlags = b[1];
      out.codeMap = Array.from(b.slice(7, 11)); out.modeCount = b[11];
      out.text = `Panel settings (BUSY, colour codes ${out.codeMap.join(',')}, ${b[11]} modes)`;
    } else if (id === 0xB2) {
      out.kind = 'action_table'; out.text = `Action table (${b.length} bytes)`;
    } else {
      out.kind = 'unknown'; out.text = `Packet ${out.id} (${b.length} bytes)`;
    }
    return out;
  }
  /** 0xB1 code_map of display instance 0, or null. */
  function codeMapFromPackets(packets) {
    const p = drivePacketsOf(packets).find(x => normalizePid(x.pid) === PID.DISPLAY_PANEL && hexToBytes(x.raw)[0] === 0);
    if (!p) return null;
    const d = decodeDrivePacket(p.pid, p.raw);
    return d.codeMap || null;
  }
  /**
   * 3.x only: the 4-colour (scheme 3) palette-index -> panel-code table from 0xB1 code_map
   * (logical colour index -> panel 2-bit code; structs.h DisplayPanelHead). Returns null for an
   * invalid map so the caller can refuse rather than guess. NEVER apply this to 0xB0 codes.
   */
  function wireMapFromCodeMap(codeMap) {
    if (!Array.isArray(codeMap) && !(codeMap instanceof Uint8Array)) return null;
    const m = Array.from(codeMap).slice(0, 4).map(Number);
    if (m.length !== 4 || m.some(v => !Number.isInteger(v) || v < 0 || v > 3)) return null;
    if (new Set(m).size !== 4) return null;
    return m;
  }

  // ---- identifying which preset a stored config came from ---------------------
  function findPacket(packets, pid) { return (packets || []).find(p => String(p.pid) === pid && p.fields); }
  function presetIndexOf(item, list) {
    if (!item || !list) return 0;
    if (item.index != null && item.index !== '') return Number(item.index);
    const i = list.findIndex(x => x.id === item.id);
    return i >= 0 ? i + 1 : 0;
  }
  /**
   * Which simple-config presets produced this config?
   *  1. the simple_config_*_index the Toolbox wrote into manufacturer data (0x02) -- exact;
   *  2. otherwise an UNAMBIGUOUS match: the one display preset with this panel_ic_type and size,
   *     the one board preset with this ic_type and display pins;
   *  3. otherwise null with the candidates, so the UI can ask the user.
   * @returns {{driverBoard, display, power, how:{driverBoard,display,power}, candidates:{displays, driverBoards}}}
   */
  function identifyPreset(packets, presets) {
    const res = { driverBoard: null, display: null, power: null,
      how: { driverBoard: null, display: null, power: null }, candidates: { displays: [], driverBoards: [] } };
    if (!presets) return res;
    const m = findPacket(packets, PID.MANUFACTURER);
    const byIndex = (list, field) => {
      const i = m ? num(m.fields[field]) : null;
      return i ? (list || []).find(x => presetIndexOf(x, list) === i) || null : null;
    };
    res.driverBoard = byIndex(presets.driverBoards, 'simple_config_driver_index');
    res.display = byIndex(presets.displays, 'simple_config_display_index');
    res.power = byIndex(presets.powerOptions, 'simple_config_power_index');
    if (res.driverBoard) res.how.driverBoard = 'simple-config-index';
    if (res.display) res.how.display = 'simple-config-index';
    if (res.power) res.how.power = 'simple-config-index';

    const disp = findPacket(packets, PID.DISPLAY);
    const sys = findPacket(packets, PID.SYSTEM);
    // An index that disagrees with the stored panel is not trusted (the editor may have changed 0x20).
    if (res.display && disp && num(disp.fields.panel_ic_type) != null &&
        num(res.display.panelIcType) !== num(disp.fields.panel_ic_type)) {
      res.display = null; res.how.display = null;
    }
    if (!res.display && disp) {
      const t = num(disp.fields.panel_ic_type);
      const w = num(disp.fields.pixel_width), h = num(disp.fields.pixel_height);
      let c = (presets.displays || []).filter(d => num(d.panelIcType) === t);
      const sized = c.filter(d => d.config && num(d.config.pixel_width) === w && num(d.config.pixel_height) === h);
      if (sized.length) c = sized;
      if (res.driverBoard) {
        const compat = c.filter(d => (d.connectorPins || []).some(p => (res.driverBoard.connectorPins || []).includes(p)));
        if (compat.length) c = compat;
      }
      res.candidates.displays = c;
      if (c.length === 1) { res.display = c[0]; res.how.display = 'panel-match'; }
    }
    if (!res.driverBoard && sys) {
      const ic = num(sys.fields.ic_type);
      let c = (presets.driverBoards || []).filter(b => b.systemConfig && num(b.systemConfig.ic_type) === ic);
      if (disp) {
        const pins = ['reset', 'busy', 'dc', 'cs', 'data', 'clk'];
        const fieldOf = { reset: 'reset_pin', busy: 'busy_pin', dc: 'dc_pin', cs: 'cs_pin', data: 'data_pin', clk: 'clk_pin' };
        const pinMatch = c.filter(b => b.displayPins && pins.every(k => num(b.displayPins[k]) === num(disp.fields[fieldOf[k]])));
        if (pinMatch.length) c = pinMatch;
      }
      res.candidates.driverBoards = c;
      if (c.length === 1) { res.driverBoard = c[0]; res.how.driverBoard = 'board-match'; }
    }
    return res;
  }

  // ---- migration ---------------------------------------------------------------
  /**
   * Does this config need drive data added before a 3.x device can show anything?
   * @param {object} o
   * @param {Array} o.packets editor-model packets read from the device
   * @param {string} o.gen firmwareGeneration()
   * @param {Map} o.db buildDriveDb()
   * @param {boolean} [o.deviceSaysNeedsMigration] firmware flag (READ_IDENT / MSD), when available
   * @param {number} [o.panelIcType] override: the panel the user picked when the config did not say
   * @param {string} [o.targetClass] deviceTargetClass().cls; missing / unknown = the restrictive class
   * @param {boolean} [o.allowAlternative] explicit user opt-in to an untested alternative (default off)
   * @returns {{needed:boolean, blocked:boolean, reason:string, panelIcType:number|null, targetClass:string,
   *            alternativeAvailable:boolean, entry, add:Array, remove:Array}}
   */
  function planMigration({ packets, gen, db, deviceSaysNeedsMigration = false, panelIcType = null, targetClass = null, allowAlternative = false } = {}) {
    const cls = normalizeClass(targetClass);
    const plan = { needed: false, blocked: false, reason: '', panelIcType: null, targetClass: cls, alternativeAvailable: false, entry: null, add: [], remove: [] };
    if (!isConfigDriven(gen)) { plan.reason = 'not a 3.x device'; return plan; }
    const disp = findPacket(packets, PID.DISPLAY);
    const t = panelIcType != null ? num(panelIcType) : (disp ? num(disp.fields.panel_ic_type) : null);
    plan.panelIcType = t;
    if (!disp && panelIcType == null) { plan.reason = 'no display configured'; return plan; }
    const burned = (packets || []).filter(p => isBurnedPid(p.pid));
    const missing = !hasPanelPacket(packets) || !hasModePacket(packets);
    if (!panelNeedsDriveData(t)) {
      plan.reason = 'this panel is not driven by drive packets';
      if (burned.length) { plan.needed = true; plan.remove = burned; plan.reason = 'remove burned lab packets'; }
      return plan;
    }
    // Drive packets already present but not runnable on this class (e.g. default-class data on a
    // BG22): they must be replaced, the device refuses them.
    const present = drivePacketsOf(packets);
    const presentFit = present.length ? checkDrivePacketsFit(present, cls) : { ok: true };
    if (!missing && presentFit.ok && !deviceSaysNeedsMigration && panelIcType == null) {
      if (burned.length) { plan.needed = true; plan.remove = burned; plan.reason = 'remove burned lab packets'; }
      else plan.reason = 'already has drive data';
      return plan;
    }
    plan.needed = true;
    const entry = driveEntryFor(db, t, cls, { allowAlternative });
    if (!entry || !entry.usable) {
      plan.blocked = true;
      plan.entry = entry || null;
      plan.alternativeAvailable = !!(entry && entry.alternativeAvailable);
      plan.reason = (entry && entry.blockedReason ? entry.blockedReason
        : 'No 3.x drive data exists for panel_ic_type ' + t + ' yet.') + ' The display stays blank on 3.x firmware until it does.';
      if (plan.alternativeAvailable) plan.reason += ' An untested single-init alternative exists; it is offered only as an explicit opt-in (not equivalent to 2.x behaviour).';
      return plan;
    }
    plan.entry = entry;
    plan.reason = missing ? 'config has no drive packets (carried over from 2.x)'
      : !presentFit.ok ? 'stored drive packets do not run on this target (' + presentFit.problems.join('; ') + ')'
      : 'device asked for migration';
    plan.remove = (packets || []).filter(p => isBurnedPid(p.pid) || (p.raw != null && isDrivePid(p.pid)));
    plan.add = entry.packets.map(p => Object.assign({}, p, { summary: decodeDrivePacket(p.pid, p.raw) }));
    return plan;
  }
  /**
   * Apply a plan: drop plan.remove, append plan.add. Every other packet is kept as is.
   * Throws (and changes nothing) when a sequence in plan.add does not fit plan.targetClass.
   */
  function applyMigration(packets, plan, makeUid) {
    const fit = checkDrivePacketsFit(plan.add || [], plan.targetClass);
    if (!fit.ok) throw new Error('Refusing to write drive data that does not run on this target: ' + fit.problems.join('; ') + '.');
    const uid = makeUid || (() => Math.random().toString(36).slice(2, 10));
    const drop = new Set(plan.remove || []);
    const out = (packets || []).filter(p => !drop.has(p));
    for (const p of plan.add || []) out.push({ uid: uid(), pid: p.pid, raw: p.raw, fields: {}, _simpleDrive: true });
    if (plan.panelIcType != null) {
      const disp = findPacket(out, PID.DISPLAY);
      if (disp && num(disp.fields.panel_ic_type) !== plan.panelIcType) {
        disp.fields = Object.assign({}, disp.fields, { panel_ic_type: String(plan.panelIcType) });
      }
    }
    return out;
  }
  function describePlan(plan) {
    const lines = [];
    for (const p of plan.add || []) lines.push('Add: ' + (p.summary ? p.summary.text : decodeDrivePacket(p.pid, p.raw).text));
    for (const p of plan.remove || []) {
      const id = Number(normalizePid(p.pid));
      lines.push('Remove: ' + (isBurnedPid(id) ? 'obsolete lab packet 0x' + id.toString(16).toUpperCase() + ' (ignored by 3.x)'
        : decodeDrivePacket(p.pid, p.raw).text));
    }
    return lines;
  }

  // ---- byte level: walk, compare, verify ------------------------------------
  function crc16ccitt(buf) {
    let crc = 0xFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= (buf[i] << 8);
      for (let j = 0; j < 8; j++) crc = ((crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1)) & 0xFFFF;
    }
    return crc;
  }
  /** CRC of an outer config blob as the firmware computes it: over everything but the CRC, length bytes zeroed. */
  function outerCrc(bytes) {
    const b = new Uint8Array(bytes.length - 2);
    b.set(bytes.subarray(0, bytes.length - 2));
    b[0] = 0; b[1] = 0;
    return crc16ccitt(b);
  }
  /**
   * Walk a raw config. `legacySize(id)` returns the body size of a legacy (< 0x80) id, or null if
   * unknown. Burned ids are sized internally. An unknown legacy id ends the walk with a `tail`.
   */
  function walkConfig(input, legacySize) {
    const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
    const res = { ok: false, length: 0, version: 0, crcOk: false, packets: [], tail: null, error: '' };
    if (bytes.length < 5) { res.error = 'too short'; return res; }
    res.length = bytes[0] | (bytes[1] << 8);
    res.version = bytes[2];
    res.crcOk = (bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8)) === outerCrc(bytes);
    const end = bytes.length - 2;
    let o = 3;
    while (o + 2 <= end) {
      const id = bytes[o + 1];
      if (id >= LEN_PREFIXED_MIN) {
        if (o + 4 > end) { res.error = 'truncated header'; return res; }
        const len = bytes[o + 2] | (bytes[o + 3] << 8);
        if (o + 4 + len > end) { res.error = 'truncated 0x' + id.toString(16); return res; }
        res.packets.push({ id, lengthPrefixed: true, body: bytesToHex(bytes.subarray(o + 4, o + 4 + len)) });
        o += 4 + len;
        continue;
      }
      const size = isBurnedPid(id) ? BURNED_SIZES[id] : (legacySize ? legacySize(id) : null);
      if (size == null) { res.tail = { id, bytes: bytesToHex(bytes.subarray(o + 1, end)) }; break; }
      if (o + 2 + size > end) { res.error = 'truncated 0x' + id.toString(16); return res; }
      res.packets.push({ id, lengthPrefixed: false, body: bytesToHex(bytes.subarray(o + 2, o + 2 + size)) });
      o += 2 + size;
    }
    res.ok = true;
    return res;
  }
  /**
   * Did the device store what we wrote? Byte equality first; otherwise packet-by-packet
   * (the per-packet `number` byte is ignored by the firmware and may be renumbered).
   */
  function compareConfigs(written, readBack, legacySize) {
    const a = written instanceof Uint8Array ? written : Uint8Array.from(written || []);
    const b = readBack instanceof Uint8Array ? readBack : Uint8Array.from(readBack || []);
    if (a.length === b.length && a.every((v, i) => v === b[i])) return { equal: true, reason: 'identical' };
    const wa = walkConfig(a, legacySize), wb = walkConfig(b, legacySize);
    if (!wa.ok || !wb.ok) return { equal: false, reason: 'could not parse ' + (!wa.ok ? 'written' : 'read-back') + ' config' };
    const key = p => p.id + ':' + p.body;
    const ka = wa.packets.map(key).sort(), kb = wb.packets.map(key).sort();
    if (ka.length !== kb.length) return { equal: false, reason: `packet count differs (${ka.length} written, ${kb.length} read back)` };
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return { equal: false, reason: 'packet 0x' + Number(ka[i].split(':')[0]).toString(16) + ' differs' };
    if ((wa.tail && wa.tail.bytes) !== (wb.tail && wb.tail.bytes)) return { equal: false, reason: 'trailing bytes differ' };
    return { equal: true, reason: 'same packets' };
  }
  /** After a migration write: the read-back must carry 0xB1 and at least one 0xAE. */
  function verifyDriveReadback(readBack, legacySize) {
    const w = walkConfig(readBack, legacySize);
    if (!w.ok) return { ok: false, reason: 'read-back did not parse: ' + w.error };
    if (!w.crcOk) return { ok: false, reason: 'read-back CRC mismatch' };
    const hasB1 = w.packets.some(p => p.id === 0xB1), hasAE = w.packets.some(p => p.id === 0xAE);
    if (!hasB1 || !hasAE) return { ok: false, reason: 'read-back is missing ' + (!hasB1 ? '0xB1 display_panel' : '0xAE display_mode') };
    return { ok: true, reason: 'drive packets present' };
  }

  // ---- READ_IDENT (0x0046) -------------------------------------------------------
  const IDENT_FLAG_CONFIG_DRIVEN = 0x01;
  const IDENT_FLAG_NEEDS_MIGRATION = 0x02;
  /**
   * [0x00][0x46][proto_minor][target][count] + count x {ic:u16, w:u16, h:u16, scheme} (7 B)
   * + optional flags byte (Firmware_Unified docs/CONFIG_DRIVEN_DISPLAY.md, provisional):
   * bit0 CONFIG_DRIVEN, bit1 NEEDS_MIGRATION. No flags byte = not config-driven / unknown.
   */
  function parseReadIdent(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (b.length < 5 || b[0] !== 0x00 || b[1] !== 0x46) return null;
    const count = b[4];
    const res = { protoMinor: b[2], target: b[3], displays: [], flags: null, configDriven: null, needsMigration: false };
    let o = 5;
    for (let i = 0; i < count; i++) {
      if (o + 7 > b.length) return res;
      res.displays.push({ panelIcType: b[o] | (b[o + 1] << 8), width: b[o + 2] | (b[o + 3] << 8), height: b[o + 4] | (b[o + 5] << 8), colorScheme: b[o + 6] });
      o += 7;
    }
    if (o < b.length) {
      res.flags = b[o];
      res.configDriven = !!(b[o] & IDENT_FLAG_CONFIG_DRIVEN);
      res.needsMigration = !!(b[o] & IDENT_FLAG_NEEDS_MIGRATION);
    }
    return res;
  }

  // ---- backup files ---------------------------------------------------------
  const BACKUP_FORMAT = 'opendisplay-config-backup';
  /**
   * JSON backup of a raw config. Contains the encryption key if the config does: the file is
   * as sensitive as the device itself, and the UI must say so.
   */
  function makeBackup(bytes, meta = {}) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    return JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: 1,
      createdAt: meta.createdAt || new Date().toISOString(),
      device: {
        name: meta.name || '',
        firmware: meta.firmware || '',
        target: meta.target || ''
      },
      length: b.length,
      config: bytesToHex(b)
    }, null, 2) + '\n';
  }
  /** Accepts a backup JSON string/object, or a raw .bin config (Uint8Array / ArrayBuffer). */
  function parseBackup(input) {
    let bytes = null, meta = {};
    if (input instanceof ArrayBuffer) input = new Uint8Array(input);
    if (input instanceof Uint8Array) {
      const first = input.length ? input[0] : 0;
      if (first === 0x7b /* '{' */) input = new TextDecoder().decode(input);
      else bytes = input;
    }
    if (!bytes) {
      let o = input;
      if (typeof input === 'string') {
        try { o = JSON.parse(input); } catch (e) { return { ok: false, error: 'not a backup file (invalid JSON)' }; }
      }
      if (!o || o.format !== BACKUP_FORMAT || typeof o.config !== 'string') return { ok: false, error: 'not an OpenDisplay config backup' };
      if (o.formatVersion !== 1) return { ok: false, error: 'unsupported backup version ' + o.formatVersion };
      bytes = hexToBytes(o.config);
      meta = Object.assign({ createdAt: o.createdAt }, o.device || {});
    }
    if (bytes.length < 5) return { ok: false, error: 'config too short' };
    const len = bytes[0] | (bytes[1] << 8);
    if (len !== bytes.length) return { ok: false, error: `length field ${len} does not match ${bytes.length} bytes` };
    if ((bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8)) !== outerCrc(bytes)) return { ok: false, error: 'CRC mismatch: the file is damaged' };
    return { ok: true, bytes, meta };
  }
  function backupFileName(name, date) {
    const d = (date || new Date()).toISOString().slice(0, 10);
    return 'opendisplay-config-' + (String(name || 'device').replace(/[^A-Za-z0-9_-]+/g, '') || 'device') + '-' + d + '.json';
  }

  return {
    PID, DRIVE_PIDS, BURNED_SIZES, VERIFIED, BACKUP_FORMAT,
    num, hexToBytes, bytesToHex, normalizePid, isDrivePid, isBurnedPid,
    firmwareGeneration, isConfigDriven, compareVersions,
    targetFromIcType, targetFromInstallType, configSizeLimit, checkConfigSize,
    TARGET_CLASS_LIMITS, RESTRICTIVE_CLASS, targetClassFromIdent, targetClassFromTarget, deviceTargetClass,
    walkSequence, checkDrivePacketsFit,
    panelNeedsDriveData, buildDriveDb, driveEntryFor, driveAvailability, badgeText,
    drivePacketsOf, hasPanelPacket, syncDrivePackets,
    decodeDrivePacket, codeMapFromPackets, wireMapFromCodeMap,
    identifyPreset, planMigration, applyMigration, describePlan,
    crc16ccitt, outerCrc, walkConfig, compareConfigs, verifyDriveReadback,
    parseReadIdent,
    makeBackup, parseBackup, backupFileName
  };
});
