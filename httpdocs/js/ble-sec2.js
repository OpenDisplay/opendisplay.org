// Bridge between OpenDisplayBLE (ble-common.js) and the SEC2 session driver.
//
// ble-common.js calls three hooks when `ble.sec2Link` is set:
//   outgoing(cmd)    from sendCommand(): returns the frame to write (sealed inside a session)
//   incoming(bytes)  from handleNotification(): returns the plaintext frame for the existing
//                    handler chain, or null when the frame was consumed or must be dropped
//   onDisconnect()   from handleDisconnect()/resetState(): the session is gone
// and handshakes run over `transport` (raw writes + a notification tap), never through the
// v1 encryption path. A SEC2 device is never spoken to with v1 (§ 13.6 pinning): attach() turns
// the v1 layer off for this connection.
// Browser only in production; tests drive it with a fake ble object.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./od-sec2.js'), require('./od-sec2-session.js'));
  } else {
    root.OpenDisplaySec2Link = factory(root.OpenDisplaySec2, root.OpenDisplaySec2Session);
  }
})(typeof self !== 'undefined' ? self : this, function (S, SS) {
  'use strict';

  class Sec2Link {
    /**
     * @param {object} ble  OpenDisplayBLE (needs writeCommandValue, isConnected, log)
     * @param {{keyStore, name, maxFrame?, mtu?, fragMax?, onError?}} o
     *   maxFrame / mtu: the frame limit is min(mtu - 3, 244) (244 when the MTU is unknown)
     *   onError(err, {fatal}) is told about refusals that abort what is in flight
     */
    constructor(ble, { keyStore, name, maxFrame = SS.DEFAULT_MAX_FRAME, mtu = null, fragMax = S.FRAG_MAX_MIN, onError = null, sleep } = {}) {
      this.ble = ble;
      this.onError = onError;
      this.waiters = [];
      this.queue = [];
      const self = this;
      this.transport = {
        get connected() { return !!ble.isConnected; },
        async send(frame) {
          if (!ble.isConnected) throw new Error('Not connected');
          await ble.writeCommandValue(S.u8(frame));
        },
        receive(match, timeoutMs) { return self._wait(match, timeoutMs); }
      };
      this.session = new SS.Sec2Session({ transport: this.transport, keyStore, name, maxFrame, mtu, fragMax,
        log: (m, l) => ble.log && ble.log(m, l || 'info'), ...(sleep ? { sleep } : {}) });
      this.tapActive = 0;   // > 0 while a handshake or a session-driver request owns the replies
    }
    get mode() { return this.session.mode; }

    _wait(match, timeoutMs = 5000) {
      const i = this.queue.findIndex(match);
      if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
      return new Promise(resolve => {
        const w = { match, resolve, timer: null };
        w.timer = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(null); }, timeoutMs);
        this.waiters.push(w);
      });
    }
    /** Hand a raw frame to a waiting handshake reader. True when it was taken. */
    _feedWaiters(bytes) {
      const w = this.waiters.find(x => x.match(bytes));
      if (!w) return false;
      clearTimeout(w.timer);
      this.waiters = this.waiters.filter(x => x !== w);
      w.resolve(Uint8Array.from(bytes));
      return true;
    }

    /** Run fn while the driver reads replies itself (select/auth/claim/rotate/unclaim). */
    async own(fn) {
      this.tapActive++;
      try { return await fn(this.session); } finally { this.tapActive--; this.queue = []; }
    }

    async outgoing(cmd) { return this.session.sealOutgoing(cmd); }

    async incoming(bytes) {
      const b = S.u8(bytes);
      if (this.tapActive > 0) {
        if (this._feedWaiters(b)) return null;
        // Not for a waiter yet: keep raw frames briefly for the next receive() call.
        this.queue.push(Uint8Array.from(b));
        if (this.queue.length > 64) this.queue.shift();
        return null;
      }
      const r = await this.session.openIncoming(b);
      if (r.deliver) return r.deliver;
      if (r.error) {
        if (this.onError) this.onError(r.error, { fatal: !!r.fatal });
        // An FE answer is also passed on so the old "needs a key" detection still fires.
        return r.frame || null;
      }
      return null;
    }

    onDisconnect() {
      this.session.onDisconnect();
      for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(null); }
      this.waiters = []; this.queue = [];
    }

    // ---- framing for ble-common's bulk paths ---------------------------------------------
    get sealed() { return this.session.hasSession; }
    /** Data bytes per direct-write frame ([00][71][data]). */
    directChunk(unsealedMax) { return this.sealed ? Math.min(unsealedMax, this.session.payloadBudget()) : unsealedMax; }
    /** Largest PIPE frame this client offers. */
    pipeClientMaxFrame(unsealed) { return this.sealed ? this.session.maxFrame : unsealed; }
    /** PIPE data bytes per frame ([00][81][seq][data]). */
    pipeDataSize(frameEff) { return this.sealed ? frameEff - S.H2D_OVERHEAD - 1 : frameEff - 3; }
  }

  return { Sec2Link };
});
