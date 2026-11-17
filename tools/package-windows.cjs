'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateManifest, verifyRelease, hashFile, assetPath } = require('./windows/manifest.cjs');
const ROOT = path.resolve(__dirname, '..');
const RUN_FILES = ['Freshwater.cmd', 'tools/windows/cli.cjs', 'tools/windows/runtime.cjs', 'tools/windows/manifest.cjs',
    'tools/windows/config.cjs', 'deploy/windows/supervisor.sh', 'deploy/windows/upgrade.sh', 'docs/windows-runtime.md',
    'docs/message-compatibility.md', 'docs/qq-runtime-management.md', 'docs/third-party-licenses.txt', 'docs/audio-codec-licenses.txt', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
function inside(file) {
    const full = path.resolve(ROOT, file), relative = path.relative(ROOT, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Release inputs must stay in this workspace');
    let cursor = ROOT;
    for (const part of relative.split(path.sep)) { cursor = path.join(cursor, part); if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Release paths must not be symlinks'); }
    return full;
}
async function descriptor(root, relative) {
    const file = path.join(root, ...relative.split('/')), stat = fs.statSync(file);
    if (!stat.isFile() || !stat.size) throw new Error('Missing release asset: ' + relative);
    return { path: relative, sizeBytes: stat.size, sha256: await hashFile(file) };
}
async function build({ assets, execute = execFileSync } = {}) {
    if (process.platform !== 'win32') throw new Error('Build the Windows ZIP on Windows to verify its bundled runtime');
    const assetsRoot = inside(assets), metadata = JSON.parse(fs.readFileSync(path.join(assetsRoot, 'assets.json'), 'utf8'));
    if (metadata.schemaVersion !== 1) throw new Error('Unsupported release-engineering metadata');
    const version = require('../package.json').version;
    const base = 'freshwater-dolphin-' + version + '-windows-x64';
    if (!/^[A-Za-z0-9.+_-]+$/.test(base)) throw new Error('Invalid release filename');
    const outputs = inside('outputs'), temporary = inside('work/temp');
    fs.mkdirSync(outputs, { recursive: true }); fs.mkdirSync(temporary, { recursive: true });
    const destination = path.join(outputs, base), archive = destination + '.zip';
    if (fs.existsSync(destination) || fs.existsSync(archive)) throw new Error('Windows release already exists; preserve it or choose a new project version');
    const stage = fs.mkdtempSync(path.join(temporary, 'windows-release-'));
    const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
        npm_config_cache: inside('work/cache/npm'), XDG_CACHE_HOME: inside('work/cache') };
    const copy = (source, relative) => { const to = path.join(stage, ...relative.split('/')); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(source, to, fs.constants.COPYFILE_EXCL); return to; };
    let published = false;
    try {
        for (const file of RUN_FILES) copy(inside(file), file);
        const nodeZip = assetPath(assetsRoot, metadata.nodeZip.path);
        if (await hashFile(nodeZip) !== metadata.nodeZip.sha256) throw new Error('Node ZIP differs from upstream checksums');
        const unpack = path.join(stage, 'node-unpack'); fs.mkdirSync(unpack);
        execute('tar.exe', ['-xf', nodeZip, '-C', unpack], { cwd: ROOT, env, timeout: 120000, stdio: 'pipe' });
        const nodeRoot = path.join(unpack, 'node-v' + metadata.nodeZip.version + '-win-x64');
        const nodeFile = copy(path.join(nodeRoot, 'node.exe'), 'runtime/node/node.exe');
        copy(path.join(nodeRoot, 'LICENSE'), 'runtime/node/LICENSE');
        if (execute(nodeFile, ['--version'], { env, encoding: 'utf8' }).trim() !== 'v' + metadata.nodeZip.version) throw new Error('Bundled Node version does not match the verified ZIP');
        fs.rmSync(unpack, { recursive: true });
        const rootfs = assetPath(assetsRoot, metadata.alpine.rootfs.path);
        const image = assetPath(assetsRoot, metadata.image.archive.path);
        for (const [source, expected, relative] of [[rootfs, metadata.alpine.rootfs.sha256, 'assets/alpine-runtime.tar'], [image, metadata.image.archive.sha256, 'assets/freshwater-image.tar']]) {
            if (await hashFile(source) !== expected) throw new Error('Offline runtime asset digest mismatch');
            copy(source, relative);
        }
        if (fs.existsSync(path.join(assetsRoot, 'apk-packages.txt'))) copy(path.join(assetsRoot, 'apk-packages.txt'), 'docs/alpine-packages.txt');
        if (fs.existsSync(path.join(assetsRoot, 'apt-packages.txt'))) copy(path.join(assetsRoot, 'apt-packages.txt'), 'docs/container-packages.txt');
        copy(path.join(assetsRoot, 'assets.json'), 'docs/release-inputs.json');
        const manifest = validateManifest({ schemaVersion: 1, releaseVersion: version, platform: 'windows-x64',
            node: { ...await descriptor(stage, 'runtime/node/node.exe'), version: metadata.nodeZip.version },
            alpine: { version: metadata.alpine.version, architecture: 'x86_64', dockerVersion: metadata.alpine.dockerVersion,
                composeVersion: metadata.alpine.composeVersion, rootfs: { ...await descriptor(stage, 'assets/alpine-runtime.tar'), expandedBytes: metadata.alpine.rootfs.expandedBytes } },
            image: { reference: metadata.image.reference, id: metadata.image.id,
                archive: await descriptor(stage, 'assets/freshwater-image.tar'), expandedBytes: metadata.image.expandedBytes },
            runtime: { deferAccounts: true, distroName: 'FreshwaterDolphin', containerName: 'freshwater-dolphin', guestPort: 4090, hostPort: 4090,
                memoryMiB: 4096, wslMemoryMiB: 6144, processors: 4, swapMiB: 2048, dataBudgetBytes: 4 * 1024 ** 3, stopSeconds: 95 },
            files: await Promise.all([...RUN_FILES, 'runtime/node/LICENSE', 'docs/release-inputs.json',
                ...['docs/alpine-packages.txt', 'docs/container-packages.txt'].filter(file => fs.existsSync(path.join(stage, file)))].map(file => descriptor(stage, file))) });
        fs.writeFileSync(path.join(stage, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        await verifyRelease(stage, manifest);
        fs.renameSync(stage, destination); published = true;
        const pendingZip = path.join(temporary, base + '.' + crypto.randomBytes(6).toString('hex') + '.zip');
        execute('tar.exe', ['-a', '-cf', pendingZip, '-C', destination, '.'], { cwd: ROOT, env, timeout: 600000, stdio: 'pipe' });
        fs.renameSync(pendingZip, archive);
        const sha256 = await hashFile(archive);
        fs.writeFileSync(archive + '.sha256', sha256 + '  ' + path.basename(archive) + '\n');
        return { directory: destination, archive, sha256, manifest };
    } finally {
        if (!published && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
    }
}
if (require.main === module) {
    const [flag, assets] = process.argv.slice(2);
    if (flag !== '--assets' || !assets) { console.error('Usage: node tools/package-windows.cjs --assets work/windows-release-assets'); process.exitCode = 1; }
    else build({ assets }).then(({ directory, archive, sha256 }) => console.log(JSON.stringify({ directory, archive, sha256 }))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { build, descriptor, RUN_FILES };
