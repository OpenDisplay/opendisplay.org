/*
 * errors.js — turn the errors this app can actually produce into messages a
 * person can act on (plan §9, M4).
 *
 * Three sources feed in, none of them written for end users: Web Bluetooth
 * DOMExceptions, the shared protocol library's thrown strings, and IndexedDB.
 * Raw text like "NetworkError: GATT operation failed" tells someone nothing
 * about what to DO, so every known shape is mapped to a sentence plus a hint;
 * anything unrecognised falls through with its original text preserved (never
 * swallowed) so unexpected failures stay debuggable.
 */

/**
 * @typedef {{title: string, hint?: string, kind: 'info'|'error'|'cancelled'}} Described
 */

const text = (err) => String(err?.message ?? err ?? '');

/** True for the user closing the browser's device chooser — not a failure. */
export function isUserCancellation(err) {
  const name = err?.name;
  const t = text(err);
  return name === 'NotFoundError'
    || name === 'AbortError'
    || /user cancelled|cancelled|Key entry cancelled/i.test(t);
}

const MATCHERS = [
  // --- user actions that are not failures ---
  {
    test: (err) => isUserCancellation(err),
    map: () => ({ kind: 'cancelled', title: 'Cancelled.' }),
  },

  // --- authentication ---
  {
    test: (err) => /rate limit/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'Too many key attempts.',
      hint: 'The device allows 10 attempts per minute. Wait a minute and try again.',
    }),
  },
  {
    test: (err) => err?.name === 'AuthRequiredError' || /authentication required/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'This device is locked.',
      hint: 'Enter its encryption key to continue, or unlock it in the Toolbox.',
    }),
  },
  {
    test: (err) => /authentication failed|wrong key|invalid key/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'That key was rejected by the device.',
      hint: 'Check the key, or re-read it from the Toolbox if it was changed.',
    }),
  },

  // --- connection lifecycle ---
  {
    test: (err) => err?.name === 'TimeoutError',
    map: (err) => ({
      kind: 'error',
      title: text(err),
      hint: 'The device stopped responding. Make sure it is awake and in range, then reconnect.',
    }),
  },
  {
    test: (err) => err?.name === 'StaleInstanceError' || /torn down while the operation/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'The connection dropped before that finished.',
      hint: 'Nothing was applied. Reconnect and try again.',
    }),
  },
  {
    test: (err) => err?.name === 'NetworkError' || /GATT|Not connected/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'Lost the Bluetooth connection.',
      hint: 'Battery-powered tags sleep quickly — wake the device and reconnect.',
    }),
  },
  {
    test: (err) => err?.name === 'SecurityError',
    map: () => ({
      kind: 'error',
      title: 'The browser blocked that Bluetooth operation.',
      hint: 'The page must be served over HTTPS, and the device must be paired from a click.',
    }),
  },
  {
    test: (err) => /Another operation is in progress/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'Something else is already talking to the device.',
      hint: 'Wait for it to finish, then try again.',
    }),
  },

  // --- storage ---
  {
    test: (err) => err?.name === 'QuotaExceededError' || /quota/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'The browser is out of storage for this site.',
      hint: 'Delete a draft or a saved device, or free up disk space, then retry.',
    }),
  },
  {
    test: (err) => /IndexedDB open blocked/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'Another tab is holding this app’s storage open.',
      hint: 'Close the app’s other tabs and reload.',
    }),
  },
  {
    test: (err) => /IndexedDB|storage unavailable/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'Could not reach this browser’s storage.',
      hint: 'Private windows and blocked site data prevent saving devices and drafts.',
    }),
  },
  {
    test: (err) => /no longer exists — draft not saved/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'That device was removed in another tab.',
      hint: 'The draft was not saved. Go back to Devices and add the device again.',
    }),
  },

  // --- composing and sending ---
  {
    test: (err) => err?.name === 'UnsupportedImageError',
    map: (err) => ({
      kind: 'error',
      title: text(err),
      hint: 'Convert the image and try again — the app needs to read its size before decoding it.',
    }),
  },
  {
    test: (err) => err?.name === 'SendAbortedError',
    map: (err) => ({ kind: 'error', title: text(err), hint: 'Nothing was sent to the panel.' }),
  },
  {
    test: (err) => /QR needs .* minimum/i.test(text(err)),
    map: (err) => ({
      kind: 'error',
      title: text(err),
      hint: 'Shorten the text, or lower the error-correction level.',
    }),
  },
  {
    test: (err) => /too light to scan/i.test(text(err)),
    map: (err) => ({ kind: 'error', title: text(err), hint: 'Black scans best on every panel.' }),
  },
  {
    test: (err) => /colour scheme .* is not supported/i.test(text(err)),
    map: (err) => ({
      kind: 'error',
      title: text(err),
      hint: 'Use the Display Tool for panels this app does not support yet.',
    }),
  },
  {
    test: (err) => /dither worker failed|wasm/i.test(text(err)),
    map: () => ({
      kind: 'error',
      title: 'The image processor stopped unexpectedly.',
      hint: 'Try a smaller photo; if it keeps happening, reload the page.',
    }),
  },
  {
    test: (err) => /device must be awake|advertising/i.test(text(err)),
    map: (err) => ({ kind: 'error', title: text(err) }),
  },
];

/** Map any error to a user-facing description. Never throws. */
export function describeError(err) {
  for (const m of MATCHERS) {
    try {
      if (m.test(err)) return m.map(err);
    } catch {
      /* a matcher must never break error reporting */
    }
  }
  const t = text(err);
  return {
    kind: 'error',
    title: t || 'Something went wrong.',
    hint: undefined,
  };
}

/** One-line form for a status area. */
export function errorMessage(err) {
  const d = describeError(err);
  return d.hint ? `${d.title} ${d.hint}` : d.title;
}
