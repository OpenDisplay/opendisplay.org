/*
 * OD App classic-script bridge (DESIGN_WEB_OD_APP_PLAN.md §2/§3).
 *
 * OpenDisplayBLE is a top-level class in the classic ble-common.js script, not
 * a window export. This bridge is the ONLY code that constructs it, publishing
 * exactly TWO globals: `globalThis.odAppBle` (the current instance) and
 * `globalThis.odAppBridge` (the factory). The instance name is stable; the
 * instance is not — per-connection isolation requires a FRESH instance after
 * every completed disconnect (the library's disconnect() does not reset
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
    // reconnects explicitly on a fresh instance instead (plan §3). A plain
    // assignment is NOT enough: the library's own connect()/_doConnectToGATT()
    // set this flag back to true, so an unexpected disconnect would revive the
    // stale instance. Pin the property so library writes are inert — instance
    // configuration only; ble-common.js itself is untouched.
    Object.defineProperty(inst, 'autoReconnectEnabled', {
      configurable: false,
      enumerable: true,
      get: function () { return false; },
      set: function () { /* pinned false: adapter owns reconnection */ },
    });
    globalThis.odAppBle = inst;
    return inst;
  }

  globalThis.odAppBridge = {
    renew: createInstance,
  };

  createInstance();
})();
