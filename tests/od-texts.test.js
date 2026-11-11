// The shared user texts must be word-for-word the ones py-opendisplay shows.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../httpdocs/js/od-texts.js');

const py = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'user_texts.json'), 'utf8'));

test('shared texts equal py-opendisplay user_texts.json, key for key and word for word', () => {
  assert.equal(py.schema, T.SCHEMA);
  assert.deepEqual(Object.keys(T.SHARED).sort(), Object.keys(py.texts).sort());
  for (const [k, v] of Object.entries(py.texts)) assert.equal(T.SHARED[k], v, k);
});

// Drift guard against the live py-opendisplay worktree (skipped when it is not checked out here).
const PY_LIVE = [path.join(__dirname, '..', '..', 'py-v9', 'tests', 'fixtures', 'user_texts.json'),
  path.join(__dirname, '..', '..', 'py', 'tests', 'fixtures', 'user_texts.json')].find(f => fs.existsSync(f));
test('shared texts equal the py-opendisplay worktree file (py-v9)', { skip: PY_LIVE ? false : 'no py-opendisplay worktree next to this one (../py-v9 or ../py)' }, () => {
  const live = JSON.parse(fs.readFileSync(PY_LIVE, 'utf8'));
  assert.equal(live.schema, T.SCHEMA, PY_LIVE);
  assert.deepEqual(Object.keys(T.SHARED).sort(), Object.keys(live.texts).sort(), PY_LIVE);
  for (const [k, v] of Object.entries(live.texts)) assert.equal(T.SHARED[k], v, k + ' differs from ' + PY_LIVE);
  assert.deepEqual(py, live, 'tests/fixtures/user_texts.json is stale: copy it from ' + PY_LIVE);
});

test('website texts never shadow a shared key', () => {
  for (const k of Object.keys(T.WEBSITE)) assert.ok(!(k in T.SHARED), k);
});

test('the two-cycle claim text and the five-cycle reset text are worded distinctly', () => {
  assert.match(T.text('gesture'), /twice in total, not more/);
  assert.match(T.text('factory_reset'), /five times/);
  assert.doesNotMatch(T.text('gesture'), /five/);
  assert.match(T.text('not_in_claim_mode'), new RegExp(T.text('gesture').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the show-key warning carries the required sentence', () => {
  assert.match(T.text('show_key'), /Anyone who can see the display, or a photo of it, has the key/);
});

test('placeholders and unknown keys', () => {
  assert.equal(T.text('verify_panel', { id: 'OD1A2B3C' }), 'Does the display show SETUP MODE and the ID OD1A2B3C?');
  assert.throws(() => T.text('nope'), /unknown text key/);
});
