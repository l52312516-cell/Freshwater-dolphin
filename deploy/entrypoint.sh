#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /workspace
export TEMP=/workspace/work/temp TMP=/workspace/work/temp TMPDIR=/workspace/work/temp
export HOME=/workspace/work/home XDG_CACHE_HOME=/workspace/work/cache
export XDG_CONFIG_HOME=/workspace/work/config XDG_DATA_HOME=/workspace/work/data
export XDG_RUNTIME_DIR=/workspace/work/runtime npm_config_cache=/workspace/work/cache/npm
mkdir -p "$TEMP" "$HOME" "$XDG_CACHE_HOME/downloads" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" work/accounts work/control work/logs work/state
chmod 700 "$TEMP" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" work/accounts work/control work/logs work/state
exec node src/manager/cli.cjs
