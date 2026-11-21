/*
 * ble-adapter.js — the ONLY module that touches the shared OpenDisplayBLE
 * instance (DESIGN_WEB_OD_APP_PLAN.md §3). ble-common.js is never modified;
 * this adapter confines every library interaction, timeout, and lifecycle rule.
 *
 * Invariants (established M0, extended M1):
 *  - the instance is resolved per operation, never captured;
 *  - every fresh instance awaits its own schema readiness before use;
 *  - one connect/op in flight (serialized state machine);
 *  - every completed disconnect — explicit or unexpected — renews the
 *    instance, so no per-connection state (encryptionSession, partialState)
 *    can leak between devices;
 *  - every device-facing promise carries a deadline; on expiry the adapter
 *    disconnects (the library's own teardown clears in-flight state safely).
 */

const SCHEMA_PATH = '/firmware/toolbox/config.yaml';
const DISPLAY_PACKET_ID = 0x20;

export const DEADLINES = {
  connect: 25000,
  auth: 12000,
  firmware: 8000,
  config: 15000,
  // Upload is bounded by a STALL, not a total: as long as chunk acks keep
  // arriving the link is alive, and a big panel on a poor MTU is slow rather
  // than broken. A flat total also had to cover the encode, a possible
  // PIPE->legacy fallback (which re-sends every byte inside the same call) and
  // the refresh, so it punished exactly the transfers least able to afford it.
  sendStall: 45000,
  // Once the data phase is done the library waits for refresh-complete (0x73),
  // which it does not bound at all — the firmware's own 0x74 refresh timeout
  // does. A large slow panel can take tens of seconds, so this phase gets its
  // own budget rather than whatever the transfer left over.
  refresh: 180000,
};

/** Colour schemes this app will send. Scheme 7 is deliberately absent: the
 *  shared encoder FAILS OPEN on unknown schemes (proven in the M-S(a) spike —
 *  it silently emits monochrome), so it must be rejected here, before the
 *  encoder ever sees it. */
export const SUPPORTED_COLOR_SCHEMES = new Set([0, 1, 2, 3, 4, 5, 6, 8]);

// Fields readDeviceInfo() consumes from the display packet (0x20); readiness
// means every one of them has a resolvable offset — not merely "some schema
// loaded". Names are the config.yaml source of truth.
const REQUIRED_DISPLAY_FIELDS = [
  'pixel_width',
  'pixel_height',
  'rotation',
  'color_scheme',
  'transmission_modes',
  'partial_update_support',
  'panel_ic_type',
];

export class AuthRequiredError extends Error {
  constructor(msg = 'Device is locked and no key is available') {
    super(msg);
    this.name = 'AuthRequiredError';
  }
}

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

// Never capture the instance — resolve it at each operation's start so a
// discarded instance can't be used after a bridge renew.
function instance() {
  const inst = globalThis.odAppBle;
  if (!inst) throw new Error('OD App bridge not initialised (boot-bridge.js missing?)');
  return inst;
}

// ---------------------------------------------------------------------------
// Schema readiness (instance-scoped)
// ---------------------------------------------------------------------------

const readiness = new WeakMap();

async function initInstance(inst) {
  await inst.loadYAMLConfig(SCHEMA_PATH);
  const schema = inst.packetSchema;
  const size = inst.packetSizes?.[DISPLAY_PACKET_ID];
  const offsets = inst.packetFieldOffsets?.[DISPLAY_PACKET_ID];
  const missing = REQUIRED_DISPLAY_FIELDS.filter((f) => typeof offsets?.[f] !== 'number');
  if (!schema || !schema[DISPLAY_PACKET_ID] || !size || missing.length > 0) {
    throw new Error(
      'Packet schema failed to load or lacks required display fields ' +
      `(${missing.join(', ') || 'packet 0x20 absent'}) — cannot talk to devices. (${SCHEMA_PATH})`,
    );
  }
  return inst;
}

export function ready() {
  const inst = instance();
  let p = readiness.get(inst);
  if (!p) {
    p = initInstance(inst).catch((err) => {
      readiness.delete(inst); // a failed load must not be cached as permanent
      throw err;
    });
    readiness.set(inst, p);
  }
  return p;
}

// Generation token: bumped SYNCHRONOUSLY on every renewal. Any async path that
// captured work before an await validates the generation afterwards, so a late
// completion can never act on (or report success for) a discarded instance.
let generation = 0;

export function currentGeneration() {
  return generation;
}

class StaleInstanceError extends Error {
  constructor() {
    super('Connection was torn down while the operation was in flight');
    this.name = 'StaleInstanceError';
  }
}

export async function renew() {
  generation++;
  globalThis.odAppBridge.renew();
  return ready();
}

export function webBluetoothBlockReason() {
  const helper = globalThis.OpenDisplayBrowser;
  if (!helper) return 'unsupported';
  return helper.getWebBluetoothBlockReason();
}

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------

let state = 'idle'; // idle | connecting | connected | disconnecting
// Lease token: every state RESERVATION takes a new lease; only the current
// leaseholder may mutate state afterwards. This stops a stale connect's
// catch/finally from clobbering a newer connect's state (generation alone
// invalidates results, but not state ownership).
let stateLease = 0;
let opInFlight = false;
/** Generation that took `opInFlight`; a lock from an older one is not binding. */
let opGeneration = -1;
let adapterInitiatedDisconnect = false;
let keyProvider = null; // async ({name, reason}) => Uint8Array(16) | null
let unexpectedDisconnectListener = null;

export function getState() {
  return state;
}

/** UI supplies the key dialog; the library's prompt() path is never engaged. */
export function setKeyProvider(fn) {
  keyProvider = fn;
}

export function setUnexpectedDisconnectListener(fn) {
  unexpectedDisconnectListener = fn;
}

/**
 * A deadline that only tears down a connection it STILL OWNS.
 *
 * The ownership check is the important part. An operation can be abandoned
 * without its promise ever settling — disconnect() swallows GATT teardown
 * races and renews the instance regardless, so a library upload whose abort
 * path never ran leaves a promise nobody will settle. Its timer kept burning,
 * and minutes later fired forceDisconnect() on whatever connection existed by
 * then: a later, healthy upload would complete on the panel and be reported as
 * a timeout, because a fuse from a previous one had cut the link. Capturing
 * the generation and lease makes a stale fuse inert.
 *
 * The clock is also restartable, because a transfer that is making progress is
 * not stalled however long it takes.
 */
function makeDeadline(label, ms) {
  const gen = generation;
  const lease = stateLease;
  let settled = false;
  let timer = null;
  let budget = ms;
  let rejectExpired;
  const expired = new Promise((_, reject) => { rejectExpired = reject; });
  // Nobody consumes `expired` until race() is called; without this a rejection
  // in that window would surface as an unhandledrejection.
  expired.catch(() => {});

  const fire = () => {
    if (settled) return;
    settled = true;
    // Reject FIRST so a result racing the teardown can never win, then tear
    // down in the background — but ONLY if this deadline is still the one
    // governing the live connection.
    rejectExpired(new TimeoutError(label, budget));
    if (generation === gen && stateLease === lease) forceDisconnect().catch(() => {});
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(fire, budget);
  };
  arm();

  return {
    /** Progress: the link is alive, so restart the clock. */
    bump() { if (!settled) arm(); },
    /** Move to a different phase, with its own budget. */
    rebudget(next) { if (!settled) { budget = next; arm(); } },
    stop() { settled = true; clearTimeout(timer); },
    race(promise) {
      return Promise.race([promise, expired]).finally(() => { this.stop(); });
    },
  };
}

function withDeadline(promise, ms, label) {
  const dl = makeDeadline(label, ms);
  return dl.race(promise);
}

async function withOp(fn) {
  // A lock held from an EARLIER generation belongs to an operation that can no
  // longer affect this connection: the instance it was talking to has been
  // discarded. It may never settle — disconnect() swallows GATT teardown races
  // and renews regardless, so a library upload whose abort path never ran
  // leaves a promise nobody will settle — and holding the lock for it wedges
  // the adapter permanently, refusing every later operation.
  if (opInFlight && opGeneration === generation) {
    throw new Error('Another operation is in progress');
  }
  opInFlight = true;
  opGeneration = generation;
  const gen = generation;
  try {
    const result = await fn();
    if (generation !== gen) throw new StaleInstanceError();
    return result;
  } finally {
    // Only release a lock we still hold: a newer operation may have taken it
    // after a generation bump, and this one must not free it underneath.
    if (opGeneration === gen) opInFlight = false;
  }
}

function wireDisconnectHandler(inst) {
  inst.onDisconnect = async () => {
    if (adapterInitiatedDisconnect) return; // explicit path handles renewal
    const lease = ++stateLease; // take ownership: in-flight attempts may no longer mutate state
    state = 'idle';
    // Renew and AWAIT readiness before notifying, so any listener-triggered
    // operation lands on a fresh, schema-ready instance.
    try {
      await renew();
    } catch { /* surfaced on the listener's next operation */ }
    // If something newer (a fresh connect, another teardown) took the lease
    // while we renewed, its flow owns the narrative — stay silent.
    if (stateLease === lease) unexpectedDisconnectListener?.();
  };
}

async function connectWith(connectFn) {
  // Reserve the state SYNCHRONOUSLY, before any await: two concurrent
  // connects must never both pass the idle check.
  if (state !== 'idle') throw new Error(`Cannot connect while ${state}`);
  state = 'connecting';
  const lease = ++stateLease;
  const gen = generation;
  try {
    await ready();
    if (generation !== gen) throw new StaleInstanceError();
    const inst = instance();
    wireDisconnectHandler(inst);
    await withDeadline(connectFn(inst), DEADLINES.connect, 'Connect');
    // A disconnect/renew that happened mid-connect invalidates this success.
    if (generation !== gen || stateLease !== lease) throw new StaleInstanceError();
    state = 'connected';
  } catch (err) {
    // Only the current leaseholder may mutate state: a STALE connect failing
    // late must not reset a newer attempt's 'connecting'/'connected'.
    if (stateLease === lease && state === 'connecting') state = 'idle';
    // A failed connect may leave partial per-connection state: renew (unless
    // something else — timeout teardown, unexpected disconnect — already did).
    if (stateLease === lease && generation === gen) await renew().catch(() => {});
    throw err;
  }
}

/** Connect via the browser chooser (Add device flow). */
export async function connectViaChooser(namePrefix = 'OD') {
  await connectWith((inst) => inst.connect(namePrefix, {}));
}

/**
 * Connect to a previously granted BluetoothDevice handle (getDevices()).
 * Attaching while connected is rejected: the library's cached device,
 * connection flag, and characteristic must never belong to different devices.
 * NOTE: assigning inst.device is the one documented library-internal touch
 * point (plan §3); covered by integration tests, degrades to chooser-per-
 * connect if an upstream change breaks it.
 */
export async function connectCached(bluetoothDevice) {
  await connectWith((inst) => {
    inst.device = bluetoothDevice;
    return inst.connect(null, { useCachedDevice: true });
  });
}

/** Explicit disconnect: always renews the instance (per-connection isolation).
 *  Concurrent callers COALESCE onto one teardown — an older, slower disconnect
 *  must never reset state after a newer attempt has taken the lease. */
let disconnectPromise = null;

export async function disconnect() {
  if (state === 'idle') return;
  if (disconnectPromise) return disconnectPromise;
  const lease = ++stateLease; // take ownership synchronously
  state = 'disconnecting';
  adapterInitiatedDisconnect = true;
  disconnectPromise = (async () => {
    try {
      await instance().disconnect();
    } catch {
      /* GATT teardown races are fine — the instance is discarded next */
    } finally {
      adapterInitiatedDisconnect = false;
      disconnectPromise = null;
      // Only the leaseholder finishes the transition; if something newer took
      // over meanwhile, leave its state alone.
      if (stateLease === lease) {
        state = 'idle';
        await renew().catch(() => {});
      }
    }
  })();
  return disconnectPromise;
}

async function forceDisconnect() {
  await disconnect();
}

// ---------------------------------------------------------------------------
// Device operations
// ---------------------------------------------------------------------------

function readConfigOnce(inst) {
  return new Promise((resolve, reject) => {
    inst.readConfig((configBytes, err) => {
      if (err) reject(err);
      else resolve(configBytes);
    }).catch(reject);
  });
}

function readFirmwareOnce(inst) {
  return new Promise((resolve, reject) => {
    inst.readFirmwareVersion((version, err) => {
      if (err) reject(err);
      else resolve(version);
    }).catch(reject);
  });
}

function isAuthRequired(err) {
  return /authentication required/i.test(String(err?.message ?? err));
}

/**
 * App-owned auth: stored key first; if it fails (or none exists), exactly ONE
 * ask via the key provider — the dialog itself may loop UI-side. Rate-limit
 * errors surface immediately without burning the provider ask. Returns the
 * key that authenticated (the CALLER saves it, and only after the protected
 * replay proves it works end-to-end).
 */
async function authenticateWith(inst, { storedKey, name, assertLive = () => {} }) {
  const tryKey = async (key) => {
    assertLive(); // a disconnect during the dialog must not reach the radio
    await inst.setEncryptionKey(key);
    assertLive(); // ...nor may authenticate() fire after a mid-step teardown
    await withDeadline(inst.authenticate(), DEADLINES.auth, 'Authentication');
  };

  if (storedKey) {
    try {
      await tryKey(storedKey);
      return { key: storedKey, fromProvider: false };
    } catch (err) {
      if (err instanceof StaleInstanceError) throw err;
      if (/rate limit/i.test(String(err?.message))) throw err;
      // The auth may have "failed" because the CONNECTION died — check before
      // concluding the key was wrong and bothering the user for another.
      assertLive();
      // Stored key rejected (rotated on the device?) — fall through to one ask.
    }
  }
  if (!keyProvider) throw new AuthRequiredError();
  assertLive(); // never open the key dialog for a dead session
  const key = await keyProvider({ name, reason: storedKey ? 'stored-key-failed' : 'locked' });
  if (!key) throw new AuthRequiredError('Key entry cancelled');
  await tryKey(key);
  return { key, fromProvider: true };
}

/**
 * Read firmware + MSD + config; parse the display packet. On 0xFE the auth
 * flow runs and the protected read replays ONCE (plan §3 wrap-and-replay).
 *
 * Returns {width, height, rotationQuarterTurns, colorScheme,
 * transmissionModes, partialUpdateSupport, panelIcType, firmware, msdHex,
 * name, authRequired, authKey?, authKeyFromProvider?}.
 */
export async function readDeviceInfo({ storedKey = null } = {}) {
  if (state !== 'connected') throw new Error('Not connected');
  return withOp(async () => {
    const gen = generation;
    // Checked between EVERY awaited step: after a disconnect/renew, no further
    // BLE call (auth prompt included) may be issued against the old instance —
    // stopping mid-operation, not merely invalidating the final result.
    const assertLive = () => {
      if (generation !== gen || state !== 'connected') throw new StaleInstanceError();
    };
    const inst = instance();
    const name = inst.device?.name ?? 'OpenDisplay';

    // 0x43 is never encrypted — safe before auth.
    const firmware = await withDeadline(readFirmwareOnce(inst), DEADLINES.firmware, 'Firmware read');
    assertLive();

    let authRequired = false;
    let authKey = null;
    let authKeyFromProvider = false;

    let configBytes;
    try {
      configBytes = await withDeadline(readConfigOnce(inst), DEADLINES.config, 'Config read');
    } catch (err) {
      if (!isAuthRequired(err)) throw err;
      assertLive();
      authRequired = true;
      const auth = await authenticateWith(inst, { storedKey, name, assertLive });
      assertLive();
      authKey = auth.key;
      authKeyFromProvider = auth.fromProvider;
      configBytes = await withDeadline(readConfigOnce(inst), DEADLINES.config, 'Config read (after auth)');
    }
    assertLive();

    const parsed = inst.parseConfigBytes(new Uint8Array(configBytes));
    const display = inst.extractDisplayConfig(parsed);
    if (!display || !display.pixelWidth || !display.pixelHeight) {
      throw new Error('Device config has no usable display packet');
    }

    // readMsd carries its own 8 s timeout in the library.
    let msdHex = null;
    try {
      const msd = await inst.readMsd();
      assertLive();
      msdHex = Array.from(msd, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      if (err instanceof StaleInstanceError) throw err;
      /* optional telemetry — absence is fine */
    }

    return {
      name,
      width: display.pixelWidth,
      height: display.pixelHeight,
      rotationQuarterTurns: display.rotation & 0x03,
      colorScheme: display.colorScheme,
      transmissionModes: display.transmissionModes,
      partialUpdateSupport: display.partialUpdateSupport,
      panelIcType: display.panelIcType,
      firmware: firmware
        ? `${firmware.major}.${firmware.minor}${firmware.patch != null ? `.${firmware.patch}` : ''}`
        : null,
      msdHex,
      authRequired,
      authKey,
      authKeyFromProvider,
    };
  });
}

/**
 * Send a canvas to the connected panel.
 *
 * The canvas MUST already hold exact ideal-palette pixels (the composer's
 * paint-back); the shared library classifies by nearest colour, which is only
 * lossless for canonical values.
 *
 * Rotation is passed as the WIRE quarter-turn value together with the panel's
 * native dimensions, exactly as the Display Tool does.
 *
 * TWO-PHASE COMPLETION, as the shared library actually reports it (verified in
 * ble-common.js, not assumed): `onComplete` settles only after the panel's
 * REFRESH-complete frame (0x73) — seconds to tens of seconds after the bytes
 * land — while the transfer→refresh transition is announced through
 * `onStatusChange`. So this promise resolves when the PANEL HAS REFRESHED, and
 * `onTransferComplete` fires earlier, at the end of the data phase.
 * (`onCommandAck` is not usable for this: the library invokes it only for
 * command 0x63 and passes no arguments.)
 *
 * @returns {Promise<{skipped: boolean, refreshed: boolean}>} `skipped` is true
 *   when the library found no pixel changes and sent nothing at all.
 */
export async function sendCanvas(canvas, colorScheme, {
  rotationQuarterTurns = 0,
  originalWidth,
  originalHeight,
  transmissionModes = null,
  partialUpdateSupport = 0,
  panelIcType = null,
  onProgress = null,
  onTransferComplete = null,
} = {}) {
  if (state !== 'connected') throw new Error('Not connected');
  if (!SUPPORTED_COLOR_SCHEMES.has(colorScheme)) {
    throw new Error(
      `colour scheme ${colorScheme} is not supported by this app — refusing to send ` +
      '(the shared encoder would silently emit monochrome)',
    );
  }
  // The canvas must match the panel it claims to be for: a rotated frame is
  // authored in swapped dimensions.
  const swap = rotationQuarterTurns === 1 || rotationQuarterTurns === 3;
  const expectW = swap ? originalHeight : originalWidth;
  const expectH = swap ? originalWidth : originalHeight;
  if (canvas.width !== expectW || canvas.height !== expectH) {
    throw new Error(
      `canvas ${canvas.width}x${canvas.height} does not match panel ` +
      `${originalWidth}x${originalHeight} at rotation ${rotationQuarterTurns} ` +
      `(expected ${expectW}x${expectH})`,
    );
  }
  return withOp(async () => {
    const gen = generation;
    const inst = instance();
    let transferAnnounced = false;
    // The library can finish WITHOUT sending anything: a mono partial update
    // whose region is unchanged reports "No pixel changes — upload skipped"
    // and calls onComplete(true) immediately. Claiming "the panel refreshed"
    // there would be a lie.
    let skipped = false;
    const deadline = makeDeadline('Image upload', DEADLINES.sendStall);
    const done = new Promise((resolve, reject) => {
      inst.sendCanvasToDisplay(canvas, colorScheme, {
        rotation: rotationQuarterTurns,
        originalWidth,
        originalHeight,
        transmissionModes,
        partialUpdateSupport,
        panelIcType,
        onProgress: (sent, total) => {
          if (generation !== gen) return;
          // Acks are still flowing, so the transfer is slow, not stalled.
          deadline.bump();
          onProgress?.(sent, total);
        },
        onStatusChange: (message) => {
          if (generation !== gen) return;
          const text = String(message);
          if (/upload skipped/i.test(text)) {
            skipped = true;
            return;
          }
          // The library says "Upload complete (Ns), refreshing display..." at
          // the data-phase boundary; that is the only public signal for it.
          if (!transferAnnounced && /refreshing display/i.test(text)) {
            transferAnnounced = true;
            // The bytes are on the device; what remains is the panel refresh,
            // which the library does not bound. Give it its own budget.
            deadline.rebudget(DEADLINES.refresh);
            onTransferComplete?.();
          }
        },
        onComplete: (ok, err) => {
          if (ok) resolve();
          else reject(err ?? new Error('Upload failed'));
        },
      }).catch(reject);
    });
    await deadline.race(done);
    if (generation !== gen) throw new StaleInstanceError();
    return skipped ? { skipped: true, refreshed: false } : { skipped: false, refreshed: true };
  });
}

/** Current connected device's BluetoothDevice.id (binding), or null. */
export function connectedBleId() {
  if (state !== 'connected') return null;
  return instance().device?.id ?? null;
}

export function connectedDeviceName() {
  if (state !== 'connected') return null;
  return instance().device?.name ?? null;
}
