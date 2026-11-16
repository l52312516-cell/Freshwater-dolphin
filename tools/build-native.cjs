'use strict';

// Build our own N-API addon. No QQ binaries or prebuilt third-party addons are
// downloaded. Runtime verification only loads exports; it never installs hooks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const NAPI_VERSION = 8;
const PROTOCOL_VERSION = 2;
const QQ_VERSION = '3.2.35-54395';
const REQUIRED_EXPORTS = ['verifyTarget', 'install', 'send', 'readResponse', 'readTemplate', 'release', 'resetSession', 'status'];
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function ordinary(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Native build requires ordinary files: ' + file);
    return stat;
}
function directory(base, relative) {
    const target = path.resolve(base, relative);
    if (!target.startsWith(base + path.sep)) throw new Error('Native build path escapes workspace');
    let current = base;
    for (const part of path.relative(base, target).split(path.sep)) {
        current = path.join(current, part);
        try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Native build directory must not contain symbolic links');
    }
    return target;
}
function supported(platform, arch, nodeVersion) {
    if (platform !== 'linux' || arch !== 'x64' || !/^v?22\./.test(nodeVersion)) {
        throw new Error('Native MSF build and runtime require Linux x64 and Node.js 22');
    }
}
function runChecked(run, executable, args, options, label) {
    const result = run(executable, args, options);
    if (result.error) throw new Error(label + ': ' + result.error.message);
    if (result.status !== 0) throw new Error(label + ': ' + String(result.stderr || result.stdout || 'process failed').trim().slice(-4000));
}
function loadCheck(file, { run, node, cwd, env }) {
    const script = 'const value=require(process.argv[1]); for(const name of ' + JSON.stringify(REQUIRED_EXPORTS) +
        ') if(typeof value[name]!=="function") throw new Error("Missing native export: "+name);' +
        'if(value.protocolVersion!==' + PROTOCOL_VERSION + ') throw new Error("Unsupported native response protocol");';
    runChecked(run, node, ['--eval', script, file], { cwd, env, encoding: 'utf8', timeout: 10000 }, 'Native addon load verification failed');
}
function buildNative(options = {}) {
    const root = fs.realpathSync(options.root || path.resolve(__dirname, '..'));
    const platform = options.platform || process.platform, arch = options.arch || process.arch;
    const nodeVersion = options.nodeVersion || process.version;
    supported(platform, arch, nodeVersion);
    const run = options.run || spawnSync, node = options.node || process.execPath;
    const source = path.join(root, 'src/native/msf-capture.c');
    ordinary(source);
    const include = path.resolve(options.include || process.env.FWD_NODE_INCLUDE || path.join(path.dirname(node), '../include/node'));
    ordinary(path.join(include, 'node_api.h'));
    const versionHeader = path.join(include, 'node_version.h');
    ordinary(versionHeader);
    const defines = fs.readFileSync(versionHeader, 'utf8');
    const headerVersion = ['MAJOR', 'MINOR', 'PATCH'].map(part =>
        defines.match(new RegExp('^#define\\s+NODE_' + part + '_VERSION\\s+(\\d+)\\s*$', 'm'))?.[1] || '');
    if (headerVersion.join('.') !== nodeVersion.replace(/^v/, '')) {
        throw new Error('Native build headers must match the running Node.js version');
    }
    const output = directory(root, 'work/native-build'), temp = directory(root, 'work/temp');
    const cache = directory(root, 'work/cache/native');
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, XDG_CACHE_HOME: cache,
        CCACHE_DIR: directory(root, 'work/cache/ccache'), npm_config_cache: directory(root, 'work/cache/npm') };
    const temporary = path.join(temp, 'msf-capture-' + crypto.randomBytes(12).toString('hex') + '.node');
    const destination = path.join(output, 'msf-capture.node');
    try {
        const args = ['-std=c11', '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-pthread',
            '-DNAPI_VERSION=' + NAPI_VERSION, '-DNODE_GYP_MODULE_NAME=msf_capture', '-I', include,
            source, '-o', temporary, '-ldl'];
        runChecked(run, options.compiler || process.env.CC || 'cc', args,
            { cwd: root, env, encoding: 'utf8', timeout: 120000 }, 'Native addon compilation failed');
        if (ordinary(temporary).size === 0) throw new Error('Native compiler produced an empty addon');
        loadCheck(temporary, { run, node, cwd: root, env });
        const manifest = { schemaVersion: 1, addon: 'msf-capture.node', platform, arch,
            napiVersion: NAPI_VERSION, protocolVersion: PROTOCOL_VERSION, nodeVersion, qqVersion: QQ_VERSION,
            source: 'src/native/msf-capture.c', sourceSha256: digest(source), sha256: digest(temporary) };
        if (fs.existsSync(destination)) ordinary(destination);
        fs.chmodSync(temporary, 0o755);
        fs.renameSync(temporary, destination);
        const manifestTemporary = path.join(output, '.manifest-' + crypto.randomBytes(8).toString('hex') + '.json');
        try {
            fs.writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
            fs.renameSync(manifestTemporary, path.join(output, 'manifest.json'));
        } finally { if (fs.existsSync(manifestTemporary)) fs.unlinkSync(manifestTemporary); }
        return { file: destination, ...manifest };
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function verifyNative(options = {}) {
    const root = fs.realpathSync(options.root || path.resolve(__dirname, '..'));
    supported(options.platform || process.platform, options.arch || process.arch, options.nodeVersion || process.version);
    const file = options.file || process.env.FWD_MSF_ADDON_PATH || path.join(root, 'work/native-build/msf-capture.node');
    if (!path.isAbsolute(file)) throw new Error('Native addon path must be absolute');
    ordinary(file);
    if (fs.realpathSync(file) !== path.resolve(file)) throw new Error('Native addon path must not follow symbolic links');
    const manifestFile = path.join(path.dirname(file), 'manifest.json');
    ordinary(manifestFile);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.addon !== path.basename(file) || manifest.platform !== 'linux' ||
        manifest.arch !== 'x64' || manifest.napiVersion !== NAPI_VERSION || manifest.protocolVersion !== PROTOCOL_VERSION || !/^v?22\./.test(manifest.nodeVersion || '') ||
        manifest.qqVersion !== QQ_VERSION || manifest.source !== 'src/native/msf-capture.c' ||
        manifest.sha256 !== digest(file) || manifest.sourceSha256 !== digest(path.join(root, manifest.source))) {
        throw new Error('Native addon manifest or SHA256 does not match this deployment');
    }
    const env = { ...process.env, TEMP: path.join(root, 'work/temp'), TMP: path.join(root, 'work/temp'), TMPDIR: path.join(root, 'work/temp') };
    loadCheck(file, { run: options.run || spawnSync, node: options.node || process.execPath, cwd: root, env });
    return { file, ...manifest };
}
if (require.main === module) {
    try {
        if (process.argv.slice(2).some(value => value !== '--verify')) throw new Error('Usage: node tools/build-native.cjs [--verify]');
        console.log(JSON.stringify(process.argv.includes('--verify') ? verifyNative() : buildNative()));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildNative, verifyNative, NAPI_VERSION, PROTOCOL_VERSION, QQ_VERSION };
