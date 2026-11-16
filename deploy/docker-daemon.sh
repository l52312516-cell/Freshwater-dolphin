#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT"
export PATH="$ROOT/runtime/docker:$ROOT/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TEMP="$ROOT/work/temp" TMP="$ROOT/work/temp" TMPDIR="$ROOT/work/temp"
export HOME="$ROOT/work/home" XDG_CACHE_HOME="$ROOT/work/cache"
mkdir -p work/temp work/cache work/home work/run work/logs work/docker work/docker-exec
test -x runtime/docker/dockerd
# Refuse to take over an independently running daemon. Stop it deliberately
# before the first systemd handoff; never kill a PID solely from a stale file.
if [[ -s work/run/docker.pid ]]; then
  task_pid=$(cat work/run/docker.pid)
  if [[ "$task_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$task_pid" 2>/dev/null; then
    echo "A Docker daemon already owns this workspace; complete the handoff first" >&2
    exit 1
  fi
fi
exec runtime/docker/dockerd --host="unix://$ROOT/work/run/docker.sock" \
  --data-root="$ROOT/work/docker" --exec-root="$ROOT/work/docker-exec" \
  --pidfile="$ROOT/work/run/docker.pid" --bridge=none --iptables=false --ip-masq=false --log-level=warn
