'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Accounts } = require('../src/manager/accounts.cjs');
const { atomic, read } = require('../src/manager/files.cjs');
const { prepare } = require('../tools/prepare-qq.cjs');

function fixture(t, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'account-lifecycle-'));
    const children = []; let serial = 800;
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 31, total: 2 ** 32 }), displayBusy: () => false,
        spawnAccount: value => {
            const child = new EventEmitter(); child.pid = serial++; child.env = value.env;
            child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
            children.push(child); return child;
        }, ...options });
    accounts.customPlatform = true;
    t.after(async () => {
        await accounts.close();
        assert.ok(path.resolve(root).startsWith(parent + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const account = id => {
        accounts.create({ id });
        const base = accounts.location(id);
        for (const name of ['state', 'home', 'data', 'config', 'qq-root/opt/QQ/resources/app']) fs.mkdirSync(path.join(base, name), { recursive: true });
        fs.writeFileSync(path.join(base, 'home/login.dat'), 'login-' + id);
        fs.writeFileSync(path.join(base, 'data/1000000001.json'), 'message-mapping-' + id);
        const app = path.join(base, 'qq-root/opt/QQ/resources/app');
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'main.cjs', name: id }) + '\n');
        fs.writeFileSync(path.join(app, 'main.cjs'), 'module.exports = {};\n');
        fs.mkdirSync(path.join(root, 'src/qq'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src/qq/entry.cjs'), 'exports.bootstrap = value => value;\n');
        prepare({ root, accountRoot: base, appDir: app });
        return { base, app };
    };
    return { root, accounts, children, account };
}

test('bridge uninstall restores only its owned entry and restarts QQ without deleting login or message data', async t => {
    const f = fixture(t), a = f.account('a'), b = f.account('b');
    await f.accounts.start('a'); await f.accounts.start('b');
    const originalB = fs.readFileSync(path.join(b.app, 'package.json'));
    const result = await f.accounts.uninstall('a');
    assert.equal(result.bridgeInstalled, false); assert.equal(result.saved, true); assert.equal(result.applied, true);
    assert.equal(f.children.length, 3); assert.equal(f.children[2].env.FWD_BRIDGE_ENABLED, '0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.app, 'package.json'))).main, 'main.cjs');
    assert.deepEqual(fs.readFileSync(path.join(b.app, 'package.json')), originalB);
    assert.equal(f.accounts.processes.get('b'), f.children[1]);
    assert.equal(fs.readFileSync(path.join(a.base, 'home/login.dat'), 'utf8'), 'login-a');
    assert.equal(fs.readFileSync(path.join(a.base, 'data/1000000001.json'), 'utf8'), 'message-mapping-a');
    atomic(path.join(a.base, 'state/health.json'), { at: Date.now(), ready: true, online: true, selfId: '1000000001', sessionEpoch: 'stale', gatewayPort: 12000 });
    atomic(path.join(a.base, 'state/authorization.json'), { stale: true });
    f.accounts.poll();
    assert.equal(f.accounts.states.get('a'), 'qq_only'); assert.equal(f.accounts.healths.has('a'), false);
    assert.equal(fs.existsSync(path.join(a.base, 'state/authorization.json')), false);
    assert.throws(() => f.accounts.gateway('a'), { code: 'BRIDGE_UNINSTALLED' });
    assert.equal((await f.accounts.install('a')).bridgeInstalled, true);
    assert.equal(f.children[3].env.FWD_BRIDGE_ENABLED, '1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.app, 'package.json'))).main, 'freshwater-entry.cjs');
});

test('bridge installation state cannot be written through ordinary configuration', async t => {
    const f = fixture(t); f.account('a');
    assert.throws(() => f.accounts.create({ id: 'b', bridgeInstalled: false }), { code: 'INVALID_CONFIG' });
    await assert.rejects(f.accounts.update('a', { bridgeInstalled: false }), { code: 'INVALID_CONFIG' });
    assert.equal(f.accounts.get('a').bridgeInstalled, true);
});
test('account startup passes the expected or bound identity to desktop optimization', async t => {
    const f = fixture(t); f.account('a'); f.account('b');
    f.accounts.get('a').expectedUin = '123'; f.accounts.get('b').boundUin = '456';
    await f.accounts.start('a'); await f.accounts.start('b');
    assert.equal(f.children[0].env.FWD_EXPECTED_UIN, '123'); assert.equal(f.children[1].env.FWD_EXPECTED_UIN, '456');
});

test('bridge changes on a not-yet-extracted QQ copy persist the desired mode without starting QQ', async t => {
    const f = fixture(t); f.accounts.create({ id: 'a' });
    assert.equal((await f.accounts.uninstall('a')).applied, true);
    assert.equal(f.accounts.get('a').desired, 'stopped'); assert.equal(f.children.length, 0);
    assert.equal((await f.accounts.install('a')).bridgeInstalled, true);
});

test('bridge restore ownership failure preserves mode, files and other running account', async t => {
    const f = fixture(t), a = f.account('a'); f.account('b');
    await f.accounts.start('a'); await f.accounts.start('b');
    const proxy = path.join(a.app, 'freshwater-entry.cjs'); fs.appendFileSync(proxy, '// unexpected owner\n');
    await assert.rejects(f.accounts.uninstall('a'), /ownership check failed/);
    assert.equal(f.accounts.get('a').bridgeInstalled, true); assert.equal(f.accounts.processes.has('a'), false);
    assert.equal(f.accounts.processes.get('b'), f.children[1]);
    assert.match(fs.readFileSync(proxy, 'utf8'), /unexpected owner/);
});

test('unconfirmed stop prevents bridge restore and account deletion before any file cleanup', async t => {
    const f = fixture(t), a = f.account('a');
    const before = fs.readFileSync(path.join(a.app, 'package.json'));
    f.accounts.stopAccount = async () => { throw Object.assign(new Error('test unconfirmed stop'), { code: 'STOP_UNCONFIRMED' }); };
    await assert.rejects(f.accounts.uninstall('a'), { code: 'STOP_UNCONFIRMED' });
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'STOP_UNCONFIRMED' });
    assert.equal(f.accounts.get('a').bridgeInstalled, true);
    assert.deepEqual(fs.readFileSync(path.join(a.app, 'package.json')), before);
    assert.equal(fs.readFileSync(path.join(a.base, 'home/login.dat'), 'utf8'), 'login-a');
});

test('a bridge relaunch failure reports saved but not applied and never reports account ready', async t => {
    const f = fixture(t); f.account('a'); await f.accounts.start('a');
    f.accounts.spawnAccount = () => { throw Object.assign(new Error('test spawn failure'), { code: 'SPAWN_FAILED' }); };
    const result = await f.accounts.uninstall('a');
    assert.equal(result.saved, true); assert.equal(result.applied, false); assert.equal(result.error, 'SPAWN_FAILED');
    assert.equal(result.bridgeInstalled, false); assert.equal(f.accounts.healths.has('a'), false);
    assert.equal(f.accounts.states.get('a'), 'apply_failed');
});

test('account deletion requires its exact confirmation and only removes the selected account', async t => {
    const f = fixture(t), a = f.account('a'), b = f.account('b');
    await f.accounts.start('a'); await f.accounts.start('b');
    await assert.rejects(f.accounts.remove('a', { confirmId: 'b' }), { code: 'CONFIRMATION_REQUIRED' });
    await assert.rejects(f.accounts.remove('missing', { confirmId: 'missing' }), { code: 'NOT_FOUND' });
    assert.deepEqual(await f.accounts.remove('a', { confirmId: 'a' }), { id: 'a', deleted: true });
    assert.equal(fs.existsSync(a.base), false); assert.throws(() => f.accounts.get('a'), { code: 'NOT_FOUND' });
    assert.equal(f.accounts.processes.get('b'), f.children[1]);
    assert.equal(fs.readFileSync(path.join(b.base, 'home/login.dat'), 'utf8'), 'login-b');
    assert.deepEqual(read(f.accounts.file).profiles.map(item => item.id), ['b']);
    const reloaded = new Accounts(f.root); t.after(() => reloaded.close());
    assert.equal(reloaded.document.profiles.some(item => item.id === 'a'), false);
});

test('deletion of an earlier account never reassigns a running peers display to a new account', async t => {
    const f = fixture(t); f.account('a'); f.account('b');
    await f.accounts.start('a'); await f.accounts.start('b');
    const displayB = f.children[1].env.DISPLAY;
    await f.accounts.remove('a', { confirmId: 'a' }); f.account('c'); await f.accounts.start('c');
    assert.equal(f.accounts.processes.get('b'), f.children[1]);
    assert.equal(f.accounts.processes.get('b').env.DISPLAY, displayB);
    assert.notEqual(f.children[2].env.DISPLAY, displayB);
    assert.equal(f.children[2].env.DISPLAY, ':120');
});

test('display allocation skips OS-occupied sockets and verifies live process bindings', async t => {
    const f = fixture(t, { displayBusy: value => value === 120 }); f.account('a'); f.account('b');
    await f.accounts.start('a'); await f.accounts.start('b');
    assert.equal(f.children[0].env.DISPLAY, ':121'); assert.equal(f.children[1].env.DISPLAY, ':122');
});

test('delete and bridge changes reject maintenance, pending restore and concurrent account changes', async t => {
    const f = fixture(t); f.account('a');
    f.accounts.document.maintenance.a = { operation: 'backup', phase: 'stopped' };
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'BUSY' });
    await assert.rejects(f.accounts.uninstall('a'), { code: 'BUSY' });
    delete f.accounts.document.maintenance.a;
    atomic(path.join(f.accounts.control, 'restore-journal.json'), { ids: ['a'] });
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'MAINTENANCE' });
    await assert.rejects(f.accounts.uninstall('a'), { code: 'MAINTENANCE' });
    fs.unlinkSync(path.join(f.accounts.control, 'restore-journal.json'));
    let release; f.accounts.stopAccount = () => new Promise(resolve => { release = resolve; });
    const removal = f.accounts.remove('a', { confirmId: 'a' }); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.accounts.uninstall('a'), { code: 'BUSY' }); await assert.rejects(f.accounts.start('a'), { code: 'BUSY' });
    release(); await removal;
});

test('deletion purge failure leaves a stopped recoverable transaction and explicit recovery finishes it', async t => {
    const f = fixture(t), a = f.account('a'); await f.accounts.start('a');
    const purge = f.accounts.purgeRemovalStage.bind(f.accounts);
    f.accounts.purgeRemovalStage = () => { throw Object.assign(new Error('test purge failure'), { code: 'EACCES' }); };
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'EACCES' });
    assert.equal(f.accounts.get('a').desired, 'stopped'); assert.equal(f.accounts.states.get('a'), 'delete_failed');
    const transaction = f.accounts.document.maintenance.a;
    assert.equal(transaction.operation, 'delete'); assert.equal(transaction.phase, 'purging');
    assert.equal(fs.existsSync(a.base), false);
    assert.equal(fs.readFileSync(path.join(f.root, transaction.stage, 'account/home/login.dat'), 'utf8'), 'login-a');
    await assert.rejects(f.accounts.start('a'), { code: 'BUSY' });
    f.accounts.purgeRemovalStage = purge;
    assert.deepEqual(await f.accounts.recoverMaintenance('a'), { id: 'a', deleted: true });
    assert.equal(fs.existsSync(path.join(f.root, transaction.stage)), false); assert.throws(() => f.accounts.get('a'), { code: 'NOT_FOUND' });
});

test('interrupted deletion is kept stopped after manager reconstruction and can finish without source data', async t => {
    const f = fixture(t); f.account('a');
    const persist = f.accounts.persist.bind(f.accounts); let failed = false;
    f.accounts.persist = () => {
        if (!failed && !f.accounts.document.profiles.some(item => item.id === 'a')) {
            failed = true; throw Object.assign(new Error('test registry failure'), { code: 'EIO' });
        }
        return persist();
    };
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'EIO' });
    const reloaded = new Accounts(f.root); t.after(() => reloaded.close());
    assert.equal(reloaded.get('a').desired, 'stopped'); assert.equal(reloaded.document.maintenance.a.operation, 'delete');
    await assert.rejects(reloaded.start('a'), { code: 'BUSY' });
    assert.deepEqual(await reloaded.recoverMaintenance('a'), { id: 'a', deleted: true });
});

test('registry persistence failure before deletion staging preserves the original directory and account', async t => {
    const f = fixture(t), a = f.account('a'); const persist = f.accounts.persist.bind(f.accounts); let failed = false;
    f.accounts.persist = () => {
        if (!failed && f.accounts.document.maintenance.a?.operation === 'delete') { failed = true; throw Object.assign(new Error('test registry failure'), { code: 'EIO' }); }
        return persist();
    };
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'EIO' });
    assert.equal(f.accounts.get('a').desired, 'stopped'); assert.equal(f.accounts.document.maintenance.a, undefined);
    assert.equal(fs.readFileSync(path.join(a.base, 'home/login.dat'), 'utf8'), 'login-a');
});

test('a deletion journal committed before a persistence error stays locked for explicit recovery', async t => {
    const f = fixture(t), a = f.account('a'); const persist = f.accounts.persist.bind(f.accounts); let failed = false;
    f.accounts.persist = () => {
        persist();
        if (!failed && f.accounts.document.maintenance.a?.operation === 'delete') { failed = true; throw Object.assign(new Error('test post-commit failure'), { code: 'EIO' }); }
    };
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'EIO' });
    assert.equal(f.accounts.document.maintenance.a.operation, 'delete');
    assert.equal(fs.existsSync(a.base), true);
    await assert.rejects(f.accounts.start('a'), { code: 'BUSY' });
    assert.deepEqual(await f.accounts.recoverMaintenance('a'), { id: 'a', deleted: true });
});

test('bridge registry failure rolls its entry back and keeps the account stopped', async t => {
    const f = fixture(t), a = f.account('a'); const persist = f.accounts.persist.bind(f.accounts); let failed = false;
    f.accounts.persist = () => {
        if (!failed && f.accounts.get('a').bridgeInstalled === false) { failed = true; throw Object.assign(new Error('test registry failure'), { code: 'EIO' }); }
        return persist();
    };
    await assert.rejects(f.accounts.uninstall('a'), { code: 'EIO' });
    assert.equal(f.accounts.get('a').bridgeInstalled, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(a.app, 'package.json'))).main, 'freshwater-entry.cjs');
    assert.equal(f.accounts.processes.size, 0);
});

test('account path and staging junctions are rejected without following another account', async t => {
    const f = fixture(t), a = f.account('a'), b = f.account('b');
    const original = path.join(f.root, 'work/control/preserved-a'); fs.renameSync(a.base, original);
    try { fs.symlinkSync(b.base, a.base, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { fs.renameSync(original, a.base); if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'UNSAFE_ACCOUNT_PATH' });
    await assert.rejects(f.accounts.uninstall('a'), { code: 'UNSAFE_ACCOUNT_PATH' });
    assert.equal(fs.readFileSync(path.join(b.base, 'home/login.dat'), 'utf8'), 'login-b');
    fs.unlinkSync(a.base); fs.renameSync(original, a.base);
    fs.symlinkSync(b.base, path.join(f.accounts.control, 'deletions'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.accounts.remove('a', { confirmId: 'a' }), { code: 'UNSAFE_ACCOUNT_PATH' });
    fs.unlinkSync(path.join(f.accounts.control, 'deletions'));
});

test('recursive deletion unlinks nested directory links without touching their account targets', async t => {
    const f = fixture(t), a = f.account('a'), b = f.account('b');
    try { fs.symlinkSync(b.base, path.join(a.base, 'home/linked-peer'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Directory links unavailable'); return; } throw error; }
    await f.accounts.remove('a', { confirmId: 'a' });
    assert.equal(fs.readFileSync(path.join(b.base, 'home/login.dat'), 'utf8'), 'login-b');
    assert.equal(fs.readFileSync(path.join(b.base, 'data/1000000001.json'), 'utf8'), 'message-mapping-b');
});
