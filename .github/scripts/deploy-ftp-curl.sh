#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# OD_DEPLOY_HTTPDOCS: test hook only — lets the shell test point at a fixture
# tree. Production callers never set it.
HTTPDOCS="${OD_DEPLOY_HTTPDOCS:-$REPO_ROOT/httpdocs}"
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

# Web OD App release preflight: whatever version app/current-version.txt points
# at must already be declared immutable in app/RELEASED_VERSIONS, or a release
# would publish a version that CI still allows people to edit in place
# (DESIGN_WEB_OD_APP_PLAN.md §2).
APP_POINTER="${HTTPDOCS}/app/current-version.txt"
APP_RELEASED="${HTTPDOCS}/app/RELEASED_VERSIONS"
if [[ -f "$APP_POINTER" ]]; then
  app_version="$(tr -d '[:space:]' < "$APP_POINTER")"
  if [[ -z "$app_version" ]]; then
    error "app/current-version.txt is empty"
    exit 1
  fi
  if [[ ! -d "${HTTPDOCS}/app/${app_version}" ]]; then
    error "app/current-version.txt names ${app_version}, but httpdocs/app/${app_version}/ does not exist"
    exit 1
  fi
  if ! grep -qxF "$app_version" "$APP_RELEASED" 2>/dev/null; then
    error "app/current-version.txt names ${app_version}, which is NOT listed in app/RELEASED_VERSIONS."
    error "Add it in the release PR so CI treats ${app_version} as immutable, then re-run."
    exit 1
  fi
  debug "app release preflight ok: ${app_version} is declared immutable"
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

# Split changed files into three ordered phases (DESIGN_WEB_OD_APP_PLAN.md §2):
#   1. assets            — everything else
#   2. HTML entrypoints  — only if EVERY asset succeeded
#   3. deployment pointers (*/current-version.txt) — only after HTML, so the
#      stale-cache recovery marker can never name a version whose entry page
#      is not yet live (a premature marker triggers a reload loop into the old
#      HTML and burns the one-shot ?rv= retry).
# FTP uploads are sequential and non-atomic; each phase gates the next.
ASSETS_TO_UPLOAD=()
HTML_TO_UPLOAD=()
POINTERS_TO_UPLOAD=()
while read -r hash rel; do
  [[ -z "$rel" ]] && continue
  if [[ "$has_remote_manifest" == true ]]; then
    remote_hash="$(lookup_manifest_hash "$REMOTE_MANIFEST" "$rel")"
    [[ "$remote_hash" == "$hash" ]] && continue
  fi
  if [[ "$(basename "$rel")" == "current-version.txt" ]]; then
    POINTERS_TO_UPLOAD+=("$rel")
  elif [[ "$rel" == *.html ]]; then
    HTML_TO_UPLOAD+=("$rel")
  else
    ASSETS_TO_UPLOAD+=("$rel")
  fi
done < "$LOCAL_MANIFEST"

upload_count=$(( ${#ASSETS_TO_UPLOAD[@]} + ${#HTML_TO_UPLOAD[@]} + ${#POINTERS_TO_UPLOAD[@]} ))
if [[ "$upload_count" -eq 0 ]]; then
  # No files to upload, but the manifests may still differ (deletion-only
  # change): refresh the remote manifest so the diff doesn't reappear forever.
  if [[ "$has_remote_manifest" == true ]] && ! cmp -s "$LOCAL_MANIFEST" "$REMOTE_MANIFEST"; then
    if ! curl "${CURL_OPTS[@]}" -T "$LOCAL_MANIFEST" "$MANIFEST_URL"; then
      error "manifest-only refresh failed"
      exit 1
    fi
    notice "deploy: no file uploads; remote manifest refreshed (deletion-only diff)"
  else
    notice "deploy skipped: no file changes detected"
  fi
  exit 0
fi

notice "FTP deploy: uploading ${upload_count}/${local_total} changed file(s) (${#ASSETS_TO_UPLOAD[@]} assets, ${#HTML_TO_UPLOAD[@]} html, ${#POINTERS_TO_UPLOAD[@]} pointers) -> ${FTP_BASE_URL}"

uploaded=0
failed=0

upload_batch() {
  local rel file url
  for rel in "$@"; do
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
}

if [[ ${#ASSETS_TO_UPLOAD[@]} -gt 0 ]]; then
  upload_batch "${ASSETS_TO_UPLOAD[@]}"
fi

# Gate the HTML phase on a fully successful asset phase.
if [[ "$failed" -gt 0 ]]; then
  error "asset phase had ${failed} failure(s) — HTML entrypoints NOT published (${uploaded}/${upload_count} ok)"
  exit 1
fi

if [[ ${#HTML_TO_UPLOAD[@]} -gt 0 ]]; then
  upload_batch "${HTML_TO_UPLOAD[@]}"
fi

if [[ "$failed" -gt 0 ]]; then
  error "html phase had ${failed} failure(s) — deployment pointers NOT published (${uploaded}/${upload_count} ok)"
  exit 1
fi

if [[ ${#POINTERS_TO_UPLOAD[@]} -gt 0 ]]; then
  upload_batch "${POINTERS_TO_UPLOAD[@]}"
fi

if [[ "$failed" -gt 0 ]]; then
  error "deploy finished with ${failed} failed upload(s) (${uploaded}/${upload_count} ok)"
  exit 1
fi

if ! curl "${CURL_OPTS[@]}" -T "$LOCAL_MANIFEST" "$MANIFEST_URL"; then
  error "uploads ok but failed to update remote manifest"
  exit 1
fi

notice "deploy complete: ${uploaded} file(s) uploaded, manifest updated"
