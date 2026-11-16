'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Accounts } = require('../src/manager/accounts.cjs');
const { ManagerLifecycle, LifecycleClient } = require('../src/manager/lifecycle.cjs');
const { atomic } = require('../src/manager/files.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { TransportHub } = require('../src/onebot/transports.cjs');
const { nodeConfig } = require('../src/config.cjs');
const scratch = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(scratch, { recursive: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate()); }
async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(scratch, 'lifecycle-')), children = [], intents = []; let pid = 100;
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 31, total: 2 ** 32 }), spawnAccount: () => {
        const child = new EventEmitter(); child.pid = pid++; child.signals = [];
        child.kill = signal => { child.signals.push(signal); intents.push(accounts.get('a').desired); queueMicrotask(() => child.emit('exit', 0)); return true; };
        children.push(child); return child;
    } });
    accounts.customPlatform = true;
    const lifecycle = await new ManagerLifecycle(root, accounts, options).open();
    t.after(async () => { await lifecycle.close(); await accounts.close(); fs.rmSync(root, { recursive: true, force: true }); });
    for (const [id, uin] of [['a', '1000000001'], ['b', '2000000002']]) {
        accounts.create({ id, expectedUin: uin }); await accounts.start(id);
        atomic(path.join(accounts.location(id), 'state/health.json'), { at: Date.now(), ready: true, online: true, selfId: uin, sessionEpoch: id + '-epoch' });
    }
    accounts.poll();
    const client = new LifecycleClient({ root, profileId: 'a', authorizationFile: path.join(accounts.location('a'), 'state/authorization.json'), endpointFile: lifecycle.file });
    const state = { self: { uin: '1000000001' }, epoch: 'a-epoch' };
    return { root, accounts, lifecycle, client, state, children, intents };
}

test('lifecycle reserves the existing account lock and cancellation never changes durable intent', async t => {
    const f = await fixture(t), receipt = await f.client.prepare(f.state, 'stop');
    assert.equal(f.accounts.busy.has('a'), true); assert.equal(f.accounts.get('a').desired, 'running');
    assert.equal(f.children[0].signals.length, 0);
    await assert.rejects(f.accounts.stop('a'), { code: 'BUSY' });
    await assert.rejects(f.client.prepare(f.state, 'restart'), { code: 'BUSY' });
    await receipt.complete(false); await until(() => !f.accounts.busy.has('a'));
    assert.equal(f.accounts.get('a').desired, 'running'); assert.equal(f.children[0].signals.length, 0);
});

test('bot_exit persists stopped intent for only its account and never triggers manager respawn', async t => {
    const f = await fixture(t), receipt = await f.client.prepare(f.state, 'stop');
    await receipt.complete(true); await until(() => !f.accounts.busy.has('a'));
    assert.equal(f.accounts.get('a').desired, 'stopped'); assert.equal(f.accounts.processes.has('a'), false);
    assert.equal(f.accounts.processes.has('b'), true); assert.equal(f.accounts.get('b').desired, 'running');
    assert.deepEqual(f.children[0].signals, ['SIGTERM']); assert.equal(f.children[1].signals.length, 0);
    assert.equal(f.accounts.retryTimers.has('a'), false);
    const disk = JSON.parse(fs.readFileSync(f.accounts.file, 'utf8'));
    assert.equal(disk.profiles.find(row => row.id === 'a').desired, 'stopped');
    await receipt.complete(true); assert.equal(f.children.length, 2);
});

test('set_restart preserves running intent through owned stop and replacement start', async t => {
    const f = await fixture(t), history = [], commit = f.accounts.commitProfile.bind(f.accounts);
    f.accounts.commitProfile = (id, value, ...rest) => { if (id === 'a' && Object.hasOwn(value, 'desired')) history.push(value.desired); return commit(id, value, ...rest); };
    const old = f.accounts.processes.get('a'), receipt = await f.client.prepare(f.state, 'restart');
    await receipt.complete(true); await until(() => !f.accounts.busy.has('a'));
    assert.equal(f.children.length, 3); assert.notEqual(f.accounts.processes.get('a'), old);
    assert.equal(f.accounts.get('a').desired, 'running'); assert.deepEqual(history, ['running', 'running']);
    assert.deepEqual(f.intents, ['running']); assert.equal(f.accounts.processes.has('b'), true);
});

test('a stale epoch, changed token or replacement child cannot commit its reservation', async t => {
    const f = await fixture(t), receipt = await f.client.prepare(f.state, 'stop');
    atomic(path.join(f.accounts.location('a'), 'state/health.json'), { at: Date.now(), ready: true, selfId: '1000000001', sessionEpoch: 'next-epoch' });
    f.accounts.poll();
    await assert.rejects(receipt.complete(true), { code: 'SESSION_CHANGED' }); await until(() => !f.accounts.busy.has('a'));
    assert.equal(f.children[0].signals.length, 0); assert.equal(f.accounts.get('a').desired, 'running');
    const next = await f.client.prepare({ ...f.state, epoch: 'next-epoch' }, 'restart');
    const old = f.accounts.processes.get('a'); f.accounts.processes.set('a', new EventEmitter());
    await assert.rejects(next.complete(true), { code: 'NOT_READY' }); await until(() => !f.accounts.busy.has('a'));
    f.accounts.processes.set('a', old); assert.equal(old.signals.length, 0);
});

test('expired reservations and conflicting manager operations release without executing', async t => {
    const f = await fixture(t, { reservationMs: 25 });
    let release; const busy = f.accounts.operate('a', () => new Promise(resolve => { release = resolve; })); await tick();
    await assert.rejects(f.client.prepare(f.state, 'stop'), { code: 'BUSY' });
    release(); await busy;
    const receipt = await f.client.prepare(f.state, 'stop'); await until(() => !f.accounts.busy.has('a'));
    await assert.rejects(receipt.complete(true), { code: 'NOT_FOUND' });
    assert.equal(f.accounts.get('a').desired, 'running'); assert.equal(f.children[0].signals.length, 0);
});

test('failed durable intent refuses execution and leaves the owned process alive', async t => {
    const f = await fixture(t), receipt = await f.client.prepare(f.state, 'stop'), commit = f.accounts.commitProfile;
    f.accounts.commitProfile = () => { throw Object.assign(new Error('write refused'), { code: 'EIO' }); };
    await assert.rejects(receipt.complete(true), { code: 'EIO' }); await until(() => !f.accounts.busy.has('a'));
    f.accounts.commitProfile = commit;
    assert.equal(f.children[0].signals.length, 0); assert.equal(f.accounts.get('a').desired, 'running');
});

test('the loopback protocol rejects public origins, wrong instance, path selectors and arbitrary operations', async t => {
    const f = await fixture(t), endpoint = JSON.parse(fs.readFileSync(f.lifecycle.file)), grant = JSON.parse(fs.readFileSync(f.client.authorizationFile));
    assert.equal(f.lifecycle.server.address().address, '127.0.0.1');
    const base = { phase: 'prepare', instance: endpoint.instance, profileId: 'a', uin: f.state.self.uin, epoch: f.state.epoch, operation: 'stop' };
    for (const value of [{ ...base, instance: '0'.repeat(48) }, { ...base, operation: 'kill' }, { ...base, profileId: '../b' }, { ...base, command: 'anything' }]) {
        const response = await fetch('http://127.0.0.1:' + endpoint.port + '/lifecycle', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + grant.managementToken }, body: JSON.stringify(value) });
        assert.equal(response.ok, false);
    }
    const origin = await fetch('http://127.0.0.1:' + endpoint.port + '/lifecycle', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid', authorization: 'Bearer ' + grant.managementToken }, body: JSON.stringify(base) });
    assert.equal(origin.status, 401); assert.equal(f.accounts.busy.has('a'), false); assert.equal(f.children[0].signals.length, 0);
});

test('actual service and HTTP transport send bot_exit success before the manager revokes and stops the account', async t => {
    const f = await fixture(t), order = [], current = { ...f.state, self: { ...f.state.self, uid: 'u_self' }, ready: true, online: true, capabilities: {} };
    const service = new OneBotService({ store: {}, lifecycleClient: f.client, backend: { call: async method => {
        assert.equal(method, 'status'); return structuredClone(current);
    } }, authorizeSession: () => fs.existsSync(f.client.authorizationFile) });
    const direct = await service.action({ action: 'bot_exit' }); assert.equal(direct.retcode, 1404); assert.equal(f.accounts.busy.has('a'), false);
    const hub = new TransportHub({ config: { profileId: 'a', gatewayPort: 0, nodes: [nodeConfig({ id: 'http', type: 'httpApi', token: 'node-secret' }, 0)] },
        status: () => current, authorization: () => fs.existsSync(f.client.authorizationFile), action: (request, session, options) => service.action(request, { selfUin: session.uin, epoch: session.epoch }, options) });
    await hub.open(); hub.start(f.state.self.uin, f.state.epoch); t.after(() => hub.close());
    hub.server.prependListener('request', (_request, response) => response.once('finish', () => order.push('response-finished')));
    const kill = f.children[0].kill; f.children[0].kill = signal => { order.push('stop'); return kill(signal); };
    const response = await fetch('http://127.0.0.1:' + hub.port + '/onebot/a/http/bot_exit', { headers: { authorization: 'Bearer node-secret' } });
    assert.deepEqual(await response.json(), { status: 'ok', retcode: 0, data: null });
    await until(() => !f.accounts.processes.has('a')); assert.deepEqual(order, ['response-finished', 'stop']); assert.equal(f.accounts.get('a').desired, 'stopped');
    assert.equal(f.accounts.processes.has('b'), true);
});

test('manager lifecycle close cancels response reservations and does not start a replacement while shutting down', async t => {
    const f = await fixture(t), receipt = await f.client.prepare(f.state, 'restart'), old = f.children[0];
    old.kill = signal => { old.signals.push(signal); return true; };
    await receipt.complete(true); await until(() => old.signals.length === 1);
    const closing = f.lifecycle.close(); old.emit('exit', 0); await closing;
    assert.equal(f.accounts.busy.has('a'), false); assert.equal(f.children.length, 2); assert.equal(f.accounts.get('a').desired, 'running');
    assert.equal(fs.existsSync(f.lifecycle.file), false);
    const g = await fixture(t); await g.client.prepare(g.state, 'stop'); await g.lifecycle.close();
    assert.equal(g.accounts.busy.has('a'), false); assert.equal(g.accounts.get('a').desired, 'running'); assert.equal(g.children[0].signals.length, 0);
});
