'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { BASELINE, normalizeRuntimeSelection, evaluateRuntimeIdentity } = require('../src/qq/runtime-profile.cjs');
function fail(message) { throw Object.assign(new Error(message), { code: 'INVALID_QQ_RUNTIME' }); }
function ordinary(file) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('QQ runtime requires ordinary files'); }
function privatePath(root, target) {
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('QQ runtime path must remain in the workspace');
    let current = root;
    for (const part of relative.split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) fail('QQ runtime path cannot contain symbolic links');
    }
    return target;
}
function digest(file) {
    const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); return hash.digest('hex'); }
    finally { fs.closeSync(fd); }
}
function metadata(file) {
    return { version: execFileSync('dpkg-deb', ['--field', file, 'Version'], { encoding: 'utf8' }).trim(),
        architecture: execFileSync('dpkg-deb', ['--field', file, 'Architecture'], { encoding: 'utf8' }).trim() };
}
function selectRuntime({ root = path.resolve(__dirname, '..'), configFile, readMetadata = metadata } = {}) {
    root = fs.realpathSync(root);
    privatePath(root, path.resolve(configFile)); ordinary(configFile);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const selection = normalizeRuntimeSelection(config.qqRuntime);
    let packageFile, expected, manifest;
    if (selection.packageId) {
        const base = path.join(root, 'work/qq-packages', selection.packageId);
        const manifestFile = privatePath(root, path.join(base, 'manifest.json')); ordinary(manifestFile);
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        if (manifest.schemaVersion !== 1 || manifest.packageId !== selection.packageId || manifest.profileId !== selection.profileId ||
            manifest.architecture !== 'x64' || !/^[a-f0-9]{64}$/.test(manifest.packageSha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.wrapperSha256 || '')) fail('QQ package manifest does not match the selected runtime');
        packageFile = privatePath(root, path.join(base, 'QQ.deb')); expected = manifest.packageSha256;
    } else {
        const bundled = path.join(root, 'runtime/packages/QQ.deb');
        packageFile = privatePath(root, fs.existsSync(bundled) ? bundled : path.join(root, 'work/cache/downloads/QQ.deb'));
        const checksum = path.join(path.dirname(packageFile), 'QQ.sha256');
        if (fs.existsSync(checksum)) {
            privatePath(root, checksum); ordinary(checksum); expected = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
        } else if (packageFile === bundled) expected = BASELINE.packageSha256;
        if (!/^[a-f0-9]{64}$/.test(expected || '')) fail('Provide the QQ package expected SHA256 before starting');
    }
    ordinary(packageFile);
    const actual = digest(packageFile);
    if (actual !== expected) fail('QQ package SHA256 mismatch');
    const info = readMetadata(packageFile);
    if (info.architecture !== 'amd64' || !/^3\.2\.\d+-[A-Za-z0-9.]+$/.test(info.version) || manifest && manifest.qqVersion !== info.version) fail('QQ package version or architecture does not match its manifest');
    const profile = evaluateRuntimeIdentity({ platform: 'linux', architecture: 'x64', qqVersion: info.version, ...selection, packageSha256: actual });
    if (profile.admission === 'denied') fail('QQ package requires an explicitly selected experimental Linux profile');
    return { ...selection, packageFile, packageSha256: actual, qqVersion: info.version, wrapperSha256: manifest?.wrapperSha256 || null };
}
function inspectQQTree(tree, { expectedVersion, expectedWrapperHash } = {}) {
    const app = path.join(tree, 'opt/QQ/resources/app');
    const packageFile = path.join(app, 'package.json');
    ordinary(packageFile);
    const packageInfo = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const version = packageInfo.version?.includes('-') ? packageInfo.version :
        packageInfo.buildVersion ? packageInfo.version + '-' + packageInfo.buildVersion : packageInfo.version;
    if (version !== expectedVersion || packageInfo.platform && packageInfo.platform !== 'linux' || packageInfo.eleArch && packageInfo.eleArch !== 'x64') fail('Extracted QQ application identity does not match the selected package');
    const wrappers = []; let visited = 0;
    function visit(directory, depth) {
        if (++visited > 100000 || depth > 24) fail('QQ application tree exceeds the inspection limit');
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) { if (entry.name === 'wrapper.node') fail('QQ wrapper cannot be a symbolic link'); continue; }
            if (entry.isDirectory()) visit(file, depth + 1);
            else if (entry.name === 'wrapper.node') { ordinary(file); wrappers.push(file); }
        }
    }
    visit(app, 0);
    if (wrappers.length !== 1) fail('QQ application must expose one identifiable native wrapper');
    const wrapperSha256 = digest(wrappers[0]);
    if (expectedWrapperHash && expectedWrapperHash !== wrapperSha256) fail('QQ wrapper SHA256 differs from the selected package manifest');
    return { qqVersion: version, wrapperSha256 };
}
if (require.main === module) {
    try {
        const [operation, target] = process.argv.slice(2);
        if (operation === '--select') {
            const value = selectRuntime({ configFile: target });
            // Fixed positional lines are data, never shell code. The caller
            // checks this command's status before reading any output.
            process.stdout.write([value.packageFile, value.packageSha256, value.qqVersion, value.profileId,
                value.packageId || '-', value.experimental ? '1' : '0', value.wrapperSha256 || '-'].join('\n') + '\n');
        } else if (operation === '--verify-wrapper') {
            const value = inspectQQTree(target, { expectedVersion: process.env.FWD_QQ_VERSION, expectedWrapperHash: process.env.FWD_QQ_EXPECTED_WRAPPER_SHA256 || undefined });
            const profile = evaluateRuntimeIdentity({ platform: 'linux', architecture: 'x64', qqVersion: value.qqVersion,
                profileId: process.env.FWD_QQ_PROFILE_ID, experimental: process.env.FWD_QQ_EXPERIMENTAL === '1',
                packageSha256: process.env.FWD_QQ_PACKAGE_SHA256, wrapperSha256: value.wrapperSha256 });
            if (profile.admission === 'denied') fail('Extracted QQ does not match an admitted runtime profile');
            process.stdout.write(value.wrapperSha256 + '\n');
        } else fail('Unsupported QQ runtime entry operation');
    } catch (error) { process.stderr.write((error.code === 'INVALID_CONFIG' || error.code === 'INVALID_QQ_RUNTIME' ? error.message : 'QQ runtime preflight failed') + '\n'); process.exitCode = 1; }
}
module.exports = { selectRuntime, inspectQQTree };
