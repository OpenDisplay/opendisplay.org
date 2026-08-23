# Design/Plan: Web OD App (device list + canvas tools)

*Working design note, 2026-08-23 (rev 3). Companion to `od-app/docs/web-app-feasibility.md`.*
*Rev 2 absorbed an external design review (Codex, 2026-08-23): rotation carried end-to-end, `recordId` identity model, schemes fail closed, key entry-only, corrected adapter API, spike-first encoder proof, browser integration tests, revised schedule. Rev 3 absorbs the re-review: rotation stored as quarter-turns, entrypoint-last deployment + immutable version dirs, shared-dependency compatibility CI, fail-closed spike outcomes (direct-uploader fallback cut from baseline), adapter lifecycle/timeout policy, two-phase rebind commit, explicit worker contract, QR core extracted not rewritten, reference-safe asset GC, named mandatory hardware exit set. Placement at repo root is deliberate (workspace-wide `DESIGN_*.md` convention). The reviewer's final pass returned **approve-with-conditions**; the conditions are incorporated: per-connection library-instance isolation (stale `encryptionSession`/`partialState` never crosses devices), current-`vN`-only support policy with a revalidating entry page, MIT header preserved in the extracted QR core, and honest platform-qualification labels.*

## 1. Summary

A new page at **`httpdocs/app/`** — the "OD App (Web)" — that brings od-app's two headline experiences to Chromium browsers:

1. **Device list** — persistent saved devices (IndexedDB + Web Bluetooth persistent permissions), one-tap reconnect, per-device keys.
2. **Canvas tools** — a composer (photo / draw / text / QR layers) with high-quality wasm dithering (`@opendisplay/epaper-dithering`) and live preview, uploading via the existing protocol library.

**Non-goals (explicit):**
- Does **not** replace or modify the existing Display Tool (`httpdocs/firmware/display/`) or any other tool. Both are linked from the site; the Display Tool remains the low-level tester.
- **No Toolbox functionality**: no config editing/writing, no hardware wizard, no firmware install, no security provisioning — including **no key generation** (a generated PSK is useless without the config write that provisions it; that is Toolbox territory). The app performs a **read-only** config read (0x40) purely to learn resolution, rotation, color scheme, and transmission modes — it never sends 0x41/0x42.
- No DFU/OTA UI, no NFC/LED/buzzer controls, no raw hex tester (that's the Display Tool's job).

## 2. Placement, deployment, stack

**Repo facts this must respect** (verified):
- `httpdocs/` is deployed via FTP on GitHub release (`.github/workflows/deploy-ftp.yml` → `deploy-ftp-curl.sh`, a manifest-diff upload that never deletes unknown remote files). No build step, no `package.json` anywhere in the repo.
- `httpdocs/js/ble-common.js` is the shared protocol library, vendored byte-for-byte into `od-app` and **SHA-256-pinned by od-app's build**. Any edit to it forces a coordinated od-app pin bump.

**Decisions:**
- **No bundler.** The app is native **ES modules** served as-is (all supported browsers are current Chromium). No build step is added; the only deployment change is the entrypoint-ordering fix below.
- **Module files use the `.js` extension** unless production MIME for `.mjs` is verified first (the server has never served a `.mjs`; a wrong `Content-Type` breaks module loading).
- **Cache/deploy coherence:** app assets live in a **versioned directory** (`httpdocs/app/v<N>/`) referenced from a thin `httpdocs/app/index.html`. FTP uploads are sequential and non-atomic, and the current script uploads in *sorted* order — `app/index.html` would go live before `app/v<N>/…`, exactly the 404 window versioning is meant to prevent. Therefore this project makes one **deploy-script change** (`deploy-ftp-curl.sh` is app infrastructure, not the protected library): partition `*.html` entrypoints and upload them **last**. Released `v<N>/` directories are **immutable** — any production asset change requires a new version — enforced by a CI check that rejects edits to an already-released version directory.
- **Shared-dependency compatibility:** the versioned app still loads the *unversioned* shared runtime (`js/ble-common.js`, `pako.js`, `js-yaml.min.js`, `opendisplay-msd.js`, `/firmware/toolbox/config.yaml`) — deliberately, to keep one shared protocol source rather than per-version forks. The compatibility contract: whenever any of those shared files changes, CI runs the Web App integration suite (§10) before release, and the app's use of them is confined to the adapter so breakage is localized and caught there. **Supported-version policy: only the current `vN` is supported.** CI tests exactly that version (enumerated explicitly in the workflow); older `vN/` dirs stay deployed only to close the mid-deploy window, and `app/index.html` is served with `Cache-Control: no-cache` (revalidate) so a cached entry never keeps pointing at a superseded version.
- **`ble-common.js` is loaded unmodified** as a classic `<script>`, exactly as the four existing tools do — with `js-yaml.min.js` loaded **before** it (as the Display Tool does), since its packet-schema loader needs it. All app logic lives in app-owned modules, mirroring how od-app confines its own code to `ble-app-adapter.js`.
- **Classic↔module bridge:** `OpenDisplayBLE` is a top-level class in a classic script, not a `window` export. A short classic bridge script publishes exactly **two** globals — `globalThis.odAppBle` (the current instance) and `globalThis.odAppBridge` (the factory: `renew()`) — and nothing else; ES modules consume both only via `ble-adapter.js`. **The bridge creates a fresh `OpenDisplayBLE` instance for every connection** (see §3 — per-connection isolation) and rebinds `odAppBle` to it; the name is stable, the instance is not. The bridge also **pins `autoReconnectEnabled` to false with a property definition** (library `connect()` re-enables a plain flag), keeping reconnection adapter-owned — instance configuration, not a library modification.
- **`@opendisplay/epaper-dithering` is vendored as the exact npm artifact**: the package's prebuilt ESM bundle (inline wasm, zero runtime deps) copied to `httpdocs/app/v<N>/vendor/epaper-dithering.js`, with `vendor/README.md` recording version, npm tarball SHA-256, and the MIT license text. Refresh only from tagged releases.
- Shared classic scripts reused: `js/ble-common.js`, `js/pako.js`, `js/opendisplay-msd.js`, `js/js-yaml.min.js`, `common.css`.

**Directory layout:**

```
httpdocs/app/
├── index.html            # thin entry: nav, view mounts, versioned asset refs
└── v1/
    ├── app.css
    ├── boot-bridge.js    # classic script: constructs OpenDisplayBLE → globalThis.odAppBle
    ├── vendor/
    │   ├── epaper-dithering.js
    │   └── README.md     # version + tarball SHA-256 + license
    └── js/
        ├── main.js       # boot, view routing, capability gate, schema readiness
        ├── store.js      # IndexedDB wrapper (devices, keys, drafts, assets)
        ├── devices.js    # device-list controller: permission sweep, connect, rebind
        ├── ble-adapter.js# the only module that touches odAppBle
        ├── keys.js       # per-device key store (entry/import/export; no generation)
        ├── composer/
        │   ├── model.js  # layer model, normalized coords, undo stack
        │   ├── canvas.js # interactive editing surface (pointer events)
        │   ├── tools.js  # photo / draw / text / QR tools
        │   ├── render.js # composite at panel resolution (rotation-aware)
        │   ├── qr.js     # worker-safe QR matrix generator (no DOM)
        │   └── dither.js # wasm pipeline + preview + ideal-palette paint-back
        └── ui/           # view helpers (device card, toasts, dialogs)
```

## 3. Architecture

Four layers, strict downward dependencies:

```
UI (index.html + ui/*)                 — views, no protocol knowledge
Controllers (devices.js, composer/*)   — flows, state machines
Adapter (ble-adapter.js, store.js, keys.js)
Shared platform (ble-common.js via odAppBle, pako, epaper-dithering, opendisplay-msd)
```

**`ble-adapter.js` is the only module that touches `odAppBle`.** Its surface:

- `ready()` — awaits the packet schema: explicitly calls `loadYAMLConfig('/firmware/toolbox/config.yaml')` (absolute path; works from `/app/`) and validates that display-packet offsets exist. ble-common's own deferred `setTimeout` load only logs on failure and must not be relied on; a schema failure fails the device-save flow visibly. **Schema state is instance-local**, so `ready()` is part of the instance factory: every fresh `OpenDisplayBLE` the bridge creates (startup *and* every post-disconnect replacement) awaits `loadYAMLConfig()` and validates the schema on that exact instance before `attachDevice`/`connect`/read operations become available on it — the adapter's state machine holds them until then. The YAML fetch after the first hits the HTTP cache, so this adds no meaningful reconnect latency.
- `attachDevice(bluetoothDevice)` — deliberately assigns the `getDevices()` handle as the library instance's cached device before the `useCachedDevice` connect path. This mutates a library-internal field; it is confined to this one function, documented as such, and covered by an integration test so a `ble-common.js` upstream change that breaks it is caught immediately. If it breaks, the app-side fix is to degrade that device to chooser-per-connect — not to modify the library. **`attachDevice` rejects while a connection is live**: switching devices requires a completed `disconnect()` first, so the library's cached device, connection flag, and characteristic never belong to different devices.
- **Lifecycle discipline:** all attach/connect/disconnect/send/read operations are serialized through one adapter state machine — one operation in flight, queued or rejected otherwise.
- **Per-connection isolation (required):** the library's `disconnect()` clears GATT and operation state but **not** `encryptionSession` or `partialState` — a stale authenticated session from locked device A would otherwise encrypt commands to device B (its `sendCommand` trusts the `authenticated` flag), and auth counters, nonces, replay windows, and partial-update etags would leak between devices. Therefore: after every completed disconnect the bridge **discards the instance and constructs a fresh `OpenDisplayBLE`**; the library's automatic reconnect is disabled, and all reconnection is explicit adapter-driven (attach → connect) on the fresh instance. **The adapter holds no direct reference to the instance** — it resolves `globalThis.odAppBle` at each operation's start, so a discarded instance cannot be used after a rebind (verified by an integration test asserting a post-rebind operation lands on the new instance).
- **Timeout policy:** several library operations (`readConfig()`, `readFirmwareVersion()`) arm callback state with **no response timeout** — a connected-but-silent device would hang them forever. Every adapter promise therefore carries a deadline; on expiry the adapter **disconnects** (letting the library's own `abortInFlightOperations()` clear its internal state safely — the adapter never mutates that state directly) and surfaces a timeout error.
- `connect(opts)` / `disconnect()` — connect does **not** imply auth; a locked device surfaces on the first protected operation (0xFE).
- `readDeviceInfo()` → `{width, height, rotationQuarterTurns, colorScheme, transmissionModes, partialUpdateSupport, panelIcType, firmware, msd}` (0x43 + 0x44 + 0x40). **Rotation is mandatory metadata, stored and passed as the wire value `0|1|2|3` (quarter-turns)** — the encoder interprets it that way; degrees (`× 90`) exist for UI display only. The Display Tool follows the same rule.
- `sendCanvas(canvas, colorScheme, {rotationQuarterTurns, originalWidth, originalHeight, transmissionModes, partialUpdateSupport, panelIcType, onProgress})` — passes the quarter-turn rotation and native dimensions exactly as the Display Tool does.
- **Auth:** `setKey(bytes)` → ble-common's `setEncryptionKey()`; `authenticate()` called directly with failures caught and surfaced. ble-common's `ensureAuthenticated()` `prompt()` fallback is never engaged — protected operations are wrapped so a 0xFE triggers the app-owned key dialog, one `authenticate()`, and one replay of the original operation, respecting the library's 10-attempts/60 s rate limit.
- `sendCanvas` rejects any `colorScheme` outside the supported set (§6) **before** touching the encoder — `encodeCanvasToByteData()` fails open (unknown schemes fall through to the mono branch).

## 4. Data model (IndexedDB)

Database `od-app`, version 1, `navigator.storage.persist()` requested on first write — treated as a request that may be denied, not a guarantee. All access via `store.js` with try/catch and empty-DB-is-valid semantics; quota errors surface as UI, not silent failures.

**Identity model:** every saved device has an app-owned, immutable **`recordId`** (random UUID). `BluetoothDevice.id` (`bleId`) is a **replaceable permission binding**, not the identity — it changes when permissions are re-granted. Keys and drafts reference `recordId`, so rebinding never orphans them.

**Store `devices`** (keyPath `recordId`):

```js
{
  recordId,              // immutable app identity (UUID)
  bleId,                 // current BluetoothDevice.id binding; null if unbound
  name,
  width, height,         // native panel pixels, from config read
  rotationQuarterTurns,  // wire value 0|1|2|3, from config read — REQUIRED for send
  colorScheme,           // wire value
  transmissionModes, partialUpdateSupport, panelIcType,
  resolutionConfirmed,   // true only after a real 0x40 read (od-app rule)
  authRequired,          // lock state: set on 0xFE; CLEARED when a protected
                         // read later succeeds without auth (device was unlocked)
  firmwareVersion, msdSnapshot,
  lastSeen, createdAt
}
```

**Store `keys`** (keyPath `recordId`): `{ recordId, psk: ArrayBuffer, exportedAt }`. `authRequired` (device is locked) and "we hold a key" are independent facts and stored separately; `exportedAt` (null until first export) backs the un-exported-key nag. Key export (JSON/QR) is a distinct deliberate action; keys never appear in URLs. **v1 has no key generation** — entry and import only.

**Store `drafts`** (keyPath `id`): `{ id, recordId?, layers[], updatedAt, thumbnailAssetId }`.
**Store `assets`** (keyPath `assetId` = content hash): image blobs stored **once**; layers, undo snapshots, and thumbnails hold `assetId` references, never blob copies. Bounded undo (~50 entries) is cheap because snapshots are structure-only. Because content-addressed assets can be **shared across drafts**, deletion is reference-safe: a periodic **mark-and-sweep** over every draft/thumbnail reference (run after draft delete and on idle startup) removes only unreachable assets — never delete-on-draft-delete directly. Crash-orphaned assets (created but never referenced) are swept the same way. Tested: shared assets, photo replacement, failed transactions, deleting one of several referencing drafts.

**Rebinding flow** (permission lost / `bleId` absent from `getDevices()`): the row shows **"permission missing"**. Two-phase commit:
1. *Propose:* on the next `requestDevice()` grant, hold the candidate handle in memory. The app suggests matching saved records by (name, resolution) as a *suggestion only* — the user confirms which record is being rebound **before** any stored key is tried (a locked device won't yield its resolution pre-auth, so matching cannot be trusted, and names/resolutions repeat across tags).
2. *Validate, then commit:* authenticate (if keyed) and read config against the candidate, show the resulting identity metadata, and only on success write `devices.bleId` in a single transaction — keys and drafts follow automatically via `recordId`. **Any failure (wrong key, config mismatch, disconnect) preserves the previous binding untouched.** A stored PSK is never auto-transferred on an unconfirmed match. Rollback on failed auth/config is a required test case.

## 5. Feature spec A — Device list

**View:** card grid. Each card: name, panel size/scheme/rotation badge, battery/temperature from `msdSnapshot`, lastSeen, lock icon when `authRequired`, and a status chip with honest semantics: **permission available / permission missing / connected**. (`getDevices()` proves a permission grant, not that the tag is awake or in range — "reachable" is only claimable after a successful GATT connection.) Actions: **Connect**, **Open composer**, **Forget** (removes row + key + drafts link + calls `device.forget()` when available), overflow: export, rename.

**Flows:**
1. **Startup:** `await adapter.ready()` (schema), then `getDevices()` sweep → bind rows to handles, set permission chips. No connections are opened automatically. If `getDevices` itself is unavailable, all rows degrade to chooser-per-connect (today's Display Tool UX) rather than "permission missing".
2. **Add device:** button → `ensureWebBluetoothAvailable()` (reuse `OpenDisplayBrowser` helper) → chooser via the existing multi-attempt `requestDevice` ladder → connect → on 0xFE: key dialog (offer "save key") → `readDeviceInfo()` → create record with fresh `recordId`, `resolutionConfirmed: true`. A device cannot be saved without a successful config read.
3. **Reconnect:** `attachDevice(handle)` → cached-device connect. Failure → toast with "device must be awake/advertising" guidance (deep-sleeping tags need their wake behavior; show `lastSeen` so stale rows are legible).
4. **Refresh info:** every successful connect re-reads 0x43/0x44/0x40 and updates the row (keeps `rotation`/`transmissionModes` honest across firmware changes).
5. **Export/import:** JSON of `devices` rows (no keys); keys exported separately and explicitly, with a nag on the lock icon while a held key has never been exported.

## 6. Feature spec B — Canvas tools (composer)

**Document model** (`composer/model.js`): ordered layer list over a fixed artboard; all geometry normalized 0…1; undo/redo as bounded structure-only snapshots referencing the `assets` store. **The artboard uses the panel's rotated logical dimensions** (e.g. a 800×480 panel at `rotationQuarterTurns=1` composes as 480×800); at send time the canvas plus `rotationQuarterTurns`/`originalWidth`/`originalHeight` go to the encoder exactly as the Display Tool does.

Layer types (matching od-app's ComposerView scope):
- **photo** — `assetId` + crop/fit + adjustments `{exposure, saturation, shadows, highlights, toneStrength}`. Import via file picker, drag-drop, paste. EXIF orientation via `createImageBitmap(blob, {imageOrientation: 'from-image'})`. Full-res original retained as an asset; editing works against a ≤1600 px proxy (od-app's pattern).
- **stroke** — freehand polyline, palette color, width.
- **text** — string, size, palette color, drag-to-position.
- **qr** — URL → matrix from `composer/qr.js`, which is the **DOM-free encoding core extracted from the site's existing MIT `/l/qrcode.js`** (its model/ECC/masking logic is DOM-independent; only its rendering uses `document`/`window`) — QR encoding is **not** rewritten from scratch. `composer/qr.js` **retains the upstream MIT copyright header** and records the source file and its hash at extraction time. Rendered as crisp modules, drag/scale. Tested per §10 (ECC levels, capacity boundaries, Unicode, independent-decoder round-trip).

**Render pipeline** — split across the worker boundary deliberately:

```
[worker]  layers → composite at panel resolution (OffscreenCanvas, {colorSpace:'srgb'})
        → epaper-dithering wasm: ditherImage(pixels, scheme/measured palette,
            {mode, serpentine: true, exposure/saturation/shadows/highlights/tone/gamut})
        → PaletteImageBuffer {indices, palette}
        → postMessage: transfer indices (+ preview ImageData painted in MEASURED RGB)
[main]    paint-back: indices → IDEAL wire-palette RGB as opaque ImageData (alpha 255)
            onto a fresh main-thread canvas ({colorSpace:'srgb', willReadFrequently:true})
        → adapter.sendCanvas(canvas, colorScheme, {rotationQuarterTurns, ...})
```

The worker never touches `ble-common.js` (main-thread only); it returns indices, and the send canvas is constructed on the main thread. The preview uses measured-palette RGB for fidelity; **paint-back always uses the ideal wire palette** — never the measured RGB from the dither result.

**Worker message contract** (explicit): the worker does not open IndexedDB — the **main thread resolves `assetId`s to decoded `ImageBitmap`s** and transfers them in; the worker transfers its output buffers (indices, preview pixels) back rather than cloning. Every render request carries a **generation ID**; the main thread discards results older than the latest ID, and at most **one pending rerender** is queued (rapid edits coalesce). Transferred bitmaps are `close()`d after use. Rapid-edit coalescing is tested at the largest supported panel resolution.

**Paint-back correctness is proven by a spike before implementation (M-S below), not assumed.** The claim: canvas pixels holding exact ideal-palette RGB values make `encodeCanvasToByteData()`'s nearest-color classification lossless, so packing matches native byte-for-byte with zero `ble-common.js` changes — and its wire-order remapping, compression gating (`transmissionModes`), PIPE-vs-direct selection, encryption chunk sizing, and partial-update tracking all come for free. Verified hazards the spike must cover: the encoder ignores alpha (transparent/uninitialized pixels read as black — hence opaque ImageData end-to-end), canvas color-space munging (hence explicit sRGB contexts), rotation transforms, row-padded odd widths, and the panel-specific gray LUT (`panelIcType`).

**Supported color schemes: {0, 1, 2, 3, 4, 5, 6, 8}** (8 = BWGBRY_SPLIT, already in the shared encoder and Display Tool). **Anything else — including 7 — is hard-rejected in the adapter before encoding**, because the encoder fails open (unknown schemes silently fall through to the mono branch).

**Dither controls:** mode (8 shared modes; default Burkes, the library default), measured-palette toggle (default on for preview), tone/gamut `'auto'` for photos, preview debounced ~150 ms.

**Send flow:** connect (or reuse live connection) → render + paint-back → `sendCanvas(...)` with progress bar → completion distinguishes *transfer complete* from *panel refreshed* (the 0x73 refresh event arrives later; surface both, as od-app does).

**Out of scope for v1 canvas:** ODL export (the Visual Designer owns ODL), templates, multi-page, scheme 7 (until the shared encoder gains it — then it's a coordinated change).

## 7. Security posture (accepted, documented)

PSKs live in same-origin IndexedDB. The `/app/` path is **not** a security boundary: any script on `opendisplay.org` — including the other tools' inline JS — can read the database, and the site currently ships no CSP. This is an **accepted product-level trade-off**: the alternative (a separate origin) forfeits shared Web Bluetooth permission grants with the existing tools, which is the app's core UX. Mitigations shipped with v1: keys never in URLs, first-class key export/backup, vendored (not hot-linked) dependencies with recorded hashes. Optional hardening later: a site-wide CSP and passphrase-wrapped key storage — store separation alone is *not* treated as meaningful security.

## 8. Shared-code contract

- `httpdocs/js/ble-common.js` is **never modified by this project — hard constraint, no exceptions.** No planned change, fallback, or contingency in this document may be resolved by editing it (it is SHA-256-pinned by od-app's build; the coordination cost is out of bounds for this app). The one library-internal touch point (`attachDevice`'s cached-device assignment) is isolated in the adapter; every contingency degrades on the app side (see §11).
- `vendor/epaper-dithering.js` is refreshed only from tagged `@opendisplay/epaper-dithering` releases; version + tarball SHA-256 + license recorded in `vendor/README.md`.
- The app claims no protocol constants of its own; anything protocol-shaped must come from `ble-common.js` or the config read.

## 9. Milestones

**M-S — Spikes (gate for everything else, ~1 wk).**
(a) *Encoder proof:* construct opaque ImageData from canonical palettes, call the real `encodeCanvasToByteData()`, compare exact packed bytes against native fixtures (generated from od-app's packing or the Python reference) for every supported scheme, all four rotations, odd/row-padded widths, transparency and color-space round-trips, and both gray-LUT variants. Hard-reject check for scheme 7/unknown.
(b) *Saved-device/auth proof:* `getDevices()` → `attachDevice` → cached reconnect across a browser restart; locked-device flow via `setEncryptionKey`/`authenticate` with the wrap-and-replay pattern.
*Exit: both proofs green in a scratch page. Outcomes are **fail-closed**: a scheme/rotation/LUT combination that cannot be proven byte-exact is dropped from the supported set (rejected in the adapter like scheme 7), and scope is revisited — there is no compensating uploader in the baseline (see §11).*

**M0 — Skeleton (2 d).** `httpdocs/app/` + `v1/` layout, nav link, capability gate with the site's standard messaging, classic-script bridge (`odAppBle`), schema-readiness (`adapter.ready()`), empty device list. **Includes verifying entry-page caching on the production host**: confirm `app/index.html` is actually served with `Cache-Control: no-cache` (server config, not a repo file) — if the host is Apache, ship an `httpdocs/app/.htaccess` setting it; if the header cannot be controlled, fall back to a JS version check in the entry page that reloads when the deployed version marker changes.

**M1 — Device list (1 wk).** `store.js` (four stores, migrations, quota UX), `keys.js`, adapter connect/readDeviceInfo/auth-wrap, add-device, permission sweep, reconnect, confirmed rebinding, forget, export/import. *Exit: locked and unlocked devices each saved, disconnected, reconnected across browser restart without a chooser; permission-loss → rebind → keys/drafts intact.*

**M2 — Composer core (1–1.5 wk).** Layer model + undo + asset store, editing surface, photo import with proxy + adjustments, stroke/text/qr tools, drafts persistence. Preview initially undithered. *Exit: composition survives reload; renders correctly for 3 panel geometries including one rotated.*

**M3 — Dither + send (1 wk).** Vendor wasm bundle, worker pipeline, measured preview, paint-back (already proven by M-S), send flow with progress. *Exit: hardware pass on the qualification matrix (§10).*

**M4 — Hardening + release (0.5–1 wk).** Fault-path UX (bad key, rate limit, schema 404, disconnect mid-upload, denied persistence, quota), Bluefy best-effort pass, CHANGELOG, release via release-please.

Total: **~5 working weeks** for one engineer familiar with the codebase (was ~3 in rev 1; revised after review — the spike week and the fault/hardware surface were underestimated). Hardware qualification and browser-specific Web Bluetooth behavior — Android reconnect and deep-sleep cases in particular — are the schedule's principal risks; M3/M4 should front-load the Android smoke set rather than leaving it to the end.

## 10. Testing

- **Browser integration suite (primary):** headless Chromium (Playwright) serving `httpdocs/` as deployed, loading the real classic scripts + modules. Covers: exact packed bytes for schemes {0–6, 8} × all four quarter-turns × odd widths (fixtures from M-S), unsupported-scheme rejection, auth wrap-and-replay against a mocked characteristic, **silent-device timeouts** (connected but non-responding config/firmware reads → adapter deadline → disconnect-clears-state), connection-switch serialization (`attachDevice` rejected while connected), **per-connection isolation** (locked A → unlocked B, locked A → locked B with a different key, unexpected disconnect → explicit reconnect, mono partial upload A → B — all on fresh instances with no session/etag leakage), **fresh-instance schema readiness** (disconnect → replacement instance → immediate reconnect parses device info correctly with no timing delays), **rebind rollback** on failed auth/config, schema-load failure, IDB migrations, asset GC (shared assets, orphan sweep), quota errors. This suite also runs in CI **whenever any shared runtime file (`ble-common.js`, `pako.js`, `js-yaml.min.js`, `opendisplay-msd.js`, `config.yaml`) changes** — the shared-dependency compatibility contract from §2. Dev-only root `package.json` (Playwright + vitest); `httpdocs/` deploy remains build-free; CI jobs `test-webapp.yml` + the immutable-`vN/` guard.
- **Unit:** pure modules — `composer/model.js` geometry/undo, `store.js` against `fake-indexeddb`, paint-back index→RGB mapping; `qr.js` across ECC levels, capacity boundaries, and Unicode, with generated matrices round-tripped through an independent decoder.
- **Golden-image:** fixed PNG + settings → `indices` hash vs snapshots from the Rust/Python reference (cross-language parity exists upstream in `epaper-dithering`).
- **Hardware qualification:** two tiers with named fixtures.
  *Mandatory smoke set (every release, blocking):* Chrome desktop + Chrome Android × one nRF52840 tag and one ESP32-S3 tag, covering: mono compressed via PIPE, 6-color uncompressed direct-write, one locked-device upload, one rotated-panel (`rotationQuarterTurns≠0`) upload, one deep-sleep wake/reconnect.
  *Extended matrix (before initial release, and after any protocol-adjacent change):* every supported packing scheme {0–6, 8} qualified on at least one real panel, both gray-LUT variants, Edge desktop, {locked, unlocked} × {PIPE, legacy direct-write}. Scripted checklist in `docs/`; a scheme with no available panel is not shipped as supported (fail closed).

## 11. Risks

| Risk | Mitigation |
|---|---|
| Paint-back byte parity fails somewhere in the matrix | M-S spike is the gate; the failing combination **fails closed** (dropped from the supported set) and scope is revisited. `ble-common.js` is never modified. An app-owned uploader over `sendHexCommand()` is **not** a baseline contingency — `sendHexCommand` only writes (no ACK awaiting), so that path means re-implementing framing, ACK pacing, and notification routing: a separately designed, estimated, and tested project with an explicit exception to the no-protocol-constants rule, undertaken only by deliberate decision |
| `attachDevice` internal mutation breaks on a `ble-common.js` update | Confined to one adapter function; integration test catches it; app-side degradation to chooser-per-connect for that device |
| `getDevices()` behavior differences across Chromium versions/platforms | Feature-detect; degrade to chooser-per-connect (today's UX) |
| Deep-sleeping tags unreachable on "reconnect" | Toolbox-style retry + guidance; `lastSeen` on cards |
| Site-data wipe destroys keys | Entry-only keys are re-enterable; export/QR backup first-class; un-exported-key nag |
| Same-origin key exposure | Documented accepted trade-off (§7); CSP + passphrase-wrapping as later hardening |
| Mixed-version module graph during FTP deploy | Immutable versioned asset dirs; deploy script uploads HTML entrypoints last (script change, §2); CI guard on released `vN/` dirs |
| Old `vN/` code drifting against updated shared runtime (`ble-common.js`, schema) | Compatibility contract (§2): integration suite runs in CI on every shared-file change; shared-file access confined to the adapter |
| Quota exhaustion from photo assets | Content-hashed single-copy assets, structure-only undo, quota-error UX, GC on draft delete |
| Scope creep toward Toolbox | Adapter has no config-write method and no key generation; PRs adding 0x41/0x42 or provisioning to `httpdocs/app/` are rejected by convention stated here |

## 12. Feature matrix

Definitive in/out list. "Internal" = capability used by the app with no UI exposed.

### Device list & connectivity

| Feature | Status | Notes |
|---|---|---|
| Saved device list (persistent) | ✅ In | IndexedDB, immutable `recordId`, `bleId` as rebindable binding |
| Add device via chooser | ✅ In | `requestDevice()` ladder from `ble-common.js` |
| Silent reconnect to known device | ✅ In | `getDevices()` + `attachDevice` + cached path; device must be advertising |
| Re-pair after permission loss | ✅ In | User-confirmed rebinding; never automatic for keyed devices |
| Rename / forget / export / import devices | ✅ In | Key export separate and explicit |
| Locked devices (auth, key entry, key storage) | ✅ In | Enter/import existing key only; `setEncryptionKey()` + `authenticate()` with app-owned retry |
| Key generation / device locking | ❌ Out | Provisioning is a config write — Toolbox territory |
| Pre-connection scan list with live telemetry | ❌ Out | No page-rendered scan list in Web Bluetooth; telemetry post-connect (0x44) |
| Firmware version / MSD / panel info on device card | ✅ In | Refreshed each connect |
| Multiple simultaneous connections | ❌ Out | One active connection |
| Background operation | ❌ Out | Browser limitation |

### Canvas / composer

| Feature | Status | Notes |
|---|---|---|
| Photo import (picker, drag-drop, paste) + adjustments | ✅ In | Exposure/saturation/shadows/highlights/tone via wasm pipeline |
| Freehand drawing | ✅ In | Palette colors, stroke width |
| Text overlays | ✅ In | Drag, size, palette color |
| QR codes | ✅ In | App-owned worker-safe generator (`/l/qrcode.js` is DOM-bound) |
| Layers, undo/redo, drafts across reloads | ✅ In | Asset-referenced storage; structure-only undo |
| High-quality dithering (8 modes, OKLab, serpentine) | ✅ In | `@opendisplay/epaper-dithering` wasm |
| Measured palettes + faithful preview | ✅ In | Measured RGB preview only; ideal RGB paint-back |
| Panel rotation | ✅ In | Carried in device record; artboard composes in rotated logical dims |
| Color schemes 0–6 and 8 | ✅ In | Scheme 8 (BWGBRY_SPLIT) already in the shared encoder |
| Color scheme 7 (7-color Spectra) | ❌ Out | Hard-rejected before encoding (encoder fails open) |
| Upload: direct-write, PIPE, compression, encryption | ✅ In | Inherited from unmodified `ble-common.js` |
| Partial updates | ⚙️ Inherited | Mono only, via `ble-common.js` etag tracking; no dedicated UI |
| ODL export / templates | ❌ Out | Visual Designer owns ODL |

### Toolbox (excluded by scope)

| Feature | Status | Notes |
|---|---|---|
| Config read (0x40) | ⚙️ Internal | Resolution, rotation, scheme, transmission modes only |
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
| Chrome desktop & Android, Edge desktop | ✅ Supported (in qualification matrix) |
| Opera, Samsung Internet | ⚠️ Expected compatible (Chromium), not release-qualified |
| Safari (macOS/iOS/iPadOS), Firefox | ❌ Unsupported (no Web Bluetooth) |
| iOS via Bluefy | ⚠️ Best-effort, untested tier |
