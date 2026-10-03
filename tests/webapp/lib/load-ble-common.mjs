// Loads the UNMODIFIED httpdocs/js/ble-common.js classic script (plus the real
// js-yaml, so the production schema parser runs) into a Node vm sandbox so its
// encoder and schema paths can be exercised headlessly. Nothing here patches
// the library — the sandbox only supplies the browser globals the script
// expects.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HTTPDOCS = join(dirname(fileURLToPath(import.meta.url)), '../../../httpdocs');

let cachedSandbox = null;
let fetchMode = 'httpdocs'; // 'httpdocs' | 'fail'

// Test hook: force schema fetches to fail (readiness retry tests).
export function setSandboxFetchMode(mode) {
  fetchMode = mode;
}

function sandboxFetch(path) {
  if (fetchMode === 'fail') {
    return Promise.resolve({ ok: false, status: 503, text: async () => '' });
  }
  try {
    const text = readFileSync(join(HTTPDOCS, path.replace(/^\//, '')), 'utf8');
    return Promise.resolve({ ok: true, status: 200, text: async () => text });
  } catch {
    return Promise.resolve({ ok: false, status: 404, text: async () => '' });
  }
}

function buildSandbox() {
  const sandbox = {
    console,
    // Constructor defers its own YAML load through setTimeout; dropping the
    // callback keeps init deterministic (tests await loadYAMLConfig directly).
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: { userAgent: 'node-spike-harness', bluetooth: undefined },
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    TextEncoder,
    TextDecoder,
    fetch: (path) => sandboxFetch(path),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const rel of ['js/js-yaml.min.js', 'js/ble-common.js']) {
    vm.runInContext(readFileSync(join(HTTPDOCS, rel), 'utf8'), sandbox, { filename: rel });
  }
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

// Runs the real boot-bridge.js in the sandbox and returns its bridge surface.
export function loadBootBridge() {
  const sandbox = getSandbox();
  const src = readFileSync(join(HTTPDOCS, 'app/v1/boot-bridge.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'app/v1/boot-bridge.js' });
  return { bridge: sandbox.odAppBridge, currentInstance: () => sandbox.odAppBle };
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
