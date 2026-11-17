'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gunzipSync, gzipSync } = require('node:zlib');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/forward-upload-protocol.cjs');
const { createCustomMergedResource } = require('../src/qq/custom-merged-resource.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const join = (...values) => Buffer.concat(values);
const one = (bytes, field) => p.fields(bytes).get(field)[0].value;
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
const SELF = { uin: '11111', uid: 'u_self' }, TARGET = { chatType: 2, peerUid: '33333' };
function fixture() {
    const calls = [], hooks = {};
    let payload, root, submittedNodes;
    const capture = {
        epoch: 'resource-epoch', session: {}, self: { ...SELF }, ensureReady() {}, hasMethods: () => true,
        deadline: task => task(),
        resolve: async ({ uin }) => { calls.push('resolve'); return hooks.resolve ? hooks.resolve(uin) : { uin, uid: 'u_other' }; },
        async invoke(service, method) {
            calls.push(method);
            if (method === 'getServerTime') return '1794636400123';
            assert.fail('Unexpected native operation');
        },
        async sendNativeElements(target, elements, _context, options) {
            calls.push('send'); options.verifyBeforeSubmit();
            const card = JSON.parse(elements[0].arkElement.bytesData), extra = JSON.parse(card.extra);
            assert.equal(extra.filename, card.meta.detail.uniseq);
            assert.match(extra.filename, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
            assert.equal(Object.hasOwn(card.meta.detail, 'tSum'), false);
            assert.equal(extra.tsum, submittedNodes.length);
            root = { ...target, msgId: '18446744073709551000', senderUin: SELF.uin, senderUid: SELF.uid, sendStatus: 2, elements };
            if (hooks.root) hooks.root(root);
            return root;
        }
    };
    capture.forwardResourceReadApi = { async read(params) {
        calls.push('resource-read');
        assert.deepEqual(params, { peer: TARGET, rootMsgId: root.msgId, parentMsgId: root.msgId,
            resId: 'fixture-resource', expectedEpoch: capture.epoch });
        const resourceNodes = protocol.decodePayload(payload).nodes.map((node, index) => ({ authorUin: node.authorUin,
            authorUid: node.authorUin === SELF.uin ? SELF.uid : 'u_other', time: node.time,
            nickname: node.nickname, elements: hooks.finalElements ? structuredClone(hooks.finalElements[index]) : p.fields(one(node.body, 1)).get(2).map(element => text(one(one(element.value, 1), 1).toString())) }));
        if (hooks.children) hooks.children(resourceNodes);
        const { expectedEpoch: _epoch, ...binding } = params;
        const result = { ...binding, resourceNodes };
        if (hooks.resource) hooks.resource(result);
        return result;
    } };
    const native = { available: () => true, async run(_capture, args) {
        calls.push(args.cmd.endsWith('SsoSendLongMsg') ? 'upload' : 'read');
        if (args.cmd.endsWith('SsoSendLongMsg')) {
            payload = gunzipSync(one(one(Buffer.from(args.data, 'hex'), 2), 4));
            submittedNodes = protocol.decodePayload(payload).nodes;
            if (hooks.upload) await hooks.upload(capture);
            return { responseHex: b(2, s(3, 'fixture-resource')).toString('hex') };
        }
        const returned = payload ? (hooks.payload ? hooks.payload(payload) : payload) : hooks.sourcePayload;
        return { responseHex: b(1, join(s(3, 'fixture-resource'), b(4, gzipSync(returned)))).toString('hex') };
    } };
    const api = createCustomMergedResource(capture, { native });
    const params = () => ({ kind: 'customResourceMerge', expectedEpoch: capture.epoch, destination: TARGET,
        nodes: [{ authorUin: '22222', nickname: 'Other', time: 1700000001, elements: [text('  first\n'), text('second')] },
            { authorUin: SELF.uin, nickname: 'Self', time: 0, elements: [text('third')] }] });
    return { capture, api, calls, hooks, params, run: (extra = {}, context) => api.run({ ...params(), ...extra }, context), nodes: () => submittedNodes };
}

test('custom authors and explicit/default times survive upload and delivered root expansion without source chat writes', async () => {
    const f = fixture(), result = await f.run();
    assert.equal(result.confirmation, 'custom-resource-metadata-and-delivery-readback');
    assert.equal(result.messageId, '18446744073709551000');
    assert.deepEqual(f.nodes().map(node => [node.authorUin, node.nickname, node.time]),
        [['22222', 'Other', '1700000001'], ['11111', 'Self', '1794636400']]);
    assert.deepEqual(f.calls, ['resolve', 'getServerTime', 'upload', 'read', 'send', 'resource-read']);
    assert.equal(result.resourceNodes.every(node => !Object.hasOwn(node, 'msgId')), true);
});

test('changed complete resource content is rejected before the destination message is sent', async () => {
    const f = fixture(); f.hooks.payload = raw => { const copy = Buffer.from(raw); copy[copy.indexOf(Buffer.from('first'))] = 120; return copy; };
    await assert.rejects(f.run(), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.includes('send'), false);
    await assert.rejects(f.run(), { code: 'BUSY' });
    assert.equal(f.calls.filter(value => value === 'upload').length, 1);
});

test('a delivered card alone cannot prove original node authors, names, times, order or text', async () => {
    for (const mutation of [nodes => { nodes[0].authorUid = SELF.uid; }, nodes => { nodes[0].authorUin = SELF.uin; },
        nodes => { nodes[0].nickname = 'Other name'; }, nodes => { nodes[0].time = '1700000002'; },
        nodes => { nodes.reverse(); }, nodes => { nodes[0].elements[0].textElement.content = 'changed'; }, nodes => { nodes.pop(); }]) {
        const f = fixture(); f.hooks.children = mutation;
        await assert.rejects(f.run(), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.filter(value => value === 'send').length, 1);
    }
});

test('root delivery must preserve the exact destination, status, sender and resource', async () => {
    for (const mutation of [root => { root.peerUid = '44444'; }, root => { root.sendStatus = 0; },
        root => { root.senderUid = 'u_other'; }, root => { root.msgId = 123; }, root => { root.elements[0].arkElement.bytesData = '{}'; }]) {
        const f = fixture(); f.hooks.root = mutation;
        await assert.rejects(f.run(), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.includes('resource-read'), false);
    }
});

test('post-delivery resource reading must bind its exact root and return the complete batch', async () => {
    for (const mutation of [value => { value.rootMsgId = '42'; }, value => { value.parentMsgId = '43'; },
        value => { value.resId = 'another-resource'; }, value => { value.peer = { chatType: 1, peerUid: SELF.uid }; },
        value => { value.resourceNodes = []; }, value => { value.resourceNodes = undefined; }]) {
        const f = fixture(); f.hooks.resource = mutation;
        await assert.rejects(f.run(), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.filter(value => value === 'upload').length, 1);
        assert.equal(f.calls.filter(value => value === 'send').length, 1);
        await assert.rejects(f.run(), { code: 'BUSY' });
    }
});

test('author resolution and complete batch validation happen before any upload or chat send', async () => {
    const f = fixture(); f.hooks.resolve = uin => ({ uin: '33333', uid: 'u_other' });
    await assert.rejects(f.run(), { code: 'NOT_FOUND' });
    assert.deepEqual(f.calls, ['resolve']);
    for (const extra of [{ nodes: [{ authorUin: '22222', nickname: 'Other', time: -1, elements: [text('text')] }] },
        { timeoutMs: 60001 }, { expectedEpoch: 'old' }]) {
        const g = fixture(); await assert.rejects(g.run(extra)); assert.equal(g.calls.length, 0);
    }
    const g = fixture(); await assert.rejects(g.run({}, { expiresAt: NaN }), { code: 'INVALID_PARAMS' }); assert.equal(g.calls.length, 0);
});

test('physical in-flight uploads remain locked and a changed account cannot send their resource', async () => {
    const f = fixture(); let release;
    f.hooks.upload = () => new Promise(resolve => { release = resolve; });
    const task = f.run();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.run(), { code: 'BUSY' });
    f.capture.epoch = 'new-epoch'; release();
    await assert.rejects(task, { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.includes('send'), false);
});

test('capture gives metadata merging the same shared long deadline as native merging', async t => {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    t.after(() => capture.close()); capture.ready = true; capture.epoch = 'epoch'; capture.session = {};
    capture.forwardOperation = async (_params, context) => ({ remaining: context.expiresAt - Date.now(), signal: context.signal });
    const result = await capture.call('forwardOperation', { kind: 'customResourceMerge', timeoutMs: 45000, expectedEpoch: 'epoch' });
    assert.ok(result.remaining > 44000 && result.remaining <= 45000);
    assert.equal(result.signal.aborted, true);
});

function nativeImageFixture() {
    const f = fixture(), params = f.params();
    params.nodes[0].elements.push({ elementType: 2, picElement: { md5HexStr: 'a'.repeat(32), fileSize: '123', picWidth: 12, picHeight: 13 } });
    f.hooks.finalElements = params.nodes.map(node => node.elements);
    const stagedRecords = params.nodes.map((node, index) => ({ senderUin: SELF.uin, senderUid: SELF.uid,
        msgTime: '1794636400', msgRandom: String(100 + index), msgSeq: String(900 + index), elements: node.elements }));
    const bodies = params.nodes.map((node, index) => b(1, join(b(2, b(1, s(1, 'native complete text ' + index))),
        ...(index === 0 ? [b(2, b(53, Buffer.from('native-image-body-owned-by-qq')))] : []))));
    f.hooks.sourcePayload = b(2, join(s(1, 'MultiMsg'), b(2, join(...stagedRecords.map((record, index) => b(1, join(
        b(1, join(n(1, SELF.uin), s(2, SELF.uid), b(7, join(s(6, 'actual native nickname'), n(11, 1))))),
        b(2, join(n(1, 9), n(2, 175), n(3, 175), n(4, record.msgRandom), n(5, 700 + index), n(6, record.msgTime),
            n(7, 1), n(11, 123456), b(15, join(n(1, 0), n(2, 0), n(3, 2), b(4, Buffer.alloc(44, 1)), b(5, Buffer.alloc(159, 2)))))),
        b(3, bodies[index]))))))));
    f.capture.mergedSendApi = { async run(args) {
        f.calls.push('native-stage');
        assert.equal(args.destination.peerUid, SELF.uid);
        assert.deepEqual(args.nodes.map(node => Object.keys(node)), [['nickname', 'elements'], ['nickname', 'elements']]);
        return { confirmed: true, confirmation: 'fresh-source-tuple-and-resource-readback', destination: args.destination,
            nodeCount: 2, resId: 'fixture-resource', record: { elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'fixture-resource' } }] }, records: stagedRecords };
    } };
    return { ...f, params, bodies, stagedRecords };
}

test('native image body is preserved byte-for-byte while only custom author headers and times are rebuilt', async () => {
    const f = nativeImageFixture(), result = await f.api.run(f.params);
    assert.equal(result.confirmed, true);
    assert.equal(f.calls.filter(value => value === 'native-stage').length, 1);
    assert.equal(f.calls.filter(value => value === 'upload').length, 1);
    assert.ok(f.nodes().every((node, index) => node.body.equals(f.bodies[index])));
    assert.equal(f.nodes()[0].authorUin, '22222');
    assert.equal(f.nodes()[0].time, '1700000001');
});

test('image source with changed verified native tuple cannot reach custom upload or target send', async () => {
    for (const field of ['msgRandom', 'msgTime']) {
        const f = nativeImageFixture(); f.stagedRecords[0][field] = '123';
        await assert.rejects(f.api.run(f.params), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.includes('upload'), false);
        assert.equal(f.calls.includes('send'), false);
    }
});
