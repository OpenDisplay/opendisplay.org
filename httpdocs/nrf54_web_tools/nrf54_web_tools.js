/**
 * nRF54 Web Tools — embeddable WebUSB CMSIS-DAP flash + RTT for nRF54L15 / nRF54LM20A.
 *
 * Requires dap.umd.js (global DAPjs) loaded first.
 *
 *   const tools = new Nrf54WebTools({
 *     target: 'nrf54l15',
 *     hex: './firmware.hex',
 *     onLog: (msg, level) => console.log(level, msg),
 *     onProgress: (phase, pct) => {},
 *     onRttData: (text) => {}
 *   });
 *   await tools.flashFirmware();
 *   await tools.connectRtt();
 *
 * Portions derived from FreeOCD / xiao-nrf54l15-web-flasher (BSD-3) and dapjs RTT (MIT).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------
  const TARGETS = {
    nrf54l15: {
      id: 'nrf54l15',
      name: 'nRF54L15',
      ctrlApNum: 2,
      ctrlApIdr: 0x32880000,
      eraseAllStatus: { ready: 0, readyToReset: 1, busy: 2, error: 3 },
      rramcBase: 0x5004B000,
      rramcConfigOffset: 0x500,
      rramcReadyOffset: 0x400,
      rramcEnableValue: 0x101,
      flashSize: 0x0017D000,
      sramBase: 0x20000000
    },
    nrf54lm20a: {
      id: 'nrf54lm20a',
      name: 'nRF54LM20A',
      ctrlApNum: 2,
      ctrlApIdr: 0x32880000,
      eraseAllStatus: { ready: 0, readyToReset: 1, busy: 2, error: 3 },
      rramcBase: 0x5004E000,
      rramcConfigOffset: 0x500,
      rramcReadyOffset: 0x400,
      rramcEnableValue: 0x101,
      flashSize: 0x001FD000,
      sramBase: 0x20000000
    }
  };

  const USB_VENDOR_IDS = [
    0x03EB, 0x0403, 0x0416, 0x045B, 0x0483, 0x04B4, 0x0D28, 0x1209,
    0x1A86, 0x1F00, 0x1FC9, 0x2341, 0x2886, 0x2A86, 0x2E8A, 0x4348, 0xC251
  ];

  const RTT_KNOWN_ADDR = 0x20000470;

  // ---------------------------------------------------------------------------
  // DAP constants / helpers
  // ---------------------------------------------------------------------------
  const DP_REG_SELECT = 0x8;
  const DP_REG_RDBUFF = 0xC;
  const DAP_PORT_DEBUG = 0x00;
  const DAP_PORT_ACCESS = 0x01;
  const DAP_TRANSFER_WRITE = 0x00;
  const DAP_TRANSFER_READ = 0x02;
  const AP_CSW = 0x00;
  const AP_TAR = 0x04;
  const AP_DRW = 0x0C;
  const CSW_VALUE = 0x23000052;
  const DAP_COMMAND_TRANSFER = 0x05;

  const CTRL_AP_RESET = 0x000;
  const CTRL_AP_ERASEALL = 0x004;
  const CTRL_AP_ERASEALLSTATUS = 0x008;
  const CTRL_AP_ERASEPROTECTSTATUS = 0x00C;
  const CTRL_AP_IDR_REG = 0x0FC;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function createSelectValue(apNum, regOffset) {
    return ((apNum << 24) & 0xFF000000) | (regOffset & 0x000000F0);
  }

  function getTransferRegister(regOffset) {
    return regOffset & 0x0C;
  }

  function getTransport(dapOrProxy) {
    const names = Object.getOwnPropertyNames(dapOrProxy);
    for (const name of names) {
      const prop = dapOrProxy[name];
      if (prop && typeof prop === 'object' && typeof prop.write === 'function' && typeof prop.read === 'function') {
        return prop;
      }
    }
    return null;
  }

  function getProxy(dap) {
    const names = Object.getOwnPropertyNames(dap);
    for (const name of names) {
      const prop = dap[name];
      if (prop && typeof prop === 'object' && typeof prop.transferBlock === 'function') {
        return prop;
      }
    }
    throw new Error('Could not find DAP proxy');
  }

  async function rawDapTransferWrite(transport, operations) {
    const packet = new Uint8Array(3 + operations.length * 5);
    const view = new DataView(packet.buffer);
    packet[0] = DAP_COMMAND_TRANSFER;
    packet[1] = 0;
    packet[2] = operations.length;
    let offset = 3;
    for (const op of operations) {
      packet[offset] = op.port | op.mode | op.register;
      view.setUint32(offset + 1, op.value || 0, true);
      offset += 5;
    }
    await transport.write(packet);
    const response = await transport.read();
    if (response.byteLength < 3) {
      throw new Error(`DAP_TRANSFER response too short: ${response.byteLength}`);
    }
    if (response.getUint8(0) !== DAP_COMMAND_TRANSFER) {
      throw new Error(`Bad DAP response cmd 0x${response.getUint8(0).toString(16)}`);
    }
    if (response.getUint8(1) !== operations.length) {
      throw new Error('DAP transfer count mismatch');
    }
    const ack = response.getUint8(2) & 0x07;
    if (ack !== 0x01) {
      throw new Error(`DAP transfer ACK=0x${ack.toString(16)}`);
    }
  }

  async function readAPReg(dap, apNum, regOffset, retries = 3) {
    const selectValue = createSelectValue(apNum, regOffset);
    const transferReg = getTransferRegister(regOffset);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const proxy = Object.getOwnPropertyNames(dap)
          .map((n) => dap[n])
          .find((p) => p && typeof p.transfer === 'function');
        if (!proxy) throw new Error('No DAP transfer proxy');
        await proxy.transfer([{
          port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_WRITE,
          register: DP_REG_SELECT, value: selectValue
        }]);
        await proxy.transfer([{
          port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_READ, register: transferReg
        }]);
        const result = await proxy.transfer([{
          port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_READ, register: DP_REG_RDBUFF
        }]);
        if (result && result.length > 0) return result[0];
        await sleep(50);
      } catch (err) {
        if (attempt === retries - 1) throw err;
        await sleep(50);
      }
    }
    return undefined;
  }

  async function writeAPReg(dap, apNum, regOffset, value, retries = 3) {
    const selectValue = createSelectValue(apNum, regOffset);
    const transferReg = getTransferRegister(regOffset);
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const proxy = Object.getOwnPropertyNames(dap)
          .map((n) => dap[n])
          .find((p) => p && typeof p.transfer === 'function');
        if (!proxy) throw new Error('No DAP transfer proxy');
        await proxy.transfer([{
          port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_WRITE,
          register: DP_REG_SELECT, value: selectValue
        }]);
        await proxy.transfer([{
          port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE,
          register: transferReg, value
        }]);
        return;
      } catch (err) {
        if (attempt === retries - 1) throw err;
        await sleep(50);
      }
    }
  }

  async function rawReadMem32(dap, address) {
    const proxy = getProxy(dap);
    const transport = getTransport(proxy);
    if (!transport) return dap.readMem32(address);
    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_WRITE, register: DP_REG_SELECT, value: 0 },
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_CSW, value: CSW_VALUE },
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_TAR, value: address >>> 0 }
    ]);
    const drw = await proxy.transfer([{
      port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_READ, register: AP_DRW
    }]);
    if (drw && drw.length > 0) return drw[0] >>> 0;
    const buff = await proxy.transfer([{
      port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_READ, register: DP_REG_RDBUFF
    }]);
    if (!buff || buff.length === 0) {
      throw new Error(`rawReadMem32(0x${(address >>> 0).toString(16)}) empty`);
    }
    return buff[0] >>> 0;
  }

  async function rawWriteMem32(dap, address, value) {
    const proxy = getProxy(dap);
    const transport = getTransport(proxy);
    if (!transport) return dap.writeMem32(address, value >>> 0);
    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_WRITE, register: DP_REG_SELECT, value: 0 },
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_CSW, value: CSW_VALUE },
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_TAR, value: address >>> 0 },
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_DRW, value: value >>> 0 }
    ]);
  }

  async function rawReadMemBytes(dap, address, byteLength) {
    const out = new Uint8Array(byteLength);
    const start = address >>> 0;
    const end = start + byteLength;
    let addr = start & ~0x3;
    let offset = 0;
    while (addr < end) {
      const word = await rawReadMem32(dap, addr);
      for (let b = 0; b < 4 && offset < byteLength; b++) {
        const abs = addr + b;
        if (abs >= start && abs < end) out[offset++] = (word >>> (8 * b)) & 0xFF;
      }
      addr += 4;
    }
    return out;
  }

  function createReliableMemProcessor(dap) {
    return {
      async connect() { if (dap.connect) await dap.connect(); },
      async disconnect() { if (dap.disconnect) await dap.disconnect(); },
      async halt() { if (dap.halt) await dap.halt(); },
      async resume() { if (dap.resume) await dap.resume(); },
      async softReset() {
        if (dap.softReset) await dap.softReset();
        else if (dap.reset) await dap.reset();
      },
      async reset() {
        if (dap.reset) return dap.reset();
        return this.softReset();
      },
      async readMem32(address) { return rawReadMem32(dap, address); },
      async writeMem32(address, value) { return rawWriteMem32(dap, address, value); },
      async writeMem8(address, value) {
        const aligned = address & ~0x3;
        const shift = (address & 0x3) * 8;
        const word = await rawReadMem32(dap, aligned);
        const next = (word & ~(0xFF << shift)) | ((value & 0xFF) << shift);
        return rawWriteMem32(dap, aligned, next);
      },
      async readBytes(address, count) { return rawReadMemBytes(dap, address, count); }
    };
  }

  // ---------------------------------------------------------------------------
  // Intel HEX
  // ---------------------------------------------------------------------------
  function parseIntelHex(hexString) {
    const lines = hexString.split(/\r?\n/);
    const data = [];
    let extendedAddress = 0;
    let minAddress = Infinity;
    let maxAddress = 0;

    for (const line of lines) {
      if (!line.startsWith(':')) continue;
      const bytes = [];
      for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.substr(i, 2), 16));
      const byteCount = bytes[0];
      const address = (bytes[1] << 8) | bytes[2];
      const recordType = bytes[3];
      const recordData = bytes.slice(4, 4 + byteCount);
      let checksum = 0;
      for (let i = 0; i < bytes.length - 1; i++) checksum += bytes[i];
      checksum = (~checksum + 1) & 0xFF;
      if (checksum !== bytes[bytes.length - 1]) {
        throw new Error(`HEX checksum error: ${line}`);
      }
      switch (recordType) {
        case 0x00: {
          const fullAddress = extendedAddress + address;
          for (let i = 0; i < recordData.length; i++) {
            data.push({ address: fullAddress + i, value: recordData[i] });
          }
          minAddress = Math.min(minAddress, fullAddress);
          maxAddress = Math.max(maxAddress, fullAddress + recordData.length);
          break;
        }
        case 0x01: break;
        case 0x02: extendedAddress = ((recordData[0] << 8) | recordData[1]) << 4; break;
        case 0x04: extendedAddress = ((recordData[0] << 8) | recordData[1]) << 16; break;
        case 0x03:
        case 0x05: break;
        default: break;
      }
    }
    if (data.length === 0) throw new Error('No data found in HEX file');
    const size = maxAddress - minAddress;
    const buffer = new Uint8Array(size);
    buffer.fill(0xFF);
    for (const { address, value } of data) buffer[address - minAddress] = value;
    return { data: buffer, startAddress: minAddress, size };
  }

  // ---------------------------------------------------------------------------
  // RTT
  // ---------------------------------------------------------------------------
  class RTTHandler {
    constructor(processor, options = {}) {
      this.processor = processor;
      this.scanStartAddress = options.scanStartAddress || 0x20000000;
      this.scanRange = options.scanRange || 0x20000;
      this.scanBlockSize = options.scanBlockSize || 0x100;
      this.scanStride = options.scanStride || 0x0F0;
      this.knownAddress = options.knownAddress != null ? options.knownAddress : RTT_KNOWN_ADDR;
      this.rttSignatureBytes = new TextEncoder().encode('SEGGER RTT');
      this.numBufUp = 0;
      this.numBufDown = 0;
      this.bufUp = {};
      this.bufDown = {};
      this.rttCtrlAddr = null;
      this.isInitialized = false;
    }

    async init() {
      this.rttCtrlAddr = null;
      this.isInitialized = false;
      const needle = this.rttSignatureBytes;

      if (this.knownAddress != null) {
        try {
          if (await this._matchAt(this.knownAddress)) {
            this.rttCtrlAddr = this.knownAddress;
          }
        } catch (_) { /* scan */ }
      }

      if (!this.rttCtrlAddr) {
        const end = this.scanStartAddress + this.scanRange;
        for (let addr = this.scanStartAddress; addr < end; addr += this.scanStride) {
          const readLen = Math.min(this.scanBlockSize, end - addr);
          try {
            const data = await this.processor.readBytes(addr, readLen);
            const idx = this._indexOfBytes(data, needle);
            if (idx >= 0) {
              this.rttCtrlAddr = addr + idx;
              break;
            }
          } catch (_) { /* continue */ }
        }
      }

      if (!this.rttCtrlAddr) return -1;
      return this._loadControlBlock();
    }

    async _matchAt(addr) {
      const data = await this.processor.readBytes(addr, this.rttSignatureBytes.length);
      return this._indexOfBytes(data, this.rttSignatureBytes) === 0;
    }

    async _loadControlBlock() {
      const data = await this.processor.readBytes(this.rttCtrlAddr, 24 + 8 * 24);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      this.numBufUp = dv.getUint32(16, true);
      this.numBufDown = dv.getUint32(20, true);
      for (let i = 0; i < this.numBufUp; i++) {
        const o = 24 + i * 24;
        this.bufUp[i] = {
          bufAddr: this.rttCtrlAddr + o,
          pBuffer: dv.getUint32(o + 4, true),
          SizeOfBuffer: dv.getUint32(o + 8, true),
          WrOff: dv.getUint32(o + 12, true),
          RdOff: dv.getUint32(o + 16, true),
          Flags: dv.getUint32(o + 20, true)
        };
      }
      for (let i = 0; i < this.numBufDown; i++) {
        const o = 24 + (this.numBufUp + i) * 24;
        this.bufDown[i] = {
          bufAddr: this.rttCtrlAddr + o,
          pBuffer: dv.getUint32(o + 4, true),
          SizeOfBuffer: dv.getUint32(o + 8, true),
          WrOff: dv.getUint32(o + 12, true),
          RdOff: dv.getUint32(o + 16, true),
          Flags: dv.getUint32(o + 20, true)
        };
      }
      this.isInitialized = true;
      return this.numBufUp + this.numBufDown;
    }

    _indexOfBytes(haystack, needle) {
      outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    async resetUpBufferReadOffset(bufId = 0) {
      const buf = this.bufUp[bufId];
      if (!buf) throw new Error(`Up buffer ${bufId} not found`);
      const wrOff = await this.processor.readMem32(buf.bufAddr + 12);
      try { await this.processor.writeMem32(buf.bufAddr + 16, wrOff); } catch (_) { /* */ }
      buf.WrOff = wrOff;
      buf.RdOff = wrOff;
      buf.hostRdOff = wrOff;
    }

    async read(bufId = 0) {
      const buf = this.bufUp[bufId];
      if (!buf) throw new Error(`Up buffer ${bufId} not found`);
      const wrOff = (await this.processor.readMem32(buf.bufAddr + 12)) >>> 0;
      const rdOffTarget = (await this.processor.readMem32(buf.bufAddr + 16)) >>> 0;
      if (buf.hostRdOff == null) buf.hostRdOff = wrOff;
      const rdOff = buf.hostRdOff >>> 0;
      buf.WrOff = wrOff;
      buf.RdOff = rdOffTarget;
      if (wrOff === rdOff) return new Uint8Array(0);
      if (wrOff < rdOff) {
        const unreadIfWrap = (buf.SizeOfBuffer - rdOff) + wrOff;
        if (unreadIfWrap > buf.SizeOfBuffer - 1 || rdOff >= buf.SizeOfBuffer) {
          buf.hostRdOff = wrOff;
          try { await this.processor.writeMem32(buf.bufAddr + 16, wrOff); } catch (_) { /* */ }
          return new Uint8Array(0);
        }
      }
      let data;
      if (wrOff > rdOff) {
        data = await this.processor.readBytes(buf.pBuffer + rdOff, wrOff - rdOff);
      } else {
        const data1 = await this.processor.readBytes(buf.pBuffer + rdOff, buf.SizeOfBuffer - rdOff);
        const data2 = wrOff > 0
          ? await this.processor.readBytes(buf.pBuffer, wrOff)
          : new Uint8Array(0);
        data = new Uint8Array(data1.length + data2.length);
        data.set(data1, 0);
        data.set(data2, data1.length);
      }
      buf.hostRdOff = wrOff;
      buf.RdOff = wrOff;
      try { await this.processor.writeMem32(buf.bufAddr + 16, wrOff); } catch (_) { /* */ }
      return data;
    }
  }

  // ---------------------------------------------------------------------------
  // Flash (CTRL-AP erase + RRAMC write)
  // ---------------------------------------------------------------------------
  async function massErase(dap, target, log, onProgress) {
    const st = target.eraseAllStatus;
    const ap = target.ctrlApNum;
    const idr = await readAPReg(dap, ap, CTRL_AP_IDR_REG);
    if (idr !== undefined && idr !== target.ctrlApIdr) {
      log(`Unexpected CTRL-AP IDR 0x${idr.toString(16)}`, 'warning');
    }

    async function attempt(isRetry) {
      const prefix = isRetry ? '[Retry] ' : '';
      log(`${prefix}Triggering mass erase...`, 'info');
      await writeAPReg(dap, ap, CTRL_AP_ERASEALL, 0);
      await sleep(10);
      await writeAPReg(dap, ap, CTRL_AP_ERASEALL, 1);
      let status;
      for (let i = 0; i < 300; i++) {
        status = await readAPReg(dap, ap, CTRL_AP_ERASEALLSTATUS);
        if (status === st.busy) break;
        if (status === st.error) return false;
        if (status === st.readyToReset) return true;
        await sleep(100);
        onProgress('erase', (i / 300) * 30);
      }
      if (status !== st.busy && status !== st.readyToReset) return false;
      for (let i = 0; i < 300; i++) {
        status = await readAPReg(dap, ap, CTRL_AP_ERASEALLSTATUS);
        if (status === st.readyToReset) return true;
        if (status === st.error) return false;
        await sleep(100);
        onProgress('erase', 30 + (i / 300) * 50);
      }
      return false;
    }

    let ok = await attempt(false);
    if (!ok) {
      log('Mass erase failed, reconnecting...', 'warning');
      await dap.disconnect();
      await sleep(500);
      await dap.connect();
      await sleep(200);
      ok = await attempt(true);
      if (!ok) throw new Error('Mass erase failed');
    }

    onProgress('erase', 80);
    await writeAPReg(dap, ap, CTRL_AP_RESET, 2);
    await sleep(10);
    await writeAPReg(dap, ap, CTRL_AP_RESET, 0);
    await writeAPReg(dap, ap, CTRL_AP_ERASEALL, 0);
    await sleep(500);
    try { await dap.reconnect(); } catch (_) { /* */ }
    await sleep(200);
    onProgress('erase', 100);
    log('Mass erase complete', 'success');
  }

  async function initRRAMC(dap, transport, target, log) {
    const configAddr = target.rramcBase + target.rramcConfigOffset;
    const readyAddr = target.rramcBase + target.rramcReadyOffset;
    log('Enabling RRAMC write...', 'info');
    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_TAR, value: configAddr }
    ]);
    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_DRW, value: target.rramcEnableValue }
    ]);
    const cfg = await dap.readMem32(configAddr);
    if ((cfg & 1) !== 1) log('RRAMC WEN not set', 'warning');
    let ready = await dap.readMem32(readyAddr);
    for (let i = 0; i < 100 && (ready & 1) === 0; i++) {
      await sleep(10);
      ready = await dap.readMem32(readyAddr);
    }
  }

  async function flashRRAMC(dap, target, firmwareData, startAddress, log, onProgress) {
    const proxy = getProxy(dap);
    const transport = getTransport(proxy);
    if (!transport) throw new Error('No DAP transport');

    const paddedSize = Math.ceil(firmwareData.length / 4) * 4;
    const padded = new Uint8Array(paddedSize);
    padded.fill(0xFF);
    padded.set(firmwareData);
    const words = new Uint32Array(padded.buffer);
    const totalWords = words.length;

    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_DEBUG, mode: DAP_TRANSFER_WRITE, register: DP_REG_SELECT, value: 0 }
    ]);
    await rawDapTransferWrite(transport, [
      { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_CSW, value: CSW_VALUE }
    ]);
    await initRRAMC(dap, transport, target, log);

    log(`Writing ${totalWords} words...`, 'info');
    let wordsWritten = 0;
    let currentTar = -1;
    while (wordsWritten < totalWords) {
      const addr = startAddress + wordsWritten * 4;
      if (currentTar === -1 || (addr & 0x3FF) === 0) {
        await rawDapTransferWrite(transport, [
          { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_TAR, value: addr }
        ]);
        currentTar = addr;
      }
      await rawDapTransferWrite(transport, [
        { port: DAP_PORT_ACCESS, mode: DAP_TRANSFER_WRITE, register: AP_DRW, value: words[wordsWritten] }
      ]);
      currentTar += 4;
      wordsWritten++;
      if (wordsWritten % 256 === 0 || wordsWritten === totalWords) {
        onProgress('flash', (wordsWritten / totalWords) * 100);
      }
    }

    if (totalWords > 0) {
      const flushAddr = startAddress + (totalWords - 1) * 4;
      try { await dap.readMem32(flushAddr); } catch (e) {
        log(`Flush read failed: ${e.message}`, 'warning');
      }
    }
    log('Flash write complete', 'success');
  }

  async function ctrlApReset(dap, target, log) {
    try {
      await writeAPReg(dap, target.ctrlApNum, CTRL_AP_RESET, 2);
      await sleep(10);
      await writeAPReg(dap, target.ctrlApNum, CTRL_AP_RESET, 0);
      await sleep(100);
      log('Device reset', 'success');
    } catch (e) {
      log(`CTRL-AP reset failed: ${e.message}`, 'warning');
      try { await dap.reset(); } catch (_) { /* */ }
    }
  }

  // ---------------------------------------------------------------------------
  // WebUSB
  // ---------------------------------------------------------------------------
  async function selectCmsisDap(options = {}) {
    if (!global.DAPjs) throw new Error('DAPjs not loaded — include dap.umd.js first');
    if (!navigator.usb) throw new Error('WebUSB not supported in this browser');
    const skip = !!options.skipProbeCheck;
    const filters = skip ? [] : USB_VENDOR_IDS.map((vendorId) => ({ vendorId }));
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters });
    } catch (error) {
      if (error.name === 'NotFoundError') {
        throw new Error('No device selected');
      }
      throw error;
    }
    if (!skip) {
      const productName = device.productName || '';
      if (!productName.toUpperCase().includes('CMSIS-DAP')) {
        throw new Error(`Not a CMSIS-DAP probe: "${productName}"`);
      }
    }
    return { device, transport: new global.DAPjs.WebUSB(device) };
  }

  async function loadHex(hex) {
    if (hex instanceof Uint8Array) {
      return parseIntelHex(new TextDecoder().decode(hex));
    }
    if (typeof File !== 'undefined' && hex instanceof File) {
      return parseIntelHex(await hex.text());
    }
    if (typeof hex === 'string') {
      const trimmed = hex.trim();
      // Inline Intel HEX (starts with a record). Otherwise treat as URL/path.
      if (trimmed.startsWith(':')) {
        return parseIntelHex(hex);
      }
      const res = await fetch(hex);
      if (!res.ok) throw new Error(`Failed to fetch HEX: ${res.status} (${hex})`);
      const text = await res.text();
      if (!text.trim().startsWith(':')) {
        throw new Error(`Fetched content is not Intel HEX (${hex})`);
      }
      return parseIntelHex(text);
    }
    throw new Error('hex must be a URL, HEX string, File, or Uint8Array');
  }

  // ---------------------------------------------------------------------------
  // Public API (nrf-web-tools style modal)
  // ---------------------------------------------------------------------------
  class Nrf54WebTools {
    /**
     * @param {HTMLElement|object} buttonOrOpts - Launch button, or options object
     * @param {string|File|Uint8Array} [hexPath] - Firmware HEX (when first arg is button)
     * @param {object} [opts]
     * @param {'nrf54l15'|'nrf54lm20a'} [opts.target='nrf54l15']
     * @param {string} [opts.deviceName] - Label shown in the dialog
     */
    constructor(buttonOrOpts, hexPath, opts = {}) {
      let button = null;
      let options = opts;

      if (buttonOrOpts && typeof buttonOrOpts === 'object' && !(buttonOrOpts instanceof HTMLElement)
          && !buttonOrOpts.addEventListener) {
        options = buttonOrOpts;
        button = options.button || options.flashButton || null;
        hexPath = options.hex != null ? options.hex : hexPath;
      } else {
        button = buttonOrOpts;
      }

      this.button = button;
      this.hex = hexPath != null ? hexPath : (options.hex || null);
      this.targetId = options.target || 'nrf54l15';
      this.deviceName = options.deviceName || null;
      this.rttPollMs = options.rttPollMs || 20;
      this.rttKnownAddress = options.rttKnownAddress != null ? options.rttKnownAddress : RTT_KNOWN_ADDR;
      this.skipProbeCheck = !!options.skipProbeCheck;
      this.onLog = options.onLog || (() => {});
      this.onProgress = options.onProgress || (() => {});
      this.onRttData = options.onRttData || (() => {});
      this.onRttConnected = options.onRttConnected || (() => {});
      this.onRttDisconnected = options.onRttDisconnected || (() => {});

      this.modal = null;
      this.currentState = 'CHOICE';
      this._rttProcessor = null;
      this._rttHandler = null;
      this._rttAbort = null;
      this._rttConnected = false;
      this._busy = false;
      this._rttLog = '';
      this._statusLog = [];
      this._uiProgress = { phase: '', pct: 0, label: '' };

      if (this.button) {
        this.button.addEventListener('click', () => this.open());
      }
    }

    static isSupported() {
      return !!(navigator.usb && global.DAPjs);
    }

    static targets() {
      return Object.keys(TARGETS);
    }

    static parseHex(hexString) {
      return parseIntelHex(hexString);
    }

    setTarget(id) {
      if (!TARGETS[id]) throw new Error(`Unknown target: ${id}`);
      this.targetId = id;
    }

    setHex(hex) {
      this.hex = hex;
    }

    getTarget() {
      const t = TARGETS[this.targetId];
      if (!t) throw new Error(`Unknown target: ${this.targetId}`);
      return t;
    }

    open() {
      this.createModal();
      this.showModal();
      this.renderPage('CHOICE');
    }

    startInstall() {
      return this.open();
    }

    // ---- Modal shell --------------------------------------------------------

    createModal() {
      if (document.getElementById('nrf54-web-modal')) {
        this.modal = document.getElementById('nrf54-web-modal');
        return;
      }
      const modal = document.createElement('div');
      modal.id = 'nrf54-web-modal';
      modal.className = 'nrf54-web-modal';
      modal.innerHTML = `
        <div class="nrf54-web-modal-content">
          <button class="nrf54-web-close" id="nrf54-web-close-btn" aria-label="Close">&times;</button>
          <div class="nrf54-web-headline" id="nrf54-web-headline"></div>
          <div class="nrf54-web-content" id="nrf54-web-content"></div>
          <div class="nrf54-web-actions" id="nrf54-web-actions"></div>
        </div>
      `;
      document.body.appendChild(modal);
      this.modal = modal;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal();
        else if (e.target.closest('.nrf54-web-close') || e.target.closest('#nrf54-web-close-btn')) {
          e.preventDefault();
          e.stopPropagation();
          this.closeModal();
        }
      });
      this.injectStyles();
    }

    showModal() {
      if (!this.modal) this.createModal();
      this.modal.classList.add('show');
    }

    async closeModal() {
      if (this.currentState === 'INSTALLING') return;
      if (this._rttConnected) {
        try { await this.disconnectRtt(); } catch (_) { /* */ }
      }
      if (this.modal) this.modal.classList.remove('show');
      this.renderPage('CHOICE');
    }

    _els() {
      return {
        headline: document.getElementById('nrf54-web-headline'),
        content: document.getElementById('nrf54-web-content'),
        actions: document.getElementById('nrf54-web-actions'),
        closeBtn: document.getElementById('nrf54-web-close-btn')
      };
    }

    renderPage(state, data = {}) {
      this.currentState = state;
      const { headline, content, actions, closeBtn } = this._els();
      if (!headline || !content || !actions) return;

      if (closeBtn) {
        const hide = state === 'INSTALLING' || state === 'CONNECTING_RTT';
        closeBtn.style.display = hide ? 'none' : 'block';
      }

      headline.innerHTML = '';
      content.innerHTML = '';
      actions.innerHTML = '';

      switch (state) {
        case 'CHOICE': this._renderChoice(headline, content, actions); break;
        case 'INSTALLING': this._renderInstalling(headline, content, actions, data); break;
        case 'SUCCESS': this._renderSuccess(headline, content, actions, data); break;
        case 'CONNECTING_RTT': this._renderConnectingRtt(headline, content, actions, data); break;
        case 'RTT': this._renderRtt(headline, content, actions, data); break;
        case 'ERROR': this._renderError(headline, content, actions, data); break;
        default: break;
      }
    }

    _targetLabel() {
      try {
        return this.deviceName || this.getTarget().name;
      } catch (_) {
        return this.targetId;
      }
    }

    _renderChoice(headline, content, actions) {
      const name = this._targetLabel();
      headline.innerHTML = '<h3>nRF54 Web Tools</h3>';
      content.innerHTML = `
        <div class="nrf54-web-welcome">
          <p>Update firmware or read live RTT logs on <strong>${this._escape(name)}</strong> via CMSIS-DAP.</p>
          <div class="nrf54-web-instructions">
            <h4>Choose an action</h4>
            <p><strong>Install</strong> mass-erases the chip and flashes the selected HEX.</p>
            <p><strong>Debug (RTT)</strong> connects to the running firmware and streams logs — before or after install.</p>
            <p class="nrf54-web-note">Chrome / Edge required. You will be asked to select the CMSIS-DAP probe.</p>
          </div>
        </div>
      `;
      actions.innerHTML = `
        <button type="button" class="nrf54-web-btn nrf54-web-btn-primary" id="nrf54-web-install-btn">Install firmware</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-debug-btn">Debug (RTT)</button>
      `;
      const installBtn = document.getElementById('nrf54-web-install-btn');
      const debugBtn = document.getElementById('nrf54-web-debug-btn');
      if (installBtn) installBtn.onclick = () => this._beginInstall();
      if (debugBtn) debugBtn.onclick = () => this._beginRtt();
    }

    _renderInstalling(headline, content, actions, data) {
      headline.innerHTML = '<h3>Installing</h3>';
      const progress = data.progress || 0;
      const label = data.label || 'Installing firmware...';
      const showRing = progress > 0 && progress < 100;
      const r = 20;
      const circ = 2 * Math.PI * r;
      content.innerHTML = `
        <div class="nrf54-web-progress-page">
          <div class="nrf54-web-circular-progress" id="nrf54-web-progress-ring" style="display:${showRing ? 'block' : 'none'}">
            <svg viewBox="0 0 48 48">
              <circle class="nrf54-web-circular-progress-track" cx="24" cy="24" r="${r}" fill="none" stroke-width="4"/>
              <circle class="nrf54-web-circular-progress-fill" id="nrf54-web-progress-fill" cx="24" cy="24" r="${r}" fill="none" stroke-width="4"
                stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - progress / 100)}"/>
            </svg>
            <span class="nrf54-web-progress-text" id="nrf54-web-progress-pct">${Math.round(progress)}%</span>
          </div>
          <div class="nrf54-web-spinner" id="nrf54-web-progress-spinner" style="display:${showRing ? 'none' : 'block'}"></div>
          <p id="nrf54-web-progress-label">${this._escape(label)}</p>
          <p class="nrf54-web-details" id="nrf54-web-progress-details">${this._escape(data.details || '')}</p>
        </div>
      `;
      actions.innerHTML = '';
    }

    _renderSuccess(headline, content, actions, data) {
      headline.innerHTML = '<h3>Installation complete</h3>';
      content.innerHTML = `
        <div class="nrf54-web-message-page">
          <div class="nrf54-web-message-icon">OK</div>
          <p>${this._escape(data.message || 'Firmware installed successfully.')}</p>
          <p class="nrf54-web-details">You can open RTT now to read boot logs, or close this dialog.</p>
        </div>
      `;
      actions.innerHTML = `
        <button type="button" class="nrf54-web-btn nrf54-web-btn-primary" id="nrf54-web-rtt-after-btn">Read RTT logs</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-done-btn">Close</button>
      `;
      const rttBtn = document.getElementById('nrf54-web-rtt-after-btn');
      const doneBtn = document.getElementById('nrf54-web-done-btn');
      if (rttBtn) rttBtn.onclick = () => this._beginRtt();
      if (doneBtn) doneBtn.onclick = () => this.closeModal();
    }

    _renderConnectingRtt(headline, content, actions, data) {
      headline.innerHTML = '<h3>Connecting RTT</h3>';
      content.innerHTML = `
        <div class="nrf54-web-progress-page">
          <div class="nrf54-web-spinner"></div>
          <p>${this._escape(data.message || 'Looking for SEGGER RTT control block...')}</p>
        </div>
      `;
      actions.innerHTML = '';
    }

    _renderRtt(headline, content, actions) {
      headline.innerHTML = '<h3>RTT logs</h3>';
      content.innerHTML = `
        <div class="nrf54-web-rtt-page">
          <pre class="nrf54-web-rtt-log" id="nrf54-web-rtt-log">${this._escape(this._rttLog)}</pre>
        </div>
      `;
      actions.innerHTML = `
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-reset-soft-btn">Soft reset</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-reset-hard-btn">Hard reset</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-download-btn">Download logs</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-clear-btn">Clear</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-primary" id="nrf54-web-rtt-close-btn">Disconnect</button>
      `;
      const softBtn = document.getElementById('nrf54-web-reset-soft-btn');
      const hardBtn = document.getElementById('nrf54-web-reset-hard-btn');
      const downloadBtn = document.getElementById('nrf54-web-download-btn');
      const clearBtn = document.getElementById('nrf54-web-clear-btn');
      const closeBtn = document.getElementById('nrf54-web-rtt-close-btn');
      if (softBtn) softBtn.onclick = () => this.resetDevice('soft');
      if (hardBtn) hardBtn.onclick = () => this.resetDevice('hard');
      if (downloadBtn) downloadBtn.onclick = () => this.downloadRttLog();
      if (clearBtn) clearBtn.onclick = () => {
        this._rttLog = '';
        const el = document.getElementById('nrf54-web-rtt-log');
        if (el) el.textContent = '';
      };
      if (closeBtn) closeBtn.onclick = async () => {
        await this.disconnectRtt();
        this.renderPage('CHOICE');
      };
      const logEl = document.getElementById('nrf54-web-rtt-log');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }

    _renderError(headline, content, actions, data) {
      headline.innerHTML = '<h3>Error</h3>';
      content.innerHTML = `
        <div class="nrf54-web-message-page">
          <p>${this._escape(data.message || 'Something went wrong.')}</p>
          ${data.details ? `<p class="nrf54-web-error-details">${this._escape(data.details)}</p>` : ''}
        </div>
      `;
      actions.innerHTML = `
        <button type="button" class="nrf54-web-btn nrf54-web-btn-secondary" id="nrf54-web-err-close">Close</button>
        <button type="button" class="nrf54-web-btn nrf54-web-btn-primary" id="nrf54-web-err-back">Back</button>
      `;
      const close = document.getElementById('nrf54-web-err-close');
      const back = document.getElementById('nrf54-web-err-back');
      if (close) close.onclick = () => this.closeModal();
      if (back) back.onclick = () => this.renderPage('CHOICE');
    }

    _escape(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    _uiLog(msg, level) {
      this.onLog(msg, level);
      this._statusLog.push({ msg, level, t: Date.now() });
    }

    _uiSetProgress(phase, pct, label) {
      this.onProgress(phase, pct);
      this._uiProgress = { phase, pct, label: label || phase };
      if (this.currentState !== 'INSTALLING') return;

      const resolvedLabel = label || (phase === 'erase' ? 'Erasing device...'
        : phase === 'flash' ? 'Writing firmware...' : 'Working...');
      const details = phase === 'erase' ? 'CTRL-AP mass erase'
        : phase === 'flash' ? 'RRAMC programming' : '';

      const labelEl = document.getElementById('nrf54-web-progress-label');
      const detailsEl = document.getElementById('nrf54-web-progress-details');
      const fill = document.getElementById('nrf54-web-progress-fill');
      const text = document.getElementById('nrf54-web-progress-pct');
      const ring = document.getElementById('nrf54-web-progress-ring');
      const spinner = document.getElementById('nrf54-web-progress-spinner');

      if (labelEl) labelEl.textContent = resolvedLabel;
      if (detailsEl) detailsEl.textContent = details;

      const showRing = pct > 0 && pct < 100;
      if (ring && spinner) {
        ring.style.display = showRing ? 'block' : 'none';
        spinner.style.display = showRing ? 'none' : 'block';
      }
      if (showRing && fill && text) {
        const circ = 2 * Math.PI * 20;
        fill.setAttribute('stroke-dashoffset', String(circ * (1 - pct / 100)));
        text.textContent = Math.round(pct) + '%';
      }
    }

    _appendRttText(text) {
      if (!text) return;
      this._rttLog += text;
      this.onRttData(text);
      if (this.currentState === 'RTT') {
        const el = document.getElementById('nrf54-web-rtt-log');
        if (el) {
          el.textContent += text;
          el.scrollTop = el.scrollHeight;
        }
      }
    }

    downloadRttLog() {
      const text = this._rttLog || '';
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rtt-log-${this.targetId}-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }

    /**
     * Reset the target while RTT is connected, then re-sync the host read cursor.
     * @param {'soft'|'hard'} [mode='soft']
     */
    async resetDevice(mode = 'soft') {
      if (!this._rttConnected || !this._rttProcessor) {
        throw new Error('RTT not connected');
      }
      const soft = mode !== 'hard';
      const softBtn = document.getElementById('nrf54-web-reset-soft-btn');
      const hardBtn = document.getElementById('nrf54-web-reset-hard-btn');
      if (softBtn) softBtn.disabled = true;
      if (hardBtn) hardBtn.disabled = true;
      try {
        this._uiLog(soft ? 'Soft reset...' : 'Hard reset...', 'info');
        this._appendRttText(soft ? '\n--- soft reset ---\n' : '\n--- hard reset ---\n');
        if (soft) {
          await this._rttProcessor.softReset();
        } else {
          await this._rttProcessor.reset();
        }
        await sleep(200);
        try { await this._rttProcessor.halt(); } catch (_) { /* */ }
        try { await this._rttHandler.resetUpBufferReadOffset(0); } catch (_) { /* */ }
        await this._rttProcessor.resume();
        await sleep(500);
        try { await this._rttHandler.resetUpBufferReadOffset(0); } catch (_) { /* */ }
        this._uiLog(soft ? 'Soft reset done' : 'Hard reset done', 'success');
      } catch (e) {
        this._uiLog(`Reset failed: ${e.message}`, 'error');
        this._appendRttText(`\n--- reset failed: ${e.message} ---\n`);
      } finally {
        if (softBtn) softBtn.disabled = false;
        if (hardBtn) hardBtn.disabled = false;
      }
    }

    // ---- Actions ------------------------------------------------------------

    async _beginInstall() {
      if (this._busy) return;
      if (!this.hex) {
        this.renderPage('ERROR', {
          message: 'No firmware HEX configured.',
          details: 'Pass a HEX URL/File to the constructor, or call setHex() first.'
        });
        return;
      }
      this.showModal();
      this.renderPage('INSTALLING', { progress: 0, label: 'Preparing...' });
      try {
        await this.flashFirmware(this.hex, { ui: true });
        this.renderPage('SUCCESS', { message: 'Firmware has been installed on your device.' });
      } catch (e) {
        this.renderPage('ERROR', { message: 'Install failed', details: e.message });
      }
    }

    async _beginRtt() {
      if (this._busy) return;
      this.showModal();
      this._rttLog = '';
      this.renderPage('CONNECTING_RTT', { message: 'Select CMSIS-DAP probe...' });
      try {
        await this.connectRtt({ ui: true });
        this.renderPage('RTT');
      } catch (e) {
        this.renderPage('ERROR', { message: 'RTT connection failed', details: e.message });
      }
    }

    /**
     * Mass-erase + flash Intel HEX + reset.
     * @param {string|File|Uint8Array} [hexOverride]
     * @param {object} [options]
     */
    async flashFirmware(hexOverride, options = {}) {
      if (this._busy) throw new Error('Busy');
      if (this._rttConnected) await this.disconnectRtt();
      this._busy = true;
      const target = this.getTarget();
      const source = hexOverride != null ? hexOverride : this.hex;
      if (source == null) throw new Error('No firmware HEX provided');
      const log = (msg, level) => this._uiLog(msg, level);
      const progress = (phase, pct) => {
        const label = phase === 'erase' ? 'Erasing device...'
          : phase === 'flash' ? 'Writing firmware...'
            : phase === 'done' ? 'Done' : phase;
        if (options.ui) this._uiSetProgress(phase, pct, label);
        else this.onProgress(phase, pct);
      };

      let dap = null;
      try {
        log(`Loading HEX for ${target.name}...`, 'info');
        if (options.ui) this._uiSetProgress('load', 0, 'Loading HEX...');
        const parsed = await loadHex(source);
        if (parsed.size > target.flashSize) {
          throw new Error(`Firmware (${parsed.size}) exceeds flash (${target.flashSize})`);
        }
        log(`HEX: ${parsed.size} bytes @ 0x${parsed.startAddress.toString(16)}`, 'info');

        log('Select CMSIS-DAP probe...', 'info');
        if (options.ui) this._uiSetProgress('connect', 0, 'Select CMSIS-DAP probe...');
        const { transport } = await selectCmsisDap({ skipProbeCheck: this.skipProbeCheck });

        dap = new global.DAPjs.ADI(transport);
        await dap.connect();
        log('DAP connected', 'success');

        await massErase(dap, target, log, progress);

        await dap.disconnect();
        await sleep(200);
        dap = new global.DAPjs.ADI(transport);
        await dap.connect();
        await sleep(200);

        await flashRRAMC(dap, target, parsed.data, parsed.startAddress, log, progress);
        await ctrlApReset(dap, target, log);
        log('Flash finished', 'success');
        progress('done', 100);
      } finally {
        try { if (dap) await dap.disconnect(); } catch (_) { /* */ }
        this._busy = false;
      }
    }

    /**
     * Connect RTT and start streaming.
     * @param {object} [options]
     */
    async connectRtt(options = {}) {
      if (this._busy) throw new Error('Busy');
      if (this._rttConnected) {
        return { ctrlAddr: this._rttHandler.rttCtrlAddr, numBufs: this._rttHandler.numBufUp };
      }
      this._busy = true;
      const target = this.getTarget();
      const knownAddress = options.knownAddress != null ? options.knownAddress : this.rttKnownAddress;
      const pollMs = options.pollMs || this.rttPollMs;
      const log = (msg, level) => this._uiLog(msg, level);

      try {
        log('Select CMSIS-DAP probe for RTT...', 'info');
        if (options.ui) {
          this.renderPage('CONNECTING_RTT', { message: 'Select CMSIS-DAP probe...' });
        }
        const { transport } = await selectCmsisDap({ skipProbeCheck: this.skipProbeCheck });
        const core = new global.DAPjs.CortexM(transport);
        await core.connect();
        this._rttProcessor = createReliableMemProcessor(core);
        log('DAP connected for RTT', 'success');

        if (options.ui) {
          this.renderPage('CONNECTING_RTT', { message: 'Scanning for RTT control block...' });
        }

        try { await this._rttProcessor.halt(); } catch (e) {
          log(`Halt warning: ${e.message}`, 'warning');
        }

        this._rttHandler = new RTTHandler(this._rttProcessor, {
          scanStartAddress: target.sramBase,
          scanRange: 0x20000,
          knownAddress
        });
        const numBufs = await this._rttHandler.init();
        if (numBufs < 0) {
          throw new Error('RTT control block not found (is this an RTT-enabled build?)');
        }
        log(`RTT CB @ 0x${this._rttHandler.rttCtrlAddr.toString(16)}`, 'success');

        if (options.ui) {
          this.renderPage('CONNECTING_RTT', { message: 'Resetting target and syncing...' });
        }

        try {
          await this._rttProcessor.softReset();
          await sleep(200);
          await this._rttProcessor.halt();
        } catch (e) {
          log(`Post-find reset warning: ${e.message}`, 'warning');
          try { await this._rttProcessor.halt(); } catch (_) { /* */ }
        }
        try { await this._rttHandler.resetUpBufferReadOffset(0); } catch (_) { /* */ }
        await this._rttProcessor.resume();
        await sleep(500);
        try { await this._rttHandler.resetUpBufferReadOffset(0); } catch (_) { /* */ }

        this._rttConnected = true;
        this._startRttPoll(pollMs);
        this.onRttConnected();
        log('RTT connected', 'success');
        return {
          ctrlAddr: this._rttHandler.rttCtrlAddr,
          numBufs: this._rttHandler.numBufUp
        };
      } catch (err) {
        await this._cleanupRtt();
        throw err;
      } finally {
        this._busy = false;
      }
    }

    async disconnectRtt() {
      if (!this._rttConnected && !this._rttProcessor) return;
      this._uiLog('Disconnecting RTT...', 'info');
      await this._cleanupRtt();
      this.onRttDisconnected();
      this._uiLog('RTT disconnected', 'info');
    }

    isRttConnected() {
      return this._rttConnected;
    }

    getRttLog() {
      return this._rttLog;
    }

    _startRttPoll(pollMs) {
      if (this._rttAbort) return;
      this._rttAbort = new AbortController();
      const signal = this._rttAbort.signal;
      const decoder = new TextDecoder();
      const loop = async () => {
        while (!signal.aborted) {
          try {
            if (this._rttHandler && this._rttConnected) {
              const data = await this._rttHandler.read(0);
              if (data.length > 0) {
                const text = decoder.decode(data);
                if (text) this._appendRttText(text);
              }
            }
          } catch (e) {
            if (!signal.aborted) this._uiLog(`RTT poll: ${e.message}`, 'warning');
          }
          await sleep(pollMs);
        }
      };
      loop();
    }

    async _cleanupRtt() {
      if (this._rttAbort) {
        this._rttAbort.abort();
        this._rttAbort = null;
      }
      this._rttConnected = false;
      this._rttHandler = null;
      try {
        if (this._rttProcessor) await this._rttProcessor.disconnect();
      } catch (_) { /* */ }
      this._rttProcessor = null;
    }

    injectStyles() {
      if (document.getElementById('nrf54-web-styles')) return;
      const style = document.createElement('style');
      style.id = 'nrf54-web-styles';
      style.textContent = `
        .nrf54-web-modal {
          display: none;
          position: fixed;
          z-index: 10000;
          left: 0; top: 0; width: 100%; height: 100%;
          background-color: rgba(0, 0, 0, 0.5);
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        }
        .nrf54-web-modal.show { display: flex; }
        .nrf54-web-modal-content {
          background: var(--card-background, #1e1e1e);
          border: 1px solid var(--border-color, #333);
          border-radius: 12px;
          padding: 0;
          max-width: 440px;
          width: 92%;
          max-height: 85vh;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
          display: flex;
          flex-direction: column;
          color: var(--foreground, #e0e0e0);
          position: relative;
          overflow: hidden;
        }
        .nrf54-web-headline { padding: 24px 24px 0 24px; position: relative; }
        .nrf54-web-headline h3 {
          margin: 0; padding-right: 48px;
          color: var(--foreground, #e0e0e0);
          font-size: 1.35rem; font-weight: 500;
        }
        .nrf54-web-close {
          position: absolute; right: 8px; top: 8px; z-index: 1000;
          color: var(--muted-foreground, #8b949e);
          font-size: 24px; font-weight: bold; cursor: pointer;
          line-height: 1; width: 40px; height: 40px;
          display: flex; align-items: center; justify-content: center;
          border: none; background: transparent; padding: 0;
        }
        .nrf54-web-close:hover { color: var(--foreground, #e0e0e0); }
        .nrf54-web-content { padding: 24px; flex: 1; overflow-y: auto; }
        .nrf54-web-actions {
          padding: 0 24px 24px 24px;
          display: flex; gap: 12px; flex-wrap: wrap;
        }
        .nrf54-web-welcome p { margin: 0 0 12px; line-height: 1.55; }
        .nrf54-web-instructions {
          text-align: left; margin-top: 8px;
          background: var(--card-background, #2a2a2a);
          border: 1px solid var(--border-color, #333);
          border-radius: 8px; padding: 16px;
        }
        .nrf54-web-instructions h4 { margin: 0 0 10px; font-size: 1rem; }
        .nrf54-web-instructions p { margin: 8px 0; color: var(--muted-foreground, #a0a0a0); font-size: 0.92rem; }
        .nrf54-web-note {
          margin-top: 12px; padding: 10px 12px;
          background: rgba(0, 191, 255, 0.1);
          border-left: 3px solid var(--accent, #00bfff);
          border-radius: 4px; font-size: 0.88rem;
          color: var(--foreground, #e0e0e0) !important;
        }
        .nrf54-web-progress-page, .nrf54-web-message-page {
          text-align: center; display: flex; flex-direction: column; align-items: center;
        }
        .nrf54-web-spinner {
          width: 48px; height: 48px;
          border: 4px solid var(--border-color, #333);
          border-top-color: var(--accent, #00bfff);
          border-radius: 50%;
          animation: nrf54-web-spin 1s linear infinite;
          margin-bottom: 16px;
        }
        @keyframes nrf54-web-spin { to { transform: rotate(360deg); } }
        .nrf54-web-details { font-size: 0.9rem; color: var(--muted-foreground, #a0a0a0); }
        .nrf54-web-message-icon {
          width: 56px; height: 56px; border-radius: 50%;
          background: rgba(63, 185, 80, 0.15); color: #3fb950;
          display: flex; align-items: center; justify-content: center;
          font-weight: 700; margin-bottom: 12px; letter-spacing: 0.04em;
        }
        .nrf54-web-error-details {
          margin-top: 12px; padding: 12px; width: 100%;
          background: rgba(248, 81, 73, 0.1);
          border-left: 3px solid #f85149; border-radius: 4px;
          font-size: 0.9rem; text-align: left; color: #f85149;
          word-break: break-word;
        }
        .nrf54-web-circular-progress {
          position: relative; width: 56px; height: 56px; margin: 0 auto 16px;
        }
        .nrf54-web-circular-progress svg {
          width: 100%; height: 100%; transform: rotate(-90deg);
        }
        .nrf54-web-circular-progress-track { stroke: var(--border-color, #333); }
        .nrf54-web-circular-progress-fill {
          stroke: var(--accent, #00bfff); stroke-linecap: round;
          transition: stroke-dashoffset 0.25s ease;
        }
        .nrf54-web-progress-text {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 600; transform: none;
        }
        .nrf54-web-rtt-page { width: 100%; }
        .nrf54-web-rtt-log {
          margin: 0; padding: 12px;
          background: #0d1117; border: 1px solid var(--border-color, #333);
          border-radius: 8px; min-height: 220px; max-height: 40vh;
          overflow: auto; white-space: pre-wrap; word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 12px; line-height: 1.45; text-align: left; color: #c9d1d9;
        }
        .nrf54-web-btn {
          flex: 1; min-width: 120px; padding: 12px 18px; border: none; border-radius: 8px;
          font-size: 14px; font-weight: 500; cursor: pointer; transition: all 0.2s;
        }
        .nrf54-web-btn-primary {
          background: var(--accent, #00bfff); color: var(--accent-button, #fff);
        }
        .nrf54-web-btn-primary:hover {
          background: var(--accent-hover, #0099cc);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 191, 255, 0.3);
        }
        .nrf54-web-btn-secondary {
          background: var(--card-background, #2a2a2a);
          color: var(--foreground, #e0e0e0);
          border: 1px solid var(--border-color, #333);
        }
        .nrf54-web-btn-secondary:hover {
          background: #333; border-color: var(--accent, #00bfff);
        }
        .nrf54-web-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
      `;
      document.head.appendChild(style);
    }
  }

  global.Nrf54WebTools = Nrf54WebTools;
})(typeof window !== 'undefined' ? window : globalThis);
