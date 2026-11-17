#!/bin/sh
# This script runs as root inside the dedicated Alpine WSL2 distribution only.
# Docker and account data remain on its ext4 VHDX, never the mounted NTFS tree.
set -eu
umask 077
BASE=/var/lib/freshwater
CONF=/etc/freshwater
RUN=/run/freshwater
SOCKET=unix:///run/freshwater/docker.sock
export DOCKER_HOST="$SOCKET"
export TEMP="$BASE/temp" TMP="$BASE/temp" TMPDIR="$BASE/temp"
export HOME="$BASE/home" XDG_CACHE_HOME="$BASE/cache"
mkdir -p "$BASE/temp" "$BASE/home" "$BASE/cache" "$RUN"
die() { printf '%s\n' "Freshwater guest: $*" >&2; exit 1; }
valid_id() { [ "${#1}" -eq 32 ] && ! printf '%s' "$1" | grep -q '[^a-f0-9]'; }
owner() {
    valid_id "$1" || die 'invalid instance identity'
    [ -f "$CONF/owner" ] && [ "$(cat "$CONF/owner")" = "$1" ] || die 'distribution ownership mismatch'
}
dkr() { timeout -s TERM -k 2 3 docker "$@"; }
docker_ok() { dkr info >/dev/null 2>&1; }
container_exists() {
    names=$(dkr container ls --all --format '{{.Names}}') || return 2
    printf '%s\n' "$names" | grep -Fxq "$CONTAINER_NAME"
}
owned_container() {
    actual=$(dkr inspect --format '{{ index .Config.Labels "io.freshwater.instance" }}' "$CONTAINER_NAME") || return 2
    [ "$actual" = "$INSTANCE_ID" ] || die 'container belongs to another instance; refusing operation'
}
load_config() {
    owner "$1"
    [ -f "$CONF/runtime.env" ] || die 'runtime is not configured'
    . "$CONF/runtime.env"
    [ "$INSTANCE_ID" = "$1" ] || die 'runtime configuration ownership mismatch'
    # /run is not assumed to be tmpfs in an imported non-systemd WSL rootfs.
    # A changed kernel boot ID proves the previous processes no longer exist.
    # Serialize initialization so two first commands cannot clear a new live lock.
    exec 7>"$CONF/boot.lock"
    flock -w 5 7 || die 'boot identity initialization is busy'
    current_boot=$(cat /proc/sys/kernel/random/boot_id)
    previous_boot=$(cat "$RUN/boot-id" 2>/dev/null || true)
    if [ -n "$previous_boot" ] && [ "$previous_boot" != "$current_boot" ]; then
        rm -f "$RUN/docker.pid" "$RUN/container-active" "$RUN/stop" "$RUN/input-closed" "$RUN/lease" "$RUN/lease.next" "$RUN/serve.lock" "$RUN/stop.lock"
    fi
    printf '%s\n' "$current_boot" > "$RUN/boot-id.$$"
    mv "$RUN/boot-id.$$" "$RUN/boot-id"
    flock -u 7
    exec 7>&-
}
daemon_owned() {
    [ -f "$RUN/docker.pid" ] || return 1
    daemon_pid=$(cat "$RUN/docker.pid")
    case "$daemon_pid" in ''|*[!0-9]*) return 1;; esac
    [ -r "/proc/$daemon_pid/cmdline" ] || return 1
    [ "$(cat "/proc/$daemon_pid/comm")" = 'dockerd' ] || return 1
    tr '\000' '\n' < "/proc/$daemon_pid/cmdline" | grep -qx "$CONF/daemon.json"
}
stop_container() {
    if container_exists; then
        owned_container || return 1
        before=$(dkr inspect --format '{{.State.Running}}' "$CONTAINER_NAME") || return 1
        case "$before" in true|false) :;; *) echo 'Unable to inspect container running state' >&2; return 1;; esac
        if [ "$before" = true ]; then
            # 95 seconds belongs to the container grace period. The bounded CLI
            # deadline includes a small API overhead and cannot wait forever.
            timeout -s TERM -k 2 98 docker stop --time 95 "$CONTAINER_NAME" >/dev/null 2>&1 || true
        fi
        after=$(dkr inspect --format '{{.State.Running}}' "$CONTAINER_NAME") || return 1
        [ "$after" = false ] || { echo 'Container stop is unconfirmed; preserving daemon for diagnosis' >&2; return 1; }
    else
        code=$?
        [ "$code" -eq 1 ] || { echo 'Container enumeration failed; stop is unconfirmed' >&2; return 1; }
    fi
}
stop_owned() {
    # Serialize Ctrl+C, a separate stop command, and EOF cleanup. Never report
    # stopped while another caller is still waiting for the same container.
    exec 8>"$RUN/stop.lock"
    flock -w 145 8 || { echo 'Another stop is still pending' >&2; return 1; }
    stop_result=0
    if docker_ok; then
        stop_container || stop_result=1
    elif daemon_owned || [ -f "$RUN/container-active" ]; then
        echo 'Docker is unreachable; container stop cannot be confirmed' >&2
        stop_result=1
    fi
    if [ "$stop_result" -ne 0 ]; then flock -u 8; return 1; fi
    if daemon_owned; then
        kill -TERM "$daemon_pid" 2>/dev/null || true
        n=0
        while kill -0 "$daemon_pid" 2>/dev/null && [ "$n" -lt 12 ]; do sleep 1; n=$((n+1)); done
        # Never kill an unverified PID or a daemon from another distro.
        if daemon_owned; then kill -KILL "$daemon_pid" 2>/dev/null || true; fi
        n=0
        while daemon_owned && [ "$n" -lt 3 ]; do sleep 1; n=$((n+1)); done
    fi
    if daemon_owned || docker_ok; then
        echo 'Docker daemon shutdown could not be confirmed' >&2
        flock -u 8; return 1
    fi
    rm -f "$RUN/container-active"
    flock -u 8
}
command=${1:-}; shift || true
case "$command" in
install)
    [ "$#" -eq 2 ] || die 'install arguments'
    source_root=$1; instance=$2
    valid_id "$instance" || die 'invalid instance identity'
    if [ -f "$CONF/owner" ]; then owner "$instance"; else
        # A prebuilt release rootfs contains no owner. Existing foreign installs
        # must not be adopted merely because their WSL name matches.
        [ ! -e "$CONF/runtime.env" ] && [ ! -d "$BASE/work/control" ] || die 'unowned existing runtime'
    fi
    for utility in docker dockerd flock sha256sum timeout; do command -v "$utility" >/dev/null || die "missing prebuilt utility: $utility"; done
    [ -f "$source_root/deploy/windows/supervisor.sh" ] || die 'source supervisor missing'
    [ -f "$source_root/deploy/windows/upgrade.sh" ] || die 'source upgrade helper missing'
    mkdir -p "$CONF" /opt/freshwater "$BASE/work" "$BASE/logs"
    chmod 700 "$CONF" /opt/freshwater "$BASE" "$BASE/work" "$BASE/logs"
    cp "$source_root/deploy/windows/supervisor.sh" /opt/freshwater/supervisor.sh
    cp "$source_root/deploy/windows/upgrade.sh" /opt/freshwater/upgrade.sh
    chmod 700 /opt/freshwater/supervisor.sh
    chmod 700 /opt/freshwater/upgrade.sh
    printf '%s\n' "$instance" > "$CONF/owner"
    # Explicit mount preparation for older, non-systemd WSL distributions.
    mkdir -p /sys/fs/cgroup
    if ! grep -q ' /sys/fs/cgroup ' /proc/mounts; then
        mount -t cgroup2 none /sys/fs/cgroup || die 'WSL kernel lacks cgroup2; update WSL before running this release'
    fi
    printf '%s\n' '{"hosts":["unix:///run/freshwater/docker.sock"],"data-root":"/var/lib/docker","pidfile":"/run/freshwater/docker.pid","storage-driver":"overlay2","features":{"containerd-snapshotter":false},"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"},"live-restore":false}' > "$CONF/daemon.json"
    printf '%s\n' '{"installed":true}'
    ;;
configure)
    [ "$#" -eq 2 ] || die 'configure arguments'
    owner "$2"
    exec 6>"$CONF/upgrade.lock"
    flock -sn 6 || die 'runtime upgrade is in progress'
    [ ! -f "$BASE/upgrades/journal" ] || die 'interrupted runtime upgrade requires recovery'
    [ -f "$1" ] || die 'runtime configuration missing'
    # Input was generated and validated by the hash-verified host launcher.
    # It stays private on both NTFS and ext4 and is never written to stdout.
    cp "$1" "$CONF/runtime.env.new"
    chmod 600 "$CONF/runtime.env.new"
    . "$CONF/runtime.env.new"
    [ "$INSTANCE_ID" = "$2" ] || die 'configuration identity mismatch'
    [ "$(dkr --version | sed -n 's/^Docker version \([^,]*\),.*/\1/p')" = "$DOCKER_VERSION" ] || die 'Docker version differs from release manifest'
    [ "$(dkr compose version --short | sed 's/^v//')" = "$COMPOSE_VERSION" ] || die 'Compose version differs from release manifest'
    mv "$CONF/runtime.env.new" "$CONF/runtime.env"
    printf '%s\n' '{"configured":true}'
    ;;
status)
    [ "$#" -eq 1 ] || die 'status arguments'
    load_config "$1"
    running=false
    daemon_running=false
    if docker_ok; then
        daemon_running=true
        if container_exists; then
            owned_container || die 'container identity is unconfirmed'
            running=$(dkr inspect --format '{{.State.Running}}' "$CONTAINER_NAME") || die 'container state is unconfirmed'
            case "$running" in true|false) :;; *) die 'invalid container running state';; esac
        else
            [ "$?" -eq 1 ] || die 'container enumeration failed'
        fi
    elif daemon_owned || [ -f "$RUN/container-active" ]; then die 'Docker is unreachable; runtime state is unconfirmed'
    fi
    supervisor_running=false
    if ! flock -n "$RUN/serve.lock" true; then supervisor_running=true; fi
    printf '{"instanceId":"%s","running":%s,"daemonRunning":%s,"supervisorRunning":%s,"confirmed":true}\n' "$INSTANCE_ID" "$running" "$daemon_running" "$supervisor_running"
    ;;
setup-token)
    [ "$#" -eq 1 ] || die 'setup-token arguments'
    load_config "$1"
    # Existing Auth removes this file after bootstrap. No alternative password,
    # persistent Windows copy, or browser URL credential is introduced here.
    token_file="$BASE/work/control/setup-token.txt"
    if [ -f "$token_file" ] && [ ! -f "$BASE/work/control/admin.json" ] && [ ! -f "$BASE/work/control/initialized.json" ]; then
        cat "$token_file"
    fi
    ;;
stop)
    [ "$#" -eq 1 ] || die 'stop arguments'
    load_config "$1"
    # The foreground supervisor observes this signal and performs the same stop.
    # A marker also handles a lost stdin pipe without depending on console events.
    touch "$RUN/stop"
    stop_owned
    printf '{"instanceId":"%s","stopped":true,"confirmed":true}\n' "$INSTANCE_ID"
    ;;
upgrade)
    [ "$#" -ge 2 ] || die 'upgrade arguments'
    case "$1" in prepare|commit|rollback|status) :;; *) die 'invalid upgrade operation';; esac
    load_config "$2"
    exec /opt/freshwater/upgrade.sh "$@"
    ;;
serve)
    [ "$#" -eq 1 ] || die 'serve arguments'
    load_config "$1"
    exec 9>"$RUN/serve.lock"
    flock -n 9 || die 'Freshwater is already running'
    exec 6>"$CONF/upgrade.lock"
    flock -sn 6 || die 'runtime upgrade is in progress'
    [ ! -f "$BASE/upgrades/journal" ] || die 'interrupted runtime upgrade requires recovery'
    # A stale dockerd may survive a force-closed Windows terminal. Reclaim only
    # the owned daemon/container before creating this foreground generation.
    if docker_ok || daemon_owned || [ -f "$RUN/container-active" ]; then
        stop_owned || die 'interrupted runtime could not be stopped safely'
    fi
    rm -f "$RUN/stop" "$RUN/input-closed" "$RUN/lease"
    cleanup_started=0
    cleanup() {
        [ "$cleanup_started" -eq 0 ] || return
        cleanup_started=1
        [ -z "${reader_pid:-}" ] || kill "$reader_pid" 2>/dev/null || true
        stop_owned || return 1
        [ -z "${docker_child:-}" ] || wait "$docker_child" 2>/dev/null || true
        rm -f "$RUN/lease" "$RUN/input-closed" "$RUN/stop"
    }
    trap 'exit_code=$?; trap - EXIT; if cleanup; then exit "$exit_code"; else exit 1; fi' EXIT
    trap 'touch "$RUN/stop"' INT TERM HUP
    # Read host heartbeats independently of image loading and readiness checks.
    # EOF and a 20s missing heartbeat both stop this project, never all WSL.
    # POSIX shells may replace fd0 of an asynchronous list with /dev/null.
    # Preserve the host IPC pipe on an explicit descriptor before forking.
    exec 5<&0
    (
        while IFS= read -r line; do
            case "$line" in PING) date +%s > "$RUN/lease.next"; mv "$RUN/lease.next" "$RUN/lease";; STOP) touch "$RUN/stop"; break;; *) touch "$RUN/stop"; break;; esac
        done
        touch "$RUN/input-closed"
    ) <&5 &
    reader_pid=$!
    exec 5<&-
    date +%s > "$RUN/lease"
    dockerd --config-file "$CONF/daemon.json" >> "$BASE/logs/docker.log" 2>&1 &
    docker_child=$!
    n=0
    while ! docker_ok; do
        kill -0 "$docker_child" 2>/dev/null || die 'dockerd exited; inspect guest docker.log'
        [ ! -f "$RUN/stop" ] && [ ! -f "$RUN/input-closed" ] || exit 0
        n=$((n+1)); [ "$n" -lt 45 ] || die 'Docker readiness timed out'; sleep 1
    done
    [ "$(dkr info --format '{{.Driver}}')" = overlay2 ] || die 'release requires overlay2 storage; update WSL kernel instead of duplicating data with vfs'
    if ! dkr image inspect "$IMAGE_ID" >/dev/null 2>&1; then
        [ -f "$IMAGE_ARCHIVE" ] || die 'offline image archive missing'
        printf '%s\n' '{"event":"loading_offline_image"}'
        timeout -s TERM -k 2 480 docker load --input "$IMAGE_ARCHIVE" >> "$BASE/logs/image-load.log" 2>&1
    fi
    [ ! -f "$RUN/stop" ] && [ ! -f "$RUN/input-closed" ] || exit 0
    [ $(( $(date +%s) - $(cat "$RUN/lease" 2>/dev/null || echo 0) )) -le 20 ] || exit 0
    [ "$(dkr image inspect --format '{{.Id}}' "$IMAGE_ID")" = "$IMAGE_ID" ] || die 'loaded image digest differs from release manifest'
    if container_exists; then
        owned_container || die 'container identity mismatch'
        stop_container || die 'interrupted container could not be stopped'
        dkr rm "$CONTAINER_NAME" >/dev/null
    else
        [ "$?" -eq 1 ] || die 'container enumeration failed'
    fi
    chown 1000:1000 "$BASE/work"
    printf 'FWD_INSTANCE_ID=%s\nFWD_INSTANCE_TOKEN=%s\nFWD_RELEASE_VERSION=%s\nFWD_WEBUI_PORT=%s\nFWD_QQ_BACKGROUND_MODE=on\nFWD_RUNTIME_DEFER_ACCOUNTS=1\n' \
        "$INSTANCE_ID" "$INSTANCE_TOKEN" "$RELEASE_VERSION" "$GUEST_PORT" > "$CONF/container.env"
    chmod 600 "$CONF/container.env"
    timeout -s TERM -k 2 30 docker run --detach --name "$CONTAINER_NAME" --label "io.freshwater.instance=$INSTANCE_ID" \
        --label "io.freshwater.release=$RELEASE_VERSION" --restart=no --init --platform linux/amd64 \
        --shm-size 512m --memory "${MEMORY_MIB}m" --cpus "$PROCESSORS" --stop-timeout 95 \
        --publish "127.0.0.1:$HOST_PORT:$GUEST_PORT" --env-file "$CONF/container.env" \
        --mount "type=bind,source=$BASE/work,target=/workspace/work" "$IMAGE_ID" >/dev/null
    touch "$RUN/container-active"
    printf '%s\n' '{"event":"guest_started"}'
    while [ ! -f "$RUN/stop" ] && [ ! -f "$RUN/input-closed" ]; do
        last=$(cat "$RUN/lease" 2>/dev/null || echo 0)
        now=$(date +%s)
        [ $((now-last)) -le 20 ] || break
        docker_ok || die 'dockerd connection lost'
        [ "$(dkr inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" = true ] || die 'Freshwater container exited'
        sleep 2
    done
    ;;
*) die 'expected install, configure, serve, status, stop, setup-token, or upgrade';;
esac
