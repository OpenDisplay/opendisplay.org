/*
 * flows.js — device-list controller flows with injected dependencies
 * (DESIGN_WEB_OD_APP_PLAN.md §5). devices.js supplies the real adapter/store/
 * keys/ui; tests supply mocks — the full selection → stored-key → validation →
 * commit sequence and every rollback branch run headlessly.
 *
 * Key-safety rules encoded here:
 *  - dialog-entered keys are saved ONLY after the protected read succeeds;
 *  - a saved record's stored key is auto-tried only when the USER selected
 *    that record first (card click on the repair path, confirmed binding on
 *    the cached path) — never guessed from name/resolution matching;
 *  - nothing is written to the store until validation has succeeded, and the
 *    rebind commit (binding + metadata) is one transaction.
 */

export function infoPatch(info, bleId) {
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

export function makeFlows({ adapter, store, keys, ui }) {
  /** Key dialog as provider; returns getter for the to-save key. Nothing is
   *  saved until the caller's protected read has succeeded. */
  function armKeyDialog() {
    let pending = null;
    adapter.setKeyProvider(async ({ name }) => {
      const res = await ui.askForKey({ name });
      if (!res) return null;
      pending = res.save ? res.key : null;
      return res.key;
    });
    return () => pending;
  }

  /** Add device (generic, unknown hardware): chooser → connect → validate →
   *  rebind proposal (validated metadata shown; candidate keys NEVER tried) or
   *  new record → save dialog key last. Any failure: disconnect (renews). */
  async function addDeviceFlow(grantedById) {
    ui.toast('Choose a device in the browser dialog…');
    await adapter.connectViaChooser('OD');
    ui.toast('Connected — reading device info…');
    const pendingKey = armKeyDialog();
    try {
      const info = await adapter.readDeviceInfo();
      const bleId = adapter.connectedBleId();

      const all = await store.listDevices();
      const existingByBinding = all.find((d) => d.bleId === bleId);
      if (existingByBinding) {
        await store.updateDevice(existingByBinding.recordId, infoPatch(info, bleId));
        if (pendingKey()) await keys.saveKey(existingByBinding.recordId, pendingKey());
        ui.toast(`Updated "${info.name}".`);
        return existingByBinding.recordId;
      }

      const candidates = all.filter(
        (d) =>
          (!d.bleId || !grantedById.has(d.bleId)) &&
          d.width === info.width &&
          d.height === info.height,
      );
      if (candidates.length > 0) {
        const chosen = await ui.askRebind({ name: info.name, info, candidates });
        if (chosen) {
          await store.commitRebind(chosen, bleId, infoPatch(info, bleId));
          if (pendingKey()) await keys.saveKey(chosen, pendingKey());
          ui.toast(`Rebound "${info.name}" to its saved record.`);
          return chosen;
        }
      }

      const record = await store.createDevice({ ...infoPatch(info, bleId), bleId });
      if (pendingKey()) await keys.saveKey(record.recordId, pendingKey());
      ui.toast(`Saved "${info.name}".`);
      return record.recordId;
    } catch (err) {
      await adapter.disconnect().catch(() => {});
      throw err;
    } finally {
      adapter.setKeyProvider(null);
    }
  }

  /** Repair a specific record whose permission is gone (plan §4 sequence):
   *  the user's card click IS the record selection, so its stored key may be
   *  tried; validation runs before the one-transaction commit; a metadata
   *  mismatch is surfaced with the validated identity before committing. */
  async function repairRecordFlow(record) {
    ui.toast(`Pick "${record.name}" in the chooser to re-pair it…`);
    await adapter.connectViaChooser('OD');
    const pendingKey = armKeyDialog();
    try {
      const storedKey = await keys.getKey(record.recordId);
      const info = await adapter.readDeviceInfo({ storedKey });
      const bleId = adapter.connectedBleId();

      if (info.width !== record.width || info.height !== record.height) {
        const proceed = await ui.confirmMismatch({ record, info });
        if (!proceed) {
          throw new Error(
            `Re-pair cancelled: "${info.name}" is ${info.width}×${info.height}, ` +
            `saved record expects ${record.width}×${record.height}`,
          );
        }
      }

      await store.commitRebind(record.recordId, bleId, infoPatch(info, bleId));
      if (pendingKey()) await keys.saveKey(record.recordId, pendingKey());
      ui.toast(`Re-paired "${info.name}".`);
      return record.recordId;
    } catch (err) {
      await adapter.disconnect().catch(() => {});
      throw err;
    } finally {
      adapter.setKeyProvider(null);
    }
  }

  /** Connect a saved record via its granted handle (confirmed binding: the
   *  stored key may be auto-tried). Post-connect failures disconnect. */
  async function connectRecordFlow(record, grantedById) {
    const handle = record.bleId ? grantedById.get(record.bleId) : null;
    if (!handle) return repairRecordFlow(record);

    ui.toast(`Connecting to "${record.name}"… (device must be awake and advertising)`);
    await adapter.connectCached(handle);
    const pendingKey = armKeyDialog();
    try {
      const storedKey = await keys.getKey(record.recordId);
      const info = await adapter.readDeviceInfo({ storedKey });
      await store.updateDevice(record.recordId, infoPatch(info, record.bleId));
      if (pendingKey()) await keys.saveKey(record.recordId, pendingKey());
      ui.toast(`Connected to "${info.name}".`);
      return record.recordId;
    } catch (err) {
      await adapter.disconnect().catch(() => {});
      throw err;
    } finally {
      adapter.setKeyProvider(null);
    }
  }

  /** Export a key; exportedAt is set only after CONFIRMED delivery. */
  async function exportKeyFlow(record) {
    const hex = await keys.exportKeyHex(record.recordId);
    const delivered = await ui.deliverKeyHex({ name: record.name, hex });
    if (delivered) {
      await keys.markExported(record.recordId);
      ui.toast('Key backed up. Clearing site data still deletes the stored copy.');
    } else {
      ui.toast('Key export cancelled — it is still not backed up.', 'error');
    }
    return delivered;
  }

  return { addDeviceFlow, connectRecordFlow, repairRecordFlow, exportKeyFlow };
}
