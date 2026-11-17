'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/forward-upload-protocol.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { createForwardResourceRead } = require('../src/qq/forward-resource-read.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const join = (...parts) => Buffer.concat(parts);
const turn = () => new Promise(resolve => setImmediate(resolve));
const textBody = (...texts) => b(1, join(...texts.map(text => b(2, b(1, s(1, text))))));
function imageElement(size = 70, business = 20) {
    const file = join(n(1, size), s(2, 'ABCDEF1234567890ABCDEF1234567890'), s(4, 'wire.png'), b(5, join(n(1, 1), n(2, 1001))), n(6, 12), n(7, 13));
    const index = join(b(1, file), s(2, 'wire-uuid'));
    const pic = s(1, 'https://multimedia.nt.qq.com.cn/download?appid=' + (business === 10 ? '1406' : '1407') + '&fileid=wire-resource');
    return b(53, join(n(1, 48), b(2, join(b(1, join(b(1, index), b(2, pic))), b(2, b(1, Buffer.alloc(0))))), n(3, business)));
}
const node = (changes = {}) => ({ authorUin: '22222', authorUid: 'u_other', nickname: '  实际显示名😀  ', time: '1700000001',
    random: '123', sequence: '456', body: textBody('  第一段\n\n', '完整😀'), ...changes });
function encodeNode(value, variant) {
    const head = join(n(1, value.authorUin), ...(value.authorUid === undefined ? [s(6, 'u_recipient')] : [s(2, value.authorUid)]),
        b(7, join(s(6, value.nickname), n(11, 1))));
    const fixed = join(n(1, 9), n(2, 4), n(3, 0), n(4, value.random), n(5, value.sequence), n(6, value.time));
    const reserve = join(n(1, 0), n(2, 0), n(3, 2), b(4, Buffer.alloc(44, 1)), b(5, Buffer.alloc(158, 2)));
    const native = join(n(1, 9), n(2, 175), n(3, 175), n(4, value.random), n(5, value.sequence), n(6, value.time),
        n(7, 1), n(11, '18446744073709551615'), b(15, reserve));
    return join(b(1, head), b(2, variant === 'native' ? native : fixed), b(3, value.body));
}
const payload = (nodes, variant = 'fixed') => b(2, join(s(1, 'MultiMsg'), b(2, join(...nodes.map(value => b(1, encodeNode(value, variant)))))));
const response = (raw, resId = 'synthetic-resource') => b(1, join(s(3, resId), b(4, gzipSync(raw))));
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);
function fixture({ variant = 'fixed', nodes = [node()] } = {}) {
    const calls = [], overrides = {};
    const capture = { epoch: 'read-epoch', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, hasMethods: () => true, deadline: Capture.prototype.deadline,
        async invoke(service, method, args) {
            assert.equal(service, 'msg'); assert.equal(method, 'getMsgsByMsgId');
            calls.push({ kind: 'root', service, method, args });
            const root = { result: 0, msgList: [{ msgId: '18446744073709551615', chatType: 2, peerUid: '33333',
                elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'synthetic-resource' } }] }] };
            return overrides.root ? overrides.root(root) : root;
        },
        async resolve(params) {
            calls.push({ kind: 'author', params });
            const value = { uin: params.uin, uid: params.uin === '22222' ? 'u_other' : 'u_author_' + params.uin };
            return overrides.resolve ? overrides.resolve(value, params) : value;
        } };
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, capture); calls.push({ kind: 'resource', params });
        const expected = protocol.prepare('forward.readUploaded', { selfUid: 'u_self', resId: 'synthetic-resource' });
        assert.equal(params.op, 'rawPacket'); assert.equal(params.cmd, expected.name); assert.equal(params.data, expected.body.toString('hex'));
        assert.equal(params.rsp, true); assert.equal(params.expectedEpoch, 'read-epoch'); assert.equal(params.expectedUin, '11111');
        assert.ok(Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 && params.timeoutMs <= 60000);
        const value = { responseHex: response(payload(nodes, variant)).toString('hex') };
        return overrides.raw ? overrides.raw(value) : value;
    } };
    const params = () => ({ peer: { chatType: 2, peerUid: '33333' }, rootMsgId: '18446744073709551615',
        parentMsgId: '18446744073709551615', resId: 'synthetic-resource', expectedEpoch: capture.epoch });
    const api = createForwardResourceRead(capture, { native });
    return { capture, native, api, calls, overrides, params, read: (extra = {}, context = {}) => api.read({ ...params(), ...extra }, context),
        readCustom: (extra = {}, context = {}) => api.readCustom({ ...params(), ...extra }, context) };
}

const fromEncodedNodes = (...values) => b(2, join(s(1, 'MultiMsg'), b(2, join(...values.map(value => b(1, value))))));
function replaceMetadata(raw, transform) {
    const fields = p.fields(raw);
    return join(b(1, fields.get(1)[0].value), b(2, transform(fields.get(2)[0].value)), b(3, fields.get(3)[0].value));
}

test('custom probe returns authoritative complete metadata, including server-omitted default fields', async () => {
    for (const omitted of [false, true]) {
        const f = fixture();
        if (omitted) {
            const encoded = replaceMetadata(encodeNode(node(), 'fixed'), () => join(n(1, 9), n(4, 123), n(5, 456), n(6, 1700000001)));
            f.overrides.raw = () => ({ responseHex: response(fromEncodedNodes(encoded)).toString('hex') });
        }
        const result = await f.readCustom();
        assert.equal(result.resourceNodes[0].nickname, node().nickname);
        assert.equal(result.resourceNodes[0].time, node().time);
        assert.equal(Object.hasOwn(result.resourceNodes[0], 'msgId'), false);
        assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource', 'author']);
    }
});

test('native 175 and unknown schemas bypass strict rich, author, 100-node and 256 KiB custom limits', async () => {
    const rich = b(1, b(2, b(99, Buffer.alloc(4096, 1))));
    const f = fixture({ variant: 'native', nodes: Array.from({ length: 1000 }, () => node({ body: rich })) });
    assert.ok(payload(Array.from({ length: 1000 }, () => node({ body: rich })), 'native').length > protocol.MAX_BYTES);
    assert.equal(await f.readCustom(), null);
    assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource']);
    for (const meta of [join(n(1, 82), n(2, 73)), join(n(1, 9), n(3, 175)), join(n(1, 9), n(2, 175), n(3, 175))]) {
        const unknown = fixture();
        const encoded = replaceMetadata(encodeNode(node(), 'fixed'), () => meta);
        unknown.overrides.raw = () => ({ responseHex: response(fromEncodedNodes(encoded)).toString('hex') });
        assert.equal(await unknown.readCustom(), null);
        assert.equal(unknown.calls.some(call => call.kind === 'author'), false);
    }
});

test('any recognized custom node latches strict validation across mixed or malformed siblings and envelope tails', async () => {
    const custom = encodeNode(node(), 'fixed'), native = encodeNode(node(), 'native');
    const malformed = replaceMetadata(custom, () => Buffer.from([0x0f]));
    const duplicate = replaceMetadata(custom, meta => join(meta, n(2, 175)));
    const badSubtype = replaceMetadata(custom, () => join(n(1, 9), s(2, 'bad wire')));
    const truncatedMeta = replaceMetadata(custom, () => join(n(1, 9), Buffer.from([0x80])));
    const cases = [fromEncodedNodes(native, custom), fromEncodedNodes(custom, native), fromEncodedNodes(malformed, custom),
        fromEncodedNodes(custom, malformed), fromEncodedNodes(duplicate), fromEncodedNodes(badSubtype), fromEncodedNodes(truncatedMeta),
        join(fromEncodedNodes(custom), n(99, 1)), join(fromEncodedNodes(custom), Buffer.from([0x80]))];
    for (const raw of cases) {
        const f = fixture(); f.overrides.raw = () => ({ responseHex: response(raw).toString('hex') });
        await rejectCode(f.readCustom(), 'INVALID_RESPONSE');
        assert.equal(f.calls.some(call => call.kind === 'author'), false);
    }
});

test('recognized custom resources fail closed on unsupported rich content and custom bounds', async () => {
    const cases = [
        { nodes: [node(), node({ body: b(1, b(2, b(99, Buffer.from([1])))) })], code: 'UNSUPPORTED' },
        { nodes: Array.from({ length: 101 }, () => node()), code: 'INVALID_RESPONSE' },
        { nodes: [node({ body: textBody('x'.repeat(protocol.MAX_BYTES + 1)) })], code: 'INVALID_RESPONSE' }
    ];
    for (const item of cases) {
        const f = fixture({ nodes: item.nodes }); await rejectCode(f.readCustom(), item.code);
        assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource']);
    }
    const envelope = fixture();
    envelope.overrides.raw = () => ({ responseHex: join(response(payload([node()])), b(99, Buffer.alloc(protocol.MAX_BYTES))).toString('hex') });
    await rejectCode(envelope.readCustom(), 'INVALID_RESPONSE');
    assert.equal(envelope.calls.some(call => call.kind === 'author'), false);
    const malformedEnvelope = fixture();
    malformedEnvelope.overrides.raw = () => ({ responseHex: join(response(payload([node()])), Buffer.from([0x80])).toString('hex') });
    await rejectCode(malformedEnvelope.readCustom(), 'INVALID_RESPONSE');
});

test('custom probing accepts the existing single-descriptor root shape but rejects changed identity and resource echo', async () => {
    const extra = fixture();
    extra.overrides.root = root => { root.msgList[0].elements.push({ elementType: 1, textElement: { content: 'root text' } }); return root; };
    assert.equal((await extra.readCustom()).resourceNodes.length, 1);
    for (const kind of ['peer', 'id', 'resource', 'epoch', 'echo']) {
        const f = fixture();
        if (kind === 'echo') f.overrides.raw = () => ({ responseHex: response(payload([node()], 'native'), 'different-resource').toString('hex') });
        else f.overrides.root = root => {
            if (kind === 'peer') root.msgList[0].peerUid = '99999';
            if (kind === 'id') root.msgList[0].msgId = '123';
            if (kind === 'resource') root.msgList[0].elements[0].multiForwardMsgElement.resId = 'different-resource';
            if (kind === 'epoch') f.capture.epoch = 'changed';
            return root;
        };
        await rejectCode(f.readCustom(), kind === 'epoch' ? 'SESSION_CHANGED' : 'INVALID_RESPONSE');
        assert.equal(f.calls.some(call => call.kind === 'author'), false);
        if (kind !== 'echo') assert.equal(f.calls.some(call => call.kind === 'resource'), false);
    }
    const unavailable = fixture(); unavailable.native.available = () => false;
    assert.equal(await unavailable.readCustom(), null);
});

test('custom probes retain cancellation and session failures rather than reclassifying them as native resources', async () => {
    for (const reason of ['timeout', 'abort', 'session']) {
        const f = fixture({ variant: 'native' }), controller = new AbortController(); let release, started;
        const entered = new Promise(resolve => { started = resolve; });
        f.overrides.raw = value => new Promise(resolve => { release = () => resolve(value); started(); });
        const result = f.readCustom({}, { signal: controller.signal, expiresAt: Date.now() + (reason === 'timeout' ? 40 : 2000) });
        result.catch(() => {}); await entered;
        if (reason === 'abort') controller.abort();
        if (reason === 'session') {
            f.capture.epoch = 'new-epoch'; f.capture.session = {};
            Capture.prototype.rejectPending.call(f.capture, Object.assign(Error('private'), { code: 'SESSION_CHANGED' }));
        }
        await assert.rejects(result, error => {
            if (reason === 'timeout') assert.ok(['TIMEOUT', 'EXPIRED'].includes(error.code));
            else assert.equal(error.code, reason === 'abort' ? 'EXPIRED' : 'SESSION_CHANGED');
            return true;
        });
        const count = f.calls.length; release(); await turn(); await turn();
        assert.equal(f.calls.length, count); assert.equal(f.capture.pending.size, 0);
    }
});

test('fixed 9/4 and observed native 9/175 resources preserve ordered display nodes without native message IDs', async () => {
    for (const variant of ['fixed', 'native']) {
        const nodes = [node(), node({ authorUin: '11111', authorUid: 'u_self', nickname: 'self', time: '1700000002',
            random: variant === 'native' ? '0' : '789', sequence: variant === 'native' ? '0' : '987', body: textBody('self text') }), node()];
        const f = fixture({ variant, nodes }), result = await f.read();
        assert.deepEqual(result, { peer: f.params().peer, rootMsgId: f.params().rootMsgId, parentMsgId: f.params().parentMsgId,
            resId: 'synthetic-resource', resourceNodes: nodes.map(value => ({ authorUin: value.authorUin, authorUid: value.authorUid,
                nickname: value.nickname, time: value.time, elements: value.authorUin === '11111' ?
                    [{ elementType: 1, textElement: { content: 'self text', atType: 0 } }] :
                    ['  第一段\n\n', '完整😀'].map(content => ({ elementType: 1, textElement: { content, atType: 0 } })) })) });
        assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource', 'author']);
        assert.deepEqual(f.calls[0].args, [{ chatType: 2, peerUid: '33333', guildId: '' }, ['18446744073709551615']]);
        for (const value of result.resourceNodes) assert.equal(Object.hasOwn(value, 'msgId'), false);
        assert.equal(f.capture.pending.size, 0);
        assert.equal(f.calls.find(call => call.kind === 'resource').params.signal.aborted, true);
    }
});

test('a fixed recipient UID is never reused as the author UID', async () => {
    const f = fixture({ nodes: [node({ authorUid: undefined })] }), result = await f.read();
    assert.equal(result.resourceNodes[0].authorUid, 'u_other');
    assert.deepEqual(f.calls.find(call => call.kind === 'author').params, { uin: '22222' });
});

test('fixed and native resources preserve exact NT image metadata, text order and deliberate repeated pictures', async () => {
    for (const variant of ['fixed', 'native']) for (const business of [10, 20]) {
        const body = b(1, join(b(2, imageElement(70, business)), b(2, b(1, s(1, 'middle'))), b(2, imageElement(70, business))));
        const f = fixture({ variant, nodes: [node({ body })] }), result = await f.read(), elements = result.resourceNodes[0].elements;
        assert.deepEqual(elements.map(element => element.elementType), [2, 1, 2]);
        assert.equal(elements[1].textElement.content, 'middle');
        assert.deepEqual(elements[0].picElement, { md5HexStr: 'abcdef1234567890abcdef1234567890', fileSize: '70', picWidth: 12,
            picHeight: 13, originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=' + (business === 10 ? '1406' : '1407') + '&fileid=wire-resource',
            fileName: 'wire.png', fileUuid: 'wire-uuid', picType: 1001 });
        assert.deepEqual(elements[0], elements[2]);
        elements[0].picElement.fileName = 'changed'; assert.equal(elements[2].picElement.fileName, 'wire.png');
    }
});

test('private Ark roots bind the exact resource and only the closed receive command is dispatched', async () => {
    const f = fixture();
    f.overrides.root = root => { root.result = '0'; root.msgList[0].chatType = 1; root.msgList[0].peerUid = 'u_friend';
        root.msgList[0].elements = [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg',
            meta: { detail: { resid: 'synthetic-resource' } } }) } }]; return root; };
    const result = await f.read({ peer: { chatType: 1, peerUid: 'u_friend' } });
    assert.deepEqual(result.peer, { chatType: 1, peerUid: 'u_friend' });
    assert.equal(f.calls.filter(call => call.kind === 'resource').length, 1);
    assert.equal(f.calls.some(call => /send|upload|getMultiMsg/.test(call.method || '')), false);
});

test('caller packet fields, inexact IDs, nested parents and stale epochs reject before native reads', async () => {
    const cases = [
        [{ cmd: 'injected' }, 'INVALID_PARAMS'], [{ data: '00' }, 'INVALID_PARAMS'], [{ nodes: [] }, 'INVALID_PARAMS'],
        [{ rootMsgId: 123 }, 'INVALID_PARAMS'], [{ rootMsgId: '18446744073709551616' }, 'INVALID_PARAMS'],
        [{ parentMsgId: '123' }, 'UNSUPPORTED'], [{ parentMsgId: '0' }, 'INVALID_PARAMS'],
        [{ peer: { chatType: 2, peerUid: 33333 } }, 'INVALID_PARAMS'], [{ peer: { chatType: 2, peerUid: '4294967296' } }, 'INVALID_PARAMS'],
        [{ peer: { chatType: 1, peerUid: '22222' } }, 'INVALID_PARAMS'], [{ resId: 'bad resource' }, 'INVALID_PARAMS'],
        [{ expectedEpoch: 'old' }, 'SESSION_CHANGED']
    ];
    for (const [params, code] of cases) { const f = fixture(); await rejectCode(f.read(params), code); assert.equal(f.calls.length, 0); }
    const f = fixture(), accessor = f.params(); Object.defineProperty(accessor, 'resId', { get() { throw Error('private'); } });
    await rejectCode(f.api.read(accessor), 'INVALID_PARAMS'); assert.equal(f.calls.length, 0);
});

test('missing native/root methods and expired requests fail before root lookup', async () => {
    for (const kind of ['native', 'method', 'expired', 'cancelled', 'deadline']) {
        const f = fixture(), context = {}, controller = new AbortController();
        if (kind === 'native') f.native.available = () => false;
        if (kind === 'method') f.capture.hasMethods = () => false;
        if (kind === 'expired') context.expiresAt = Date.now() - 1;
        if (kind === 'cancelled') { controller.abort(); context.signal = controller.signal; }
        if (kind === 'deadline') context.expiresAt = Infinity;
        await rejectCode(f.read({}, context), ['native', 'method'].includes(kind) ? 'UNSUPPORTED' : kind === 'deadline' ? 'INVALID_PARAMS' : 'EXPIRED');
        assert.equal(f.calls.length, 0);
    }
});

test('every native root binding is checked before reading any raw resource', async () => {
    const changes = [root => { delete root.result; }, root => { root.result = 1; }, root => { root.msgList = []; },
        root => { root.msgList.push(root.msgList[0]); }, root => { root.msgList[0].msgId = '123'; },
        root => { root.msgList[0].msgId = Number(root.msgList[0].msgId); }, root => { root.msgList[0].chatType = 1; },
        root => { root.msgList[0].peerUid = '44444'; }, root => { root.msgList[0].elements[0].multiForwardMsgElement.resId = 'different'; },
        root => { root.msgList[0].elements.push({ elementType: 1, textElement: { content: 'extra' } }); },
        root => { root.msgList[0].elements[0].textElement = { content: 'ambiguous' }; }];
    for (const change of changes) {
        const f = fixture(); f.overrides.root = root => { change(root); return root; };
        await assert.rejects(f.read(), error => ['INVALID_RESPONSE', 'NOT_FOUND', 'KERNEL_ERROR'].includes(error.code));
        assert.deepEqual(f.calls.map(call => call.kind), ['root']);
    }
});

test('resource echo, exact bounded hex, gzip and strict schemas reject malformed responses', async () => {
    const validPayload = payload([node()]);
    const malformed = [undefined, null, '', '0', 'gg', '00'.repeat(protocol.MAX_BYTES + 1),
        response(validPayload, 'different').toString('hex'), b(1, s(4, 'not gzip')).toString('hex'),
        response(Buffer.alloc(protocol.MAX_BYTES + 1)).toString('hex'), response(join(validPayload, n(99, 1))).toString('hex'),
        response(payload([])).toString('hex'), response(payload(Array(101).fill(node()))).toString('hex')];
    for (const responseHex of malformed) {
        const f = fixture(); f.overrides.raw = () => ({ responseHex });
        await rejectCode(f.read(), 'INVALID_RESPONSE');
        assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource']);
    }
});

test('author resolution rejects different UINs, malformed UIDs, raw UID conflicts and colliding accounts', async () => {
    for (const resolved of [{ uin: '33333', uid: 'u_other' }, { uin: '22222', uid: '22222' }, { uin: '22222', uid: 'u_self' },
        { uin: '22222', uid: 'u_different' }, { uin: 22222n, uid: 'u_other' }]) {
        const f = fixture(); f.overrides.resolve = () => resolved; await rejectCode(f.read(), 'INVALID_RESPONSE');
    }
    const selfConflict = fixture({ nodes: [node({ authorUin: '11111', authorUid: 'u_other' })] });
    await rejectCode(selfConflict.read(), 'INVALID_RESPONSE'); assert.equal(selfConflict.calls.filter(call => call.kind === 'author').length, 0);
    const collision = fixture({ nodes: [node(), node({ authorUin: '33333', authorUid: 'u_other' })] });
    collision.overrides.resolve = (_, params) => ({ uin: params.uin, uid: 'u_other' });
    await rejectCode(collision.read(), 'INVALID_RESPONSE');
    const unavailable = fixture(); unavailable.capture.resolve = undefined; await rejectCode(unavailable.read(), 'UNSUPPORTED');
});

test('unknown rich elements fail the whole resource without partial nodes or author lookup', async () => {
    const f = fixture({ nodes: [node(), node({ body: b(1, b(2, b(99, Buffer.from([1])))) })] });
    await rejectCode(f.read(), 'UNSUPPORTED');
    assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource']);
});

test('resource-wide element, text and image budgets cannot be multiplied across individual nodes', async () => {
    const cases = [
        [node({ body: textBody(...Array(501).fill('x')) }), node({ body: textBody(...Array(501).fill('x')) })],
        [node({ body: textBody('x'.repeat(32769)) }), node({ body: textBody('x'.repeat(32769)) })],
        [node({ body: b(1, b(2, imageElement(6 * 1024 * 1024))) }), node({ body: b(1, b(2, imageElement(6 * 1024 * 1024))) })]
    ];
    for (const nodes of cases) {
        const f = fixture({ nodes }); await rejectCode(f.read(), 'INVALID_RESPONSE');
        assert.deepEqual(f.calls.map(call => call.kind), ['root', 'resource']);
    }
});

test('decoded resource JSON cannot expand beyond its 256 KiB output bound', async () => {
    const f = fixture({ nodes: [node({ body: textBody('\u0001'.repeat(50000)) })] });
    await rejectCode(f.read(), 'INVALID_RESPONSE');
});

test('one hundred distinct authors are resolved exactly once within a read, with no cross-read cache', async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => node({ authorUin: String(20000 + index), authorUid: 'u_author_' + (20000 + index) }));
    const f = fixture({ nodes }); f.overrides.resolve = (_, params) => ({ uin: params.uin, uid: 'u_author_' + params.uin });
    assert.equal((await f.read()).resourceNodes.length, 100);
    assert.equal(f.calls.filter(call => call.kind === 'author').length, 100);
    await f.read(); assert.equal(f.calls.filter(call => call.kind === 'author').length, 200);
});

test('native errors cross a fixed privacy boundary and reads are never retried automatically', async () => {
    for (const stage of ['root', 'raw', 'resolve']) {
        const f = fixture(); f.overrides[stage] = () => { throw Object.assign(Error('private text/resource/bytes'), { code: 'QUERY_FAILED', responseHex: 'secret' }); };
        await assert.rejects(f.read(), error => { assert.equal(error.code, 'QUERY_FAILED'); assert.match(error.message, /^QQ forward resource reading failed; phase=(root|resource|authors)$/);
            assert.equal(error.responseHex, undefined); assert.equal(error.message.includes('private'), false); return true; });
        assert.equal(f.calls.filter(call => call.kind === (stage === 'raw' ? 'resource' : stage === 'resolve' ? 'author' : stage)).length, 1);
    }
});

test('hung root, native packet and author reads share timeout/abort/session cancellation and cannot continue late', async () => {
    for (const stage of ['root', 'raw', 'resolve']) for (const reason of ['timeout', 'abort', 'session']) {
        const f = fixture(), controller = new AbortController(); let release, started;
        const entered = new Promise(resolve => { started = resolve; });
        f.overrides[stage] = value => new Promise(resolve => { release = () => resolve(value); started(); });
        const result = f.read({}, { signal: controller.signal, expiresAt: Date.now() + (reason === 'timeout' ? 40 : 2000) });
        result.catch(() => {}); await entered;
        if (reason === 'abort') controller.abort();
        if (reason === 'session') { f.capture.session = {}; f.capture.epoch = 'new-epoch';
            Capture.prototype.rejectPending.call(f.capture, Object.assign(Error('private session error'), { code: 'SESSION_CHANGED' })); }
        await rejectCode(result, reason === 'timeout' ? 'TIMEOUT' : reason === 'abort' ? 'EXPIRED' : 'SESSION_CHANGED');
        assert.equal(f.capture.pending.size, 0);
        const count = f.calls.length; release(); await turn(); await turn(); assert.equal(f.calls.length, count, stage + ' late continuation');
        const nativeCall = f.calls.find(call => call.kind === 'resource'); if (nativeCall) assert.equal(nativeCall.params.signal.aborted, true);
    }
});

test('same-epoch identity/session changes after successful native awaits still suppress the result', async () => {
    for (const field of ['session', 'uin', 'uid']) {
        const f = fixture(); f.overrides.raw = value => {
            if (field === 'session') f.capture.session = {}; else f.capture.self[field] = field === 'uin' ? '99999' : 'u_new'; return value;
        };
        await rejectCode(f.read(), 'SESSION_CHANGED'); assert.equal(f.calls.some(call => call.kind === 'author'), false);
    }
});

test('mutating one returned node does not affect another node or a later fresh read', async () => {
    const f = fixture({ nodes: [node(), node()] }), first = await f.read();
    first.resourceNodes[0].elements[0].textElement.content = 'changed';
    first.peer.peerUid = 'changed';
    assert.equal(first.resourceNodes[1].elements[0].textElement.content, '  第一段\n\n');
    const second = await f.read(); assert.equal(second.peer.peerUid, '33333');
    assert.equal(second.resourceNodes[0].elements[0].textElement.content, '  第一段\n\n');
});
