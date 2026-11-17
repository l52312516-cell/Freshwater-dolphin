'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const protocol = require('../src/qq/profile-update-protocol.cjs'), p = require('../src/qq/proto.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { createInteractions } = require('../src/qq/interactions.cjs');
const { runInteraction } = require('../src/onebot/interactions.cjs');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { decodeHttpParameter } = require('../src/onebot/parameter-schema.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const ack = (...extra) => Buffer.concat([p.varintField(1, 0x112a), p.varintField(2, 2), p.varintField(3, 0), ...extra]);
const one = (map, field) => { assert.equal(map.get(field)?.length, 1); return map.get(field)[0].value; };

test('profile sex writes only field 20009 to the authenticated UIN with the reference fixed wire', () => {
    for (const sex of [0, 1, 2]) {
        const prepared = protocol.prepare('profile.sex', { uin: '12345', sex });
        assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x112a_2');
        const top = p.fields(prepared.body), body = p.fields(one(top, 4)), int = p.fields(one(body, 3));
        assert.deepEqual([...top.keys()], [1, 2, 3, 4, 12]);
        assert.deepEqual([one(top, 1), one(top, 2), one(top, 3), one(top, 12)], [0x112an, 2n, 0n, 0n]);
        assert.deepEqual([...body.keys()], [1, 3]); assert.equal(one(body, 1), 12345n);
        assert.deepEqual([...int.keys()], [1, 2]); assert.equal(one(int, 1), 20009n); assert.equal(one(int, 2), BigInt(sex));
        assert.deepEqual(protocol.decode(ack(), prepared), { operation: 'profile.sex', uin: '12345', sex,
            confirmed: false, confirmation: 'requires_profile_readback' });
    }
});

test('invalid profile sex input and unknown profile fields cannot become fixed requests', () => {
    for (const value of [undefined, null, '', '0', '1', true, -1, 3, 1.5, NaN, Infinity]) {
        assert.throws(() => protocol.prepare('profile.sex', { uin: '12345', sex: value }), { code: 'INVALID_PARAMS' });
    }
    for (const uin of [undefined, null, 0, -1, '012345', '4294967296', 12345.5, 'u_self']) {
        assert.throws(() => protocol.prepare('profile.sex', { uin, sex: 1 }), { code: 'INVALID_PARAMS' });
    }
    assert.throws(() => protocol.prepare('profile.sex', { uin: '12345', sex: 1, fieldId: 20002 }), { code: 'INVALID_PARAMS' });
    assert.throws(() => protocol.prepare('profile.raw', { uin: '12345', sex: 1 }), { code: 'UNSUPPORTED' });
});

test('profile ACK validates operation identity and protobuf default status without claiming business confirmation', () => {
    const prepared = protocol.prepare('profile.sex', { uin: '12345', sex: 1 });
    assert.equal(protocol.decode(Buffer.concat([p.varintField(1, 0x112a), p.varintField(2, 2)]), prepared).confirmed, false);
    for (const bytes of [Buffer.alloc(0), p.varintField(1, 0x112a), ack(p.varintField(3, 0)),
        ack(p.bytesField(3, Buffer.from([0]))), ack(p.varintField(12, 1)), ack(p.varintField(1, 0x112b)),
        ack(p.bytesField(4, p.varintField(1, 0)))]) {
        assert.throws(() => protocol.decode(bytes, prepared), { code: 'INVALID_RESPONSE' });
    }
    const rejected = Buffer.concat([p.varintField(1, 0x112a), p.varintField(2, 2), p.varintField(3, 7)]);
    assert.throws(() => protocol.decode(rejected, prepared), { code: 'KERNEL_ERROR' });
});

test('fixed profile writes use the correlated native channel once and release each response without claiming readback', async () => {
    const sent = [], released = [], capture = { self: { uin: '12345' }, epoch: 'native-sex-epoch', closed: false };
    const native = { protocolVersion: 2, resetSession() {}, install: () => ({ ok: true }),
        readTemplate: () => ({ haveTemplate: true }),
        send(command, hex) { const requestId = String(sent.length + 1); sent.push({ command, hex, requestId }); return { ok: true, requestId }; },
        readResponse(requestId) { return { requestId, result: 0, count: 1,
            body: [...Buffer.concat([p.varintField(1, 0x112a), p.varintField(2, 2)])] }; },
        release(requestId) { released.push(requestId); } };
    const channel = createChannel({ loadNative: () => native });
    for (const sex of [0, 1, 2]) {
        const request = { uin: '12345', sex }, prepared = protocol.prepare('profile.sex', request);
        const result = await channel.run(capture, { op: 'fixedProfile', operation: 'profile.sex', request,
            expectedEpoch: capture.epoch, expectedUin: '12345', timeoutMs: 1000 });
        assert.deepEqual(result, { operation: 'profile.sex', ...request, confirmed: false, confirmation: 'requires_profile_readback', via: 'native-msf' });
        assert.equal(sent.at(-1).command, prepared.name); assert.equal(sent.at(-1).hex, prepared.body.toString('hex'));
    }
    assert.deepEqual(sent.map(row => row.requestId), ['1', '2', '3']);
    assert.deepEqual(released, ['1', '2', '3']);
});

function fixture(t) {
    const capture = new Capture({ install: false, processObject: { env: {} } });
    Object.assign(capture, { ready: true, online: true, session: {}, epoch: 'sex-epoch', qqVersion: '3.2.35-54395', self: { uin: '12345', uid: 'u_self' } });
    const calls = [], values = { sex: 0, nickname: 'Original', personalNote: '' };
    let available = true, readOverride, writeOverride;
    const profile = { getCoreAndBaseInfo(store, ids) {
        calls.push({ op: 'read', store, ids });
        if (readOverride) return readOverride();
        return new Map([['u_self', { uid: 'u_self', uin: '12345', coreInfo: { uid: 'u_self', nick: values.nickname },
            baseInfo: { uid: 'u_self', uin: '12345', sex: values.sex, longNick: values.personalNote } }]]);
    }, setNickName(value) { calls.push({ op: 'nickname', value }); values.nickname = value; },
    setLongNick(value) { calls.push({ op: 'signature', value }); values.personalNote = value; } };
    capture.service = () => profile;
    const native = { available: () => available, async run(received, request) {
        assert.equal(received, capture); calls.push({ op: 'sex', request });
        if (writeOverride) return writeOverride(request);
        values.sex = request.request.sex;
        return protocol.decode(ack(), protocol.prepare(request.operation, request.request));
    } };
    const api = createInteractions(capture, { native });
    const state = () => ({ epoch: capture.epoch, self: { ...capture.self }, capabilities: api.capabilities() });
    // The production Capture call removes the operation dispatch key.
    const service = { sessionCall: (current, method, { operation, ...params }) => {
        assert.equal(method, 'interaction'); return api.dispatch(operation, { ...params, expectedEpoch: current.epoch });
    } };
    t.after(() => capture.close());
    return { capture, api, native, calls, values, profile, service, state,
        run: (params, context = {}) => api.dispatch('profile.update', params, context),
        public: params => runInteraction(service, state(), 'set_qq_profile', params),
        set available(value) { available = value; }, set read(value) { readOverride = value; }, set write(value) { writeOverride = value; } };
}

test('OneBot profile sex crosses the fixed transport and verifies the exact original and updated self field', async t => {
    const f = fixture(t);
    for (const value of [1, 2, 0]) {
        assert.equal(await f.public({ sex: value }), null);
        assert.equal(f.values.sex, value);
    }
    const writes = f.calls.filter(row => row.op === 'sex'); assert.equal(writes.length, 3);
    assert.equal(f.calls.filter(row => row.op === 'read').length, 6);
    assert.ok(writes.every(row => row.request.op === 'fixedProfile' && row.request.expectedUin === '12345' &&
        row.request.expectedEpoch === 'sex-epoch' && row.request.signal instanceof AbortSignal && row.request.request.uin === '12345'));
});

test('HTTP forms decode sex and target_id without coercing malformed scalar values', async t => {
    const f = fixture(t);
    for (const value of ['0', '1', '2']) {
        const parsed = decodeHttpParameter('sex', value, 'set_qq_profile'); assert.equal(parsed, Number(value));
        assert.equal(await f.public({ sex: parsed }), null);
    }
    assert.equal(decodeHttpParameter('target_id', '12345', 'friend_poke'), 12345);
    for (const value of ['01', '1.0', ' 1', 'true']) {
        assert.equal(decodeHttpParameter('sex', value), value);
        await assert.rejects(f.public({ sex: value }), { code: 'INVALID_PARAMS' });
    }
});

test('sex validation and full capability checks precede reads or changes to any compound profile field', async t => {
    const f = fixture(t);
    for (const sex of [null, '', '1', -1, 3, 0.5, undefined]) {
        await assert.rejects(f.public({ nickname: 'New', sex }), { code: 'INVALID_PARAMS' });
        await assert.rejects(f.run({ nickname: 'New', sex }), { code: 'INVALID_PARAMS' });
    }
    f.available = false;
    assert.equal(f.api.capabilities().selfSex, false);
    await assert.rejects(f.public({ nickname: 'New', sex: 1 }), { code: 'UNSUPPORTED' });
    await assert.rejects(f.run({ nickname: 'New', sex: 1 }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('an unchanged zero sex value requires a real read and performs no write', async t => {
    const f = fixture(t); const result = await f.run({ sex: 0 });
    assert.deepEqual(result.previous, { sex: 0 }); assert.equal(result.changed, false); assert.equal(result.sex, 0);
    assert.equal(f.calls.filter(row => row.op === 'sex').length, 0);
    assert.equal(f.calls.filter(row => row.op === 'read').length, 1);
});

test('missing, inexact or foreign original sex snapshots block the mutation before SSO', async t => {
    const f = fixture(t);
    for (const baseInfo of [{}, { sex: '0' }, { sex: 3 }, { sex: 0, uid: 'u_other' }, { sex: 0, uin: '54321' }]) {
        f.read = () => new Map([['u_self', { uid: 'u_self', coreInfo: { uid: 'u_self' }, baseInfo }]]);
        await assert.rejects(f.run({ sex: 1 }), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(f.calls.filter(row => row.op === 'sex').length, 0);
});

test('a successful ACK with a stale self snapshot is not a confirmed profile change and never retries the write', async t => {
    const f = fixture(t), controller = new AbortController();
    f.write = request => { setTimeout(() => controller.abort(), 10); return protocol.decode(ack(), protocol.prepare(request.operation, request.request)); };
    await assert.rejects(f.run({ sex: 1 }, { signal: controller.signal }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    assert.equal(f.values.sex, 0); assert.equal(f.calls.filter(row => row.op === 'sex').length, 1);
});

test('wrong ACK identity and session replacement never become profile success', async t => {
    for (const patch of [{ uin: '54321' }, { sex: 2 }, { confirmed: true }, { confirmation: 'server_ack' }]) {
        const f = fixture(t);
        f.write = request => ({ ...protocol.decode(ack(), protocol.prepare(request.operation, request.request)), ...patch });
        await assert.rejects(f.run({ sex: 1 }), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.filter(row => row.op === 'sex').length, 1);
    }
    const f = fixture(t); f.write = request => {
        f.capture.epoch = 'changed'; return protocol.decode(ack(), protocol.prepare(request.operation, request.request));
    };
    await assert.rejects(f.run({ sex: 1 }), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.filter(row => row.op === 'sex').length, 1);
});

test('a confirmed earlier nickname change followed by a rejected sex update reports partial completion', async t => {
    const f = fixture(t); f.write = () => { throw Object.assign(Error('rejected'), { code: 'KERNEL_ERROR' }); };
    await assert.rejects(f.run({ nickname: 'New', sex: 1 }), { code: 'PARTIAL_RESULT' });
    assert.equal(f.values.nickname, 'New'); assert.equal(f.values.sex, 0);
    assert.deepEqual(f.calls.filter(row => ['nickname', 'sex'].includes(row.op)).map(row => row.op), ['nickname', 'sex']);
});

test('the native fixed profile channel rejects a foreign account or invalid field before loading or priming native transport', async () => {
    let nativeLoads = 0;
    const channel = createChannel({ loadNative: () => { nativeLoads++; throw Error('must not load'); } });
    const capture = { self: { uin: '12345' }, epoch: 'e1' };
    await assert.rejects(channel.run(capture, { op: 'fixedProfile', operation: 'profile.sex', request: { uin: '54321', sex: 1 } }), { code: 'SESSION_CHANGED' });
    await assert.rejects(channel.run(capture, { op: 'fixedProfile', operation: 'profile.sex', request: { uin: '12345', sex: 3 } }), { code: 'INVALID_PARAMS' });
    assert.equal(nativeLoads, 0);
});
