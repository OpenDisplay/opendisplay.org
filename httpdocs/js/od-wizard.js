// The setup wizard planner (SECURITY_V2 rev 5 § 15; proposals P1, P2, P6, P7). Pure logic: it
// reads what the device signals (advertisement, READ_IDENT, SEC_STATUS, the setup URL) and says
// which steps of the ONE wizard apply, where to enter, and what to offer. The page draws it.
//
//   Identify -> Configure display -> Verify panel -> Claim -> Secrets -> Done
//
// Every input is advisory (unauthenticated); security decisions happen in the handshake.
// UMD: module.exports under node, window.OpenDisplayWizard in the browser.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplayWizard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEPS = Object.freeze(['identify', 'configure', 'verify', 'claim', 'secrets', 'done']);
  const MSD_STATUS_CLAIM_MODE = 0x04;
  const MSD_STATUS_SESSION_REQUIRED = 0x08;
  const COMPANY_ID = 0x2446;

  /**
   * The state bits of a manufacturer-data record (§ 5.3): 16 bytes from READ_MSD (company id
   * first) or 14 bytes from Web Bluetooth's manufacturerData (company id stripped).
   * @returns {{claimMode, sessionRequired, awaitingClaim, unconfigured, status}|null}
   */
  function parseMsdState(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : (bytes && bytes.buffer ? new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength) : Uint8Array.from(bytes || []));
    let dyn;
    if (b.length === 16) dyn = 2;
    else if (b.length === 14) dyn = 0;
    else return null;
    const st = b[dyn + 13];
    const dynamic = b.subarray(dyn, dyn + 11);
    const claimMode = !!(st & MSD_STATUS_CLAIM_MODE);
    const sessionRequired = !!(st & MSD_STATUS_SESSION_REQUIRED);
    return { claimMode, sessionRequired, awaitingClaim: claimMode && !sessionRequired,
      unconfigured: dynamic.every(x => x === 0xff), status: st };
  }
  /**
   * Optional Chrome-only scan filter for "waiting to be claimed" (advert_claim_mode): status
   * bit 2 set, bit 3 clear. Browsers without manufacturerData filters fall back to the name
   * filter; the result is always confirmed after connecting.
   */
  function claimModeScanFilter(namePrefix) {
    const data = new Uint8Array(14); data[13] = MSD_STATUS_CLAIM_MODE;
    const mask = new Uint8Array(14); mask[13] = MSD_STATUS_CLAIM_MODE | MSD_STATUS_SESSION_REQUIRED;
    const f = { manufacturerData: [{ companyIdentifier: COMPANY_ID, dataPrefix: data, mask }] };
    if (namePrefix) f.namePrefix = namePrefix;
    return f;
  }

  /**
   * Where does this device stand? Combines SEC_STATUS (preferred), READ_IDENT and the MSD.
   * @returns {string} 'virgin' | 'fresh' | 'gesture' | 'claimed_in_claim_mode' | 'open' |
   *   'claimed' | 'locked' | 'legacy' (2.x / no SEC2) | 'unknown'
   */
  function deviceState({ status = null, ident = null, msd = null, fw = null } = {}) {
    if (fw && fw.major < 3) return 'legacy';
    if (ident && ident.flags != null && !ident.sec2) return 'legacy';
    const unconfigured = (ident && ident.displays && ident.displays.length === 0) || (msd && msd.unconfigured) || false;
    if (status) {
      if (status.locked) return 'locked';
      if (status.claimed) return status.claimMode ? 'claimed_in_claim_mode' : 'claimed';
      if (status.claimMode) {
        if (status.claimModeFresh) return unconfigured ? 'virgin' : 'fresh';
        return 'gesture';
      }
      return 'open';
    }
    if (ident && ident.flags != null) {
      if (ident.claimed) return 'claimed';
      if (ident.claimMode) return unconfigured ? 'virgin' : 'gesture';
      return 'open';
    }
    if (msd) {
      if (msd.sessionRequired) return 'claimed';
      if (msd.claimMode) return msd.unconfigured ? 'virgin' : 'gesture';
    }
    return 'unknown';
  }

  /**
   * Plan the wizard.
   * @param {object} o
   * @param {'qr'|'flasher'|'toolbox'|'reset'} o.trigger
   * @param {object} [o.url]      OpenDisplaySetupUrl.parseSetupUrl() result
   * @param {object} [o.status]   parsed SEC_STATUS
   * @param {object} [o.ident]    OpenDisplayV3.parseReadIdent() result
   * @param {object} [o.msd]      parseMsdState() result
   * @param {object} [o.fw]       {major, minor, patch}
   * @param {'claim'|'no_key'|null} [o.choice] the user's answer on an open device
   * @returns {{state, entry, steps:{id, status:'skip'|'todo'}[], textKeys:string[], offer:string[],
   *   needsGesture:boolean, migration:object|null, scan:{name:string|null}, preset:object|null}}
   */
  function planWizard({ trigger = 'toolbox', url = null, status = null, ident = null, msd = null, fw = null, choice = null, noRotate = false } = {}) {
    const state = deviceState({ status, ident, msd, fw });
    const textKeys = [];
    const offer = [];
    const plan = { state, entry: null, steps: [], textKeys, offer, needsGesture: false, migration: null,
      scan: { name: url && url.name ? url.name : null }, preset: url && url.status === 'setup' ? url.preset : null };
    if (url) {
      if (url.kind === 'reset' || trigger === 'reset') textKeys.push('setup_reset');
      if (url.status === 'generic' && url.newerFormat) textKeys.push('setup_newer_format');
      if (url.oldFirmware) textKeys.push('setup_old_firmware');
      if (url.status === 'setup' && (url.preset.b || url.preset.d || url.preset.p)) textKeys.push('setup_confirm_preset');
    }
    const todo = new Set();
    switch (state) {
      case 'virgin':
        plan.entry = 'configure';
        ['configure', 'verify', 'claim', 'secrets'].forEach(s => todo.add(s));
        textKeys.push('awaiting_claim');
        break;
      case 'fresh':
        plan.entry = status && status.configLocked ? 'claim' : 'verify';
        ['verify', 'claim', 'secrets'].forEach(s => todo.add(s));
        if (status && status.configLocked) todo.delete('verify');
        textKeys.push('awaiting_claim');
        break;
      case 'gesture':
        plan.entry = 'claim';
        ['claim', 'secrets'].forEach(s => todo.add(s));
        textKeys.push('awaiting_claim');
        break;
      case 'claimed_in_claim_mode':
        plan.entry = 'secrets';
        todo.add('secrets');
        break;
      case 'open': {
        plan.migration = planMigrationAssistant({ ident, status, noRotate });
        if (choice === 'claim') {
          plan.entry = plan.migration.steps.includes('update_drive_data') ? 'configure' : 'claim';
          plan.needsGesture = true;
          if (plan.migration.steps.includes('update_drive_data')) todo.add('configure');
          ['claim', 'secrets'].forEach(s => todo.add(s));
          textKeys.push('gesture');
        } else if (choice === 'no_key') {
          plan.entry = plan.migration.steps.includes('update_drive_data') ? 'configure' : 'done';
          if (plan.migration.steps.includes('update_drive_data')) todo.add('configure');
          textKeys.push('use_without_key');
        } else {
          plan.entry = 'identify';
          offer.push('claim', 'no_key');
          textKeys.push('claim_choice');
        }
        if (status && status.legacySecretsOpen) textKeys.push('legacy_secrets');
        break;
      }
      case 'claimed':
        plan.entry = null;  // no wizard: a normal session
        plan.migration = planMigrationAssistant({ ident, status, noRotate });
        break;
      case 'locked':
        plan.entry = null;
        textKeys.push('locked', 'factory_reset');
        break;
      case 'legacy':
        plan.entry = null;
        if (url && url.oldFirmware && !textKeys.includes('setup_old_firmware')) textKeys.push('setup_old_firmware');
        break;
      default:
        plan.entry = 'identify';
    }
    if (trigger === 'flasher' && state === 'unknown') plan.entry = 'identify';
    for (const id of STEPS) {
      const s = id === 'identify' || id === 'done' ? 'todo' : (todo.has(id) ? 'todo' : 'skip');
      plan.steps.push({ id, status: s });
    }
    return plan;
  }

  /**
   * P7 migration assistant (§ 15.3): one step per screen.
   *   update_drive_data  NEEDS_MIGRATION (READ_IDENT tail bit 1)
   *   rotate_key         claimed with a 2.x key (KEY_LEGACY / ROTATION_SUGGESTED), unless opted out
   *   claim_gesture      unclaimed but holding 2.x secrets (LEGACY_SECRETS_OPEN)
   *   change_wifi        after claim_gesture: the password was readable
   */
  function planMigrationAssistant({ ident = null, status = null, noRotate = false } = {}) {
    const steps = [];
    const textKeys = [];
    if (ident && ident.needsMigration) { steps.push('update_drive_data'); textKeys.push('needs_migration'); }
    const legacyKey = !!(status && status.claimed && (status.rotationSuggested || status.keyLegacy));
    if (legacyKey) {
      if (!noRotate) { steps.push('rotate_key'); textKeys.push('rotation_one_way'); } else textKeys.push('rotation_pending');
    }
    const legacySecrets = !!((status && status.legacySecretsOpen) || (ident && ident.legacySecretsOpen));
    if (legacySecrets) { steps.push('claim_gesture', 'change_wifi'); textKeys.push('legacy_secrets', 'change_wifi'); }
    return { applies: steps.length > 0, steps, textKeys };
  }

  /**
   * What to tell the user after a NOT_IN_CLAIM_MODE answer (two-cycle gesture), and for a key
   * that no longer works (five-cycle reset). The two texts are deliberately different.
   */
  function recoveryText(reason) {
    if (reason === 'not_in_claim_mode') return 'not_in_claim_mode';
    if (reason === 'not_authorised' || reason === 'locked') return 'factory_reset';
    if (reason === 'claim_mode_ended') return 'claim_mode_ended';
    return null;
  }

  return { STEPS, parseMsdState, claimModeScanFilter, deviceState, planWizard, planMigrationAssistant, recoveryText,
    MSD_STATUS_CLAIM_MODE, MSD_STATUS_SESSION_REQUIRED, COMPANY_ID };
});
