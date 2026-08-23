/*
 * OD App classic-script bridge (DESIGN_WEB_OD_APP_PLAN.md §2/§3).
 *
 * OpenDisplayBLE is a top-level class in the classic ble-common.js script, not
 * a window export. This bridge is the ONLY code that constructs it, publishing
 * exactly one global: `globalThis.odAppBle`. The name is stable; the instance
 * is not — per-connection isolation requires a FRESH instance after every
 * completed disconnect (the library's disconnect() does not reset
 * encryptionSession/partialState, so a stale authenticated session from device
 * A could otherwise encrypt commands to device B).
 *
 * ES modules must reach the instance through `globalThis.odAppBle` (resolved at
 * each operation's start, never captured) and renew it via
 * `globalThis.odAppBridge.renew()`.
 */
(function () {
  'use strict';

  function createInstance() {
    var inst = new OpenDisplayBLE();
    // Library auto-reconnect reuses stale per-connection state; the adapter
    // reconnects explicitly on a fresh instance instead (plan §3).
    inst.autoReconnectEnabled = false;
    globalThis.odAppBle = inst;
    return inst;
  }

  globalThis.odAppBridge = {
    renew: createInstance,
  };

  createInstance();
})();
