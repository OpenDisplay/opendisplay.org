// User-facing texts for the SEC2 / setup flows: ONE module, stable keys.
// SHARED: copied verbatim from py-opendisplay src/opendisplay/texts.py
// (tests/fixtures/user_texts.json, schema opendisplay-user-texts/2). Change them there first;
// tests/od-texts.test.js fails when the two differ.
// WEBSITE: texts only the browser needs (prompts, refusals, storage). Each may contain {name}
// placeholders filled by format().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OpenDisplayTexts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SCHEMA = 'opendisplay-user-texts/2';
  const SHARED = Object.freeze({
    awaiting_claim: "This display is in setup mode and waiting to be claimed. Setup mode ends after 10 minutes.",
    blank_panel: "This display reports that its screen does not work, so its code cannot be checked. Claiming is then protected only by claim mode, which you started on the device. Continue only if the display screen really does not work and nobody you distrust is nearby.",
    change_wifi: "Change your WiFi password: it was readable while the display was unclaimed.",
    claim_first: "The display refused the secrets because it is not claimed. Claim this device first.",
    claim_mode_ended: "The display is no longer in setup mode (it closes after 10 minutes, or the display restarted). Start it again: Put the display into claim mode: switch it off and on, wait about 5 seconds, switch it off and on again (twice in total, not more). It now shows SETUP MODE. Then claim it within 10 minutes.",
    display_seen: "This display reported a screen before. Claiming without the code is refused, because someone may be interfering.",
    factory_reset: "Lost the key? Factory-reset the display: switch it off and on five times. Each time, wait about 5 seconds before switching it off, and keep it off for at least 2 seconds. It then shows FACTORY RESET and starts fresh. This ERASES its key, WiFi password, FindMy keys, images and settings. (Twice is claim mode; five times is the reset.)",
    gesture: "Put the display into claim mode: switch it off and on, wait about 5 seconds, switch it off and on again (twice in total, not more). It now shows SETUP MODE. Then claim it within 10 minutes.",
    legacy_key_rotated: "The key carried over from the 2.x firmware was replaced by a new key, automatically. Back up the new key now. Going back to a 2.x firmware now needs a factory reset first.",
    key_dead: "This display was reset to factory state, so the key stored here no longer works. Set it up again; the old key is kept until the new claim succeeds.",
    legacy_secrets: "This display stores a WiFi password or FindMy keys but is not claimed. Anyone nearby can read them. Claim it now: switch the display off and on, wait about 5 seconds, switch it off and on again.",
    no_panel: "This display reports that it has no screen, so its code cannot be checked. Claiming is then protected only by claim mode, which you started on the device. Continue only if the display really has no screen and nobody you distrust is nearby.",
    no_recovery: "This config switches off the five-power-cycle factory reset and the display has no reset pin. If its key is ever lost, the only way back is a wired reflash (USB/SWD).",
    power_access: "Anyone who can switch the display's power off and on five times can reset it to factory state (your keys and settings are erased, not revealed).",
    reconnect_wait: "The display restarts after a configuration change. Wait at least 30 seconds for it to come back.",
    rotation_one_way: "Replacing the key from the 2.x firmware is a one-way step. Afterwards, installing a 2.x firmware image directly no longer gives a working key; going back then needs a factory reset first.",
    rotation_pending: "This display still uses the key from its 2.x firmware. It will be replaced by a new key the next time it connects, once the new key can be stored safely.",
    secrets_need_key: "WiFi passwords and FindMy keys need a key: the display must be claimed first, so that they are sent encrypted and nobody nearby can read them.",
    show_key_not_stored: "The display keeps the setting to show its key on the screen only while it is claimed, so it stored it as off. Nothing failed. Claim the display first, then switch the setting on again.",
    show_key: "The display will show its key on the screen, permanently. Anyone who can see the display, or a photo of it, has the key and can control the display and read its WiFi password."
  });
  const WEBSITE = Object.freeze({
    busy_retry: "The display is busy drawing. Trying again in a moment.",
    claim_choice: "This display is not claimed. Claim it to protect it with a key (needs the power-cycle gesture on the display), or use it without a key.",
    claimed_ok: "Claimed. The key is stored in this browser.",
    code_mismatch: "The code does not match the display. Nothing was claimed. Check the code on the display and try again; if it still does not match, someone may be interfering.",
    config_busy: "The display is busy drawing. Wait a few seconds and try again; nothing was written.",
    config_malformed: "This configuration is damaged (it does not end at its checksum). Nothing was written.",
    enter_code: "Type the 6-digit code shown on the display.",
    frame_too_long: "The display refused a message as too long for this connection. Nothing more was sent.",
    key_from_link: "A key was taken from the link and removed from the address bar.",
    key_mismatch: "The display refused this configuration because it carries a different key. Remove the key from the configuration, or use this display's own key.",
    locked: "This display is locked. Recover it with a factory reset.",
    needs_migration: "This display runs firmware 3 but its configuration has no drive data for its panel yet. Update the drive data first.",
    no_rotate_migrated: "Do not replace keys carried over from firmware 2.x",
    no_rotate_this_display: "Do not replace the key this display carried over from firmware 2.x",
    not_authorised: "Not authorised: this display is claimed and no stored key works for it. Add its key, or factory-reset it if the key is lost.",
    not_in_claim_mode: "The display is not in claim mode. Put the display into claim mode: switch it off and on, wait about 5 seconds, switch it off and on again (twice in total, not more). It now shows SETUP MODE. Then claim it within 10 minutes.",
    panel_busy: "The display panel is busy. Wait a few seconds and try again.",
    rotation_kept: "This display keeps the key from its 2.x firmware, because \"Do not replace keys carried over from firmware 2.x\" is on.",
    rotation_needs_storage: "This browser cannot keep keys safely (private window, or it may delete stored data), so the key was not replaced. Use a normal browser window, or replace it from the Security dialog after downloading the key.",
    rotation_done_show_key: "The key was replaced. This display shows its key on the boot screen, which now shows the new key.",
    seen_on_sec2: "This display uses secure sessions; this browser will not talk to it without one.",
    setup_confirm_preset: "Check the board, display and power option below before anything is written.",
    setup_genuine: "Only https://opendisplay.org/l/ is genuine. A display in claim mode or factory reset can be redrawn by anyone nearby before it enters that state; claim mode itself cannot be redrawn.",
    setup_newer_format: "This display shows a newer setup code than this page knows. You can still set it up.",
    setup_old_firmware: "Firmware 2.x has no setup screen. Use the normal toolbox for this display.",
    setup_reset: "This display was reset to factory settings. Its settings and key were erased.",
    show_key_confirm: "Show the key on the display?",
    storage_not_durable: "This browser cannot keep the key safely (private window or storage not allowed). Claiming and key replacement are refused, because the display would end up with a key nobody has. Use a normal browser window, or download the key first.",
    storage_not_persisted: "This browser may delete stored keys when it runs low on space. Download a copy of the key before continuing.",
    unclaim_confirm: "Unclaim this display? Its key, WiFi password and FindMy keys are erased and anyone nearby can then change it.",
    use_without_key: "Use without a key: anyone nearby can change this display, and it cannot store a WiFi password or FindMy keys.",
    verify_panel: "Does the display show SETUP MODE and the ID {id}?"
  });
  const ALL = Object.freeze(Object.assign({}, SHARED, WEBSITE));
  /** The text for `key`, with {name} placeholders filled from `vars`. Unknown key -> throws (a typo must not show nothing). */
  function text(key, vars) {
    if (!Object.prototype.hasOwnProperty.call(ALL, key)) throw new Error('unknown text key ' + key);
    return ALL[key].replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  }
  return { SCHEMA, SHARED, WEBSITE, ALL, text };
});
