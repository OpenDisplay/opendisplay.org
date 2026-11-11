// The setup/recovery URL a 3.0 display shows on its SETUP and RESET screens
// (SECURITY_V2 revision 5 § 7.8.1, decision F):
//   https://opendisplay.org/l/?f=1&k=<1|2>&i=<6 hex>&t=<1..99>&v=<a.b.c>[&b=][&d=][&p=]
// on the same /l/ entry point as the 2.x/3.0 boot-screen device link (one 31-character
// base64url token, no '='). The parser is defensive: the input comes from a QR code anyone can
// print. It never throws, never decodes HTML, and returns only numbers and fixed strings.
// UMD: module.exports under node, window.OpenDisplaySetupUrl in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplaySetupUrl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOSTS = Object.freeze(['opendisplay.org', 'www.opendisplay.org']);
  const MAX_LEN = 2048;
  const KNOWN_FORMAT = 1;
  const KIND = Object.freeze({ 1: 'setup', 2: 'reset' });
  /** READ_IDENT fw_target values (PROTOCOL_CHANGES_3.0 row 5). */
  const TARGET_NAME = Object.freeze({ 1: 'ESP32', 2: 'nRF54', 3: 'EFR32BG22', 4: 'nRF52811', 5: 'nRF52840' });

  const RE_F = /^[0-9]{1,3}$/;
  const RE_ID = /^[0-9A-Fa-f]{6}$/;
  const RE_T = /^[1-9][0-9]?$/;
  const RE_DEC = /^(0|[1-9][0-9]{0,2})$/;
  const RE_INDEX = /^[1-9][0-9]{0,3}$/;
  const RE_LEGACY = /^[A-Za-z0-9_-]{31}$/;

  /** Split a raw query into [name, value] pairs in order. No percent-decoding: every valid value is plain ASCII. */
  function pairs(query) {
    const out = [];
    for (const part of String(query).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      out.push(eq < 0 ? [part, null] : [part.slice(0, eq), part.slice(eq + 1)]);
    }
    return out;
  }
  /** First occurrence wins (rule 2). */
  function firstOf(list) {
    const m = new Map();
    for (const [k, v] of list) if (!m.has(k)) m.set(k, v);
    return m;
  }
  function parseVersion(v) {
    if (typeof v !== 'string') return null;
    const p = v.split('.');
    if (p.length !== 3 || !p.every(x => RE_DEC.test(x))) return null;
    const n = p.map(Number);
    if (n.some(x => x > 255)) return null;
    return { major: n[0], minor: n[1], patch: n[2], text: n.join('.') };
  }

  /**
   * Split an input (a full URL, "/l/?…", "?…" or a bare query) into {query} or an error.
   * A full URL must be https on opendisplay.org (or www.) with path /l/.
   */
  function splitInput(input) {
    if (typeof input !== 'string') return { error: 'not_a_string' };
    const s = input.trim();
    if (!s) return { error: 'empty' };
    if (s.length > MAX_LEN) return { error: 'too_long' };
    if (/[\u0000-\u001f\u007f\s<>"'`]/.test(s)) return { error: 'bad_characters' };
    let rest = s;
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(s);
    if (m) {
      if (m[1].toLowerCase() !== 'https') return { error: 'not_https' };
      const host = m[2].toLowerCase();
      if (!HOSTS.includes(host)) return { error: 'wrong_host', host };
      rest = m[3];
    }
    const hash = rest.indexOf('#');
    if (hash >= 0) rest = rest.slice(0, hash);
    const q = rest.indexOf('?');
    let path = q >= 0 ? rest.slice(0, q) : rest;
    const query = q >= 0 ? rest.slice(q + 1) : (m ? '' : rest);
    if (m || q >= 0) {
      if (path && !/^\/l(\/|\/index\.html)?$/.test(path)) return { error: 'wrong_path', path };
      if (m && !path) return { error: 'wrong_path', path };
    }
    return { query };
  }

  /**
   * Read a /l/ link.
   * @returns {{status:'setup'|'generic'|'legacy'|'not_setup_url',
   *   format?:number|null, knownFormat?:boolean, kind?:'setup'|'reset', id?:string|null,
   *   name?:string|null, target?:number|null, targetName?:string|null,
   *   fw?:{major,minor,patch,text}|null, oldFirmware?:boolean, preset?:{b,d,p},
   *   ignored?:string[], reason?:string, payload?:string}}
   *  - 'setup': format 1 with a valid k and i; preset indices that passed their checks.
   *  - 'generic': unknown (future) format, or format 1 with a bad k / i: only the core is used,
   *    nothing is preselected; `newerFormat` says which text to show.
   *  - 'legacy': the 2.x/3.0 boot-screen device link; `payload` is the token for the old decoder.
   *  - 'not_setup_url': anything else; `reason` says why.
   */
  function parseSetupUrl(input) {
    const sp = splitInput(input);
    if (sp.error) return { status: 'not_setup_url', reason: sp.error };
    const list = pairs(sp.query);
    if (!list.length) return { status: 'not_setup_url', reason: 'empty_query' };
    // Rule 1, dispatch: the setup grammar starts with f=…; the legacy link is one bare token.
    if (list[0][0] !== 'f') {
      if (list.length === 1 && list[0][1] === null && RE_LEGACY.test(list[0][0])) return { status: 'legacy', payload: list[0][0] };
      return { status: 'not_setup_url', reason: 'unrecognised_query' };
    }
    const fields = firstOf(list);
    const fRaw = fields.get('f');
    const format = typeof fRaw === 'string' && RE_F.test(fRaw) ? Number(fRaw) : null;
    const known = format === KNOWN_FORMAT && fRaw === '1';
    const kRaw = fields.get('k');
    const kOk = kRaw === '1' || kRaw === '2';
    const iRaw = fields.get('i');
    const id = typeof iRaw === 'string' && RE_ID.test(iRaw) ? iRaw.toUpperCase() : null;
    const base = {
      format, knownFormat: known,
      kind: kOk ? KIND[kRaw] : 'setup',  // rule 3: an unknown kind is treated as 1
      id, name: id ? 'OD' + id : null
    };
    if (!known || !kOk || !id) {
      return Object.assign({ status: 'generic', newerFormat: !known,
        reason: !known ? 'unknown_format' : !kOk ? 'bad_kind' : 'bad_id',
        target: null, targetName: null, fw: null, oldFirmware: false, preset: { b: null, d: null, p: null }, ignored: [] }, base);
    }
    const ignored = [];
    const tRaw = fields.get('t');
    let target = null;
    if (tRaw != null) { if (RE_T.test(tRaw)) target = Number(tRaw); else ignored.push('t'); }
    let fw = null;
    if (fields.has('v')) { fw = parseVersion(fields.get('v')); if (!fw) ignored.push('v'); }
    const preset = { b: null, d: null, p: null };
    for (const k of ['b', 'd', 'p']) {
      if (!fields.has(k)) continue;
      const v = fields.get(k);
      if (typeof v === 'string' && RE_INDEX.test(v)) preset[k] = Number(v); else ignored.push(k);
    }
    return Object.assign({ status: 'setup', newerFormat: false, target,
      targetName: target != null ? TARGET_NAME[target] || null : null,
      fw, oldFirmware: !!(fw && fw.major < 3), preset, ignored }, base);
  }

  /** Build a format-1 URL (tests, and the "test this page" link). Mirrors od_setup_url_build(). */
  function buildSetupUrl({ kind = 'setup', id, target = null, fw = null, b = null, d = null, p = null }) {
    let s = 'https://opendisplay.org/l/?f=1&k=' + (kind === 'reset' ? 2 : 1) + '&i=' + String(id).toUpperCase();
    if (target != null && target >= 1 && target <= 99) s += '&t=' + target;
    if (fw) s += '&v=' + [fw.major, fw.minor, fw.patch].join('.');
    for (const [k, v] of [['b', b], ['d', d], ['p', p]]) if (v != null && v >= 1 && v <= 9999) s += '&' + k + '=' + v;
    return s;
  }

  /**
   * Preset indices -> preset ids. `registry` is simple-config-id-registry.json
   * ({driverBoards:{id:index}, displays:{…}, powerOptions:{…}}) or preset lists whose items
   * carry `index` (or their 1-based position) and `id`. Unknown indices give null, never a guess.
   * @returns {{driverBoard:string|null, display:string|null, power:string|null}} preset ids
   */
  function presetsFor(parsed, registry) {
    const out = { driverBoard: null, display: null, power: null };
    if (!parsed || parsed.status !== 'setup' || !registry) return out;
    const find = (list, i) => {
      if (i == null || !list) return null;
      if (Array.isArray(list)) {
        const hit = list.find((x, n) => (x && x.index != null ? Number(x.index) : n + 1) === i);
        return hit && hit.id != null ? String(hit.id) : null;
      }
      for (const [id, idx] of Object.entries(list)) if (Number(idx) === i) return id;
      return null;
    };
    out.driverBoard = find(registry.driverBoards, parsed.preset.b);
    out.display = find(registry.displays, parsed.preset.d);
    out.power = find(registry.powerOptions, parsed.preset.p);
    return out;
  }

  /**
   * The Toolbox link the /l/ page offers: the name filter, the wizard marker and, for a known
   * format, the preselected preset ids (which the user confirms there). Never a key.
   * @param {object} parsed  parseSetupUrl() result ('setup' or 'generic')
   * @param {{driverBoard, display, power}} ids  presetsFor() result
   */
  function toolboxLinkFor(parsed, ids, base) {
    const u = new URL(base || 'https://opendisplay.org/firmware/toolbox/index.html');
    if (parsed && parsed.name) { u.searchParams.set('device', parsed.name); u.searchParams.set('setup', parsed.name); }
    if (parsed && parsed.kind === 'reset') u.searchParams.set('kind', 'reset');
    if (parsed && parsed.status === 'generic' && parsed.newerFormat) u.searchParams.set('newer', '1');
    if (parsed && parsed.status === 'setup' && ids) {
      if (ids.driverBoard) u.searchParams.set('driver', ids.driverBoard);
      if (ids.display) u.searchParams.set('display', ids.display);
      if (ids.power) u.searchParams.set('power', ids.power);
    }
    return u.toString();
  }

  return { toolboxLinkFor, HOSTS, MAX_LEN, KNOWN_FORMAT, KIND, TARGET_NAME, parseSetupUrl, buildSetupUrl, presetsFor, _splitInput: splitInput };
});
