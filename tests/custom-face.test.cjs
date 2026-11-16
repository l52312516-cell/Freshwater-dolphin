'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const p = require('../src/qq/proto.cjs');
const media = require('../src/qq/media.cjs');
const { createCustomFace } = require('../src/qq/custom-face.cjs');
const { runCustomFace } = require('../src/onebot/custom-face-actions.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const md5 = crypto.createHash('md5').update(PNG).digest('hex');
const A = '12345_0_0_0_' + md5.toUpperCase() + '_0_0', B = '12345_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
function fixture(t, initial = [A, B]) {
    const temp = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temp, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temp, 'custom-face-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const state = { ids: [...initial], descriptions: new Map(), calls: [], requests: [], upload: true };
    const capture = { epoch: 'e1', self: { uin: '12345', uid: 'u_self' }, session: {}, mediaDirectory: directory,
        ensureReady() {}, hasMethods: () => true, deadline: operation => operation(), async prepareMedia(data) {
            state.calls.push({ prepareMedia: data });
            const image = media.readImage(directory, data.file);
            return { elementType: 2, elementId: '', picElement: { md5HexStr: image.md5, picSubType: 0, sourcePath: 'NATIVE-CACHE', summary: data.summary } };
        } };
    const native = { available: () => true, async run(_capture, request) {
        state.calls.push(request); const data = request.request;
        if (request.operation === 'face.list') return { uin: '12345', ids: [...state.ids], complete: true };
        if (request.operation === 'face.detail') return { uin: '12345', entries: data.ids.filter(id => state.descriptions.has(id)).map(emojiId => ({ emojiId, desc: state.descriptions.get(emojiId) })) };
        if (request.operation === 'face.delete') state.ids = state.ids.filter(id => id !== data.emojiId);
        if (request.operation === 'face.modify') state.descriptions.set(data.emojiId, data.desc);
        if (request.operation === 'face.reorder') state.ids = [...data.ids];
        if (request.operation === 'face.uploadSession') return { servers: [{ host: '42.81.1.9', port: 80 }] };
        if (request.operation === 'face.uploadTicket') return { token: Buffer.alloc(128, 1) };
        return { ...data, acknowledged: true };
    } };
    const api = createCustomFace(capture, { native, fetchImpl: async (url, request) => {
        state.requests.push({ url, request });
        if (url.startsWith('https://p.qpic.cn/qq_expression/')) return new Response(PNG);
        const body = request.body, head = p.fields(body.subarray(9, 9 + body.readUInt32BE(1))), identity = p.fields(p.one(head, 3).value);
        const emojiId = p.one(identity, 1).value.toString();
        if (state.upload) state.ids.push(emojiId);
        const size = body.readUInt32BE(5), ackHead = p.messageField(2, [p.varintField(2, size), p.varintField(3, 0), p.varintField(4, size), p.varintField(5, 0)]);
        const prefix = Buffer.alloc(9); prefix[0] = 0x28; prefix.writeUInt32BE(ackHead.length, 1);
        return new Response(Buffer.concat([prefix, ackHead, Buffer.from([0x29])]));
    } });
    const context = () => ({ expiresAt: Date.now() + 1000 });
    return { state, capture, api, query: data => api.query({ ...data, expectedEpoch: capture.epoch }, context()), action: data => api.action({ ...data, expectedEpoch: capture.epoch }, context()) };
}

test('catalog reads preserve real IDs/URLs/MD5 and detail descriptions without losing complete-list provenance', async t => {
    const f = fixture(t); f.state.descriptions.set(A, '常用');
    const result = await f.query({ operation: 'face.list', count: 1, detail: true });
    assert.equal(result.total, 2); assert.equal(result.complete, false); assert.equal(result.faces.length, 1);
    assert.deepEqual(result.faces[0], { emojiId: A, md5: md5.toUpperCase(), url: 'https://p.qpic.cn/qq_expression/12345/' + A + '/0', desc: '常用' });
    const calls = f.state.calls.filter(call => call.operation); assert.deepEqual(calls.map(call => call.operation), ['face.list', 'face.detail']);
    assert.equal(calls[0].op, 'fixedCustomFace'); assert.equal(calls[0].expectedUin, '12345');
    assert.deepEqual((await f.query({ operation: 'face.list', count: 0 })).faces, []);
    await assert.rejects(f.query({ operation: 'face.list', count: 1001 }), { code: 'INVALID_PARAMS' });
});

test('delete/modify/move require account membership and authoritative readback, with the real two-step order sequence', async t => {
    const f = fixture(t);
    assert.equal((await f.action({ operation: 'face.modify', emojiId: A, desc: '新备注' })).confirmation, 'description_readback');
    assert.equal((await f.action({ operation: 'face.moveFront', emojiId: B })).confirmation, 'order_readback');
    assert.deepEqual(f.state.ids, [B, A]);
    const operations = f.state.calls.filter(call => call.operation).map(call => call.operation);
    const order = operations.indexOf('face.order'); assert.equal(operations[order + 1], 'face.reorder'); assert.equal(operations[order + 2], 'face.list');
    assert.equal((await f.action({ operation: 'face.delete', emojiId: A })).confirmation, 'catalog_absence');
    const before = f.state.calls.length;
    await assert.rejects(f.action({ operation: 'face.delete', emojiId: A }), { code: 'NOT_FOUND' });
    assert.equal(f.state.calls.slice(before).some(call => call.operation === 'face.delete'), false);
    await assert.rejects(f.action({ operation: 'face.delete', emojiId: B.replace('12345_', '999_') }), { code: 'INVALID_PARAMS' });
});

test('add uploads actual controlled image bytes once and confirms catalog identity; duplicate content sends no upload', async t => {
    const f = fixture(t, []), input = 'base64://' + PNG.toString('base64');
    const result = await f.action({ operation: 'face.add', file: input });
    assert.equal(result.emojiId, A); assert.equal(result.confirmation, 'catalog_readback'); assert.equal(f.state.requests.length, 1);
    const upload = f.state.requests[0]; assert.equal(upload.url, 'http://42.81.1.9:80/cgi-bin/httpconn?htcmd=0x6FF0087&uin=12345');
    assert.equal(upload.request.redirect, 'manual'); assert.deepEqual(upload.request.body.subarray(9 + upload.request.body.readUInt32BE(1), -1), PNG);
    assert.equal((await f.action({ operation: 'face.add', file: input })).alreadyPresent, true); assert.equal(f.state.requests.length, 1);
    for (const file of ['C:/outside.png', 'file:///outside.png', 'https://evil.example/a.png', 'base64://AAAA']) await assert.rejects(f.action({ operation: 'face.add', file }));
});

test('saved custom face preparation downloads only the account URL, verifies digest and retains actual subtype1', async t => {
    const f = fixture(t);
    const prepared = await f.query({ operation: 'face.prepare', emojiId: md5 });
    assert.equal(prepared.emojiId, A); assert.equal(prepared.element.picElement.picSubType, 1); assert.equal(prepared.element.picElement.summary, '[动画表情]');
    assert.equal(f.state.requests[0].url, 'https://p.qpic.cn/qq_expression/12345/' + A + '/0');
    assert.deepEqual(fs.readdirSync(f.capture.mediaDirectory), []);
    const before = f.state.requests.length;
    await assert.rejects(f.query({ operation: 'face.prepare', emojiId: 'C'.repeat(32) }), { code: 'NOT_FOUND' });
    assert.equal(f.state.requests.length, before);
});

test('custom face operations bind full session and retain unresolved physical mutation locks after caller timeout', async t => {
    const f = fixture(t); let finish;
    const api = createCustomFace(f.capture, { native: { available: () => true, run: () => new Promise(resolve => { finish = resolve; }) } });
    const task = api.query({ operation: 'face.list', expectedEpoch: 'e1' }); await Promise.resolve();
    f.capture.self = { uin: '12345', uid: 'u_other' }; finish({ uin: '12345', ids: [], complete: true });
    await assert.rejects(task, { code: 'SESSION_CHANGED' });
    f.capture.deadline = async operation => { operation(); throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); };
    const locked = createCustomFace(f.capture, { native: { available: () => true, run: () => new Promise(() => {}) } });
    await assert.rejects(locked.action({ operation: 'face.delete', emojiId: A, expectedEpoch: 'e1' }), { code: 'TIMEOUT' });
    f.capture.epoch = 'e2';
    await assert.rejects(locked.action({ operation: 'face.delete', emojiId: A, expectedEpoch: 'e2' }), { code: 'BUSY' });
});

test('OneBot custom-face sends retain sticker subtype and store only an exact actual native message', async () => {
    const self = { uin: '12345', uid: 'u_self' }, state = { self, capabilities: { customFaceRead: true, customFaceWrite: true, customFaceSend: true } };
    const calls = []; let subtype = 1, target = '20001', saved = 0;
    const service = { remaining: () => 1000, store: { remember(_account, record) { saved++; assert.equal(record.msgId, '98765'); return { id: 9 }; } }, queueSentMessage() {}, async sessionCall(_state, method, data) {
        calls.push({ method, data });
        if (method === 'customFaceQuery') return { uin: '12345', emojiId: A, md5, element: { elementType: 2, elementId: '', picElement: { md5HexStr: md5, picSubType: 1, summary: '[动画表情]' } } };
        if (method === 'sendMessage') return { chatType: 2, peerUid: target, senderUin: '12345', msgId: '98765', msgSeq: '77', msgTime: '1700000000',
            elements: [{ elementType: 2, picElement: { md5HexStr: md5, picSubType: subtype } }] };
        assert.fail('Unexpected method');
    } };
    assert.deepEqual(await runCustomFace(service, state, 'send_custom_face', { group_id: 20001, emoji_id: A }), { message_id: 9 });
    assert.equal(calls[1].data.elements[0].picElement.picSubType, 1); assert.equal(saved, 1);
    subtype = 0;
    await assert.rejects(runCustomFace(service, state, 'send_custom_face', { group_id: 20001, emoji_id: A }), { code: 'INVALID_RESPONSE' }); assert.equal(saved, 1);
    subtype = 1; target = '999';
    await assert.rejects(runCustomFace(service, state, 'send_custom_face', { group_id: 20001, emoji_id: A }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(runCustomFace(service, state, 'send_custom_face', { group_id: 20001, user_id: 10001, emoji_id: A }), { code: 'INVALID_PARAMS' });
});

test('OneBot custom-face reads and writes check exact IDs/description confirmations and reject arbitrary files', async t => {
    const f = fixture(t), state = { self: f.capture.self, capabilities: f.api.capabilities() };
    const service = { mediaDirectory: f.capture.mediaDirectory, log() {}, async sessionCall(_state, method, data) {
        return method === 'customFaceQuery' ? f.query(data) : f.action(data);
    } };
    assert.deepEqual(await runCustomFace(service, state, 'fetch_custom_face', { count: 1, return_type: 'id' }), [A]);
    assert.equal((await runCustomFace(service, state, 'fetch_custom_face_detail', { count: 1 }))[0].emoji_id, A);
    assert.equal(await runCustomFace(service, state, 'modify_custom_face', { emoji_id: A, desc: '备注' }), null);
    const added = await runCustomFace(service, state, 'add_custom_face', { file: 'base64://' + PNG.toString('base64') });
    assert.deepEqual(added, { emoji_id: A }); assert.deepEqual(fs.readdirSync(f.capture.mediaDirectory), []);
    for (const file of ['C:/outside.png', 'https://evil.example/a', 'file:///outside']) await assert.rejects(runCustomFace(service, state, 'add_custom_face', { file }), { code: 'INVALID_PARAMS' });
    await assert.rejects(runCustomFace(service, state, 'fetch_custom_face', { return_type: 'anything' }), { code: 'INVALID_PARAMS' });
});
