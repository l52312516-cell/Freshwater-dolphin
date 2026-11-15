'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createMergedSend } = require('../src/qq/merged-send.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SELF = { uid: 'u_self', uin: '2068886823' }, DEST = { chatType: 2, peerUid: '1103828635' }, EPOCH = 'custom-merge-session';
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
const fails = code => error => { assert.equal(error.code, code, error.stack); return true; };
function fixture(t) {
    const calls = [], records = new Map(), merged = new Map(), hooks = {}; let sequence = 0;
    const capture = new Capture({ install: false, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    capture.ready = true; capture.epoch = EPOCH; capture.self = { ...SELF };
    const native = {
        generateMsgUniqueId() { return String(80000 + sequence); },
        sendMsg(_zero, target, elements) {
            calls.push({ method: 'sendMsg', target, elements });
            if (hooks.send) return hooks.send(target, elements);
            const index = ++sequence;
            const record = { chatType: target.chatType, peerUid: target.peerUid, guildId: target.guildId,
                msgId: String(18446744073709551000n + BigInt(index)), msgSeq: String(9007199254740993n + BigInt(index)),
                msgRandom: String(300000 + index), msgTime: '1794636400', senderUid: SELF.uid, senderUin: SELF.uin,
                sendStatus: 2, sendNickName: 'Real self', elements: structuredClone(elements) };
            records.set(record.msgId, record); capture.bus.emit('sent', [record]); return { result: 0 };
        },
        getMsgsByMsgId(target, ids) {
            calls.push({ method: 'getMsgsByMsgId', target, ids });
            const value = { result: 0, msgList: ids.map(id => records.get(id)) };
            return hooks.get ? hooks.get(target, ids, value) : value;
        },
        multiForwardMsgWithComment(...args) {
            calls.push({ method: 'merge', args });
            if (hooks.merge) return hooks.merge(...args);
            emitRoot(args); return { result: 0 };
        },
        getMultiMsg(target, id, parent) {
            calls.push({ method: 'getMultiMsg', target, id, parent });
            const value = { result: 0, msgList: merged.get(id) };
            return hooks.read ? hooks.read(target, id, parent, value) : value;
        }
    };
    function emitRoot(args, extra = {}) {
        const id = extra.msgId || String(18446744073709551500n + BigInt(merged.size));
        const root = { ...args[2], msgId: id, senderUid: SELF.uid, senderUin: SELF.uin, sendStatus: 2,
            elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'real-resource-' + id } }], ...extra };
        records.set(id, root);
        merged.set(id, args[0].map((node, index) => ({ ...structuredClone(records.get(node.msgId)),
            msgId: String(18446744073709551200n + BigInt(index)), sendNickName: node.senderShowName, guildId: '' })));
        capture.bus.emit('sent', [root]); return root;
    }
    capture.session = { getMsgService: () => native, getMSFService: () => ({ getServerTime: () => '1794636400' }) };
    const api = createMergedSend(capture);
    const run = (extra = {}, context) => api.run({ expectedEpoch: EPOCH, destination: DEST,
        nodes: [{ nickname: 'Node A', elements: [text(' a\n ')] }, { nickname: 'Node B', elements: [text('same text')] }], ...extra }, context);
    t.after(() => capture.close());
    return { capture, native, calls, records, merged, hooks, api, run, emitRoot };
}
function image(t, f) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'merged-send-image-'));
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF0sAAAAASUVORK5CYII=', 'base64');
    const filename = path.join(directory, 'pixel.png'), md5 = crypto.createHash('md5').update(bytes).digest('hex'); fs.writeFileSync(filename, bytes);
    f.capture.mediaTargetRoots = [directory];
    f.capture.preparedMedia.set(filename, { type: 'image', epoch: EPOCH, at: Date.now(), md5, size: bytes.length });
    t.after(() => { assert.ok(directory.startsWith(parent + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
    return { elementType: 2, picElement: { sourcePath: filename, md5HexStr: md5, fileSize: String(bytes.length), picWidth: 1, picHeight: 1, picSubType: 0 } };
}

test('native resource names remain the actual QQ-resolved names when display hints are overridden', async t => {
    const f = fixture(t);
    f.hooks.read = (_peer, _id, _parent, value) => ({ ...value, msgList: value.msgList.map(record => ({
        ...record, sendNickName: 'QQ actual nickname', sendMemberName: 'QQ actual card'
    })) });
    const result = await f.run();
    assert.equal(result.confirmed, true);
    assert.equal(result.records[0].sendNickName, 'QQ actual nickname');
});

test('100 native nodes with real-sized metadata fit the bounded aggregate RPC response', async t => {
    const f = fixture(t);
    f.hooks.read = (_peer, _id, _parent, value) => ({ ...value, msgList: value.msgList.map(record => ({
        ...record, nativeMetadata: 'x'.repeat(6000)
    })) });
    const result = await f.run({ nodes: Array.from({ length: 100 }, (_, index) => ({ nickname: 'Batch', elements: [text('node ' + index)] })) });
    assert.equal(result.nodeCount, 100); assert.equal(result.records.length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024);
    assert.equal(f.calls.filter(row => row.method === 'merge').length, 1);
});

test('QQ ordinary images with a nullable flash flag retain the exact prepared image signature', async t => {
    const f = fixture(t), picture = image(t, f);
    f.hooks.get = (_peer, _ids, value) => {
        for (const record of value.msgList) for (const element of record.elements) {
            if (element.picElement) element.picElement.isFlashPic = null;
        }
        return value;
    };
    const result = await f.run({ nodes: [{ nickname: 'Picture', elements: [picture, text(' native nullable flag ')] }] });
    assert.equal(result.confirmed, true); assert.equal(result.records[0].elements[0].picElement.isFlashPic, null);
});

test('a resource without any real author display name remains invalid', async t => {
    const f = fixture(t);
    f.hooks.read = (_peer, _id, _parent, value) => ({ ...value, msgList: value.msgList.map(record => ({
        ...record, sendNickName: '', sendMemberName: '', senderNickname: ''
    })) });
    await assert.rejects(f.run(), fails('INVALID_RESPONSE'));
});

test('custom merged text stages fresh self messages and proves ordered complete resources without guild correlation', async t => {
    const f = fixture(t), result = await f.run();
    assert.equal(result.confirmed, true); assert.equal(result.confirmation, 'fresh-source-tuple-and-resource-readback');
    assert.equal(result.nodeCount, 2); assert.equal(result.destination.peerUid, DEST.peerUid);
    assert.equal(result.source.peerUid, SELF.uid); assert.equal(result.sourceMsgIds.length, 2);
    assert.equal(f.calls.filter(row => row.method === 'sendMsg').length, 2); assert.equal(f.calls.filter(row => row.method === 'merge').length, 1);
    const args = f.calls.find(row => row.method === 'merge').args;
    assert.deepEqual(args[0].map(item => item.senderShowName), ['Node A', 'Node B']);
    assert.deepEqual(args[1], { chatType: 1, peerUid: SELF.uid, guildId: '' }); assert.deepEqual(args[2], { ...DEST, guildId: '' });
    assert.equal(result.record.guildId, ''); assert.equal(result.records[0].elements[0].textElement.content, ' a\n ');
    assert.equal(result.records[0].msgSeq, '9007199254740994'); assert.equal(f.capture.bus.listenerCount('sent'), 0);
});

test('public capability flags require real verified-version native methods', t => {
    const f = fixture(t); assert.equal(f.api.capabilities().mergedText, true);
    delete f.native.getMultiMsg; assert.equal(f.api.capabilities().mergeCustom, false);
    f.capture.qqVersion = 'unknown'; assert.equal(f.api.capabilities().mergedText, false);
});

test('the whole batch is prevalidated before any selfchat side effect', async t => {
    const variants = [
        { nodes: [] }, { nodes: Array.from({ length: 101 }, () => ({ nickname: 'n', elements: [text('n')] })) },
        { nodes: [{ nickname: 'ok', elements: [text('ok')] }, { nickname: 'bad', elements: [{ elementType: 5, videoElement: {} }] }] },
        { nodes: [{ nickname: 'bad\nname', elements: [text('x')] }] },
        { nodes: [{ nickname: 'n', elements: [text('x'.repeat(65537))] }] },
        { nodes: [{ nickname: 'n', elements: [text('x')], user_id: SELF.uin }] },
        { nodes: [{ nickname: 'n', elements: [{ elementType: 1, textElement: { content: 'mention', atType: 2 } }] }] },
        { nodes: [{ nickname: 'n', elements: [{ elementType: 2, picElement: { md5HexStr: 'a'.repeat(32), fileSize: '1', picWidth: 1, picHeight: 1, sourcePath: '/unprepared' } }] }] },
        { timeoutMs: 60001 }, { destination: { chatType: 1, peerUid: SELF.uin } }
    ];
    for (const variant of variants) { const f = fixture(t); await assert.rejects(f.run(variant), fails('INVALID_PARAMS')); assert.equal(f.calls.length, 0); }
});

test('stale epochs and unsupported methods cannot stage messages', async t => {
    const f = fixture(t); await assert.rejects(f.run({ expectedEpoch: 'old' }), fails('SESSION_CHANGED'));
    delete f.native.multiForwardMsgWithComment; await assert.rejects(f.run(), fails('UNSUPPORTED')); assert.equal(f.calls.length, 0);
    const g = fixture(t); g.capture.qqVersion = 'unknown';
    assert.equal(g.api.capabilities().mergeCustom, false); await assert.rejects(g.run(), fails('UNSUPPORTED')); assert.equal(g.calls.length, 0);
});

test('previous session-local stage IDs and full signatures cannot be reused as fresh sources', async t => {
    for (const mode of ['id', 'signature']) {
        const f = fixture(t), first = await f.run(), previous = f.records.get(first.sourceMsgIds[0]);
        if (mode === 'id') f.hooks.send = (target, _elements) => { f.capture.bus.emit('sent', [{ ...previous, guildId: target.guildId }]); return { result: 0 }; };
        else f.hooks.get = (target, _ids, value) => {
            if (target.chatType === 1) Object.assign(value.msgList[0], { msgSeq: previous.msgSeq, msgRandom: previous.msgRandom, msgTime: previous.msgTime });
            return value;
        };
        await assert.rejects(f.run(), fails('INVALID_RESPONSE')); assert.equal(f.calls.filter(row => row.method === 'merge').length, 1);
    }
});

test('an unconfirmed staging send never reaches merge and remains reserved until session replacement', async t => {
    const f = fixture(t); f.hooks.send = () => ({ result: 0 });
    await assert.rejects(f.run({ timeoutMs: 30 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    assert.equal(f.calls.filter(row => row.method === 'merge').length, 0);
    await assert.rejects(f.run(), fails('BUSY'));
    f.capture.epoch = 'replacement'; delete f.hooks.send;
    assert.equal((await f.run({ expectedEpoch: 'replacement' })).confirmed, true);
});

test('explicit validation and QQ staging rejections release the lock without retrying the failed call', async t => {
    for (const code of ['INVALID_PARAMS', 'SEND_FAILED', 'KERNEL_ERROR']) {
        const f = fixture(t), original = f.capture.sendMessage;
        f.capture.sendMessage = async () => { throw Object.assign(new Error('explicit refusal'), { code }); };
        await assert.rejects(f.run(), fails(code)); assert.equal(f.calls.length, 0);
        f.capture.sendMessage = original;
        assert.equal((await f.run()).confirmed, true); assert.equal(f.calls.filter(row => row.method === 'merge').length, 1);
    }
});

test('staging requires exact nonzero string seq/random, self identity and fresh complete content', async t => {
    for (const mutate of [record => { record.msgSeq = 0; }, record => { record.msgRandom = '0'; },
        record => { record.msgSeq = 9007199254740994; }, record => { record.senderUid = 'u_other'; },
        record => { record.elements = [text('changed')]; }, record => { record.sendStatus = 3; }]) {
        const f = fixture(t); f.hooks.get = (_target, _ids, value) => { mutate(value.msgList[0]); return value; };
        await assert.rejects(f.run(), fails('INVALID_RESPONSE')); assert.equal(f.calls.some(row => row.method === 'merge'), false);
    }
});

test('QQ rebuilt child IDs are accepted but changed order, sequence, random, sender, time or text are not', async t => {
    for (const key of ['order', 'msgSeq', 'msgRandom', 'senderUid', 'senderUin', 'msgTime', 'text', 'duplicate-id']) {
        const f = fixture(t); f.hooks.read = (_target, _id, _parent, value) => {
            const result = structuredClone(value);
            if (key === 'order') result.msgList.reverse();
            else if (key === 'text') result.msgList[0].elements[0].textElement.content = 'changed';
            else if (key === 'duplicate-id') result.msgList[1].msgId = result.msgList[0].msgId;
            else result.msgList[0][key] = key === 'senderUid' ? 'u_wrong' : '999';
            return result;
        };
        await assert.rejects(f.run({ timeoutMs: 30 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        assert.equal(f.calls.filter(row => row.method === 'merge').length, 1); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    }
});

test('multiple exact fresh-tuple roots are ambiguous, duplicate updates of one root are harmless', async t => {
    const f = fixture(t); f.hooks.merge = (...args) => { f.emitRoot(args); f.emitRoot(args); return { result: 0 }; };
    await assert.rejects(f.run(), fails('INVALID_RESPONSE'));
    const g = fixture(t); g.hooks.merge = (...args) => { const root = g.emitRoot(args); g.capture.bus.emit('sent', [root]); return { result: 0 }; };
    assert.equal((await g.run()).confirmed, true);
});

test('unrelated merged roots cannot confirm the new sources or replace a later matching root', async t => {
    const f = fixture(t); f.hooks.merge = (...args) => {
        const unrelated = f.emitRoot(args); f.merged.get(unrelated.msgId)[0].msgRandom = '999';
        f.emitRoot(args); return { result: 0 };
    };
    const result = await f.run(); assert.equal(result.messageId, '18446744073709551501');
});

test('explicit native failures cannot be hidden by an otherwise matching root', async t => {
    for (const reply of [{ result: 7 }, null, true, { result: '0' }]) {
        const f = fixture(t); f.hooks.merge = (...args) => { f.emitRoot(args); return reply; };
        await assert.rejects(f.run(), error => ['KERNEL_ERROR', 'INVALID_RESPONSE'].includes(error.code));
        assert.equal(f.calls.filter(row => row.method === 'merge').length, 1); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    }
});

test('void and numeric-zero native acceptance still require resource proof', async t => {
    for (const reply of [undefined, 0]) {
        const f = fixture(t); f.hooks.merge = (...args) => { f.emitRoot(args); return reply; }; assert.equal((await f.run()).confirmed, true);
        const g = fixture(t); g.hooks.merge = () => reply;
        await assert.rejects(g.run({ timeoutMs: 30 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    }
});

test('native promise retains the account lock after timeout and is never retried', async t => {
    const f = fixture(t); let settle; f.hooks.merge = () => new Promise(resolve => { settle = resolve; });
    await assert.rejects(f.run({ timeoutMs: 30 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    await assert.rejects(f.run(), fails('BUSY')); assert.equal(f.calls.filter(row => row.method === 'merge').length, 1);
    settle({ result: 0 }); await new Promise(resolve => setImmediate(resolve)); delete f.hooks.merge;
    assert.equal((await f.run()).confirmed, true); assert.equal(f.capture.bus.listenerCount('sent'), 0);
});

test('candidate overflow fails rather than selecting the newest root', async t => {
    const f = fixture(t); f.hooks.merge = (...args) => { for (let index = 0; index < 33; index++) f.emitRoot(args); return { result: 0 }; };
    await assert.rejects(f.run(), fails('INVALID_RESPONSE')); assert.equal(f.capture.bus.listenerCount('sent'), 0);
});

test('unbounded native author display names remain invalid', async t => {
    const f = fixture(t); f.hooks.read = (_target, _id, _parent, value) => {
        value.msgList[0].sendNickName = 'x'.repeat(513);
        value.msgList[0].sendMemberName = ''; value.msgList[0].senderNickname = ''; return value;
    };
    await assert.rejects(f.run(), fails('INVALID_RESPONSE'));
});

test('completed Ark10 roots and private UID destinations use their actual resource identities', async t => {
    const f = fixture(t); f.hooks.merge = (...args) => {
        f.emitRoot(args, { elements: [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'real-ark-resid' } } }) } }] });
        return { result: 0 };
    };
    const result = await f.run({ destination: { chatType: 1, peerUid: 'u_destination' } });
    assert.equal(result.resId, 'real-ark-resid'); assert.equal(result.destination.peerUid, 'u_destination');
});

test('mixed image nodes verify prepared bytes and stable metadata while ignoring native paths and URL changes', async t => {
    const f = fixture(t), pic = image(t, f);
    f.hooks.read = (_target, _id, _parent, value) => {
        const image = value.msgList[0].elements[1].picElement; image.sourcePath = '/native/other'; image.originImageUrl = 'https://native/resource';
        image.fileUuid = 'changed'; image.fileSize = Number(image.fileSize); image.picWidth = '1'; image.picHeight = '1'; return value;
    };
    assert.equal((await f.run({ nodes: [{ nickname: 'Picture', elements: [text('before'), pic, text('after')] }] })).confirmed, true);
});

test('a later invalid prepared image stops the entire batch before the first stage', async t => {
    const f = fixture(t), pic = image(t, f); fs.appendFileSync(pic.picElement.sourcePath, 'changed');
    await assert.rejects(f.run({ nodes: [{ nickname: 'text', elements: [text('must not send')] }, { nickname: 'image', elements: [pic] }] }), fails('INVALID_PARAMS'));
    assert.equal(f.calls.length, 0);
});

test('session changes and cancellation cannot cross staging into a new-account merge', async t => {
    for (const mode of ['session', 'abort']) {
        const f = fixture(t), controller = new AbortController();
        f.hooks.get = (_target, _ids, value) => { if (mode === 'session') f.capture.epoch = 'other'; else controller.abort(); return value; };
        await assert.rejects(f.run({}, { signal: controller.signal }), error => ['SESSION_CHANGED', 'EXPIRED'].includes(error.code));
        assert.equal(f.calls.filter(row => row.method === 'merge').length, 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    }
});
