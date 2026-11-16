'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parameters, TransportHub } = require('../src/onebot/transports.cjs');
const { nodeConfig } = require('../src/config.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { REQUIREMENTS } = require('../src/onebot/extended-actions.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');

function fixture() {
    const state = { ready: true, online: true, epoch: 'current-epoch', self: { uin: '11111', uid: 'u_self' },
        capabilities: { ...Object.fromEntries(Object.values(REQUIREMENTS).map(flag => [flag, true])),
            groupFileDelete: true, forwardExisting: true, history: true, recordExport: true, image: true, record: true } };
    const calls = [], overrides = {};
    const service = new OneBotService({ mediaDirectory: path.resolve('work/temp/account-media'),
        store: { stage: () => ({ store: {}, commit() {} }) }, backend: { async call(method, params, options) {
            if (method === 'status') return structuredClone(state);
            calls.push({ method, params, options });
            if (overrides[method]) return overrides[method](params);
            if (method === 'resolve') return { uin: params.uin, uid: 'u_' + params.uin };
            if (method === 'extendedAction') return { ...params, confirmed: true };
            if (method === 'extendedQuery') return { ...params, notices: [{ notice_id: 'notice-1', message: { text: 'synthetic' } }],
                messages: [{ message_id: 'native-reference' }], members: [{ user_id: 22222, nickname: 'member' }], isEnd: true };
            if (method === 'history') return { records: [] };
            if (method === 'groupFiles') return { confirmed: true, groupId: params.groupId, fileIds: params.files.map(file => file.fileId) };
            if (method === 'forwardOperation') return { confirmed: true, confirmation: 'kernel_ack', source: params.source,
                destination: params.destination, sourceMsgIds: params.msgIds };
            if (method === 'recordExport') return { ...params, format: params.outFormat, path: path.resolve('work/temp/account-media/voice-exports/result.wav'), size: 1024 };
            throw new Error('Unexpected method ' + method);
        } } });
    service.record = async (_state, id) => ({ chatType: 2, peerUid: '12345', msgId: String(18446744073709551000n + BigInt(id)), msgSeq: '120', clientSeq: '121',
        msgRandom: '4294967295', msgTime: '1800000000', senderUid: 'u_sender', senderUin: '22222', sourceOneBotId: id });
    const invoke = (action, params = {}, session) => service.action({ action, params, echo: { test: action } }, session);
    return { state, service, calls, overrides, invoke };
}

test('HTTP schema decodes registered arrays and booleans without coercing text, flags or long IDs', () => {
    const result = parameters(new URLSearchParams({ messages: '[{"type":"node","data":{"content":"test"}}]', message_ids: '[1,-2]',
        files: '[{"file_id":"a","busid":102}]', reverse_order: 'true', set: 'false', category_id: '0',
        message: '12345', flag: '18446744073709551615', message_seq: '18446744073709551615', echo: 'false' }));
    assert.ok(Array.isArray(result.messages)); assert.deepEqual(result.message_ids, [1, -2]);
    assert.deepEqual(result.files, [{ file_id: 'a', busid: 102 }]); assert.equal(result.reverse_order, true);
    assert.equal(result.set, false); assert.equal(result.category_id, 0); assert.equal(result.echo, false);
    assert.equal(result.message, '12345'); assert.equal(result.flag, '18446744073709551615'); assert.equal(result.message_seq, '18446744073709551615');
    assert.equal(parameters(new URLSearchParams({ files: '{"not":"an array"}' })).files, '{"not":"an array"}');
    assert.equal(parameters(new URLSearchParams({ files: '[bad json' })).files, '[bad json');
});

test('real HTTP GET, form and JSON reach the same formal batch and forwarding action validation', async t => {
    const f = fixture(), config = { profileId: 'audit', gatewayPort: 0, nodes: [nodeConfig({ id: 'api', type: 'httpApi', token: 'secret' }, 0)] };
    const hub = new TransportHub({ config, action: (request, session) => f.service.action(request, session), status: async () => f.state });
    await hub.open(); hub.start('11111', 'current-epoch'); t.after(() => hub.close());
    const base = 'http://127.0.0.1:' + hub.port + '/onebot/audit/api/';
    for (const [action, params] of [['delete_group_file', { group_id: 12345, files: [{ file_id: 'file-1', busid: 102 }] }],
        ['qqapi_message_forward', { group_id: 54321, message_ids: [1, 2] }]]) {
        const strings = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
        const query = new URLSearchParams({ ...strings, access_token: 'secret' });
        const get = await fetch(base + action + '?' + query).then(response => response.json());
        const form = await fetch(base + action, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(strings) }).then(response => response.json());
        const json = await fetch(base + action, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify(params) }).then(response => response.json());
        assert.equal(get.retcode, 0, JSON.stringify(get)); assert.deepEqual(form, get); assert.deepEqual(json, get);
    }
    for (const encoding of ['query', 'form', 'json']) {
        const url = base + 'get_group_msg_history', params = { group_id: 12345, reverse_order: true };
        const options = encoding === 'query' ? undefined : { method: 'POST', headers: { 'Content-Type': encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
            body: encoding === 'json' ? JSON.stringify(params) : new URLSearchParams(params) };
        const response = await fetch(url + '?access_token=secret' + (encoding === 'query' ? '&group_id=12345&reverse_order=true' : ''), options).then(value => value.json());
        assert.equal(response.retcode, 1400);
    }
    assert.equal(f.calls.some(call => call.method === 'history'), false);
});

test('all early read-only actions enforce explicit account and stale connection identity', async () => {
    const f = fixture();
    for (const action of ['get_status', 'get_version_info', 'get_capabilities', 'can_send_image', 'can_send_record']) {
        assert.equal((await f.invoke(action, { self_id: 22222 })).retcode, 1400, action);
        assert.equal((await f.invoke(action, {}, { epoch: 'old-epoch', selfUin: '11111' })).retcode, 1503, action);
        assert.equal((await f.invoke(action, {}, { epoch: 'current-epoch', uin: '22222' })).retcode, 1503, action);
        assert.equal((await f.invoke(action, { self_id: 11111 }, { epoch: 'current-epoch', uin: '11111' })).retcode, 0, action);
    }
    assert.equal(f.calls.length, 0);
});

test('fixed extended actions resolve target UID and require exact confirmed targets with no retries', async () => {
    const f = fixture();
    for (const [action, params, operation] of [['group_poke', { group_id: 12345, user_id: 22222 }, 'message.poke'],
        ['friend_poke', { user_id: 22222 }, 'message.poke'], ['set_msg_emoji_like', { message_id: 1, emoji_id: '128077', set: false }, 'message.emoji'],
        ['set_essence_msg', { message_id: 1 }, 'group.essence'], ['delete_essence_msg', { message_id: 1 }, 'group.essence'],
        ['set_friend_category', { user_id: 22222, category_id: 0 }, 'friend.category'],
        ['set_group_special_title', { group_id: 12345, user_id: 22222, special_title: '', duration: -1 }, 'group.memberTitle'],
        ['_send_group_notice', { group_id: 12345, content: 'first\nsecond' }, 'group.noticePublish'],
        ['_del_group_notice', { group_id: 12345, notice_id: 'notice-1' }, 'group.noticeDelete']]) {
        const result = await f.invoke(action, params); assert.equal(result.retcode, 0, JSON.stringify(result)); assert.deepEqual(result.echo, { test: action });
        assert.equal(f.calls.at(-1).params.operation, operation); assert.equal(f.calls.at(-1).params.expectedEpoch, 'current-epoch');
    }
    assert.equal(f.calls.find(call => call.params.operation === 'message.poke').params.targetUid, 'u_22222');
    f.overrides.extendedAction = params => ({ ...params, confirmed: true, groupId: '99999' });
    assert.equal((await f.invoke('_del_group_notice', { group_id: 12345, notice_id: 'notice-1' })).retcode, 1500);
    assert.equal(f.calls.filter(call => call.params.operation === 'group.noticeDelete').length, 2);
});

test('extended queries preserve actual records and reject different group or omitted pagination', async () => {
    const f = fixture();
    assert.deepEqual((await f.invoke('_get_group_notice', { group_id: 12345 })).data, [{ notice_id: 'notice-1', message: { text: 'synthetic' } }]);
    assert.deepEqual((await f.invoke('get_group_honor_info', { group_id: 12345, type: 'emotion' })).data,
        { group_id: 12345, emotion_list: [{ user_id: 22222, nickname: 'member' }] });
    assert.deepEqual((await f.invoke('get_essence_msg_list', { group_id: 12345 })).data, [{ message_id: 'native-reference' }]);
    f.overrides.extendedQuery = params => ({ ...params, groupId: '99999', notices: [] });
    assert.equal((await f.invoke('_get_group_notice', { group_id: 12345 })).retcode, 1500);
    f.overrides.extendedQuery = params => ({ ...params, messages: [] });
    assert.equal((await f.invoke('get_essence_msg_list', { group_id: 12345 })).retcode, 1500);
});

test('unsupported contracts, unknown fields and missing actual essence random fail without a write', async () => {
    const f = fixture(); f.state.capabilities.messagePoke = false;
    assert.equal((await f.invoke('send_poke', { user_id: 22222 })).retcode, 1404); assert.equal(f.calls.length, 0);
    f.state.capabilities.messagePoke = true;
    for (const [action, params] of [['group_poke', { user_id: 22222 }], ['friend_poke', { group_id: 12345, user_id: 22222 }],
        ['set_friend_category', { user_id: 22222, category_id: -1 }], ['_send_group_notice', { group_id: 12345, content: 'x', raw_kernel: 'never' }],
        ['set_msg_emoji_like', { message_id: 1, emoji_id: '1', set: 'true' }]]) {
        assert.equal((await f.invoke(action, params)).retcode, 1400, action);
    }
    assert.equal(f.calls.length, 0);
    f.service.record = async () => ({ chatType: 2, peerUid: '12345', msgId: '123456', msgSeq: '120' });
    assert.equal((await f.invoke('set_essence_msg', { message_id: 1 })).retcode, 1404);
    assert.equal(f.calls.length, 0);
});

test('get_record validates observed handles and matched bounded account results under a media deadline', async () => {
    const f = fixture(), params = { file: 'fwd-record-' + 'ab'.repeat(16), out_format: 'wav' };
    assert.equal((await f.invoke('get_record', params)).retcode, 0);
    const call = f.calls.at(-1); assert.equal(call.method, 'recordExport'); assert.ok(call.options.timeoutMs > 55000);
    assert.equal(call.params.expectedEpoch, 'current-epoch');
    f.overrides.recordExport = params => ({ ...params, format: params.outFormat, path: path.resolve('outside.wav'), size: 100 });
    assert.equal((await f.invoke('get_record', params)).retcode, 1500);
    const before = f.calls.length;
    assert.equal((await f.invoke('get_record', { ...params, file: '../voice.silk' })).retcode, 1400);
    assert.equal((await f.invoke('get_record', { ...params, out_format: 'amr' })).retcode, 1404);
    assert.equal(f.calls.length, before);
    f.state.capabilities.recordExport = false; assert.equal((await f.invoke('get_record', params)).retcode, 1404);
});

test('new capability entries remain unavailable without their exact backend flag', () => {
    const state = { ready: true, self: { uin: '11111', uid: 'u_self' }, capabilities: {} }, result = capabilities(state);
    for (const action of Object.keys(REQUIREMENTS)) {
        const entry = [...result.actions, ...result.extensions].find(item => item.name === action);
        assert.ok(entry); assert.equal(entry.implemented, true); assert.equal(entry.available, false);
        state.capabilities[REQUIREMENTS[action]] = true;
        assert.equal([...capabilities(state).actions, ...capabilities(state).extensions].find(item => item.name === action).available, true);
        delete state.capabilities[REQUIREMENTS[action]];
    }
});

test('additional fixed account and catalog actions retain target identity and reject mismatched results', async () => {
    const f = fixture(), image = 'fwd-image-' + 'cd'.repeat(16);
    for (const [action, params, operation] of [['delete_friend', { user_id: 22222 }, 'friend.delete'],
        ['set_online_status', { status: 10, ext_status: 0, battery_status: 0 }, 'self.status'],
        ['set_qq_avatar', { file: image }, 'self.avatar'], ['set_group_portrait', { group_id: 12345, file: image }, 'group.avatar']]) {
        assert.equal((await f.invoke(action, params)).retcode, 0); assert.equal(f.calls.at(-1).params.operation, operation);
    }
    const count = f.calls.length;
    for (const [action, params] of [['delete_friend', { user_id: 11111 }], ['set_online_status', { status: -1 }],
        ['set_qq_avatar', { file: '/arbitrary/file.png' }], ['set_group_portrait', { group_id: 12345, file: 'https://example.invalid/image.png' }],
        ['ocr_image', { image: 'file:///private/image' }]]) assert.equal((await f.invoke(action, params)).retcode, 1400);
    assert.equal(f.calls.length, count);
    f.overrides.extendedQuery = params => ({ ...params, texts: [{ text: '第一行\n第二行', confidence: 99 }], language: 'zh',
        characters: [{ type: 'normal', voices: [] }], faces: [{ id: '1', name: 'face' }], face: { id: params.faceId } });
    assert.equal((await f.invoke('ocr_image', { image: 'https://gchat.qpic.cn/actual-image/0' })).data.texts[0].text, '第一行\n第二行');
    assert.deepEqual((await f.invoke('get_ai_characters', { group_id: 12345 })).data, [{ type: 'normal', voices: [] }]);
    assert.deepEqual((await f.invoke('get_system_face_list')).data, [{ id: '1', name: 'face' }]);
    assert.deepEqual((await f.invoke('get_system_face', { face_id: '1' })).data, { id: '1' });
    f.overrides.extendedQuery = params => ({ ...params, faceId: '99999', face: {} });
    assert.equal((await f.invoke('get_system_face', { face_id: '1' })).retcode, 1500);
});
