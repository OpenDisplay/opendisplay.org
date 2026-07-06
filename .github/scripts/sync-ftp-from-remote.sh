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

LFTP_NET_TIMEOUT="${LFTP_NET_TIMEOUT:-15}"
LFTP_CMD_TIMEOUT="${LFTP_CMD_TIMEOUT:-120}"
LFTP_MAX_RETRIES="${LFTP_MAX_RETRIES:-1}"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

mkdir -p "$CACHE_DIR" "$REMOTE_MIRROR"

if [[ -z "${FTP_SERVER:-}" || -z "${FTP_USERNAME:-}" || -z "${FTP_PASSWORD:-}" ]]; then
  echo "::error::FTP_SERVER, FTP_USERNAME, and FTP_PASSWORD are required" >&2
  exit 1
fi

# Never print credentials — not even redacted host/user (GitHub may strip those lines).
debug() {
  echo "[$(date -u +'%H:%M:%S')] $*" >&2
}

notice() {
  echo "::notice::$*" >&2
}

error() {
  echo "::error::$*" >&2
}

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

safe_tail() {
  local file="$1"
  local lines="${2:-30}"
  [[ -f "$file" ]] || return 0
  tail -n "$lines" "$file" | redact_secrets >&2
}

write_netrc() {
  printf 'machine %s\nlogin %s\npassword %s\n' \
    "$FTP_SERVER" "$FTP_USERNAME" "$FTP_PASSWORD" > "$NETRC"
  chmod 600 "$NETRC"
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
    echo "open ${proto}://${FTP_SERVER};"
    cat
    echo "bye;"
  } > "$script"
  debug "lftp session starting (protocol=${proto})"
  if lftp -f "$script" >"$LFTP_LAST_LOG" 2>&1; then
    ACTIVE_PROTOCOL="$proto"
    return 0
  fi
  debug "lftp failed (protocol=${proto})"
  safe_tail "$LFTP_LAST_LOG" 20
  return 1
}

protocols_to_try() {
  if [[ -n "${FTP_PROTOCOL:-}" ]]; then
    printf '%s\n' "$FTP_PROTOCOL"
    return
  fi
  printf '%s\n' ftp ftpes ftps
}

ftp_connect_test() {
  local proto
  for proto in $(protocols_to_try); do
    notice "Testing FTP connection (protocol=${proto})"
    if run_lftp_script "$proto" <<'EOF'
pwd;
ls;
EOF
    then
      notice "FTP connection OK (protocol=${proto})"
      safe_tail "$LFTP_LAST_LOG" 25
      return 0
    fi
  done
  return 1
}

build_candidate_paths() {
  local paths=()
  local discovered="$WORKDIR/discovered-paths.txt"
  : > "$discovered"

  if [[ -f "$LFTP_LAST_LOG" ]]; then
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      case "$name" in
        httpdocs|HTTPDOCS)
          printf '%s/\n' "$name" >> "$discovered"
          printf '%s/\n' "/$name" >> "$discovered"
          ;;
        opendisplay.org)
          printf 'opendisplay.org/httpdocs/\n' >> "$discovered"
          printf '/opendisplay.org/httpdocs/\n' >> "$discovered"
          ;;
      esac
    done < <(grep -vE '^[[:space:]]*$|^[0-9]' "$LFTP_LAST_LOG" | awk '{print $NF}' | sed 's|/$||' || true)
  fi

  if [[ -n "${FTP_REMOTE_DIR:-}" ]]; then
    paths+=("$FTP_REMOTE_DIR")
  fi
  paths+=(
    "/opendisplay.org/httpdocs/"
    "opendisplay.org/httpdocs/"
    "httpdocs/"
    "/httpdocs/"
    "./httpdocs/"
  )

  if [[ -s "$discovered" ]]; then
    while IFS= read -r line; do
      paths+=("$line")
    done < "$discovered"
  fi

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
  local proto="${ACTIVE_PROTOCOL:-ftp}"
  debug "Probing path: ${remote_path}"
  if ! run_lftp_script "$proto" <<EOF
cd '${remote_path}';
pwd;
ls;
EOF
  then
    debug "Probe failed: ${remote_path}"
    return 1
  fi
  debug "Probe OK: ${remote_path}"
  safe_tail "$LFTP_LAST_LOG" 15
  return 0
}

mirror_remote_path() {
  local remote_path="$1"
  local proto="${ACTIVE_PROTOCOL:-ftp}"
  debug "Mirroring ${remote_path}"
  rm -rf "${REMOTE_MIRROR:?}"/*
  mkdir -p "$REMOTE_MIRROR"
  if ! run_lftp_script "$proto" <<EOF
cd '${remote_path}';
mirror --verbose --parallel=1 --no-perms --no-umask . ${REMOTE_MIRROR};
EOF
  then
    debug "Mirror command failed: ${remote_path}"
    return 1
  fi
  local files
  files=$(find "$REMOTE_MIRROR" -type f | wc -l)
  debug "Mirror done: ${files} file(s)"
  if [[ "$files" -eq 0 ]]; then
    safe_tail "$LFTP_LAST_LOG" 20
    return 1
  fi
  echo "$remote_path"
  return 0
}

try_all_paths_with_protocols() {
  local proto
  for proto in $(protocols_to_try); do
    notice "Trying paths with protocol=${proto}"
    ACTIVE_PROTOCOL=""
    if ! run_lftp_script "$proto" <<'EOF'
pwd;
ls;
EOF
    then
      continue
    fi
    ACTIVE_PROTOCOL="$proto"
    SELECTED_REMOTE=""
    while IFS= read -r candidate; do
      [[ -z "$candidate" ]] && continue
      if probe_remote_path "$candidate"; then
        if SELECTED_REMOTE=$(mirror_remote_path "$candidate"); then
          notice "Using remote path ${SELECTED_REMOTE} (protocol=${proto})"
          return 0
        fi
      fi
    done < <(build_candidate_paths)
  done
  return 1
}

notice "FTP sync script starting"
debug "timeouts: net=${LFTP_NET_TIMEOUT}s cmd=${LFTP_CMD_TIMEOUT}s"
debug "FTP_PROTOCOL env: ${FTP_PROTOCOL:-<not set, will try ftp then ftpes then ftps>}"

if ! ftp_connect_test; then
  error "Could not connect or list FTP root with any protocol"
fi

if ! try_all_paths_with_protocols; then
  error "Failed to mirror any candidate remote path"
  debug "Paths attempted:"
  while IFS= read -r p; do debug "  - ${p}"; done < <(build_candidate_paths)
  debug "Last lftp log:"
  safe_tail "$LFTP_LAST_LOG" 40
  debug "Set FTP_REMOTE_DIR if you know the exact folder (e.g. httpdocs/)"
  debug "Set FTP_PROTOCOL to ftp, ftpes, or ftps if auto-detect is wrong"
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
  debug "Remote manifest unchanged"
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
  debug "Remote changed but matches main — updating manifest cache only"
  cp "$NEW_MANIFEST" "$MANIFEST_FILE"
  echo "content_changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  notice "FTP updated but matches git main"
  exit 0
fi

cp "$NEW_MANIFEST" "$MANIFEST_FILE"
echo "content_changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
notice "FTP differs from git — PR will be opened"
