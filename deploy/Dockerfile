FROM ubuntu:22.04 AS runtime-base

ARG DEBIAN_FRONTEND=noninteractive
ENV TEMP=/workspace/work/temp TMP=/workspace/work/temp TMPDIR=/workspace/work/temp \
    HOME=/workspace/work/home XDG_CACHE_HOME=/workspace/work/cache \
    XDG_CONFIG_HOME=/workspace/work/config XDG_DATA_HOME=/workspace/work/data \
    XDG_RUNTIME_DIR=/workspace/work/runtime npm_config_cache=/workspace/work/cache/npm

RUN mkdir -p /workspace/work/temp /workspace/work/cache/apt/lists/partial /workspace/work/cache/apt/archives/partial \
    && apt-get -o Dir::State::lists=/workspace/work/cache/apt/lists update \
    && apt-get -o Dir::State::lists=/workspace/work/cache/apt/lists \
       -o Dir::Cache::archives=/workspace/work/cache/apt/archives install -y --no-install-recommends \
       ca-certificates curl xz-utils python3 xvfb x11-utils dbus-x11 tini util-linux \
       libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libx11-xcb1 libxtst6 \
       libatk-bridge2.0-0 libdrm2 libnotify4 libsecret-1-0 libappindicator3-1 \
       fonts-noto-cjk libgl1 libegl1 \
    && rm -rf /workspace/work/cache/apt \
    && useradd --uid 1000 --no-create-home --home-dir /workspace/work/home --shell /bin/bash dolphin

ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl --fail --location --retry 2 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /workspace/work/temp/node.tar.xz \
    && printf '%s  %s\n' "$NODE_SHA256" /workspace/work/temp/node.tar.xz | sha256sum --check - \
    && mkdir -p /workspace/runtime/node \
    && tar -xJf /workspace/work/temp/node.tar.xz --strip-components=1 -C /workspace/runtime/node \
    && rm /workspace/work/temp/node.tar.xz

ENV PATH=/workspace/runtime/node/bin:$PATH PYTHONDONTWRITEBYTECODE=1
WORKDIR /workspace

FROM runtime-base AS webui-build
COPY webui/package.json webui/package-lock.json ./webui/
RUN cd webui && npm ci --ignore-scripts --no-audit --no-fund
COPY webui/index.html webui/tsconfig.json webui/vite.config.ts ./webui/
COPY webui/src ./webui/src
RUN cd webui && npm run build

FROM runtime-base AS release
RUN mkdir -p /workspace/work/cache/apt/lists/partial /workspace/work/cache/apt/archives/partial \
    && apt-get -o Dir::State::lists=/workspace/work/cache/apt/lists update \
    && apt-get -o Dir::State::lists=/workspace/work/cache/apt/lists \
       -o Dir::Cache::archives=/workspace/work/cache/apt/archives install -y --no-install-recommends x11vnc ffmpeg \
    && mkdir -p /workspace/runtime/ffmpeg \
    && cp /usr/bin/ffmpeg /workspace/runtime/ffmpeg/ffmpeg \
    && rm -rf /workspace/work/cache/apt
ENV FWD_FFMPEG_PATH=/workspace/runtime/ffmpeg/ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY tools/prepare-qq.cjs ./tools/prepare-qq.cjs
COPY deploy ./deploy
COPY --from=webui-build /workspace/webui/dist ./webui/dist
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY docs/third-party-licenses.txt ./docs/third-party-licenses.txt
COPY docs/audio-codec-licenses.txt ./docs/audio-codec-licenses.txt
RUN mkdir -p /workspace/work/accounts /workspace/work/control /workspace/work/logs /workspace/work/data /workspace/work/state \
    && chown -R 1000:1000 /workspace/work
EXPOSE 4090
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 CMD ["node", "src/manager/cli.cjs", "--health"]
ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/workspace/deploy/entrypoint.sh"]
