'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { atomic, read, fail, privateDirectory, identifier, durableRename, syncDirectory } = require('./files.cjs');
const { normalizeRuntimeSelection, evaluateRuntimeIdentity, BASELINE } = require('../qq/runtime-profile.cjs');
const { inspectQQTree } = require('../../tools/qq-runtime-entry.cjs');

const STATE_DIRS = Object.freeze(['home', 'config', 'data', 'media', 'qq-root']);
const RESERVE = 5 * 1024 ** 3;
const MAX_PACKAGE = 1024 ** 3;
const digestFile = file => {
    const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
    try { const buffer = Buffer.allocUnsafe(1024 * 1024); let size;
        while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size));
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
};
function directory(root, relative, create = false) {
    const target = path.resolve(root, relative), rel = path.relative(path.resolve(root), target);
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw fail('UNSAFE_RUNTIME_PATH', 'Runtime paths must stay in the workspace');
    let current = path.resolve(root);
    for (const part of rel.split(path.sep)) {
        current = path.join(current, part);
        if (!fs.existsSync(current)) { if (create) fs.mkdirSync(current, { mode: 0o700 }); else return target; }
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UNSAFE_RUNTIME_PATH', 'Runtime directories must not contain symbolic links');
    }
    return target;
}
function regular(root, filename, limit = MAX_PACKAGE) {
    directory(root, path.dirname(filename));
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw fail('INVALID_PACKAGE', 'Expected an ordinary bounded QQ package file');
    return stat;
}
function treeBytes(target) {
    if (!fs.existsSync(target)) return 0;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) throw fail('UNSAFE_RUNTIME_PATH', 'Runtime state contains special files');
    return fs.readdirSync(target).reduce((sum, name) => sum + treeBytes(path.join(target, name)), 0);
}
function removeTree(root, target) {
    directory(root, target);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
}
function validateManifest(value, packageId) {
    if (!value || value.schemaVersion !== 1 || value.packageId !== identifier(packageId) || value.architecture !== 'x64' ||
        typeof value.qqVersion !== 'string' || !/^3\.2\.[0-9]+(?:-[0-9]+)?$/.test(value.qqVersion) ||
        !/^[a-f0-9]{64}$/.test(value.packageSha256 || '') || !/^[a-f0-9]{64}$/.test(value.wrapperSha256 || '') ||
        !Number.isSafeInteger(value.expandedBytes) || value.expandedBytes <= 0) throw fail('INVALID_PACKAGE', 'Invalid QQ runtime manifest');
    normalizeRuntimeSelection({ packageId, profileId: value.profileId, experimental: true });
    return value;
}

class QQRuntimes {
    constructor(root, accounts, { execute = execFileSync, waitMs = 120000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        availableBytes = target => { const stat = fs.statfsSync(target); return Number(stat.bavail) * Number(stat.bsize); }, checkpoint = () => {} } = {}) {
        this.root = root; this.accounts = accounts; this.execute = execute; this.waitMs = waitMs; this.now = now; this.sleep = sleep;
        this.availableBytes = availableBytes; this.checkpoint = checkpoint;
        this.packages = directory(root, 'work/qq-packages', true);
        this.imports = directory(root, 'work/qq-imports', true);
        this.journals = directory(root, 'work/control/runtime-switches', true);
        this.stages = directory(root, 'work/runtime-switches', true);
        this.importing = false;
    }
    package(packageId, { verify = true } = {}) {
        identifier(packageId);
        const base = directory(this.root, path.join(this.packages, packageId));
        const file = path.join(base, 'QQ.deb'), manifestFile = path.join(base, 'manifest.json');
        regular(this.root, manifestFile, 16384);
        const manifest = validateManifest(read(manifestFile), packageId);
        regular(this.root, file);
        if (verify && digestFile(file) !== manifest.packageSha256) throw fail('PACKAGE_DIGEST', 'Registered QQ package digest changed');
        return { ...manifest, file };
    }
    list() {
        const packages = [];
        for (const name of fs.readdirSync(this.packages)) {
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) continue;
            try { const { file, ...manifest } = this.package(name, { verify: false }); packages.push(manifest); }
            catch { packages.push({ packageId: name, state: 'invalid' }); }
        }
        return { packages, importDirectory: 'work/qq-imports', switches: this.accounts.list().map(item => ({ id: item.id, qqRuntime: item.qqRuntime,
            recoveryPending: fs.existsSync(path.join(this.journals, item.id + '.json')) })) };
    }
    backupIdentity(config) {
        const selection = normalizeRuntimeSelection(undefined, config.qqRuntime);
        if (selection.packageId) {
            const manifest = this.package(selection.packageId);
            if (selection.profileId !== manifest.profileId) throw fail('INVALID_PACKAGE', 'Account runtime profile does not match its immutable package');
            return { ...selection, platform: 'linux', architecture: 'x64', qqVersion: manifest.qqVersion,
                packageSha256: manifest.packageSha256, wrapperSha256: manifest.wrapperSha256, dataFormat: 1, evidence: 'package-verified' };
        }
        let packageSha256 = null, wrapperSha256 = null;
        for (const file of [path.join(this.root, 'runtime/packages/QQ.deb'), path.join(this.root, 'work/cache/downloads/QQ.deb')]) {
            try { regular(this.root, file); packageSha256 = digestFile(file); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const tree = path.join(this.accounts.location(config.id), 'qq-root');
        if (fs.existsSync(path.join(tree, 'opt/QQ/resources/app/package.json'))) wrapperSha256 = inspectQQTree(tree, { expectedVersion: BASELINE.qqVersion }).wrapperSha256;
        return { ...selection, platform: 'linux', architecture: 'x64', qqVersion: BASELINE.qqVersion,
            packageSha256, wrapperSha256, dataFormat: 1, evidence: packageSha256 === BASELINE.packageSha256 && wrapperSha256 === BASELINE.wrapperSha256 ? 'package-verified' : 'unverified' };
    }
    assertRestorable(runtime) {
        validateBackupRuntime(runtime);
        if (!runtime.packageSha256 || !runtime.wrapperSha256 || evaluateRuntimeIdentity({ ...runtime }).admission === 'denied') {
            throw fail('RUNTIME_UNAVAILABLE', 'Full QQ state needs an admitted runtime with complete source fingerprints', 409);
        }
        if (runtime.packageId) {
            const manifest = this.package(runtime.packageId);
            for (const key of ['qqVersion', 'packageSha256', 'wrapperSha256', 'profileId']) {
                if (manifest[key] !== runtime[key]) throw fail('RUNTIME_UNAVAILABLE', 'The exact source QQ runtime is required for a full restore', 409);
            }
            return;
        }
        for (const file of [path.join(this.root, 'runtime/packages/QQ.deb'), path.join(this.root, 'work/cache/downloads/QQ.deb')]) {
            try { regular(this.root, file); if (digestFile(file) === runtime.packageSha256 && runtime.wrapperSha256 === BASELINE.wrapperSha256) return; }
            catch (error) { if (!['ENOENT', 'INVALID_PACKAGE'].includes(error.code)) throw error; }
        }
        throw fail('RUNTIME_UNAVAILABLE', 'The exact baseline QQ package is required before restoring full QQ state', 409);
    }
    prepareRestore(runtime, target) {
        this.assertRestorable(runtime);
        let file;
        if (runtime.packageId) file = this.package(runtime.packageId).file;
        else file = [path.join(this.root, 'runtime/packages/QQ.deb'), path.join(this.root, 'work/cache/downloads/QQ.deb')].find(candidate => fs.existsSync(candidate) && digestFile(candidate) === runtime.packageSha256);
        if (!file || this.extract(file, target, runtime.qqVersion) !== runtime.wrapperSha256) throw fail('RUNTIME_UNAVAILABLE', 'Restored QQ wrapper does not match its source runtime', 409);
        atomic(path.join(target, '.freshwater-deb.sha256'), runtime.packageSha256 + '\n');
    }
    extract(file, target, expectedVersion) {
        this.execute('dpkg-deb', ['--extract', file, target], { cwd: this.root, timeout: 120000, stdio: 'pipe', env: { ...process.env,
            TEMP: path.join(this.root, 'work/temp'), TMP: path.join(this.root, 'work/temp'), TMPDIR: path.join(this.root, 'work/temp') } });
        return inspectQQTree(target, { expectedVersion }).wrapperSha256;
    }
    register({ file, expectedSha256 } = {}) {
        if (this.importing) throw fail('BUSY', 'QQ package import is already running', 409);
        if (typeof file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.deb$/.test(file) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) {
            throw fail('INVALID_PARAMS', 'Supply a staged QQ .deb filename and its independent SHA256');
        }
        const source = path.join(this.imports, file); regular(this.root, source);
        if (digestFile(source) !== expectedSha256) throw fail('PACKAGE_DIGEST', 'QQ package does not match the supplied SHA256');
        const packageId = 'qq-' + expectedSha256.slice(0, 32), destination = path.join(this.packages, packageId);
        if (fs.existsSync(destination)) return this.package(packageId);
        if (this.availableBytes(this.root) < RESERVE + fs.statSync(source).size * 8) throw fail('LOW_DISK', 'QQ import needs extraction space and a 5 GiB reserve', 409);
        const stage = directory(this.root, 'work/temp/qq-import-' + crypto.randomBytes(12).toString('hex'), true);
        this.importing = true;
        try {
            const frozen = path.join(stage, 'QQ.deb');
            fs.copyFileSync(source, frozen, fs.constants.COPYFILE_EXCL);
            if (digestFile(frozen) !== expectedSha256) throw fail('PACKAGE_DIGEST', 'QQ package changed while being staged');
            const metadata = this.execute('dpkg-deb', ['--field', frozen, 'Version', 'Architecture'], { cwd: this.root, encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
            const qqVersion = String(metadata).match(/^Version:\s*(\S+)$/m)?.[1];
            if (!/^Architecture:\s*amd64$/m.test(String(metadata)) || !/^3\.2\.[0-9]+(?:-[0-9]+)?$/.test(qqVersion || '')) throw fail('INVALID_PACKAGE', 'Only Linux QQ 3.2.x amd64 packages can be registered');
            const extracted = directory(this.root, path.join(stage, 'extracted'), true);
            const wrapperSha256 = this.extract(frozen, extracted, qqVersion);
            const manifest = { schemaVersion: 1, packageId, profileId: 'linux-x64-' + qqVersion, qqVersion, architecture: 'x64',
                packageSha256: expectedSha256, wrapperSha256, expandedBytes: treeBytes(extracted) };
            validateManifest(manifest, packageId);
            removeTree(this.root, extracted); atomic(path.join(stage, 'manifest.json'), manifest);
            durableRename(stage, destination);
            return manifest;
        } finally { if (fs.existsSync(stage)) removeTree(this.root, stage); this.importing = false; }
    }
    journal(id) { return path.join(this.journals, identifier(id) + '.json'); }
    readJournal(id) {
        const journal = read(this.journal(id), null);
        if (!journal) return null;
        if (journal.schemaVersion !== 1 || journal.id !== id || !/^work\/runtime-switches\/[A-Za-z0-9_-]+-[a-f0-9]{24}$/.test(journal.stage || '') ||
            !['prepared', 'swapping', 'verifying', 'committed', 'rolling_back', 'rollback_failed'].includes(journal.phase) || !Array.isArray(journal.swaps) ||
            journal.swaps.some(swap => !STATE_DIRS.includes(swap.name) || typeof swap.hadOriginal !== 'boolean' ||
                swap.rollbackIntent !== undefined && typeof swap.rollbackIntent !== 'boolean' || swap.rolledBack !== undefined && typeof swap.rolledBack !== 'boolean') ||
            new Set(journal.swaps.map(swap => swap.name)).size !== journal.swaps.length || journal.previous?.id !== id) {
            throw fail('RUNTIME_RECOVERY_FAILED', 'Invalid runtime switch journal; preserve private state for recovery', 503);
        }
        directory(this.root, journal.stage); normalizeRuntimeSelection(undefined, journal.previous.qqRuntime);
        return journal;
    }
    rollback(id, journal) {
        this.accounts.assertStopped(id);
        const stage = directory(this.root, journal.stage), base = this.accounts.location(id);
        journal.phase = 'rolling_back'; atomic(this.journal(id), journal);
        for (const swap of [...journal.swaps].reverse()) {
            const current = path.join(base, swap.name), old = path.join(stage, 'old', swap.name), pending = path.join(stage, 'new', swap.name);
            directory(this.root, current); directory(this.root, old); directory(this.root, pending);
            if (swap.rolledBack) {
                if (fs.existsSync(old) || fs.existsSync(current) !== swap.hadOriginal) throw fail('RUNTIME_RECOVERY_FAILED', 'Completed rollback paths changed', 503);
                continue;
            }
            if (fs.existsSync(old)) {
                swap.rollbackIntent = true; atomic(this.journal(id), journal);
                if (fs.existsSync(current)) removeTree(this.root, current);
                durableRename(old, current); this.checkpoint('after_rollback_rename', swap.name);
            }
            else if (swap.hadOriginal) {
                if (!fs.existsSync(current) || !fs.existsSync(pending) && !swap.rollbackIntent) throw fail('RUNTIME_RECOVERY_FAILED', 'Runtime rollback state is incomplete', 503);
            } else {
                swap.rollbackIntent = true; atomic(this.journal(id), journal);
                if (!fs.existsSync(pending) && fs.existsSync(current)) removeTree(this.root, current);
                else if (fs.existsSync(pending) && fs.existsSync(current)) throw fail('RUNTIME_RECOVERY_FAILED', 'Runtime rollback target appeared unexpectedly', 503);
            }
            swap.rolledBack = true; atomic(this.journal(id), journal);
        }
        this.accounts.commitProfile(id, structuredClone(journal.previous));
        this.accounts.clearGrant(id); this.accounts.writeConfig(id);
        fs.unlinkSync(this.journal(id)); syncDirectory(this.journals);
        removeTree(this.root, stage); this.accounts.runtimePending.delete(id);
    }
    recover() {
        for (const item of this.accounts.document.profiles) {
            if (!fs.existsSync(this.journal(item.id))) continue;
            const journal = this.readJournal(item.id);
            if (journal.phase === 'committed') { fs.unlinkSync(this.journal(item.id)); continue; }
            this.accounts.runtimePending.add(item.id);
            try { this.rollback(item.id, journal); }
            catch { this.accounts.states.set(item.id, 'runtime_recovery_failed'); }
        }
    }
    async switch(id, selection, { expectedRevision } = {}) {
        const next = normalizeRuntimeSelection(selection);
        if (!next.packageId) throw fail('INVALID_PARAMS', 'Select an immutable registered QQ package');
        const candidate = this.package(next.packageId);
        if (candidate.profileId !== next.profileId) throw fail('INVALID_PACKAGE', 'Selected QQ profile does not match the package');
        if (evaluateRuntimeIdentity({ platform: 'linux', architecture: 'x64', ...candidate, ...next }).admission === 'denied') {
            throw fail('VERSION_UNVERIFIED', 'Enable experimental mode before selecting an unverified QQ build', 409);
        }
        return this.accounts.operate(id, async () => {
            if (fs.existsSync(this.journal(id))) throw fail('MAINTENANCE', 'QQ runtime recovery must finish before another switch', 409);
            const previous = structuredClone(this.accounts.get(id)), running = this.accounts.processes.has(id), base = this.accounts.location(id);
            if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw fail('CONFIG_CHANGED', 'Account configuration changed; reload it before switching QQ versions', 409);
            const expected = previous.expectedUin || previous.boundUin;
            if (running && !expected) throw fail('IDENTITY_REQUIRED', 'Bind the current QQ identity before switching a running account', 409);
            const bytes = STATE_DIRS.reduce((total, name) => total + treeBytes(path.join(base, name)), 0) + candidate.expandedBytes;
            if (this.availableBytes(this.root) < bytes + Math.max(RESERVE, Math.ceil(bytes / 10))) throw fail('LOW_DISK', 'QQ version switch needs a full rollback snapshot and disk reserve', 409);
            const stageRelative = 'work/runtime-switches/' + id + '-' + crypto.randomBytes(12).toString('hex');
            const stage = directory(this.root, stageRelative, true);
            const journal = { schemaVersion: 1, id, phase: 'prepared', stage: stageRelative, previous, selection: next, swaps: [], at: this.now() };
            let journalWritten = false;
            try {
                this.accounts.runtimePending.add(id); this.accounts.clearGrant(id);
                await this.accounts.stopAccount(id, { preserveIntent: true }); this.accounts.assertStopped(id);
                const data = path.join(base, 'data');
                if (fs.existsSync(data)) require('../onebot/store.cjs').checkpointDirectory(data);
                directory(this.root, path.join(stage, 'new'), true); directory(this.root, path.join(stage, 'old'), true);
                for (const name of STATE_DIRS) {
                    const target = directory(this.root, path.join(stage, 'new', name), true), current = path.join(base, name);
                    if (name === 'qq-root') {
                        if (this.extract(candidate.file, target, candidate.qqVersion) !== candidate.wrapperSha256) throw fail('PACKAGE_DIGEST', 'QQ wrapper fingerprint differs from its manifest');
                        atomic(path.join(target, '.freshwater-deb.sha256'), candidate.packageSha256 + '\n');
                    } else if (fs.existsSync(current)) { directory(this.root, current); fs.cpSync(current, target, { recursive: true, dereference: false, verbatimSymlinks: true }); }
                }
                atomic(this.journal(id), journal); journalWritten = true;
                journal.phase = 'swapping'; atomic(this.journal(id), journal);
                for (const name of STATE_DIRS) {
                    const current = path.join(base, name), swap = { name, hadOriginal: fs.existsSync(current) };
                    journal.swaps.push(swap); atomic(this.journal(id), journal);
                    if (swap.hadOriginal) durableRename(current, path.join(stage, 'old', name));
                    this.checkpoint('after_old_rename', name);
                    durableRename(path.join(stage, 'new', name), current); this.checkpoint('after_new_rename', name);
                }
                this.accounts.commitProfile(id, { qqRuntime: next, revision: previous.revision + 1 });
                journal.phase = 'verifying'; atomic(this.journal(id), journal);
                if (running) {
                    await this.accounts.startAccount(id, { automatic: true, runtimeSwitch: true });
                    const deadline = this.now() + this.waitMs;
                    let ready = false;
                    while (this.now() < deadline) {
                        if (!this.accounts.processes.has(id)) throw fail('RUNTIME_START_FAILED', 'The selected QQ runtime exited before verification', 409);
                        const health = read(path.join(base, 'state/health.json'), {});
                        if (health.ready === true && String(health.selfId) === expected && health.at >= journal.at && this.now() - health.at < 15000) { ready = true; break; }
                        if (health.ready === true && health.selfId && String(health.selfId) !== expected) throw fail('ACCOUNT_MISMATCH', 'The new QQ runtime reported a different account', 409);
                        await this.sleep(250);
                    }
                    if (!ready) throw fail('RUNTIME_IDENTITY_TIMEOUT', 'QQ login identity was not confirmed; restoring the previous runtime', 409);
                } else this.accounts.writeConfig(id);
                journal.phase = 'committed'; atomic(this.journal(id), journal);
                atomic(path.join(stage, 'snapshot.json'), { ...journal, committedAt: this.now() });
                fs.unlinkSync(this.journal(id)); syncDirectory(this.journals);
                this.accounts.runtimePending.delete(id); this.accounts.onChange();
                let snapshotCleanupPending = false;
                try {
                    const snapshots = directory(this.root, 'work/control/runtime-snapshots', true), index = path.join(snapshots, id + '.json');
                    const old = read(index, null);
                    atomic(index, { schemaVersion: 1, id, stage: stageRelative });
                    if (old && old.id === id && old.stage !== stageRelative &&
                        new RegExp('^work/runtime-switches/' + id + '-[a-f0-9]{24}$').test(old.stage || '')) {
                        const oldStage = directory(this.root, old.stage), snapshot = read(path.join(oldStage, 'snapshot.json'));
                        if (snapshot.id !== id || snapshot.phase !== 'committed' || snapshot.stage !== old.stage) throw fail('UNSAFE_RUNTIME_PATH', 'Previous snapshot ownership could not be confirmed');
                        removeTree(this.root, oldStage);
                    }
                } catch { snapshotCleanupPending = true; }
                return { id, qqRuntime: next, identityVerified: running, rollbackSnapshot: stageRelative, routesPreserved: true, snapshotCleanupPending };
            } catch (error) {
                try {
                    await this.accounts.stopAccount(id, { preserveIntent: true });
                    if (journalWritten) this.rollback(id, journal);
                    else { removeTree(this.root, stage); this.accounts.runtimePending.delete(id); }
                } catch {
                    journal.phase = 'rollback_failed'; atomic(this.journal(id), journal);
                    this.accounts.states.set(id, 'runtime_recovery_failed');
                    throw fail('RUNTIME_RECOVERY_FAILED', 'Runtime switch failed; private rollback state is retained and account startup is blocked', 503);
                }
                if (running) {
                    try { await this.accounts.startAccount(id, { automatic: true }); }
                    catch { this.accounts.states.set(id, 'runtime_restored_start_failed'); }
                }
                throw error;
            }
        });
    }
}

function validateBackupRuntime(runtime) {
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime) ||
        Object.keys(runtime).some(key => !['packageId', 'profileId', 'experimental', 'platform', 'architecture', 'qqVersion', 'packageSha256', 'wrapperSha256', 'dataFormat', 'evidence'].includes(key)) ||
        runtime.evidence !== undefined && !['package-verified', 'unverified'].includes(runtime.evidence) ||
        runtime.platform !== 'linux' || runtime.architecture !== 'x64' || runtime.dataFormat !== 1 ||
        !/^3\.2\.[0-9]+(?:-[0-9]+)?$/.test(runtime.qqVersion || '') ||
        !['packageSha256', 'wrapperSha256'].every(key => /^[a-f0-9]{64}$/.test(runtime[key] || '') || runtime.evidence === 'unverified' && runtime[key] === null)) throw fail('INVALID_BACKUP', 'Invalid per-account QQ runtime identity');
    normalizeRuntimeSelection({ packageId: runtime.packageId, profileId: runtime.profileId, experimental: runtime.experimental });
    return runtime;
}

module.exports = { QQRuntimes, validateManifest, validateBackupRuntime, treeBytes, digestFile, STATE_DIRS };
