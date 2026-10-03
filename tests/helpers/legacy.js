// Loads the legacy browser scripts in httpdocs/js unchanged, so characterization tests pin
// today's behaviour before the code moves into src/lib. Each script runs in its own vm
// context that provides the few browser globals it touches.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HTTPDOCS = fileURLToPath(new URL('../../httpdocs/', import.meta.url));

// Top-level classes and consts in a classic script don't land on the global object, so
// this suffix hands them out explicitly.
const EXPORTS = `
globalThis.__legacy = {
  OpenDisplayBLE, BlockRequest, BlockPart, OpenDisplayBrowser,
  normalizeBluetoothUuid, bluetoothUuidShortLabel,
  getPremadeLegacySimpleTriple, parseSimpleConfigPixelDimension, getDisplayLayoutFromSimplePresetsDb,
  PARTIAL_UPDATE_NONE, PARTIAL_UPDATE_REGION, PARTIAL_UPDATE_FULL_FRAME,
};`;

/** Serves site-absolute paths (e.g. /firmware/toolbox/config.yaml) from httpdocs. */
async function fetchFromHttpdocs(path) {
  try {
    const text = readFileSync(HTTPDOCS + String(path).replace(/^\//, ''), 'utf8');
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404, text: async () => '', json: async () => null };
  }
}

let cached;

export function loadBleCommon() {
  if (cached) return cached;
  const context = vm.createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    fetch: fetchFromHttpdocs,
  });
  // js-yaml is a UMD bundle; in a vm context it attaches `jsyaml` to the context global.
  vm.runInContext(readFileSync(HTTPDOCS + 'js/js-yaml.min.js', 'utf8'), context);
  vm.runInContext(readFileSync(HTTPDOCS + 'js/ble-common.js', 'utf8') + EXPORTS, context, {
    filename: 'httpdocs/js/ble-common.js',
  });
  cached = context.__legacy;
  return cached;
}

/** A device object with the packet schema from config.yaml loaded, and logging silenced. */
export async function newBle() {
  const { OpenDisplayBLE } = loadBleCommon();
  const ble = new OpenDisplayBLE({ onLog: () => {} });
  await ble.loadYAMLConfig('/firmware/toolbox/config.yaml');
  return ble;
}

export const hex = (s) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
export const toHex = (bytes) => Buffer.from(bytes).toString('hex');
