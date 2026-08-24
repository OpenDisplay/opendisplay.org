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
import { askForKey, askRebind, confirmDanger, toast } from './ui/dialogs.js';

let grantedById = new Map(); // bleId -> BluetoothDevice
let connectedRecordId = null;
let busy = false;
let bluetoothGated = false;

const $ = (id) => document.getElementById(id);

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
  for (const b of document.querySelectorAll('#deviceList button')) b.disabled = busy;
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
    toast(`Storage unavailable: ${err.message ?? err}`, 'error');
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
    b.addEventListener('click', () =>
      withBusy(fn).catch((err) => toast(String(err.message ?? err), 'error')),
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
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

function infoPatch(info, bleId) {
  return {
    bleId,
    name: info.name,
    width: info.width,
    height: info.height,
    rotationQuarterTurns: info.rotationQuarterTurns,
    colorScheme: info.colorScheme,
    transmissionModes: info.transmissionModes,
    partialUpdateSupport: info.partialUpdateSupport,
    panelIcType: info.panelIcType,
    resolutionConfirmed: true,
    // authRequired clear rule (plan §4): a protected read succeeding without
    // auth proves the device is no longer locked.
    authRequired: info.authRequired,
    firmwareVersion: info.firmware,
    ...(info.msdHex ? { msdSnapshotHex: info.msdHex } : {}),
    lastSeen: Date.now(),
  };
}

/** Wire the key dialog as provider; returns () => pendingKeyToSave. Nothing is
 *  saved until the caller's protected read has succeeded. */
function armKeyDialog() {
  let pending = null;
  adapter.setKeyProvider(async ({ name }) => {
    const res = await askForKey({ name });
    if (!res) return null;
    pending = res.save ? res.key : null;
    return res.key;
  });
  return () => pending;
}

/** Add device: chooser → connect → read info (validation) → rebind proposal
 *  or new record → save key last. On any failure: disconnect + renew. */
async function addDevice() {
  toast('Choose a device in the browser dialog…');
  await adapter.connectViaChooser('OD');
  toast('Connected — reading device info…');
  const pendingKey = armKeyDialog();
  try {
    const info = await adapter.readDeviceInfo();
    const bleId = adapter.connectedBleId();

    const all = await store.listDevices();
    const existingByBinding = all.find((d) => d.bleId === bleId);
    if (existingByBinding) {
      await store.updateDevice(existingByBinding.recordId, infoPatch(info, bleId));
      if (pendingKey()) await keys.saveKey(existingByBinding.recordId, pendingKey());
      connectedRecordId = existingByBinding.recordId;
      toast(`Updated "${info.name}".`);
      return;
    }

    // Two-phase rebind: validation (auth + config) has already succeeded on
    // this physical device; the user's confirmation commits binding+metadata
    // in ONE transaction. Stored keys were never auto-tried.
    const candidates = all.filter(
      (d) =>
        (!d.bleId || !grantedById.has(d.bleId)) &&
        d.width === info.width &&
        d.height === info.height,
    );
    if (candidates.length > 0) {
      const chosen = await askRebind({ name: info.name, candidates });
      if (chosen) {
        await store.commitRebind(chosen, bleId, infoPatch(info, bleId));
        if (pendingKey()) await keys.saveKey(chosen, pendingKey());
        connectedRecordId = chosen;
        toast(`Rebound "${info.name}" to its saved record.`);
        return;
      }
    }

    const record = await store.createDevice({ ...infoPatch(info, bleId), bleId });
    if (pendingKey()) await keys.saveKey(record.recordId, pendingKey());
    connectedRecordId = record.recordId;
    toast(`Saved "${info.name}".`);
  } catch (err) {
    await adapter.disconnect().catch(() => {});
    throw err;
  } finally {
    adapter.setKeyProvider(null);
  }
}

/** Connect a saved record: cached handle when granted, else chooser re-pair.
 *  Any post-connect failure disconnects (which renews). */
async function connectRecord(record) {
  const handle = record.bleId ? grantedById.get(record.bleId) : null;
  if (!handle) {
    toast('Permission missing — pick the device in the chooser to re-pair.');
    await addDevice();
    return;
  }
  toast(`Connecting to "${record.name}"… (device must be awake and advertising)`);
  await adapter.connectCached(handle);
  const pendingKey = armKeyDialog();
  try {
    // Known, previously confirmed binding: the stored key may be tried
    // automatically; if it fails the adapter asks the dialog once.
    const storedKey = await keys.getKey(record.recordId);
    const info = await adapter.readDeviceInfo({ storedKey });
    await store.updateDevice(record.recordId, infoPatch(info, record.bleId));
    if (pendingKey()) await keys.saveKey(record.recordId, pendingKey());
    connectedRecordId = record.recordId;
    toast(`Connected to "${info.name}".`);
  } catch (err) {
    await adapter.disconnect().catch(() => {});
    throw err;
  } finally {
    adapter.setKeyProvider(null);
  }
}

async function forgetFlow(record) {
  if (!(await confirmDanger(`Forget "${record.name}"? Its saved key and drafts are deleted too.`))) return;
  if (record.recordId === connectedRecordId) {
    await adapter.disconnect().catch(() => {});
    connectedRecordId = null;
  }
  await store.forgetDevice(record.recordId);
  try {
    await grantedById.get(record.bleId)?.forget?.();
  } catch { /* permission revocation is best effort */ }
}

/** Export a key; exportedAt is set only after delivery is confirmed. */
async function exportKeyFlow(record) {
  const hex = await keys.exportKeyHex(record.recordId);
  let delivered = false;
  try {
    await navigator.clipboard.writeText(hex);
    delivered = true;
    toast('Key copied to clipboard. Store it somewhere safe — clearing site data deletes it.');
  } catch {
    // Clipboard unavailable/denied: show it for manual copy instead.
    window.prompt(`Encryption key for "${record.name}" — copy it now:`, hex);
    delivered = true;
    toast('Key shown for manual copy.');
  }
  if (delivered) await keys.markExported(record.recordId);
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
  const n = await store.importDevices(payload);
  toast(`Imported ${n} device record(s). Reconnect each to re-establish permissions.`);
}

// ---------------------------------------------------------------------------

export async function initDevices({ gated = false } = {}) {
  bluetoothGated = gated;

  adapter.setUnexpectedDisconnectListener(() => {
    connectedRecordId = null;
    toast('Device disconnected.');
    refresh();
  });

  $('btnAddDevice').addEventListener('click', () =>
    withBusy(addDevice).catch((err) => {
      if (/cancel|NotFoundError/i.test(String(err))) toast('Add device cancelled.');
      else toast(String(err.message ?? err), 'error');
    }),
  );
  $('btnExport').addEventListener('click', () =>
    withBusy(exportDeviceList).catch((err) => toast(String(err.message ?? err), 'error')),
  );
  $('importFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) withBusy(() => importDeviceList(file)).catch((err) => toast(String(err.message ?? err), 'error'));
  });

  await refresh();
}
