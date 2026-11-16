'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildNative, verifyNative } = require('../tools/build-native.cjs');

const parent = path.resolve(__dirname, '../work/temp');
fs.mkdirSync(parent, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(parent, 'native-build-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const include = path.join(root, 'work/headers/include/node');
    fs.mkdirSync(include, { recursive: true });
    fs.mkdirSync(path.join(root, 'src/native'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/native/msf-capture.c'), '/* fixture source */\n');
    fs.writeFileSync(path.join(include, 'node_api.h'), '/* fixture header */\n');
    fs.writeFileSync(path.join(include, 'node_version.h'), '#define NODE_MAJOR_VERSION 22\n#define NODE_MINOR_VERSION 23\n#define NODE_PATCH_VERSION 5\n');
    const calls = [];
    const run = (executable, args, options) => {
        calls.push({ executable, args, options });
        if (args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], 'fixture generated native object\n');
        return { status: 0, stdout: '', stderr: '' };
    };
    return { root, include, calls, run, platform: 'linux', arch: 'x64', nodeVersion: 'v22.23.5', node: path.join(root, 'runtime/node/bin/node') };
}

test('native build produces checked source/binary manifests and workspace-scoped subprocess files', t => {
    const f = fixture(t), built = buildNative(f);
    assert.equal(built.file, path.join(f.root, 'work/native-build/msf-capture.node'));
    assert.equal(built.platform, 'linux');
    assert.equal(built.arch, 'x64');
    assert.equal(built.napiVersion, 8);
    assert.equal(built.protocolVersion, 2);
    assert.equal(built.qqVersion, '3.2.35-54395');
    assert.match(built.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(built.sha256, /^[a-f0-9]{64}$/);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[0].args.includes('-pthread'));
    assert.ok(f.calls[0].args.includes('-DNAPI_VERSION=8'));
    for (const call of f.calls) {
        assert.equal(call.options.cwd, f.root);
        for (const key of ['TEMP', 'TMP', 'TMPDIR', 'XDG_CACHE_HOME', 'CCACHE_DIR', 'npm_config_cache']) {
            assert.ok(call.options.env[key].startsWith(f.root + path.sep));
        }
    }
    assert.equal(verifyNative({ ...f, file: built.file }).sha256, built.sha256);
});

test('native verification rejects changed binaries and changed source before loading', t => {
    const f = fixture(t), built = buildNative(f);
    fs.appendFileSync(built.file, 'tamper');
    assert.throws(() => verifyNative({ ...f, file: built.file }), /manifest or SHA256/);
    assert.equal(f.calls.length, 2);
    buildNative(f);
    const count = f.calls.length;
    fs.appendFileSync(path.join(f.root, 'src/native/msf-capture.c'), '/* changed */');
    assert.throws(() => verifyNative({ ...f, file: built.file }), /manifest or SHA256/);
    assert.equal(f.calls.length, count);
});

test('compiler failure and load failure preserve the previously verified native addon', t => {
    const f = fixture(t), built = buildNative(f);
    const binary = fs.readFileSync(built.file), manifest = fs.readFileSync(path.join(path.dirname(built.file), 'manifest.json'));
    assert.throws(() => buildNative({ ...f, run: () => ({ status: 1, stderr: 'compiler unavailable' }) }), /compilation failed/);
    assert.throws(() => buildNative({ ...f, run: (exe, args) => {
        if (args.includes('-o')) { fs.writeFileSync(args[args.indexOf('-o') + 1], 'new object'); return { status: 0 }; }
        return { status: 1, stderr: 'bad addon ABI' };
    } }), /load verification failed/);
    assert.deepEqual(fs.readFileSync(built.file), binary);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(built.file), 'manifest.json')), manifest);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'work/temp')), []);
});

test('unsupported platforms and mismatched Node headers are refused before spawning a compiler', t => {
    const f = fixture(t);
    for (const change of [{ platform: 'win32' }, { arch: 'arm64' }, { nodeVersion: 'v24.1.0' }]) {
        assert.throws(() => buildNative({ ...f, ...change }), /Linux x64 and Node.js 22/);
    }
    fs.writeFileSync(path.join(f.include, 'node_version.h'), '#define NODE_MAJOR_VERSION 22\n#define NODE_MINOR_VERSION 0\n#define NODE_PATCH_VERSION 0\n');
    assert.throws(() => buildNative(f), /headers must match/);
    assert.equal(f.calls.length, 0);
});

test('native output rejects workspace directory junctions before compiling or replacing files', t => {
    const f = fixture(t), outside = path.join(f.root, 'work/outside');
    fs.mkdirSync(outside);
    try { fs.symlinkSync(outside, path.join(f.root, 'work/native-build'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
    assert.throws(() => buildNative(f), /must not contain symbolic links/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('Docker native runtime is built from source and cannot be hidden by the persistent work mount', () => {
    const root = path.resolve(__dirname, '..');
    const dockerfile = fs.readFileSync(path.join(root, 'deploy/Dockerfile'), 'utf8');
    const entry = fs.readFileSync(path.join(root, 'deploy/entrypoint.sh'), 'utf8');
    assert.match(dockerfile, /FROM runtime-base AS native-build/);
    assert.match(dockerfile, /COPY --from=native-build \/workspace\/work\/native-build\/ \/workspace\/runtime\/native\//);
    assert.match(dockerfile, /FWD_MSF_ADDON_PATH=\/workspace\/runtime\/native\/msf-capture.node/);
    assert.match(entry, /node tools\/build-native.cjs --verify\nexec node src\/manager\/cli.cjs/);
});
