# Web

Website files for https://opendisplay.org/

## Deployment

Publishing a [GitHub Release](https://github.com/OpenDisplay/opendisplay.org/releases) deploys `httpdocs/` to the Netcup FTP server at `/opendisplay.org/httpdocs/`.

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `deploy-ftp` | Release published, manual | Upload `httpdocs/` to production FTP |
| `sync-ftp` | Daily 03:00 UTC, manual | Open a PR if the live FTP folder changed |
| `sync-firmware` | Daily 04:00 UTC, manual | Open a PR when [OpenDisplay/Firmware](https://github.com/OpenDisplay/Firmware) has a new release |

### Required secrets

| Secret | Description |
|---|---|
| `FTP_SERVER` | e.g. `hosting150730.a2f84.netcup.net` |
| `FTP_USERNAME` | Netcup FTP username |
| `FTP_PASSWORD` | Netcup FTP password |

### Optional secrets

| Secret | Description |
|---|---|
| `FTP_PROTOCOL` | Set to `ftps` if plain FTP fails (common on Netcup) |

### Recommended flow

1. Merge changes to `main`
2. Create a GitHub Release → production deploy
3. Review and merge automated PRs from `sync-ftp` (manual server edits) or `sync-firmware` (new firmware binaries), then release again to deploy
