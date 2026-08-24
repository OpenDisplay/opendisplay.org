// Minimal Chrome DevTools Protocol driver — zero dependencies.
//
// Why: --dump-dom's virtual time never lets IndexedDB callbacks run (verified
// empirically: 2000 polled timers fire before one IDB open completes), so any
// browser test touching IDB needs a real-time driver. This launches headless
// Chrome with a debugging port, speaks raw WebSocket (RFC 6455 client frames)
// to the browser endpoint, and evaluates expressions in fresh tabs.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

// --- tiny WebSocket client (text frames, client-masked, ping->pong) ---

class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onmessage = null;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
  }

  static async open(wsUrl) {
    const url = new URL(wsUrl);
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    await once(socket, 'connect');
    const key = randomBytes(16).toString('base64');
    socket.write(
      `GET ${url.pathname} HTTP/1.1\r\n` +
      `Host: ${url.hostname}:${url.port}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    // Wait for the 101 handshake; keep any frame bytes that follow it.
    const rest = await new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end !== -1) {
          socket.off('data', onData);
          if (!head.toString('latin1', 0, end).includes(' 101 ')) {
            reject(new Error('WebSocket upgrade refused'));
            return;
          }
          resolve(head.subarray(end + 4));
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
    const ws = new MiniWebSocket(socket);
    if (rest.length) {
      ws.buffer = Buffer.concat([ws.buffer, rest]);
      // Drain after the caller has attached onmessage (constructor flow is
      // synchronous, so setImmediate is late enough).
      setImmediate(() => ws.drain());
    }
    return ws;
  }

  drain() {
    this.#drain();
  }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  #drain() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2)); off = 10;
      }
      if (this.buffer.length < off + len) return;
      const payload = this.buffer.subarray(off, off + len);
      this.buffer = this.buffer.subarray(off + len);
      if (opcode === 0x9) {
        // ping -> pong (server pings are unmasked; our pong must be masked)
        const mask = randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | masked.length]), mask, masked]));
      } else if (opcode === 0x1) {
        this.onmessage?.(payload.toString('utf8'));
      }
      // opcode 0x8 (close) / others: ignore; the test tears the process down.
    }
  }

  close() {
    this.socket.destroy();
  }
}

// --- CDP session ---

export class ChromeCdp {
  constructor(proc, ws) {
    this.proc = proc;
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (text) => {
      const msg = JSON.parse(text);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP: ${msg.error.message}`));
        else resolve(msg.result);
      }
    };
    // A dead socket or dead browser must FAIL pending commands, never hang CI.
    const failAll = (why) => () => {
      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP ${why} with command in flight`));
      }
    };
    ws.socket.on('close', failAll('socket closed'));
    ws.socket.on('error', failAll('socket error'));
    proc.on('exit', failAll('chrome exited'));
  }

  static async launch(chromeBin, { profileDir, args = [] } = {}) {
    const proc = spawn(chromeBin, [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--remote-debugging-port=0',
      ...(profileDir ? [`--user-data-dir=${profileDir}`] : []),
      ...args,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let wsUrl;
    try {
      wsUrl = await new Promise((resolve, reject) => {
        let err = '';
        const timer = setTimeout(() => reject(new Error(`Chrome gave no DevTools URL:\n${err}`)), 20000);
        proc.stderr.on('data', (chunk) => {
          err += chunk;
          const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
          if (m) { clearTimeout(timer); resolve(m[1]); }
        });
        proc.on('exit', () => { clearTimeout(timer); reject(new Error(`Chrome exited early:\n${err}`)); });
      });
      const ws = await MiniWebSocket.open(wsUrl);
      return new ChromeCdp(proc, ws);
    } catch (err) {
      proc.kill(); // never leak a Chrome on launch/handshake failure
      throw err;
    }
  }

  cmd(method, params = {}, sessionId = undefined, { timeoutMs = 15000 } = {}) {
    const id = this.nextId++;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return p;
  }

  /**
   * Open `url` in a fresh tab and evaluate `expression` (awaited, by value).
   * Polls until the expression stops throwing (e.g. a module-set global).
   */
  async evalOnPage(url, expression, { timeoutMs = 30000 } = {}) {
    const { targetId } = await this.cmd('Target.createTarget', { url });
    const { sessionId } = await this.cmd('Target.attachToTarget', { targetId, flatten: true });
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const res = await this.cmd('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }, sessionId);
        if (!res.exceptionDetails) return res.result?.value;
        if (Date.now() > deadline) {
          throw new Error(`evalOnPage timed out; last: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await this.cmd('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async close() {
    this.ws.close();
    this.proc.kill();
    await once(this.proc, 'exit').catch(() => {});
  }
}
