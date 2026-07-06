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
