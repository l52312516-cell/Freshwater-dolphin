'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const wire = require('../src/qq/misc-extra-protocol.cjs');
const { createMiscExtra } = require('../src/qq/misc-extra.cjs');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const n = p.varintField, b = p.bytesField, s = (tag, value) => b(tag, Buffer.from(value)), m = (tag, values) => b(tag, Buffer.concat(values));
const ark = { ver: '1.0.0.1', prompt: '[小程序]', config: {}, appName: 'com.tencent.miniapp_01', appView: 'view_8C8E89B49BE609866298ADDFF2DBABA4', metaData: { detail_1: { title: 'Actual' } } };
function envelope(prepared, bytes, error = 0) { return Buffer.concat([n(1, prepared.command), n(2, prepared.sub), n(3, error), b(4, bytes), n(12, 0)]); }
function reply(prepared) {
    if (prepared.operation === 'miniapp.ark') return Buffer.concat([n(2, 0), m(4, [s(2, JSON.stringify(ark))])]);
    if (prepared.operation === 'self.diy') return Buffer.alloc(0);
    return envelope(prepared, prepared.operation === 'card.send' ? m(1, [n(4, 0)]) : prepared.operation === 'button.click' ? n(3, 0) : Buffer.alloc(0));
}
const inputs = { 'miniapp.ark': { type: 'bili', title: 'Actual', desc: '', picUrl: '', jumpUrl: 'https://www.bilibili.com/video/BV1xx' },
    'card.send': { targetId: '33333', peerType: 1, title: 'Actual', desc: 'Description', summary: '[分享]', previewUrl: '', jumpUrl: 'https://example.com/' },
    'group.sign': { selfUin: '12345', groupId: '33333' }, 'self.diy': { faceId: '14', faceType: '0', wording: 'Testing' },
    'button.click': { groupId: '33333', botAppid: '10001', msgSeq: '77', buttonId: 'button', callbackData: 'observed' } };
test('five misc operations encode fixed names and semantic fields, then decode only successful matching replies', () => {
    for (const operation of wire.OPERATIONS) {
        const prepared = wire.prepare(operation, inputs[operation]);
        assert.ok(prepared.body.length); const value = wire.decode(reply(prepared), prepared);
        assert.equal(value.operation, operation);
        for (const [key, expected] of Object.entries(prepared.data)) assert.equal(value[key], expected);
        if (prepared.command !== undefined) {
            assert.throws(() => wire.decode(envelope({ ...prepared, command: prepared.command + 1 }, Buffer.alloc(0)), prepared), { code: 'INVALID_RESPONSE' });
            assert.throws(() => wire.decode(envelope(prepared, Buffer.alloc(0), 5), prepared), { code: 'KERNEL_ERROR' });
        }
    }
    const card = wire.prepare('card.send', inputs['card.send']), body = p.fields(p.one(p.fields(card.body), 4).value), app = p.fields(p.one(body, 1).value), meta = p.fields(p.one(body, 2).value);
    assert.equal(p.one(app, 1).value, 100446242n); assert.equal(p.one(app, 11).value, 33333n); assert.equal(p.one(meta, 2).value, 33333n);
    assert.equal(p.one(p.fields(p.one(app, 12).value), 14).value.length, 0);
    assert.equal(wire.prepare('group.sign', inputs['group.sign']).name, 'OidbSvcTrpcTcp.0xEB7_1');
    const diy = p.fields(wire.prepare('self.diy', inputs['self.diy']).body);
    assert.equal(p.one(diy, 1).value, 10n); assert.equal(p.one(diy, 2).value, 2000n); assert.equal(p.one(p.fields(p.one(diy, 4).value), 3).value, 0n);
});
test('misc protocol rejects malformed miniapp JSON, missing card delivery and conflicting statuses', () => {
    const mini = wire.prepare('miniapp.ark', inputs['miniapp.ark']), card = wire.prepare('card.send', inputs['card.send']), diy = wire.prepare('self.diy', inputs['self.diy']);
    for (const bytes of [Buffer.alloc(0), n(2, 1), m(4, [s(2, '{}')]), m(4, [s(2, 'not-json')]), Buffer.concat([n(2, 0), n(2, 0), m(4, [s(2, JSON.stringify(ark))])])]) assert.throws(() => wire.decode(bytes, mini));
    for (const bytes of [envelope(card, Buffer.alloc(0)), envelope(card, m(1, [n(4, 7)])), envelope(card, Buffer.concat([m(1, []), m(1, [])]))]) assert.throws(() => wire.decode(bytes, card));
    assert.throws(() => wire.decode(Buffer.concat([n(1, 1), s(2, 'set status success')]), diy));
    assert.throws(() => wire.decode(s(2, 'unexpected'), diy));
    for (const [operation, input] of [['self.diy', { ...inputs['self.diy'], faceType: null }], ['miniapp.ark', { ...inputs['miniapp.ark'], type: 'raw' }],
        ['miniapp.ark', { ...inputs['miniapp.ark'], picUrl: 'file:///etc/passwd' }], ['card.send', { ...inputs['card.send'], peerType: true }], ['group.sign', { ...inputs['group.sign'], command: 'raw' }]]) assert.throws(() => wire.prepare(operation, input), { code: 'INVALID_PARAMS' });
});
function fixture() {
    const calls = [], capture = { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, ensureReady() {}, deadline: fn => fn() };
    const native = { available: () => true, async run(_capture, params) { calls.push(params); assert.equal(params.op, 'fixedMiscExtra'); assert.equal(params.expectedEpoch, capture.epoch);
        const prepared = wire.prepare(params.operation, params.request); return wire.decode(reply(prepared), prepared); } };
    const api = createMiscExtra(capture, { native }), state = () => ({ ready: true, epoch: capture.epoch, self: capture.self, capabilities: { ...api.capabilities(), reply: true } });
    const source = { id: 1, locator: { peer: { chatType: 2, peerUid: '33333' }, seq: '77' } };
    const service = new OneBotService({ store: { state: () => ({ byId: new Map([[1, source]]) }) }, backend: { async call(method, params) {
        if (method === 'status') return structuredClone(state());
        assert.equal(method, 'miscExtra'); return api.execute(params);
    } } });
    service.record = async () => ({ chatType: 2, peerUid: '33333', msgId: '9001', msgSeq: '77', elements: [{ elementType: 20, inlineKeyboardElement: { botAppid: '10001', rows: [{ buttons: [{ id: 'button', data: 'observed', type: 2 }] }] } }] });
    return { service, api, capture, calls, native };
}
test('actual OneBot routes all five misc operations with exact account, button, defaults and confirmations', async () => {
    const f = fixture(), requests = [['get_mini_app_ark', { title: 'Actual', jump_url: inputs['miniapp.ark'].jumpUrl }],
        ['send_tuwen_ark', { group_id: 33333, title: 'Actual', desc: '', preview_url: '', jump_url: 'https://example.com/' }], ['set_group_sign', { group_id: 33333 }],
        ['set_diy_online_status', { face_id: 14, face_type: 0 }], ['click_inline_keyboard_button', { group_id: 33333, bot_appid: 10001, msg_seq: 77, button_id: 'button', callback_data: 'observed' }]];
    for (const [action, params] of requests) {
        const result = await f.service.action({ action, params, echo: 'exact' }); assert.equal(result.retcode, 0, JSON.stringify(result)); assert.equal(result.echo, 'exact');
    }
    assert.equal(f.calls.length, 5); const count = f.calls.length;
    for (const [action, params] of [['get_mini_app_ark', { self_id: 99999 }], ['get_mini_app_ark', { picUrl: 'https://a.example/', pic_url: 'https://b.example/' }],
        ['set_diy_online_status', { face_id: 14, face_type: null }], ['click_inline_keyboard_button', { ...requests[4][1], callback_data: 'forged' }], ['click_inline_keyboard_button', { ...requests[4][1], msg_seq: 78 }]]) assert.notEqual((await f.service.action({ action, params })).retcode, 0);
    assert.equal(f.calls.length, count);
});
test('native channel accepts empty ACK only from a fixed operation that declares it and exact empty metadata', async () => {
    for (const [operation, data, status, size, success] of [['self.diy', inputs['self.diy'], 'empty', '0', true], ['self.diy', inputs['self.diy'], 'too_large', '0', false],
        ['self.diy', inputs['self.diy'], 'empty', '5', false], ['miniapp.ark', inputs['miniapp.ark'], 'empty', '0', false]]) {
        let released = false;
        const native = { resetSession() {}, install: () => ({ ok: true }), readTemplate: () => ({ haveTemplate: true }), send: () => ({ ok: true, requestId: '1' }),
            readResponse: () => ({ requestId: '1', count: 1, result: 0, body: [], bodyStatus: status, responseBytes: size }), release() { released = true; } };
        const channel = createChannel({ loadNative: () => native }), promise = channel.run({ epoch: 'e', self: { uin: '12345' } }, { op: 'fixedMiscExtra', operation, request: data, expectedEpoch: 'e', expectedUin: '12345', timeoutMs: 1000 });
        if (success) assert.equal((await promise).confirmed, true); else await assert.rejects(promise, { code: 'QUERY_FAILED' }); assert.equal(released, true);
    }
});
test('physical misc reservations survive expiry and session changes until native requests settle', async () => {
    const f = fixture(), resolvers = [];
    f.native.run = (_capture, input) => new Promise(resolve => resolvers.push(() => { const prepared = wire.prepare(input.operation, input.request); resolve(wire.decode(reply(prepared), prepared)); }));
    const promise = f.api.execute({ operation: 'group.sign', expectedEpoch: 'e1', ...inputs['group.sign'] });
    const rejected = assert.rejects(promise, { code: 'SESSION_CHANGED' }); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.api.execute({ operation: 'group.sign', expectedEpoch: 'e1', ...inputs['group.sign'] }), { code: 'BUSY' });
    f.capture.epoch = 'e2'; f.capture.session = {}; resolvers[0](); await rejected;
    f.native.run = async (_capture, input) => { const prepared = wire.prepare(input.operation, input.request); return wire.decode(reply(prepared), prepared); };
    assert.equal((await f.api.execute({ operation: 'group.sign', expectedEpoch: 'e2', ...inputs['group.sign'] })).confirmed, true);
});

test('target QQ card protocol remains unavailable after real business rejection without dispatch', async () => {
    const f = fixture(); f.capture.qqVersion = '3.2.35-54395';
    assert.equal(f.api.capabilities().tuwenArk, false);
    await assert.rejects(f.api.execute({ operation: 'card.send', expectedEpoch: 'e1', ...inputs['card.send'] }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
    assert.equal(f.api.capabilities().miniappArk, true);
});
