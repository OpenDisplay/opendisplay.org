// Agreement checks between the website's protocol code and py-opendisplay.
// Neither side is ground truth: the firmware is. A failure here is a finding to settle
// against the firmware source, recorded in tests/fixtures/divergences.md, not a reason
// to copy py-opendisplay blindly.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hex, newBle, toHex } from '../helpers/legacy.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/py-opendisplay.json', import.meta.url), 'utf8'));

// dither.js is an ES module that publishes window.OpenDisplayDither.
globalThis.window ??= { dispatchEvent() {} };
await import('../../httpdocs/js/dither.js');
const dither = globalThis.window.OpenDisplayDither;

// Cases where the two senders disagree on purpose or by a bug that isn't fixed yet. Each
// entry pins what the website does today and points to its write-up in divergences.md.
// Remove an entry when the disagreement is resolved.
const KNOWN = {
  'palette:35:8': { website: 'spectra73', see: 'D1' },
  'partial:1': { website: { aligned: [5, 2, 5, 1] }, see: 'D2' },
};

const MEASURED_IDS = { SPECTRA_7_3_6COLOR: 'spectra73', MONO_4_26: 'mono426', SOLUM_BWR: 'solumbwr', BWRY_3_97: 'bwry397' };

describe('encryption', () => {
  it.each(fx.crypto.map((c, i) => [i, c]))('session %i: key, id and encrypted commands', async (_, c) => {
    const ble = await newBle();
    const s = ble.encryptionSession;
    s.masterKey = hex(c.masterKey);
    await ble.deriveSessionKey(hex(c.clientNonce), hex(c.serverNonce));
    expect(toHex(s.sessionKey)).toBe(c.sessionKey);
    s.clientNonce = hex(c.clientNonce);
    s.serverNonce = hex(c.serverNonce);
    await ble.deriveSessionId();
    expect(toHex(s.sessionId)).toBe(c.sessionId);
    s.authenticated = true;
    for (const cmd of c.commands) {
      s.nonceCounter = cmd.counter;
      const wire = await ble.encryptCommand(hex(cmd.cmd + cmd.payload));
      expect(toHex(wire)).toBe(cmd.wire);
    }
  });
});

describe('panel palettes', () => {
  it.each(fx.palettes.measured.map((m) => [m.panel, m.scheme, m]))('panel %s scheme %i picks the same measured palette', (_, __, m) => {
    const ours = dither.paletteForPanel(m.panel, m.scheme);
    const known = KNOWN[`palette:${m.panel}:${m.scheme}`];
    expect(ours ? ours.id : null).toBe(known ? known.website : m.measured ? MEASURED_IDS[m.measured] : null);
  });
  it.each(fx.palettes.gray4Codes.map((g) => [g.panel, g]))('panel %s 4-gray codes', (_, g) => {
    expect(dither.wireMap(5, g.panel)).toEqual(g.codes);
  });
  it.each(fx.palettes.bwryCodes.map((g) => [g.panel, g]))('panel %s BWRY codes', (_, g) => {
    expect(dither.wireMap(3, g.panel)).toEqual(g.codes);
  });
});

// A stand-in for a canvas: encodeCanvasToByteData only reads its size and pixels.
const fakeCanvas = (w, h) => ({
  width: w,
  height: h,
  getContext: () => ({ getImageData: () => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) }),
});

describe('image encoding (palette indices → wire bytes)', () => {
  it.each(fx.encoding.map((e) => [e.scheme, e.panel, `${e.width}x${e.height}`, e]))('scheme %i panel %s %s', async (_, __, ___, e) => {
    const ble = await newBle();
    const bytes = ble.encodeCanvasToByteData(
      fakeCanvas(e.width, e.height), e.scheme, 0, null, null, e.panel,
      Uint8Array.from(e.indices), dither.wireMap(e.scheme, e.panel),
    );
    expect(toHex(bytes)).toBe(e.bytes);
  });
});

describe('partial updates', () => {
  it.each(fx.partial.map((p, i) => [i, p]))('case %i: bounding box, alignment, segment bytes', async (i, p) => {
    const ble = await newBle();
    const bbox = ble.computeBoundingRect(Uint8Array.from(p.old), Uint8Array.from(p.new), p.width, p.height);
    expect(bbox ? [...bbox] : null).toEqual(p.bbox);
    if (!p.bbox) return;
    const aligned = ble.alignPartialRect(...p.bbox, p.width, 8);
    const known = KNOWN[`partial:${i}`];
    if (known) {
      expect([...aligned]).toEqual(known.website.aligned);
      return;
    }
    expect([...aligned]).toEqual(p.aligned);
    const seg = ble.encodeMonoSegmentWire(Uint8Array.from(p.new), ...p.aligned, p.width);
    expect(toHex(seg)).toBe(p.segment);
  });
});

describe('config', () => {
  it('parses a config container serialized by py-opendisplay', async () => {
    const ble = await newBle();
    const parsed = ble.parseConfigBytes(hex(fx.config.bytes));
    expect(parsed.crcGiven).toBe(true);
    const display = parsed.packets.find((p) => p.id === 0x20).displayConfig;
    expect(display).toMatchObject(fx.config.display);
    const power = parsed.packets.find((p) => p.id === 0x04).powerOption;
    expect(power).toMatchObject(fx.config.power);
  });
});

describe('direct write end command', () => {
  it.each(fx.directWriteEnd.map((c) => [c.refreshMode, c.etag, c]))('refresh %i etag %s', async (_, __, c) => {
    const ble = await newBle();
    expect(ble.buildDirectWriteEndHex(c.refreshMode, c.etag).toLowerCase()).toBe(c.wire);
  });
});
