'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { Auth } = require('../src/manager/auth.cjs');
const { Accounts } = require('../src/manager/accounts.cjs');
const { Backups, encode, decode, validateArchive, ordinaryMapping } = require('../src/manager/backups.cjs');
const { atomic } = require('../src/manager/files.cjs');
const { createManager } = require('../src/manager/server.cjs');
const { inspect } = require('../src/manager/ownership.cjs');
const mapping = nextId => JSON.stringify({ version: 1, account: '2068886823', nextId, entries: [] });

function temporary(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function fakeAccounts(t) {
    const root = temporary(t); let pid = 100;
    const children = [];
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 31, total: 2 ** 32 }), spawnAccount: options => {
        const child = new EventEmitter(); child.pid = pid++; child.env = options.env;
        child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; }; children.push(child); return child;
    } });
    accounts.customPlatform = true; t.after(() => accounts.close());
    return { root, accounts, children };
}

test('administrator initialization is private, one-time and session revocation closes streams', async t => {
    const root = temporary(t), auth = new Auth(root);
    const setupToken = fs.readFileSync(auth.setup, 'utf8').trim();
    await assert.rejects(auth.bootstrap('wrong', 'long-test-password', 'a'), { code: 'AUTH_FAILED' });
    const session = await auth.bootstrap(setupToken, 'long-test-password', 'a');
    assert.equal(fs.existsSync(auth.setup), false);
    assert.equal(auth.session(auth.cookie(session.id, false)), session);
    let ended = false; session.streams.add({ end() { ended = true; } });
    await auth.change('long-test-password', 'replacement-password');
    assert.equal(ended, true); assert.equal(auth.session(auth.cookie(session.id, false)), null);
    await assert.rejects(auth.login('long-test-password', 'b'), { code: 'AUTH_FAILED' });
    assert.ok((await auth.login('replacement-password', 'b')).csrf);
    assert.throws(() => auth.require({ headers: { cookie: auth.cookie('absent', false) } }), { code: 'AUTH_REQUIRED' });
});

test('corrupt authentication fails closed and never reopens administrator registration', t => {
    const root = temporary(t); atomic(path.join(root, 'admin.json'), { version: 99 });
    assert.throws(() => new Auth(root), { code: 'AUTH_CORRUPT' });
    assert.equal(fs.existsSync(path.join(root, 'setup-token.txt')), false);
});

test('a deleted administrator file never reopens setup after durable initialization', async t => {
    const root = temporary(t), auth = new Auth(root);
    await auth.bootstrap(fs.readFileSync(auth.setup, 'utf8').trim(), 'administrator-password', 'local');
    assert.equal(fs.existsSync(auth.initialized), true);
    fs.unlinkSync(auth.file);
    assert.throws(() => new Auth(root), { code: 'AUTH_CORRUPT' });
    assert.equal(fs.existsSync(auth.setup), false);
});

test('account updates own the full stop-save-start operation and cannot race public start/stop', async t => {
    const { accounts, children } = fakeAccounts(t);
    accounts.create({ id: 'a' }); await accounts.start('a');
    let signalled;
    children[0].kill = signal => { signalled = signal; return true; };
    const update = accounts.update('a', { label: 'new label' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signalled, 'SIGTERM');
    await assert.rejects(accounts.start('a'), { code: 'BUSY' });
    await assert.rejects(accounts.stop('a'), { code: 'BUSY' });
    children[0].emit('exit', 0);
    assert.equal((await update).applied, true);
    assert.equal(children.length, 2);
    assert.equal(accounts.get('a').label, 'new label');
    assert.equal(accounts.retryTimers.size, 0);
    assert.equal(accounts.retries.size, 0);
});

test('manager revokes an existing grant when the worker health becomes corrupt or future dated', async t => {
    const { root, accounts } = fakeAccounts(t); accounts.create({ id: 'a' }); await accounts.start('a');
    const state = path.join(root, 'work/accounts/a/state'), grant = path.join(state, 'authorization.json');
    atomic(path.join(state, 'health.json'), { at: Date.now(), selfId: '2068886823', sessionEpoch: 'first', ready: true });
    accounts.poll(); assert.equal(fs.existsSync(grant), true);
    fs.writeFileSync(path.join(state, 'health.json'), 'invalid');
    accounts.poll(); assert.equal(fs.existsSync(grant), false);
    atomic(path.join(state, 'health.json'), { at: Date.now() + 60000, selfId: '2068886823', sessionEpoch: 'first', ready: true });
    accounts.poll(); assert.equal(fs.existsSync(grant), false);
});

test('process ledger validation refuses reused group identities and unrelated members', t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'state'));
    atomic(path.join(root, 'state/processes.json'), { version: 1, accountRoot: root, ownerPid: 101, ownerStartTime: '100', groups: [{ pid: 201, startTime: '200' }] });
    const table = new Map([[101, { pid: 101, group: 101, startTime: '100' }], [201, { pid: 201, group: 201, startTime: '200' }]]);
    const options = { table: () => table, environ: () => ['FWD_ACCOUNT_ROOT=' + root] };
    assert.deepEqual(inspect(root, options).groups, [201]);
    table.get(201).startTime = '999';
    assert.throws(() => inspect(root, options), { code: 'PROCESS_OWNERSHIP' });
    table.delete(201); table.set(202, { pid: 202, group: 201, startTime: '201' });
    assert.throws(() => inspect(root, { ...options, environ: pid => pid === 202 ? ['FWD_ACCOUNT_ROOT=other'] : ['FWD_ACCOUNT_ROOT=' + root] }), { code: 'PROCESS_OWNERSHIP' });
});

test('account gates isolate directories, reject duplicate identities and revoke on stop', async t => {
    const { root, accounts, children } = fakeAccounts(t);
    accounts.create({ id: 'alpha', expectedUin: '2068886823' });
    accounts.create({ id: 'beta', expectedUin: '2441760163' });
    await accounts.start('alpha'); await accounts.start('beta');
    assert.notEqual(children[0].env.FWD_RPC_DIR, children[1].env.FWD_RPC_DIR);
    for (const [id, uin] of [['alpha', '2068886823'], ['beta', '2441760163']]) atomic(path.join(root, 'work/accounts', id, 'state/health.json'), {
        at: Date.now(), selfId: uin, sessionEpoch: id + '-epoch', ready: true, online: true, gatewayPort: 12345
    });
    accounts.poll();
    const grantA = path.join(root, 'work/accounts/alpha/state/authorization.json');
    const grantB = path.join(root, 'work/accounts/beta/state/authorization.json');
    assert.equal(JSON.parse(fs.readFileSync(grantA)).uin, '2068886823');
    assert.ok(JSON.parse(fs.readFileSync(grantA)).managementToken.length >= 32);
    await accounts.stop('alpha'); assert.equal(fs.existsSync(grantA), false); assert.equal(fs.existsSync(grantB), true);
    assert.equal(accounts.states.get('beta'), 'online');
});

test('unknown duplicate QQ cannot both receive authorization, wrong expected QQ stays blocked', async t => {
    const { root, accounts } = fakeAccounts(t);
    accounts.create({ id: 'a' }); accounts.create({ id: 'b' });
    await accounts.start('a'); await accounts.start('b');
    for (const id of ['a', 'b']) atomic(path.join(root, 'work/accounts', id, 'state/health.json'), {
        at: Date.now(), selfId: '2068886823', sessionEpoch: id, ready: true, online: true
    });
    accounts.poll();
    assert.equal(accounts.states.get('a'), 'online'); assert.equal(accounts.states.get('b'), 'duplicate_account');
    assert.equal(fs.existsSync(path.join(root, 'work/accounts/b/state/authorization.json')), false);
});

test('node configuration redacts secrets and preserves a token omitted by the UI', async t => {
    const { accounts } = fakeAccounts(t);
    const created = accounts.create({ id: 'a', nodes: [{ id: 'listener', type: 'httpApi', token: 'private-token' }] });
    assert.equal(created.nodes[0].token, undefined); assert.equal(created.nodes[0].tokenPresent, true);
    await accounts.update('a', { nodes: [{ id: 'listener', type: 'httpApi', enabled: true }] });
    assert.equal(accounts.get('a').nodes[0].token, 'private-token');
    assert.throws(() => accounts.create({ id: 'b', nodes: [{ id: 'public', type: 'wsServer' }] }), { code: 'TOKEN_REQUIRED' });
});

test('stop revokes authorization and waits for an active kernel operation before terminating QQ', async t => {
    const { root, accounts, children } = fakeAccounts(t);
    accounts.create({ id: 'a' }); await accounts.start('a');
    const health = path.join(root, 'work/accounts/a/state/health.json');
    atomic(health, { at: Date.now(), activeActions: 1 });
    let signaled = false;
    const oldKill = children[0].kill;
    children[0].kill = signal => { signaled = true; return oldKill(signal); };
    const stopping = accounts.stop('a');
    while (accounts.states.get('a') !== 'stopping') await new Promise(resolve => setImmediate(resolve));
    assert.equal(signaled, false);
    atomic(health, { at: Date.now(), activeActions: 0 });
    await stopping;
    assert.equal(signaled, true); assert.equal(accounts.processes.has('a'), false);
});

test('encrypted backups authenticate before parsing, reject damage and exclude administrator state', async t => {
    const { root, accounts } = fakeAccounts(t); accounts.create({ id: 'a', nodes: [{ id: 'bot', type: 'wsClient', url: 'ws://127.0.0.1:17700/ws', token: 'node-token' }] });
    const base = accounts.location('a'); fs.mkdirSync(path.join(base, 'home'), { recursive: true });
    fs.writeFileSync(path.join(base, 'home/login.dat'), 'private-login-state');
    const backups = new Backups(root, accounts);
    const backup = await backups.create({ profileIds: ['a'], kind: 'full', password: 'backup-test-password' });
    const bytes = fs.readFileSync(backups.file(backup.id));
    assert.equal(bytes.includes(Buffer.from('private-login-state')), false);
    await assert.rejects(decode(bytes, 'wrong-password'), { code: 'INVALID_PASSWORD' });
    const damaged = Buffer.from(bytes); damaged[damaged.length - 1] ^= 1;
    await assert.rejects(decode(damaged, 'backup-test-password'), { code: 'INVALID_PASSWORD' });
    const preview = await backups.preview({ backupId: backup.id, password: 'backup-test-password' });
    fs.writeFileSync(path.join(base, 'home/login.dat'), 'changed');
    const result = await backups.apply(preview.previewId);
    assert.deepEqual(result, { restored: ['a'], started: false });
    assert.equal(fs.readFileSync(path.join(base, 'home/login.dat'), 'utf8'), 'private-login-state');
    assert.equal(accounts.get('a').nodes[0].token, 'node-token');
    assert.equal(accounts.get('a').desired, 'stopped');
});

test('ordinary backups strip login state and tokens and keep restored connections disabled', async t => {
    const { root, accounts } = fakeAccounts(t); accounts.create({ id: 'a', nodes: [{ id: 'bot', type: 'wsClient', url: 'ws://127.0.0.1:17700/ws', token: 'node-token' }] });
    const base = accounts.location('a');
    fs.mkdirSync(path.join(base, 'data'), { recursive: true }); fs.mkdirSync(path.join(base, 'home'), { recursive: true });
    fs.writeFileSync(path.join(base, 'data/2068886823.json'), mapping(42)); fs.writeFileSync(path.join(base, 'home/login.dat'), 'ticket');
    const backups = new Backups(root, accounts), backup = await backups.create({ profileIds: ['a'] });
    const document = await decode(fs.readFileSync(backups.file(backup.id)));
    assert.equal(document.profiles[0].entries.length, 1); assert.equal(document.profiles[0].config.nodes[0].token, undefined);
    const preview = await backups.preview({ backupId: backup.id }); await backups.apply(preview.previewId);
    assert.equal(accounts.get('a').nodes[0].enabled, false); assert.equal(accounts.get('a').nodes[0].token, '');
    assert.equal(fs.existsSync(path.join(base, 'home/login.dat')), false);
    assert.equal(fs.readFileSync(path.join(base, 'data/2068886823.json'), 'utf8'), mapping(42));
});

test('ordinary mappings preserve stable locators and dedup flags while stripping every cached message body', () => {
    const locator = { peer: { chatType: 1, peerUid: 'u_friend' }, nativeId: '90071992547409931234', seq: '3', clientSeq: '4', senderUin: '2441760163' };
    const stored = { version: 1, account: '2068886823', nextId: 2, entries: [{ id: 1, locator, emitted: true,
        recalled: true, recallEmitted: false, record: { text: 'private body' }, event: { raw_message: 'private body' }, recallEvent: { secret: 'private body' } }] };
    const bytes = ordinaryMapping(Buffer.from(JSON.stringify(stored)), '2068886823', { strip: true });
    assert.equal(bytes.includes(Buffer.from('private body')), false);
    assert.deepEqual(JSON.parse(bytes).entries[0], { id: 1, locator, emitted: true, recalled: true, recallEmitted: false });
    assert.doesNotThrow(() => ordinaryMapping(bytes, '2068886823'));
    assert.throws(() => ordinaryMapping(Buffer.from(JSON.stringify(stored)), '2068886823'), { code: 'INVALID_BACKUP' });
    assert.throws(() => ordinaryMapping(bytes, '2441760163'), { code: 'INVALID_BACKUP' });
    const duplicate = JSON.parse(bytes); duplicate.entries.push(duplicate.entries[0]);
    assert.throws(() => ordinaryMapping(Buffer.from(JSON.stringify(duplicate)), '2068886823'), { code: 'INVALID_BACKUP' });
});

test('ordinary backup waits for the writer to stop and captures its final persisted message mapping', async t => {
    const { root, accounts, children } = fakeAccounts(t);
    accounts.create({ id: 'a' }); await accounts.start('a');
    const data = path.join(accounts.location('a'), 'data/2068886823.json');
    fs.writeFileSync(data, mapping(1));
    const originalKill = children[0].kill;
    children[0].kill = signal => { fs.writeFileSync(data, mapping(2)); return originalKill(signal); };
    const backups = new Backups(root, accounts), backup = await backups.create({ profileIds: ['a'] });
    const document = await decode(fs.readFileSync(backups.file(backup.id)));
    assert.equal(Buffer.from(document.profiles[0].entries[0].data, 'base64').toString(), mapping(2));
    assert.equal(accounts.processes.has('a'), true);
});

test('failed backup acquisition never changes another existing maintenance operation', async t => {
    const { root, accounts } = fakeAccounts(t); accounts.create({ id: 'a' });
    accounts.document.maintenance.a = { operation: 'restore', phase: 'needs_repair', at: 1 }; accounts.persist();
    const backups = new Backups(root, accounts);
    await assert.rejects(backups.create({ profileIds: ['a'] }), { code: 'BUSY' });
    assert.equal(accounts.document.maintenance.a.phase, 'needs_repair');
    assert.equal(backups.locked, false);
});

test('restore journal blocks restart and retains rollback state while prior writer ownership is unresolved', async t => {
    const { root, accounts } = fakeAccounts(t); accounts.create({ id: 'a' });
    const stage = 'work/temp/restore-' + 'a'.repeat(32); fs.mkdirSync(path.join(root, stage), { recursive: true });
    const journal = path.join(root, 'work/control/restore-journal.json');
    atomic(journal, { version: 1, phase: 'staging', stage, ids: ['a'], swaps: [], previous: { profiles: [structuredClone(accounts.get('a'))] } });
    accounts.processes.set('a', {});
    const backups = new Backups(root, accounts);
    assert.equal(backups.recoveryError, 'RESTORE_RECOVERY_REQUIRED');
    await assert.rejects(accounts.start('a'), { code: 'MAINTENANCE' });
    assert.equal(fs.existsSync(journal), true); assert.equal(fs.existsSync(path.join(root, stage)), true);
    accounts.processes.delete('a'); backups.ensureRecovered();
    assert.equal(fs.existsSync(journal), false);
    assert.equal(accounts.get('a').desired, 'stopped');
});

test('restore survives actual process crashes between renames and registry writes and rolls back at startup', async t => {
    for (const checkpoint of ['after_old_rename', 'after_new_rename', 'after_registry_persist']) {
        const root = temporary(t), accounts = new Accounts(root);
        accounts.create({ id: 'a', label: 'original' });
        fs.mkdirSync(path.join(accounts.location('a'), 'data'), { recursive: true });
        const mapping = path.join(accounts.location('a'), 'data/2068886823.json');
        fs.writeFileSync(mapping, JSON.stringify({ version: 1, account: '2068886823', nextId: 10, entries: [] }));
        const backups = new Backups(root, accounts), backup = await backups.create({ profileIds: ['a'] });
        fs.writeFileSync(mapping, JSON.stringify({ version: 1, account: '2068886823', nextId: 20, entries: [] }));
        const script = `const {Accounts}=require(process.argv[1]);const {Backups}=require(process.argv[2]);(async()=>{const a=new Accounts(process.argv[3]);const b=new Backups(process.argv[3],a,{checkpoint:n=>{if(n===process.argv[5])process.exit(77)}});const p=await b.preview({backupId:process.argv[4]});await b.apply(p.previewId)})().catch(()=>process.exit(78));`;
        const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/manager/accounts.cjs'), require.resolve('../src/manager/backups.cjs'), root, backup.id, checkpoint],
            { cwd: root, env: { ...process.env, TEMP: path.resolve(__dirname, '../work/temp'), TMP: path.resolve(__dirname, '../work/temp'), TMPDIR: path.resolve(__dirname, '../work/temp') }, encoding: 'utf8' });
        assert.equal(child.status, 77, checkpoint + ': ' + child.stderr);
        assert.equal(fs.existsSync(backups.journalFile), true);
        const restartedAccounts = new Accounts(root), restarted = new Backups(root, restartedAccounts);
        assert.equal(restarted.recoveryError, null);
        assert.equal(fs.existsSync(backups.journalFile), false);
        assert.equal(JSON.parse(fs.readFileSync(mapping, 'utf8')).nextId, 20, checkpoint);
        assert.equal(restartedAccounts.get('a').label, 'original');
        assert.equal(restartedAccounts.get('a').desired, 'stopped');
        assert.equal(restartedAccounts.document.maintenance.a.phase, 'rolled_back');
    }
});

test('a committed restore survives a crash without rolling back its new state', async t => {
    const root = temporary(t), accounts = new Accounts(root); accounts.create({ id: 'a' });
    fs.mkdirSync(path.join(accounts.location('a'), 'data'), { recursive: true });
    const mapping = path.join(accounts.location('a'), 'data/2068886823.json'); fs.writeFileSync(mapping, JSON.stringify({ version: 1, account: '2068886823', nextId: 10, entries: [] }));
    const backups = new Backups(root, accounts), backup = await backups.create({ profileIds: ['a'] });
    fs.writeFileSync(mapping, JSON.stringify({ version: 1, account: '2068886823', nextId: 20, entries: [] }));
    const script = `const {Accounts}=require(process.argv[1]);const {Backups}=require(process.argv[2]);(async()=>{const a=new Accounts(process.argv[3]);const b=new Backups(process.argv[3],a,{checkpoint:n=>{if(n==='after_commit')process.exit(77)}});const p=await b.preview({backupId:process.argv[4]});await b.apply(p.previewId)})().catch(()=>process.exit(78));`;
    const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/manager/accounts.cjs'), require.resolve('../src/manager/backups.cjs'), root, backup.id], { cwd: root, encoding: 'utf8' });
    assert.equal(child.status, 77, child.stderr);
    const restartedAccounts = new Accounts(root), restarted = new Backups(root, restartedAccounts);
    assert.equal(restarted.recoveryError, null);
    assert.equal(JSON.parse(fs.readFileSync(mapping, 'utf8')).nextId, 10);
    assert.equal(fs.existsSync(backups.journalFile), false);
});

test('restore rejects traversal, duplicate paths, non-state roots and version mismatches', () => {
    const document = { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind: 'full', profiles: [{ config: { id: 'a', nodes: [] }, entries: [] }] };
    for (const name of ['home/../escape', '/etc/passwd', 'home\\escape', 'qq-root/app', 'home//escape']) {
        const candidate = structuredClone(document); candidate.profiles[0].entries.push({ name, data: '', size: 0, sha256: 'bad' });
        assert.throws(() => validateArchive(candidate), { code: 'INVALID_BACKUP' });
    }
    const candidate = structuredClone(document); candidate.qqVersion = 'unknown';
    assert.throws(() => validateArchive(candidate), { code: 'INVALID_BACKUP' });
});

test('management HTTP requires bootstrap, cookie and CSRF; public OneBot does not inherit administrator permission', async t => {
    const { root, accounts } = fakeAccounts(t);
    const manager = await createManager({ root, accounts, startAccounts: false }); t.after(() => manager.close());
    const app = manager.app;
    assert.equal((await app.inject('/api/overview')).statusCode, 401);
    const token = fs.readFileSync(manager.auth.setup, 'utf8').trim();
    const initialized = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { setupToken: token, password: 'administrator-password' } });
    assert.equal(initialized.statusCode, 200);
    const cookie = initialized.headers['set-cookie'].split(';')[0], csrf = initialized.json().data.csrf;
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: { id: 'no-csrf' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://foreign.invalid' }, payload: { id: 'wrong-origin' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie, 'x-csrf-token': csrf }, payload: { id: 'a' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/accounts', headers: { cookie } })).json().data[0].id, 'a');
    assert.equal((await app.inject({ url: '/onebot/unknown/unknown/get_status', headers: { cookie } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/unknown', headers: { cookie } })).statusCode, 404);
});

test('global service settings support isolated partial patches and save only fully valid updates', async t => {
    const { root, accounts } = fakeAccounts(t);
    const manager = await createManager({ root, accounts, startAccounts: false }); t.after(() => manager.close());
    const initialized = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'administrator-password'
    } });
    const headers = { cookie: initialized.headers['set-cookie'].split(';')[0], 'x-csrf-token': initialized.json().data.csrf };
    const initial = (await manager.app.inject({ url: '/api/settings', headers })).json().data;
    assert.deepEqual(initial.rkey, { fallbackServers: [] }); assert.equal(initial.musicSignUrl, '');
    const patch = payload => manager.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload });
    const saved = await patch({ rkey: { fallbackServers: ['https://rkey.example/api?key=secret'] }, musicSignUrl: 'https://sign.example/card' });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().data.needsRestart, false);
    const file = path.join(root, 'work/control/settings.json'), before = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(before).musicSignUrl, 'https://sign.example/card');
    for (const payload of [{ maxAccounts: 3, musicSignUrl: 'file:///secret' }, { maxAccounts: 3, unknown: 'invalid' }, { publicBaseUrl: 'https://manager.example', rkey: { fallbackServers: ['https://user:pass@rkey.example/'] } }]) {
        assert.equal((await patch(payload)).statusCode, 400);
        assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(accounts.maxAccounts, 2);
    }
    assert.equal((await patch({ maxAccounts: 3 })).statusCode, 200);
    const after = (await manager.app.inject({ url: '/api/settings', headers })).json().data;
    assert.equal(after.maxAccounts, 3); assert.equal(after.musicSignUrl, 'https://sign.example/card');
    assert.deepEqual(after.rkey, { fallbackServers: ['https://rkey.example/api?key=secret'] });
    assert.equal((await patch({ rkey: { fallbackServers: [] }, musicSignUrl: '' })).statusCode, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).rkey, { fallbackServers: [] });
    const secret = await patch({ musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark', musicSignKey: 'private-test-api-key' });
    assert.equal(secret.statusCode, 200); assert.equal(secret.json().data.hasMusicSignKey, true);
    assert.equal(secret.body.includes('private-test-api-key'), false); assert.equal(Object.hasOwn(secret.json().data, 'musicSignKey'), false);
    const exposed = await manager.app.inject({ url: '/api/settings', headers });
    assert.equal(exposed.body.includes('private-test-api-key'), false); assert.equal(exposed.json().data.hasMusicSignKey, true);
    await patch({ musicSignKey: '' }); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).musicSignKey, 'private-test-api-key');
    const privateBefore = fs.readFileSync(file, 'utf8');
    assert.equal((await patch({ musicSignUrl: 'https://other-sign.example/card' })).statusCode, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), privateBefore);
    assert.equal((await patch({ clearMusicSignKey: true, musicSignKey: 'conflict' })).statusCode, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), privateBefore);
    assert.equal((await patch({ clearMusicSignKey: true })).json().data.hasMusicSignKey, false);
    const queryKey = await patch({ musicSignUrl: 'https://selected.example/sign?key=query-private-test-key' });
    assert.equal(queryKey.statusCode, 200); assert.equal(queryKey.json().data.hasMusicSignKey, true);
    assert.equal(queryKey.body.includes('query-private-test-key'), false);
    assert.equal(queryKey.json().data.musicSignUrl, 'https://selected.example/sign');
});

test('public proxy has only validated OneBot action routes and strips administrator cookies', async t => {
    const { root, accounts } = fakeAccounts(t);
    accounts.create({ id: 'a', nodes: [{ id: 'http', type: 'httpApi', token: 'public-token' }, { id: 'socket', type: 'wsServer', token: 'socket-token' }] });
    const forwarded = [];
    const upstream = http.createServer((request, response) => {
        forwarded.push({ url: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization });
        response.setHeader('Content-Type', 'application/json'); response.end('{"status":"ok","retcode":0,"data":null}');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    accounts.gateway = () => upstream.address().port;
    const manager = await createManager({ root, accounts, startAccounts: false });
    t.after(async () => { await manager.close(); await new Promise(resolve => upstream.close(resolve)); });
    const result = await manager.app.inject({ url: '/onebot/a/http/get_status?echo=false', headers: { cookie: 'fwd_session=administrator', authorization: 'Bearer public-token' } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(forwarded[0], { url: '/onebot/a/http/get_status?echo=false', cookie: undefined, authorization: 'Bearer public-token' });
    for (const url of ['/onebot/a/http/..%2f..%2finternal%2faction', '/onebot/a/http/%252e%252e%252finternal', '/onebot/a/socket/get_status', '/onebot/a/http/https:%2f%2fevil.invalid']) {
        assert.ok((await manager.app.inject({ url })).statusCode >= 400, url);
    }
    assert.equal(forwarded.length, 1);
});

test('only one manager can own the same control directory and closing releases ownership', async t => {
    const { root, accounts } = fakeAccounts(t);
    const first = await createManager({ root, accounts, startAccounts: false });
    try { await assert.rejects(createManager({ root, accounts, startAccounts: false }), { code: 'BUSY' }); }
    finally { await first.close(); }
    const next = await createManager({ root, accounts: new Accounts(root), startAccounts: false });
    await next.close();
});
