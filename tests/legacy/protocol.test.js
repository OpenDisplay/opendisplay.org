// Characterization tests for ble-common.js protocol helpers that py-opendisplay has no
// counterpart for, or where the website's own data files are the input.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hex, loadBleCommon, newBle } from '../helpers/legacy.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/py-opendisplay.json', import.meta.url), 'utf8'));
const presets = JSON.parse(readFileSync(new URL('../../httpdocs/firmware/toolbox/simple-config-presets.json', import.meta.url), 'utf8'));

describe('config packet layout from config.yaml', () => {
  it.each(Object.entries(fx.packetSizes))('packet %s has the payload size py-opendisplay expects', async (id, size) => {
    const ble = await newBle();
    expect(ble.getPacketSize(parseInt(id, 16))).toBe(size);
  });

  it('places display fields at fixed offsets', async () => {
    const ble = await newBle();
    const offsets = ble.packetFieldOffsets[0x20];
    expect(offsets).toMatchObject({ instance_number: 0, display_technology: 1, panel_ic_type: 2, pixel_width: 4, pixel_height: 6 });
  });

  it('stops parsing at an unknown packet type instead of misreading the rest', async () => {
    const ble = await newBle();
    const body = [0, 0, 1, 0, 0xfe, 1, 2, 3];
    body[0] = body.length + 2;
    const crc = ble.crc16ccittOuter(Uint8Array.from(body));
    const parsed = ble.parseConfigBytes(Uint8Array.from([...body, crc & 0xff, crc >> 8]));
    expect(parsed.crcGiven).toBe(true);
    expect(parsed.packets).toEqual([]);
  });

  it('reports a bad CRC without throwing', async () => {
    const ble = await newBle();
    const bytes = hex(fx.config.bytes);
    bytes[bytes.length - 1] ^= 0xff;
    expect(ble.parseConfigBytes(bytes).crcGiven).toBe(false);
  });
});

describe('crc16ccitt', () => {
  it('is CRC-16/CCITT-FALSE (check value for "123456789" is 0x29B1)', async () => {
    const ble = await newBle();
    expect(ble.crc16ccitt(new TextEncoder().encode('123456789'))).toBe(0x29b1);
  });
});

describe('hex helpers', () => {
  it('round-trips bytes through hex', async () => {
    const ble = await newBle();
    const bytes = Uint8Array.from([0, 1, 0x7f, 0x80, 0xff]);
    expect(ble.bytesToHex(bytes)).toBe('00 01 7F 80 FF');
    expect([...ble.hexToBytes('00 01 7f 80 FF')]).toEqual([...bytes]);
  });

  it('rejects odd-length hex with an empty result', async () => {
    const ble = await newBle();
    expect(ble.hexToBytes('abc').length).toBe(0);
  });

  it('writes little-endian numbers', async () => {
    const ble = await newBle();
    expect(ble.numToBytesLE(0x01020304, 4)).toEqual([4, 3, 2, 1]);
  });
});

describe('firmware update over BLE (OEPL block protocol)', () => {
  // Builds the parts the device would receive for one requested block.
  async function partsFor(imageHex, blockId) {
    const ble = await newBle();
    ble.sendNextDFUPart = () => {};
    await ble.sendDFUBlockData(blockId, imageHex);
    return ble.dfuState.packets.map((p) => hex(p));
  }

  it('splits a 4096-byte block into 230-byte parts with a header and checksum byte', async () => {
    const image = Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff);
    const imageHex = Buffer.from(image).toString('hex');
    const parts = await partsFor(imageHex, 0);

    // Block 0 = 4-byte header (length LE, 16-bit byte sum LE) + 4096 data bytes.
    expect(parts).toHaveLength(Math.ceil((4 + 4096) / 230));
    for (const [i, part] of parts.entries()) {
      expect(part).toHaveLength(3 + 230);
      expect(part[1]).toBe(0); // block id
      expect(part[2]).toBe(i); // part number
      const sum = part.slice(1).reduce((a, b) => a + b, 0) & 0xff;
      expect(part[0]).toBe(sum);
    }
    const payload = parts.flatMap((p) => [...p.slice(3)]);
    const sum = image.slice(0, 4096).reduce((a, b) => a + b, 0);
    expect(payload.slice(0, 4)).toEqual([4096 & 0xff, 4096 >> 8, sum & 0xff, (sum >> 8) & 0xff]);
    expect(payload.slice(4, 4 + 4096)).toEqual(image.slice(0, 4096));
    expect(payload.slice(4 + 4096).every((b) => b === 0)).toBe(true);
  });

  it('sends the short last block with its real length', async () => {
    const image = Array.from({ length: 5000 }, (_, i) => i & 0xff);
    const parts = await partsFor(Buffer.from(image).toString('hex'), 1);
    const payload = parts.flatMap((p) => [...p.slice(3)]);
    expect(payload[0] | (payload[1] << 8)).toBe(5000 - 4096);
    expect(parts.every((p) => p[1] === 1)).toBe(true);
  });

  it('reads the parts bitmap from a block request', () => {
    const { BlockRequest } = loadBleCommon();
    // checksum, 8-byte version (LE), block id, type, 6-byte parts bitmap
    const req = new BlockRequest('aa' + '0807060504030201' + '03' + '00' + 'f0000000000f');
    expect(req.blockId).toBe(3);
    expect(req.ver).toBe(0x0102030405060708n);
    expect(req.requestedParts.slice(0, 8)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(req.requestedParts.slice(-4)).toEqual([1, 1, 1, 1]);
  });
});

describe('simple-config presets', () => {
  const lib = loadBleCommon();

  it('maps every legacy ?config= preset to ids that exist in simple-config-presets.json', () => {
    const ids = (list) => new Set(list.map((x) => x.id));
    const boards = ids(presets.driverBoards);
    const displays = ids(presets.displays);
    const powers = ids(presets.powerOptions);
    const stems = ['nrf52840-en04', 'esp32-s3-ee04', 'reterminal-e1004', '73kit', 'ee02'];
    for (const stem of stems) {
      const t = lib.getPremadeLegacySimpleTriple(`/firmware/toolbox/presets/${stem}.json`);
      expect(t, stem).not.toBeNull();
      expect(boards.has(t.driverBoardId), `${stem} board ${t.driverBoardId}`).toBe(true);
      expect(displays.has(t.displayId), `${stem} display ${t.displayId}`).toBe(true);
      expect(powers.has(t.powerId), `${stem} power ${t.powerId}`).toBe(true);
    }
    expect(lib.getPremadeLegacySimpleTriple('nope')).toBeNull();
  });

  it('reads display size and color scheme, accepting hex or decimal sizes', () => {
    expect(lib.parseSimpleConfigPixelDimension('0x320')).toBe(800);
    expect(lib.parseSimpleConfigPixelDimension('480')).toBe(480);
    expect(lib.parseSimpleConfigPixelDimension('')).toBeNull();
    const layout = lib.getDisplayLayoutFromSimplePresetsDb(presets, 'ep73-spectra-800x480');
    expect(layout).toEqual({ width: 800, height: 480, colorScheme: 4 });
  });
});
