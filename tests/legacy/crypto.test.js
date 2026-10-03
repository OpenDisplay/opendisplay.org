import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hex, newBle, toHex } from '../helpers/legacy.js';

// RFC 4493 section 4 test vectors (AES-128 key 2b7e1516…).
const CMAC_KEY = hex('2b7e151628aed2a6abf7158809cf4f3c');
const CMAC_MSG = hex(
  '6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51' +
  '30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710',
);
const CMAC_VECTORS = [
  [0, 'bb1d6929e95937287fa37d129b756746'],
  [16, '070a16b46b4d4144f79bdd9dd04a287c'],
  [40, 'dfa66747de9ae63030ca32611497c827'],
  [64, '51f0bebf7e3b9d92fc49741779363cfe'],
];

describe('aesCmac', () => {
  it.each(CMAC_VECTORS)('matches RFC 4493 for a %i-byte message', async (len, mac) => {
    const ble = await newBle();
    expect(toHex(await ble.aesCmac(CMAC_KEY, CMAC_MSG.slice(0, len)))).toBe(mac);
  });
});

// The firmware passes a 16-byte nonce (session id + counter); CCM uses its last 13 bytes.
const pad16 = (nonce13) => Uint8Array.from([0xee, 0xee, 0xee, ...nonce13]);

describe('aesCcmEncrypt / aesCcmDecrypt', () => {
  it('matches RFC 3610 packet vector #1', async () => {
    const ble = await newBle();
    const key = hex('c0c1c2c3c4c5c6c7c8c9cacbcccdcecf');
    const nonce = hex('00000003020100a0a1a2a3a4a5');
    const ad = hex('0001020304050607');
    const plaintext = hex('08090a0b0c0d0e0f101112131415161718191a1b1c1d1e');
    const out = await ble.aesCcmEncrypt(key, pad16(nonce), ad, plaintext, 8);
    expect(toHex(out.ciphertext)).toBe('588c979a61c663d2f066d0c2c0f989806d5f6b61dac384');
    expect(toHex(out.tag)).toBe('17e8d12cfdf926e0');
  });

  // Node's own AES-CCM is an independent oracle for the 12-byte tag the protocol uses.
  it.each([0, 1, 15, 16, 17, 100, 244])('agrees with node:crypto for %i plaintext bytes', async (len) => {
    const ble = await newBle();
    const key = randomBytes(16);
    const nonce = randomBytes(13);
    const ad = randomBytes(len % 3 === 0 ? 0 : 5);
    const plaintext = randomBytes(len);

    const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 12 });
    if (ad.length) cipher.setAAD(ad, { plaintextLength: len });
    const expected = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const expectedTag = cipher.getAuthTag();

    const out = await ble.aesCcmEncrypt(key, pad16(nonce), ad, plaintext, 12);
    expect(toHex(out.ciphertext)).toBe(toHex(expected));
    expect(toHex(out.tag)).toBe(toHex(expectedTag));

    const back = await ble.aesCcmDecrypt(key, pad16(nonce), ad, out.ciphertext, out.tag, 12);
    expect(toHex(back)).toBe(toHex(plaintext));
  });

  it('rejects a tampered tag', async () => {
    const ble = await newBle();
    const key = randomBytes(16);
    const nonce = pad16(randomBytes(13));
    const out = await ble.aesCcmEncrypt(key, nonce, new Uint8Array(0), randomBytes(20), 12);
    const tag = Uint8Array.from(out.tag);
    tag[0] ^= 1;
    await expect(ble.aesCcmDecrypt(key, nonce, new Uint8Array(0), out.ciphertext, tag, 12)).rejects.toThrow();
  });
});

describe('getCurrentNonce', () => {
  it('is the session id followed by the big-endian 64-bit counter', async () => {
    const ble = await newBle();
    ble.encryptionSession.sessionId = hex('0102030405060708');
    ble.encryptionSession.nonceCounter = 2 ** 40 + 0x0a0b;
    expect(toHex(ble.getCurrentNonce())).toBe('0102030405060708' + '0000010000000a0b');
  });
});

describe('constantTimeCompare', () => {
  it('compares contents and length', async () => {
    const ble = await newBle();
    expect(ble.constantTimeCompare(hex('0102'), hex('0102'))).toBe(true);
    expect(ble.constantTimeCompare(hex('0102'), hex('0103'))).toBe(false);
    expect(ble.constantTimeCompare(hex('0102'), hex('010203'))).toBe(false);
  });
});
