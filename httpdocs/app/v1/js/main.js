/*
 * OD App entry module (M0 skeleton): schema readiness, capability gate,
 * version-staleness check, empty device-list view. Device flows land in M1.
 *
 * Boot order is schema FIRST, gate second: the schema needs no Bluetooth, so
 * loading it unconditionally keeps the ready() path exercised (and testable)
 * even in environments where Web Bluetooth is unavailable.
 *
 * document.body.dataset.odSchema / .odGate expose deterministic boot state for
 * the browser smoke tests.
 */
import { ready, webBluetoothBlockReason } from './ble-adapter.js';
import { initDevices } from './devices.js';
import { onPersistenceDenied } from './store.js';
import { flushComposer } from './composer/index.js';

// Must match the directory this file lives in; compared against the deployed
// marker to recover from a stale heuristically-cached entry page (the
// production server sends no Cache-Control header — verified 2026-08-23:
// nginx front, no caching headers, so browsers cache index.html on the
// Last-Modified heuristic).
const APP_VERSION = 'v1';

// Tell the watchdog the module graph evaluated: without this it reports a
// load failure after its grace period.
document.body.dataset.odBoot = 'started';

const $ = (id) => document.getElementById(id);

function showGate(message, { retry = false } = {}) {
  const gate = $('gateBanner');
  gate.textContent = message;
  if (retry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'odapp__btn';
    btn.textContent = 'Retry';
    btn.style.marginLeft = '0.75rem';
    btn.addEventListener('click', () => {
      gate.hidden = true;
      boot();
    });
    gate.appendChild(btn);
  }
  gate.hidden = false;
}

function gateMessage(reason) {
  const helper = globalThis.OpenDisplayBrowser;
  switch (reason) {
    case 'firefox':
      return helper?.firefoxWebBluetoothMessage?.() ??
        'Firefox does not support Web Bluetooth. Please use Chrome or Edge.';
    case 'ios-safari':
      return 'Safari on iOS/iPadOS cannot use Web Bluetooth. Use the Bluefy app, or the native OD App for iPhone/iPad.';
    case 'insecure':
      return 'Web Bluetooth requires a secure (HTTPS) connection.';
    case 'chromium-disabled':
      return helper?.chromiumWebBluetoothDisabledMessage?.() ??
        'Web Bluetooth is disabled in this browser. Enable it in the browser settings.';
    default:
      return helper?.webBluetoothUnsupportedMessage?.() ??
        'This browser does not support Web Bluetooth. Please use Chrome or Edge on desktop or Android.';
  }
}

// Stale-entry recovery: the deployed marker names the current version. When a
// heuristically-cached index.html embeds an older APP_VERSION, reload with a
// cache-busting query so the fresh entry (and its asset graph) is fetched.
// Any fetch failure is ignored — this is a recovery aid, never a boot gate.
async function checkEntryFreshness() {
  try {
    const res = await fetch('current-version.txt', { cache: 'no-store' });
    if (!res.ok) return;
    const current = (await res.text()).trim();
    if (current && current !== APP_VERSION && !location.search.includes('rv=')) {
      location.replace(`${location.pathname}?rv=${encodeURIComponent(current)}`);
    }
  } catch {
    /* offline or marker missing: proceed with the cached version */
  }
}

async function boot() {
  const status = $('statusLine');
  try {
    status.textContent = 'Loading protocol schema…';
    try {
      await ready();
      document.body.dataset.odSchema = 'ready';
    } catch (err) {
      document.body.dataset.odSchema = 'failed';
      status.textContent = 'Schema failed to load — device features disabled.';
      showGate(String(err instanceof Error ? err.message : err), { retry: true });
      return;
    }

    // If the browser refuses durable storage, say so once: saved devices,
    // drafts and keys can be evicted under storage pressure.
    onPersistenceDenied(() => {
      showGate(
        'Durable storage could not be confirmed in this browser, so saved devices, '
        + 'drafts and encryption keys may be evicted if disk space runs low. Export '
        + 'anything you cannot lose.',
      );
    });

    // The saved-device list renders even when Bluetooth is gated (records are
    // viewable/exportable); connect-capable controls stay disabled then.
    const reason = webBluetoothBlockReason();
    await initDevices({ gated: !!reason });

    if (reason) {
      document.body.dataset.odGate = reason;
      showGate(gateMessage(reason));
      status.textContent = 'Bluetooth unavailable in this browser.';
      return;
    }

    document.body.dataset.odGate = 'none';

    // Bluefy (iOS) passes the capability gate because it does provide
    // navigator.bluetooth, but it is WebKit: silent reconnect needs
    // getDevices(), which it does not implement, so every connection goes
    // through the chooser. Say so once rather than letting it look broken.
    if (globalThis.OpenDisplayBrowser?.isBluefy?.()) {
      document.body.dataset.odBluefy = 'true';
      showGate(
        'Running in Bluefy. Sending images works, but iOS cannot remember Bluetooth '
        + 'permissions, so saved devices must be picked from the chooser every time.',
      );
    }

    status.textContent = 'Ready.';
  } catch (err) {
    // Belt-and-braces: no code path may strand the page at "Loading…".
    status.textContent = 'Something went wrong while starting the app.';
    showGate(String(err instanceof Error ? err.message : err), { retry: true });
  }
}

$('navDevices').addEventListener('click', () => {
  // Flush the composer draft before leaving: edits must never be lost.
  // The session stays alive so navigating back resumes it.
  flushComposer().catch(() => {});
  $('viewDevices').hidden = false;
  $('viewComposer').hidden = true;
  $('navDevices').classList.add('odapp__navbtn--active');
  $('navComposer').classList.remove('odapp__navbtn--active');
});

$('navComposer').addEventListener('click', () => {
  if ($('navComposer').disabled) return;
  $('viewDevices').hidden = true;
  $('viewComposer').hidden = false;
  $('navComposer').classList.add('odapp__navbtn--active');
  $('navDevices').classList.remove('odapp__navbtn--active');
});

checkEntryFreshness();
boot();
