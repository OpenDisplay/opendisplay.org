#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="$REPO_ROOT/httpdocs/firmware/toolbox/bin"
FW_DIR="$REPO_ROOT/httpdocs/firmware/toolbox/firmware"
VERSION_FILE="$BIN_DIR/firmware-version.json"
DOWNLOAD_DIR="$(mktemp -d)"
FIRMWARE_REPO="${FIRMWARE_REPO:-OpenDisplay/Firmware}"

cleanup() {
  rm -rf "$DOWNLOAD_DIR"
}
trap cleanup EXIT

mkdir -p "$BIN_DIR" "$FW_DIR"

pinned_tag=""
if [[ -f "$VERSION_FILE" ]]; then
  pinned_tag=$(jq -r '.tag // empty' "$VERSION_FILE")
fi

echo "Fetching latest release from $FIRMWARE_REPO ..."
release_json=$(curl -fsSL "https://api.github.com/repos/${FIRMWARE_REPO}/releases/latest")
latest_tag=$(echo "$release_json" | jq -r '.tag_name')
published_at=$(echo "$release_json" | jq -r '.published_at')

if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
  echo "No release found" >&2
  exit 1
fi

if [[ -n "$pinned_tag" ]]; then
  if [[ "$pinned_tag" == "$latest_tag" ]]; then
    echo "Already synced to $pinned_tag"
    echo "changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  newer=$(printf '%s\n%s\n' "$pinned_tag" "$latest_tag" | sort -V | tail -1)
  if [[ "$newer" != "$latest_tag" ]]; then
    echo "Pinned tag $pinned_tag is newer than latest release $latest_tag"
    echo "changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
fi

echo "Syncing firmware release $latest_tag (was: ${pinned_tag:-none})"

# A release whose build failed is still "latest" via the API, just with no (or
# incomplete) assets. Without this guard the download loop below simply matches
# nothing — no error — and the manifest rewrite further down would still stamp
# the new version into every *_full.json, advertising a firmware whose binaries
# were never built. Fail loudly instead; the workflow goes red and opens no PR.
#
# Counted with jq rather than over a bash array: on a zero-asset release the
# array is empty, and "${arr[@]}" under `set -u` is an error on bash < 4.4.
missing=()
[[ $(echo "$release_json" | jq '[.assets[].name | select(endswith("_full.bin"))] | length') -eq 0 ]] \
  && missing+=("*_full.bin")
[[ $(echo "$release_json" | jq '[.assets[].name | select(. == "NRF52840.uf2")] | length') -eq 0 ]] \
  && missing+=("NRF52840.uf2")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Release $latest_tag is missing expected assets: ${missing[*]}" >&2
  echo "Refusing to sync — this usually means the firmware build failed after the release was created." >&2
  echo "Re-run the firmware release build, then re-run this sync." >&2
  exit 1
fi

mapfile -t asset_names < <(echo "$release_json" | jq -r '.assets[].name')

for name in "${asset_names[@]}"; do
  url=$(echo "$release_json" | jq -r --arg n "$name" '.assets[] | select(.name == $n) | .browser_download_url')
  case "$name" in
    *_full.bin)
      curl -fsSL -o "$BIN_DIR/$name" "$url"
      echo "  $name -> toolbox/bin/"
      ;;
    NRF52840.uf2|NRF52840.zip)
      curl -fsSL -o "$FW_DIR/$name" "$url"
      echo "  $name -> toolbox/firmware/"
      ;;
  esac
done

# Create ESP Web Tools manifests for any newly shipped *_full.bin that has none
# yet (e.g. when a new env like esp32-N4 starts releasing). Chip family is
# derived from the env stem; unknown stems fall back to classic ESP32.
chip_family_for() {
  local stem="$1"
  case "$stem" in
    esp32-s3-*) echo "ESP32-S3" ;;
    esp32-c3-*) echo "ESP32-C3" ;;
    esp32-c6-*) echo "ESP32-C6" ;;
    esp32-*)    echo "ESP32" ;;
    *)          echo "" ;;
  esac
}

for bin in "$BIN_DIR"/*_full.bin; do
  [[ -f "$bin" ]] || continue
  base=$(basename "$bin")
  stem="${base%_full.bin}"
  manifest="$BIN_DIR/${stem}_full.json"
  if [[ ! -f "$manifest" ]]; then
    family=$(chip_family_for "$stem")
    if [[ -z "$family" ]]; then
      echo "  skip manifest for $base (unknown chip family)"
      continue
    fi
    jq -n \
      --arg v "$latest_tag" \
      --arg family "$family" \
      --arg path "$base" \
      '{
        name: "Open Display Firmware",
        version: $v,
        home_assistant_domain: "open_display",
        new_install_prompt_erase: false,
        new_install_improv_wait_time: 0,
        builds: [{ chipFamily: $family, parts: [{ path: $path, offset: 0 }] }]
      }' > "$manifest"
    echo "  created $manifest ($family)"
  fi
done

for manifest in "$BIN_DIR"/*_full.json; do
  [[ -f "$manifest" ]] || continue
  jq --arg v "$latest_tag" '.version = $v' "$manifest" > "${manifest}.tmp"
  mv "${manifest}.tmp" "$manifest"
done

synced_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n \
  --arg repo "$FIRMWARE_REPO" \
  --arg tag "$latest_tag" \
  --arg published_at "$published_at" \
  --arg synced_at "$synced_at" \
  '{repository: $repo, tag: $tag, published_at: $published_at, synced_at: $synced_at}' \
  > "$VERSION_FILE"

if git -C "$REPO_ROOT" diff --quiet -- \
  httpdocs/firmware/toolbox/bin/ \
  httpdocs/firmware/toolbox/firmware/; then
  echo "No file changes after sync"
  echo "changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

echo "changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "tag=$latest_tag" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Firmware binaries updated to $latest_tag"
