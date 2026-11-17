'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

test('Docker release removes writable host source modes without changing persistent state or runtime binaries', t => {
    const project = path.resolve(__dirname, '..'), dockerfile = fs.readFileSync(path.join(project, 'deploy/Dockerfile'), 'utf8');
    const release = dockerfile.split('FROM runtime-base AS release\n')[1]; assert.ok(release);
    const normalization = /^RUN chmod -R (u=rwX,go=rX) (.+)$/m.exec(release); assert.ok(normalization);
    const targets = normalization[2].trim().split(/\s+/);
    assert.deepEqual(targets, ['/workspace/src', '/workspace/deploy', '/workspace/tools', '/workspace/package.json', '/workspace/package-lock.json']);
    // New runtime-source COPY inputs must remain under one of the deliberately
    // normalized targets. Build products, dependencies and mounted work stay out.
    const copies = [...release.matchAll(/^COPY (.+)$/gm)];
    assert.ok(copies.every(copy => copy.index < normalization.index), 'Normalize after all release COPY instructions');
    const runtimeSources = copies.filter(copy => !copy[1].startsWith('--from=')).flatMap(copy => copy[1].trim().split(/\s+/).slice(0, -1))
        .filter(source => /^(?:src|deploy|tools)(?:\/|$)/.test(source) || ['package.json', 'package-lock.json'].includes(source));
    assert.deepEqual([...new Set(runtimeSources)].sort(), ['deploy', 'package-lock.json', 'package.json', 'src', 'tools/build-native.cjs', 'tools/prepare-qq.cjs', 'tools/qq-runtime-entry.cjs']);
    assert.ok(runtimeSources.every(source => targets.some(target => source === target.slice('/workspace/'.length) || source.startsWith(target.slice('/workspace/'.length) + '/'))));
    assert.ok(normalization.index < release.indexOf('USER 1000:1000'));
    if (process.platform === 'win32') return; // POSIX behavior is exercised by the Linux image suite.
    const root = fs.mkdtempSync(path.join(parent, 'source-modes-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['src/qq', 'deploy', 'tools', 'work/accounts/private', 'runtime/native', 'node_modules/example']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o777 });
    const files = ['src/qq/source.cjs', 'deploy/entrypoint.sh', 'tools/build-native.cjs', 'package.json', 'package-lock.json'];
    for (const file of files) { fs.writeFileSync(path.join(root, file), 'content must stay exact\n'); fs.chmodSync(path.join(root, file), 0o666); }
    const executable = path.join(root, 'tools/executable'); fs.writeFileSync(executable, 'executable contents\n'); fs.chmodSync(executable, 0o777);
    for (const directory of ['src', 'src/qq', 'deploy', 'tools']) fs.chmodSync(path.join(root, directory), 0o777);
    const untouched = ['work/accounts/private/state.json', 'runtime/native/addon.node', 'node_modules/example/index.cjs'].map(relative => path.join(root, relative));
    for (const file of untouched) { fs.writeFileSync(file, 'outside source scope\n'); fs.chmodSync(file, 0o600); }
    const before = [...files.map(file => path.join(root, file)), executable, ...untouched].map(file => ({ file, bytes: fs.readFileSync(file), uid: fs.statSync(file).uid }));
    const result = spawnSync('chmod', ['-R', normalization[1], ...targets.map(target => path.join(root, target.slice('/workspace/'.length)))], {
        cwd: root, encoding: 'utf8', env: { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent }
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    for (const file of files) assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o644);
    for (const directory of ['src', 'src/qq', 'deploy', 'tools']) assert.equal(fs.statSync(path.join(root, directory)).mode & 0o777, 0o755);
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
    for (const file of untouched) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const value of before) { assert.deepEqual(fs.readFileSync(value.file), value.bytes); assert.equal(fs.statSync(value.file).uid, value.uid); }
});
