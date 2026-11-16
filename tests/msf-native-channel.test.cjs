'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { varintField, bytesField, messageField } = require('../src/qq/proto.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
function spaceResponse(used = 184) {
    return Buffer.concat([varintField(1, 0x6d8), varintField(2, 3), varintField(3, 0),
        bytesField(4, messageField(4, [varintField(4, 10000), varintField(5, used)]))]);
}

function fixture() {
    let clock = 0, nextId = 0, template = true;
    const sleeps = [], sent = [], released = [], reads = [], responses = new Map(), active = new Set();
    const capture = { epoch: 'e1', self: { uin: '123' }, closed: false,
        service: () => ({ sendSsoCmdReqByContend: () => { primed++; return Promise.resolve({}); } }) };
    let primed = 0, resets = 0, maximumActive = 0, onSend = null;
    const native = {
        protocolVersion: 2,
        resetSession() { resets++; },
        install(target) { assert.equal(target, 'ssosend'); return { ok: true }; },
        readTemplate() { return { haveTemplate: template }; },
        send(command, body) {
            assert.equal(command, 'OidbSvcTrpcTcp.0x6d8_3');
            assert.ok(/^[0-9a-f]+$/.test(body));
            const id = String(++nextId);
            sent.push(id); active.add(id); maximumActive = Math.max(maximumActive, active.size);
            if (onSend) onSend(id);
            return { ok: true, requestId: id };
        },
        readResponse(id) {
            reads.push(id);
            return { requestId: id, result: 0, count: 0, body: [], ...responses.get(id) };
        },
        release(id) { released.push(id); active.delete(id); }
    };
    const channel = createChannel({ loadNative: () => native, now: () => clock,
        pollMs: 1, sleep: () => new Promise(resolve => { sleeps.push(resolve); }) });
    return { channel, capture, native, sent, released, reads, responses, active,
        get maximumActive() { return maximumActive; }, get primed() { return primed; }, get resets() { return resets; },
        set template(value) { template = value; }, set onSend(value) { onSend = value; },
        call(params = {}) { return channel.run(capture, { op: 'fetchGroupFileSpace', groupId: 2000000001, timeoutMs: 1000, ...params }); },
        reply(id, used = 184) { responses.set(id, { count: 1, body: [...spaceResponse(used)] }); },
        async step(ms = 1) { clock += ms; for (const resume of sleeps.splice(0)) resume(); await turn(); }
    };
}

test('native channel serializes concurrent requests and releases each correlated response', async () => {
    const f = fixture(), first = f.call(), second = f.call();
    await turn();
    assert.deepEqual(f.sent, ['1']);
    f.reply('1', 11); await f.step();
    assert.equal((await first).usedSpace, 11);
    assert.deepEqual(f.sent, ['1', '2']);
    f.reply('2', 22); await f.step();
    assert.equal((await second).usedSpace, 22);
    assert.deepEqual(f.released, ['1', '2']);
    assert.equal(f.maximumActive, 1);
    assert.equal(f.resets, 1, 'one primed native state per QQ session');
});

test('native empty-body errors distinguish bounded size diagnostics without leaking response data', async () => {
    const f = fixture();
    f.onSend = id => f.responses.set(id, { count: 1, body: [], responseBytes: '160000', bodyStatus: 'too_large', secret: 'PRIVATE' });
    await assert.rejects(f.call(), error => {
        assert.equal(error.code, 'QUERY_FAILED');
        assert.match(error.message, /status=too_large,bytes=160000/);
        assert.equal(error.message.includes('PRIVATE'), false);
        return true;
    });
    assert.deepEqual(f.released, ['1']);
});

test('a timed-out native callback cannot become the next request response', async () => {
    const f = fixture();
    const first = f.call({ timeoutMs: 20 }).catch(error => error);
    const second = f.call();
    await turn();
    await f.step(21);
    assert.equal((await first).code, 'TIMEOUT');
    assert.deepEqual(f.released, ['1']);
    assert.deepEqual(f.sent, ['1', '2']);
    f.reply('1', 9999); // old callback arrives while request 2 is pending
    await f.step();
    assert.equal(f.active.has('2'), true);
    f.reply('2', 23); await f.step();
    assert.equal((await second).usedSpace, 23);
    assert.deepEqual(f.released, ['1', '2']);
    assert.equal(f.reads.slice(f.reads.indexOf('2')).includes('1'), false);
});

test('time spent in the native queue counts toward a deadline and expired work is never sent', async () => {
    const f = fixture(), first = f.call();
    const queued = f.call({ timeoutMs: 10 }).catch(error => error);
    await turn();
    await f.step(11);
    f.reply('1'); await f.step();
    await first;
    assert.equal((await queued).code, 'TIMEOUT');
    assert.deepEqual(f.sent, ['1']);
    assert.deepEqual(f.released, ['1']);
});

test('session replacement rejects active and queued requests before a new session can send', async () => {
    const f = fixture();
    const first = f.call().catch(error => error), queued = f.call().catch(error => error);
    await turn();
    f.capture.epoch = 'e2'; f.capture.self = { uin: '456' };
    await f.step();
    assert.equal((await first).code, 'SESSION_CHANGED');
    assert.equal((await queued).code, 'SESSION_CHANGED');
    assert.deepEqual(f.sent, ['1']);
    assert.deepEqual(f.released, ['1']);
    f.onSend = id => f.reply(id, 42);
    assert.equal((await f.call()).usedSpace, 42);
    assert.equal(f.resets, 2);
});

test('native session priming shares the total request deadline and never sends after expiry', async () => {
    const f = fixture(); f.template = false;
    const pending = f.call({ timeoutMs: 20 }).catch(error => error);
    await turn();
    assert.equal(f.primed, 1);
    await f.step(21);
    assert.equal((await pending).code, 'TIMEOUT');
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.released, []);
    f.template = true; f.onSend = id => f.reply(id);
    assert.equal((await f.call()).usedSpace, 184);
});

test('cancelling queued or active work releases the active ID and never submits cancelled queued work', async () => {
    const f = fixture(), active = new AbortController(), waiting = new AbortController();
    const first = f.call({ signal: active.signal }).catch(error => error);
    const second = f.call({ signal: waiting.signal }).catch(error => error);
    await turn();
    waiting.abort(); active.abort();
    assert.equal((await second).code, 'TIMEOUT');
    assert.equal((await first).code, 'TIMEOUT');
    await f.step();
    assert.deepEqual(f.sent, ['1']);
    assert.deepEqual(f.released, ['1']);
    f.onSend = id => f.reply(id, 7);
    assert.equal((await f.call()).usedSpace, 7, 'cancellation does not break subsequent queries');
});

test('native queue capacity is bounded and cancelled queued entries are drained without sends', async () => {
    const f = fixture(), cancel = new AbortController();
    const requests = Array.from({ length: 32 }, () => f.call({ signal: cancel.signal }).catch(error => error));
    await assert.rejects(f.call(), { code: 'BUSY' });
    await turn();
    assert.deepEqual(f.sent, ['1']);
    cancel.abort();
    const errors = await Promise.all(requests);
    assert.ok(errors.every(error => error.code === 'TIMEOUT'));
    await f.step(); await turn();
    assert.deepEqual(f.sent, ['1']);
    assert.deepEqual(f.released, ['1']);
    f.onSend = id => f.reply(id, 9);
    assert.equal((await f.call()).usedSpace, 9);
});

test('cancelled queued callers free capacity while an earlier native query is still active', async () => {
    const f = fixture(), cancel = new AbortController();
    const first = f.call();
    const queued = Array.from({ length: 31 }, () => f.call({ signal: cancel.signal }).catch(error => error));
    await turn(); cancel.abort();
    assert.ok((await Promise.all(queued)).every(error => error.code === 'TIMEOUT'));
    const replacement = f.call();
    await turn();
    assert.deepEqual(f.sent, ['1'], 'the replacement cannot overlap the still active query');
    f.reply('1', 11); await f.step();
    assert.equal((await first).usedSpace, 11);
    assert.deepEqual(f.sent, ['1', '2']);
    f.reply('2', 22); await f.step();
    assert.equal((await replacement).usedSpace, 22);
    assert.equal(f.maximumActive, 1);
});

test('fixed native RPC refuses raw sends, invalid budgets and pre-aborted calls', async () => {
    const f = fixture();
    await assert.rejects(f.call({ op: 'send', cmd: 'Anything', bodyHex: '00' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.call({ timeoutMs: 0 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.call({ timeoutMs: 60001 }), { code: 'INVALID_PARAMS' });
    const cancel = new AbortController(); cancel.abort();
    await assert.rejects(f.call({ signal: cancel.signal }), { code: 'TIMEOUT' });
    await turn();
    assert.deepEqual(f.sent, []);
});

test('wrong callback IDs and transport errors fail the query and still release its ID', async () => {
    for (const response of [{ requestId: '999', count: 1, body: [...spaceResponse()] },
        { count: 1, result: 5, body: [...spaceResponse()] }, { count: 1, body: [] }]) {
        const f = fixture();
        f.onSend = id => f.responses.set(id, response);
        await assert.rejects(f.call(), { code: response.requestId ? 'INVALID_RESPONSE' : 'QUERY_FAILED' });
        assert.deepEqual(f.released, ['1']);
    }
});
