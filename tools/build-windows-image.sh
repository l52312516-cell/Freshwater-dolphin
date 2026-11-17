#!/bin/sh
# Build/export a Windows-launcher Linux image without deploying a live service.
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"
: "${BASE_IMAGE_ID:?Set the exact existing Freshwater runtime base image sha256}"
case "$BASE_IMAGE_ID" in sha256:????????????????????????????????????????????????????????????????) :;; *) echo 'An exact image ID is required' >&2; exit 1;; esac
OUTPUT="$ROOT/work/windows-image-release"
mkdir -p "$OUTPUT/temp" "$OUTPUT/cache"
export TEMP="$OUTPUT/temp" TMP="$OUTPUT/temp" TMPDIR="$OUTPUT/temp" XDG_CACHE_HOME="$OUTPUT/cache" DOCKER_CONFIG="$OUTPUT/cache/docker-client"
DOCKER_BIN=${DOCKER_BIN:-docker}
IMAGE_TAG=${IMAGE_TAG:-freshwater-dolphin:windows-shell-20261117}
[ ! -e "$OUTPUT/freshwater-image.tar" ] || { echo 'Preserve the existing release before rebuilding' >&2; exit 1; }
rm -rf "$OUTPUT/context" "$OUTPUT/qa-work"
mkdir -p "$OUTPUT/context" "$OUTPUT/qa-work"
"$DOCKER_BIN" image inspect "$BASE_IMAGE_ID" >/dev/null
QQ_SOURCE=${QQ_SOURCE:-$ROOT/work/cache/downloads/QQ.deb}
printf '%s  %s\n' 7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac "$QQ_SOURCE" | sha256sum --check -
[ -f webui/dist/index.html ] || { echo 'Build the WebUI before exporting the release context' >&2; exit 1; }
# The release context is intentionally explicit: no accounts, credentials, or logs.
for entry in src deploy; do cp -R "$ROOT/$entry" "$OUTPUT/context/$entry"; done
mkdir -p "$OUTPUT/context/tools" "$OUTPUT/context/webui"
for file in prepare-qq.cjs qq-runtime-entry.cjs build-native.cjs; do cp "$ROOT/tools/$file" "$OUTPUT/context/tools/$file"; done
cp -R webui/dist "$OUTPUT/context/webui/dist"
cp package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md "$OUTPUT/context/"
cp "$QQ_SOURCE" "$OUTPUT/context/QQ.deb"
cat > "$OUTPUT/context/Dockerfile" <<EOF
FROM $BASE_IMAGE_ID
USER 0:0
COPY package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md /workspace/
COPY src /workspace/src
COPY deploy /workspace/deploy
COPY tools /workspace/tools
COPY webui/dist /workspace/webui/dist
COPY QQ.deb /workspace/runtime/packages/QQ.deb
RUN chmod -R u=rwX,go=rX /workspace/src /workspace/deploy /workspace/tools /workspace/webui/dist && chmod 644 /workspace/runtime/packages/QQ.deb
USER 1000:1000
EOF
"$DOCKER_BIN" build --network host --file "$OUTPUT/context/Dockerfile" --tag "$IMAGE_TAG" "$OUTPUT/context"
"$DOCKER_BIN" image inspect --format '{{.Id}}' "$IMAGE_TAG" > "$OUTPUT/image-id.txt"
"$DOCKER_BIN" image inspect --format '{{.Size}}' "$IMAGE_TAG" > "$OUTPUT/expanded-bytes.txt"
printf '%s\n' "$IMAGE_TAG" > "$OUTPUT/image-reference.txt"
# Check immutable release inputs and ensure the inherited image has no account
# credentials. This replaces the entrypoint and never starts the manager or QQ.
"$DOCKER_BIN" run --rm --network none --user 0:0 --entrypoint node "$IMAGE_TAG" -e '
const fs=require("node:fs"),crypto=require("node:crypto");
for(const dir of ["work/accounts","work/control"]) if(fs.existsSync(dir)&&fs.readdirSync(dir).length) throw Error("Release contains private runtime state: "+dir);
const file="runtime/packages/QQ.deb";
if(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")!=="7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac") throw Error("Bundled QQ digest mismatch");
process.stdout.write(fs.readFileSync("runtime/apt-packages.txt"));
' > "$OUTPUT/apt-packages.txt"
# QA explicitly replaces the image entrypoint. It never starts QQ or an account.
"$DOCKER_BIN" run --rm --network none --user 0:0 --entrypoint node \
    --mount "type=bind,source=$ROOT/tests,target=/workspace/tests,readonly" \
    --mount "type=bind,source=$ROOT/tools,target=/workspace/tools,readonly" \
    --mount "type=bind,source=$ROOT/webui,target=/workspace/webui,readonly" \
    --mount "type=bind,source=$OUTPUT/qa-work,target=/workspace/work" \
    "$IMAGE_TAG" tools/test.cjs > "$OUTPUT/linux-tests.log" 2>&1
"$DOCKER_BIN" save --output "$OUTPUT/freshwater-image.tar.partial" "$IMAGE_TAG"
mv "$OUTPUT/freshwater-image.tar.partial" "$OUTPUT/freshwater-image.tar"
sha256sum "$OUTPUT/freshwater-image.tar" > "$OUTPUT/freshwater-image.tar.sha256"
printf 'Release image exported: %s\n' "$OUTPUT/freshwater-image.tar"
