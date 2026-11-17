'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const { Capture } = require('../src/qq/capture.cjs');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'merged-id-')), store = new MessageStore({ directory: root });
    const state = { ready: true, epoch: 'id-epoch', self: { uin: '11111', uid: 'u_self' }, capabilities: { mergeExistingNative: true, mergeCustom: false } };
    const originals = [1, 2].map(index => ({ chatType: 2, peerUid: '12345', msgId: String(18446744073709551000n + BigInt(index)),
        senderUin: String(index * 11111 + 11111), senderUid: 'u_author' + index, sendNickName: 'Original ' + index,
        msgSeq: String(index), clientSeq: String(index), msgTime: '1800000000', elements: [{ elementType: 1, textElement: { content: ' original ' + index + '\n', atType: 0 } }] }));
    const ids = originals.map(record => store.remember('11111', record).id), calls = [], override = {};
    const record = { chatType: 2, peerUid: '12345', msgId: '18446744073709551500', msgSeq: '9', clientSeq: '9', msgTime: '1800000001',
        senderUin: '11111', senderUid: 'u_self', sendStatus: 2, elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'real-resource' } }] };
    const service = new OneBotService({ store, backend: { async call(method, params) {
        if (method === 'status') return structuredClone(state); calls.push({ method, params });
        if (method === 'getMessage') return originals.find(item => item.msgId === params.nativeId);
        if (method === 'forwardOperation') {
            const result = { confirmed: true, confirmation: 'correlated-native-merge-and-resource-readback', source: params.source, destination: params.source,
                sourceMsgIds: params.msgIds, messageId: record.msgId, resId: 'real-resource', record, records: structuredClone(originals) };
            return override.result ? override.result(result) : result;
        }
        throw new Error('Unexpected method ' + method);
    } } });
    t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const params = { group_id: 12345, messages: ids.map(id => ({ type: 'node', data: { id } })) };
    return { state, store, service, calls, originals, ids, record, params, override, invoke: (input = params, action = 'send_group_forward_msg') => service.action({ action, params: input }) };
}

test('a capable simulated backend submits formal ID nodes once and returns only a proven destination message ID', async t => {
    const f = fixture(t), result = await f.invoke(); assert.equal(result.retcode, 0, JSON.stringify(result));
    const call = f.calls.find(row => row.method === 'forwardOperation'); assert.equal(call.params.kind, 'existingMerge');
    assert.deepEqual(call.params.source, { chatType: 2, peerUid: '12345' }); assert.deepEqual(call.params.msgIds, f.originals.map(row => row.msgId));
    assert.equal(call.params.expectedEpoch, 'id-epoch'); assert.equal(f.calls.filter(row => row.method === 'forwardOperation').length, 1);
    assert.ok(Number.isInteger(call.params.timeoutMs) && call.params.timeoutMs > 55000 && call.params.timeoutMs <= 60000);
    assert.equal(f.store.get('11111', result.data.message_id).record.msgId, f.record.msgId);
    assert.deepEqual(f.originals.map(row => row.sendNickName), ['Original 1', 'Original 2']);
});

test('ID nodes reject mixed/custom fields, duplicates, cross-group/private targets and unsupported media before sending', async t => {
    for (const alter of [f => ({ params: { ...f.params, messages: [{ type: 'node', data: { id: f.ids[0], nickname: 'spoof' } }] } }),
        f => ({ params: { ...f.params, messages: [f.params.messages[0], { type: 'node', data: { user_id: '11111', nickname: 'self', content: 'text' } }] } }),
        f => ({ params: { ...f.params, messages: [f.params.messages[0], f.params.messages[0]] } }),
        f => ({ params: { ...f.params, group_id: 54321 } }), f => ({ params: { user_id: 22222, messages: f.params.messages }, action: 'send_private_forward_msg' }),
        f => { f.originals[1].elements = [{ elementType: 2, picElement: {} }]; return {}; }]) {
        const f = fixture(t), changed = alter(f), result = await f.invoke(changed.params || f.params, changed.action);
        assert.equal(result.status, 'failed'); assert.equal(f.calls.some(row => row.method === 'forwardOperation'), false);
    }
});

test('ID merge refuses unknown proof, substituted resource or session and never retries native sending', async t => {
    for (const transform of [result => ({ ...result, confirmation: 'kernel_ack' }), result => ({ ...result, resId: 'substituted' }),
        result => ({ ...result, sourceMsgIds: result.sourceMsgIds.slice().reverse() }), result => ({ ...result, records: [] }),
        result => ({ ...result, record: { ...result.record, senderUid: 'u_other' } })]) {
        const f = fixture(t); f.override.result = transform;
        assert.equal((await f.invoke()).retcode, 1500); assert.equal(f.calls.filter(row => row.method === 'forwardOperation').length, 1);
        assert.equal(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: f.record.msgId }), null);
    }
    const f = fixture(t); f.override.result = result => { f.state.epoch = 'changed'; return result; };
    assert.equal((await f.invoke()).retcode, 1503); assert.equal(f.calls.filter(row => row.method === 'forwardOperation').length, 1);
});

test('ID merge capability is independent of custom-node support and disabled without its native flag', async t => {
    const f = fixture(t), get = () => capabilities(f.state).extensions.find(item => item.name === 'send_group_forward_msg');
    assert.equal(get().available, true); assert.equal(get().variants.custom_text_image_nodes, false); assert.equal(get().variants.existing_message_id_nodes, true);
    f.state.capabilities.mergeExistingNative = false; assert.equal(get().available, false);
    assert.equal((await f.invoke()).retcode, 1404); assert.equal(f.calls.length, 0);
});

test('the real target-build capability rejects public ID nodes while keeping the custom-node variant independently available', async t => {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    capture.session = { getMsgService: () => Object.fromEntries(['getMsgsByMsgId', 'multiForwardMsgWithComment',
        'generateMsgUniqueId', 'getMultiMsg'].map(name => [name, () => {}])), getMSFService: () => ({ getServerTime() {} }) };
    t.after(() => capture.close());
    const f = fixture(t);
    f.state.capabilities.mergeExistingNative = capture.forwardApi.capabilities().mergeExistingNative;
    f.state.capabilities.mergeCustom = true;
    const extension = capabilities(f.state).extensions.find(item => item.name === 'send_group_forward_msg');
    assert.equal(extension.available, true); assert.equal(extension.variants.custom_text_image_nodes, true);
    assert.equal(extension.variants.existing_message_id_nodes, false);
    const response = await f.invoke(); assert.equal(response.retcode, 1404);
    assert.equal(f.calls.length, 0, 'disabled ID nodes must stop before source lookup or internal write dispatch');
});
