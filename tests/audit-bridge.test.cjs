'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');

async function until(check) {
    const deadline = Date.now() + 2000;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error('condition timed out');
        await new Promise(resolve => setImmediate(resolve));
    }
}

function captureFixture(t) {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: TARGET_VERSION });
    const calls = [];
    const group = {
        getGroupDetailInfo(groupId) { calls.push(groupId); return Promise.resolve({ result: 0 }); }
    };
    capture.ready = true;
    capture.self = { uin: '123', uid: 'u_123', nickname: 'Test' };
    capture.session = { getGroupService() { return group; } };
    t.after(() => capture.close());
    return { capture, calls, group };
}

for (const cancellation of ['abort', 'deadline']) {
    test(`a shared group query survives one caller's ${cancellation}`, async t => {
        // Establish both waiters before advancing either deadline. A real
        // 50ms timer can expire before setImmediate runs on a loaded runner,
        // making a transient waiters===2 condition impossible to observe.
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
        const { capture, calls } = captureFixture(t);
        const controller = new AbortController();
        const early = capture.call('groupInfo', { groupId: '200' }, { signal: controller.signal,
            expiresAt: Date.now() + (cancellation === 'deadline' ? 50 : 2000) });
        const earlyRejected = assert.rejects(early, error => ['EXPIRED', 'TIMEOUT'].includes(error.code));
        const late = capture.call('groupInfo', { groupId: '200' }, { expiresAt: Date.now() + 2000 });
        let lateSettled = false;
        late.then(() => { lateSettled = true; }, () => { lateSettled = true; });
        // The native dispatch and both coalesced waiter registrations are
        // microtasks; one real immediate drains them without consuming time.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls.length, 1);
        assert.equal(capture.queries.get('group:200')?.waiters, 2);
        if (cancellation === 'abort') controller.abort();
        else t.mock.timers.tick(50);
        await earlyRejected;
        assert.equal(lateSettled, false);
        assert.equal(capture.queries.get('group:200')?.waiters, 1);
        assert.equal(capture.bus.listenerCount('groupInfo'), 1);
        capture.bus.emit('groupInfo', { groupCode: '200', groupName: 'Still waiting' });
        assert.equal((await late).group_name, 'Still waiting');
        assert.equal(calls.length, 1);
        assert.equal(capture.queries.size, 0);
        assert.equal(capture.bus.listenerCount('groupInfo'), 0);
    });
}

test('the final shared query cancellation removes its callback and permits a fresh query', async t => {
    const { capture, calls } = captureFixture(t);
    const controller = new AbortController();
    const first = capture.call('groupInfo', { groupId: '200' }, { signal: controller.signal });
    first.catch(() => {});
    await until(() => calls.length === 1);
    controller.abort();
    await assert.rejects(first, { code: 'EXPIRED' });
    await until(() => capture.bus.listenerCount('groupInfo') === 0 && capture.queries.size === 0);
    const next = capture.call('groupInfo', { groupId: '200' });
    await until(() => calls.length === 2);
    capture.bus.emit('groupInfo', { groupCode: '200', groupName: 'Fresh' });
    assert.equal((await next).group_name, 'Fresh');
    assert.equal(capture.pending.size, 0);
});

test('session replacement retires every caller of a shared native query', async t => {
    const { capture, calls } = captureFixture(t);
    const first = capture.call('groupInfo', { groupId: '200' });
    const second = capture.call('groupInfo', { groupId: '200' });
    first.catch(() => {}); second.catch(() => {});
    await until(() => calls.length === 1);
    capture.resetSession(capture.session, { selfUin: '456', selfUid: 'u_456', clientVer: TARGET_VERSION });
    await assert.rejects(first, { code: 'SESSION_CHANGED' });
    await assert.rejects(second, { code: 'SESSION_CHANGED' });
    await until(() => capture.bus.listenerCount('groupInfo') === 0);
    assert.equal(capture.queries.size, 0);
    assert.equal(capture.pending.size, 0);
});

test('retired native listeners cannot revive when readiness recovers within the same session', t => {
    const { capture } = captureFixture(t);
    const callbacks = [];
    capture.session.getMsgService = () => ({
        addKernelMsgListener(value) { callbacks.push(value); return callbacks.length; },
        removeKernelMsgListener() {}
    });
    capture.attach();
    const old = callbacks[0], epoch = capture.epoch;
    const events = [];
    capture.on('event', event => { if (event.kind === 'message') events.push(event); });
    const record = { chatType: 2, peerUid: '200', senderUin: '456', senderUid: 'u_456', msgId: '99',
        elements: [{ elementType: 1, textElement: { content: 'one real callback' } }] };
    capture.withdrawReady(Object.assign(new Error('initialization withdrawn'), { code: 'NOT_READY' }));
    old.onRecvMsg([record]);
    assert.equal(events.length, 0);
    capture.ready = true;
    capture.attach();
    assert.equal(capture.epoch, epoch);
    old.onRecvMsg([record]);
    assert.equal(events.length, 0);
    callbacks[1].onRecvMsg([record]);
    assert.equal(events.length, 1);
});

test('friend category indexing preserves ordering and independent result objects', async t => {
    const { capture } = captureFixture(t);
    const categories = [
        { categoryId: 1, categroyName: 'First', buddyUids: ['u_100', 'u_100', 'u_200'] },
        { categoryId: 2, categoryName: 'Second', buddyUids: ['u_200', 'u_100'] },
        { categoryId: -1, categoryName: 'Invalid', buddyUids: ['u_100'] }
    ];
    capture.session.getBuddyService = () => ({ getBuddyListV2: async () => ({ result: 0, data: categories }) });
    capture.session.getProfileService = () => ({ getCoreAndBaseInfo: async () => new Map(['100', '200'].map(uin => [
        'u_' + uin, { uid: 'u_' + uin, uin, coreInfo: { nick: uin }, baseInfo: { categoryId: 2 } }
    ])) });
    const friends = await capture.call('friends');
    assert.deepEqual(friends.map(friend => friend.user_id), [100, 200]);
    for (const friend of friends) {
        assert.deepEqual(friend.categories, [{ id: 1, name: 'First' }, { id: 2, name: 'Second' }]);
        assert.equal(friend.category_name, 'Second');
    }
    friends[0].categories[0].name = 'Changed';
    assert.equal(friends[1].categories[0].name, 'First');
});

test('explicit UIN/UID pairs require native confirmation and cannot override a verified identity', async t => {
    const { capture } = captureFixture(t);
    let lookups = 0;
    capture.session.getProfileService = () => ({ getUidByUin(_source, values) {
        lookups++; return new Map(values.map(uin => [uin, 'u_' + uin]));
    } });
    await assert.rejects(capture.call('resolve', { uin: '456', uid: 'u_wrong' }), { code: 'INVALID_PARAMS' });
    assert.equal(capture.forward.get('456'), 'u_456');
    assert.equal(capture.reverse.has('u_wrong'), false);
    assert.deepEqual(await capture.call('resolve', { uin: '456', uid: 'u_456' }), { uin: '456', uid: 'u_456' });
    assert.equal(lookups, 1);
    await assert.rejects(capture.call('resolve', { uin: '789', uid: 'u_456' }), { code: 'INVALID_PARAMS' });
    assert.equal(lookups, 1);
});

test('identity cache replacement removes stale mappings in both directions', t => {
    const { capture } = captureFixture(t);
    capture.remember('456', 'u_old');
    capture.remember('456', 'u_new');
    assert.equal(capture.reverse.has('u_old'), false);
    assert.equal(capture.reverse.get('u_new'), '456');
    capture.remember('789', 'u_new');
    assert.equal(capture.forward.has('456'), false);
    assert.equal(capture.forward.get('789'), 'u_new');
    assert.equal(capture.reverse.get('u_new'), '789');
    capture.remember('9999999999999999999', 'u_inexact');
    assert.equal(capture.reverse.has('u_inexact'), false);
});

test('long-lived identity caches remain bounded and close releases account lookup data', t => {
    const { capture } = captureFixture(t);
    for (let index = 1; index <= 20000; index++) capture.remember(String(index), 'u_' + index);
    capture.remember('1', 'u_1');
    capture.remember('20001', 'u_20001');
    assert.equal(capture.forward.size, 20000);
    assert.equal(capture.reverse.size, 20000);
    assert.equal(capture.forward.has('1'), true);
    assert.equal(capture.forward.has('2'), false);
    assert.equal(capture.reverse.has('u_2'), false);
    capture.close();
    assert.equal(capture.forward.size, 0);
    assert.equal(capture.reverse.size, 0);
});

async function rpcFixture(t, options = {}) {
    const temporary = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(temporary, { recursive: true });
    const dir = fs.mkdtempSync(path.join(temporary, 'audit-bridge-'));
    const backend = new EventEmitter();
    backend.call = async () => true;
    const server = await startServer({ dir, backend, pollMs: 5, ...options });
    const client = new RpcClient({ directory: dir, timeoutMs: 2000 });
    t.after(async () => { client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { backend, client };
}

test('RPC ages out disconnected events after one minute and reports the missing cursor range', async t => {
    let now = 100000;
    const { backend, client } = await rpcFixture(t, { now: () => now });
    backend.emit('event', { kind: 'message', record: { msgId: 'old' } });
    now += 59999;
    const initial = await client.call('events');
    assert.equal(initial.events.length, 1);
    assert.equal(initial.gap, false);
    now++;
    backend.emit('event', { kind: 'message', record: { msgId: 'fresh' } });
    const staleCursor = await client.call('events', { cursor: 0, instance: initial.instance });
    assert.equal(staleCursor.gap, true);
    assert.deepEqual(staleCursor.events.map(item => item.event.record.msgId), ['fresh']);
    const acknowledged = await client.call('events', { cursor: initial.cursor, instance: initial.instance });
    assert.equal(acknowledged.gap, false);
    assert.equal(acknowledged.events[0].event.record.msgId, 'fresh');
});

test('an entirely expired RPC queue advances its cursor without pretending to replay events', async t => {
    let now = 100000;
    const { backend, client } = await rpcFixture(t, { now: () => now });
    backend.emit('event', { kind: 'message', record: { msgId: 'expired' } });
    now += 60000;
    const expired = await client.call('events');
    assert.equal(expired.gap, true);
    assert.equal(expired.cursor, 1);
    assert.deepEqual(expired.events, []);
    const current = await client.call('events', { cursor: expired.cursor, instance: expired.instance });
    assert.equal(current.gap, false);
    assert.deepEqual(current.events, []);
});
