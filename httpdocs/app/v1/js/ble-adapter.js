/*
 * ble-adapter.js — the ONLY module that touches the shared OpenDisplayBLE
 * instance (DESIGN_WEB_OD_APP_PLAN.md §3). ble-common.js is never modified;
 * this adapter confines every library interaction, timeout, and lifecycle rule.
 *
 * M0 scope: instance access, instance-scoped schema readiness, renewal.
 * Connect/auth/read/send arrive with M1.
 */

const SCHEMA_PATH = '/firmware/toolbox/config.yaml';
const DISPLAY_PACKET_ID = 0x20;

// Never capture the instance — resolve it at each operation's start so a
// discarded instance can't be used after a bridge renew (plan §3 watch item).
function instance() {
  const inst = globalThis.odAppBle;
  if (!inst) throw new Error('OD App bridge not initialised (boot-bridge.js missing?)');
  return inst;
}

// Instance-scoped readiness: schema state (packetSchema/packetSizes) lives on
// each OpenDisplayBLE instance, so EVERY fresh instance must await its own
// loadYAMLConfig before attach/connect/read are allowed. The library's own
// deferred setTimeout load only logs failures and must not be relied on.
const readiness = new WeakMap();

async function initInstance(inst) {
  // loadYAMLConfig swallows errors internally (logs only), so readiness is
  // judged by validating the resulting state, not by the call resolving.
  await inst.loadYAMLConfig(SCHEMA_PATH);
  const schema = inst.packetSchema;
  const sizes = inst.packetSizes || {};
  if (!schema || !schema[DISPLAY_PACKET_ID] || Object.keys(sizes).length === 0) {
    throw new Error(
      'Packet schema failed to load or lacks the display packet — cannot talk to devices. ' +
      `(${SCHEMA_PATH})`,
    );
  }
  return inst;
}

/** Await schema readiness for the CURRENT instance. Safe to call repeatedly. */
export function ready() {
  const inst = instance();
  let p = readiness.get(inst);
  if (!p) {
    p = initInstance(inst).catch((err) => {
      // A failed load must not be cached as permanent: allow retry.
      readiness.delete(inst);
      throw err;
    });
    readiness.set(inst, p);
  }
  return p;
}

/**
 * Discard the current instance and create a fresh, schema-ready one.
 * Called by the adapter after every completed disconnect (per-connection
 * isolation, plan §3). Resolves only when the new instance is ready.
 */
export async function renew() {
  globalThis.odAppBridge.renew();
  return ready();
}

/** Browser capability gate — thin pass-through to the shared helper. */
export function webBluetoothBlockReason() {
  const helper = globalThis.OpenDisplayBrowser;
  if (!helper) return 'unsupported';
  return helper.getWebBluetoothBlockReason();
}
