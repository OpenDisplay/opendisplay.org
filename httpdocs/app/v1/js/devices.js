/*
 * devices.js — device-list controller (DESIGN_WEB_OD_APP_PLAN.md §5).
 * Flows: startup permission sweep, add via chooser (with two-phase rebind),
 * cached reconnect, refresh-on-connect, forget, export/import.
 */
import * as adapter from './ble-adapter.js';
import * as store from './store.js';
import * as keys from './keys.js';
import { askForKey, askRebind, confirmDanger, toast } from './ui/dialogs.js';

let grantedById = new Map(); // bleId -> BluetoothDevice
let connectedRecordId = null;

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

  const btn = (label, fn, { primary = false } = {}) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `odapp__btn${primary ? ' odapp__btn--primary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => fn().catch((err) => toast(String(err.message ?? err), 'error')));
    actions.appendChild(b);
    return b;
  };

  if (record.recordId === connectedRecordId) {
    btn('Disconnect', async () => {
      await adapter.disconnect();
      connectedRecordId = null;
      await refresh();
    }, { primary: true });
  } else {
    btn('Connect', () => connectRecord(record), { primary: true });
  }
  keys.getKey(record.recordId).then((k) => {
    if (k) {
      btn('Export key', async () => {
        const hex = await keys.exportKey(record.recordId);
        await navigator.clipboard?.writeText?.(hex);
        toast('Key copied to clipboard. Store it somewhere safe — clearing site data deletes it.');
      });
    }
  }).catch(() => {});
  btn('Forget', async () => {
    if (!(await confirmDanger(`Forget "${record.name}"? Its saved key and drafts are deleted too.`))) return;
    if (record.recordId === connectedRecordId) {
      await adapter.disconnect();
      connectedRecordId = null;
    }
    await store.forgetDevice(record.recordId);
    try {
      grantedById.get(record.bleId)?.forget?.();
    } catch { /* best effort */ }
    await refresh();
  });

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

/** Add device: chooser → connect → read info (app-owned key dialog) →
 *  two-phase rebind proposal or new record. */
async function addDevice() {
  toast('Choose a device in the browser dialog…');
  await adapter.connectViaChooser('OD');
  toast('Connected — reading device info…');

  let pendingSave = null;
  adapter.setKeyProvider(async ({ name }) => {
    const res = await askForKey({ name });
    if (!res) return null;
    pendingSave = res.save ? res.key : null;
    return res.key;
  });

  try {
    const info = await adapter.readDeviceInfo();
    const bleId = adapter.connectedBleId();

    // Already bound to a record? Just refresh that record.
    const existingByBinding = (await store.listDevices()).find((d) => d.bleId === bleId);
    if (existingByBinding) {
      await updateRecordFromInfo(existingByBinding.recordId, info, bleId, pendingSave);
      connectedRecordId = existingByBinding.recordId;
      toast(`Updated "${info.name}".`);
      return;
    }

    // Two-phase rebind: validation (auth + config read) has already succeeded
    // on this physical device; propose matching permission-less records, and
    // only a user confirmation commits the new binding.
    const candidates = (await store.listDevices()).filter(
      (d) =>
        (!d.bleId || !grantedById.has(d.bleId)) &&
        d.width === info.width &&
        d.height === info.height,
    );
    if (candidates.length > 0) {
      const chosen = await askRebind({ name: info.name, candidates });
      if (chosen) {
        await store.commitRebind(chosen, bleId);
        await updateRecordFromInfo(chosen, info, bleId, pendingSave);
        connectedRecordId = chosen;
        toast(`Rebound "${info.name}" to its saved record.`);
        return;
      }
    }

    const record = await store.createDevice({
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
      authRequired: info.authRequired,
      firmwareVersion: info.firmware,
      msdSnapshotHex: info.msdHex,
    });
    if (pendingSave) await keys.saveKey(record.recordId, pendingSave);
    connectedRecordId = record.recordId;
    toast(`Saved "${info.name}".`);
  } catch (err) {
    await adapter.disconnect();
    throw err;
  } finally {
    adapter.setKeyProvider(null);
    await refresh();
  }
}

async function updateRecordFromInfo(recordId, info, bleId, pendingSaveKey) {
  await store.updateDevice(recordId, {
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
    msdSnapshotHex: info.msdHex ?? undefined,
    lastSeen: Date.now(),
  });
  if (pendingSaveKey) await keys.saveKey(recordId, pendingSaveKey);
}

/** Connect a saved record: cached handle when granted, else chooser re-pair. */
async function connectRecord(record) {
  const handle = record.bleId ? grantedById.get(record.bleId) : null;
  adapter.setKeyProvider(async ({ name }) => {
    const res = await askForKey({ name });
    if (!res) return null;
    if (res.save) await keys.saveKey(record.recordId, res.key);
    return res.key;
  });
  try {
    if (handle) {
      toast(`Connecting to "${record.name}"… (device must be awake and advertising)`);
      await adapter.connectCached(handle);
      // Known binding: the stored key may be used automatically.
      const storedKey = await keys.getKey(record.recordId);
      const info = await adapter.readDeviceInfo({ storedKey });
      await updateRecordFromInfo(record.recordId, info, record.bleId, null);
      if (info.authKeyFromProvider && info.authKey) {
        /* provider already saved when user opted in */
      }
      connectedRecordId = record.recordId;
      toast(`Connected to "${info.name}".`);
    } else {
      // Permission missing: re-pair via the chooser (addDevice offers rebind).
      toast('Permission missing — pick the device in the chooser to re-pair.');
      await addDevice();
    }
  } finally {
    adapter.setKeyProvider(null);
    await refresh();
  }
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
  await refresh();
}

// ---------------------------------------------------------------------------

export async function initDevices() {
  adapter.setUnexpectedDisconnectListener(() => {
    connectedRecordId = null;
    toast('Device disconnected.');
    refresh();
  });

  $('btnAddDevice').addEventListener('click', () =>
    addDevice().catch((err) => {
      if (/cancel|NotFoundError/i.test(String(err))) toast('Add device cancelled.');
      else toast(String(err.message ?? err), 'error');
    }),
  );
  $('btnExport').addEventListener('click', () =>
    exportDeviceList().catch((err) => toast(String(err.message ?? err), 'error')),
  );
  $('importFile').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) importDeviceList(file).catch((err) => toast(String(err.message ?? err), 'error'));
  });

  await refresh();
}
