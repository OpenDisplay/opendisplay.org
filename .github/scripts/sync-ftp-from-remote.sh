#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HTTPDOCS="$REPO_ROOT/httpdocs"
CACHE_DIR="$REPO_ROOT/.github/cache"
MANIFEST_FILE="$CACHE_DIR/ftp-remote-manifest.txt"
WORKDIR="$(mktemp -d)"
REMOTE_MIRROR="$WORKDIR/remote"
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

# Strip ftp://, paths, trailing slashes from the server secret.
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

redact_secrets() {
  FTP_PASSWORD="$FTP_PASSWORD" FTP_USERNAME="$FTP_USERNAME" python3 -u - <<'PY'
import os
import re
import sys

password = os.environ.get("FTP_PASSWORD", "")
username = os.environ.get("FTP_USERNAME", "")

patterns: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^password\s+\S+", re.IGNORECASE), "password ***REDACTED***"),
    (re.compile(r"^(login|user)\s+\S+", re.IGNORECASE), r"\1 ***REDACTED***"),
    (re.compile(r"(?i)(ftp|ftps|ftpes)://[^@\s/]+@"), r"\1://***REDACTED***@"),
    (re.compile(r"(?i)(ftp|ftps|ftpes)://[^:]+:[^@]+@"), r"\1://***REDACTED***@"),
]

if username:
    patterns.append((re.compile(re.escape(username) + r":\S+"), "***REDACTED***"))

for line in sys.stdin:
    if password:
        line = line.replace(password, "***REDACTED***")
    for regex, repl in patterns:
        line = regex.sub(repl, line)
    sys.stdout.write(line)
    sys.stdout.flush()
PY
}

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
  debug "lftp log (last ${lines} lines, ${size} bytes):"
  tail -n "$lines" "$LFTP_LAST_LOG" | redact_secrets >&2 || {
    debug "redaction failed — showing generic error only"
  }
}

# Build lftp "open ...;" with URL-encoded credentials (handles special chars in password).
lftp_open_line() {
  local proto="$1"
  local remote_path="${2:-}"
  FTP_PROTO="$proto" FTP_HOST="$FTP_HOST" FTP_USER="$FTP_USERNAME" FTP_PASS="$FTP_PASSWORD" FTP_PATH="$remote_path" python3 - <<'PY'
import os
import urllib.parse

proto = os.environ["FTP_PROTO"]
host = os.environ["FTP_HOST"]
user = urllib.parse.quote(os.environ["FTP_USER"], safe="")
passwd = urllib.parse.quote(os.environ["FTP_PASS"], safe="")
path = os.environ.get("FTP_PATH", "").strip("/")
suffix = f"/{path}" if path else "/"
print(f"open {proto}://{user}:{passwd}@{host}{suffix};")
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

run_lftp_script() {
  local proto="$1"
  local open_path="${2:-}"
  local script="$WORKDIR/lftp-$$.cmd"
  LFTP_LAST_LOG="$WORKDIR/lftp-run-$$.log"
  {
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
  local label="${proto}://${FTP_HOST}/${open_path}"
  debug "lftp connect (${label})"
  if lftp -f "$script" >"$LFTP_LAST_LOG" 2>&1; then
    ACTIVE_PROTOCOL="$proto"
    return 0
  fi
  debug "lftp connect failed (${label})"
  show_lftp_log 15
  return 1
}

protocols_to_try() {
  if [[ -n "${FTP_PROTOCOL:-}" ]]; then
    printf '%s\n' "$FTP_PROTOCOL"
    return
  fi
  printf '%s\n' ftp
}

# Remote directory paths to open directly (Netcup: ftp://user@host/httpdocs/).
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
      notice "Connect ${proto} host=${FTP_HOST} path=${remote_label}"
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
debug "host=${FTP_HOST} (normalized from FTP_SERVER secret)"
debug "timeouts net=${LFTP_NET_TIMEOUT}s cmd=${LFTP_CMD_TIMEOUT}s"
debug "FTP_PROTOCOL=${FTP_PROTOCOL:-<unset, using ftp>}"

if ! try_connect_and_mirror; then
  error "Failed to connect or mirror httpdocs from FTP"
  debug "Tried open paths: $(open_paths_to_try | tr '\n' ' ')"
  debug "Set FTP_REMOTE_DIR=httpdocs if your layout differs"
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
