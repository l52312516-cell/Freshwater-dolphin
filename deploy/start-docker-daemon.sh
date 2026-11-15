#!/usr/bin/env bash
# Optional Linux helper: an isolated daemon whose storage stays in this checkout.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[[ "$EUID" == 0 ]] || { echo 'Run this helper as root; it does not install Docker or change the system daemon.' >&2; exit 1; }
command -v dockerd >/dev/null || { echo 'Install Docker Engine separately before using this helper.' >&2; exit 1; }
WORK="$ROOT/work"
mkdir -p "$WORK/temp" "$WORK/cache" "$WORK/docker" "$WORK/docker-exec" "$WORK/run" "$WORK/logs"
export TEMP="$WORK/temp" TMP="$WORK/temp" TMPDIR="$WORK/temp"
export XDG_CACHE_HOME="$WORK/cache"
export DOCKER_CONFIG="$WORK/cache/docker-client" BUILDX_CONFIG="$WORK/cache/buildx"
mkdir -p "$DOCKER_CONFIG" "$BUILDX_CONFIG"
SOCKET="$WORK/run/docker.sock"
PIDFILE="$WORK/run/docker.pid"
if [[ -f "$PIDFILE" ]]; then
    PID="$(cat "$PIDFILE")"
    if [[ "$PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$PID" 2>/dev/null; then
        EXE="$(readlink -f "/proc/$PID/exe" 2>/dev/null || true)"
        ARGS="$(tr '\0' '\n' <"/proc/$PID/cmdline" 2>/dev/null || true)"
        if [[ "${EXE##*/}" == dockerd ]] && grep -Fxq -- "--data-root=$WORK/docker" <<<"$ARGS"; then
            echo "Docker is already running. export DOCKER_HOST=unix://$SOCKET"
            exit 0
        fi
        echo 'PID file belongs to a different process; refusing to replace it.' >&2
        exit 1
    fi
fi
[[ ! -S "$SOCKET" ]] || { echo 'Socket already exists without a verified daemon; inspect it before restarting.' >&2; exit 1; }
nohup dockerd --host="unix://$SOCKET" --data-root="$WORK/docker" --exec-root="$WORK/docker-exec" \
    --pidfile="$PIDFILE" --bridge=none --iptables=false --ip-masq=false \
    >"$WORK/logs/docker.log" 2>&1 </dev/null &
PID=$!
for attempt in {1..60}; do
    if docker --host "unix://$SOCKET" info >/dev/null 2>&1; then
        echo "Docker ready. export DOCKER_HOST=unix://$SOCKET"
        exit 0
    fi
    kill -0 "$PID" 2>/dev/null || { echo 'Docker exited; see work/logs/docker.log' >&2; exit 1; }
    sleep 1
done
echo 'Docker startup timed out; inspect work/logs/docker.log before retrying.' >&2
exit 1
