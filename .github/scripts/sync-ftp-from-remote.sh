#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTPDOCS="$REPO_ROOT/httpdocs"
CACHE_DIR="$REPO_ROOT/.github/cache"
MANIFEST_FILE="$CACHE_DIR/ftp-remote-manifest.txt"
SYNC_EXCLUDE_HTTPDOCS=(
  firmware/toolbox/firmware/.gitkeep
)
WORKDIR="$(mktemp -d)"
REMOTE_MIRROR="$WORKDIR/remote"

CURL_MAX_TIME="${CURL_MAX_TIME:-120}"
FTP_REMOTE_PATH="${FTP_REMOTE_DIR:-httpdocs}"
FTP_REMOTE_PATH="${FTP_REMOTE_PATH#/}"
FTP_REMOTE_PATH="${FTP_REMOTE_PATH%/}"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR" "$REMOTE_MIRROR"

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

FTP_HOST="$(normalize_ftp_host "$FTP_SERVER")"
FTP_BASE_URL="ftp://${FTP_HOST}/${FTP_REMOTE_PATH}/"
CURL_OPTS=(--silent --show-error --ftp-pasv --max-time "$CURL_MAX_TIME" -u "${FTP_USERNAME}:${FTP_PASSWORD}")

FILES_DOWNLOADED=0
DIRS_VISITED=0

curl_ftp_list() {
  curl "${CURL_OPTS[@]}" --list-only "$1"
}

is_ftp_directory() {
  local url="$1"
  [[ "${url}" != */ ]] && url="${url}/"
  curl "${CURL_OPTS[@]}" --list-only "$url" >/dev/null 2>&1
}

mirror_ftp_curl() {
  local remote_url="$1"
  local local_dir="$2"
  [[ "${remote_url}" == */ ]] || remote_url="${remote_url}/"
  mkdir -p "$local_dir"
  DIRS_VISITED=$((DIRS_VISITED + 1))
  debug "listing ${remote_url}"

  local listing
  if ! listing=$(curl_ftp_list "$remote_url"); then
    error "failed to list ${remote_url}"
    return 1
  fi

  local name child_remote child_local
  while IFS= read -r name || [[ -n "$name" ]]; do
    [[ -z "$name" || "$name" == "." || "$name" == ".." ]] && continue
    child_remote="${remote_url}${name}"
    child_local="${local_dir}/${name}"
    if is_ftp_directory "$child_remote"; then
      mirror_ftp_curl "${child_remote}/" "$child_local"
    else
      if ! curl "${CURL_OPTS[@]}" -o "$child_local" "$child_remote"; then
        error "failed to download ${child_remote}"
        return 1
      fi
      FILES_DOWNLOADED=$((FILES_DOWNLOADED + 1))
      if (( FILES_DOWNLOADED % 50 == 0 )); then
        debug "downloaded ${FILES_DOWNLOADED} files ..."
      fi
    fi
  done <<< "$listing"
}

is_sync_excluded() {
  local rel="$1"
  local excluded
  for excluded in "${SYNC_EXCLUDE_HTTPDOCS[@]}"; do
    [[ "$rel" == "$excluded" ]] && return 0
  done
  return 1
}

build_manifest() {
  local root="$1"
  local out="$2"
  : > "$out"
  find "$root" -type f | sort | while read -r file; do
    rel="${file#"$root"/}"
    is_sync_excluded "$rel" && continue
    hash=$(sha256sum "$file" | awk '{print $1}')
    printf '%s %s\n' "$hash" "$rel"
  done >> "$out"
}

notice "FTP sync starting (curl mirror)"
debug "remote=${FTP_BASE_URL}"

debug "probing remote directory ..."
entry_count=$(curl_ftp_list "$FTP_BASE_URL" | wc -l | tr -d ' ')
notice "remote list OK (${entry_count} top-level entries)"

rm -rf "${REMOTE_MIRROR:?}"/*
mkdir -p "$REMOTE_MIRROR"
mirror_ftp_curl "$FTP_BASE_URL" "$REMOTE_MIRROR"

file_count=$(find "$REMOTE_MIRROR" -type f | wc -l | tr -d ' ')
notice "mirror complete: ${file_count} files, ${DIRS_VISITED} directories"
debug "curl downloaded ${FILES_DOWNLOADED} files"

if [[ "$file_count" -eq 0 ]]; then
  error "mirror returned 0 files"
  exit 1
fi

echo "remote_path=/${FTP_REMOTE_PATH}/" >> "${GITHUB_OUTPUT:-/dev/null}"

NEW_MANIFEST="$WORKDIR/manifest-new.txt"
build_manifest "$REMOTE_MIRROR" "$NEW_MANIFEST"
debug "manifest entries: $(wc -l < "$NEW_MANIFEST")"

remote_changed=true
if [[ -f "$MANIFEST_FILE" ]] && cmp -s "$MANIFEST_FILE" "$NEW_MANIFEST"; then
  remote_changed=false
  debug "remote manifest unchanged"
fi

if [[ "$remote_changed" == false ]]; then
  echo "remote_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  notice "no FTP changes since last check"
  exit 0
fi

echo "remote_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"

debug "applying remote tree to httpdocs/"
rsync_excludes=()
for excluded in "${SYNC_EXCLUDE_HTTPDOCS[@]}"; do
  rsync_excludes+=(--exclude "$excluded")
done
rsync -a --delete "${rsync_excludes[@]}" "$REMOTE_MIRROR/" "$HTTPDOCS/"

git_diff_paths=(httpdocs/)
for excluded in "${SYNC_EXCLUDE_HTTPDOCS[@]}"; do
  git_diff_paths+=(":(exclude)httpdocs/${excluded}")
done
if git -C "$REPO_ROOT" diff --quiet -- "${git_diff_paths[@]}"; then
  cp "$NEW_MANIFEST" "$MANIFEST_FILE"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  notice "FTP updated but matches git main"
  exit 0
fi

cp "$NEW_MANIFEST" "$MANIFEST_FILE"
echo "content_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
notice "FTP differs from git — PR will be opened"
