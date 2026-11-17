'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { Accounts } = require('../src/manager/accounts.cjs');
const { QQRuntimes, STATE_DIRS } = require('../src/manager/qq-runtimes.cjs');
const { Backups, validateArchive } = require('../src/manager/backups.cjs');
const { normalizeRuntimeSelection } = require('../src/qq/runtime-profile.cjs');
const { atomic } = require('../src/manager/files.cjs');
const parent = path.resolve(__dirname, '../work/temp');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, runtimeOptions = {}) {
    fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'qq-runtimes-'));
    const accounts = new Accounts(root), calls = [];
    for (const [id, uin, port] of [['legacy', '1000000001', 17700], ['secondary', '1000000002', 17701]]) {
        accounts.create({ id, expectedUin: uin, nodes: [{ id: 'astrbot', type: 'wsClient', enabled: true, url: 'ws://127.0.0.1:' + port + '/ws', token: 'saved-secret' }] });
        const base = accounts.location(id);
        for (const name of STATE_DIRS) { fs.mkdirSync(path.join(base, name), { recursive: true }); fs.writeFileSync(path.join(base, name, 'sentinel'), id + '-old-' + name); }
        accounts.writeConfig(id);
    }
    accounts.stopAccount = async id => { accounts.processes.delete(id); accounts.clearGrant(id); };
    t.after(async () => { accounts.processes.clear(); await accounts.close(); assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
    const wrapper = Buffer.from('synthetic-linux-qq-wrapper'), packageBytes = Buffer.from('synthetic-linux-qq-package');
    const execute = (command, args) => {
        calls.push({ command, args: [...args] }); assert.equal(command, 'dpkg-deb');
        if (args[0] === '--field') return 'Version: 3.2.36-70000\nArchitecture: amd64\n';
        assert.equal(args[0], '--extract');
        const app = path.join(args[2], 'opt/QQ/resources/app'); fs.mkdirSync(app, { recursive: true });
        fs.writeFileSync(path.join(app, 'wrapper.node'), wrapper);
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '3.2.36-70000', buildVersion: '70000', platform: 'linux', eleArch: 'x64' }));
        return '';
    };
    const runtimes = new QQRuntimes(root, accounts, { execute, availableBytes: () => 100 * 1024 ** 3, ...runtimeOptions });
    fs.writeFileSync(path.join(runtimes.imports, 'candidate.deb'), packageBytes);
    const manifest = runtimes.register({ file: 'candidate.deb', expectedSha256: digest(packageBytes) });
    const selection = { packageId: manifest.packageId, profileId: manifest.profileId, experimental: true };
    return { root, accounts, runtimes, calls, manifest, selection, wrapper, packageBytes };
}
const routes = accounts => accounts.document.profiles.map(item => ({ id: item.id, nodes: structuredClone(item.nodes) }));
test('a stale account revision rejects a runtime switch before state, routes, or grants change', async t => {
    const { accounts, runtimes, selection } = fixture(t);
    const before = structuredClone(accounts.document), oldState = snapshot(accounts, 'legacy');
    await assert.rejects(runtimes.switch('legacy', selection, { expectedRevision: accounts.get('legacy').revision + 1 }), { code: 'CONFIG_CHANGED' });
    assert.deepEqual(accounts.document, before); assert.deepEqual(snapshot(accounts, 'legacy'), oldState);
    assert.equal(accounts.runtimePending.size, 0); assert.equal(fs.readdirSync(runtimes.journals).length, 0);
});
function snapshot(accounts, id) { const base = accounts.location(id); return Object.fromEntries(STATE_DIRS.map(name => [name, fs.readFileSync(path.join(base, name, 'sentinel'), 'utf8')])); }

test('runtime registration pins a package, wrapper and complete build, rejecting digest mutation before switching', async t => {
    const f = fixture(t); assert.equal(f.manifest.qqVersion, '3.2.36-70000'); assert.equal(f.manifest.wrapperSha256, digest(f.wrapper));
    assert.throws(() => f.runtimes.register({ file: '../candidate.deb', expectedSha256: digest(f.packageBytes) }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.runtimes.switch('legacy', { ...f.selection, experimental: false }), { code: 'VERSION_UNVERIFIED' });
    assert.equal(f.accounts.get('legacy').qqRuntime.packageId, null);
    fs.writeFileSync(path.join(f.runtimes.packages, f.manifest.packageId, 'QQ.deb'), 'tampered');
    await assert.rejects(f.runtimes.switch('legacy', f.selection), { code: 'PACKAGE_DIGEST' });
});
test('switching a stopped account keeps private state, both original AstrBot routes and a rollback snapshot', async t => {
    const f = fixture(t), beforeRoutes = routes(f.accounts), secondary = snapshot(f.accounts, 'secondary');
    const result = await f.runtimes.switch('legacy', f.selection);
    assert.equal(result.identityVerified, false); assert.deepEqual(f.accounts.get('legacy').qqRuntime, f.selection);
    assert.deepEqual(routes(f.accounts), beforeRoutes); assert.deepEqual(snapshot(f.accounts, 'secondary'), secondary);
    assert.equal(fs.readFileSync(path.join(f.accounts.location('legacy'), 'config/sentinel'), 'utf8'), 'legacy-old-config');
    assert.equal(fs.existsSync(path.join(f.root, result.rollbackSnapshot, 'old/qq-root/sentinel')), true);
    assert.equal(fs.existsSync(f.runtimes.journal('legacy')), false);
});
test('failed mid-swap restores exact old binary, state, configuration and both routes', async t => {
    let fired = false;
    const f = fixture(t, { checkpoint(phase, name) { if (!fired && phase === 'after_new_rename' && name === 'data') { fired = true; throw Object.assign(new Error('synthetic interruption'), { code: 'SYNTHETIC' }); } } });
    const previous = structuredClone(f.accounts.get('legacy')), before = snapshot(f.accounts, 'legacy'), beforeRoutes = routes(f.accounts);
    await assert.rejects(f.runtimes.switch('legacy', f.selection), { code: 'SYNTHETIC' });
    assert.deepEqual(f.accounts.get('legacy'), previous); assert.deepEqual(snapshot(f.accounts, 'legacy'), before);
    assert.deepEqual(routes(f.accounts), beforeRoutes); assert.equal(fs.existsSync(f.runtimes.journal('legacy')), false);
    assert.equal(f.accounts.runtimePending.has('legacy'), false);
});
test('a running account cannot renew an authorization grant until the new login identity is verified', async t => {
    const f = fixture(t), beforeRoutes = routes(f.accounts); f.accounts.commitProfile('legacy', { desired: 'running' });
    f.accounts.processes.set('legacy', {}); let checks = 0;
    f.accounts.startAccount = async (id, options) => {
        checks++; assert.equal(options.runtimeSwitch, true); f.accounts.processes.set(id, {}); f.accounts.writeConfig(id);
        const health = { at: Date.now(), ready: true, selfId: '1000000001', sessionEpoch: 'new-runtime-session', online: true, gatewayPort: 4100 };
        atomic(path.join(f.accounts.location(id), 'state/health.json'), health);
        f.accounts.pollAccount(id, new Map());
        assert.equal(fs.existsSync(path.join(f.accounts.location(id), 'state/authorization.json')), false);
    };
    const result = await f.runtimes.switch('legacy', f.selection); assert.equal(result.identityVerified, true); assert.equal(checks, 1);
    f.accounts.pollAccount('legacy', new Map());
    assert.equal(fs.existsSync(path.join(f.accounts.location('legacy'), 'state/authorization.json')), true);
    assert.deepEqual(routes(f.accounts), beforeRoutes);
});
test('a persisted incomplete switch journal recovers the old data and runtime before account start', t => {
    const f = fixture(t), id = 'legacy', previous = structuredClone(f.accounts.get(id)), beforeRoutes = routes(f.accounts);
    const stageRelative = 'work/runtime-switches/legacy-' + 'a'.repeat(24), stage = path.join(f.root, stageRelative), base = f.accounts.location(id);
    fs.mkdirSync(path.join(stage, 'old'), { recursive: true }); fs.mkdirSync(path.join(stage, 'new'), { recursive: true });
    fs.renameSync(path.join(base, 'data'), path.join(stage, 'old/data'));
    fs.mkdirSync(path.join(base, 'data')); fs.writeFileSync(path.join(base, 'data/sentinel'), 'new-state');
    f.accounts.commitProfile(id, { qqRuntime: f.selection });
    atomic(f.runtimes.journal(id), { schemaVersion: 1, id, phase: 'verifying', stage: stageRelative, previous, selection: f.selection,
        swaps: [{ name: 'data', hadOriginal: true }], at: Date.now() });
    f.runtimes.recover();
    assert.deepEqual(f.accounts.get(id), previous); assert.equal(fs.readFileSync(path.join(base, 'data/sentinel'), 'utf8'), 'legacy-old-data');
    assert.deepEqual(routes(f.accounts), beforeRoutes); assert.equal(fs.existsSync(f.runtimes.journal(id)), false);
});
test('v3 archives reject runtime selection conflicts and require the exact source package before touching state', async t => {
    const f = fixture(t), config = structuredClone(f.accounts.get('legacy'));
    config.qqRuntime = f.selection;
    const runtime = { ...f.selection, platform: 'linux', architecture: 'x64', qqVersion: f.manifest.qqVersion,
        packageSha256: f.manifest.packageSha256, wrapperSha256: f.manifest.wrapperSha256, dataFormat: 1 };
    const document = { version: 3, architecture: 'x64', kind: 'full', profiles: [{ config, runtime, entries: [] }] };
    const conflict = structuredClone(document); conflict.profiles[0].runtime.packageId = 'another';
    assert.throws(() => validateArchive(conflict), { code: 'INVALID_BACKUP' });
    const validated = validateArchive(structuredClone(document));
    const backups = new Backups(f.root, f.accounts, { runtimes: f.runtimes, memory: () => ({ free: 10 * 1024 ** 3, total: 20 * 1024 ** 3 }) });
    t.after(() => backups.close());
    backups.previews.set('synthetic', { backupId: 'archive', document: validated, expires: Date.now() + 10000 });
    const packageDir = path.join(f.runtimes.packages, f.manifest.packageId); fs.renameSync(packageDir, packageDir + '-hidden');
    const before = snapshot(f.accounts, 'legacy'), previous = structuredClone(f.accounts.get('legacy'));
    await assert.rejects(backups.apply('synthetic', 'archive'));
    assert.deepEqual(snapshot(f.accounts, 'legacy'), before); assert.deepEqual(f.accounts.get('legacy'), previous);
    assert.equal(fs.existsSync(backups.journalFile), false);
});
test('restarting recovery after an interrupted rollback rename does not discard the restored old state', async t => {
    let interrupted = false;
    const f = fixture(t, { checkpoint(phase) { if (phase === 'after_rollback_rename' && !interrupted) { interrupted = true; throw new Error('synthetic recovery interruption'); } } });
    const id = 'legacy', previous = structuredClone(f.accounts.get(id)), beforeRoutes = routes(f.accounts), base = f.accounts.location(id);
    const stageRelative = 'work/runtime-switches/legacy-' + 'b'.repeat(24), stage = path.join(f.root, stageRelative);
    fs.mkdirSync(path.join(stage, 'old'), { recursive: true }); fs.mkdirSync(path.join(stage, 'new'), { recursive: true });
    fs.renameSync(path.join(base, 'data'), path.join(stage, 'old/data')); fs.mkdirSync(path.join(base, 'data'));
    fs.writeFileSync(path.join(base, 'data/sentinel'), 'new-runtime-data');
    f.accounts.commitProfile(id, { qqRuntime: f.selection });
    atomic(f.runtimes.journal(id), { schemaVersion: 1, id, phase: 'verifying', stage: stageRelative, previous, selection: f.selection,
        swaps: [{ name: 'data', hadOriginal: true }], at: Date.now() });
    f.runtimes.recover();
    assert.equal(interrupted, true); assert.equal(fs.existsSync(f.runtimes.journal(id)), true);
    assert.equal(fs.readFileSync(path.join(base, 'data/sentinel'), 'utf8'), 'legacy-old-data');
    // Reconstruct both objects from disk, as after a manager process restart.
    const restartedAccounts = new Accounts(f.root), restarted = new QQRuntimes(f.root, restartedAccounts);
    t.after(() => restartedAccounts.close()); restarted.recover();
    assert.deepEqual(restartedAccounts.get(id), previous);
    assert.equal(fs.readFileSync(path.join(base, 'data/sentinel'), 'utf8'), 'legacy-old-data');
    assert.deepEqual(routes(restartedAccounts), beforeRoutes); assert.equal(fs.existsSync(restarted.journal(id)), false);
    assert.equal(restartedAccounts.runtimePending.has(id), false);
});
test('a full v3 restore installs the recorded QQ binary together with its matching state and runtime selection', async t => {
    const f = fixture(t), config = structuredClone(f.accounts.get('legacy')); config.qqRuntime = f.selection;
    const runtime = { ...f.selection, platform: 'linux', architecture: 'x64', qqVersion: f.manifest.qqVersion,
        packageSha256: f.manifest.packageSha256, wrapperSha256: f.manifest.wrapperSha256, dataFormat: 1 };
    const bytes = Buffer.from('source-version-state'), document = validateArchive({ version: 3, architecture: 'x64', kind: 'full', profiles: [{ config, runtime,
        entries: [{ name: 'config/source-state', size: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }] }] });
    const backups = new Backups(f.root, f.accounts, { runtimes: f.runtimes, memory: () => ({ free: 10 * 1024 ** 3, total: 20 * 1024 ** 3 }) }); t.after(() => backups.close());
    backups.previews.set('synthetic', { backupId: 'archive', document, expires: Date.now() + 10000 });
    const beforeRoutes = routes(f.accounts); await backups.apply('synthetic', 'archive');
    const base = f.accounts.location('legacy');
    assert.deepEqual(fs.readFileSync(path.join(base, 'qq-root/opt/QQ/resources/app/wrapper.node')), f.wrapper);
    assert.equal(fs.readFileSync(path.join(base, 'qq-root/.freshwater-deb.sha256'), 'utf8').trim(), f.manifest.packageSha256);
    assert.deepEqual(fs.readFileSync(path.join(base, 'config/source-state')), bytes);
    assert.deepEqual(f.accounts.get('legacy').qqRuntime, f.selection); assert.equal(f.accounts.get('legacy').desired, 'stopped');
    assert.deepEqual(routes(f.accounts), beforeRoutes); assert.equal(fs.existsSync(backups.journalFile), false);
});
