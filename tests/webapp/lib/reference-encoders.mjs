// Independent reference implementation of the wire packing, ported from
// py-opendisplay (src/opendisplay/encoding/images.py, bitplanes.py,
// display_palettes.py) — the Python sender that the HA integration ships.
// Deliberately written from the numpy semantics, NOT from ble-common.js, so a
// byte-for-byte match between the two is a genuine cross-implementation proof.
//
// Inputs are palette-index arrays in NATIVE panel orientation, row-major,
// indices per the dither palette order for each scheme.

// np.packbits(mask, axis=1): each row packed MSB-first, zero-padded to a byte.
function packbitsRows(mask, width, height) {
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// encode_1bpp: any non-zero index = white bit, row-padded.
export function refMono(indices, w, h) {
  return packbitsRows(indices.map((i) => i > 0), w, h);
}

// encode_bitplanes BWR: plane1 = white|red (idx 1|2), plane2 = idx 2; concat.
export function refBwr(indices, w, h) {
  return concat(
    packbitsRows(indices.map((i) => i === 1 || i === 2), w, h),
    packbitsRows(indices.map((i) => i === 2), w, h),
  );
}

// encode_bitplanes BWY: plane1 = white only (idx 1), plane2 = idx 2 (yellow).
export function refBwy(indices, w, h) {
  return concat(
    packbitsRows(indices.map((i) => i === 1), w, h),
    packbitsRows(indices.map((i) => i === 2), w, h),
  );
}

// display_palettes.get_bwry_codes: identity except panels 0x1D/0x1E, whose
// native table swaps yellow/red on the wire.
export function bwryCodes(panelIcType) {
  if (panelIcType === 0x1d || panelIcType === 0x1e) return [0, 1, 3, 2];
  return [0, 1, 2, 3];
}

// encode_2bpp: 4 px/byte MSB-first, width zero-padded to a multiple of 4 per row.
export function refBwry(indices, w, h, codes = [0, 1, 2, 3]) {
  const cols = Math.ceil(w / 4) * 4;
  const out = new Uint8Array((cols / 4) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = codes[indices[y * w + x] & 0x03];
      const byteIdx = y * (cols / 4) + (x >> 2);
      out[byteIdx] |= v << (6 - (x & 3) * 2);
    }
  }
  return out;
}

// encode_4bpp core: 2 px/byte high-nibble-first, width zero-padded to even per row.
function pack4bppPlane(values, w, h) {
  const cols = Math.ceil(w / 2) * 2;
  const out = new Uint8Array((cols / 2) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = values[y * w + x] & 0x0f;
      const byteIdx = y * (cols / 2) + (x >> 1);
      out[byteIdx] |= x & 1 ? v : v << 4;
    }
  }
  return out;
}

const BWGBRY_LUT = [0, 1, 2, 3, 5, 6];

// encode_4bpp(bwgbry_mapping=True): dither indices 0..5 -> firmware 0,1,2,3,5,6.
export function refBwgbry(indices, w, h) {
  return pack4bppPlane(indices.map((i) => BWGBRY_LUT[i]), w, h);
}

// encode_4bpp(bwgbry_mapping=True, half_planes=True): left half-plane (all rows)
// then right half-plane; mid = width // 2.
export function refBwgbrySplit(indices, w, h) {
  const mapped = indices.map((i) => BWGBRY_LUT[i]);
  const mid = Math.floor(w / 2);
  const left = [];
  const right = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < mid; x++) left.push(mapped[y * w + x]);
    for (let x = mid; x < w; x++) right.push(mapped[y * w + x]);
  }
  return concat(pack4bppPlane(left, mid, h), pack4bppPlane(right, w - mid, h));
}

// display_palettes.get_gray4_codes: base (3,1,2,0); v2 (3,2,1,0) for 0x28/0x48.
export function gray4Codes(panelIcType) {
  if (panelIcType === 0x28 || panelIcType === 0x48) return [3, 2, 1, 0];
  return [3, 1, 2, 0];
}

// encode_gray4_bitplanes: level -> stored 2-bit code; plane0 = bit0, plane1 = bit1.
export function refGray4(indices, w, h, codes) {
  const stored = indices.map((i) => codes[i & 0x03]);
  return concat(
    packbitsRows(stored.map((c) => c & 1), w, h),
    packbitsRows(stored.map((c) => c & 2), w, h),
  );
}

// encode_4bpp identity: 16-gray indices 0..15 map straight through.
export function refGray16(indices, w, h) {
  return pack4bppPlane(indices, w, h);
}
