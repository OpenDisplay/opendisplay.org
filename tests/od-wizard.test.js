// The setup wizard planner: device states per SECURITY_V2 rev 5 § 5.3.1 / § 15.1, the P7
// migration assistant, the MSD bits and the optional claim-mode scan filter.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../httpdocs/js/od-wizard.js');
const U = require('../httpdocs/js/od-setup-url.js');
const T = require('../httpdocs/js/od-texts.js');

const msd16 = (status, dyn = 0x00) => Uint8Array.from([0x46, 0x24, ...new Array(11).fill(dyn), 25, 0x40, status]);
const msd14 = (status, dyn = 0x00) => Uint8Array.from([...new Array(11).fill(dyn), 25, 0x40, status]);
const st = o => Object.assign({ claimed: false, locked: false, claimMode: false, claimModeFresh: false, configLocked: false,
  legacySecretsOpen: false, rotationSuggested: false, keyLegacy: false }, o);
const todo = p => p.steps.filter(s => s.status === 'todo').map(s => s.id);

test('MSD state bits for every row of § 5.3.1 (16-byte READ_MSD and 14-byte Web Bluetooth forms)', () => {
  const rows = [
    ['unclaimed normal', 0xc0, 0x11, { claimMode: false, sessionRequired: false, awaitingClaim: false, unconfigured: false }],
    ['unclaimed, no display', 0xc0, 0xff, { claimMode: false, sessionRequired: false, awaitingClaim: false, unconfigured: true }],
    ['virgin', 0xc4, 0xff, { claimMode: true, sessionRequired: false, awaitingClaim: true, unconfigured: true }],
    ['gesture', 0x34, 0x11, { claimMode: true, sessionRequired: false, awaitingClaim: true, unconfigured: false }],
    ['claimed in claim mode', 0xcc, 0x11, { claimMode: true, sessionRequired: true, awaitingClaim: false, unconfigured: false }],
    ['claimed', 0xc8, 0x11, { claimMode: false, sessionRequired: true, awaitingClaim: false, unconfigured: false }],
    ['reboot bit and battery bit ignored', 0x07, 0x11, { claimMode: true, sessionRequired: false, awaitingClaim: true, unconfigured: false }]
  ];
  for (const [n, s, d, want] of rows) {
    for (const m of [W.parseMsdState(msd16(s, d)), W.parseMsdState(msd14(s, d))]) {
      for (const [k, v] of Object.entries(want)) assert.equal(m[k], v, n + ' ' + k);
    }
  }
  assert.equal(W.parseMsdState(new Uint8Array(13)), null);
  // A DataView (what Web Bluetooth hands out) works too.
  assert.equal(W.parseMsdState(new DataView(msd14(0xc4, 0xff).buffer)).awaitingClaim, true);
});

test('claim-mode scan filter: bit 2 set, bit 3 clear, company 0x2446', () => {
  const f = W.claimModeScanFilter('OD1A2B3C');
  const m = f.manufacturerData[0];
  assert.equal(m.companyIdentifier, 0x2446);
  assert.equal(m.dataPrefix.length, 14); assert.equal(m.dataPrefix[13], 0x04); assert.equal(m.mask[13], 0x0c);
  assert.equal(f.namePrefix, 'OD1A2B3C');
  assert.equal(W.claimModeScanFilter().namePrefix, undefined);
});

test('virgin device (just flashed): enter at Configure display', () => {
  const p = W.planWizard({ trigger: 'flasher', status: st({ claimMode: true, claimModeFresh: true }), ident: { flags: 0x29, sec2: true, displays: [] } });
  assert.equal(p.state, 'virgin'); assert.equal(p.entry, 'configure');
  assert.deepEqual(todo(p), ['identify', 'configure', 'verify', 'claim', 'secrets', 'done']);
});

test('FRESH after config: Verify panel; once the code was drawn (config locked): Claim', () => {
  const ident = { flags: 0x29, sec2: true, displays: [{}] };
  const a = W.planWizard({ status: st({ claimMode: true, claimModeFresh: true }), ident });
  assert.equal(a.state, 'fresh'); assert.equal(a.entry, 'verify');
  assert.deepEqual(todo(a), ['identify', 'verify', 'claim', 'secrets', 'done']);
  const b = W.planWizard({ status: st({ claimMode: true, claimModeFresh: true, configLocked: true }), ident });
  assert.equal(b.entry, 'claim'); assert.ok(!todo(b).includes('verify'));
});

test('GESTURE claim mode goes straight to Claim', () => {
  const p = W.planWizard({ status: st({ claimMode: true }) });
  assert.equal(p.state, 'gesture'); assert.equal(p.entry, 'claim');
  assert.ok(p.textKeys.includes('awaiting_claim'));
});

test('open device in normal mode: offers claim (gesture) or use without a key', () => {
  const p = W.planWizard({ trigger: 'toolbox', status: st({}) });
  assert.equal(p.state, 'open'); assert.deepEqual(p.offer, ['claim', 'no_key']);
  assert.ok(p.textKeys.includes('claim_choice'));
  const c = W.planWizard({ status: st({}), choice: 'claim' });
  assert.equal(c.entry, 'claim'); assert.equal(c.needsGesture, true); assert.ok(c.textKeys.includes('gesture'));
  const n = W.planWizard({ status: st({}), choice: 'no_key' });
  assert.equal(n.entry, 'done'); assert.ok(!todo(n).includes('secrets'), 'no secrets without a key');
  // NEEDS_MIGRATION first.
  const m = W.planWizard({ status: st({}), ident: { flags: 0x0b, sec2: true, needsMigration: true, displays: [{}] }, choice: 'claim' });
  assert.equal(m.entry, 'configure'); assert.deepEqual(m.migration.steps, ['update_drive_data']);
});

test('claimed / locked / legacy / unknown', () => {
  const c = W.planWizard({ status: st({ claimed: true }) });
  assert.equal(c.state, 'claimed'); assert.equal(c.entry, null);
  const l = W.planWizard({ status: st({ claimed: true, locked: true }) });
  assert.equal(l.state, 'locked'); assert.deepEqual(l.textKeys, ['locked', 'factory_reset']);
  assert.equal(W.planWizard({ fw: { major: 2 } }).state, 'legacy');
  assert.equal(W.planWizard({ ident: { flags: 0x01, sec2: false, displays: [] } }).state, 'legacy');
  assert.equal(W.planWizard({}).state, 'unknown');
  assert.equal(W.planWizard({ msd: W.parseMsdState(msd14(0xc4, 0xff)) }).state, 'virgin');
  assert.equal(W.planWizard({ msd: W.parseMsdState(msd14(0xc8)) }).state, 'claimed');
  assert.equal(W.planWizard({ status: st({ claimed: true, claimMode: true }) }).entry, 'secrets');
});

test('QR trigger: filter by name, preselect the preset, say "reset" for k=2, generic for a newer format', () => {
  const url = U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=2&i=1A2B3C&t=3&v=3.0.0&b=16&d=10&p=2');
  const p = W.planWizard({ trigger: 'qr', url, status: st({ claimMode: true, claimModeFresh: true }), ident: { flags: 0x29, sec2: true, displays: [] } });
  assert.equal(p.scan.name, 'OD1A2B3C'); assert.deepEqual(p.preset, { b: 16, d: 10, p: 2 });
  assert.ok(p.textKeys.includes('setup_reset')); assert.ok(p.textKeys.includes('setup_confirm_preset'));
  assert.equal(p.entry, 'configure', 'recovery is setup');
  const g = W.planWizard({ trigger: 'qr', url: U.parseSetupUrl('https://opendisplay.org/l/?f=7&k=1&i=1A2B3C&b=1') });
  assert.equal(g.preset, null); assert.ok(g.textKeys.includes('setup_newer_format')); assert.equal(g.scan.name, 'OD1A2B3C');
  const o = W.planWizard({ trigger: 'qr', url: U.parseSetupUrl('https://opendisplay.org/l/?f=1&k=1&i=1A2B3C&v=2.5.0') });
  assert.ok(o.textKeys.includes('setup_old_firmware'));
});

test('P7 migration assistant', () => {
  const a = W.planMigrationAssistant({ ident: { needsMigration: true }, status: st({ claimed: true, rotationSuggested: true }) });
  assert.deepEqual(a.steps, ['update_drive_data', 'rotate_key']);
  assert.ok(a.textKeys.includes('rotation_one_way'));
  const off = W.planMigrationAssistant({ status: st({ claimed: true, keyLegacy: true }), noRotate: true });
  assert.deepEqual(off.steps, []); assert.ok(off.textKeys.includes('rotation_pending'));
  const s = W.planMigrationAssistant({ status: st({ legacySecretsOpen: true }) });
  assert.deepEqual(s.steps, ['claim_gesture', 'change_wifi']);
  assert.equal(W.planMigrationAssistant({}).applies, false);
});

test('every text key the planner names exists', () => {
  const plans = [W.planWizard({ status: st({}) }), W.planWizard({ status: st({}), choice: 'claim' }), W.planWizard({ status: st({}), choice: 'no_key' }),
    W.planWizard({ status: st({ claimMode: true, claimModeFresh: true }) }), W.planWizard({ status: st({ locked: true, claimed: true }) }),
    W.planWizard({ url: U.parseSetupUrl('f=1&k=2&i=000001&v=2.0.0&b=1') }), W.planWizard({ url: U.parseSetupUrl('f=9&k=1&i=000001') })];
  const keys = new Set(plans.flatMap(p => p.textKeys.concat(p.migration ? p.migration.textKeys : [])));
  for (const r of ['not_in_claim_mode', 'not_authorised', 'claim_mode_ended']) keys.add(W.recoveryText(r));
  for (const m of [W.planMigrationAssistant({ ident: { needsMigration: true }, status: st({ claimed: true, keyLegacy: true, legacySecretsOpen: true }) })]) m.textKeys.forEach(k => keys.add(k));
  for (const k of keys) assert.doesNotThrow(() => T.text(k), k);
  assert.notEqual(W.recoveryText('not_in_claim_mode'), W.recoveryText('not_authorised'));
});
