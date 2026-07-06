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

# Timeouts (seconds) — override via env if needed
LFTP_NET_TIMEOUT="${LFTP_NET_TIMEOUT:-30}"
LFTP_CMD_TIMEOUT="${LFTP_CMD_TIMEOUT:-300}"
LFTP_MAX_RETRIES="${LFTP_MAX_RETRIES:-2}"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR" "$REMOTE_MIRROR"

if [[ -z "${FTP_SERVER:-}" || -z "${FTP_USERNAME:-}" || -z "${FTP_PASSWORD:-}" ]]; then
  echo "FTP_SERVER, FTP_USERNAME, and FTP_PASSWORD are required" >&2
  exit 1
fi

PROTOCOL="${FTP_PROTOCOL:-ftp}"

# Redact FTP_PASSWORD and common credential patterns from any log line.
# Uses Python for literal replacement (safe with special regex chars in passwords).
redact_secrets() {
  FTP_PASSWORD="$FTP_PASSWORD" FTP_USERNAME="$FTP_USERNAME" python3 - <<'PY'
import os
import re
import sys

password = os.environ.get("FTP_PASSWORD", "")
username = os.environ.get("FTP_USERNAME", "")

patterns: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^password\s+\S+", re.IGNORECASE), "password ***REDACTED***"),
    (re.compile(r"^(login|user)\s+\S+", re.IGNORECASE), r"\1 ***REDACTED***"),
    (re.compile(r"(?i)(ftp|ftps)://[^@\s/]+@"), r"\1://***REDACTED***@"),
    (re.compile(r"(?i)(ftp|ftps)://[^:]+:[^@]+@"), r"\1://***REDACTED***@"),
]

if username:
    patterns.append((re.compile(re.escape(username) + r":\S+"), "***REDACTED***"))

for line in sys.stdin:
    if password:
        line = line.replace(password, "***REDACTED***")
    for regex, repl in patterns:
        line = regex.sub(repl, line)
    sys.stdout.write(line)
PY
}

safe_tail() {
  local file="$1"
  local lines="${2:-30}"
  [[ -f "$file" ]] || return 0
  tail -n "$lines" "$file" | redact_secrets
}

debug() {
  printf '[%s] %s\n' "$(date -u +"%H:%M:%S")" "$*" | redact_secrets
}

write_netrc() {
  printf 'machine %s\nlogin %s\npassword %s\n' \
    "$FTP_SERVER" "$FTP_USERNAME" "$FTP_PASSWORD" > "$NETRC"
  chmod 600 "$NETRC"
}

lftp_common_settings() {
  cat <<EOF
set net:netrc-file ${NETRC};
set ftp:passive-mode true;
set net:timeout ${LFTP_NET_TIMEOUT};
set net:max-retries ${LFTP_MAX_RETRIES};
set net:reconnect-interval-base 5;
set cmd:default-timeout ${LFTP_CMD_TIMEOUT};
set cmd:fail-exit yes;
EOF
  if [[ "$PROTOCOL" == "ftps" ]]; then
    echo "set ftp:ssl-force true;"
    echo "set ssl:verify-certificate no;"
  fi
  # Intentionally no cmd:trace / debug — they can echo credentials from netrc.
}

run_lftp_script() {
  local script="$WORKDIR/lftp-$$.cmd"
  LFTP_LAST_LOG="$WORKDIR/lftp-run-$$.log"
  write_netrc
  {
    lftp_common_settings
    echo "open ${PROTOCOL}://${FTP_SERVER};"
    cat
    echo "bye;"
  } > "$script"
  debug "Running lftp ($(wc -l < "$script") lines) ..."
  if [[ "${FTP_DEBUG:-}" == "1" ]]; then
    debug "--- lftp script (no credentials) ---"
    head -30 "$script" | redact_secrets
    debug "--- end preview ---"
  fi
  if lftp -f "$script" >"$LFTP_LAST_LOG" 2>&1; then
    return 0
  fi
  debug "lftp exited with error"
  safe_tail "$LFTP_LAST_LOG" 25
  return 1
}

build_candidate_paths() {
  local paths=()
  if [[ -n "${FTP_REMOTE_DIR:-}" ]]; then
    paths+=("$FTP_REMOTE_DIR")
  fi
  paths+=(
    "/opendisplay.org/httpdocs/"
    "httpdocs/"
    "/httpdocs/"
    "opendisplay.org/httpdocs/"
  )
  local seen="" p norm
  for p in "${paths[@]}"; do
    norm="${p%/}/"
    if [[ "$seen" != *"|${norm}|"* ]]; then
      seen="${seen}|${norm}|"
      printf '%s\n' "$norm"
    fi
  done
}

probe_remote_path() {
  local remote_path="$1"
  local probe_out
  debug "Probing: ${remote_path}"
  if ! run_lftp_script <<EOF
pwd;
echo __MARK_PWD__;
pwd;
echo __MARK_CD__;
cd '${remote_path}';
pwd;
echo __MARK_LS__;
ls;
echo __MARK_DONE__;
EOF
  then
    debug "  probe failed for ${remote_path}"
    return 1
  fi
  probe_out="$LFTP_LAST_LOG"
  if ! grep -q __MARK_CD__ "$probe_out" || ! grep -q __MARK_DONE__ "$probe_out"; then
    debug "  probe incomplete for ${remote_path}"
    safe_tail "$probe_out" 15
    return 1
  fi
  debug "  probe ok"
  sed -n '/__MARK_PWD__/,/__MARK_DONE__/p' "$probe_out" | grep -v __MARK_ | head -30 | redact_secrets
  return 0
}

mirror_remote_path() {
  local remote_path="$1"
  debug "Mirroring ${remote_path} -> ${REMOTE_MIRROR}"
  rm -rf "${REMOTE_MIRROR:?}"/*
  mkdir -p "$REMOTE_MIRROR"
  if run_lftp_script <<EOF
pwd;
cd '${remote_path}';
pwd;
mirror --verbose --parallel=2 --no-perms --no-umask . ${REMOTE_MIRROR};
EOF
  then
    local files
    files=$(find "$REMOTE_MIRROR" -type f | wc -l)
    debug "Mirror finished: ${files} file(s)"
    if [[ "$files" -eq 0 ]]; then
      debug "Mirror returned 0 files"
      safe_tail "$LFTP_LAST_LOG" 30
      return 1
    fi
    echo "$remote_path"
    return 0
  fi
  debug "Mirror command failed for ${remote_path}"
  return 1
}

debug "FTP sync starting"
debug "  server=${FTP_SERVER} protocol=${PROTOCOL} user=${FTP_USERNAME}"
debug "  net:timeout=${LFTP_NET_TIMEOUT}s cmd:timeout=${LFTP_CMD_TIMEOUT}s"
debug "  local httpdocs=${HTTPDOCS}"

debug "Listing FTP root (pwd + ls) ..."
if run_lftp_script <<'EOF'; then
pwd;
ls;
EOF
  safe_tail "$LFTP_LAST_LOG" 40
else
  debug "FTP root listing failed"
fi

SELECTED_REMOTE=""
while IFS= read -r candidate; do
  [[ -z "$candidate" ]] && continue
  if probe_remote_path "$candidate"; then
    if SELECTED_REMOTE=$(mirror_remote_path "$candidate"); then
      debug "Using remote path: ${SELECTED_REMOTE}"
      break
    fi
  fi
done < <(build_candidate_paths)

if [[ -z "$SELECTED_REMOTE" ]]; then
  echo "Failed to mirror any candidate remote path" >&2
  debug "Candidate paths tried:"
  build_candidate_paths | while read -r p; do debug "  - $p"; done
  debug "Tip: set FTP_REMOTE_DIR to the correct path, or FTP_DEBUG=1 for script preview"
  exit 1
fi

echo "remote_path=${SELECTED_REMOTE}" >> "${GITHUB_OUTPUT:-/dev/null}"

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
debug "Built manifest ($(wc -l < "$NEW_MANIFEST") entries)"

remote_changed=true
if [[ -f "$MANIFEST_FILE" ]] && cmp -s "$MANIFEST_FILE" "$NEW_MANIFEST"; then
  remote_changed=false
  debug "Remote manifest unchanged"
fi

if [[ "$remote_changed" == false ]]; then
  echo "remote_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

echo "remote_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"

debug "Applying remote tree to httpdocs/"
rsync -a --delete "$REMOTE_MIRROR/" "$HTTPDOCS/"

if git -C "$REPO_ROOT" diff --quiet -- httpdocs/; then
  debug "Remote changed but content matches main — updating manifest cache only"
  cp "$NEW_MANIFEST" "$MANIFEST_FILE"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

cp "$NEW_MANIFEST" "$MANIFEST_FILE"
echo "content_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
debug "Detected differences between live FTP and repository"
