/*
 * keys.js — per-device PSK policy (DESIGN_WEB_OD_APP_PLAN.md §4/§7).
 * Entry and import ONLY — no generation (provisioning is Toolbox territory).
 * Keys never appear in URLs; export is a separate deliberate action tracked
 * via exportedAt (backs the un-exported-key nag).
 */
import { getKeyRecord, putKeyRecord, deleteKeyRecord } from './store.js';

export function parseHexKey(input) {
  const hex = String(input ?? '').replace(/[^0-9A-Fa-f]/g, '');
  if (hex.length !== 32) {
    throw new Error('Encryption key must be exactly 32 hex characters (16 bytes)');
  }
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return key;
}

export function keyToHex(key) {
  return Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getKey(recordId) {
  const rec = await getKeyRecord(recordId);
  return rec ? new Uint8Array(rec.psk) : null;
}

export async function hasUnexportedKey(recordId) {
  const rec = await getKeyRecord(recordId);
  return !!rec && !rec.exportedAt;
}

export async function saveKey(recordId, key) {
  if (!(key instanceof Uint8Array) || key.length !== 16) {
    throw new Error('key must be 16 bytes');
  }
  const existing = await getKeyRecord(recordId);
  await putKeyRecord({
    recordId,
    psk: key.buffer.slice(key.byteOffset, key.byteOffset + 16),
    exportedAt: existing?.exportedAt ?? null,
    updatedAt: Date.now(),
  });
}

export async function deleteKey(recordId) {
  await deleteKeyRecord(recordId);
}

/** Export one key as text (hex) and mark it exported. */
export async function exportKey(recordId) {
  const key = await getKey(recordId);
  if (!key) throw new Error('no key stored for this device');
  const rec = await getKeyRecord(recordId);
  await putKeyRecord({ ...rec, exportedAt: Date.now() });
  return keyToHex(key);
}
