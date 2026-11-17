'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
function fail(message) { throw new Error('Invalid Windows release: ' + message); }
function positive(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(name);
    return value;
}
function assertReleaseRoot(root) {
    const absolute = path.resolve(root), parsed = path.parse(absolute);
    if (process.platform === 'win32' && !/^[A-Za-z]:\\$/.test(parsed.root)) fail('release root must be a local drive directory');
    let cursor = parsed.root;
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) fail('release root or ancestor is a link, junction, or non-directory');
    }
    const canonical = fs.realpathSync.native(absolute);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(canonical) !== normalize(absolute)) fail('release root is not canonical (junction/reparse redirection)');
    return absolute;
}
function assetPath(root, value) {
    assertReleaseRoot(root);
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/') ||
        value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$|[<>"|?*]/.test(part) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('unsafe asset path');
    const absolute = path.resolve(root, value);
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('asset outside release');
    // Reject symlink/reparse redirections, including an ancestor directory.
    let cursor = path.resolve(root);
    for (const segment of value.split('/')) {
        cursor = path.join(cursor, segment);
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('asset symlink');
    }
    return absolute;
}
function asset(item, name) {
    if (!item || typeof item.path !== 'string' || !HASH.test(item.sha256 || '')) fail(name + ' hash/path');
    positive(item.sizeBytes, name + ' sizeBytes');
}
function validateManifest(value) {
    if (!value || value.schemaVersion !== 1 || value.platform !== 'windows-x64' ||
        typeof value.releaseVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/.test(value.releaseVersion)) fail('schema/platform/version');
    asset(value.node, 'node');
    if (value.node.path !== 'runtime/node/node.exe') fail('bundled Node path');
    if (!/^22\.\d+\.\d+$/.test(value.node.version || '')) fail('Node 22 version');
    if (!value.alpine || value.alpine.architecture !== 'x86_64' || !/^\d+\.\d+\.\d+$/.test(value.alpine.version || '')) fail('Alpine version');
    asset(value.alpine.rootfs, 'Alpine rootfs'); positive(value.alpine.rootfs.expandedBytes, 'rootfs expandedBytes');
    for (const key of ['dockerVersion', 'composeVersion']) if (!/^[0-9][0-9A-Za-z.+_-]{0,49}$/.test(value.alpine[key] || '')) fail(key);
    if (!value.image || !/^sha256:[a-f0-9]{64}$/.test(value.image.id || '') ||
        !/^[a-z0-9][a-z0-9./:_-]{0,199}$/.test(value.image.reference || '')) fail('image identity');
    asset(value.image.archive, 'image archive'); positive(value.image.expandedBytes, 'image expandedBytes');
    const r = value.runtime;
    if (!r || !NAME.test(r.distroName || '') || !NAME.test(r.containerName || '')) fail('runtime names');
    for (const key of ['guestPort', 'hostPort']) positive(r[key], key, 1024, 65535);
    positive(r.memoryMiB, 'memoryMiB', 512, 16384);
    positive(r.wslMemoryMiB, 'wslMemoryMiB', r.memoryMiB, 32768);
    positive(r.processors, 'processors', 1, 64); positive(r.swapMiB, 'swapMiB', 0, 16384);
    positive(r.dataBudgetBytes, 'dataBudgetBytes');
    if (r.stopSeconds !== 95) fail('stopSeconds must be 95');
    if (!Array.isArray(value.files) || !value.files.length) fail('launcher files missing');
    const all = [value.node, value.alpine.rootfs, value.image.archive, ...value.files];
    const seen = new Set();
    for (const item of all) { asset(item, 'file'); if (seen.has(item.path)) fail('duplicate asset'); seen.add(item.path); }
    for (const required of ['tools/windows/cli.cjs', 'tools/windows/runtime.cjs', 'tools/windows/manifest.cjs',
        'tools/windows/config.cjs', 'deploy/windows/supervisor.sh', 'deploy/windows/upgrade.sh', 'Freshwater.cmd']) if (!seen.has(required)) fail('missing ' + required);
    return value;
}
function loadManifest(root, file = path.join(root, 'release-manifest.json')) {
    return validateManifest(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
async function verifyRelease(root, manifest) {
    validateManifest(manifest);
    for (const item of [manifest.node, manifest.alpine.rootfs, manifest.image.archive, ...manifest.files]) {
        const file = assetPath(root, item.path);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size !== item.sizeBytes || await hashFile(file) !== item.sha256) fail('asset verification failed: ' + item.path);
    }
    return true;
}
function spacePlan(manifest, { installed = false } = {}) {
    validateManifest(manifest);
    const r = manifest.runtime;
    // Download archives already exist in the release. Their bytes are already excluded
    // from host free-space, and must not be counted a second time here.
    const rootfs = installed ? 0 : manifest.alpine.rootfs.expandedBytes;
    const image = manifest.image.expandedBytes;
    const swap = r.swapMiB * 1024 ** 2;
    const growth = rootfs + image + swap + r.dataBudgetBytes;
    if (!Number.isSafeInteger(growth)) fail('space budget overflow');
    const reserve = Math.max(5 * 1024 ** 3, Math.ceil(growth * 0.1));
    return { rootfsBytes: rootfs, imageBytes: image, swapBytes: swap, dataBudgetBytes: r.dataBudgetBytes,
        reserveBytes: reserve, requiredFreeBytes: growth + reserve };
}
module.exports = { validateManifest, loadManifest, verifyRelease, assetPath, hashFile, spacePlan, assertReleaseRoot };
