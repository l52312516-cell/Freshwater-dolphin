#!/usr/bin/env bash
# One independently supervised QQ instance. No host Docker access is required.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
: "${FWD_ACCOUNT_ROOT:?FWD_ACCOUNT_ROOT is required}"
: "${FWD_CONFIG:?FWD_CONFIG is required}"
: "${FWD_RPC_DIR:?FWD_RPC_DIR is required}"
: "${DISPLAY:?DISPLAY is required}"
[[ "$DISPLAY" =~ ^:[0-9]{1,5}$ ]] || { echo 'Invalid private X display' >&2; exit 1; }
ACCOUNT="$(realpath -e "$FWD_ACCOUNT_ROOT")"
[[ "$ACCOUNT" == "$FWD_ACCOUNT_ROOT" && "$(dirname "$ACCOUNT")" == "$ROOT/work/accounts" && "$(basename "$ACCOUNT")" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || { echo 'Account root must be a direct private workspace account directory' >&2; exit 1; }
for directory in "$ROOT/work" "$ROOT/work/accounts" "$ACCOUNT"; do
    [[ ! -L "$directory" && "$(realpath -e "$directory")" == "$directory" ]] || { echo 'Account path must not contain symbolic links' >&2; exit 1; }
done
[[ "$FWD_CONFIG" == "$ACCOUNT/"* && "$FWD_RPC_DIR" == "$ACCOUNT/"* ]] || { echo 'Account configuration and RPC must stay private to this account' >&2; exit 1; }
export FWD_ACCOUNT_ROOT="$ACCOUNT"
export TEMP="$ACCOUNT/temp" TMP="$ACCOUNT/temp" TMPDIR="$ACCOUNT/temp"
export HOME="$ACCOUNT/home" XDG_CACHE_HOME="$ACCOUNT/cache"
export XDG_CONFIG_HOME="$ACCOUNT/config" XDG_DATA_HOME="$ACCOUNT/data"
export XDG_RUNTIME_DIR="$ACCOUNT/runtime" npm_config_cache="$ACCOUNT/cache/npm"
export FWD_MEDIA_DIR="$ACCOUNT/media"
for directory in "$TEMP" "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$FWD_RPC_DIR" "$FWD_MEDIA_DIR" "$ACCOUNT/qq-root" "$ACCOUNT/logs" "$ACCOUNT/state"; do
    [[ "$(realpath -m "$directory")" == "$directory" && "$directory" == "$ACCOUNT/"* ]] || { echo 'Account runtime path must not follow symbolic links or parent traversals' >&2; exit 1; }
    mkdir -p "$directory"
    [[ "$(realpath -e "$directory")" == "$directory" && "$directory" == "$ACCOUNT/"* ]] || { echo 'Account runtime path must not follow symbolic links' >&2; exit 1; }
    chmod 700 "$directory"
done
[[ "$(realpath -e "$FWD_CONFIG")" == "$FWD_CONFIG" && -f "$FWD_CONFIG" ]] || { echo 'Account configuration must be an ordinary private file' >&2; exit 1; }
PIDS=()
python3 deploy/account-processes.py init "$ACCOUNT" "$$"
cleanup() {
    trap - EXIT TERM INT
    python3 deploy/account-processes.py signal-term "$ACCOUNT" "$$" || true
    local deadline=$((SECONDS + 20))
    while (( SECONDS < deadline )); do
        if python3 deploy/account-processes.py idle "$ACCOUNT" "$$"; then break; fi
        sleep 0.25
    done
    python3 deploy/account-processes.py signal-kill "$ACCOUNT" "$$" || true
    wait 2>/dev/null || true
    python3 deploy/account-processes.py clear "$ACCOUNT" "$$" || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
PACKAGE="$ROOT/work/cache/downloads/QQ.deb"
CHECKSUM="$ROOT/work/cache/downloads/QQ.sha256"
[[ -f "$PACKAGE" && -f "$CHECKSUM" && ! -L "$PACKAGE" && ! -L "$CHECKSUM" ]] || { echo 'Provide the shared official QQ.deb and independent SHA256 first' >&2; exit 1; }
EXPECTED="$(awk 'NR==1 {print $1}' "$CHECKSUM")"
[[ "$EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'QQ.sha256 must start with the expected SHA256' >&2; exit 1; }
printf '%s  %s\n' "$EXPECTED" "$PACKAGE" | sha256sum --check --status - || { echo 'QQ package SHA256 mismatch' >&2; exit 1; }
[[ "$(dpkg-deb --field "$PACKAGE" Architecture)" == amd64 && "$(dpkg-deb --field "$PACKAGE" Version)" == 3.2.35-54395 ]] || { echo 'Only Linux amd64 QQ 3.2.35-54395 is verified' >&2; exit 1; }
export FWD_QQ_VERSION=3.2.35-54395
MARKER="$ACCOUNT/qq-root/.freshwater-deb.sha256"
if [[ -f "$MARKER" && ! -L "$MARKER" ]]; then
    [[ "$(cat "$MARKER")" == "${EXPECTED,,}" ]] || { echo 'Account QQ package differs; preserve state and explicitly migrate it' >&2; exit 1; }
else
    [[ ! -e "$MARKER" && ! -e "$ACCOUNT/qq-root/opt/QQ/qq" ]] || { echo 'Existing account QQ tree has no valid ownership marker' >&2; exit 1; }
    dpkg-deb --extract "$PACKAGE" "$ACCOUNT/qq-root"
    printf '%s\n' "${EXPECTED,,}" >"$MARKER"
fi
QQ="$ACCOUNT/qq-root/opt/QQ/qq"
[[ -x "$QQ" ]] || { echo 'Account QQ executable is missing' >&2; exit 1; }
if [[ "${FWD_BRIDGE_ENABLED:-1}" == 0 ]]; then
    node tools/prepare-qq.cjs --account-root "$ACCOUNT" --app-dir "$ACCOUNT/qq-root/opt/QQ/resources/app" --restore >/dev/null
elif [[ "${FWD_BRIDGE_ENABLED:-1}" == 1 ]]; then
    node tools/prepare-qq.cjs --account-root "$ACCOUNT" --app-dir "$ACCOUNT/qq-root/opt/QQ/resources/app" >/dev/null
else
    echo 'Invalid bridge mode' >&2; exit 1
fi
setsid bash -o pipefail -c 'Xvfb "$1" -screen 0 1280x900x24 -nolisten tcp 2>&1 | node "$2/deploy/rotate-log.cjs" "$3/logs/xvfb.log"' -- "$DISPLAY" "$ROOT" "$ACCOUNT" &
PIDS+=("$!")
python3 deploy/account-processes.py record "$ACCOUNT" "$$" "${PIDS[@]}"
for attempt in {1..40}; do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    kill -0 "${PIDS[0]}" 2>/dev/null || { echo 'Private Xvfb exited' >&2; exit 1; }
    sleep 0.25
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo 'Private Xvfb did not become ready' >&2; exit 1; }
setsid bash -o pipefail -c 'dbus-run-session -- env -u NODE_OPTIONS -u LD_PRELOAD "$1" --no-sandbox --disable-gpu --in-process-gpu --disable-dev-shm-usage 2>&1 | node "$2/deploy/rotate-log.cjs" "$3/logs/qq.log"' -- "$QQ" "$ROOT" "$ACCOUNT" &
PIDS+=("$!")
python3 deploy/account-processes.py record "$ACCOUNT" "$$" "${PIDS[@]}"
if [[ "${FWD_BRIDGE_ENABLED:-1}" == 1 ]]; then
    setsid node src/cli.cjs --config "$FWD_CONFIG" &
    PIDS+=("$!")
    python3 deploy/account-processes.py record "$ACCOUNT" "$$" "${PIDS[@]}"
fi
echo 'Account processes started; identity, QQ online and OneBot connections are independently confirmed.'
set +e
wait -n "${PIDS[@]}"
RESULT=$?
set -e
[[ "$RESULT" != 0 ]] || RESULT=1
exit "$RESULT"
