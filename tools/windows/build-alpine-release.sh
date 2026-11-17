#!/bin/sh
# Release engineering only. Does not touch live Freshwater containers or QQ.
# Usage: DOCKER_BIN=/path/docker ./tools/windows/build-alpine-release.sh work/windows-release-ID
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
case "${1:-}" in /*) OUTPUT=$1;; '') echo 'Pass a new project work/ output directory' >&2; exit 1;; *) OUTPUT="$ROOT/$1";; esac
OUTPUT=$(realpath -m -- "$OUTPUT")
case "$OUTPUT" in "$ROOT"/work/*) :;; *) echo 'Builder output must stay below this project work/' >&2; exit 1;; esac
mkdir -p "$OUTPUT"
OUTPUT=$(CDPATH= cd -- "$OUTPUT" && pwd -P)
case "$OUTPUT" in "$ROOT"/work/*) :;; *) echo 'Builder output must stay below this project work/' >&2; exit 1;; esac
[ ! -e "$OUTPUT/alpine-runtime.tar" ] || { echo 'Refusing to overwrite an existing rootfs release' >&2; exit 1; }
export TEMP="$OUTPUT/temp" TMP="$OUTPUT/temp" TMPDIR="$OUTPUT/temp"
export HOME="$OUTPUT/home" XDG_CACHE_HOME="$OUTPUT/cache" DOCKER_CONFIG="$OUTPUT/cache/docker-client"
mkdir -p "$HOME" "$TEMP" "$XDG_CACHE_HOME" "$DOCKER_CONFIG" "$OUTPUT/build-work/temp" "$OUTPUT/build-work/cache"
if [ -z "${DOCKER_BIN:-}" ]; then
    if [ -x "$ROOT/runtime/docker/docker" ]; then DOCKER_BIN="$ROOT/runtime/docker/docker"
    elif [ -x "$ROOT/runtime/docker" ] && [ ! -d "$ROOT/runtime/docker" ]; then DOCKER_BIN="$ROOT/runtime/docker"
    else DOCKER_BIN=$(command -v docker); fi
fi
[ -x "$DOCKER_BIN" ] || { echo 'Docker client is required' >&2; exit 1; }
VERSION=3.24.4
ROOTFS_SHA=cdaa38cb8de3537967ee5b6c9b6cd00cc962da2b018e6eea48696bb274923012
ARCHIVE="$OUTPUT/alpine-minirootfs-$VERSION-x86_64.tar.gz"
URL="https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/alpine-minirootfs-$VERSION-x86_64.tar.gz"
if [ ! -f "$ARCHIVE" ]; then curl --silent --show-error --fail --location --max-time 120 --retry 2 --output "$ARCHIVE.partial" "$URL"; mv "$ARCHIVE.partial" "$ARCHIVE"; fi
printf '%s  %s\n' "$ROOTFS_SHA" "$ARCHIVE" | sha256sum --check -
BUILD_ID="$(date +%Y%m%d%H%M%S)-$$"
BASE_IMAGE="freshwater-alpine-release-base:$BUILD_ID"
CONTAINER="freshwater-alpine-release-build-$BUILD_ID"
ALPINE_MIRROR=${ALPINE_MIRROR:-https://dl-cdn.alpinelinux.org/alpine}
case "$ALPINE_MIRROR" in https://dl-cdn.alpinelinux.org/alpine|https://mirrors.aliyun.com/alpine) :;; *) echo 'Unsupported explicit Alpine HTTPS mirror' >&2; exit 1;; esac
cleanup() {
    # Exact unique names only. Never prune Docker or affect the production container.
    "$DOCKER_BIN" rm -f "$CONTAINER" >/dev/null 2>&1 || true
    "$DOCKER_BIN" image rm "$BASE_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP
"$DOCKER_BIN" import --platform linux/amd64 "$ARCHIVE" "$BASE_IMAGE" > "$OUTPUT/base-image-id.txt"
"$DOCKER_BIN" create --name "$CONTAINER" --label "io.freshwater.release-builder=$BUILD_ID" --network host \
    --env TEMP=/build-work/temp --env TMP=/build-work/temp --env TMPDIR=/build-work/temp \
    --env XDG_CACHE_HOME=/build-work/cache \
    --env "ALPINE_MIRROR=$ALPINE_MIRROR" \
    --mount "type=bind,source=$OUTPUT/build-work,target=/build-work" "$BASE_IMAGE" /bin/sh -ec '
        umask 077
        printf "%s/v3.24/main\n%s/v3.24/community\n" "$ALPINE_MIRROR" "$ALPINE_MIRROR" > /etc/apk/repositories
        apk add --no-cache docker-engine docker-cli docker-cli-compose util-linux ca-certificates
        cp /etc/apk/repositories /build-work/repositories.txt
        mkdir -p /etc/freshwater /opt/freshwater /var/lib/freshwater/temp /var/lib/freshwater/home /var/lib/freshwater/cache /var/lib/freshwater/work /var/lib/freshwater/logs
        chmod 700 /etc/freshwater /opt/freshwater /var/lib/freshwater
        printf "[user]\ndefault=root\n[boot]\nsystemd=false\n" > /etc/wsl.conf
        # Ensure image/container rootfs has no owner, auth state or machine identity.
        rm -f /etc/machine-id
        for utility in docker dockerd flock sha256sum timeout; do command -v "$utility" >/dev/null; done
        docker --version | sed -n "s/^Docker version \([^,]*\),.*/\1/p" > /build-work/docker-version.txt
        docker compose version --short | sed "s/^v//" > /build-work/compose-version.txt
        apk info -v | sort > /build-work/apk-packages.txt
        # Mounted build-work is excluded: measure only the exported root filesystem.
        du -skx / | awk "{printf \"%.0f\\n\", \$1 * 1024}" > /build-work/expanded-bytes.txt
        uname -m > /build-work/architecture.txt
    ' > "$OUTPUT/build-container-id.txt"
"$DOCKER_BIN" start --attach "$CONTAINER"
STATUS=$("$DOCKER_BIN" inspect --format '{{.State.ExitCode}}' "$CONTAINER")
[ "$STATUS" -eq 0 ] || { echo 'Alpine build container failed' >&2; exit 1; }
"$DOCKER_BIN" export --output "$OUTPUT/alpine-runtime.tar.partial" "$CONTAINER"
mv "$OUTPUT/alpine-runtime.tar.partial" "$OUTPUT/alpine-runtime.tar"
for file in docker-version.txt compose-version.txt apk-packages.txt expanded-bytes.txt architecture.txt repositories.txt; do cp "$OUTPUT/build-work/$file" "$OUTPUT/$file"; done
mkdir -p "$OUTPUT/release-inputs"
cp "$OUTPUT/repositories.txt" "$OUTPUT/release-inputs/repositories.txt"
sha256sum "$OUTPUT/alpine-runtime.tar" > "$OUTPUT/alpine-runtime.tar.sha256"
printf '%s\n' "$VERSION" > "$OUTPUT/alpine-version.txt"
printf '%s\n' "$ROOTFS_SHA" > "$OUTPUT/source-minirootfs-sha256.txt"
printf 'Alpine release rootfs: %s\n' "$OUTPUT/alpine-runtime.tar"
printf 'Docker: %s; Compose: %s\n' "$(cat "$OUTPUT/docker-version.txt")" "$(cat "$OUTPUT/compose-version.txt")"
