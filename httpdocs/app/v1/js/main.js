/*
 * OD App entry module (M0 skeleton): capability gate, schema readiness,
 * empty device-list view. Device flows land in M1, the composer in M2/M3.
 */
import { ready, webBluetoothBlockReason } from './ble-adapter.js';

const $ = (id) => document.getElementById(id);

function showGate(message) {
  const gate = $('gateBanner');
  gate.textContent = message;
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

async function boot() {
  const status = $('statusLine');

  const reason = webBluetoothBlockReason();
  if (reason) {
    showGate(gateMessage(reason));
    status.textContent = 'Bluetooth unavailable in this browser.';
    return;
  }

  status.textContent = 'Loading protocol schema…';
  try {
    await ready();
  } catch (err) {
    showGate(String(err instanceof Error ? err.message : err));
    status.textContent = 'Schema failed to load — device features disabled.';
    return;
  }

  status.textContent = 'Ready.';
  $('emptyState').hidden = false;
  // M1 enables this and wires the add-device flow.
  $('btnAddDevice').disabled = true;
}

$('navDevices').addEventListener('click', () => {
  $('viewDevices').hidden = false;
  $('viewComposer').hidden = true;
  $('navDevices').classList.add('odapp__navbtn--active');
  $('navComposer').classList.remove('odapp__navbtn--active');
});

boot();
