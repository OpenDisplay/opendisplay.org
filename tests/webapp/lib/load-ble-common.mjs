// Loads the UNMODIFIED httpdocs/js/ble-common.js classic script into a Node vm
// sandbox so its encoder can be exercised headlessly. Nothing here patches or
// alters the library — the sandbox only supplies the browser globals the script
// expects at load time.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const BLE_COMMON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../httpdocs/js/ble-common.js',
);

let cachedSandbox = null;

function buildSandbox() {
  const sandbox = {
    console,
    // Constructor defers its YAML schema load through setTimeout; dropping the
    // callback keeps the harness offline (schema is irrelevant to encoding).
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: { userAgent: 'node-spike-harness', bluetooth: undefined },
    document: { readyState: 'complete', addEventListener: () => {} },
    TextEncoder,
    TextDecoder,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = readFileSync(BLE_COMMON_PATH, 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ble-common.js' });
  return sandbox;
}

export function getSandbox() {
  if (!cachedSandbox) cachedSandbox = buildSandbox();
  return cachedSandbox;
}

// Fresh library instance per call (mirrors the app's per-connection isolation).
export function makeBleInstance() {
  const sandbox = getSandbox();
  return vm.runInContext('new OpenDisplayBLE()', sandbox);
}

// Minimal stand-in for an HTMLCanvasElement backed by an RGBA buffer — only the
// surface encodeCanvasToByteData() actually touches.
export function makeFakeCanvas(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`pixel buffer ${rgba.length} != ${width}x${height}x4`);
  }
  return {
    width,
    height,
    getContext: () => ({
      getImageData: (x, y, w, h) => {
        if (x !== 0 || y !== 0 || w !== width || h !== height) {
          throw new Error('harness canvas only supports full-frame getImageData');
        }
        return { data: rgba, width, height };
      },
    }),
  };
}
