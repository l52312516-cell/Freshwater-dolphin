'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createForward, descriptor } = require('../src/qq/forward.cjs');
const { createForwardRegistry, runForward } = require('../src/onebot/forward.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = '18446744073709551610';
const CHILD = '18446744073709551609';
const SOURCE = { chatType: 2, peerUid: '2000000001' };
const DESTINATION = { chatType: 1, peerUid: 'u_destination' };
const state = () => ({ ready: true, epoch: 'forward-session', self: { uin: '1000000001', uid: 'u_self' },
    capabilities: { forwardRead: true, forwardExisting: true } });
const text = value => ({ elementType: 1, textElement: { content: value, atType: 0 } });
const merged = resId => ({ elementType: 16, multiForwardMsgElement: { resId, fileName: 'MultiMsg', xmlContent: '' } });
const message = (id = ROOT, elements = [merged('root-resource')]) => ({ msgId: id, ...SOURCE,
    senderUin: '1000000003', senderUid: 'u_sender', msgTime: '1794614400', sendNickName: 'Real author', elements });
const picture = originImageUrl => ({ elementType: 2, elementId: 'native-image-element',
    picElement: { originImageUrl, md5HexStr: '0123456789abcdef0123456789abcdef', fileName: 'pixel.png', fileSize: '70',
        picWidth: 1, picHeight: 1, picSubType: 0, sourcePath: '/private/QQ/cache/never-export-this.png' } });
function fixture() {
    const calls = [], handlers = {};
    const native = {
        async getMsgsByMsgId(peer, ids) { calls.push({ method: 'getMsgsByMsgId', peer, ids });
            return handlers.get ? handlers.get(peer, ids) : { result: 0, msgList: ids.map(id => message(id)) }; },
        async forwardMsg(...args) { calls.push({ method: 'forwardMsg', args }); return handlers.send ? handlers.send(...args) : { result: 0 }; },
        async getMultiMsg(...args) { calls.push({ method: 'getMultiMsg', args }); return handlers.read ? handlers.read(...args) :
            { result: 0, msgList: [message(CHILD, [text('  original\nmessage  ')])] }; },
        async buildMultiForwardMsg(...args) { calls.push({ method: 'buildMultiForwardMsg', args }); return handlers.build ? handlers.build(...args) :
            { result: 0, rspInfo: { elements: [merged('built-resource')] } }; }
    };
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    capture.epoch = state().epoch; capture.self = state().self; capture.ready = true;
    capture.session = { getMsgService: () => native };
    const forward = createForward(capture);
    const send = extra => forward.run({ kind: 'forward', source: SOURCE, destination: DESTINATION, msgIds: [ROOT], ...extra });
    const read = extra => forward.run({ kind: 'read', peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, ...extra });
    return { native, capture, forward, calls, handlers, send, read };
}
function fails(code) { return error => { assert.equal(error.code, code, error.stack); return true; }; }

test('ordinary forwarding validates exact sources, dispatches once, and never invents a destination ID', async () => {
    const f = fixture(), result = await f.send();
    assert.deepEqual(f.calls.map(x => x.method), ['getMsgsByMsgId', 'forwardMsg']);
    assert.equal(f.calls[1].args[0][0], ROOT);
    assert.ok(f.calls[1].args[3] instanceof Map);
    assert.equal(result.confirmed, true);
    assert.equal(result.confirmation, 'kernel_ack');
    assert.equal(Object.hasOwn(result, 'messageId'), false);
    assert.deepEqual(result.sourceMsgIds, [ROOT]);
});

const buildRequest = extra => ({ kind: 'build', source: SOURCE, msgIds: [ROOT, CHILD], expectedEpoch: state().epoch, ...extra });

test('known-failed pending-carrier merge kind is blocked before any native build or send', async () => {
    const f = fixture();
    await assert.rejects(f.forward.run(buildRequest({ kind: 'mergeProbe' })), fails('UNSUPPORTED'));
    assert.equal(f.calls.length, 0);
});

test('private merged-build RPC validates real group sources and returns native carrier without sending', async () => {
    const f = fixture();
    const result = await f.forward.run(buildRequest());
    assert.deepEqual(f.calls.map(item => item.method), ['getMsgsByMsgId', 'buildMultiForwardMsg']);
    assert.deepEqual(f.calls[1].args, [{ srcMsgIds: [ROOT, CHILD], srcContact: { ...SOURCE, guildId: '' } }]);
    assert.deepEqual(result, { built: true, sent: false, source: SOURCE, sourceMsgIds: [ROOT, CHILD], elements: [merged('built-resource')] });
    assert.equal(Object.hasOwn(result, 'messageId'), false);
    assert.equal(f.calls.some(item => item.method === 'forwardMsg'), false);
    // Even a successfully built resource is not automatically uploaded again.
    await assert.rejects(f.forward.run(buildRequest()), fails('BUSY'));
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 1);
});

test('merged-build RPC accepts only a genuine native multimsg Ark or type 16 carrier', async () => {
    const f = fixture();
    const element = { elementType: 10, elementId: '', arkElement: { bytesData: JSON.stringify({
        app: 'com.tencent.multimsg', meta: { detail: { resid: 'actual-native-resource' } }
    }) } };
    f.handlers.build = () => ({ result: 0, rspInfo: { elements: [element] } });
    assert.deepEqual((await f.forward.run(buildRequest())).elements, [element]);
});

test('merged-build params, unverified builds and absent methods fail before lookup or native construction', async () => {
    const f = fixture();
    for (const extra of [{ expectedEpoch: undefined }, { expectedEpoch: 'old' }]) {
        await assert.rejects(f.forward.run(buildRequest(extra)), fails('SESSION_CHANGED'));
    }
    await assert.rejects(f.forward.run(buildRequest({ source: DESTINATION })), fails('UNSUPPORTED'));
    for (const extra of [{ msgIds: [] }, { msgIds: [ROOT, ROOT] }, { msgIds: [Number(ROOT)] },
        { msgIds: ['18446744073709551616'] }, { msgIds: Array.from({ length: 21 }, (_, i) => String(i + 1)) },
        { elements: [merged('spoofed')] }, { destination: SOURCE }]) {
        await assert.rejects(f.forward.run(buildRequest(extra)), fails('INVALID_PARAMS'));
    }
    f.capture.qqVersion = 'unverified';
    await assert.rejects(f.forward.run(buildRequest()), fails('UNSUPPORTED'));
    f.capture.qqVersion = '3.2.35-54395'; delete f.native.buildMultiForwardMsg;
    await assert.rejects(f.forward.run(buildRequest()), fails('UNSUPPORTED'));
    assert.equal(f.calls.length, 0);
});

test('incomplete or cross-conversation build sources never construct a native resource', async () => {
    const f = fixture();
    for (const msgList of [[], [message(ROOT)], [message(ROOT), { ...message(CHILD), peerUid: '9999' }]]) {
        f.handlers.get = () => ({ result: 0, msgList });
        await assert.rejects(f.forward.run(buildRequest()));
    }
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 0);
    f.handlers.get = undefined;
    assert.equal((await f.forward.run(buildRequest())).built, true);
});

test('unknown merged-build results expose only structural diagnostics and never rebuild or send', async () => {
    const secret = 'PRIVATE_NATIVE_CONTENT_AND_RESOURCE';
    const responses = [undefined, {}, { result: '0', rspInfo: { elements: [merged(secret)] } },
        { result: 4, wording: secret }, { result: 0, rspInfo: null }, { result: 0, rspInfo: { elements: [] } },
        { result: 0, rspInfo: { elements: [merged(secret), merged(secret)] } },
        { result: 0, rspInfo: { elements: [text(secret)] } },
        { result: 0, rspInfo: { elements: [{ elementType: 16, multiForwardMsgElement: { resId: '' } }] } },
        { result: 0, rspInfo: { elements: [{ ...merged(secret), textElement: { content: secret } }] } },
        { result: 0, rspInfo: { elements: [{ elementType: 10, arkElement: { bytesData: secret } }] } },
        { result: 0, rspInfo: { elements: [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: secret }) } }] } },
        { result: 0, rspInfo: { elements: [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: {} } }) } }] } },
        { result: 0, rspInfo: { elements: [{ ...merged(secret), unknownData: 'x'.repeat(65536) }] } }
    ];
    for (const response of responses) {
        const f = fixture(); f.handlers.build = () => response;
        await assert.rejects(f.forward.run(buildRequest()), error => {
            assert.ok(['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));
            assert.equal(error.message.includes(secret), false);
            assert.match(error.message, /shape=/);
            return true;
        });
        await assert.rejects(f.forward.run(buildRequest()), fails('BUSY'));
        assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 1);
        assert.equal(f.calls.filter(item => item.method === 'forwardMsg').length, 0);
    }
});

test('merged-build timeouts keep their reservation after late completion and reset only for a changed session', async () => {
    const f = fixture();
    let finish, dispatched;
    const observed = new Promise(resolve => { dispatched = resolve; });
    f.handlers.build = () => { dispatched(); return new Promise(resolve => { finish = resolve; }); };
    const original = f.forward.run(buildRequest(), { expiresAt: Date.now() + 25 });
    const rejected = assert.rejects(original, fails('TIMEOUT'));
    await observed; await rejected;
    await assert.rejects(f.forward.run(buildRequest()), fails('BUSY'));
    finish({ result: 0, rspInfo: { elements: [merged('late-resource')] } });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.forward.run(buildRequest()), fails('BUSY'));
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 1);
    f.capture.epoch = 'new-session'; f.handlers.build = undefined;
    assert.equal((await f.forward.run(buildRequest({ expectedEpoch: f.capture.epoch }))).built, true);
});

test('build cancellation or session replacement during lookup prevents native construction', async () => {
    for (const mode of ['abort', 'session']) {
        const f = fixture(), controller = new AbortController();
        f.handlers.get = (_peer, ids) => {
            if (mode === 'abort') controller.abort(); else f.capture.epoch = 'new-session';
            return { result: 0, msgList: ids.map(id => message(id)) };
        };
        await assert.rejects(f.forward.run(buildRequest(), { signal: controller.signal }),
            error => ['EXPIRED', 'SESSION_CHANGED'].includes(error.code));
        assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 0);
    }
});

test('merged-build session reservations have a fixed bound without evicting unknown attempts', async () => {
    const f = fixture();
    for (let index = 1; index <= 32; index++) await f.forward.run(buildRequest({ msgIds: [String(index)] }));
    await assert.rejects(f.forward.run(buildRequest({ msgIds: ['33'] })), fails('BUSY'));
    await assert.rejects(f.forward.run(buildRequest({ msgIds: ['1'] })), fails('BUSY'));
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 32);
});

test('private build inspection preserves an unknown native result without validating or authorizing sending', async () => {
    const f = fixture(), secret = 'PRIVATE_RESOURCE_OR_TEXT';
    const raw = { result: 0, privateSequence: 18446744073709551610n, rspInfo: { elements: [{ elementType: 10,
        elementId: 'native-id', arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg',
            meta: { detail: { unusualResource: secret } } }) }, textElement: { content: secret } }] } };
    f.handlers.build = () => raw;
    const result = await f.forward.run(buildRequest({ kind: 'inspectBuild' }));
    assert.equal(result.nativeAccepted, true); assert.equal(result.validated, false); assert.equal(result.sent, false);
    assert.equal(Object.hasOwn(result, 'elements'), false); assert.equal(Object.hasOwn(result, 'messageId'), false);
    assert.equal(Object.hasOwn(result, 'built'), false);
    assert.equal(result.rawResult.privateSequence, '18446744073709551610');
    assert.equal(result.rawResult.rspInfo.elements[0].textElement.content, secret);
    assert.deepEqual(result.sourceMsgIds, [ROOT, CHILD]);
    assert.equal(result.shape.elements[0].ark.appIsMultimsg, true);
    assert.deepEqual(result.shape.elements[0].ark.detailKeys, ['unusualResource']);
    assert.equal(JSON.stringify(result.shape).includes(secret), false);
    result.rawResult.rspInfo.elements[0].textElement.content = 'client changed its clone';
    assert.equal(raw.rspInfo.elements[0].textElement.content, secret);
    await assert.rejects(f.forward.run(buildRequest()), fails('BUSY'));
    await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild' })), fails('BUSY'));
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 1);
    assert.equal(f.calls.filter(item => item.method === 'forwardMsg').length, 0);
});

test('inspection and strict construction share one session reservation in both directions', async () => {
    const f = fixture();
    await f.forward.run(buildRequest());
    await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild' })), fails('BUSY'));
    const result = await f.forward.run(buildRequest({ kind: 'inspectBuild', msgIds: [CHILD, ROOT] }));
    assert.equal(result.validated, true); assert.equal(result.sent, false);
    assert.deepEqual(result.sourceMsgIds, [CHILD, ROOT]);
    assert.deepEqual(result.rawResult.rspInfo.elements, [merged('built-resource')]);
    assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 2);
});

test('inspection cannot bypass source, epoch, method or strict parameter guards', async () => {
    const f = fixture();
    for (const [extra, code] of [[{ expectedEpoch: undefined }, 'SESSION_CHANGED'], [{ source: DESTINATION }, 'UNSUPPORTED'],
        [{ msgIds: [ROOT, ROOT] }, 'INVALID_PARAMS'], [{ target: SOURCE }, 'INVALID_PARAMS'],
        [{ elements: [merged('spoofed')] }, 'INVALID_PARAMS']]) {
        await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild', ...extra })), fails(code));
    }
    delete f.native.buildMultiForwardMsg;
    await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild' })), fails('UNSUPPORTED'));
    assert.equal(f.calls.length, 0);
});

test('native inspection requires explicit numeric success and cannot expose oversized or inexact raw results', async () => {
    const cyclic = { result: 0 }; cyclic.self = cyclic;
    for (const response of [undefined, { result: '0' }, { result: 1 },
        { result: 0, privateData: 'x'.repeat(1024 * 1024) }, { result: 0, roundedId: 9007199254740992 }, cyclic]) {
        const f = fixture(); f.handlers.build = () => response;
        await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild' })),
            error => ['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));
        await assert.rejects(f.forward.run(buildRequest({ kind: 'inspectBuild' })), fails('BUSY'));
        assert.equal(f.calls.filter(item => item.method === 'buildMultiForwardMsg').length, 1);
        assert.equal(f.calls.filter(item => item.method === 'forwardMsg').length, 0);
    }
});

test('inspection does not weaken strict carrier validation and keeps diagnostics structural', async () => {
    const secret = 'PRIVATE_URL_OR_MESSAGE';
    const result = { result: 0, rspInfo: { elements: [{ elementType: 10, arkElement: { bytesData: JSON.stringify({
        app: secret, meta: { detail: { unexpected: secret } }
    }) } }] } };
    const strict = fixture(); strict.handlers.build = () => result;
    await assert.rejects(strict.forward.run(buildRequest()), error => {
        assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(error.message.includes(secret), false);
        const shape = JSON.parse(error.message.split('shape=')[1]);
        assert.equal(shape.elements[0].ark.appIsMultimsg, false);
        assert.deepEqual(shape.elements[0].ark.metaKeys, ['detail']);
        return true;
    });
    const inspected = fixture(); inspected.handlers.build = () => result;
    const value = await inspected.forward.run(buildRequest({ kind: 'inspectBuild' }));
    assert.equal(value.validated, false); assert.equal(value.nativeAccepted, true);
    assert.equal(value.rawResult.rspInfo.elements[0].arkElement.bytesData, result.rspInfo.elements[0].arkElement.bytesData);
});

test('forwarding rejects unsafe IDs, duplicate IDs, spoofed peers and unknown fields before native dispatch', async () => {
    const f = fixture();
    for (const extra of [{ msgIds: [Number(ROOT)] }, { msgIds: ['18446744073709551616'] }, { msgIds: ['01'] },
        { msgIds: [ROOT, ROOT] }, { msgIds: [] }, { destination: { chatType: 1, peerUid: '1000000001' } },
        { source: { ...SOURCE, arbitrary: true } }, { eval: 'bad' }, { msgIds: new Array(51).fill(ROOT) }]) {
        await assert.rejects(f.send(extra), fails('INVALID_PARAMS'));
    }
    assert.equal(f.calls.length, 0);
});

test('source mismatch and incomplete source lookup cannot cause a forward', async () => {
    const f = fixture();
    for (const response of [{ result: 0, msgList: [] }, { result: 0, msgList: [message(CHILD)] },
        { result: 0, msgList: [{ ...message(), peerUid: '9999' }] }, { result: 1, msgList: [message()] }]) {
        f.handlers.get = () => response;
        await assert.rejects(f.send());
    }
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 0);
});

test('void, malformed, failed and timed-out forward acknowledgements are never success or retried', async () => {
    const f = fixture();
    for (const response of [undefined, {}, { result: '170013002' }, { result: true }]) {
        f.handlers.send = () => response;
        await assert.rejects(f.send());
    }
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 4);
    f.handlers.send = () => Promise.reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    await assert.rejects(f.send(), fails('TIMEOUT'));
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 5);
});

test('timed-out native forward retains its conflict lock until original completion', async () => {
    const f = fixture();
    let finish, dispatched;
    const observed = new Promise(resolve => { dispatched = resolve; });
    f.handlers.send = () => { dispatched(); return new Promise(resolve => { finish = resolve; }); };
    const original = f.forward.run({ kind: 'forward', source: SOURCE, destination: DESTINATION, msgIds: [ROOT] }, { expiresAt: Date.now() + 25 });
    const outcome = assert.rejects(original, fails('TIMEOUT'));
    await observed; await outcome;
    await assert.rejects(f.send(), fails('BUSY'));
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 1);
    finish({ result: 0 });
    await new Promise(resolve => setImmediate(resolve));
    f.handlers.send = () => ({ result: 0 });
    assert.equal((await f.send()).confirmed, true);
});

test('cancelled or changed session during source validation cannot dispatch', async () => {
    const f = fixture(), controller = new AbortController();
    f.handlers.get = () => { controller.abort(); return { result: 0, msgList: [message()] }; };
    await assert.rejects(f.forward.run({ kind: 'forward', source: SOURCE, destination: DESTINATION, msgIds: [ROOT] }, { signal: controller.signal }), fails('EXPIRED'));
    f.handlers.get = () => { f.capture.epoch = 'changed'; return { result: 0, msgList: [message()] }; };
    await assert.rejects(f.send(), error => ['EXPIRED', 'SESSION_CHANGED'].includes(error.code));
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 0);
});

test('native merged reading retains real node authors, original whitespace and long integer identity', async () => {
    const f = fixture(), value = await f.read();
    assert.equal(value.records[0].msgId, CHILD);
    assert.equal(value.records[0].senderUin, '1000000003');
    assert.equal(value.records[0].elements[0].textElement.content, '  original\nmessage  ');
    assert.deepEqual(f.calls[1].args, [{ ...SOURCE, guildId: '' }, ROOT, ROOT]);
});

test('native merged reading rejects ordinary messages and incomplete or ambiguous merged roots', async () => {
    const f = fixture();
    for (const elements of [[text('normal')], [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: '' } } }) } }],
        [{ elementType: 16, multiForwardMsgElement: { resId: '' } }], [merged('a'), merged('b')]]) {
        f.handlers.get = () => ({ result: 0, msgList: [message(ROOT, elements)] });
        await assert.rejects(f.read());
    }
    assert.equal(f.calls.filter(x => x.method === 'getMultiMsg').length, 0);
    assert.equal(descriptor({ elementType: 10, multiForwardMsgElement: { resId: 'fake' } }), null);
});

test('a completed own multimsg Ark reads its actual native root and resource', async () => {
    const f = fixture();
    const element = { elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'completed-native-resource' } } }) } };
    f.handlers.get = () => ({ result: 0, msgList: [message(ROOT, [element])] });
    const result = await f.read();
    assert.equal(result.resId, 'completed-native-resource');
    assert.deepEqual(f.calls.find(call => call.method === 'getMultiMsg').args, [{ ...SOURCE, guildId: '' }, ROOT, ROOT]);
});

test('changed observed resource cannot be substituted behind a native root ID', async () => {
    const f = fixture();
    await assert.rejects(f.read({ resId: 'old-resource' }), fails('NOT_FOUND'));
    assert.equal(f.calls.filter(x => x.method === 'getMultiMsg').length, 0);
});

test('forward capabilities stay false when unavailable and do not activate an unverified QQ version', async () => {
    const f = fixture();
    f.capture.ready = false;
    assert.deepEqual(f.forward.capabilities(), { forwardExisting: false, forwardRead: false, mergeExistingNative: false });
    f.capture.ready = true; f.capture.qqVersion = 'unknown-build';
    assert.deepEqual(f.forward.capabilities(), { forwardExisting: false, forwardRead: false, mergeExistingNative: false });
    await assert.rejects(f.send(), fails('UNSUPPORTED'));
    f.capture.qqVersion = '3.2.35-54395'; delete f.native.getMultiMsg;
    assert.deepEqual(f.forward.capabilities(), { forwardExisting: true, forwardRead: false, mergeExistingNative: false });
    await assert.rejects(f.read(), fails('UNSUPPORTED'));
});

test('unknown nested parents cannot be queried; actually observed children can', async () => {
    const f = fixture();
    await assert.rejects(f.read({ parentMsgId: CHILD }), fails('NOT_FOUND'));
    f.handlers.read = (_peer, _root, parent) => ({ result: 0, msgList: [message(CHILD,
        parent === CHILD ? [text('nested leaf')] : [merged('child-resource')])] });
    await f.read();
    const child = await f.read({ parentMsgId: CHILD });
    assert.equal(child.parentMsgId, CHILD);
    assert.equal(f.calls.filter(x => x.method === 'getMultiMsg').length, 2);
});

test('merged parent cache is cleared on account/session changes and has an enforced TTL', async () => {
    const f = fixture(); let clock = Date.now();
    const forward = createForward(f.capture, { now: () => clock });
    const read = parentMsgId => forward.run({ kind: 'read', peer: SOURCE, rootMsgId: ROOT, parentMsgId });
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [merged('child-resource')])] });
    await read(ROOT); clock += 60001;
    await assert.rejects(read(CHILD), fails('NOT_FOUND'));
    clock = Date.now(); await read(ROOT);
    f.capture.self = { uid: 'u_other', uin: '3000000002' };
    await assert.rejects(read(CHILD), fails('NOT_FOUND'));
});

test('merged read rejects failed, excessive, duplicate, inexact and cyclic native results', async () => {
    const f = fixture();
    for (const response of [{ result: 1, msgList: [] }, { result: 0 },
        { result: 0, msgList: new Array(1001).fill(message(CHILD, [text('x')])) },
        { result: 0, msgList: [message(CHILD), message(CHILD)] },
        { result: 0, msgList: [{ ...message(CHILD), msgSeq: 9007199254740992 }] },
        { result: 0, msgList: [message(ROOT, [merged('root-resource')])] }]) {
        f.handlers.read = () => response;
        await assert.rejects(f.read());
    }
});

test('observed registry rejects raw resids, expired handles and cross-account/session handles', () => {
    let clock = 100;
    const registry = createForwardRegistry({ now: () => clock, ttlMs: 20 });
    const s = state(), record = message();
    const id = registry.register(s, record, record.elements[0]);
    assert.match(id, /^fwd_[A-Za-z0-9_-]{32}$/);
    assert.equal(registry.get(s, id).rootMsgId, ROOT);
    assert.throws(() => registry.get(s, 'root-resource'), fails('INVALID_PARAMS'));
    clock += 21; assert.throws(() => registry.get(s, id), fails('NOT_FOUND'));
    const next = registry.register(s, record, record.elements[0]);
    assert.throws(() => registry.get({ ...s, epoch: 'new-session' }, next), fails('NOT_FOUND'));
    const other = registry.register(s, record, record.elements[0]);
    assert.throws(() => registry.get({ ...s, self: { uid: 'u_other', uin: '3000000002' } }, other), fails('NOT_FOUND'));
});

test('registry is bounded and does not accept substituted elements or unknown native roots', () => {
    const registry = createForwardRegistry({ maxHandles: 1 }), s = state(), first = message(), second = message(CHILD);
    assert.throws(() => registry.register(s, first, merged('root-resource')), fails('INVALID_RESPONSE'));
    const old = registry.register(s, first, first.elements[0]);
    registry.register(s, second, second.elements[0]);
    assert.throws(() => registry.get(s, old), fails('NOT_FOUND'));
    assert.throws(() => registry.register(s, { ...first, msgId: Number(ROOT) }, first.elements[0]), fails('INVALID_RESPONSE'));
});

function protocolFixture() {
    const f = fixture(), s = state(), calls = [];
    const records = new Map([[1, message()]]);
    const service = {
        forwardRegistry: createForwardRegistry(),
        remaining() { return 10000; },
        async assertSession(value) { assert.equal(value.epoch, s.epoch); },
        async record(_state, id, expectedPeer) {
            const record = records.get(id);
            if (!record) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
            if (expectedPeer && (record.chatType !== expectedPeer.chatType || record.peerUid !== expectedPeer.peerUid)) throw Object.assign(new Error('wrong peer'), { code: 'INVALID_PARAMS' });
            return record;
        },
        async sessionCall(_state, method, params) {
            calls.push({ method, params });
            if (method === 'resolve') return { uin: params.uin || '1000000003', uid: params.uid || 'u_destination' };
            assert.equal(method, 'forwardOperation');
            return f.forward.run(params);
        }
    };
    return { ...f, state: s, service, protocolCalls: calls, records,
        run: (action, params) => runForward(service, s, action, params) };
}

test('OneBot forward extension resolves a real private UID and has no fabricated message_id', async () => {
    const f = protocolFixture();
    const value = await f.run('qqapi_message_forward', { message_ids: [1], user_id: '3000000002' });
    assert.deepEqual(f.protocolCalls[0], { method: 'resolve', params: { uin: '3000000002' } });
    assert.deepEqual(value.destination, { message_type: 'private', user_id: 3000000002 });
    assert.equal(value.confirmed, true);
    assert.equal(Object.hasOwn(value, 'message_id'), false);
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 1);
});

test('OneBot forwarding rejects mixed source peers and invalid private mappings without dispatch', async () => {
    const f = protocolFixture();
    f.records.set(2, { ...message(CHILD), peerUid: '1234' });
    await assert.rejects(f.run('qqapi_message_forward', { message_ids: [1, 2], group_id: '2000000001' }), fails('INVALID_PARAMS'));
    const original = f.service.sessionCall;
    f.service.sessionCall = (s, method, p) => method === 'resolve' ? { uid: 'u_wrong', uin: '9999' } : original(s, method, p);
    await assert.rejects(f.run('qqapi_message_forward', { message_ids: [1], user_id: '3000000002' }), fails('NOT_FOUND'));
    assert.equal(f.calls.filter(x => x.method === 'forwardMsg').length, 0);
});

test('get_forward_msg accepts only the observed opaque handle and preserves node author and whitespace', async () => {
    const f = protocolFixture();
    const value = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.equal(value.messages[0].sender.user_id, 1000000003);
    assert.equal(value.messages[0].sender.nickname, 'Real author');
    assert.equal(value.messages[0].content[0].data.text, '  original\nmessage  ');
    assert.deepEqual(value.message[0], { type: 'node', data: { user_id: '1000000003', nickname: 'Real author', time: 1794614400, content: value.messages[0].content } });
    const standard = await f.run('get_forward_msg', { id: value.id });
    assert.deepEqual(standard.messages, value.messages);
    await assert.rejects(f.run('get_forward_msg', { id: ROOT }), fails('INVALID_PARAMS'));
    await assert.rejects(f.run('get_forward_msg', { id: 'root-resource' }), fails('INVALID_PARAMS'));
});

test('both forward response formats preserve each native node timestamp through fresh reads', async () => {
    const f = protocolFixture();
    let times = ['1700000002', 1700000001, '4294967295'];
    f.handlers.read = () => ({ result: 0, msgList: times.map((msgTime, index) => ({
        ...message(String(100 + index), [text('equal content')]), msgTime
    })) });
    const first = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.deepEqual(first.messages.map(node => node.time), times.map(Number));
    assert.deepEqual(first.message.map(node => node.data.time), times.map(Number));
    times = [1, '1700000003', 1700000004];
    const next = await f.run('get_forward_msg', { id: first.id });
    assert.deepEqual(next.messages.map(node => node.time), times.map(Number));
    assert.deepEqual(next.message.map(node => node.data.time), times.map(Number));
    assert(next.message.every(node => typeof node.data.time === 'number'));
    assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 2);
});

test('missing or malformed native node timestamps fail the whole query without a time fallback', async () => {
    const f = protocolFixture();
    for (const msgTime of [undefined, null, '', 0, '0', -1, 1.5, '01', '1.0', '1e3', '1700000001 ', NaN, Infinity,
        9007199254740992, '9007199254740992']) {
        f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('valid first')]),
            { ...message('100', [text('invalid timestamp')]), msgTime }] });
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
    }
});

test('OneBot merged query rejects a wrong resource response and disabled capability', async () => {
    const f = protocolFixture();
    f.state.capabilities.forwardRead = false;
    await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('UNSUPPORTED'));
    assert.equal(f.protocolCalls.length, 0);
    f.state.capabilities.forwardRead = true;
    f.service.sessionCall = async () => ({ rootMsgId: ROOT, parentMsgId: ROOT, peer: SOURCE, resId: 'substitution', records: [] });
    await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
});

test('real merged-image URL shape uses the existing rkey service and retains the whole mixed message', async () => {
    const f = protocolFixture(), resolutions = [];
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD,
        [text('before image\n'), picture('/download?appid=1407&fileid=synthetic-native-file&spec=0'), text('\n after image')])] });
    f.service.globalServices = { async resolveImageUrl(input, isGroup, context) {
        resolutions.push({ input, isGroup, context });
        const url = new URL(input); url.searchParams.set('rkey', 'verified-test-rkey'); return url.href;
    } };
    const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.deepEqual(result.messages[0].content.map(segment => segment.type), ['text', 'image', 'text']);
    assert.equal(result.messages[0].content[0].data.text, 'before image\n');
    assert.equal(result.messages[0].content[2].data.text, '\n after image');
    const data = result.messages[0].content[1].data, url = new URL(data.url);
    assert.equal(url.hostname, 'multimedia.nt.qq.com.cn');
    assert.equal(url.searchParams.get('fileid'), 'synthetic-native-file');
    assert.equal(url.searchParams.get('spec'), '0');
    assert.equal(url.searchParams.get('rkey'), 'verified-test-rkey');
    assert.equal(data.file_size, '70'); assert.equal(data.width, 1); assert.equal(data.height, 1);
    assert.equal(JSON.stringify(result).includes('/private/QQ/cache/'), false);
    assert.equal(resolutions.length, 1); assert.equal(resolutions[0].isGroup, true);
    assert.equal(resolutions[0].context.timeoutMs, 10000);
    assert.ok(f.calls.filter(call => call.method === 'getMsgsByMsgId').every(call => call.ids.every(id => id === ROOT)));
});

test('a private image inside a group merge uses its own appid rather than the outer group', async () => {
    const f = protocolFixture(); let keyKind;
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [picture('/download?appid=1406&fileid=private-resource&spec=0')])] });
    f.service.globalServices = { async resolveImageUrl(input, isGroup) { keyKind = isGroup; return input + '&rkey=private-test-key'; } };
    const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.equal(keyKind, false);
    assert.equal(result.messages[0].content[0].type, 'image');
});

test('merged images with complete official URLs work without a new media-query or rkey request', async () => {
    const f = protocolFixture();
    for (const input of ['https://multimedia.nt.qq.com/download?appid=1407&fileid=native-file&rkey=existing-key',
        'https://gchat.qpic.cn/gchatpic_new/actual-native-locator/0']) {
        f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [picture(input)])] });
        const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
        assert.equal(result.messages[0].content[0].data.url, input);
    }
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('no partial output'), picture('/download?appid=1407&fileid=native-file')])] });
    const partial = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.equal(partial._freshwater.content_status, 'partial');
    assert.equal(partial.messages[0].content[0].data.text, 'no partial output');
    assert.match(partial.messages[0].content[1].data.text, /QQ媒体暂不可读取/);
});

test('merged NT images with an observed old key still consult the account resolver without changing resource identity', async () => {
    const f = protocolFixture(), input = 'https://multimedia.nt.qq.com/download?appid=1407&fileid=native-file&spec=0&rkey=old-key';
    let calls = 0;
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [picture(input)])] });
    f.service.globalServices = { async resolveImageUrl(observed, isGroup) {
        calls++; assert.equal(observed, input); assert.equal(isGroup, true);
        const url = new URL(observed); url.searchParams.set('rkey', 'current-account-key'); return url.href;
    } };
    const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    const url = new URL(result.messages[0].content[0].data.url);
    assert.equal(calls, 1); assert.equal(url.searchParams.get('fileid'), 'native-file');
    assert.equal(url.searchParams.get('rkey'), 'current-account-key'); assert.equal(url.searchParams.get('spec'), '0');
});

test('merged image resource validation rejects arbitrary hosts, guessed routes and ambiguous file IDs', async () => {
    const f = protocolFixture(); let resolutions = 0;
    f.service.globalServices = { async resolveImageUrl() { resolutions++; throw new Error('must not be called'); } };
    for (const input of ['https://example.com/download?appid=1407&fileid=a', 'http://multimedia.nt.qq.com/download?appid=1407&fileid=a',
        '//example.com/download?appid=1407&fileid=a', '/other-route?fileid=a', '/download?appid=999&fileid=a',
        '/download?appid=1407', '/download?appid=1407&fileid=a&fileid=b', '/download?appid=1407&fileid=a%0D%0A',
        '/download?appid=1407&fileid=a&spec=0&unknown=b', 'https://multimedia.nt.qq.com:443/download?appid=1407&fileid=a#fragment']) {
        f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [picture(input)])] });
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }));
    }
    assert.equal(resolutions, 0);
});

test('rkey resolution cannot change the observed merged image resource or cross the account session', async () => {
    const f = protocolFixture();
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [picture('/download?appid=1407&fileid=native-file&spec=0')])] });
    for (const output of ['https://example.com/download?appid=1407&fileid=native-file&rkey=a',
        'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=substitution&spec=0&rkey=a',
        'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=native-file&spec=0',
        'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=native-file&spec=0&rkey=a&other=extra']) {
        f.service.globalServices = { async resolveImageUrl() { return output; } };
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }));
    }
    let authorizations = 0;
    f.service.assertSession = async () => { if (++authorizations > 1) throw Object.assign(new Error('session changed'), { code: 'SESSION_CHANGED' }); };
    f.service.globalServices = { async resolveImageUrl(input) { return input + '&rkey=actual-key'; } };
    await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('SESSION_CHANGED'));
});

test('malformed media inside merged messages remains a whole-query failure', async () => {
    const f = protocolFixture();
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('must not leak partial text'), { elementType: 999 }])] });
    await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
});

test('forward parameter tampering never exposes an arbitrary kernel action or custom merge construction', async () => {
    const f = protocolFixture();
    await assert.rejects(f.run('send_group_forward_msg', { messages: [] }), fails('UNSUPPORTED'));
    await assert.rejects(f.run('qqapi_message_forward', { message_ids: [1], group_id: '2000000001', nodes: [] }), fails('INVALID_PARAMS'));
    await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1, resId: 'forged' }), fails('INVALID_PARAMS'));
    await assert.rejects(f.run('qqapi_message_forward', { message_ids: [1], user_id: '3000000002', group_id: '2000000001' }), fails('INVALID_PARAMS'));
    assert.equal(f.calls.length, 0);
});

test('real Capture, persistent store, service and codec retain nested merged authors and session-bound handles', async t => {
    const temporaryRoot = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'forward-integration-'));
    t.after(() => { assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
    const f = fixture(), grandchild = '18446744073709551608';
    f.handlers.read = (_peer, root, parent) => {
        assert.equal(root, ROOT);
        return { result: 0, msgList: parent === ROOT ? [{ ...message(CHILD,
            [text('  first layer\n'), merged('nested-resource')]), senderUin: '3000000002', sendNickName: 'Inner author', msgTime: '1700000001' }] :
            [{ ...message(grandchild, [text('second layer\n  '), { elementType: 6, faceElement: { faceIndex: 14, faceType: 1 } }]),
                senderUin: '3000000004', sendNickName: 'Different author', msgTime: 1700000002 }] };
    };
    const store = new MessageStore({ directory });
    const rootEntry = store.remember(f.capture.self.uin, message());
    const service = new OneBotService({ backend: { call: (method, params, context) => f.capture.call(method, params, context) }, store });
    const action = (name, params, echo) => service.action({ action: name, params, echo });
    const query = await action('get_msg', { message_id: rootEntry.id }, { tracking: [1, 'nested'] });
    assert.equal(query.status, 'ok', query.message);
    assert.deepEqual(query.echo, { tracking: [1, 'nested'] });
    assert.equal(query.data.message[0].type, 'forward');
    const rootHandle = query.data.message[0].data.id;
    const mergedResponse = await action('get_forward_msg', { id: rootHandle });
    assert.equal(mergedResponse.status, 'ok', mergedResponse.message);
    assert.equal(mergedResponse.data.message[0].type, 'node');
    assert.equal(mergedResponse.data.message[0].data.user_id, '3000000002');
    assert.equal(mergedResponse.data.message[0].data.time, 1700000001);
    const inner = mergedResponse.data.messages[0];
    assert.equal(inner.time, 1700000001);
    assert.equal(inner.sender.user_id, 3000000002);
    assert.equal(inner.sender.nickname, 'Inner author');
    assert.equal(inner.content[0].data.text, '  first layer\n');
    assert.equal(inner.content[1].type, 'forward');
    const nestedHandle = inner.content[1].data.id;
    assert.notEqual(nestedHandle, rootHandle);
    const nested = await action('get_forward_msg', { id: nestedHandle });
    assert.equal(nested.status, 'ok', nested.message);
    assert.equal(nested.data.message[0].data.time, 1700000002);
    assert.equal(nested.data.messages[0].time, 1700000002);
    assert.equal(nested.data.messages[0].sender.user_id, 3000000004);
    assert.equal(nested.data.messages[0].sender.nickname, 'Different author');
    assert.equal(nested.data.messages[0].content[0].data.text, 'second layer\n  ');
    assert.deepEqual(nested.data.messages[0].content[1], { type: 'face', data: { id: '14' } });
    assert.equal(f.calls.filter(value => value.method === 'getMultiMsg').length, 2);
    f.capture.epoch = 'another-authenticated-session';
    const stale = await action('get_forward_msg', { id: nestedHandle });
    assert.equal(stale.status, 'failed');
    assert.equal(stale.retcode, 1404);
    assert.equal(f.calls.filter(value => value.method === 'getMultiMsg').length, 2);
});

// Exercise the new read fallback through its actual protobuf decoder, Capture
// session/deadline checks and public codec. Only the fixed MSF transport is a
// test double; display nodes never enter the normal-message locator or store.
const fallbackProto = require('../src/qq/proto.cjs');
const fallbackProtocol = require('../src/qq/forward-upload-protocol.cjs');
const { createForwardResourceRead } = require('../src/qq/forward-resource-read.cjs');
const { gzipSync: fallbackGzip } = require('node:zlib');
const fbN = fallbackProto.varintField, fbB = fallbackProto.bytesField;
const fbS = (field, value) => fbB(field, Buffer.from(value, 'utf8'));
const fbJoin = (...parts) => Buffer.concat(parts);
const fbText = value => fbB(1, fbS(1, value));
const fbBody = (...elements) => fbB(1, fbJoin(...elements.map(element => fbB(2, element))));
function fallbackImage() {
    const file = fbJoin(fbN(1, 70), fbS(2, '0123456789ABCDEF0123456789ABCDEF'), fbS(4, 'wire.png'),
        fbB(5, fbJoin(fbN(1, 1), fbN(2, 1001))), fbN(6, 12), fbN(7, 13));
    const index = fbJoin(fbB(1, file), fbS(2, 'wire-uuid'));
    const pic = fbJoin(fbS(1, '/download?appid=1406&fileid=wire-resource'), fbB(2, fbS(1, '&spec=0')),
        fbS(3, 'multimedia.nt.qq.com.cn'));
    const media = fbJoin(fbB(1, fbJoin(fbB(1, index), fbB(2, pic))), fbB(2, fbB(1, fbJoin(fbN(1, 0), fbS(2, 'wire summary')))));
    return fbB(53, fbJoin(fbN(1, 48), fbB(2, media), fbN(3, 10)));
}
function fallbackPayload(nodes, variant) {
    const encoded = nodes.map(node => {
        const head = fbJoin(fbN(1, node.authorUin), fbS(2, node.authorUid), fbB(7, fbJoin(fbS(6, node.nickname), fbN(11, 1))));
        const native = variant === 'native';
        const meta = fbJoin(fbN(1, 9), fbN(2, native ? 175 : 4), fbN(3, native ? 175 : 0), fbN(4, node.random),
            fbN(5, node.sequence), fbN(6, node.time), ...(native ? [fbN(7, 1), fbN(11, '18446744073709551615'),
                fbB(15, fbJoin(fbN(1, 0), fbN(2, 0), fbN(3, 2), fbB(4, Buffer.alloc(44, 1)), fbB(5, Buffer.alloc(158, 2))))] : []));
        return fbB(1, fbJoin(fbB(1, head), fbB(2, meta), fbB(3, node.body)));
    });
    return fbB(2, fbJoin(fbS(1, 'MultiMsg'), fbB(2, fbJoin(...encoded))));
}
function fallbackFixture(variant = 'fixed') {
    const f = protocolFixture(), rawCalls = [], authorCalls = [], keyCalls = [];
    const nodes = [{ authorUin: '1000000003', authorUid: 'u_sender', nickname: '  Wire author😀  ', time: '1700000002',
        random: '123', sequence: '456', body: fbBody(fbText('  before\n'), fallbackImage(), fbText('\n after  ')) },
    { authorUin: '1000000001', authorUid: 'u_self', nickname: 'Self author', time: '1700000001', random: '789',
        sequence: '987', body: fbBody(fbText('second node')) }];
    f.handlers.read = () => ({ result: 1, msgList: [] });
    f.capture.resolve = async params => { authorCalls.push(params); return { uin: params.uin, uid: 'u_sender' }; };
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, f.capture); rawCalls.push(params);
        const prepared = fallbackProtocol.prepare('forward.readUploaded', { selfUid: 'u_self', resId: 'root-resource' });
        assert.equal(params.op, 'rawPacket'); assert.equal(params.cmd, prepared.name);
        assert.equal(params.data, prepared.body.toString('hex')); assert.equal(params.rsp, true);
        assert.equal(params.expectedEpoch, f.state.epoch); assert.equal(params.expectedUin, f.state.self.uin);
        const response = fbB(1, fbJoin(fbS(3, 'root-resource'), fbB(4, fallbackGzip(fallbackPayload(nodes, variant)))));
        return { responseHex: response.toString('hex') };
    } };
    f.capture.forwardResourceReadApi = createForwardResourceRead(f.capture, { native });
    f.service.globalServices = { async resolveImageUrl(input, isGroup, context) {
        keyCalls.push({ input, isGroup, context });
        const url = new URL(input); url.searchParams.set('rkey', 'current-reader-key'); return url.href;
    } };
    return { ...f, nodes, rawCalls, authorCalls, keyCalls, rawTransport: native };
}

test('fixed and native resource fallbacks preserve both public aliases, historical times and mixed text/images without child IDs', async () => {
    for (const variant of ['fixed', 'native']) for (const trigger of ['rejected', 'empty']) {
        const f = fallbackFixture(variant);
        if (trigger === 'empty') f.handlers.read = () => ({ result: 0, msgList: [] });
        const first = await f.run('qqapi_get_forward_messages', { message_id: 1 });
        assert.deepEqual(first.messages.map(node => node.time), [1700000002, 1700000001]);
        assert.deepEqual(first.message.map(node => node.data.time), [1700000002, 1700000001]);
        assert.deepEqual(first.messages.map(node => node.sender), [{ user_id: 1000000003, nickname: '  Wire author😀  ' },
            { user_id: 1000000001, nickname: 'Self author' }]);
        assert.deepEqual(first.messages[0].content, [{ type: 'text', data: { text: '  before\n' } }, { type: 'image', data: {
            file: '0123456789abcdef0123456789abcdef', url: 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=wire-resource&spec=0&rkey=current-reader-key',
            file_size: '70', file_name: 'wire.png', width: 12, height: 13, sub_type: 0, summary: 'wire summary'
        } }, { type: 'text', data: { text: '\n after  ' } }]);
        for (let index = 0; index < first.messages.length; index++) {
            const publicNode = first.messages[index], alias = first.message[index];
            assert.deepEqual(Object.keys(publicNode).sort(), ['content', 'sender', 'time']);
            assert.deepEqual(alias, { type: 'node', data: { user_id: String(publicNode.sender.user_id),
                nickname: publicNode.sender.nickname, time: publicNode.time, content: publicNode.content } });
        }
        const standard = await f.run('get_forward_msg', { id: first.id });
        assert.deepEqual(standard, { message: first.message, messages: first.messages });
        assert.equal(JSON.stringify(first).includes(CHILD), false);
        assert.equal(JSON.stringify(first).includes('msgId'), false);
        assert.equal(JSON.stringify(first).includes('sourcePath'), false);
        assert.equal(f.rawCalls.length, variant === 'fixed' ? 2 : 4);
        assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, variant === 'fixed' ? 0 : 2);
        assert.equal(f.calls.filter(call => call.method === 'getMsgsByMsgId').length, variant === 'fixed' ? 4 : 6);
        for (const call of f.calls.filter(call => call.method === 'getMsgsByMsgId')) {
            assert.deepEqual(call.peer, { ...SOURCE, guildId: '' }); assert.deepEqual(call.ids, [ROOT]);
        }
        assert.deepEqual(f.authorCalls, [{ uin: '1000000003' }, { uin: '1000000003' }]);
        assert.equal(f.keyCalls.length, 2); assert(f.keyCalls.every(call => call.isGroup === false));
        assert(f.rawCalls.every(call => call.signal.aborted));
        assert.equal(f.capture.pending.size, 0);
    }
});

test('resource fallback performs fresh reads and preserves each new time in both aliases', async () => {
    const f = fallbackFixture(), first = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    f.nodes[0].time = '4294967295'; f.nodes[1].time = '1'; f.nodes[1].body = fbBody(fbText('new exact body\n'));
    const next = await f.run('get_forward_msg', { id: first.id });
    assert.deepEqual(next.messages.map(node => node.time), [4294967295, 1]);
    assert.deepEqual(next.message.map(node => node.data.time), [4294967295, 1]);
    assert.equal(next.messages[1].content[0].data.text, 'new exact body\n');
    assert.deepEqual(next.message[1].data.content, next.messages[1].content);
    assert.equal(f.rawCalls.length, 2);
});

test('custom probe rechecks the exact root binding before issuing the fixed resource read', async () => {
    const changes = [root => { root.msgId = CHILD; }, root => { root.chatType = 1; }, root => { root.peerUid = '2000000002'; },
        root => { root.elements = [merged('substituted-resource')]; }, root => { root.elements.push(merged('ambiguous-root')); }];
    for (const change of changes) {
        const f = fallbackFixture(); let reads = 0;
        f.handlers.get = (_peer, ids) => {
            assert.deepEqual(ids, [ROOT]); const root = message();
            if (++reads === 2) change(root);
            return { result: 0, msgList: [root] };
        };
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
        assert.equal(reads, 2); assert.equal(f.rawCalls.length, 0);
        assert.equal(f.authorCalls.length, 0); assert.equal(f.keyCalls.length, 0);
        assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 0);
    }
});

test('custom resources preserve raw nicknames and times when native expansion would succeed with replaced metadata', async () => {
    const f = fallbackFixture();
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('native replacement')])] });
    const first = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.deepEqual(first.messages.map(value => value.sender.nickname), f.nodes.map(value => value.nickname));
    assert.deepEqual(first.messages.map(value => value.time), f.nodes.map(value => Number(value.time)));
    const standard = await f.run('get_forward_msg', { id: first.id });
    assert.deepEqual(standard.message, first.message); assert.deepEqual(standard.messages, first.messages);
    assert.equal(f.calls.some(call => call.method === 'getMultiMsg'), false);
    assert.equal(f.rawCalls.length, 2);
});

test('unknown custom rich content remains an ordered partial resource without replacing display metadata', async () => {
    const f = fallbackFixture();
    f.nodes[1].body = fbBody(fbB(99, Buffer.from([1])));
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('silently omitted custom content')])] });
    const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.equal(result._freshwater.content_status, 'partial');
    assert.equal(result.messages[1].content[0].type, 'text');
    assert.match(result.messages[1].content[0].data.text, /协议字段99/);
    assert.equal(f.rawCalls.length, 1); assert.ok(f.authorCalls.length > 0);
    assert.equal(f.calls.some(call => call.method === 'getMultiMsg'), false);
});

test('native 175 probing retains 1000-node, 8 MiB rich content and native nested parent identities', async () => {
    const f = fallbackFixture('native');
    f.nodes[0].body = fbBody(fbB(99, Buffer.alloc(300000, 1)));
    const records = Array.from({ length: 1000 }, (_, index) => message(String(100000 + index), [text('x'.repeat(6000)),
        { elementType: 6, faceElement: { faceIndex: 14 } }]));
    records[0].elements.push(merged('nested-native-resource'));
    f.handlers.read = () => ({ result: 0, msgList: records });
    const result = await f.read();
    assert.equal(result.records.length, 1000); assert.equal(Object.hasOwn(result, 'resourceNodes'), false);
    assert.equal(result.records[1].elements[1].faceElement.faceIndex, 14);
    assert.ok(Buffer.byteLength(JSON.stringify(result.records)) > fallbackProtocol.MAX_BYTES);
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('nested native contents')])] });
    const nested = await f.read({ parentMsgId: records[0].msgId });
    assert.equal(nested.records[0].elements[0].textElement.content, 'nested native contents');
    assert.equal(f.rawCalls.length, 1); assert.equal(f.authorCalls.length, 0);
    assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 2);
});

test('unavailable preclassification transports preserve successful native reads without decoding custom authors', async () => {
    for (const code of ['BUSY', 'QUERY_FAILED', 'UNSUPPORTED', 'INVALID_CONFIG', 'KERNEL_ERROR', 'INVALID_RESPONSE']) {
        const f = fallbackFixture('native');
        f.rawTransport.run = async () => { throw Object.assign(Error('private transport failure'), { code }); };
        f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('ordinary native content')])] });
        const result = await f.read();
        assert.equal(result.records[0].elements[0].textElement.content, 'ordinary native content');
        assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 1);
        assert.equal(f.authorCalls.length, 0); assert.equal(f.capture.pending.size, 0);
    }
});

test('a short pending probe yields to native reading and aborts a late positive candidate', async () => {
    const f = fallbackFixture(), original = f.rawTransport.run; let release;
    f.rawTransport.run = async (...args) => {
        const value = await original(...args);
        return new Promise(resolve => { release = () => resolve(value); });
    };
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('native within caller deadline')])] });
    const started = Date.now(), result = await f.read();
    assert.equal(result.records[0].elements[0].textElement.content, 'native within caller deadline');
    assert.ok(Date.now() - started < 4000);
    assert.ok(f.rawCalls[0].timeoutMs <= 1500); assert.equal(f.rawCalls[0].signal.aborted, true);
    const count = f.calls.length; release();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, count); assert.equal(f.authorCalls.length, 0); assert.equal(f.capture.pending.size, 0);
});

test('a stalled probe root revalidation yields to native reading without a late raw packet', async () => {
    const f = fallbackFixture(), original = f.handlers.get; let lookups = 0, release;
    f.handlers.get = (target, ids) => {
        if (++lookups === 2) return new Promise(resolve => { release = () => resolve({ result: 0, msgList: [message()] }); });
        return original ? original(target, ids) : { result: 0, msgList: ids.map(id => message(id)) };
    };
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [text('native after stalled probe root')])] });
    assert.equal((await f.read()).records[0].elements[0].textElement.content, 'native after stalled probe root');
    assert.equal(f.rawCalls.length, 0); assert.equal(f.authorCalls.length, 0);
    release(); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.rawCalls.length, 0); assert.equal(f.capture.pending.size, 0);
});

test('total expiry and scope loss during a probe prevent any native continuation', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
    for (const mode of ['deadline', 'session', 'notReady']) {
        const f = fallbackFixture('native'), original = f.rawTransport.run;
        if (mode === 'deadline') f.rawTransport.run = () => new Promise(() => {});
        else f.rawTransport.run = async (...args) => {
            const value = await original(...args);
            if (mode === 'session') f.capture.session = {};
            else f.capture.ready = false;
            return value;
        };
        const pending = f.forward.run({ kind: 'read', peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT },
            { expiresAt: Date.now() + (mode === 'deadline' ? 40 : 2000) });
        const rejected = assert.rejects(pending,
        error => {
            if (mode === 'deadline') assert.ok(['TIMEOUT', 'EXPIRED'].includes(error.code));
            else assert.equal(error.code, mode === 'session' ? 'SESSION_CHANGED' : 'NOT_READY');
            return true;
        });
        await new Promise(resolve => setImmediate(resolve));
        if (mode === 'deadline') t.mock.timers.tick(40);
        await rejected;
        assert.equal(f.calls.some(call => call.method === 'getMultiMsg'), false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.authorCalls.length, 0); assert.equal(f.capture.pending.size, 0);
    }
});

test('fallback receives the observed root, peer, resource, epoch and original cancellation context', async () => {
    const f = fixture(), controller = new AbortController(); let called = 0;
    const endsAt = Date.now() + 9000;
    f.handlers.read = () => ({ result: 1 });
    const expected = { peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, resId: 'root-resource', resourceNodes: [] };
    f.capture.forwardResourceReadApi = { async read(params, context) {
        called++;
        assert.deepEqual(params, { peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, resId: 'root-resource', expectedEpoch: state().epoch });
        assert.equal(context.signal, controller.signal); assert.equal(context.expiresAt, endsAt);
        return expected;
    } };
    const result = await f.forward.run({ kind: 'read', peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, resId: 'root-resource' },
        { signal: controller.signal, expiresAt: endsAt });
    assert.equal(result, expected); assert.equal(called, 1);
    assert.deepEqual(f.calls.map(call => call.method), ['getMsgsByMsgId', 'getMultiMsg']);
});

test('native success and malformed native responses do not activate resource fallback', async () => {
    const responses = [{ result: 0, msgList: [message(CHILD, [text('native wins')])] }, undefined, {}, { result: 0 },
        { result: 0, msgList: null }, { result: 0, msgList: [message(CHILD), message(CHILD)] }];
    for (const [index, response] of responses.entries()) {
        const f = fixture(); let reads = 0;
        f.capture.forwardResourceReadApi = { async read() { reads++; throw new Error('fallback must remain unused'); } };
        f.handlers.read = () => response;
        if (index === 0) assert.equal((await f.read()).records[0].elements[0].textElement.content, 'native wins');
        else await assert.rejects(f.read(), fails('INVALID_RESPONSE'));
        assert.equal(reads, 0); assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 1);
    }
});

test('native read session, cancellation, deadline and other non-kernel errors do not fall back', async () => {
    for (const code of ['SESSION_CHANGED', 'EXPIRED', 'TIMEOUT', 'NOT_READY', 'UNSUPPORTED', 'INVALID_RESPONSE']) {
        const f = fixture(); let reads = 0;
        f.capture.forwardResourceReadApi = { async read() { reads++; throw new Error('must not read'); } };
        f.handlers.read = () => { throw Object.assign(new Error('synthetic native failure'), { code }); };
        await assert.rejects(f.read(), fails(code)); assert.equal(reads, 0);
    }
    for (const mode of ['epoch', 'session', 'uid', 'uin', 'ready', 'cancel', 'expired']) {
        const f = fixture(), controller = new AbortController(); let reads = 0, clock = Date.now();
        const forward = createForward(f.capture, { now: () => clock });
        f.capture.forwardResourceReadApi = { async read() { reads++; throw new Error('must not read'); } };
        f.handlers.read = () => {
            if (mode === 'epoch') f.capture.epoch = 'another-session';
            if (mode === 'session') f.capture.session = { ...f.capture.session };
            if (mode === 'uid') f.capture.self = { ...f.capture.self, uid: 'u_other' };
            if (mode === 'uin') f.capture.self = { ...f.capture.self, uin: '1000000002' };
            if (mode === 'ready') f.capture.ready = false;
            if (mode === 'cancel') controller.abort();
            if (mode === 'expired') clock += 10001;
            return { result: 1 };
        };
        await assert.rejects(forward.run({ kind: 'read', peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT },
            { signal: controller.signal }), fails(mode === 'ready' ? 'NOT_READY' : ['cancel', 'expired'].includes(mode) ? 'EXPIRED' : 'SESSION_CHANGED'));
        assert.equal(reads, 0); assert.equal(f.calls.filter(call => call.method === 'getMultiMsg').length, 1);
        assert.equal(f.capture.pending.size, 0);
    }
});

test('observed nested native parents never fall back to the outer root resource', async () => {
    const f = fixture(); let reads = 0;
    f.capture.forwardResourceReadApi = { async read() { reads++; throw new Error('nested fallback must not be called'); } };
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [merged('inner-resource')])] });
    await f.read();
    f.handlers.read = () => ({ result: 1 });
    await assert.rejects(f.read({ parentMsgId: CHILD }), fails('KERNEL_ERROR'));
    assert.equal(reads, 0);
    assert.deepEqual(f.calls.filter(call => call.method === 'getMultiMsg').at(-1).args, [{ ...SOURCE, guildId: '' }, ROOT, CHILD]);
});

test('public resource variant rejects mixed representations, forged child identities and unsupported content atomically', async () => {
    const source = () => ({ authorUin: '1000000003', authorUid: 'u_sender', nickname: 'Resource author', time: '1700000001', elements: [text('safe content')] });
    const response = () => ({ peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, resId: 'root-resource', resourceNodes: [source()] });
    const cases = [value => { value.records = []; }, value => { value.records = undefined; }, value => { value.resourceNodes = undefined; },
        value => { value.resourceNodes = []; }, value => { value.resourceNodes = Array.from({ length: 101 }, source); },
        value => { value.resourceNodes.push({ ...source(), msgId: CHILD }); },
        value => { value.resourceNodes.push({ ...source(), authorUid: 'not-a-native-uid' }); },
        value => { value.resourceNodes.push({ ...source(), nickname: 1 }); },
        value => { value.resourceNodes.push({ ...source(), time: '01' }); },
        value => { value.resourceNodes.push({ ...source(), elements: [text('no partial output'), { elementType: 999 }] }); }];
    for (const change of cases) {
        const f = protocolFixture(), value = response(); change(value);
        f.service.sessionCall = async (_state, method) => { assert.equal(method, 'forwardOperation'); return value; };
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
    }
    const conflicts = [{ ...text('conflicting payload'), arkElement: { bytesData: '{}' } }];
    for (const element of conflicts) {
        const f = protocolFixture(), value = response(); value.resourceNodes.push({ ...source(), elements: [element] });
        f.service.sessionCall = async () => value;
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
    }
    for (const element of [merged('unbound-inner-resource'), { ...picture(''), picElement: { ...picture('').picElement, isFlashPic: true } }]) {
        const f = protocolFixture(), value = response(); value.resourceNodes.push({ ...source(), elements: [element] });
        f.service.sessionCall = async () => value;
        const partial = await f.run('qqapi_get_forward_messages', { message_id: 1 });
        assert.equal(partial._freshwater.content_status, 'partial');
        assert.equal(partial.messages[1].content[0].type, 'text');
    }
});

test('resource fallback results remain bound to the exact public root, parent, peer and resource', async () => {
    for (const change of [value => { value.rootMsgId = CHILD; }, value => { value.parentMsgId = CHILD; },
        value => { value.peer = DESTINATION; }, value => { value.resId = 'different-resource'; }]) {
        const f = protocolFixture();
        const value = { peer: SOURCE, rootMsgId: ROOT, parentMsgId: ROOT, resId: 'root-resource', resourceNodes: [
            { authorUin: '1000000003', authorUid: 'u_sender', nickname: 'Verified author', time: '1700000001', elements: [text('exact body')] }
        ] };
        change(value); f.service.sessionCall = async () => value;
        await assert.rejects(f.run('qqapi_get_forward_messages', { message_id: 1 }), fails('INVALID_RESPONSE'));
    }
});

test('a resourceNodes response cannot be used below an independently observed native nested handle', async () => {
    const f = protocolFixture();
    f.handlers.read = () => ({ result: 0, msgList: [message(CHILD, [merged('inner-resource')])] });
    const initial = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    const nested = initial.messages[0].content[0].data.id;
    f.service.sessionCall = async () => ({ peer: SOURCE, rootMsgId: ROOT, parentMsgId: CHILD, resId: 'root-resource', resourceNodes: [
        { authorUin: '1000000003', authorUid: 'u_sender', nickname: 'Resource author', time: '1700000001', elements: [text('unbound nested resource')] }
    ] });
    await assert.rejects(f.run('get_forward_msg', { id: nested }), fails('INVALID_RESPONSE'));
});

test('unknown wire content in a resource fallback returns explicit ordered partial nodes', async () => {
    const f = fallbackFixture();
    f.nodes[1].body = fbBody(fbText('must not return the preceding node'), fbB(51, fbS(1, 'unhandled content')));
    const result = await f.run('qqapi_get_forward_messages', { message_id: 1 });
    assert.equal(result._freshwater.content_status, 'partial');
    assert.equal(result.messages[1].content[0].data.text, 'must not return the preceding node');
    assert.match(result.messages[1].content[1].data.text, /协议字段51/);
    assert.equal(f.rawCalls.length, 1); assert.ok(f.authorCalls.length > 0); assert.equal(f.keyCalls.length, 1);
    assert.equal(f.capture.pending.size, 0);
});
