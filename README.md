# Web

Website files for https://opendisplay.org/

## Deployment

Publishing a [GitHub Release](https://github.com/OpenDisplay/opendisplay.org/releases) deploys `httpdocs/` to the FTP server at `/httpdocs/`.

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `deploy-ftp` | Release published, manual | Upload `httpdocs/` to production FTP |
| `sync-ftp` | Daily 03:00 UTC, manual | Open a PR if the live FTP folder changed |
| `sync-firmware` | Daily 04:00 UTC, manual | Open a PR when [OpenDisplay/Firmware](https://github.com/OpenDisplay/Firmware) has a new release |
| `validate-simple-config` | PR/push touching toolbox presets | Keep simple-config board/display/battery ids & indexes stable |

### Simple-config preset IDs

Toolbox simple-config entries live in `httpdocs/firmware/toolbox/simple-config-presets.json`.

- **String `id`** values are used in share URLs (`?driver=&display=&power=`).
- Numeric **`index`** values are written into device manufacturer data as `simple_config_{driver,display,power}_index`.

Both are permanent once published. To add hardware, append a new id with a new unused index and update `simple-config-id-registry.json` in the same change. Never reuse or renumber existing mappings.

Optional fields the Toolbox reads:

- Board `supportsEncryption: false`: the firmware has no security module (nRF52811). The encryption switch is off and disabled, and no 0x27 packet is written. Whatever the preset says, a config carrying a secret (0x27 key, Wi-Fi password, Find My keys) is refused before writing to an nRF52811.
- Board `dataBus`, `nfcConfig`, `flashConfig`: written as 0x24, 0x2A and 0x2B.
- Display `v3PanelIcType`: the firmware 3.x drive preset of a Firmware_NRF display (e.g. 1016 on 2.x, 0xE011 on 3.x, from `drive-presets-nrf52811.json`). `panelIcType` keeps the 2.x id.
- Display `v3Only: true`: no 2.x driver exists; `panelIcType` is already the 3.x id and the display is not offered for 2.x.

Local check:

```bash
python3 .github/scripts/validate-simple-config-presets.py
```

