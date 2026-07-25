#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FW_DIR="$REPO_ROOT/httpdocs/firmware/toolbox/firmware"
VERSION_FILE="$FW_DIR/firmware-nrf54-version.json"
DOWNLOAD_DIR="$(mktemp -d)"
FIRMWARE_REPO="${FIRMWARE_REPO:-OpenDisplay/Firmware_NRF54}"

cleanup() {
  rm -rf "$DOWNLOAD_DIR"
}
trap cleanup EXIT

mkdir -p "$FW_DIR"

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

echo "Syncing nRF54 firmware release $latest_tag (was: ${pinned_tag:-none})"

# Factory merged HEX only — ignore *-app_update.bin and *-dfu.zip
l15_url=$(echo "$release_json" | jq -r \
  '.assets[] | select(.name | test("^nrf54l15-.*\\.hex$") and (test("app_update") | not)) | .browser_download_url' | head -1)
lm20_url=$(echo "$release_json" | jq -r \
  '.assets[] | select(.name | test("^nrf54lm20a-.*\\.hex$") and (test("app_update") | not)) | .browser_download_url' | head -1)

if [[ -z "$l15_url" || "$l15_url" == "null" ]]; then
  echo "Missing nrf54l15-*.hex asset in release $latest_tag" >&2
  exit 1
fi
if [[ -z "$lm20_url" || "$lm20_url" == "null" ]]; then
  echo "Missing nrf54lm20a-*.hex asset in release $latest_tag" >&2
  exit 1
fi

curl -fsSL -o "$FW_DIR/nrf54l15.hex" "$l15_url"
echo "  nrf54l15.hex <- $l15_url"
curl -fsSL -o "$FW_DIR/nrf54lm20a.hex" "$lm20_url"
echo "  nrf54lm20a.hex <- $lm20_url"

synced_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
jq -n \
  --arg repo "$FIRMWARE_REPO" \
  --arg tag "$latest_tag" \
  --arg published_at "$published_at" \
  --arg synced_at "$synced_at" \
  '{repository: $repo, tag: $tag, published_at: $published_at, synced_at: $synced_at}' \
  > "$VERSION_FILE"

if git -C "$REPO_ROOT" diff --quiet -- \
  httpdocs/firmware/toolbox/firmware/nrf54l15.hex \
  httpdocs/firmware/toolbox/firmware/nrf54lm20a.hex \
  httpdocs/firmware/toolbox/firmware/firmware-nrf54-version.json; then
  echo "No file changes after sync"
  echo "changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

echo "changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "tag=$latest_tag" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "nRF54 firmware binaries updated to $latest_tag"
