'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/share-oidb.cjs');
const { createShareQueries, MAX_PENDING } = require('../src/qq/share-queries.cjs');
const { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, runShareActions } = require('../src/onebot/share-actions.cjs');
const { createInteractions } = require('../src/qq/interactions.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { createChannel } = require('../src/qq/msf-native.cjs');
const ark = '{ "app": "com.tencent.contact.lua", "meta": { "contact": { "uin": "22222", "nick": "服务端名片" } } }';
const groupArk = '{"app":"com.tencent.structmsg","meta":{"contact":{"groupCode":"12345"}}}';
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const join = (...parts) => Buffer.concat(parts);
const error = code => Object.assign(new Error(code), { code });
const rejects = (promise, code) => assert.rejects(promise, reason => reason.code === code);
const turn = () => new Promise(resolve => setImmediate(resolve));
function envelope(prepared, body, overrides = {}) {
    return join(n(1, overrides.command ?? prepared.command), n(2, overrides.sub ?? prepared.sub), n(3, overrides.error ?? 0),
        b(4, body), n(12, overrides.mode ?? prepared.mode));
}
function response(prepared, value = prepared.operation === 'group.ark' ? groupArk : ark) {
    return envelope(prepared, prepared.operation === 'group.ark' ? join(n(1, 0), s(5, value)) : s(1, value));
}
function nativeFixture() {
    const calls = [], overrides = {};
    const capture = { epoch: 'share-epoch', self: { uin: '11111', uid: 'u_self' }, session: {}, ensureReady() {},
        deadline: operation => operation() };
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, capture); calls.push(params);
        if (overrides.run) return overrides.run(params);
        const prepared = protocol.prepare(params.operation, params.request);
        return protocol.decode(response(prepared), prepared);
    } };
    const share = createShareQueries(capture, { native });
    return { capture, native, share, calls, overrides,
        query: (params = { operation: 'group.ark', groupId: '12345' }, context = {}) => share.query({ ...params, expectedEpoch: capture.epoch }, context) };
}
function actionFixture() {
    const state = { ready: true, epoch: 'onebot-share', self: { uin: '11111', uid: 'u_self' },
        capabilities: { groupArkShare: true, peerArkShare: true, arkShare: true, selfProfile: true, selfSignature: true } }, calls = [], overrides = {};
    let active = true;
    const service = {
        async assertSession(bound) { assert.equal(bound, state); if (!active) throw error('NOT_READY'); },
        async sessionCall(bound, method, request) {
            await this.assertSession(bound); calls.push({ method, request });
            let result;
            if (overrides[method]) result = await overrides[method](request);
            else if (method === 'shareQuery') result = { ...request, arkMsg: request.operation === 'group.ark' ? groupArk : ark };
            else if (method === 'interaction') result = { confirmed: true, changed: true, uin: state.self.uin, uid: state.self.uid,
                personalNote: request.personalNote, previous: { personalNote: 'Old signature' } };
            else assert.fail('Unexpected RPC ' + method);
            await this.assertSession(bound); return result;
        }
    };
    return { state, service, calls, overrides, deactivate: () => { active = false; }, invoke: (action, params = {}) => runShareActions(service, state, action, params) };
}

test('group Ark wire fixes 0x8b7_5, mode 1 and request fields 1=1, 2=groupCode, 5=1', () => {
    const prepared = protocol.prepare('group.ark', { groupId: 12345 }), top = p.fields(prepared.body), body = p.fields(top.get(4)[0].value);
    assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x8b7_5'); assert.equal(prepared.mode, 1);
    assert.deepEqual([...top.keys()], [1, 2, 3, 4, 12]);
    assert.equal(top.get(1)[0].value, 0x8b7n); assert.equal(top.get(2)[0].value, 5n); assert.equal(top.get(12)[0].value, 1n);
    assert.deepEqual([...body].map(([field, rows]) => [field, rows[0].value]), [[1, 1n], [2, 12345n], [5, 1n]]);
    assert.deepEqual(prepared.data, { groupId: '12345' });
});

test('peer Ark wire fixes 0x12b6_0, mode 0, real UIN and the kernel phone/jump URL fields', () => {
    for (const phoneNumber of [undefined, '', '+86 123456789']) {
        const prepared = protocol.prepare('peer.ark', { userId: '22222', phoneNumber }), top = p.fields(prepared.body), body = p.fields(top.get(4)[0].value);
        assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x12b6_0'); assert.equal(prepared.mode, 0);
        assert.equal(top.get(12)[0].value, 0n); assert.equal(body.get(1)[0].value, 22222n);
        assert.equal(body.get(2)[0].value.toString(), phoneNumber || '-');
        assert.equal(body.get(3)[0].value.toString(), 'mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=22222');
        assert.equal(prepared.data.phoneNumber, phoneNumber || '');
    }
});

test('fixed Ark protocol rejects unsafe targets, unknown methods, raw bodies and parameter accessors', () => {
    for (const groupId of [0, -1, 1.5, '012345', '4294967296', Number.MAX_SAFE_INTEGER + 1, null, true]) {
        assert.throws(() => protocol.prepare('group.ark', { groupId }), { code: 'INVALID_PARAMS' });
    }
    assert.throws(() => protocol.prepare('arbitrary.command', {}), { code: 'UNSUPPORTED' });
    assert.throws(() => protocol.prepare('group.ark', { groupId: 12345, command: 'private' }), { code: 'INVALID_PARAMS' });
    for (const phoneNumber of [null, 123, 'bad\0phone', 'x'.repeat(1025), '\ud800']) assert.throws(() => protocol.prepare('peer.ark', { userId: 22222, phoneNumber }), { code: 'INVALID_PARAMS' });
    const input = {};
    Object.defineProperty(input, 'groupId', { get() { assert.fail('request getter must not run'); } });
    assert.throws(() => protocol.prepare('group.ark', input), { code: 'INVALID_PARAMS' });
});

test('Ark protocol keeps the exact server JSON and query identity while accepting omitted protobuf zero status', () => {
    const group = protocol.prepare('group.ark', { groupId: '12345' }), peer = protocol.prepare('peer.ark', { userId: '22222' });
    assert.deepEqual(protocol.decode(response(group), group), { operation: 'group.ark', groupId: '12345', arkMsg: groupArk });
    assert.deepEqual(protocol.decode(response(peer), peer), { operation: 'peer.ark', userId: '22222', phoneNumber: '', arkMsg: ark });
    assert.equal(protocol.decode(join(n(1, group.command), n(2, group.sub), b(4, s(5, groupArk))), group).arkMsg, groupArk);
    assert.equal(protocol.decode(join(n(1, peer.command), b(4, s(1, ark))), peer).arkMsg, ark);
});

test('Ark decoder rejects different commands, subcommands, modes, business errors and ambiguous status fields', () => {
    const prepared = protocol.prepare('group.ark', { groupId: 12345 }), body = join(n(1, 0), s(5, groupArk));
    for (const change of [{ command: 0x12b6 }, { sub: 0 }, { mode: 0 }]) assert.throws(() => protocol.decode(envelope(prepared, body, change), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, body, { error: 7 }), prepared), { code: 'KERNEL_ERROR' });
    assert.throws(() => protocol.decode(envelope(prepared, join(n(1, 5), s(5, groupArk))), prepared), { code: 'KERNEL_ERROR' });
    assert.throws(() => protocol.decode(join(response(prepared), n(3, 0)), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, join(n(1, 0), n(1, 0), s(5, groupArk))), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(envelope(prepared, join(s(1, 'private error detail'), s(5, groupArk))), prepared), { code: 'INVALID_RESPONSE' });
    try { protocol.decode(envelope(prepared, join(n(1, 5), s(2, 'PRIVATE_SERVER_TEXT'), s(5, 'PRIVATE_ARK'))), prepared); assert.fail(); }
    catch (reason) { assert.equal(reason.code, 'KERNEL_ERROR'); assert.equal(reason.message.includes('PRIVATE'), false); }
});

test('Ark payloads must be explicit, bounded UTF-8 JSON application objects, never successful empty or local fallback cards', () => {
    const prepared = protocol.prepare('peer.ark', { userId: 22222 });
    for (const body of [Buffer.alloc(0), s(2, ark), s(1, ''), join(s(1, ark), s(1, ark)), n(1, 1), b(1, Buffer.from([0xff]))]) {
        assert.throws(() => protocol.decode(envelope(prepared, body), prepared), { code: 'INVALID_RESPONSE' });
    }
    for (const value of ['not-json', '[]', 'null', '"string"', '{}', '{"app":1}', '{"app":""}', '{"app":"x","infinite":1e999}',
        JSON.stringify({ app: 'x', data: 'x'.repeat(protocol.MAX_ARK_BYTES) })]) assert.throws(() => protocol.decode(response(prepared, value), prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(Buffer.alloc(protocol.MAX_RESPONSE_BYTES + 1), prepared), { code: 'INVALID_RESPONSE' });
    let deep = null;
    for (let index = 0; index < 34; index++) deep = { inner: deep };
    assert.throws(() => protocol.validateArk(JSON.stringify({ app: 'x', deep })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.validateArk(JSON.stringify({ app: 'x', list: Array(20001).fill(0) })), { code: 'INVALID_RESPONSE' });
});

test('QQ Ark adapter exposes three related flags and binds native queries to exact epoch, account and caller deadline', async () => {
    const f = nativeFixture(), expiresAt = Date.now() + 2000;
    assert.deepEqual(f.share.capabilities(), { groupArkShare: true, peerArkShare: true, arkShare: true });
    assert.equal((await f.query(undefined, { expiresAt })).arkMsg, groupArk);
    assert.equal(f.calls[0].op, 'fixedShare'); assert.equal(f.calls[0].expectedEpoch, f.capture.epoch); assert.equal(f.calls[0].expectedUin, '11111');
    assert.deepEqual(f.calls[0].request, { groupId: '12345' }); assert.ok(f.calls[0].timeoutMs > 0 && f.calls[0].timeoutMs <= 2000);
    const result = await f.query({ operation: 'peer.ark', userId: 22222, phoneNumber: '123' });
    assert.equal(result.phoneNumber, '123'); assert.equal(result.userId, '22222'); assert.equal(result.arkMsg, ark);
});

test('actual native channel routes fixedShare through the exact serializers and correlated decoder', async () => {
    const capture = { epoch: 'channel-share', self: { uin: '11111' } }, sent = [], released = [], replies = new Map();
    const native = {
        resetSession() {}, install: () => ({ ok: true }), readTemplate: () => ({ haveTemplate: true }),
        send(command, hex) {
            const operation = command === 'OidbSvcTrpcTcp.0x8b7_5' ? 'group.ark' : 'peer.ark',
                request = operation === 'group.ark' ? { groupId: '12345' } : { userId: '22222', phoneNumber: '123' }, prepared = protocol.prepare(operation, request),
                requestId = String(sent.length + 1);
            assert.equal(command, prepared.name); assert.equal(hex, prepared.body.toString('hex'));
            sent.push({ command, requestId }); replies.set(requestId, response(prepared));
            return { ok: true, requestId };
        },
        readResponse(requestId) { return { requestId, result: 0, count: 1, body: [...replies.get(requestId)] }; },
        release(requestId) { released.push(requestId); }
    };
    const channel = createChannel({ loadNative: () => native });
    assert.equal((await channel.run(capture, { op: 'fixedShare', operation: 'group.ark', request: { groupId: '12345' }, expectedEpoch: capture.epoch, expectedUin: '11111' })).arkMsg, groupArk);
    assert.equal((await channel.run(capture, { op: 'fixedShare', operation: 'peer.ark', request: { userId: '22222', phoneNumber: '123' }, expectedEpoch: capture.epoch, expectedUin: '11111' })).arkMsg, ark);
    assert.deepEqual(sent.map(item => item.command), ['OidbSvcTrpcTcp.0x8b7_5', 'OidbSvcTrpcTcp.0x12b6_0']); assert.deepEqual(released, ['1', '2']);
});

test('QQ Ark adapter validates all requests before native work and refuses stale epochs, aborts or unavailable transport', async () => {
    const f = nativeFixture();
    for (const params of [{ operation: 'group.ark', groupId: 0 }, { operation: 'group.ark', groupId: 12345, raw: 'private' },
        { operation: 'peer.ark', userId: 22222, phoneNumber: null }, { operation: 'unknown' }]) await rejects(f.query(params), 'INVALID_PARAMS');
    await rejects(f.share.query({ operation: 'group.ark', groupId: 12345, expectedEpoch: 'old' }), 'SESSION_CHANGED');
    await rejects(f.query(undefined, { expiresAt: Date.now() - 1 }), 'EXPIRED');
    await rejects(f.query(undefined, { expiresAt: NaN }), 'INVALID_PARAMS');
    await rejects(f.query(undefined, { signal: AbortSignal.abort() }), 'EXPIRED');
    const params = { expectedEpoch: f.capture.epoch, groupId: 12345 };
    Object.defineProperty(params, 'operation', { get() { assert.fail('operation accessor must not run'); }, enumerable: true });
    await rejects(f.share.query(params), 'INVALID_PARAMS');
    f.native.available = () => false;
    assert.deepEqual(f.share.capabilities(), { groupArkShare: false, peerArkShare: false, arkShare: false });
    await rejects(f.query(), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
});

test('QQ Ark adapter rejects late completion after epoch, UID or session replacement and never retries errors', async () => {
    for (const change of [f => { f.capture.epoch = 'new'; }, f => { f.capture.self.uid = 'u_other'; }, f => { f.capture.session = {}; }]) {
        const f = nativeFixture(); let complete;
        f.overrides.run = params => new Promise(resolve => { complete = () => resolve(protocol.decode(response(protocol.prepare(params.operation, params.request)), protocol.prepare(params.operation, params.request))); });
        const task = f.query(); await turn(); change(f); complete(); await rejects(task, 'SESSION_CHANGED'); assert.equal(f.calls.length, 1);
    }
    const f = nativeFixture(); f.overrides.run = () => { throw error('KERNEL_ERROR'); };
    await rejects(f.query(), 'KERNEL_ERROR'); assert.equal(f.calls.length, 1);
    f.overrides.run = () => ({ operation: 'group.ark', groupId: '54321', arkMsg: groupArk });
    await rejects(f.query(), 'INVALID_RESPONSE'); assert.equal(f.calls.length, 2);
});

test('QQ Ark physical pending budget survives caller cancellation and session changes until native promises settle', async () => {
    const f = nativeFixture(), completions = [];
    f.capture.deadline = operation => { operation().catch(() => {}); return Promise.reject(error('TIMEOUT')); };
    f.overrides.run = params => new Promise(resolve => completions.push(() => {
        const prepared = protocol.prepare(params.operation, params.request); resolve(protocol.decode(response(prepared), prepared));
    }));
    for (let index = 0; index < MAX_PENDING; index++) await rejects(f.query(), 'TIMEOUT');
    assert.equal(f.calls.length, MAX_PENDING);
    f.capture.epoch = 'replacement'; f.capture.session = {};
    await rejects(f.query(), 'BUSY'); assert.equal(f.calls.length, MAX_PENDING);
    for (const complete of completions) complete(); await turn();
    f.capture.deadline = operation => operation(); f.overrides.run = undefined;
    assert.equal((await f.query()).arkMsg, groupArk); assert.equal(f.calls.length, MAX_PENDING + 1);
});

test('OneBot registry keeps Ark generation read-only and longnick requires both profile and signature capabilities', () => {
    assert.deepEqual([...ACTIONS], ['share_group_ex', 'send_group_ark_share', 'share_peer', 'send_ark_share', 'set_self_longnick']);
    assert.equal(READ_ONLY_ACTIONS.size, 4); assert.equal(READ_ONLY_ACTIONS.has('set_self_longnick'), false);
    assert.equal(EXTENSION_REQUIREMENTS.share_peer, 'arkShare'); assert.deepEqual(EXTENSION_REQUIREMENTS.set_self_longnick, ['selfProfile', 'selfSignature']);
});

test('group-only Ark names return the exact server string and peer names retain their object wrapper', async () => {
    for (const action of ['share_group_ex', 'send_group_ark_share']) {
        const f = actionFixture(); assert.equal(await f.invoke(action, { group_id: 12345 }), groupArk);
        assert.deepEqual(f.calls, [{ method: 'shareQuery', request: { operation: 'group.ark', groupId: '12345' } }]);
    }
    for (const action of ['share_peer', 'send_ark_share']) {
        const f = actionFixture(); assert.deepEqual(await f.invoke(action, { user_id: '22222', phone_number: '123' }), { arkMsg: ark });
        assert.deepEqual(f.calls, [{ method: 'shareQuery', request: { operation: 'peer.ark', userId: '22222', phoneNumber: '123' } }]);
        assert.deepEqual(await f.invoke(action, { group_id: 12345 }), { arkMsg: groupArk });
    }
});

test('peer Ark aliases use group precedence with two valid IDs and gate the selected branch independently', async () => {
    const f = actionFixture(); f.state.capabilities.peerArkShare = false;
    assert.deepEqual(await f.invoke('share_peer', { group_id: 12345, user_id: 22222 }), { arkMsg: groupArk });
    await rejects(f.invoke('share_peer', { user_id: 22222 }), 'UNSUPPORTED'); assert.equal(f.calls.length, 1);
    f.state.capabilities.groupArkShare = false; f.state.capabilities.peerArkShare = true;
    assert.deepEqual(await f.invoke('send_ark_share', { user_id: 22222 }), { arkMsg: ark });
    await rejects(f.invoke('send_ark_share', { group_id: 12345, user_id: 22222 }), 'UNSUPPORTED'); assert.equal(f.calls.length, 2);
    await rejects(f.invoke('share_peer', { group_id: 12345, user_id: null }), 'INVALID_PARAMS'); assert.equal(f.calls.length, 2);
});

test('Ark action parameter, identity and response mismatches fail before any send or successful fallback', async () => {
    for (const [action, params] of [['share_peer', {}], ['share_group_ex', {}], ['share_group_ex', { group_id: 12345, user_id: 22222 }],
        ['share_peer', { user_id: 22222, phone_number: 123 }], ['share_peer', { user_id: 22222, self_id: 33333 }],
        ['share_peer', { group_id: 12345, phone_number: null }], ['send_ark_share', { user_id: 22222, message: 'no send' }]]) {
        const f = actionFixture(); await rejects(f.invoke(action, params), 'INVALID_PARAMS'); assert.equal(f.calls.length, 0);
    }
    const f = actionFixture();
    for (const result of [{ operation: 'group.ark', groupId: '54321', arkMsg: groupArk }, { operation: 'peer.ark', groupId: '12345', arkMsg: ark },
        { operation: 'group.ark', groupId: '12345', arkMsg: '' }]) {
        f.overrides.shareQuery = () => result; await rejects(f.invoke('share_group_ex', { group_id: 12345 }), 'INVALID_RESPONSE');
    }
    assert.equal(f.calls.every(call => call.method === 'shareQuery'), true);
    const stale = actionFixture(); stale.overrides.shareQuery = request => { stale.deactivate(); return { ...request, arkMsg: ark }; };
    await rejects(stale.invoke('share_peer', { user_id: 22222 }), 'NOT_READY');
});

test('longnick accepts exact strings and empty clearing, gives longNick precedence and returns an empty object', async () => {
    for (const params of [{ longNick: 'New\nsignature' }, { long_nick: 'New\nsignature' }, { longNick: 'New\nsignature', long_nick: 'Ignored' }]) {
        const f = actionFixture(); assert.deepEqual(await f.invoke('set_self_longnick', params), {});
        assert.deepEqual(f.calls, [{ method: 'interaction', request: { operation: 'profile.update', personalNote: 'New\nsignature' } }]);
    }
    const f = actionFixture(); assert.deepEqual(await f.invoke('set_self_longnick', { longNick: '', long_nick: 'Ignored' }), {});
    assert.equal(f.calls[0].request.personalNote, '');
});

test('longnick validates both aliases, string bounds, parameter properties and all required capabilities before writing', async () => {
    for (const params of [{}, { longNick: null }, { long_nick: 123 }, { longNick: 'Valid', long_nick: false },
        { longNick: 'bad\0note' }, { longNick: '\ud800' }, { longNick: 'x'.repeat(4097) }, { long_nick: 'Valid', self_id: 33333 },
        { longNick: 'Valid', nickname: 'Unrequested' }]) {
        const f = actionFixture(); await rejects(f.invoke('set_self_longnick', params), 'INVALID_PARAMS'); assert.equal(f.calls.length, 0);
    }
    for (const flag of ['selfProfile', 'selfSignature']) {
        const f = actionFixture(); f.state.capabilities[flag] = false;
        await rejects(f.invoke('set_self_longnick', { longNick: 'Valid' }), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
    }
    const f = actionFixture(), params = {};
    Object.defineProperty(params, 'longNick', { get() { assert.fail('parameter getter must not execute'); }, enumerable: true });
    await rejects(f.invoke('set_self_longnick', params), 'INVALID_PARAMS');
    await rejects(f.invoke('unknown'), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
});

test('longnick requires exact account/value confirmation and never retries uncertain mutations', async () => {
    const bad = [undefined, { confirmed: true }, { confirmed: true, changed: true, uin: '33333', uid: 'u_self', personalNote: 'Valid', previous: { personalNote: 'Old' } },
        { confirmed: true, changed: true, uin: '11111', uid: 'u_other', personalNote: 'Valid', previous: { personalNote: 'Old' } },
        { confirmed: true, changed: true, uin: '11111', uid: 'u_self', personalNote: 'Wrong', previous: { personalNote: 'Old' } }];
    for (const result of bad) {
        const f = actionFixture(); f.overrides.interaction = () => result;
        await rejects(f.invoke('set_self_longnick', { longNick: 'Valid' }), 'INVALID_RESPONSE'); assert.equal(f.calls.length, 1);
    }
    const f = actionFixture(); f.overrides.interaction = () => { throw error('TIMEOUT'); };
    await rejects(f.invoke('set_self_longnick', { longNick: 'Valid' }), 'TIMEOUT'); assert.equal(f.calls.length, 1);
});

test('actual OneBot session calls, share protocol and profile adapter preserve one deadline and verified signature readback', async () => {
    const f = nativeFixture(), calls = [], deadlines = []; let signature = 'Old';
    f.capture.hasMethods = (service, methods) => service === 'profile' && methods.every(method => ['getCoreAndBaseInfo', 'setLongNick'].includes(method));
    f.capture.invoke = async (service, method, args) => {
        assert.equal(service, 'profile'); calls.push({ method, args });
        if (method === 'getCoreAndBaseInfo') return new Map([['u_self', { uid: 'u_self', uin: '11111', coreInfo: { uid: 'u_self' }, baseInfo: { longNick: signature } }]]);
        assert.equal(method, 'setLongNick'); signature = args[0]; return { result: 0 };
    };
    const interaction = createInteractions(f.capture), state = { ready: true, epoch: f.capture.epoch, self: f.capture.self,
        capabilities: { ...f.share.capabilities(), ...interaction.capabilities() } };
    const service = new OneBotService({ store: {}, backend: { async call(method, params, options) {
        if (method === 'status') return state;
        deadlines.push(Date.now() + options.timeoutMs);
        const context = { expiresAt: Date.now() + options.timeoutMs };
        if (method === 'shareQuery') return f.share.query(params, context);
        if (method === 'interaction') { const { operation, ...request } = params; return interaction.dispatch(operation, request, context); }
        assert.fail('Unexpected method ' + method);
    } } });
    const expiration = Date.now() + 15000, invoke = (action, params) => service.deadlines.run(expiration, () => runShareActions(service, state, action, params));
    assert.deepEqual(await invoke('send_ark_share', { user_id: 22222 }), { arkMsg: ark });
    assert.equal(f.calls[0].op, 'fixedShare'); assert.equal(f.calls[0].expectedEpoch, f.capture.epoch);
    assert.deepEqual(await invoke('set_self_longnick', { long_nick: 'New\nverified' }), {});
    assert.deepEqual(calls.map(call => call.method), ['getCoreAndBaseInfo', 'setLongNick', 'getCoreAndBaseInfo']);
    assert.equal(signature, 'New\nverified'); assert.ok(deadlines.every(deadline => Math.abs(deadline - expiration) < 20));
});

test('registered OneBot actions expose all five response contracts through the public service dispatcher', async () => {
    const f = actionFixture(), service = new OneBotService({ store: {}, backend: { async call(method, request) {
        if (method === 'status') return f.state;
        const { expectedEpoch, ...params } = request;
        assert.equal(expectedEpoch, f.state.epoch);
        return f.service.sessionCall(f.state, method, params);
    } } });
    for (const action of ['share_group_ex', 'send_group_ark_share']) {
        const result = await service.action({ action, params: { group_id: 12345 } }); assert.equal(result.retcode, 0, JSON.stringify(result)); assert.equal(result.data, groupArk);
    }
    for (const action of ['share_peer', 'send_ark_share']) {
        const result = await service.action({ action, params: { user_id: 22222 } }); assert.equal(result.retcode, 0, JSON.stringify(result)); assert.deepEqual(result.data, { arkMsg: ark });
    }
    const signature = await service.action({ action: 'set_self_longnick', params: { longNick: 'Public dispatch' } });
    assert.equal(signature.retcode, 0, JSON.stringify(signature)); assert.deepEqual(signature.data, {});
    assert.equal((await service.action({ action: 'share_peer', params: { user_id: 22222, self_id: 33333 } })).retcode, 1400);
    const status = await service.action({ action: 'get_capabilities' });
    for (const action of ACTIONS) assert.equal(status.data.extensions.find(item => item.name === action)?.available, true, action);
});
