# Design/Plan: Web OD App (device list + canvas tools)

*Working design note, 2026-08-23. Companion to `od-app/docs/web-app-feasibility.md`.*

## 1. Summary

A new page at **`httpdocs/app/`** — the "OD App (Web)" — that brings od-app's two headline experiences to Chromium browsers:

1. **Device list** — persistent saved devices (IndexedDB + Web Bluetooth persistent permissions), one-tap reconnect, per-device keys.
2. **Canvas tools** — a composer (photo / draw / text / QR layers) with high-quality wasm dithering (`@opendisplay/epaper-dithering`) and live preview, uploading via the existing protocol library.

**Non-goals (explicit):**
- Does **not** replace or modify the existing Display Tool (`httpdocs/firmware/display/`) or any other tool. Both are linked from the site; the Display Tool remains the low-level tester.
- **No Toolbox functionality**: no config editing/writing, no hardware wizard, no firmware install, no security provisioning. The app performs a **read-only** config read (0x40) purely to learn resolution, color scheme, and transmission modes — it never sends 0x41/0x42.
- No DFU/OTA UI, no NFC/LED/buzzer controls, no raw hex tester (that's the Display Tool's job).

## 2. Placement, deployment, stack

**Repo facts this must respect** (verified):
- `httpdocs/` is deployed verbatim via FTP on GitHub release (`.github/workflows/deploy-ftp.yml` → `deploy-ftp-curl.sh`). No build step, no `package.json` anywhere in the repo.
- `httpdocs/js/ble-common.js` is the shared protocol library, vendored byte-for-byte into `od-app` and **SHA-256-pinned by od-app's build**. Any edit to it forces a coordinated od-app pin bump.

**Decisions:**
- **No bundler.** The app is native **ES modules** served as-is (every supported browser is Chromium ≥ recent — `import`/`import maps`/top-level await are all safe). This keeps the FTP deploy untouched.
- **`ble-common.js` is loaded unmodified** as a classic `<script>` (it is global-scope), exactly as the four existing tools do. All app logic lives in app-owned modules, mirroring how od-app confines its own code to `ble-app-adapter.js`.
- **`@opendisplay/epaper-dithering` is vendored as one file**: copy the package's prebuilt ESM bundle (inline wasm, zero runtime deps) to `httpdocs/app/vendor/epaper-dithering.mjs`. Record the version + upstream commit in a `vendor/README.md`; refresh manually on library releases (same spirit as the existing pinned ESP Web Tools vendor copy in `firmware/toolbox/js/`).
- Shared classic scripts reused: `js/ble-common.js`, `js/pako.js`, `js/opendisplay-msd.js`, `js/js-yaml.min.js` (ble-common needs it for the packet schema), `common.css`.

**Directory layout:**

```
httpdocs/app/
├── index.html            # shell: nav, device-list view, composer view
├── app.css
├── vendor/
│   ├── epaper-dithering.mjs
│   └── README.md         # version + provenance
└── js/
    ├── main.mjs          # boot, routing between views, capability gate
    ├── store.mjs         # IndexedDB wrapper (devices, drafts)
    ├── devices.mjs       # device-list controller: getDevices() sweep, connect, re-pair
    ├── ble-adapter.mjs   # thin app-owned facade over the global bleLib instance
    ├── keys.mjs          # per-device PSK store + generate/export/import
    ├── composer/
    │   ├── model.mjs     # layer model, normalized coords, undo stack
    │   ├── canvas.mjs    # interactive editing surface (pointer events)
    │   ├── tools.mjs     # photo / draw / text / QR tools
    │   ├── render.mjs    # composite at panel resolution
    │   └── dither.mjs    # wasm pipeline + preview + palette paint-back
    └── ui/               # small view helpers (device card, toasts, dialogs)
```

## 3. Architecture

Four layers, strict downward dependencies:

```
UI (index.html + ui/*)                 — views, no protocol knowledge
Controllers (devices.mjs, composer/*)  — flows, state machines
Adapter (ble-adapter.mjs, store.mjs, keys.mjs)
Shared platform (ble-common.js, pako, epaper-dithering.mjs, opendisplay-msd.js)
```

**`ble-adapter.mjs` is the only module that touches `bleLib`.** It exposes typed promise-based operations the app needs and nothing more:
`connect(opts)`, `disconnect()`, `readDeviceInfo()` (0x43 firmware + 0x44 MSD + 0x40 config → `{width, height, colorScheme, transmissionModes, partialUpdateSupport, panelIcType, firmware, msd}`), `sendCanvas(canvas, colorScheme, opts)` (wraps `sendCanvasToDisplay` with progress callbacks), `setKeyProvider(fn)`.

**Key-provider hook:** ble-common's auth path falls back to a `prompt()` for the 32-hex key. The adapter pre-seeds the key from `keys.mjs` before connecting (ble-common accepts a programmatically supplied key via its existing key plumbing; the adapter sets it the same way the Toolbox does from URL params — without ever putting keys in URLs). If auth fails with the stored key, the UI shows a proper key dialog and updates the store. **No change to ble-common.js is required for any of this.**

## 4. Data model (IndexedDB)

Database `od-app`, version 1, `navigator.storage.persist()` requested on first write. All access via `store.mjs` with try/catch and empty-DB-is-valid semantics.

**Store `devices`** (keyPath `bleId`):

```js
{
  bleId,                 // BluetoothDevice.id (stable per origin+profile)
  name,                  // last known GAP name
  width, height,         // from config read
  colorScheme,           // wire value 0–6
  transmissionModes,     // bitmask from config (compression/PIPE gates)
  partialUpdateSupport,
  panelIcType,
  resolutionConfirmed,   // od-app rule: true only after a real 0x40 read
  firmwareVersion,
  msdSnapshot,           // decoded battery/sensors from last 0x44
  hasKey,                // boolean; key bytes live in the `keys` store
  lastSeen,              // epoch ms
  createdAt
}
```

**Store `keys`** (keyPath `bleId`): `{ bleId, psk: ArrayBuffer }`. Separate store so `devices` can be exported wholesale without keys; key export is a distinct, deliberate action (JSON or QR). Threat model note: origin-readable, wiped with site data — export/backup is therefore first-class UI, and keys never appear in URLs.

**Store `drafts`** (keyPath `id`): serialized composer documents `{ id, bleId?, layers[], updatedAt, thumbnail(Blob) }` so a composition survives reload. Layer coords are normalized 0…1 (od-app's model), so a draft is portable across panels.

A device row whose `bleId` is absent from `navigator.bluetooth.getDevices()` renders as **"needs re-pairing"**: the record is kept; the next `requestDevice()` grant is re-linked to it by matching (name, width×height) with user confirmation, then the row's `bleId` is rewritten.

## 5. Feature spec A — Device list

**View:** card grid. Each card: name, panel size/scheme badge, battery/temperature from `msdSnapshot`, lastSeen, lock icon if `hasKey`, status chip (*reachable / needs re-pairing / connected*). Actions: **Connect**, **Open composer**, **Forget** (removes row + key + calls `device.forget()` when available), overflow: export, rename.

**Flows:**
1. **Startup sweep:** `getDevices()` → partition saved rows into reachable / needs-re-pairing. No connections are opened automatically.
2. **Add device:** button → `ensureWebBluetoothAvailable()` (reuse `OpenDisplayBrowser` helper) → `bleLib` chooser via the existing multi-attempt `requestDevice` ladder → connect → auth if 0xFE (key dialog; offer "save key") → `readDeviceInfo()` → upsert row with `resolutionConfirmed: true`. A device cannot be saved without a successful config read (od-app invariant).
3. **Reconnect:** cached-device path (`useCachedDevice`) — no chooser, works while the device advertises. Failure → toast with "device must be awake/advertising" guidance; deep-sleeping tags need their wake behavior, same caveat the Toolbox reconnect loop has.
4. **Refresh info:** on every successful connect, re-read 0x43/0x44/0x40 and update the row (cheap, keeps `transmissionModes` honest across firmware updates).
5. **Export/import:** JSON file of `devices` rows (no keys) via download/file-input; keys exported separately and explicitly.

## 6. Feature spec B — Canvas tools (composer)

**Document model** (`composer/model.mjs`): ordered layer list over a fixed panel-aspect artboard; all geometry normalized 0…1; undo/redo as an immutable-snapshot stack (bounded, ~50 entries).

Layer types (matching od-app's ComposerView scope):
- **photo** — source `Blob` + crop/fit mode + adjustments `{exposure, saturation, shadows, highlights, toneStrength}`. Import via file picker, drag-drop, and paste. EXIF orientation handled by decoding through `createImageBitmap(blob, {imageOrientation: 'from-image'})`. Keep the full-res original; edit against a ≤1600 px proxy (od-app's pattern).
- **stroke** — freehand polyline, palette color, width.
- **text** — string, size, palette color, drag-to-position.
- **qr** — URL → QR matrix rendered as crisp modules (reuse the site's existing `/l/` QR generator code), drag/scale.

**Render pipeline** (`render.mjs` + `dither.mjs`), all in a Web Worker via `OffscreenCanvas` so the UI never janks:

```
layers → composite at panel resolution (w×h RGB)
       → epaper-dithering wasm: ditherImage(pixels, scheme/measured palette,
           {mode, serpentine: true, exposure/saturation/shadows/highlights/tone/gamut})
       → PaletteImageBuffer {indices, palette}
       → paint-back: index → IDEAL wire-palette RGB onto an OffscreenCanvas
       → (preview) index → MEASURED palette RGB for a faithful on-screen look
```

The **paint-back trick is the load-bearing decision**: `sendCanvasToDisplay()` encodes whatever pixels are on the canvas by nearest-color detection, so handing it a canvas containing exact ideal-palette RGB values makes its encoding lossless and byte-identical to od-app's packing — with **zero changes to `ble-common.js`** and its od-app SHA pin. ble-common's own naive `applyDithering` is simply never called. Its wire-order remapping (e.g. 6-color `[0,1,6,5,3,2]`), compression gating (`transmissionModes`), PIPE-vs-direct selection, encryption chunk sizing, and partial-update tracking all come for free.

**Dither controls:** mode (the 8 shared modes; default Burkes, matching library default), measured-palette toggle (default on for preview fidelity), tone/gamut `'auto'` for photos, live preview debounced ~150 ms after any change.

**Send flow:** connect (or reuse live connection) → render final canvas at panel resolution → `sendCanvas(canvas, colorScheme, {transmissionModes, partialUpdateSupport, panelIcType, onProgress})` → progress bar with bytes/percent → completion state distinguishes *transfer complete* from *panel refreshed* (the 0x73 refresh event arrives later; surface both, as od-app does).

**Out of scope for v1 canvas:** ODL export (the Visual Designer owns ODL), templates, multi-page, scheme-7 (add when the encoder gains it).

## 7. Shared-code contract

- `httpdocs/js/ble-common.js` is **not modified** by this project. If a future need arises (none identified), it is a separate coordinated change: edit → od-app vendoring + SHA pin update in the same release window.
- `vendor/epaper-dithering.mjs` is refreshed only from tagged `@opendisplay/epaper-dithering` releases; version recorded in `vendor/README.md`.
- The app claims no protocol constants of its own; anything protocol-shaped it needs must already be exposed by `ble-common.js` or the config read.

## 8. Milestones

**M0 — Skeleton + gate (1–2 d).** `httpdocs/app/` shell, nav link from `index.html`, `OpenDisplayBrowser` capability gate with the site's standard unsupported-browser messaging, empty device-list view, module scaffolding.

**M1 — Device list (3–5 d).** `store.mjs` (IndexedDB, persist(), migrations), `keys.mjs`, `ble-adapter.mjs` connect/readDeviceInfo, add-device flow, startup sweep, reconnect, re-pair linking, forget, export/import. *Exit: a locked and an unlocked device can each be saved, disconnected, and reconnected across a browser restart without a chooser.*

**M2 — Composer core (4–6 d).** Layer model + undo, editing surface, photo import with proxy + adjustments, stroke/text/qr tools, drafts persistence. Preview initially undithered. *Exit: a composition survives reload and renders correctly at panel resolution for 3 different panel geometries.*

**M3 — Dither + send (3–4 d).** Vendor wasm bundle, worker pipeline, measured-palette preview, paint-back, send flow with progress, verify against a real device on: mono, BWR, BWRY, 6-color, 4-gray, 16-gray; compressed and uncompressed; encrypted and plaintext; PIPE and direct-write fallback. *Exit: byte-level A/B — packed payload for a fixed test image matches od-app's packing (compare via the device or a captured log).*

**M4 — Polish + release (2–3 d).** Empty states, error toasts mapped from ble-common error strings, Bluefy sanity pass (best-effort; document limitations), CHANGELOG entry, release via existing release-please flow.

Total: **~3 working weeks** for one engineer familiar with the codebase.

## 9. Testing

- **Unit (dev-only, not deployed):** a root-level `package.json` with vitest, testing the pure modules only — `composer/model.mjs` geometry/undo, `store.mjs` against `fake-indexeddb`, re-pair matching logic, dither paint-back index→RGB mapping. `httpdocs/` deploy remains build-free; CI gets a `test-webapp.yml` job.
- **Golden-image:** fixed PNG + fixed dither settings → assert `indices` hash matches a checked-in snapshot generated by the Python/Rust reference (`epaper-dithering` cross-language parity already exists upstream).
- **Manual matrix per release:** Chrome + Edge on desktop, Chrome on Android; one nRF52840 and one ESP32-S3 tag; locked + unlocked; PIPE-capable + legacy-direct-write firmware.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `getDevices()` behavior differences across Chromium versions/platforms | Feature-detect; the app degrades to chooser-per-connect, which is exactly today's Display Tool UX |
| Paint-back mismatch (canvas color-space munging, e.g. display-P3 profiles altering pixel values) | Create contexts with `{colorSpace: 'srgb', willReadFrequently: true}`; M3 exit criterion is a byte-level A/B against od-app packing |
| Deep-sleeping tags unreachable for "reconnect" | Copy Toolbox's retry loop + user guidance; show `lastSeen` so stale rows are legible |
| Site-data wipe destroys keys | Key export/QR backup is first-class in M1, and the lock icon nags when a key has never been exported |
| Scope creep toward Toolbox | The adapter simply has no config-write method; PRs adding 0x41/0x42 to `httpdocs/app/` are rejected by convention stated here |

## 11. Feature matrix

Definitive in/out list. Entries marked ✻ amend earlier sections — they incorporate findings from an external design review (2026-08-23): rotation carried end-to-end, scheme 8 added / scheme 7 fails closed, key entry-only (no generation), device records keyed on an immutable `recordId` with `bleId` as a rebindable permission handle. "Internal" = capability used by the app with no UI exposed.

### Device list & connectivity

| Feature | Status | Notes |
|---|---|---|
| Saved device list (persistent) | ✅ In | ✻ IndexedDB records with immutable `recordId`; `bleId` is a rebindable binding |
| Add device via chooser | ✅ In | `requestDevice()` ladder from `ble-common.js` |
| Silent reconnect to known device | ✅ In | `getDevices()` + cached-device path; device must be advertising |
| Re-pair after permission loss | ✅ In | ✻ user-confirmed rebinding to an existing record (never automatic for keyed devices) |
| Rename / forget / export / import devices | ✅ In | Key export separate and explicit |
| Locked devices (auth, key entry, key storage) | ✅ In | ✻ enter/import an existing key only; `setEncryptionKey()` + `authenticate()` with app-owned retry dialog |
| Key generation / device locking | ❌ Out | Provisioning is a config write — Toolbox territory |
| Pre-connection scan list with live telemetry | ❌ Out | No page-rendered scan list in Web Bluetooth; telemetry shown post-connect (0x44) |
| Firmware version / MSD / panel info on device card | ✅ In | Refreshed each connect |
| Multiple simultaneous connections | ❌ Out | One active connection |
| Background operation | ❌ Out | Browser limitation |

### Canvas / composer

| Feature | Status | Notes |
|---|---|---|
| Photo import (picker, drag-drop, paste) + adjustments | ✅ In | Exposure/saturation/shadows/highlights/tone via wasm pipeline |
| Freehand drawing | ✅ In | Palette colors, stroke width |
| Text overlays | ✅ In | Drag, size, palette color |
| QR codes | ✅ In | ✻ worker-safe QR matrix generator (the site's `/l/qrcode.js` is DOM-bound and cannot run in a worker) |
| Layers, undo/redo, drafts across reloads | ✅ In | ✻ asset-referenced storage (blobs stored once, snapshots reference them) |
| High-quality dithering (8 modes, OKLab, serpentine) | ✅ In | `@opendisplay/epaper-dithering` wasm |
| Measured palettes + faithful preview | ✅ In | Measured RGB for preview only; ideal RGB for encoding paint-back |
| Panel rotation | ✅ In | ✻ carried in device record and passed to `sendCanvasToDisplay` as the Display Tool does |
| Color schemes 0–6 and 8 | ✅ In | ✻ scheme 8 (BWGBRY_SPLIT) already supported by the shared encoder |
| Color scheme 7 (7-color Spectra) | ❌ Out | ✻ hard-rejected — fails closed (the encoder otherwise falls through to mono) |
| Upload: direct-write, PIPE, compression, encryption | ✅ In | Inherited from unmodified `ble-common.js` |
| Partial updates | ⚙️ Inherited | Mono only, via `ble-common.js` etag tracking; no dedicated UI |
| ODL export / templates | ❌ Out | Visual Designer owns ODL |

### Toolbox (excluded by scope)

| Feature | Status | Notes |
|---|---|---|
| Config read (0x40) | ⚙️ Internal | Resolution, scheme, rotation, transmission modes only |
| Config editor / write (0x41/0x42) | ❌ Out | Adapter has no write method |
| Hardware wizard / presets / WiFi / security provisioning | ❌ Out | |
| USB firmware install | ❌ Out | |
| Share-config URLs | ❌ Out | |

### Low-level device controls (Display Tool keeps these)

| Feature | Status | Notes |
|---|---|---|
| Reboot / deep sleep / power off / enter-DFU | ❌ Out | Revisitable later at low cost (one-line adapter calls) |
| LED / buzzer / NFC | ❌ Out | |
| Raw hex tester + traffic log | ❌ Out | |
| BLE DFU/OTA firmware transfer | ❌ Out | Unwired in every client today |

### Platform reach

| Platform | Status |
|---|---|
| Chrome/Edge/Opera/Samsung Internet — desktop & Android | ✅ Supported |
| Safari (macOS/iOS/iPadOS), Firefox | ❌ Unsupported (no Web Bluetooth) |
| iOS via Bluefy | ⚠️ Best-effort, untested tier |
