/*
 * devices.js — device-list controller (DESIGN_WEB_OD_APP_PLAN.md §5).
 * Flows: startup permission sweep, add via chooser (two-phase rebind),
 * cached reconnect, refresh-on-connect, forget, export/import.
 *
 * Controller rules:
 *  - `busy` gates every device-facing action (double-clicks can't reach the
 *    adapter's serialization errors);
 *  - Bluetooth-gated sessions render records read-only (no Connect/Add);
 *  - keys entered in the dialog are saved ONLY after the authenticated
 *    protected read succeeds end-to-end;
 *  - a key counts as exported only after delivery is confirmed.
 */
import * as adapter from './ble-adapter.js';
import * as store from './store.js';
import * as keys from './keys.js';
import { makeFlows } from './flows.js';
import { errorMessage, describeError } from './errors.js';
import { openComposer, closeComposer, openRecordId, refreshConnectionState } from './composer/index.js';
import { askForKey, askRebind, confirmRepair, deliverKeyHex, confirmDanger, toast } from './ui/dialogs.js';

const flows = makeFlows({
  adapter, store, keys,
  ui: { askForKey, askRebind, confirmRepair, deliverKeyHex, toast },
});

let grantedById = new Map(); // bleId -> BluetoothDevice
let connectedRecordId = null;
let busy = false;
let bluetoothGated = false;

const $ = (id) => document.getElementById(id);

/** Surface an error as actionable guidance; a user cancellation is not a
 *  failure and is reported as plain information. */
function reportError(err) {
  const d = describeError(err);
  toast(errorMessage(err), d.kind === 'cancelled' ? 'info' : 'error');
}

// ---------------------------------------------------------------------------
// Permission sweep
// ---------------------------------------------------------------------------

async function sweepPermissions() {
  grantedById = new Map();
  try {
    // Timeboxed: getDevices() can hang where no Bluetooth backend exists
    // (headless, some platforms). A missed sweep only degrades rows to
    // chooser-per-connect — it must never stall the whole app.
    const sweep = navigator.bluetooth?.getDevices?.();
    if (!sweep) return;
    const devices = await Promise.race([
      sweep,
      new Promise((r) => setTimeout(() => r([]), 3000)),
    ]);
    for (const d of devices) grantedById.set(d.id, d);
  } catch {
    /* getDevices unavailable: every row degrades to chooser-per-connect */
  }
}

function permissionChip(record) {
  if (record.recordId === connectedRecordId) return ['connected', 'Connected'];
  if (!record.bleId) return ['missing', 'Permission missing'];
  if (grantedById.has(record.bleId)) return ['granted', 'Permission available'];
  return ['missing', 'Permission missing'];
}

// ---------------------------------------------------------------------------
// Busy wrapper
// ---------------------------------------------------------------------------

async function withBusy(fn) {
  if (busy) return; // ignore re-entrant clicks entirely
  busy = true;
  renderControls();
  try {
    await fn();
  } finally {
    busy = false;
    await refresh();
  }
}

function renderControls() {
  $('btnAddDevice').disabled = busy || bluetoothGated;
  $('btnExport').disabled = busy;
  for (const b of document.querySelectorAll('#deviceList button')) {
    // `data-gated` marks a button disabled for a reason of its own (no
    // Bluetooth in this browser). Without honouring it here, this loop would
    // re-ENABLE Connect on a gated browser, since it runs after the cards are
    // built. Composer is deliberately never gated: composing does not need a
    // connection.
    b.disabled = busy || b.dataset.gated === 'true';
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtLastSeen(ts) {
  if (!ts) return 'never';
  const d = Math.round((Date.now() - ts) / 60000);
  if (d < 1) return 'just now';
  if (d < 60) return `${d} min ago`;
  if (d < 60 * 48) return `${Math.round(d / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
}

async function renderList() {
  const listEl = $('deviceList');
  const empty = $('emptyState');
  let devices = [];
  try {
    devices = await store.listDevices();
  } catch (err) {
    reportError(err);
  }
  listEl.textContent = '';
  empty.hidden = devices.length > 0;

  for (const record of devices.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))) {
    listEl.appendChild(deviceCard(record));
  }
  renderControls();
}

function deviceCard(record) {
  const [chipKind, chipText] = permissionChip(record);
  const card = document.createElement('article');
  card.className = 'odapp-card';
  card.dataset.recordId = record.recordId;

  const title = document.createElement('h3');
  title.className = 'odapp-card__name';
  title.textContent = record.name;
  if (record.authRequired) title.append(' \u{1F512}');

  const meta = document.createElement('p');
  meta.className = 'odapp-card__meta';
  const rot = record.rotationQuarterTurns ? ` · rot ${record.rotationQuarterTurns * 90}°` : '';
  meta.textContent =
    `${record.width}×${record.height} · scheme ${record.colorScheme}${rot}` +
    `${record.firmwareVersion ? ` · fw ${record.firmwareVersion}` : ''} · seen ${fmtLastSeen(record.lastSeen)}`;

  const chip = document.createElement('span');
  chip.className = `odapp-chip odapp-chip--${chipKind}`;
  chip.textContent = chipText;

  const actions = document.createElement('div');
  actions.className = 'odapp-card__actions';

  const btn = (label, fn, { primary = false, disabled = false } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `odapp__btn${primary ? ' odapp__btn--primary' : ''}`;
    b.textContent = label;
    b.disabled = disabled || busy;
    if (disabled) b.dataset.gated = 'true';
    b.addEventListener('click', () =>
      withBusy(fn).catch((err) => reportError(err)),
    );
    actions.appendChild(b);
    return b;
  };

  if (record.recordId === connectedRecordId) {
    btn('Disconnect', async () => {
      await adapter.disconnect();
      connectedRecordId = null;
    }, { primary: true });
  } else {
    btn('Connect', () => connectRecord(record), {
      primary: true,
      disabled: bluetoothGated,
    });
  }
  // Never gated on a connection: tags sleep most of the time, so composing
  // offline and connecting only to send is the normal path.
  btn('Composer', async () => {
    await openComposer(record);
    showComposerView(record);
  });
  keys.getKey(record.recordId).then(async (k) => {
    if (!k) return;
    const nag = await keys.hasUnexportedKey(record.recordId).catch(() => false);
    const b = btn(nag ? 'Export key ⚠' : 'Export key', () => exportKeyFlow(record));
    if (nag) b.title = 'This key has never been backed up — clearing site data deletes it.';
  }).catch(() => {});
  btn('Forget', () => forgetFlow(record));

  card.append(title, chip, meta, actions);
  return card;
}

async function refresh() {
  await sweepPermissions();
  await renderList();
  // An open composer's Send button depends on connection state owned here.
  refreshConnectionState();
}

function showComposerView(record) {
  refreshConnectionState();
  $('viewDevices').hidden = true;
  $('viewComposer').hidden = false;
  $('navComposer').disabled = false;
  $('navComposer').classList.add('odapp__navbtn--active');
  $('navDevices').classList.remove('odapp__navbtn--active');
  $('navComposer').dataset.recordId = record.recordId;
}

// ---------------------------------------------------------------------------
// Flows (logic lives in flows.js; this file owns DOM + selection state)
// ---------------------------------------------------------------------------

async function addDevice() {
  connectedRecordId = await flows.addDeviceFlow(grantedById);
}

async function connectRecord(record) {
  connectedRecordId = await flows.connectRecordFlow(record, grantedById);
}

async function forgetFlow(record) {
  if (!(await confirmDanger(`Forget "${record.name}"? Its saved key and drafts are deleted too.`))) return;
  if (record.recordId === connectedRecordId) {
    await adapter.disconnect().catch(() => {});
    connectedRecordId = null;
  }
  // Close the composer FIRST and discard its pending draft write: a live
  // session would otherwise autosave the draft back after deletion.
  if (openRecordId() === record.recordId) {
    await closeComposer({ discard: true });
    $('navComposer').disabled = true;
    $('viewComposer').hidden = true;
    $('viewDevices').hidden = false;
    $('navDevices').classList.add('odapp__navbtn--active');
    $('navComposer').classList.remove('odapp__navbtn--active');
  }
  await store.forgetDevice(record.recordId);
  try {
    await grantedById.get(record.bleId)?.forget?.();
  } catch { /* permission revocation is best effort */ }
  // Reclaim the forgotten device's photos now, not whenever a composer next opens.
  await store.sweepAssets().catch(() => {});
}

async function exportKeyFlow(record) {
  await flows.exportKeyFlow(record);
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

async function exportDeviceList() {
  const payload = await store.exportDevices();
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'od-app-devices.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importDeviceList(file) {
  const payload = JSON.parse(await file.text());
  const { imported, skipped } = await store.importDevices(payload);
  toast(
    `Imported ${imported} device record(s)`
    + (skipped ? `, skipped ${skipped} (already present or invalid)` : '')
    + '. Connect each once to confirm its panel before sending.',
  );
}

// ---------------------------------------------------------------------------

export async function initDevices({ gated = false } = {}) {
  bluetoothGated = gated;

  adapter.setUnexpectedDisconnectListener(() => {
    connectedRecordId = null;
    toast('Device disconnected.');
    refreshConnectionState();   // Send must go dead immediately, not on repaint
    refresh();
  });

  $('btnAddDevice').addEventListener('click', () =>
    withBusy(addDevice).catch((err) => reportError(err)),
  );
  $('btnExport').addEventListener('click', () =>
    withBusy(exportDeviceList).catch((err) => reportError(err)),
  );
  $('importFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) withBusy(() => importDeviceList(file)).catch((err) => reportError(err));
  });

  await refresh();
}
