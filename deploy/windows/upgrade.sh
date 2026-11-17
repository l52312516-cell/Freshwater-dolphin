#!/bin/sh
# Cold application snapshots live only inside this instance's ext4 VHDX.
# No Docker graph, host path, QQ process, or network service is copied here.
set -eu
umask 077
BASE=/var/lib/freshwater
CONF=/etc/freshwater
SUPERVISOR=/opt/freshwater/supervisor.sh
UP="$BASE/upgrades"

die() { printf '%s\n' "Freshwater upgrade: $*" >&2; exit 1; }
valid_id() { [ "${#1}" -eq 32 ] && ! printf '%s' "$1" | grep -q '[^a-f0-9]'; }
ordinary_file() { [ -f "$1" ] && [ ! -L "$1" ]; }
ordinary_dir() { [ -d "$1" ] && [ ! -L "$1" ]; }
safe_ancestors() {
    checked=$1
    while [ "$checked" != / ]; do
        ordinary_dir "$checked" || die "unsafe directory: $checked"
        checked=${checked%/*}; [ -n "$checked" ] || checked=/
    done
}
persist() { sync; }
write_record() {
    destination=$1; record=$2
    [ ! -L "$destination" ] || die 'unsafe transaction record'
    if [ -e "$destination.next" ] || [ -L "$destination.next" ]; then
        ordinary_file "$destination.next" || die 'unsafe temporary transaction record'
        rm -f "$destination.next"
    fi
    (set -C; printf '%s\n' "$record" > "$destination.next")
    chmod 600 "$destination.next"
    persist
    mv -f "$destination.next" "$destination"
    persist
}
read_record() {
    ordinary_file "$1" || die 'invalid transaction record'
    IFS=' ' read -r RECORD_PHASE RECORD_GENERATION RECORD_EXTRA < "$1" || die 'empty transaction record'
    [ -z "$RECORD_EXTRA" ] && valid_id "$RECORD_GENERATION" || die 'invalid transaction identity'
    [ "$(wc -l < "$1" | tr -d ' ')" = 1 ] || die 'invalid transaction record length'
}
load_state() {
    PHASE=none; GENERATION=
    if [ -e "$UP/state" ] || [ -L "$UP/state" ]; then
        read_record "$UP/state"
        case "$RECORD_PHASE" in prepared|committed|rolled_back) :;; *) die 'invalid snapshot phase';; esac
        PHASE=$RECORD_PHASE; GENERATION=$RECORD_GENERATION
    fi
}
load_journal() {
    OP=; JOURNAL_GENERATION=
    if [ -e "$UP/journal" ] || [ -L "$UP/journal" ]; then
        read_record "$UP/journal"
        case "$RECORD_PHASE" in copying|switching|rollback) :;; *) die 'invalid recovery phase';; esac
        OP=$RECORD_PHASE; JOURNAL_GENERATION=$RECORD_GENERATION
    fi
}
marker_matches() {
    ordinary_dir "$1" && ordinary_file "$1/owner" && ordinary_file "$1/generation" &&
        [ "$(cat "$1/owner")" = "$INSTANCE" ] && [ "$(cat "$1/generation")" = "$2" ]
}
validate_tree() {
    ordinary_dir "$1" || die 'private work directory is missing or unsafe'
    # Relative internal links retain their meaning after a cold copy. Absolute,
    # dangling and escaping links and all special files are rejected explicitly.
    if [ -n "$(find "$1" ! -type d ! -type f ! -type l -print -quit)" ]; then die 'private work contains a special file'; fi
    if ! find "$1" -type l -exec sh -c '
        tree=$1; shift
        for link do
            target=$(readlink "$link") || exit 1
            case "$target" in /*) exit 1;; esac
            resolved=$(readlink -f "$link") || exit 1
            [ -f "$resolved" ] || [ -d "$resolved" ] || exit 1
            case "$resolved" in "$tree"/*) :;; *) exit 1;; esac
        done
    ' sh "$1" {} +; then die 'private work contains an unsafe symbolic link'; fi
}
snapshot_complete() {
    marker_matches "$UP/current" "$GENERATION" && ordinary_dir "$UP/current/work" && ordinary_file "$UP/current/runtime.env"
}
require_stopped() {
    ordinary_file "$CONF/runtime.env" || die 'runtime configuration is missing or unsafe'
    status_json=$(timeout -s TERM -k 2 20 "$SUPERVISOR" status "$INSTANCE") || die 'runtime shutdown is unconfirmed'
    # Supervisor is a fixed, owned program. Match its exact compact status
    # schema, rather than sourcing a shell record or accepting partial fields.
    expected="{\"instanceId\":\"$INSTANCE\",\"running\":false,\"daemonRunning\":false,\"supervisorRunning\":false,\"confirmed\":true}"
    [ "$status_json" = "$expected" ] || die 'container, daemon and supervisor must be confirmed stopped'
}
cleanup_retired() {
    for item in retired displaced-work; do
        if [ -e "$UP/$item" ] || [ -L "$UP/$item" ]; then
            ordinary_dir "$UP/$item" || die 'unsafe retired transaction directory'
            rm -rf "$UP/$item"
        fi
    done
    if [ -e "$UP/staging" ] || [ -L "$UP/staging" ]; then
        ordinary_dir "$UP/staging" || die 'unsafe snapshot staging directory'
        rm -rf "$UP/staging"
    fi
    if [ "$PHASE" = rolled_back ] && [ -d "$UP/current" ]; then
        marker_matches "$UP/current" "$GENERATION" || die 'rollback metadata ownership mismatch'
        [ ! -e "$UP/current/work" ] || die 'unexpected unconsumed rollback state'
        rm -rf "$UP/current"
    fi
}
finish_prepare() {
    GENERATION=$JOURNAL_GENERATION
    if ! marker_matches "$UP/current" "$GENERATION"; then
        marker_matches "$UP/staging" "$GENERATION" && ordinary_file "$UP/staging/ready" || die 'prepared snapshot is incomplete'
        if [ -e "$UP/current" ] || [ -L "$UP/current" ]; then
            ordinary_dir "$UP/current" && ordinary_file "$UP/current/owner" && [ "$(cat "$UP/current/owner")" = "$INSTANCE" ] || die 'previous snapshot is unsafe'
            [ ! -e "$UP/retired" ] && [ ! -L "$UP/retired" ] || die 'ambiguous snapshot replacement'
            mv "$UP/current" "$UP/retired"; persist
        fi
        mv "$UP/staging" "$UP/current"; persist
    fi
    snapshot_complete || die 'snapshot replacement is incomplete'
    write_record "$UP/state" "prepared $GENERATION"
    rm -f "$UP/journal"; persist
    PHASE=prepared; OP=
    cleanup_retired
}
finish_rollback() {
    GENERATION=$JOURNAL_GENERATION
    marker_matches "$UP/current" "$GENERATION" || die 'rollback snapshot ownership mismatch'
    ordinary_file "$UP/current/runtime.env" || die 'rollback configuration is missing'
    # The snapshot's work is consumed exactly once. Presence at each fixed path
    # disambiguates a crash immediately after either durable directory rename.
    if [ -e "$UP/current/work" ] || [ -L "$UP/current/work" ]; then
        ordinary_dir "$UP/current/work" || die 'unsafe rollback work directory'
        if [ -e "$BASE/work" ] || [ -L "$BASE/work" ]; then
            ordinary_dir "$BASE/work" || die 'unsafe active work directory'
            [ ! -e "$UP/displaced-work" ] && [ ! -L "$UP/displaced-work" ] || die 'ambiguous work replacement'
            mv "$BASE/work" "$UP/displaced-work"; persist
        else
            ordinary_dir "$UP/displaced-work" || die 'active work disappeared without a recovery copy'
        fi
        mv "$UP/current/work" "$BASE/work"; persist
    else
        ordinary_dir "$BASE/work" && ordinary_dir "$UP/displaced-work" || die 'restored work cannot be confirmed'
    fi
    # Atomic replacement keeps runtime.env present even across a power loss.
    # Until the journal clears, the supervisor refuses to run this mixed state.
    [ ! -L "$CONF/runtime.env.restore" ] || die 'unsafe configuration restore path'
    if [ -e "$CONF/runtime.env.restore" ]; then ordinary_file "$CONF/runtime.env.restore" || die 'unsafe configuration restore path'; rm -f "$CONF/runtime.env.restore"; fi
    (set -C; : > "$CONF/runtime.env.restore")
    cp -p "$UP/current/runtime.env" "$CONF/runtime.env.restore"
    chmod 600 "$CONF/runtime.env.restore"; persist
    mv -f "$CONF/runtime.env.restore" "$CONF/runtime.env"; persist
    write_record "$UP/state" "rolled_back $GENERATION"
    rm -f "$UP/journal"; persist
    PHASE=rolled_back; OP=
    cleanup_retired
}
emit_status() {
    available=false; confirmed=true; response_phase=$PHASE
    if [ -n "$OP" ]; then
        confirmed=false
        case "$OP" in copying|switching) response_phase=preparing;; rollback) response_phase=rolling_back;; esac
    elif [ "$PHASE" = prepared ] || [ "$PHASE" = committed ]; then
        snapshot_complete || die 'snapshot integrity cannot be confirmed'
        available=true
    fi
    # Host physical-volume budgeting must include the next full work copy.
    # A rollback between directory renames still has a measurable displaced
    # work tree; it is never mistaken for an empty instance.
    size_tree="$BASE/work"
    if ! ordinary_dir "$size_tree"; then
        if ordinary_dir "$UP/displaced-work"; then size_tree="$UP/displaced-work"; else die 'private work size cannot be measured'; fi
    fi
    work_kib=$(du -sk "$size_tree" | awk '{print $1}')
    case "$work_kib" in ''|*[!0-9]*) die 'private work size cannot be measured';; esac
    work_bytes=$((work_kib * 1024))
    [ "$work_bytes" -ge 0 ] || die 'private work size exceeds supported range'
    printf '{"instanceId":"%s","phase":"%s","snapshotAvailable":%s,"confirmed":%s,"workSizeBytes":%s}\n' "$INSTANCE" "$response_phase" "$available" "$confirmed" "$work_bytes"
}

[ "$#" -eq 2 ] || die 'expected operation and instance identity'
COMMAND=$1; INSTANCE=$2
case "$COMMAND" in prepare|commit|rollback|status) :;; *) die 'invalid upgrade operation';; esac
valid_id "$INSTANCE" || die 'invalid instance identity'
safe_ancestors "$BASE"; safe_ancestors "$CONF"
ordinary_file "$CONF/owner" && [ "$(cat "$CONF/owner")" = "$INSTANCE" ] || die 'distribution ownership mismatch'
[ ! -L "$CONF/upgrade.lock" ] || die 'unsafe upgrade lock'
exec 8>>"$CONF/upgrade.lock"
case "$COMMAND" in prepare|rollback) flock -w 10 8;; *) flock -sw 10 8;; esac || die 'runtime upgrade is busy'
if [ -e "$UP" ] || [ -L "$UP" ]; then ordinary_dir "$UP" || die 'unsafe upgrade directory'; else mkdir "$UP"; fi
chmod 700 "$UP"
[ ! -L "$UP/metadata.lock" ] || die 'unsafe metadata lock'
exec 9>>"$UP/metadata.lock"; flock -w 10 9 || die 'snapshot metadata is busy'
# Fixed children must never redirect writes/removals outside this VHDX tree.
for item in state state.next journal journal.next staging current retired displaced-work; do
    [ ! -L "$UP/$item" ] || die 'unsafe transaction path'
done
load_state; load_journal
case "$COMMAND" in
status) emit_status;;
prepare)
    require_stopped
    case "$OP" in rollback) die 'interrupted rollback must be recovered first';; switching) finish_prepare; emit_status; exit 0;; esac
    if [ -z "$OP" ] && [ "$PHASE" = prepared ]; then snapshot_complete || die 'prepared snapshot is incomplete'; emit_status; exit 0; fi
    if [ -z "$OP" ]; then
        cleanup_retired
        GENERATION=$(tr -d '-' < /proc/sys/kernel/random/uuid)
        valid_id "$GENERATION" || die 'could not create snapshot generation'
    else GENERATION=$JOURNAL_GENERATION; fi
    validate_tree "$BASE/work"
    ordinary_file "$CONF/runtime.env" || die 'runtime configuration is unsafe'
    if [ -e "$UP/staging" ]; then ordinary_dir "$UP/staging" || die 'unsafe staging directory'; rm -rf "$UP/staging"; fi
    needed_kib=$(du -sk "$BASE/work" | awk '{print $1}')
    free_kib=$(df -Pk "$BASE" | awk 'END {print $4}')
    case "$needed_kib:$free_kib" in *[!0-9:]*) die 'guest free space cannot be measured';; esac
    [ -n "$needed_kib" ] && [ -n "$free_kib" ] || die 'guest free space cannot be measured'
    [ "$free_kib" -ge "$((needed_kib + 5242880))" ] || die 'guest snapshot needs the work size plus 5 GiB free reserve'
    if [ -z "$OP" ]; then write_record "$UP/journal" "copying $GENERATION"; fi
    mkdir "$UP/staging"
    cp -a "$BASE/work" "$UP/staging/work"
    cp -p "$CONF/runtime.env" "$UP/staging/runtime.env"
    printf '%s\n' "$INSTANCE" > "$UP/staging/owner"
    printf '%s\n' "$GENERATION" > "$UP/staging/generation"
    touch "$UP/staging/ready"; persist
    write_record "$UP/journal" "switching $GENERATION"
    JOURNAL_GENERATION=$GENERATION; finish_prepare; emit_status
    ;;
commit)
    [ -z "$OP" ] || die 'interrupted snapshot operation requires recovery'
    case "$PHASE" in prepared|committed) :;; *) die 'there is no prepared snapshot to commit';; esac
    snapshot_complete || die 'snapshot integrity cannot be confirmed'
    write_record "$UP/state" "committed $GENERATION"; PHASE=committed
    cleanup_retired; emit_status
    ;;
rollback)
    require_stopped
    case "$OP" in
    copying)
        # No live state has changed. Cancel a partial copy without ever treating
        # it as a usable snapshot, and retain any earlier committed snapshot.
        if [ -e "$UP/staging" ]; then ordinary_dir "$UP/staging" || die 'unsafe staging directory'; rm -rf "$UP/staging"; fi
        rm -f "$UP/journal"; persist; OP=
        emit_status; exit 0
        ;;
    switching) finish_prepare;;
    esac
    if [ -z "$OP" ] && [ "$PHASE" = rolled_back ]; then cleanup_retired; emit_status; exit 0; fi
    if [ -z "$OP" ]; then
        case "$PHASE" in prepared|committed) :;; *) die 'there is no rollback snapshot';; esac
        snapshot_complete || die 'snapshot integrity cannot be confirmed'
        validate_tree "$UP/current/work"
        ordinary_dir "$BASE/work" || die 'active work directory is unsafe'
        [ ! -e "$UP/displaced-work" ] || die 'unexpected previous rollback copy'
        write_record "$UP/journal" "rollback $GENERATION"
        JOURNAL_GENERATION=$GENERATION
    fi
    finish_rollback; emit_status
    ;;
esac
