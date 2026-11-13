# Web

Website files for https://opendisplay.org/

## Deployment

Merging to `main` runs release-please. When its release PR is merged, the release it creates deploys `httpdocs/` to the FTP server at `/httpdocs/`. A release published by hand, or a manual run of `deploy-ftp`, deploys too. Pushing any other branch deploys nothing.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/); release-please derives the version and `CHANGELOG.md` from them.

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `release-please` | Push to `main`, manual | Maintain the release PR; on release, call `deploy-ftp` |
| `deploy-ftp` | Called by `release-please`, release published, manual | Upload `httpdocs/` to production FTP |
| `sync-firmware` | Daily 04:00 UTC, manual | Open a PR when [OpenDisplay/Firmware](https://github.com/OpenDisplay/Firmware) (2.x) has a new release |
| `sync-firmware-nrf54` | Daily 04:30 UTC, manual | Open a PR when [OpenDisplay/Firmware_NRF54](https://github.com/OpenDisplay/Firmware_NRF54) has a new release |
| `sync-firmware-unified` | Daily 04:30 UTC, manual | Open a PR when [OpenDisplay/Firmware_Unified](https://github.com/OpenDisplay/Firmware_Unified) (3.x) has a new release; writes `httpdocs/firmware/toolbox/v3/` only |
| `validate-simple-config` | PR/push touching toolbox presets | Keep simple-config board/display/battery ids & indexes stable |

Scheduled workflows run from `main` only.

## Firmware 2.x and 3.x

The Toolbox, BLE Tester and designer pick the path by the connected device's firmware major version (`OpenDisplayV3.firmwareGeneration` in `httpdocs/js/od-v3.js`). 2.x devices are handled as before. 3.x devices are config-driven: the config carries each panel's drive data (packets 0xAE-0xB1), and the Toolbox migrates a config without it on connect. The 3.x security scheme (claim, sealed sessions, key store) is in `httpdocs/js/od-sec2*.js`, `od-keystore.js` and `ble-sec2.js`; the setup and recovery QR (`/l/?f=1&...`) is read by `od-setup-url.js`.

## Vendored files

| File | Source | Refresh |
|---|---|---|
| `httpdocs/firmware/toolbox/drive-presets.json` | Firmware_Unified `panels/generated/drive_presets.json` | `python3 .github/scripts/sync-drive-presets.py <Firmware_Unified checkout>` |
| `httpdocs/firmware/toolbox/drive-presets-nrf52811.json` | Firmware_NRF `presets/drive_presets_nrf52811.json` | `python3 .github/scripts/sync-drive-presets.py --src <file> --out httpdocs/firmware/toolbox/drive-presets-nrf52811.json` |
| `tests/fixtures/sec2_vectors.json` | py-opendisplay `tests/fixtures/` (same file in Firmware_Unified) | copy |
| `tests/fixtures/user_texts.json` | py-opendisplay `tests/fixtures/`; mirrored word for word in `httpdocs/js/od-texts.js` | copy, then update `od-texts.js` |

The user-facing texts in `user_texts.json` are shared with py-opendisplay and the Home Assistant integration. Change them in all three, never only here.

## Tests

```bash
node --test tests/*.test.js
python3 .github/scripts/validate-simple-config-presets.py
```

`tests/drift.test.js` compares the vendored files with their sources. It runs when the sources are checked out next to this repository (`../py-opendisplay`, `../Firmware_Unified`, `../Firmware_NRF`) or named by `OPENDISPLAY_PY_DIR`, `OPENDISPLAY_FW_DIR` and `OPENDISPLAY_FW_NRF52811_DIR`, and is skipped otherwise.

### Simple-config preset IDs

Toolbox simple-config entries live in `httpdocs/firmware/toolbox/simple-config-presets.json`.

- **String `id`** values are used in share URLs (`?driver=&display=&power=`).
- Numeric **`index`** values are written into device manufacturer data as `simple_config_{driver,display,power}_index`.

Both are permanent once published. To add hardware, append a new id with a new unused index and update `simple-config-id-registry.json` in the same change. Never reuse or renumber existing mappings.

Optional fields the Toolbox reads:

- Board `supportsEncryption: false`: the firmware has no security module (nRF52811). The encryption switch is off and disabled, and no 0x27 packet is written. Whatever the preset says, a config carrying a secret (0x27 key, Wi-Fi password, Find My keys) is refused before writing to an nRF52811.
- Board `dataBus`, `nfcConfig`, `flashConfig`: written as 0x24, 0x2A and 0x2B.
- Display `v3PanelIcType`: the firmware 3.x drive preset of a Firmware_NRF display (e.g. 1016 on 2.x, 0xE011 on 3.x, from `drive-presets-nrf52811.json`). `panelIcType` keeps the 2.x id. Only displays whose 3.x preset was checked on a real panel carry it: the firmware ships no other presets, and on 3.x an nRF52811 display without one is refused.
- Display `v3Only: true`: no 2.x driver exists; `panelIcType` is already the 3.x id and the display is not offered for 2.x.

Check with `python3 .github/scripts/validate-simple-config-presets.py`.

