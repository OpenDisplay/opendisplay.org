# Web

Website files for https://opendisplay.org/

## Deployment

Publishing a [GitHub Release](https://github.com/OpenDisplay/opendisplay.org/releases) deploys `httpdocs/` to the Netcup FTP server at `/httpdocs/`.

## GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `deploy-ftp` | Release published, manual | Upload `httpdocs/` to production FTP |
| `sync-ftp` | Daily 03:00 UTC, manual | Open a PR if the live FTP folder changed |
| `sync-firmware` | Daily 04:00 UTC, manual | Open a PR when [OpenDisplay/Firmware](https://github.com/OpenDisplay/Firmware) has a new release |

### Recommended flow

1. Merge changes to `main`
2. Create a GitHub Release → production deploy
3. Review and merge automated PRs from `sync-ftp` (manual server edits) or `sync-firmware` (new firmware binaries), then release again to deploy
