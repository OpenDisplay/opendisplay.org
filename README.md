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

Local check:

```bash
python3 .github/scripts/validate-simple-config-presets.py
```

