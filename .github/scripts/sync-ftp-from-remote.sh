#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTPDOCS="$REPO_ROOT/httpdocs"
CACHE_DIR="$REPO_ROOT/.github/cache"
MANIFEST_FILE="$CACHE_DIR/ftp-remote-manifest.txt"
WORKDIR="$(mktemp -d)"
REMOTE_MIRROR="$WORKDIR/remote"
NETRC="$WORKDIR/netrc"
LFTP_LAST_LOG=""
SELECTED_REMOTE=""
ACTIVE_PROTOCOL=""

LFTP_NET_TIMEOUT="${LFTP_NET_TIMEOUT:-20}"
LFTP_CMD_TIMEOUT="${LFTP_CMD_TIMEOUT:-180}"
LFTP_MAX_RETRIES="${LFTP_MAX_RETRIES:-2}"

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
  h="${h#ftpes://}"
  h="${h%%/*}"
  h="${h%/}"
  echo "$h"
}

FTP_HOST="$(normalize_ftp_host "$FTP_SERVER")"

write_netrc() {
  # Password only in netrc — never in lftp script or URLs (CI log masking strips those lines).
  {
    printf 'machine %s\nlogin %s\npassword %s\n' "$FTP_HOST" "$FTP_USERNAME" "$FTP_PASSWORD"
    printf 'machine default\nlogin %s\npassword %s\n' "$FTP_USERNAME" "$FTP_PASSWORD"
  } > "$NETRC"
  chmod 600 "$NETRC"
}

# Print safe lftp diagnostics — never emit lines that still contain the password.
show_lftp_log() {
  local lines="${1:-30}"
  if [[ ! -f "$LFTP_LAST_LOG" ]]; then
    debug "lftp log file missing"
    return
  fi
  local size
  size=$(wc -c < "$LFTP_LAST_LOG" | tr -d ' ')
  if [[ "$size" -eq 0 ]]; then
    debug "lftp log is empty"
    return
  fi
  debug "lftp diagnostics (${size} bytes, last ${lines} lines sanitized):"
  LOG_PATH="$LFTP_LAST_LOG" TAIL_LINES="$lines" \
    FTP_PASSWORD="$FTP_PASSWORD" FTP_USERNAME="$FTP_USERNAME" \
    python3 -u <<'PY' >&2
import os
import re

path = os.environ["LOG_PATH"]
password = os.environ.get("FTP_PASSWORD", "")
username = os.environ.get("FTP_USERNAME", "")
n = int(os.environ.get("TAIL_LINES", "30"))

raw = open(path, encoding="utf-8", errors="replace").read().splitlines()
chunk = raw[-n:]
printed = 0
codes = set()

for line in chunk:
    if password and password in line:
        print("  [line omitted: contained credential]")
        continue
    if username and re.search(rf"{re.escape(username)}[:/]", line):
        line = re.sub(rf"{re.escape(username)}[:/]\S+", f"{username}:***", line)
    line = re.sub(r"(?i)(ftp|ftps)://[^@\s]+@", r"\1://***@", line)
    for code in re.findall(r"\b(220|421|425|426|530|550)\b", line):
        codes.add(code)
    if line.strip():
        print(f"  {line}")
        printed += 1

if codes:
    print(f"  FTP response codes seen: {', '.join(sorted(codes))}")
if printed == 0:
    print("  (no safe lines to show — typical for login failure with secret masking)")
    print("  hint: verify FTP_USERNAME, FTP_PASSWORD, and that FTP_SERVER is hostname only")
PY
}

lftp_protocol_settings() {
  local proto="$1"
  case "$proto" in
    ftps)
      echo "set ftp:ssl-force true;"
      echo "set ssl:verify-certificate no;"
      ;;
    ftpes)
      echo "set ftp:ssl-protect-data true;"
      echo "set ftp:ssl-protect-list true;"
      echo "set ssl:verify-certificate no;"
      ;;
  esac
}

# open ftp://user@host/path/ — password from netrc only
lftp_open_line() {
  local proto="$1"
  local remote_path="${2:-}"
  remote_path="${remote_path#/}"
  remote_path="${remote_path%/}"
  if [[ -n "$remote_path" && "$remote_path" != "." ]]; then
    echo "open ${proto}://${FTP_USERNAME}@${FTP_HOST}/${remote_path}/;"
  else
    echo "open ${proto}://${FTP_USERNAME}@${FTP_HOST}/;"
  fi
}

run_lftp_script() {
  local proto="$1"
  local open_path="${2:-}"
  local script="$WORKDIR/lftp-$$.cmd"
  LFTP_LAST_LOG="$WORKDIR/lftp-run-$$.log"
  write_netrc
  {
    echo "set net:netrc-file ${NETRC};"
    echo "set ftp:passive-mode true;"
    echo "set net:timeout ${LFTP_NET_TIMEOUT};"
    echo "set net:max-retries ${LFTP_MAX_RETRIES};"
    echo "set cmd:default-timeout ${LFTP_CMD_TIMEOUT};"
    echo "set cmd:fail-exit yes;"
    lftp_protocol_settings "$proto"
    lftp_open_line "$proto" "$open_path"
    cat
    echo "bye;"
  } > "$script"
  local label="${proto}://${FTP_USERNAME}@${FTP_HOST}/${open_path:-}"
  debug "lftp connect (${label})"
  if lftp -f "$script" >"$LFTP_LAST_LOG" 2>&1; then
    ACTIVE_PROTOCOL="$proto"
    return 0
  fi
  debug "lftp connect failed (${label})"
  show_lftp_log 20
  return 1
}

curl_ftp_probe() {
  local err="$WORKDIR/curl-err.txt"
  local out="$WORKDIR/curl-out.txt"
  local url="ftp://${FTP_HOST}/httpdocs/"
  debug "curl probe: ${url}"
  if curl -sS --ftp-pasv --list-only -u "$FTP_USERNAME:$FTP_PASSWORD" "$url" >"$out" 2>"$err"; then
    local count
    count=$(wc -l < "$out" | tr -d ' ')
    notice "curl list OK (${count} entries under /httpdocs/)"
    head -5 "$out" | sed "s/$FTP_PASSWORD/***REDACTED***/g" >&2 || true
    return 0
  fi
  debug "curl probe failed"
  if [[ -s "$err" ]]; then
    FTP_PASSWORD="$FTP_PASSWORD" python3 -c "
import os, sys
pw = os.environ.get('FTP_PASSWORD','')
for line in open(sys.argv[1], errors='replace'):
    if pw and pw in line:
        print('  curl: [stderr line omitted]')
    else:
        print('  curl:', line.rstrip())
" "$err" >&2
  fi
  return 1
}

protocols_to_try() {
  if [[ -n "${FTP_PROTOCOL:-}" ]]; then
    printf '%s\n' "$FTP_PROTOCOL"
    return
  fi
  printf '%s\n' ftp
}

open_paths_to_try() {
  if [[ -n "${FTP_REMOTE_DIR:-}" ]]; then
    printf '%s\n' "${FTP_REMOTE_DIR#/}"
    return
  fi
  printf '%s\n' httpdocs "" .
}

try_connect_and_mirror() {
  local proto open_path remote_label
  for proto in $(protocols_to_try); do
    for open_path in $(open_paths_to_try); do
      remote_label="/${open_path}"
      [[ -z "$open_path" || "$open_path" == "." ]] && remote_label="/"
      notice "Connect ${proto} path=${remote_label}"
      rm -rf "${REMOTE_MIRROR:?}"/*
      mkdir -p "$REMOTE_MIRROR"
      if ! run_lftp_script "$proto" "$open_path" <<EOF
pwd;
ls;
mirror --verbose --parallel=1 --no-perms --no-umask . ${REMOTE_MIRROR};
EOF
      then
        continue
      fi
      local files
      files=$(find "$REMOTE_MIRROR" -type f | wc -l)
      debug "Downloaded ${files} file(s)"
      if [[ "$files" -gt 0 ]]; then
        SELECTED_REMOTE="${remote_label}"
        notice "Mirror OK: ${files} files from ${remote_label} (${proto})"
        return 0
      fi
      debug "Mirror returned 0 files"
      show_lftp_log 20
    done
  done
  return 1
}

notice "FTP sync starting"
debug "host=${FTP_HOST}"
debug "timeouts net=${LFTP_NET_TIMEOUT}s cmd=${LFTP_CMD_TIMEOUT}s"

curl_ftp_probe || true

if ! try_connect_and_mirror; then
  error "Failed to connect or mirror httpdocs from FTP"
  debug "Tried open paths: $(open_paths_to_try | tr '\n' ' ')"
  show_lftp_log 40
  exit 1
fi

echo "remote_path=${SELECTED_REMOTE}" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "remote_protocol=${ACTIVE_PROTOCOL}" >> "${GITHUB_OUTPUT:-/dev/null}"

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

NEW_MANIFEST="$WORKDIR/manifest-new.txt"
build_manifest "$REMOTE_MIRROR" "$NEW_MANIFEST"
debug "Manifest entries: $(wc -l < "$NEW_MANIFEST")"

remote_changed=true
if [[ -f "$MANIFEST_FILE" ]] && cmp -s "$MANIFEST_FILE" "$NEW_MANIFEST"; then
  remote_changed=false
fi

if [[ "$remote_changed" == false ]]; then
  echo "remote_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  notice "No FTP changes since last check"
  exit 0
fi

echo "remote_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"

debug "Applying remote tree to httpdocs/"
rsync -a --delete "$REMOTE_MIRROR/" "$HTTPDOCS/"

if git -C "$REPO_ROOT" diff --quiet -- httpdocs/; then
  cp "$NEW_MANIFEST" "$MANIFEST_FILE"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  notice "FTP updated but matches git main"
  exit 0
fi

cp "$NEW_MANIFEST" "$MANIFEST_FILE"
echo "content_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
notice "FTP differs from git — PR will be opened"
