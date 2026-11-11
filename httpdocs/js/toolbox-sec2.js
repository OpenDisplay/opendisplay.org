// Toolbox glue for SEC2 (firmware 3.0 security) and the one setup wizard. Loaded after
// toolbox-v3.js; needs od-sec2.js, od-sec2-policy.js, od-keystore.js, od-sec2-session.js,
// ble-sec2.js, od-texts.js, od-wizard.js and od-setup-url.js.
//
// What it changes on the page:
//   - every connect: READ the version, probe SEC_STATUS, pin SEC2 devices, open a session with a
//     stored key (asking for one if none works), rotate a migrated 2.x key unless opted out;
//   - unclaimed devices: the wizard (claim with the typed code, or use without a key);
//   - config writes: secrets refused client-side on an unclaimed device (or written after the
//     claim), confirmations for SHOW_KEY_ON_SCREEN and "no recovery", NACKs explained;
//   - ?key= in the address bar is taken and removed; no generated link carries a key;
//   - a Security dialog: claim, rotate, unclaim, forget, download key, the rotation opt-out.
// Texts come from od-texts.js only.
/* global bleLib, addLog, tbFlash, toolboxDeviceName, ensureAuthenticatedOnConnect:writable,
   ensureAuthenticatedOnDemand:writable, getEncryptionKeyFromUrl:writable, tbSavedKey, tbAskForKey */
'use strict';

(function (root) {
  const S = root.OpenDisplaySec2, P = root.OpenDisplaySec2Policy, KS = root.OpenDisplayKeyStore;
  const T = root.OpenDisplayTexts, W = root.OpenDisplayWizard, U = root.OpenDisplaySetupUrl;
  const L = root.OpenDisplaySec2Link;
  if (!S || !P || !KS || !T || !W || !L) return;
  const txt = (k, v) => T.text(k, v);

  // ---- key store ------------------------------------------------------------------------
  let store = null;
  function keyStore() {
    if (store) return store;
    let storage = null;
    try { storage = root.localStorage; storage.getItem('x'); } catch (e) { storage = null; }
    store = new KS.KeyStore({ storage, persisted: () => (root.navigator && root.navigator.storage && root.navigator.storage.persisted
      ? root.navigator.storage.persisted() : Promise.resolve(false)) });
    return store;
  }

  // ---- ?key= : accept it, then remove it from the address bar -----------------------------
  const KEY_PARAMS = ['key', 'k', 'enc', 'encryption_key', 'encryptionKey', 'password', 'pw'];
  /**
   * Take a key from the query (the names getEncryptionKeyFromUrl() accepts) and return the URL
   * without it. `k` is ignored when the query is a setup URL (f=…): there it is the kind.
   * @returns {{key:string|null, url:string|null}} url = the cleaned href, or null when unchanged
   */
  function takeKeyFromUrl(href) {
    let u;
    try { u = new URL(href); } catch (e) { return { key: null, url: null }; }
    const isSetup = u.searchParams.has('f');
    let key = null, changed = false;
    for (const name of KEY_PARAMS) {
      if (name === 'k' && isSetup) continue;
      if (!u.searchParams.has(name)) continue;
      const v = KS.normKey(u.searchParams.get(name));
      if (v && !key) key = v;
      if (v) { u.searchParams.delete(name); changed = true; }
    }
    return { key, url: changed ? u.toString() : null };
  }
  let linkKey = null;
  function captureUrlKey() {
    if (!root.location || !root.history) return;
    const r = takeKeyFromUrl(root.location.href);
    if (r.key) {
      linkKey = r.key;
      try { root.history.replaceState(root.history.state, '', r.url); } catch (e) { /* file:// */ }
      if (typeof addLog === 'function') addLog(txt('key_from_link'), 'info');
    }
  }
  // The old reader looked at the address bar on every connect; it now gets the captured key.
  const origUrlKey = typeof getEncryptionKeyFromUrl === 'function' ? getEncryptionKeyFromUrl : () => null;
  root.getEncryptionKeyFromUrl = function () { return linkKey || origUrlKey(); };

  // ---- setup entry (from /l/ or after the flasher) ---------------------------------------
  /** ?setup=OD1A2B3C&kind=reset (written by /l/; never a key). */
  function setupParams(search) {
    const q = new URLSearchParams(search || '');
    const name = q.get('setup');
    if (!name || !/^OD[0-9A-F]{6}$/.test(name)) return null;
    return { name, kind: q.get('kind') === 'reset' ? 'reset' : 'setup', newer: q.get('newer') === '1' };
  }

  // ---- dialog ------------------------------------------------------------------------------
  /**
   * One modal, built with textContent only. Resolves the id of the button pressed (or the
   * typed value for `input`), null on cancel.
   */
  function ask({ title, lines = [], input = null, buttons = [{ id: 'ok', label: 'OK', primary: true }], checkbox = null }) {
    const doc = root.document;
    const dlg = doc.createElement('dialog');
    dlg.className = 'tb-dialog';
    const form = doc.createElement('form');
    form.method = 'dialog';
    const head = doc.createElement('div'); head.className = 'bt-card__head';
    const h = doc.createElement('h2'); h.textContent = title; head.appendChild(h);
    for (const l of [].concat(lines)) { const p = doc.createElement('p'); p.textContent = l; head.appendChild(p); }
    form.appendChild(head);
    let inp = null, cb = null;
    if (input) {
      const lab = doc.createElement('label'); lab.className = 'tb-dialog__field'; lab.textContent = input.label || '';
      inp = doc.createElement('input'); inp.type = 'text'; inp.autocomplete = 'off'; inp.className = 'tb-mono';
      if (input.inputmode) inp.setAttribute('inputmode', input.inputmode);
      if (input.placeholder) inp.placeholder = input.placeholder;
      lab.appendChild(inp); form.appendChild(lab);
    }
    if (checkbox) {
      const lab = doc.createElement('label'); lab.className = 'tb-switch';
      cb = doc.createElement('input'); cb.type = 'checkbox'; cb.checked = !!checkbox.checked;
      const sp = doc.createElement('span'); sp.textContent = checkbox.label;
      lab.appendChild(cb); lab.appendChild(sp); form.appendChild(lab);
    }
    const acts = doc.createElement('div'); acts.className = 'tb-actions';
    form.appendChild(acts);
    dlg.appendChild(form);
    (doc.body || doc.documentElement).appendChild(dlg);
    return new Promise(resolve => {
      const done = v => { try { dlg.close(); } catch (e) { /* closed */ } dlg.remove(); resolve(v); };
      for (const b of buttons) {
        const el = doc.createElement('button');
        el.type = 'button';
        el.className = 'bt-btn ' + (b.primary ? 'bt-btn--primary' : 'bt-btn--outline');
        el.textContent = b.label;
        el.dataset.id = b.id;
        el.onclick = () => done(b.id === 'cancel' ? null : (inp && b.primary ? { id: b.id, value: inp.value, checked: cb ? cb.checked : null } : (cb ? { id: b.id, checked: cb.checked } : b.id)));
        acts.appendChild(el);
      }
      dlg.oncancel = e => { if (e && e.preventDefault) e.preventDefault(); done(null); };
      dlg.showModal();
      if (inp && inp.focus) inp.focus();
    });
  }
  const CANCEL = { id: 'cancel', label: 'Cancel' };

  // ---- the link per connection -------------------------------------------------------------
  let link = null;
  let lastStored = null;   // the config last read or written on this device (for the confirmations)
  let pendingSecrets = null;
  function deviceName() { return typeof toolboxDeviceName === 'function' ? toolboxDeviceName() : ''; }
  function attachLink() {
    const name = deviceName();
    if (link && link.session.name === name && bleLib.sec2Link === link) return link;
    link = new L.Sec2Link(bleLib, { keyStore: keyStore(), name,
      onError: (e, o) => { bleLib._onSec2Error(e, o); if (e.textKey) tbFlash(txt(e.textKey)); } });
    bleLib.attachSec2(link);
    return link;
  }
  function detachLink() { if (bleLib && bleLib.sec2Link) bleLib.attachSec2(null); link = null; }

  /** Ask for a key and add it as a candidate. False on cancel. */
  async function askForKey(again) {
    const name = deviceName();
    const v = await ask({ title: 'This display is claimed', lines: [again ? txt('not_authorised') : 'Enter its key to continue.'],
      input: { label: 'Key', placeholder: '32 hex characters' }, buttons: [CANCEL, { id: 'ok', label: 'Unlock', primary: true }] });
    if (!v || !KS.normKey(v.value)) return false;
    keyStore().addCandidate(name, v.value, 'user');
    return true;
  }

  /** Offer a key download when the browser may evict the store. True = go on. */
  async function beforeOnlyKey({ kind, keyHex, persisted }) {
    if (persisted) return true;
    const a = await ask({ title: kind === 'rotate' ? 'Replace the key' : 'Claim this display', lines: [txt('storage_not_persisted')],
      buttons: [CANCEL, { id: 'skip', label: 'Continue without' }, { id: 'dl', label: 'Download the key', primary: true }] });
    if (!a) return false;
    if (a === 'dl') downloadKey(deviceName(), keyHex);
    return true;
  }
  function downloadKey(name, keyHex) {
    const s = keyStore();
    const text = keyHex ? ['OpenDisplay key backup', 'Device: ' + name, 'Key: ' + keyHex,
      'Anyone with this key can control the display and read its WiFi password.', ''].join('\n') : s.exportText(name);
    if (!text) return;
    try {
      const blob = new root.Blob([text], { type: 'text/plain' });
      const a = root.document.createElement('a');
      a.href = root.URL.createObjectURL(blob);
      a.download = 'opendisplay-key-' + String(name).replace(/[^A-Za-z0-9_-]/g, '') + '.txt';
      a.click();
      setTimeout(() => root.URL.revokeObjectURL(a.href), 1000);
    } catch (e) { addLog('Key download failed: ' + e.message, 'error'); }
  }

  // ---- connect --------------------------------------------------------------------------
  /**
   * Runs first on every connect. Returns 'sec2' when this module handled security, 'v1' to let
   * the 2.x path run.
   */
  async function onConnect() {
    if (!bleLib || !bleLib.isConnected) return 'v1';
    const l = attachLink();
    let sel;
    try { sel = await l.own(s => s.select()); } catch (e) {
      if (e.code === 'downgrade_refused') {
        addLog(txt('seen_on_sec2'), 'error'); tbFlash(txt('seen_on_sec2'));
        return 'sec2';   // stay attached: no v1 to a pinned device
      }
      addLog('SEC2 probe failed: ' + e.message, 'warning');
      detachLink(); return 'v1';
    }
    if (sel.mode !== 'sec2') { detachLink(); return 'v1'; }
    const st = sel.status;
    addLog('Security: SEC2, ' + st.stateName + (st.claimMode ? ', claim mode' : ''), 'info');
    if (st.claimed && !st.claimMode) { await openSession(); return 'sec2'; }
    if (st.locked) { tbFlash(txt('locked') + ' ' + txt('factory_reset')); return 'sec2'; }
    let ident = null;
    try { ident = root.OpenDisplayV3 ? root.OpenDisplayV3.parseReadIdent(await l.own(ss => ss.readIdent())) : null; } catch (e) { ident = null; }
    await runWizard({ status: st, ident });
    return 'sec2';
  }

  /** Open a session with the stored keys, asking for one when none works. */
  async function openSession() {
    const s = keyStore(), name = deviceName();
    if (linkKey) s.addCandidate(name, linkKey, 'link');
    const v1 = typeof tbSavedKey === 'function' ? tbSavedKey(name) : '';
    if (v1) s.addCandidate(name, v1, 'v1-store');
    for (let tries = 0; tries < 4; tries++) {
      if (!s.hasAnyKey(name) && !(await askForKey(false))) return false;
      try {
        const a = await link.own(ss => ss.authenticate());
        addLog('Secure session open' + (a.keyLegacy ? ' (key from firmware 2.x)' : ''), 'success');
        await maybeRotate();
        return true;
      } catch (e) {
        if (e.code === 'busy') { addLog(txt('busy_retry'), 'warning'); continue; }
        if (e.code !== 'not_authorised') { addLog('Secure session failed: ' + e.message, 'error'); tbFlash(e.textKey ? txt(e.textKey) : e.message); return false; }
        if (!(await askForKey(true))) { tbFlash(txt('not_authorised') + ' ' + txt('factory_reset')); return false; }
        // Reconnect-free retry: the device keeps the link after AUTH_FAILED.
        link.session.status = null;
      }
    }
    return false;
  }

  /** P7: a migrated key rotates by default (one-way), unless the owner opted out. */
  async function maybeRotate() {
    const sess = link.session;
    if (!sess.keyLegacy) return;
    if (!sess.rotationWanted()) { addLog(txt('rotation_pending'), 'info'); return; }
    const a = await ask({ title: 'Replace the key from firmware 2.x', lines: [txt('rotation_pending'), txt('rotation_one_way')],
      checkbox: { label: txt('no_rotate_migrated'), checked: false },
      buttons: [{ id: 'later', label: 'Not now' }, { id: 'rotate', label: 'Replace the key', primary: true }] });
    if (!a) return;
    if (a.checked) keyStore().setNoRotate(deviceName(), true);
    if (a.id !== 'rotate' || a.checked) return;
    try {
      await link.own(async ss => { await ss.rotate({ beforeOnlyKey }); await ss.readStatus(); await ss.authenticate(); });
      addLog('Key replaced.', 'success'); tbFlash('Key replaced. The new key is stored in this browser.', 'info');
      if (P.sec27Of && lastStored && (P.sec27Of(lastStored) || {}).flags & P.SEC_FLAG.SHOW_KEY_ON_SCREEN) tbFlash(txt('rotation_done_show_key'), 'info');
    } catch (e) {
      addLog('Key replacement: ' + e.message, 'error');
      tbFlash(e.textKey ? txt(e.textKey) : e.message);
    }
  }

  // ---- the wizard ------------------------------------------------------------------------
  async function runWizard({ status, ident = null, choice = null }) {
    const sp = setupParams(root.location ? root.location.search : '');
    const plan = W.planWizard({ trigger: sp ? 'qr' : 'toolbox', status, ident, choice,
      url: sp ? { status: sp.newer ? 'generic' : 'setup', kind: sp.kind, name: sp.name, newerFormat: sp.newer, preset: { b: null, d: null, p: null } } : null,
      noRotate: keyStore().noRotate(deviceName()) });
    addLog('Setup: ' + plan.state + (plan.entry ? ', step ' + plan.entry : ''), 'info');
    if (plan.offer.length) {
      const a = await ask({ title: 'Set up security', lines: plan.textKeys.map(k => txt(k)),
        buttons: [{ id: 'no_key', label: 'Use without a key' }, { id: 'claim', label: 'Claim', primary: true }] });
      if (!a) return;
      if (a === 'no_key') { tbFlash(txt('use_without_key'), 'info'); return; }
      const g = await ask({ title: 'Claim mode', lines: [txt('gesture')], buttons: [CANCEL, { id: 'ok', label: 'The display shows SETUP MODE', primary: true }] });
      if (!g) return;
      const st = await link.own(ss => ss.readStatus());
      if (!st || !st.claimMode) { tbFlash(txt('not_in_claim_mode')); return; }
      return runWizard({ status: st });
    }
    if (plan.entry === 'configure') {
      tbFlash(txt('awaiting_claim') + ' Choose the board and display, then write the configuration. The claim follows.', 'info');
      return;
    }
    if (plan.entry === 'verify') {
      const id = deviceName();
      const a = await ask({ title: 'Check the display', lines: [txt('verify_panel', { id })],
        buttons: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes', primary: true }] });
      if (a !== 'yes') { tbFlash('Check the display configuration (board and display), write it again, and reconnect.', 'info'); return; }
    }
    if (plan.entry === 'verify' || plan.entry === 'claim') await claim();
  }

  async function claim() {
    try {
      const res = await link.own(ss => ss.claim({
        askCode: async () => {
          const a = await ask({ title: 'Claim this display', lines: [txt('enter_code')],
            input: { label: 'Code', inputmode: 'numeric', placeholder: '123 456' },
            buttons: [CANCEL, { id: 'blank', label: 'The screen shows nothing' }, { id: 'ok', label: 'Claim', primary: true }] });
          if (a === 'blank') return { blank: true };
          return a && a.value != null ? a.value : '';
        },
        acknowledge: async key => (await ask({ title: 'Claim without the code', lines: [txt(key)],
          buttons: [CANCEL, { id: 'ok', label: 'Continue', primary: true }] })) === 'ok',
        beforeOnlyKey
      }));
      addLog(txt('claimed_ok'), 'success'); tbFlash(txt('claimed_ok'), 'info');
      if (!res.codeChecked) addLog('Claimed without checking the code.', 'warning');
      if (pendingSecrets) await writeSecretsAfterClaim();
      return true;
    } catch (e) {
      addLog('Claim: ' + e.message, 'error');
      tbFlash(e.textKey ? txt(e.textKey) : e.message);
      return false;
    }
  }

  async function writeSecretsAfterClaim() {
    const blob = pendingSecrets;
    const a = await ask({ title: 'Secrets', lines: ['Write the WiFi password and FindMy keys now, encrypted?'],
      buttons: [{ id: 'later', label: 'Later' }, { id: 'ok', label: 'Write them', primary: true }] });
    if (a !== 'ok') return;
    try { await bleLib.writeConfig(blob); pendingSecrets = null; lastStored = blob; addLog('Secrets written.', 'success'); } catch (e) {
      tbFlash(e.textKey ? txt(e.textKey) : e.message);
    }
  }

  // ---- config writes ---------------------------------------------------------------------
  /** The config without WiFi / FindMy packets and with a zero 0x27 key. */
  function stripSecrets(blob) {
    const w = P.walk(blob);
    if (!w.ok) return null;
    const kept = w.packets.filter(p => p.type !== P.PKT_WIFI && p.type !== P.PKT_FINDMY);
    return P.zeroKeyField(P.buildBlob(kept, { version: blob[2], header: blob.subarray(0, 2) }));
  }
  /**
   * Called by the wrapped bleLib.writeConfig before anything is sent. Throws a friendly error
   * (nothing written) or returns the bytes to write.
   */
  async function checkWrite(bytes) {
    if (!link || link.mode !== 'sec2') return bytes;
    const sess = link.session, st = sess.status || {};
    let blob = Uint8Array.from(bytes);
    const chk = P.clientWriteCheck(blob, { sec2: true, claimed: !!st.claimed,
      kDev: sess.key ? S.hexToBytes(sess.key) : null, legacySecrets: !!st.legacySecretsOpen });
    if (!chk.ok && chk.textKey === 'secrets_need_key') {
      const a = await ask({ title: 'Claim this device first', lines: [txt('secrets_need_key')],
        buttons: [CANCEL, { id: 'strip', label: 'Write without them now', primary: true }] });
      const stripped = a === 'strip' ? stripSecrets(blob) : null;
      if (!stripped) { const e = new Error(txt('claim_first')); e.tbFriendly = true; e.textKey = 'claim_first'; throw e; }
      pendingSecrets = blob;
      blob = stripped;
    } else if (!chk.ok) {
      const e = new Error(txt(chk.textKey)); e.tbFriendly = true; e.textKey = chk.textKey; throw e;
    }
    if (P.showKeyRequested(blob, lastStored)) {
      const a = await ask({ title: 'Show the key on the display?', lines: [txt('show_key')],
        buttons: [CANCEL, { id: 'ok', label: 'Show the key', primary: true }] });
      if (a !== 'ok') { const e = new Error('Not written.'); e.tbFriendly = true; throw e; }
    }
    if (st.claimed && P.leavesNoRecovery(blob, lastStored)) {
      const a = await ask({ title: 'No way back if the key is lost', lines: [txt('no_recovery')],
        buttons: [CANCEL, { id: 'ok', label: 'Switch it off anyway', primary: true }] });
      if (a !== 'ok') { const e = new Error('Not written.'); e.tbFriendly = true; throw e; }
    }
    return blob;
  }
  function wrapWrites() {
    if (!bleLib || bleLib._sec2Wrapped) return;
    const orig = bleLib.writeConfig.bind(bleLib);
    bleLib.writeConfig = async function (bytes, onComplete) {
      const blob = await checkWrite(bytes);
      try {
        await orig(blob, onComplete);
      } catch (e) {
        const n = root.OpenDisplayV3 && e && e.nackFrame ? root.OpenDisplayV3.explainNack(e.nackFrame) : null;
        if (n && T.ALL[n.kind]) { e.message = txt(n.kind); e.tbFriendly = true; }
        throw e;
      }
      lastStored = blob;
      // 3.0 restarts after a config write; give it at least 30 s to come back (BG22 pauses ~24 s).
      if (link && link.mode === 'sec2') {
        bleLib.maxReconnectAttempts = Math.max(bleLib.maxReconnectAttempts || 0, 5);
        addLog(txt('reconnect_wait'), 'info');
      }
    };
    bleLib._sec2Wrapped = true;
  }

  // ---- hooks into the page ----------------------------------------------------------------
  const origOnConnect = typeof ensureAuthenticatedOnConnect === 'function' ? ensureAuthenticatedOnConnect : async () => {};
  root.ensureAuthenticatedOnConnect = async function () {
    wrapWrites();
    const r = await onConnect();
    if (r !== 'sec2') return origOnConnect();
  };
  const origOnDemand = typeof ensureAuthenticatedOnDemand === 'function' ? ensureAuthenticatedOnDemand : async () => {};
  root.ensureAuthenticatedOnDemand = async function () {
    if (link && link.mode === 'sec2' && bleLib && bleLib.sec2Link === link) {
      if (link.session.hasSession) return;
      const st = link.session.status;
      if (st && !st.claimed) return;          // open device: no session needed
      if (!(await openSession())) throw new Error(txt('not_authorised'));
      return;
    }
    return origOnDemand();
  };

  // ---- Security dialog --------------------------------------------------------------------
  async function securityMenu() {
    if (!bleLib || !bleLib.isConnected || !link || link.mode !== 'sec2') { tbFlash('Connect a firmware 3 display first.', 'info'); return; }
    const sess = link.session, name = deviceName(), s = keyStore();
    const st = await link.own(ss => ss.readStatus());
    const lines = [name + ': ' + (st ? st.stateName : 'unknown') + (sess.hasSession ? ', secure session open' : '')];
    const buttons = [CANCEL];
    if (st && !st.claimed) buttons.push({ id: 'claim', label: 'Claim', primary: true });
    if (sess.hasSession) buttons.push({ id: 'rotate', label: 'Replace the key' }, { id: 'unclaim', label: 'Unclaim' });
    if (s.hasAnyKey(name)) buttons.push({ id: 'download', label: 'Download the key' }, { id: 'forget', label: 'Forget the key' });
    const a = await ask({ title: 'Security', lines, buttons, checkbox: { label: txt('no_rotate_migrated'), checked: s.noRotate(name) } });
    if (!a) return;
    const id = typeof a === 'string' ? a : a.id;
    if (a && typeof a === 'object') s.setNoRotate(name, !!a.checked);
    if (id === 'claim') return runWizard({ status: st });
    if (id === 'rotate') {
      try { await link.own(async ss => { await ss.rotate({ beforeOnlyKey }); await ss.readStatus(); await ss.authenticate(); }); tbFlash('Key replaced.', 'info'); } catch (e) { tbFlash(e.textKey ? txt(e.textKey) : e.message); }
    }
    if (id === 'unclaim') {
      if ((await ask({ title: 'Unclaim', lines: [txt('unclaim_confirm')], buttons: [CANCEL, { id: 'ok', label: 'Unclaim', primary: true }] })) !== 'ok') return;
      try { await link.own(ss => ss.unclaim()); tbFlash('Unclaimed.', 'info'); } catch (e) { tbFlash(e.textKey ? txt(e.textKey) : e.message); }
    }
    if (id === 'download') downloadKey(name, null);
    if (id === 'forget') s.forget(name);
  }

  function addSecurityButton() {
    const doc = root.document;
    const bar = doc && doc.getElementById && doc.getElementById('bleConnectionPanel');
    if (!bar || doc.getElementById('tbSecurityBtn')) return;
    const b = doc.createElement('button');
    b.type = 'button'; b.id = 'tbSecurityBtn'; b.className = 'bt-btn bt-btn--outline'; b.textContent = 'Security';
    b.onclick = () => securityMenu();
    bar.appendChild(b);
  }
  /** The "waiting to be claimed" scan option next to the name filter (degrades to the name filter). */
  function addClaimModeOption() {
    const doc = root.document;
    const np = doc && doc.getElementById && doc.getElementById('namePrefix');
    if (!np || !np.parentNode || doc.getElementById('tbClaimModeScan')) return;
    const lab = doc.createElement('label'); lab.className = 'tb-switch';
    const cb = doc.createElement('input'); cb.type = 'checkbox'; cb.id = 'tbClaimModeScan';
    const sp = doc.createElement('span'); sp.textContent = 'Only displays waiting to be claimed (Chrome / Edge)';
    lab.appendChild(cb); lab.appendChild(sp);
    np.parentNode.appendChild(lab);
    cb.onchange = () => { if (typeof OpenDisplayBLE !== 'undefined') OpenDisplayBLE.prototype.claimModeScan = cb.checked; setClaimModeScan(cb.checked); };
  }
  function applySetupParams() {
    const sp = setupParams(root.location ? root.location.search : '');
    if (!sp) return;
    const np = root.document && root.document.getElementById && root.document.getElementById('namePrefix');
    if (np) np.value = sp.name;   // the chooser lists only this display
    if (sp.kind === 'reset') tbFlash(txt('setup_reset'), 'info');
    if (sp.newer) tbFlash(txt('setup_newer_format'), 'info');
  }
  /** Optional: list only displays waiting to be claimed (Chrome/Edge; others ignore it). */
  function setClaimModeScan(on) { if (typeof bleLib !== 'undefined' && bleLib) bleLib.claimModeScan = !!on; }

  captureUrlKey();
  try { addSecurityButton(); addClaimModeOption(); applySetupParams(); } catch (e) { /* page without these elements */ }

  root.TbSec2 = { takeKeyFromUrl, setupParams, stripSecrets, checkWrite, onConnect, openSession, runWizard, claim,
    securityMenu, setClaimModeScan, keyStore, _state: () => ({ link, lastStored, pendingSecrets, linkKey }) };
})(typeof window !== 'undefined' ? window : globalThis);
