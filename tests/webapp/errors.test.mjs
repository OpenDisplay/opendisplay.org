// M4: every error this app can produce must reach the user as something they
// can ACT on. These tests pin the mapping for the failure modes the plan calls
// out (bad key, rate limit, schema failure, disconnect mid-upload, denied
// persistence, quota) plus the ones later reviews surfaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppModule } from './lib/load-app-module.mjs';

const { describeError, errorMessage, isUserCancellation } = await loadAppModule('errors.js');

function named(name, message) {
  const e = new Error(message ?? name);
  e.name = name;
  return e;
}

test('a cancelled chooser is information, not an error', () => {
  for (const err of [named('NotFoundError', 'User cancelled the requestDevice() chooser.'),
                     named('AbortError', 'The user dismissed the chooser'),
                     new Error('Key entry cancelled')]) {
    assert.equal(isUserCancellation(err), true, err.name);
    assert.equal(describeError(err).kind, 'cancelled');
  }
});

test('cancellation is classified NARROWLY: a bare AbortError is a real failure', () => {
  // AbortError/NotFoundError are also produced by genuine faults, so the name
  // alone must not excuse them — that would hide real errors as "Cancelled."
  for (const err of [named('AbortError'),
                     named('AbortError', 'GATT operation aborted'),
                     named('NotFoundError', 'Service 0x2446 not found')]) {
    assert.equal(isUserCancellation(err), false, err.message);
    assert.equal(describeError(err).kind, 'error');
  }
});

test('upload failures from the shared library get actionable messages', () => {
  const ack = describeError(new Error('Direct write ack timeout (chunk 12)'));
  assert.match(ack.title, /stopped acknowledging/i);
  assert.match(ack.hint, /Nothing was displayed/i);
  assert.match(ack.hint, /chunk 12/, 'the specific detail is preserved');

  const refresh = describeError(new Error('Display refresh timed out'));
  assert.match(refresh.title, /did not report finishing/i);
  assert.match(refresh.hint, /may still appear/i, 'e-paper may have refreshed anyway');

  assert.match(
    describeError(new Error('PIPE_WRITE aborted: MAX_RETX exceeded (PTO)')).title,
    /lost packets/i,
  );
  assert.match(describeError(new Error('Partial update failed')).hint, /full-screen update/i);
  assert.match(describeError(new Error('Disconnected')).title, /disconnected during/i);
  assert.match(describeError(new Error('Upload failed')).title, /upload failed/i);
});

test('an image too large to resize safely is refused with its size', () => {
  const d = describeError(named('ImageTooLargeError',
    'Image is too large for this browser to resize safely (96 megapixels)'));
  assert.match(d.title, /96 megapixels/);
});

test('auth failures explain what to do about them', () => {
  const rate = describeError(new Error('Authentication rate limit exceeded (10 attempts per minute)'));
  assert.match(rate.title, /too many key attempts/i);
  assert.match(rate.hint, /wait a minute/i);

  const locked = describeError(named('AuthRequiredError', 'Device is locked'));
  assert.match(locked.title, /locked/i);
  assert.match(locked.hint, /Toolbox/);

  const wrong = describeError(new Error('Authentication failed: wrong key'));
  assert.match(wrong.title, /rejected by the device/i);
});

test('a timeout keeps its specific message and adds recovery advice', () => {
  const err = named('TimeoutError', 'Config read timed out after 15000 ms');
  const d = describeError(err);
  assert.match(d.title, /Config read timed out/, 'the specific operation is preserved');
  assert.match(d.hint, /awake and in range/i);
});

test('a mid-operation disconnect says nothing was applied', () => {
  const d = describeError(named('StaleInstanceError',
    'Connection was torn down while the operation was in flight'));
  assert.match(d.title, /connection dropped/i);
  assert.match(d.hint, /Nothing was applied/i);
});

test('GATT and security errors name the real cause', () => {
  assert.match(describeError(named('NetworkError', 'GATT operation failed')).hint, /sleep quickly/i);
  assert.match(describeError(named('SecurityError', 'blocked')).hint, /HTTPS/);
});

test('storage failures distinguish quota, blocked and unavailable', () => {
  assert.match(describeError(named('QuotaExceededError', 'quota')).title, /out of storage/i);
  assert.match(describeError(new Error('IndexedDB open blocked')).title, /another tab/i);
  assert.match(describeError(new Error('IndexedDB open failed')).title, /storage/i);
  assert.match(
    describeError(new Error('device rec-1 no longer exists — draft not saved')).hint,
    /not saved/i,
  );
});

test('composer failures point at the fix', () => {
  assert.match(
    describeError(named('UnsupportedImageError', 'Unsupported image format — use PNG, JPEG, GIF or WebP')).title,
    /PNG, JPEG, GIF or WebP/,
  );
  assert.match(
    describeError(new Error('QR needs 41px minimum (incl. quiet zone) but the panel is 30px')).hint,
    /lower the error-correction/i,
  );
  assert.match(describeError(new Error('QR ink is too light to scan')).hint, /Black scans best/);
  assert.match(
    describeError(new Error('colour scheme 7 is not supported by this app')).hint,
    /Display Tool/,
  );
  assert.match(describeError(new Error('dither worker failed')).title, /image processor/i);
});

test('an aborted send states plainly that nothing was sent', () => {
  const d = describeError(named('SendAbortedError',
    'the composition changed while preparing to send — nothing was sent'));
  assert.match(d.hint, /Nothing was sent/i);
});

test('unknown errors keep their original text rather than being swallowed', () => {
  const d = describeError(new Error('some entirely novel failure'));
  assert.equal(d.title, 'some entirely novel failure');
  assert.equal(d.kind, 'error');
});

test('describeError never throws, whatever it is handed', () => {
  for (const weird of [undefined, null, '', 0, {}, [], Symbol('x'), new Error()]) {
    const d = describeError(weird);
    assert.equal(typeof d.title, 'string');
    assert.ok(d.title.length > 0, `non-empty for ${String(weird)}`);
  }
});

test('errorMessage joins title and hint into one line', () => {
  const msg = errorMessage(named('QuotaExceededError', 'quota'));
  assert.match(msg, /out of storage.*Delete a draft/is);
  // No hint: just the title.
  assert.equal(errorMessage(new Error('plain')), 'plain');
});
