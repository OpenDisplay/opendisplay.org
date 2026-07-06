#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTPDOCS="$REPO_ROOT/httpdocs"
MANIFEST_NAME=".opendisplay-deploy-manifest.txt"

CURL_MAX_TIME="${CURL_MAX_TIME:-180}"
FTP_REMOTE_PATH="${FTP_REMOTE_DIR:-httpdocs}"
FTP_REMOTE_PATH="${FTP_REMOTE_PATH#/}"
FTP_REMOTE_PATH="${FTP_REMOTE_PATH%/}"

if [[ -z "${FTP_SERVER:-}" || -z "${FTP_USERNAME:-}" || -z "${FTP_PASSWORD:-}" ]]; then
  echo "::error::FTP_SERVER, FTP_USERNAME, and FTP_PASSWORD are required" >&2
  exit 1
fi

debug() {
  echo "[$(date -u +'%H:%M:%S')] $*" >&2
}

notice() {
  echo "::notice::$*" >&2
}

error() {
  echo "::error::$*" >&2
}

normalize_ftp_host() {
  local h="$1"
  h="${h#ftp://}"
  h="${h#ftps://}"
  h="${h%%/*}"
  h="${h%/}"
  echo "$h"
}

build_manifest() {
  local root="$1"
  local out="$2"
  : > "$out"
  find "$root" -type f | sort | while read -r file; do
    rel="${file#"$root"/}"
    hash=$(sha256sum "$file" | awk '{print $1}')
    printf '%s %s\n' "$hash" "$rel"
  done >> "$out"
}

lookup_manifest_hash() {
  local manifest="$1"
  local path="$2"
  awk -v p="$path" '$2 == p { print $1; exit }' "$manifest"
}

FTP_HOST="$(normalize_ftp_host "$FTP_SERVER")"
FTP_BASE_URL="ftp://${FTP_HOST}/${FTP_REMOTE_PATH}/"
MANIFEST_URL="ftp://${FTP_HOST}/${MANIFEST_NAME}"
CURL_OPTS=(
  --silent
  --show-error
  --ftp-pasv
  --ftp-create-dirs
  --max-time "$CURL_MAX_TIME"
  --retry 3
  --retry-delay 3
  --retry-all-errors
  -u "${FTP_USERNAME}:${FTP_PASSWORD}"
)

if [[ ! -d "$HTTPDOCS" ]]; then
  error "httpdocs directory not found at ${HTTPDOCS}"
  exit 1
fi

LOCAL_MANIFEST="$(mktemp)"
REMOTE_MANIFEST="$(mktemp)"
trap 'rm -f "$LOCAL_MANIFEST" "$REMOTE_MANIFEST"' EXIT

build_manifest "$HTTPDOCS" "$LOCAL_MANIFEST"
local_total=$(wc -l < "$LOCAL_MANIFEST" | tr -d ' ')

if [[ "$local_total" -eq 0 ]]; then
  error "no files to upload in httpdocs/"
  exit 1
fi

has_remote_manifest=false
if curl "${CURL_OPTS[@]}" -o "$REMOTE_MANIFEST" "$MANIFEST_URL" 2>/dev/null && [[ -s "$REMOTE_MANIFEST" ]]; then
  has_remote_manifest=true
  if cmp -s "$LOCAL_MANIFEST" "$REMOTE_MANIFEST"; then
    notice "deploy skipped: remote already matches local (${local_total} files)"
    exit 0
  fi
  debug "remote manifest found — computing diff"
else
  debug "no remote manifest — first deploy"
fi

mapfile -t TO_UPLOAD < <(
  while read -r hash rel; do
    [[ -z "$rel" ]] && continue
    if [[ "$has_remote_manifest" == true ]]; then
      remote_hash="$(lookup_manifest_hash "$REMOTE_MANIFEST" "$rel")"
      [[ "$remote_hash" == "$hash" ]] && continue
    fi
    printf '%s\n' "$rel"
  done < "$LOCAL_MANIFEST"
)

upload_count="${#TO_UPLOAD[@]}"
if [[ "$upload_count" -eq 0 ]]; then
  notice "deploy skipped: no file changes detected"
  exit 0
fi

notice "FTP deploy: uploading ${upload_count}/${local_total} changed file(s) -> ${FTP_BASE_URL}"

uploaded=0
failed=0

for rel in "${TO_UPLOAD[@]}"; do
  file="${HTTPDOCS}/${rel}"
  url="${FTP_BASE_URL}${rel}"
  if curl "${CURL_OPTS[@]}" -T "$file" "$url"; then
    uploaded=$((uploaded + 1))
    if (( uploaded % 25 == 0 || uploaded == upload_count )); then
      debug "uploaded ${uploaded}/${upload_count} ..."
    fi
  else
    failed=$((failed + 1))
    error "upload failed: ${rel}"
  fi
done

if [[ "$failed" -gt 0 ]]; then
  error "deploy finished with ${failed} failed upload(s) (${uploaded}/${upload_count} ok)"
  exit 1
fi

if ! curl "${CURL_OPTS[@]}" -T "$LOCAL_MANIFEST" "$MANIFEST_URL"; then
  error "uploads ok but failed to update remote manifest"
  exit 1
fi

notice "deploy complete: ${uploaded} file(s) uploaded, manifest updated"
