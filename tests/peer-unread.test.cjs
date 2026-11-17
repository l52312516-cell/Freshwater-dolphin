'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { FIELDS, decodeContactUnreadFrame } = require('../src/qq/peer-unread.cjs');
const peer = Object.freeze({ chatType: 1, peerUid: 'u_test', guildId: '' });
function record(target = peer, cnt = 2, type = 37) {
    return { peer: { ...target }, ...Object.fromEntries(FIELDS.map(name => [name, { type, cnt }])) };
}
const frame = (...records) => new Map([[98, new Map(records.map((value, index) => ['opaque-' + index, value]))]]);
function fixture(invoke) {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    capture.epoch = 'one'; capture.ready = true; capture.qqVersion = '3.2.35-54395';
    capture.self = { uin: '10001', uid: 'u_self' };
    const listeners = [], calls = [];
    const msg = {
        addKernelMsgListener(value) { listeners.push(value); return listeners.length; }, removeKernelMsgListener() {},
        getContactUnreadCnt(peers) {
            calls.push(structuredClone(peers));
            return invoke?.(listeners.at(-1), calls.length, peers) ?? { result: 0, errMsg: '' };
        }
    };
    capture.session = { getMsgService: () => msg };
    capture.attach();
    const input = (extra = {}) => ({ operation: 'unread.snapshot', expectedEpoch: capture.epoch,
        expectedSelf: { ...capture.self }, peer: { ...peer }, observationMs: 20, ...extra });
    const query = (extra = {}, context = {}) => capture.call('socialQuery', input(extra), { expiresAt: Date.now() + 1000, ...context });
    return { capture, listeners, calls, query, input };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('raw decoder matches complete value.peer, ignores opaque keys, and copies signed int32 fields', () => {
    const value = record(peer, -5), decoded = decodeContactUnreadFrame(frame(record({ ...peer, guildId: 'other' }), value), peer);
    assert.equal(decoded.status, 'raw-observed'); assert.equal(decoded.counters.all_unread_cnt.cnt, -5);
    value.all_unread_cnt.cnt = 900;
    assert.equal(decoded.counters.all_unread_cnt.cnt, -5); assert.ok(Object.isFrozen(decoded.counters.all_unread_cnt));
    assert.equal(JSON.stringify(decoded).includes('u_test'), false);
});

test('raw decoder rejects malformed maps, incomplete counters, duplicates and record overflow', () => {
    for (const value of [{ result: 0 }, new Map([['bad-key', new Map()]]), frame(record(), record()),
        frame({ ...record(), all_unread_cnt: { type: 1, cnt: '2' } }), frame({ ...record(), peer: { chatType: 1, peerUid: 'u_test' } })]) {
        assert.ok(['invalid', 'ambiguous'].includes(decodeContactUnreadFrame(value, peer).status));
    }
    assert.equal(decodeContactUnreadFrame(frame(record(), record({ ...peer, peerUid: 'u_other' })), peer, 1).status, 'invalid');
    assert.equal(decodeContactUnreadFrame(new Map([[1, new Map()], [2, new Map()]]), peer, 1).status, 'invalid');
    for (const changed of [{ chatType: 2 }, { peerUid: 'u_other' }, { guildId: 'x' }]) {
        assert.equal(decodeContactUnreadFrame(frame(record({ ...peer, ...changed })), peer).status, 'missing');
    }
});

test('raw decoder never evaluates field accessors or assumes unknown enum semantics', () => {
    let accessed = false; const value = record(peer, 0, -2147483648);
    Object.defineProperty(value, 'peer', { get() { accessed = true; return peer; } });
    assert.equal(decodeContactUnreadFrame(frame(value), peer).status, 'invalid'); assert.equal(accessed, false);
    const decoded = decodeContactUnreadFrame(frame(record(peer, 2147483647, -2147483648)), peer);
    assert.equal(decoded.counters.show_unread_cnt.type, -2147483648);
});

test('fixed social query receives synchronous standard callback with a separate ACK and no business success', async t => {
    const { performance } = require('node:perf_hooks');
    let monotonic = 0;
    t.mock.method(performance, 'now', () => monotonic);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
    const f = fixture((listener, _count, peers) => {
        assert.deepEqual(peers, [peer]); listener.onContactUnreadCntUpdate(frame(record()));
        return { result: 0, errMsg: '' };
    }); t.after(() => f.capture.close());
    const pending = f.query();
    await tick();
    monotonic = 20;
    t.mock.timers.tick(20);
    const value = await pending;
    assert.equal(f.calls.length, 1); assert.equal(value.source, 'kernel_push');
    assert.deepEqual(value.requestAck, { result: 0 }); assert.equal(value.snapshot.matchingFrames, 1);
    assert.equal(value.snapshot.counters.show_unread_cnt.cnt, 2);
    for (const name of ['semanticVerified', 'queryCorrelated', 'businessVerified']) assert.equal(value[name], false);
    for (const privateValue of ['u_self', '10001', 'u_test', 'opaque-']) assert.equal(JSON.stringify(value).includes(privateValue), false);
});

test('zero snapshots and independent nonzero/zero phases remain raw and never report read success', async t => {
    const { performance } = require('node:perf_hooks');
    let monotonic = 0;
    t.mock.method(performance, 'now', () => monotonic);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
    let cnt = 2;
    const f = fixture(listener => { listener.onContactUnreadCntUpdate(frame(record(peer, cnt))); }); t.after(() => f.capture.close());
    const snapshot = async () => {
        const pending = f.query();
        // Let the native ACK microtask settle before advancing the actual
        // observation window; parallel CPU load is not a simulated late ACK.
        await tick(); monotonic += 20; t.mock.timers.tick(20);
        return pending;
    };
    const nonzero = await snapshot(); cnt = 0; const zero = await snapshot();
    assert.equal(nonzero.snapshot.counters.all_unread_cnt.cnt, 2); assert.equal(zero.snapshot.counters.all_unread_cnt.cnt, 0);
    assert.equal(zero.businessVerified, false); assert.equal(zero.read, undefined); assert.equal(f.calls.length, 2);
});

test('callback without valid native ACK and ACK without a matching callback both fail', async t => {
    for (const invoke of [() => ({ result: 0, errMsg: '' }), listener => { listener.onContactUnreadCntUpdate(frame(record())); return { result: 9, errMsg: 'private detail' }; },
        listener => { listener.onContactUnreadCntUpdate(frame(record())); return { result: 0 }; }]) {
        const f = fixture(invoke); t.after(() => f.capture.close());
        await assert.rejects(f.query(), error => ['TIMEOUT', 'KERNEL_ERROR', 'INVALID_RESPONSE'].includes(error.code) && !error.message.includes('private detail'));
        assert.equal(f.calls.length, 1);
    }
});

test('a changing or malformed frame invalidates the whole stable window even after a good sample', async t => {
    for (const bad of [frame(record(peer, 3)), frame(record(), record()), { result: 0, errMsg: '' }]) {
        const f = fixture(listener => { listener.onContactUnreadCntUpdate(frame(record())); listener.onContactUnreadCntUpdate(bad); });
        t.after(() => f.capture.close()); await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    }
});

test('native throws and rejections are bounded failures without leaking native text or retaining a settled lock', async t => {
    for (const asynchronous of [false, true]) {
        const f = fixture((listener, count) => {
            if (count > 1) { listener.onContactUnreadCntUpdate(frame(record())); return { result: 0, errMsg: '' }; }
            const error = new Error('private peer and message detail');
            if (asynchronous) return Promise.reject(error);
            throw error;
        }); t.after(() => f.capture.close());
        await assert.rejects(f.query(), error => error.code === 'KERNEL_ERROR' && !error.message.includes('private'));
        assert.equal((await f.query()).snapshot.counters.all_unread_cnt.cnt, 2);
    }
});

test('an ACK microtask delayed past the observation window cannot beat a delayed timer', async t => {
    const { performance } = require('node:perf_hooks');
    const f = fixture(listener => {
        listener.onContactUnreadCntUpdate(frame(record()));
        return Promise.resolve().then(() => {
            const end = performance.now() + 30;
            while (performance.now() < end) { /* Simulate an event-loop stall before the ACK. */ }
            return { result: 0, errMsg: '' };
        });
    }); t.after(() => f.capture.close());
    await assert.rejects(f.query(), { code: 'TIMEOUT' });
});

test('identical repeats and other peers do not change the target snapshot', async t => {
    const f = fixture(listener => {
        listener.onContactUnreadCntUpdate(frame(record())); listener.onContactUnreadCntUpdate(frame(record({ ...peer, peerUid: 'u_other' }, 99)));
        listener.onContactUnreadCntUpdate(frame(record()));
    }); t.after(() => f.capture.close());
    assert.equal((await f.query()).snapshot.matchingFrames, 2);
});

test('expected full Peer, self, epoch, supported fields and finite window are validated before dispatch', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    for (const extra of [{ expectedEpoch: 'old' }, { expectedSelf: { uin: '10001', uid: 'u_other' } }, { expectedSelf: { uin: '10001' } },
        { peer: { chatType: 1, peerUid: 'u_test' } }, { peer: { ...peer, extra: true } }, { observationMs: 0 }, { observationMs: 2001 }, { raw: true }]) {
        await assert.rejects(f.query(extra), error => ['INVALID_PARAMS', 'SESSION_CHANGED'].includes(error.code));
    }
    await assert.rejects(f.query({}, { expiresAt: Date.now() + 10 }), { code: 'EXPIRED' });
    assert.equal(f.calls.length, 0);
});

test('a missing native method or standard listener fails without dispatch', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    f.capture.detach(); await assert.rejects(f.query(), { code: 'UNSUPPORTED' });
    f.capture.attach(); f.capture.session.getMsgService().getContactUnreadCnt = undefined;
    await assert.rejects(f.query(), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 0);
});

test('physical lock survives observation timeout and clear until the native Promise actually settles', async t => {
    let finish;
    const f = fixture((listener, count) => count === 1 ? new Promise(resolve => { finish = resolve; }) :
        (listener.onContactUnreadCntUpdate(frame(record())), { result: 0, errMsg: '' })); t.after(() => f.capture.close());
    await assert.rejects(f.query(), { code: 'TIMEOUT' });
    f.capture.social.clearUnread();
    await assert.rejects(f.query(), { code: 'BUSY' });
    f.capture.epoch = 'two'; f.capture.social.reset();
    await assert.rejects(f.query(), { code: 'BUSY' });
    assert.equal(f.calls.length, 1);
    finish({ result: 0, errMsg: '' }); await tick();
    // Bind a new standard listener to the new epoch before the next query.
    f.capture.detach(); f.capture.attach();
    assert.equal((await f.query()).snapshot.counters.all_unread_cnt.cnt, 2); assert.equal(f.calls.length, 2);
});

test('parallel callers cannot share one callback window or free each other\'s physical slot', async t => {
    let finish;
    const f = fixture(() => new Promise(resolve => { finish = resolve; })); t.after(() => f.capture.close());
    const first = f.query({ observationMs: 40 }); await tick();
    await assert.rejects(f.query(), { code: 'BUSY' });
    f.listeners.at(-1).onContactUnreadCntUpdate(frame(record())); finish({ result: 0, errMsg: '' });
    assert.equal((await first).snapshot.matchingFrames, 1); assert.equal(f.calls.length, 1);
});

test('self, session, generation and epoch changes reject an active snapshot', async t => {
    for (const change of [c => { c.self = { ...c.self, uid: 'u_changed' }; }, c => { c.session = { ...c.session }; },
        c => { c.observerGeneration++; }, c => { c.epoch = 'two'; }]) {
        let finish;
        const f = fixture(() => new Promise(resolve => { finish = resolve; })); t.after(() => f.capture.close());
        const task = f.query({ observationMs: 50 }); await tick(); change(f.capture); finish({ result: 0, errMsg: '' });
        await assert.rejects(task, { code: 'SESSION_CHANGED' });
    }
});

test('detach terminates observation and retired native listener cannot poison a replacement window', async t => {
    let finish, old;
    const f = fixture((listener, count) => {
        if (count === 1) { old = listener; return new Promise(resolve => { finish = resolve; }); }
        old.onContactUnreadCntUpdate(frame(record(peer, 99)));
        listener.onContactUnreadCntUpdate(frame(record())); return { result: 0, errMsg: '' };
    }); t.after(() => f.capture.close());
    const task = f.query({ observationMs: 50 }); await tick(); f.capture.detach();
    await assert.rejects(task, { code: 'SESSION_CHANGED' }); finish({ result: 0, errMsg: '' }); await tick();
    f.capture.attach(); assert.equal((await f.query()).snapshot.matchingFrames, 1);
});

test('abort and capture shutdown terminate observation; later callbacks cannot complete it', async () => {
    for (const mode of ['abort', 'close', 'withdraw']) {
        let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; })), controller = new AbortController();
        const task = f.query({ observationMs: 50 }, { signal: controller.signal }); await tick();
        if (mode === 'abort') controller.abort();
        else if (mode === 'close') f.capture.close();
        else f.capture.withdrawReady(Object.assign(new Error('offline'), { code: 'NOT_READY' }));
        await assert.rejects(task, error => ['EXPIRED', 'NOT_READY', 'SESSION_CHANGED'].includes(error.code));
        f.listeners.at(-1).onContactUnreadCntUpdate(frame(record())); finish({ result: 0, errMsg: '' }); await tick(); f.capture.close();
    }
});
