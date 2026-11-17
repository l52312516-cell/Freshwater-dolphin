'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/forward-upload-protocol.cjs');
const { createForwardUpload, serverTimeSeconds, MAX_ATTEMPTS } = require('../src/qq/forward-upload.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { runForwardExtra, ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, UNSUPPORTED_ACTIONS } = require('../src/onebot/forward-extra-actions.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const join = (...parts) => Buffer.concat(parts);
const one = (map, field) => map.get(field)?.[0]?.value;
const map = value => p.fields(value);
const turn = () => new Promise(resolve => setImmediate(resolve));
const node = (content = '  原文😀\n\n', author = '11111') => ({ type: 'node', data: { user_id: author, nickname: '真实显示名', content } });
const uploadRequest = () => ({ selfUin: '11111', selfUid: 'u_self', nodes: [{ nickname: '真实显示名', texts: ['hello', '  😀\n'], sequence: '123', random: '456', time: '1794636400' }] });
const uploaded = (resId = 'actual-resource-from-QQ') => b(2, s(3, resId));
const readback = (payload, resId) => b(1, join(...(resId === undefined ? [] : [s(3, resId)]), b(4, gzipSync(payload))));
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
function serverNormalized(raw, change = nodes => nodes) {
    const nodes = change(protocol.decodePayload(raw).nodes);
    return b(2, join(s(1, 'MultiMsg'), b(2, join(...nodes.map(node => b(1, join(
        b(1, join(n(1, node.authorUin), s(2, node.authorUid ?? (node.authorUin === '11111' ? 'u_self' : 'u_author_' + node.authorUin)),
            b(7, join(s(6, node.nickname), n(11, 1))))),
        b(2, join(n(1, node.msgType), n(4, node.random), n(5, node.sequence), n(6, node.time),
            b(15, join(n(3, 2), b(4, Buffer.alloc(44, 1)), b(5, Buffer.alloc(154, 2)))))), b(3, node.body))))))));
}

test('fixed upload uses the real longmsg namespace, full text segments and no chat-send packet', () => {
    for (const groupId of [undefined, '22222']) {
        const request = uploadRequest(); if (groupId) request.groupId = groupId;
        const prepared = protocol.prepare('forward.upload', request), root = map(prepared.body), info = map(one(root, 2));
        assert.equal(prepared.name, 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
        assert.equal(one(info, 1), groupId ? 3n : 1n);
        assert.equal(one(map(one(info, 2)), 2).toString(), groupId || 'u_self');
        assert.equal(one(info, 3), groupId ? 22222n : undefined);
        const action = map(one(map(prepared.rawPayload), 2));
        assert.equal(one(action, 1).toString(), 'MultiMsg');
        const body = map(one(map(one(action, 2)), 1)), response = map(one(body, 1)), content = map(one(body, 2));
        assert.equal(one(response, 1), 11111n); assert.equal(one(response, 6).toString(), 'u_self');
        assert.equal(one(map(one(response, 7)), 6).toString(), '真实显示名');
        assert.equal(one(content, 5), 123n); assert.equal(one(content, 6), 1794636400n);
        const rich = map(one(map(one(body, 3)), 1));
        assert.deepEqual(rich.get(2).map(cell => one(map(one(map(cell.value), 1)), 1).toString()), ['hello', '  😀\n']);
    }
});

test('fixed receive scopes the real resource to self UID and only accepts the exact native resource echo', () => {
    const prepared = protocol.prepare('forward.readUploaded', { selfUid: 'u_self', resId: 'QQ-resource' });
    assert.equal(prepared.name, 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
    const info = map(one(map(prepared.body), 1));
    assert.equal(one(map(one(info, 1)), 2).toString(), 'u_self'); assert.equal(one(info, 2).toString(), 'QQ-resource');
    const raw = protocol.prepare('forward.upload', uploadRequest()).rawPayload;
    for (const echo of [undefined, 'QQ-resource']) assert.equal(protocol.decode(readback(raw, echo), prepared).payloadBase64, raw.toString('base64'));
    assert.throws(() => protocol.decode(readback(raw, 'other-resource'), prepared), { code: 'INVALID_RESPONSE' });
});

test('longmsg decode rejects absent, duplicate, empty, malformed, oversized and invalid UTF-8 resource IDs', () => {
    const prepared = protocol.prepare('forward.upload', uploadRequest());
    for (const body of [Buffer.alloc(0), b(2, Buffer.alloc(0)), uploaded(''), uploaded('resource with whitespace'),
        b(2, b(3, Buffer.from([0xff]))), join(uploaded(), uploaded()), b(2, join(s(3, 'one'), s(3, 'two'))),
        b(2, n(3, 1)), Buffer.alloc(protocol.MAX_BYTES + 1)]) assert.throws(() => protocol.decode(body, prepared), { code: 'INVALID_RESPONSE' });
    assert.deepEqual(protocol.decode(uploaded(), prepared), { operation: 'forward.upload', resId: 'actual-resource-from-QQ' });
});

test('uploaded readback rejects missing payload, invalid gzip and bounded decompression bombs', () => {
    const prepared = protocol.prepare('forward.readUploaded', { selfUid: 'u_self', resId: 'QQ-resource' });
    for (const body of [b(1, Buffer.alloc(0)), b(1, b(4, Buffer.alloc(0))), b(1, s(4, 'not-gzip')),
        readback(Buffer.alloc(protocol.MAX_BYTES + 1)), readback(Buffer.from([0xff])), readback(Buffer.alloc(0))]) assert.throws(() => protocol.decode(body, prepared), { code: 'INVALID_RESPONSE' });
});

test('protocol rejects raw packet injection, arbitrary commands, source impersonation fields and invalid display metadata', () => {
    const request = uploadRequest();
    assert.throws(() => protocol.prepare('anything', request), { code: 'UNSUPPORTED' });
    for (const value of [{ ...request, command: 'injected' }, { ...request, selfUin: 2 ** 53 }, { ...request, selfUid: '' }, { ...request, groupId: '0' },
        { ...request, nodes: [{ ...request.nodes[0], author: '22222' }] }, { ...request, nodes: [{ ...request.nodes[0], time: '0' }] },
        { ...request, nodes: [{ ...request.nodes[0], texts: Array(1001).fill('x') }] }, { ...request, nodes: [{ ...request.nodes[0], texts: ['x'.repeat(65537)] }] },
        { ...request, nodes: [request.nodes[0], request.nodes[0]] }]) assert.throws(() => protocol.prepare('forward.upload', value), { code: 'INVALID_PARAMS' });
});

function runtimeFixture() {
    const calls = [], overrides = {}, payloads = new Map(); let serial = 0;
    const capture = { epoch: 'upload-epoch', session: {}, self: { uin: '11111', uid: 'u_self' }, ensureReady() {}, hasMethods: () => true,
        deadline: operation => operation(), async invoke(service, method, args) { calls.push({ service, method, args }); return Object.hasOwn(overrides, 'time') ? overrides.time : '1794636400'; },
        async resolve(params) { calls.push({ method: 'resolve', params }); return overrides.resolve ? overrides.resolve(params) : { uin: params.uin, uid: 'u_author_' + params.uin }; } };
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, capture); calls.push(params);
        const prepared = protocol.prepare(params.operation, params.request);
        const perform = () => {
            if (params.operation === 'forward.upload') {
                const resId = 'server-resource-' + ++serial; payloads.set(resId, prepared.rawPayload);
                return protocol.decode(uploaded(resId), prepared);
            }
            const raw = payloads.get(params.request.resId);
            return protocol.decode(readback(overrides.payload ? overrides.payload(raw) : raw, params.request.resId), prepared);
        };
        return overrides.run ? overrides.run(params, perform) : perform();
    } };
    const api = createForwardUpload(capture, { native });
    const data = () => ({ expectedEpoch: capture.epoch, nodes: [{ nickname: 'self', texts: ['first', '  第二段😀\n'] }] });
    return { capture, native, api, calls, overrides, payloads, data, upload: (extra = {}, context = {}) => api.upload({ ...data(), ...extra }, context) };
}

test('resource upload returns only a real uploaded ID after complete semantic readback, with zero self-chat sends', async () => {
    const f = runtimeFixture(), value = await f.upload({ groupId: '22222' });
    assert.deepEqual(value, { uploaded: true, sent: false, confirmation: 'fixed-longmsg-resource-and-semantic-readback', resId: 'server-resource-1', nodeCount: 1, groupId: '22222' });
    assert.deepEqual(f.calls.map(call => call.operation || call.method), ['getServerTime', 'forward.upload', 'forward.readUploaded']);
    for (const call of f.calls.filter(row => row.op)) { assert.equal(call.op, 'fixedForwardUpload'); assert.equal(call.expectedEpoch, 'upload-epoch'); assert.equal(call.expectedUin, '11111'); assert.ok(call.timeoutMs > 0 && call.timeoutMs <= 10000); }
    assert.equal(JSON.stringify(value).includes('payload'), false); assert.equal(JSON.stringify(value).includes('u_self'), false);
});

test('different group namespaces obtain separate real resources; a duplicate entered upload is never retried', async () => {
    const f = runtimeFixture();
    assert.equal((await f.upload()).resId, 'server-resource-1');
    assert.equal((await f.upload({ groupId: '22222' })).resId, 'server-resource-2');
    const count = f.calls.length;
    await rejects(f.upload(), 'BUSY'); assert.equal(f.calls.length, count);
    f.capture.epoch = 'fresh-epoch'; assert.equal((await f.upload()).resId, 'server-resource-3');
});

test('resource errors do not return staged or invented IDs and never automatically repeat native upload', async () => {
    for (const failure of ['native', 'missing-id', 'wrong-operation', 'changed-content', 'wrong-readback-id']) {
        const f = runtimeFixture();
        f.overrides.run = (params, perform) => {
            if (params.operation === 'forward.upload') {
                if (failure === 'native') throw Object.assign(new Error('native failure'), { code: 'QUERY_FAILED' });
                if (failure === 'missing-id') return { operation: params.operation, resId: '' };
                if (failure === 'wrong-operation') return { operation: 'other', resId: 'invented' };
            }
            const value = perform();
            if (params.operation === 'forward.readUploaded') {
                if (failure === 'changed-content') value.payloadBase64 = b(2, Buffer.alloc(0)).toString('base64');
                if (failure === 'wrong-readback-id') value.resId = 'different';
            }
            return value;
        };
        await rejects(f.upload(), failure === 'native' ? 'QUERY_FAILED' : 'INVALID_RESPONSE');
        await rejects(f.upload(), 'BUSY');
        assert.equal(f.calls.filter(row => row.operation === 'forward.upload').length, 1);
    }
});

test('a caller timeout or epoch change does not free the physical upload reservation', async () => {
    const f = runtimeFixture(); let release, deadlines = 0;
    f.overrides.run = (params, perform) => params.operation === 'forward.upload' ? new Promise(resolve => { release = () => resolve(perform()); }) : perform();
    f.capture.deadline = operation => { if (++deadlines > 1) return operation(); operation().catch(() => {}); return Promise.reject(Object.assign(new Error('caller timeout'), { code: 'TIMEOUT' })); };
    await rejects(f.upload(), 'TIMEOUT'); await turn();
    f.capture.epoch = 'new-epoch';
    await rejects(f.upload(), 'BUSY');
    release(); await turn(); await turn();
    assert.equal(f.calls.filter(row => row.operation === 'forward.readUploaded').length, 0);
});

test('session changes after readback reject the uploaded result', async () => {
    const f = runtimeFixture();
    f.overrides.run = (params, perform) => { const value = perform(); if (params.operation === 'forward.readUploaded') f.capture.self.uid = 'u_other'; return value; };
    await rejects(f.upload(), 'SESSION_CHANGED');
});

test('malformed server time stops before resource upload and does not create a permanent attempt reservation', async () => {
    const f = runtimeFixture(); f.overrides.time = 'not-a-real-time';
    await rejects(f.upload(), 'INVALID_RESPONSE');
    assert.equal(f.calls.filter(row => row.op).length, 0);
    delete f.overrides.time;
    assert.equal((await f.upload()).uploaded, true);
});

test('server time failure diagnostics contain only closed type and range classes, never native values or object keys', async () => {
    for (const [value, shape] of [[1794636400000, 'primitive-number:milliseconds-range'], [1794636400000n, 'primitive-bigint:milliseconds-range'],
        [1794636400n, 'primitive-bigint:uint32'], ['private-time-text', 'primitive-string:not-exact-integer'],
        [{ privateField: 'private-native-value' }, 'object:not-exact-integer'], [null, 'other:not-exact-integer'], [undefined, 'undefined:not-exact-integer']]) {
        const f = runtimeFixture(); f.overrides.time = value;
        await assert.rejects(f.upload(), error => {
            assert.equal(error.code, 'INVALID_RESPONSE');
            assert.equal(error.message, 'QQ forward resource operation failed; phase=server-time-normalize; server_time=' + shape);
            assert.doesNotMatch(error.message, /179463640|privateField|private-native-value|private-time-text/); return true;
        });
        assert.equal(f.calls.filter(row => row.op).length, 0);
    }
    const f = runtimeFixture(); f.overrides.run = () => { throw Object.assign(new Error('private-server-resource'), { code: 'QUERY_FAILED' }); };
    await assert.rejects(f.upload(), error => { assert.equal(error.code, 'QUERY_FAILED'); assert.equal(error.message, 'QQ forward resource operation failed; phase=upload'); return true; });
});

test('observed QQ decimal millisecond time is converted exactly to uint32 seconds before upload', async () => {
    for (const [source, expected] of [['1794636400123', '1794636400'], ['1000000000000', '1000000000'], ['4294967295999', '4294967295'],
        ['1794636400', '1794636400'], [1794636400, '1794636400']]) {
        const f = runtimeFixture(); f.overrides.time = source; assert.equal((await f.upload()).uploaded, true);
        assert.ok(f.calls.find(call => call.operation === 'forward.upload').request.nodes.every(node => node.time === expected));
    }
    for (const source of ['4294967296000', '999999999999', '01794636400123', '1794636400123.0', '-1794636400123']) {
        const f = runtimeFixture(); f.overrides.time = source; await rejects(f.upload(), 'INVALID_RESPONSE');
        assert.equal(f.calls.filter(call => call.op).length, 0);
    }
});

test('aborts, expired requests, wrong epochs, malformed whole batches and unavailable methods fail before native work', async () => {
    for (const [extra, context, code] of [
        [{ expectedEpoch: 'wrong' }, {}, 'SESSION_CHANGED'], [{}, { expiresAt: Date.now() - 1 }, 'EXPIRED'],
        [{}, { signal: AbortSignal.abort() }, 'EXPIRED'], [{ nodes: [{ nickname: '', texts: ['x'] }] }, {}, 'INVALID_PARAMS'],
        [{ nodes: [{ nickname: 'first', texts: ['x'] }, { nickname: 'bad', texts: ['x'.repeat(65537)] }] }, {}, 'INVALID_PARAMS'],
        [{ rawPayload: 'injected' }, {}, 'INVALID_PARAMS']]) {
        const f = runtimeFixture(); await rejects(f.upload(extra, context), code); assert.equal(f.calls.length, 0);
    }
    const f = runtimeFixture(); f.capture.hasMethods = () => false;
    assert.equal(f.api.capabilities().forwardUpload, false); await rejects(f.upload(), 'UNSUPPORTED'); assert.equal(f.calls.length, 0);
});

test('QQ 3.2.35-54395 accepts only the observed server normalization through semantic readback', async () => {
    const f = runtimeFixture(); f.capture.qqVersion = '3.2.35-54395';
    f.overrides.payload = raw => serverNormalized(raw);
    assert.equal(f.api.capabilities().forwardUpload, true);
    for (const extra of [{}, { groupId: '22222' }]) assert.equal((await f.upload(extra)).uploaded, true);
    for (const raw of f.payloads.values()) assert.equal(raw.equals(serverNormalized(raw)), false);
    assert.equal(f.calls.filter(call => call.operation === 'forward.upload').length, 2);
    const unavailable = runtimeFixture(); unavailable.capture.qqVersion = '3.2.35-54395'; unavailable.native.available = () => false;
    assert.equal(unavailable.api.capabilities().forwardUpload, false);
    await rejects(unavailable.upload(), 'UNSUPPORTED'); assert.deepEqual(unavailable.calls, []);
});

test('distinct real authors resolve once and keep their display names, full text and supplied times', async () => {
    const f = runtimeFixture(); f.overrides.payload = raw => serverNormalized(raw);
    const nodes = [
        { authorUin: '22222', nickname: '  原作者😀  ', texts: ['  unchanged\n\n', 'second'], time: 1700000001 },
        { authorUin: 22222, nickname: 'same author', texts: ['third'], time: '1700000002' },
        { authorUin: '11111', nickname: 'self', texts: ['fourth'], time: 0 },
        { nickname: 'default self', texts: ['fifth'] }
    ];
    const original = structuredClone(nodes);
    assert.equal((await f.upload({ nodes })).nodeCount, 4);
    assert.deepEqual(nodes, original);
    assert.deepEqual(f.calls.filter(call => call.method === 'resolve').map(call => call.params), [{ uin: '22222' }]);
    const prepared = f.calls.find(call => call.operation === 'forward.upload').request.nodes;
    assert.deepEqual(prepared.map(node => node.time), ['1700000001', '1700000002', '1794636400', '1794636400']);
    assert.deepEqual(prepared.map(node => node.authorUin), ['22222', '22222', '11111', undefined]);
    assert.deepEqual(prepared.map(node => [node.nickname, node.texts]), original.map(node => [node.nickname, node.texts]));
});

test('author lookup failures and conflicts stop before upload and do not consume the content attempt', async () => {
    for (const response of [{ uin: '33333', uid: 'u_author_22222' }, { uin: '22222', uid: 'bad' },
        { uin: '22222', uid: 'u_self' }, { uin: { toString: () => '22222' }, uid: 'u_author_22222' }, null]) {
        const f = runtimeFixture(), nodes = [{ authorUin: '22222', nickname: 'author', texts: ['x'] }];
        f.overrides.resolve = () => response;
        await rejects(f.upload({ nodes }), 'INVALID_RESPONSE');
        assert.equal(f.calls.some(call => call.op || call.method === 'getServerTime'), false);
        delete f.overrides.resolve;
        assert.equal((await f.upload({ nodes })).uploaded, true);
    }
    const f = runtimeFixture(); f.capture.resolve = undefined;
    await rejects(f.upload({ nodes: [{ authorUin: '22222', nickname: 'author', texts: ['x'] }] }), 'UNSUPPORTED');
    assert.deepEqual(f.calls, []);
});

test('supplied author UIDs must match a real lookup and cannot bypass author resolution', async () => {
    for (const authorUin of ['11111', '22222']) {
        const f = runtimeFixture(), expected = authorUin === '11111' ? 'u_self' : 'u_author_22222';
        const nodes = [{ authorUin, authorUid: 'u_unverified', nickname: 'author', texts: ['x'] }];
        await rejects(f.upload({ nodes }), 'INVALID_PARAMS');
        assert.equal(f.calls.filter(call => call.method === 'resolve').length, authorUin === '11111' ? 0 : 1);
        assert.equal(f.calls.some(call => call.op), false);
        nodes[0].authorUid = expected;
        assert.equal((await f.upload({ nodes })).uploaded, true);
    }
    const f = runtimeFixture();
    const nodes = [{ authorUin: '22222', nickname: 'one', texts: ['x'] },
        { authorUin: '22222', authorUid: 'u_unverified', nickname: 'two', texts: ['y'] }];
    await rejects(f.upload({ nodes }), 'INVALID_PARAMS');
    assert.equal(f.calls.filter(call => call.method === 'resolve').length, 1);
    assert.equal(f.calls.some(call => call.op), false);
});

test('all one hundred distinct nonself authors can be verified within the bounded UID map', async () => {
    const f = runtimeFixture(); f.overrides.payload = raw => serverNormalized(raw);
    const nodes = Array.from({ length: 100 }, (_, index) => ({ authorUin: String(20000 + index), nickname: 'author ' + index, texts: ['x'] }));
    assert.equal((await f.upload({ nodes })).nodeCount, 100);
    assert.equal(f.calls.filter(call => call.method === 'resolve').length, 100);
    const f2 = runtimeFixture(); f2.overrides.resolve = params => ({ uin: params.uin, uid: 'u_shared' });
    await rejects(f2.upload({ nodes: nodes.slice(0, 2) }), 'INVALID_RESPONSE');
    assert.equal(f2.calls.some(call => call.op), false);
});

test('author, time and content changes are distinct attempts while equivalent default aliases remain reserved', async () => {
    const f = runtimeFixture();
    assert.equal((await f.upload()).uploaded, true);
    await rejects(f.upload({ nodes: [{ ...f.data().nodes[0], authorUin: '11111', authorUid: 'u_self', time: 0 }] }), 'BUSY');
    assert.equal((await f.upload({ nodes: [{ ...f.data().nodes[0], authorUin: '22222' }] })).uploaded, true);
    assert.equal((await f.upload({ nodes: [{ ...f.data().nodes[0], time: 1700000000 }] })).uploaded, true);
    assert.equal(f.calls.filter(call => call.operation === 'forward.upload').length, 3);
});

test('readback changes to author, time, full body, node count, order or unknown structure fail without retry', async () => {
    for (const alter of [
        nodes => { nodes[0].authorUin = '33333'; return nodes; },
        nodes => { nodes[0].authorUid = 'u_wrong'; return nodes; },
        nodes => { nodes[0].time = String(BigInt(nodes[0].time) + 1n); return nodes; },
        nodes => { nodes[0].body = b(1, b(2, b(1, s(1, 'changed')))); return nodes; },
        nodes => nodes.slice(0, 1), nodes => [...nodes, nodes[0]], nodes => nodes.reverse()
    ]) {
        const f = runtimeFixture(), nodes = [{ nickname: 'one', texts: ['  same\n'] }, { nickname: 'two', texts: ['second'] }];
        f.overrides.payload = raw => serverNormalized(raw, alter);
        await rejects(f.upload({ nodes }), 'INVALID_RESPONSE'); await rejects(f.upload({ nodes }), 'BUSY');
        assert.equal(f.calls.filter(call => call.operation === 'forward.upload').length, 1);
    }
    const f = runtimeFixture(); f.overrides.payload = raw => join(serverNormalized(raw), n(99, 1));
    await rejects(f.upload(), 'INVALID_RESPONSE'); await rejects(f.upload(), 'BUSY');
});

test('native readback payloads require canonical bounded base64 before decoding', async () => {
    for (const encoded of ['', null, '_w==', 'AB==', 'AAAAAA', 'AAAA====', '====', 'A'.repeat(4 * Math.ceil(protocol.MAX_BYTES / 3) + 4),
        Buffer.alloc(protocol.MAX_BYTES + 1).toString('base64')]) {
        const f = runtimeFixture();
        f.overrides.run = (params, perform) => { const value = perform(); if (params.operation === 'forward.readUploaded') value.payloadBase64 = encoded; return value; };
        await rejects(f.upload(), 'INVALID_RESPONSE'); await rejects(f.upload(), 'BUSY');
        assert.equal(f.calls.filter(call => call.operation === 'forward.upload').length, 1);
    }
    const f = runtimeFixture();
    f.overrides.run = (params, perform) => { const value = perform(); if (params.operation === 'forward.readUploaded') value.payloadBase64 += '\n'; return value; };
    await rejects(f.upload(), 'INVALID_RESPONSE');
});

test('abort, expiry and session changes during author lookup cannot enter a later upload', async () => {
    for (const reason of ['abort', 'expiry', 'epoch', 'session', 'uin', 'uid']) {
        const f = runtimeFixture(), controller = new AbortController(); let release;
        f.overrides.resolve = params => new Promise(resolve => { release = () => resolve({ uin: params.uin, uid: 'u_author_' + params.uin }); });
        const context = { signal: controller.signal, ...(reason === 'expiry' ? { expiresAt: Date.now() + 20 } : {}) };
        const task = f.upload({ nodes: [{ authorUin: '22222', nickname: 'author', texts: ['x'] }] }, context);
        await turn();
        if (reason === 'abort') controller.abort();
        if (reason === 'expiry') await new Promise(resolve => setTimeout(resolve, 30));
        if (reason === 'epoch') f.capture.epoch = 'changed';
        if (reason === 'session') f.capture.session = {};
        if (reason === 'uin') f.capture.self.uin = '33333';
        if (reason === 'uid') f.capture.self.uid = 'u_changed';
        release(); await rejects(task, ['abort', 'expiry'].includes(reason) ? 'EXPIRED' : 'SESSION_CHANGED');
        assert.equal(f.calls.some(call => call.op || call.method === 'getServerTime'), false);
    }
});

test('hung read-only preflight expires safely, frees its reservation and cannot upload from a late result', async t => {
    // Both deadlines share an absolute expiry but register in different turns.
    // Advance them together after the hung preflight has actually registered;
    // one real setImmediate after the outer timer is not an inner-timer barrier.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
    for (const phase of ['resolve', 'server-time']) for (const reason of ['timeout', 'abort', 'session']) {
        const f = runtimeFixture(), controller = new AbortController(); let release;
        f.capture.deadline = Capture.prototype.deadline; f.capture.pending = new Set();
        const nodes = [{ authorUin: '22222', nickname: 'author', texts: ['x'] }];
        if (phase === 'resolve') f.overrides.resolve = params => new Promise(resolve => { release = () => resolve({ uin: params.uin, uid: 'u_author_' + params.uin }); });
        else f.overrides.time = new Promise(resolve => { release = () => resolve('1794636400'); });
        const context = { signal: controller.signal, expiresAt: Date.now() + (reason === 'timeout' ? 30 : 60000) };
        const task = f.upload({ nodes }, context);
        const rejected = rejects(task, reason === 'timeout' ? 'TIMEOUT' : reason === 'abort' ? 'EXPIRED' : 'SESSION_CHANGED');
        await turn();
        assert.equal(f.capture.pending.size, 2, phase + ':' + reason + ' must enter the read-only preflight');
        if (reason === 'timeout') t.mock.timers.tick(30);
        if (reason === 'abort') controller.abort();
        if (reason === 'session') {
            f.capture.epoch = 'new-read-session';
            Capture.prototype.rejectPending.call(f.capture, Object.assign(new Error('QQ session changed'), { code: 'SESSION_CHANGED' }));
        }
        await rejected; await turn();
        assert.equal(f.calls.some(call => call.op), false);
        assert.equal(f.capture.pending.size, 0);
        delete f.overrides.resolve; delete f.overrides.time;
        assert.equal((await f.upload({ nodes })).uploaded, true, phase + ':' + reason);
        release(); await turn(); await turn();
        assert.equal(f.calls.filter(call => call.operation === 'forward.upload').length, 1, 'late preflight must never resume the expired upload');
        assert.equal(f.capture.pending.size, 0);
    }
});

test('the session attempt budget stays bounded and a new authenticated epoch starts a fresh budget', async () => {
    const f = runtimeFixture();
    for (let i = 1; i <= MAX_ATTEMPTS; i++) assert.equal((await f.upload({ groupId: String(i) })).uploaded, true);
    const calls = f.calls.length;
    await rejects(f.upload({ groupId: String(MAX_ATTEMPTS + 1) }), 'BUSY'); assert.equal(f.calls.length, calls);
    f.capture.epoch = 'fresh-epoch';
    assert.equal((await f.upload({ groupId: String(MAX_ATTEMPTS + 1) })).uploaded, true);
});

test('exported server time normalization accepts only exact QQ seconds or the observed millisecond string', () => {
    assert.equal(serverTimeSeconds('1794636400123'), '1794636400');
    assert.equal(serverTimeSeconds(1794636400), '1794636400');
    for (const value of [0, '0', '4294967296000', 1794636400123, 1794636400123n, '1794636400123.0', {}, null]) {
        assert.throws(() => serverTimeSeconds(value), { code: 'INVALID_PARAMS' });
    }
});

function publicFixture() {
    const state = { epoch: 'public-epoch', self: { uin: '11111', uid: 'u_self' }, capabilities: { forwardUpload: true, mergeCustom: true } };
    const calls = [], entries = new Map(), overrides = {};
    const service = { remaining: () => 60000, async assertSession() {}, store: {
        get: (_account, id) => entries.get(id), remember: (_account, record) => { const entry = { id: 7, record }; entries.set(7, entry); return entry; }
    }, async sessionCall(bound, method, params) {
        assert.equal(bound, state); calls.push({ method, params });
        if (overrides[method]) return overrides[method](params);
        if (method === 'forwardUpload') return { uploaded: true, sent: false, confirmation: 'fixed-longmsg-resource-and-semantic-readback', resId: 'real-upload-resource', nodeCount: params.nodes.length, ...(params.groupId ? { groupId: params.groupId } : {}) };
        if (method === 'resolve') return { uin: params.uin, uid: 'u_destination' };
        assert.equal(method, 'forwardOperation');
        const record = { ...params.destination, msgId: '18446744073709551000', msgSeq: '100', clientSeq: '200', msgTime: '1794636400',
            senderUin: '11111', senderUid: 'u_self', sendStatus: 2, elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'real-send-resource' } }] };
        return { confirmed: true, confirmation: 'fresh-source-tuple-and-resource-readback', destination: params.destination,
            nodeCount: params.nodes.length, resId: 'real-send-resource', messageId: record.msgId, record };
    } };
    return { state, service, calls, entries, overrides, run: (action, params = {}) => runForwardExtra(service, state, action, params) };
}

test('only the three real implementations enter implemented actions; summary remains explicitly unsupported', () => {
    assert.deepEqual([...ACTIONS], ['upload_forward_msg', 'upload_foward_msg', 'send_forward_msg']);
    assert.equal(EXTENSION_REQUIREMENTS.send_forward_msg, 'mergeCustom');
    assert.equal(typeof UNSUPPORTED_ACTIONS.get_msg_emoji_likes, 'string');
    assert.deepEqual([...READ_ONLY_ACTIONS], ['get_msg_emoji_likes']);
});

test('both upload names retain the historical group_id response difference and use message/messages aliases', async () => {
    for (const action of ['upload_forward_msg', 'upload_foward_msg']) {
        const f = publicFixture(), result = await f.run(action, { message: [node()], group_id: 22222 });
        assert.deepEqual(result, { message_id: 0, res_id: 'real-upload-resource', forward_id: 'real-upload-resource', ...(action === 'upload_forward_msg' ? { group_id: 22222 } : {}) });
        assert.deepEqual(f.calls.map(call => call.method), ['forwardUpload']);
        assert.deepEqual(f.calls[0].params, { nodes: [{ authorUin: '11111', nickname: '真实显示名', texts: ['  原文😀\n\n'] }], groupId: '22222' });
        assert.equal(f.entries.size, 0);
    }
});

test('send_forward_msg with no target uploads only; zero hints do not route a send', async () => {
    for (const params of [{}, { group_id: 0, user_id: 0 }]) {
        const f = publicFixture();
        f.state.capabilities.mergeCustom = false;
        assert.deepEqual(await f.run('send_forward_msg', { messages: [node()], ...params }), { message_id: 0, res_id: 'real-upload-resource', forward_id: 'real-upload-resource' });
        assert.deepEqual(f.calls.map(call => call.method), ['forwardUpload']);
    }
});

test('all upload-only variants preserve arbitrary validated authors and optional times for the runtime', async () => {
    for (const action of ['upload_forward_msg', 'upload_foward_msg', 'send_forward_msg']) {
        const f = publicFixture(), messages = [node('other', '33333'), node('zero'), node('missing')];
        messages[0].data.time = '1700000001'; messages[1].data.time = 0;
        const original = structuredClone(messages);
        assert.equal((await f.run(action, { messages })).res_id, 'real-upload-resource');
        assert.deepEqual(messages, original);
        assert.deepEqual(f.calls[0].params.nodes, [
            { authorUin: '33333', nickname: '真实显示名', texts: ['other'], time: 1700000001 },
            { authorUin: '11111', nickname: '真实显示名', texts: ['zero'], time: 0 },
            { authorUin: '11111', nickname: '真实显示名', texts: ['missing'] }
        ]);
        assert.equal(f.calls.length, 1);
    }
});

test('resource upload gates do not disable targeted merged sending or imply that no-target sending is available', async () => {
    for (const ready of [false, true]) for (const forwardUpload of [false, true]) for (const mergeCustom of [false, true]) {
        const inventory = capabilities({ qqVersion: '3.2.35-54395', ready, self: { uin: '11111', uid: 'u_self' }, capabilities: { forwardUpload, mergeCustom } });
        const action = name => inventory.extensions.find(entry => entry.name === name);
        assert.equal(action('send_forward_msg').available, ready && (forwardUpload || mergeCustom));
        assert.deepEqual(action('send_forward_msg').variants, { targeted_text_image_nodes: ready && mergeCustom, upload_only_text_nodes: ready && forwardUpload });
        for (const name of ['upload_forward_msg', 'upload_foward_msg']) assert.equal(action(name).available, ready && forwardUpload);
    }
    for (const [action, extra] of [['upload_forward_msg', {}], ['upload_foward_msg', { group_id: 22222 }],
        ['send_forward_msg', {}], ['send_forward_msg', { group_id: 0, user_id: 0 }]]) {
        const f = publicFixture(); f.state.capabilities.forwardUpload = false;
        await rejects(f.run(action, { messages: [node()], ...extra }), 'UNSUPPORTED');
        assert.deepEqual(f.calls, []); assert.equal(f.entries.size, 0);
    }
});

test('a targeted send validates its own merge capability before any resource or chat write', async () => {
    const f = publicFixture(); f.state.capabilities.mergeCustom = false;
    await rejects(f.run('send_forward_msg', { group_id: 22222, messages: [node()] }), 'UNSUPPORTED');
    assert.deepEqual(f.calls, []);
});

test('send_forward_msg returns the real resource on a confirmed group or private root', async () => {
    for (const params of [{ group_id: 22222 }, { message_type: 'group', group_id: 22222, user_id: 33333 }, { user_id: 33333 }, { message_type: 'private', user_id: 33333 }]) {
        const f = publicFixture(); f.state.capabilities.forwardUpload = false;
        const result = await f.run('send_forward_msg', { messages: [node()], ...params });
        assert.deepEqual(result, { message_id: 7, res_id: 'real-send-resource', forward_id: 'real-send-resource' });
        assert.equal(f.calls.filter(call => call.method === 'forwardUpload').length, 0);
        const sent = f.calls.find(call => call.method === 'forwardOperation'); assert.equal(sent.params.kind, 'customMerge');
        assert.deepEqual(sent.params.destination, params.group_id ? { chatType: 2, peerUid: '22222' } : { chatType: 1, peerUid: 'u_destination' });
    }
});

test('uploads reject unsupported image/ID nodes, foreign self_id, preview metadata and conflicting aliases before any QQ write', async () => {
    const png = 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    for (const [action, params, code] of [
        ['upload_forward_msg', { messages: [node()], message: [node()] }, 'INVALID_PARAMS'],
        ['upload_forward_msg', { messages: [{ type: 'node', data: { id: 7 } }] }, 'UNSUPPORTED'],
        ['upload_forward_msg', { messages: [node([{ type: 'image', data: { file: png } }])] }, 'UNSUPPORTED'],
        ['upload_forward_msg', { messages: [node()], self_id: 33333 }, 'INVALID_PARAMS'],
        ['upload_forward_msg', { messages: [node()], group_id: 2 ** 53 }, 'INVALID_PARAMS'],
        ['send_forward_msg', { messages: [node()], source: 'custom title', group_id: 22222 }, 'UNSUPPORTED'],
        ['send_forward_msg', { messages: [node()], message_type: 'group' }, 'INVALID_PARAMS'],
        ['send_forward_msg', { messages: [node()], message_type: 'private' }, 'INVALID_PARAMS'],
        ['send_forward_msg', { messages: [node()], message_type: 'other' }, 'INVALID_PARAMS'],
        ['upload_forward_msg', {}, 'INVALID_PARAMS']]) {
        const f = publicFixture(); await rejects(f.run(action, params), code); assert.deepEqual(f.calls, []);
    }
});

test('public upload requires exact node count, namespace, uploaded-only state and readback confirmation', async () => {
    for (const mutation of [value => { value.sent = true; }, value => { value.uploaded = false; }, value => { value.nodeCount = 2; },
        value => { value.confirmation = 'kernel_ack'; }, value => { value.confirmation = 'fixed-longmsg-resource-and-exact-readback'; },
        value => { value.groupId = '33333'; }, value => { value.resId = ''; }]) {
        const f = publicFixture(); f.overrides.forwardUpload = params => { const value = { uploaded: true, sent: false, nodeCount: params.nodes.length,
            confirmation: 'fixed-longmsg-resource-and-semantic-readback', resId: 'actual', groupId: params.groupId }; mutation(value); return value; };
        await rejects(f.run('upload_forward_msg', { messages: [node()], group_id: 22222 }), 'INVALID_RESPONSE');
        assert.equal(f.entries.size, 0); assert.equal(f.calls.length, 1);
    }
});

test('emoji summary cannot silently return a single emoji, an empty list or a fabricated last time', async () => {
    const f = publicFixture(); f.state.capabilities.messageEmojiSummary = true;
    for (const message_id of [7, -7]) await rejects(f.run('get_msg_emoji_likes', { message_id }), 'UNSUPPORTED');
    for (const params of [{ message_id: 0 }, { message_id: '18446744073709551000' }, { message_id: 7, emoji_id: '76' }]) await rejects(f.run('get_msg_emoji_likes', params), 'INVALID_PARAMS');
    assert.deepEqual(f.calls, []);
});
