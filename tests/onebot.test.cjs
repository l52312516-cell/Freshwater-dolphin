'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/onebot/codec.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

const tempRoot = path.resolve(__dirname, '../work/temp');
fs.mkdirSync(tempRoot, { recursive: true });
function sample(overrides = {}) {
    return { msgId: '18446744073709551612', msgSeq: '25', clientSeq: '31',
        chatType: 2, peerUid: '12345', peerUin: '12345', senderUid: 'u_sender',
        senderUin: '22222', msgTime: '1800000000', sendNickName: '小海豚', sendMemberName: '群名片',
        elements: [{ elementType: 1, textElement: { content: '测试 你好\n', atType: 0 } }], ...overrides };
}
function fixture(t, maxMessages = 10000) {
    const directory = fs.mkdtempSync(path.join(tempRoot, 'onebot-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new MessageStore({ directory, maxMessages });
    const state = { epoch: 'session-1', ready: true, online: null,
        self: { uin: '11111', uid: 'u_self', nickname: '海豚' }, qqVersion: '3.2.35-54395' };
    const calls = [];
    const backend = { async call(method, params = {}) {
        calls.push({ method, params });
        if (method === 'status') return structuredClone(state);
        if (method === 'resolve') return params.uid ? { uin: '22222', uid: params.uid } : { uin: params.uin, uid: 'u_' + params.uin };
        if (method === 'groupMember') return { user_id: Number(params.uin), group_id: Number(params.groupId), nickname: '成员', card: '卡片', role: 'member' };
        if (method === 'user') return { user_id: Number(params.uin), nickname: '好友' };
        if (method === 'friends') return [{ user_id: 22222, nickname: '好友', remark: '备注' }];
        if (method === 'groups') return [{ group_id: 12345, group_name: '测试群' }];
        if (method === 'groupInfo') return { group_id: Number(params.groupId), group_name: '测试群', member_count: 2, max_member_count: 200 };
        if (method === 'getMessage') return sample({ msgId: params.nativeId || '900', msgSeq: params.seq || '25', ...params.peer });
        if (method === 'sendMessage') return sample({ msgId: '18446744073709551613', ...params.peer, senderUin: '11111', senderUid: 'u_self', elements: params.elements });
        throw new Error('Unexpected backend method ' + method);
    } };
    const service = new OneBotService({ backend, store });
    return { directory, store, state, backend, service, calls };
}

test('capability catalogue separates 38 standard actions, 20 segments and four event classes from availability', async t => {
    const { service, state, calls } = fixture(t);
    const first = await service.capabilities();
    assert.equal(first.actions.length, 38);
    assert.equal(first.segments.length, 20);
    assert.equal(first.events.length, 4);
    assert.equal(new Set(first.actions.map(item => item.name)).size, 38);
    assert.equal(first.actions.find(item => item.name === 'get_group_member_list').available, false);
    state.capabilities = { groupMembers: true, face: true, text: true };
    const next = await service.capabilities();
    assert.equal(next.actions.find(item => item.name === 'get_group_member_list').available, true);
    assert.equal(next.segments.find(item => item.name === 'face').send, true);
    assert.equal(next.actions.find(item => item.name === 'set_group_kick').implemented, true);
    assert.equal(next.actions.find(item => item.name === 'set_group_kick').available, false);
    assert.deepEqual((await service.action({ action: 'can_send_image' })).data, { yes: false });
    assert.deepEqual((await service.action({ action: 'can_send_record' })).data, { yes: false });
    assert.equal((await service.action({ action: 'get_record', params: { file: 'unknown', out_format: 'mp3' } })).retcode, 1404);
    assert.equal((await service.action({ action: 'get_version_info' })).data.app_version, require('../package.json').version);
    assert.equal((await service.action({ action: 'set_group_kick', params: { group_id: 12345, user_id: 22222 } })).retcode, 1404);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('ordinary face segments round-trip without flattening text or accepting animated stickers', async t => {
    const { service, state, calls } = fixture(t);
    state.capabilities = { face: true };
    const segments = [{ type: 'text', data: { text: ' A\n' } }, { type: 'face', data: { id: '14' } },
        { type: 'face', data: { id: '222' } }];
    assert.deepEqual(codec.parse(codec.stringify(segments)), segments);
    const sent = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: segments } });
    assert.equal(sent.retcode, 0);
    const elements = calls.find(item => item.method === 'sendMessage').params.elements;
    assert.equal(elements[1].elementType, 6);
    assert.equal(elements[1].faceElement.faceType, 1);
    assert.equal(elements[2].faceElement.faceType, 2);
    assert.deepEqual(await codec.fromKernel(sample({ elements }), {}), segments);
    for (const id of ['-1', '1.5', '358', '359']) assert.throws(() => codec.parse([{ type: 'face', data: { id } }]));
    await assert.rejects(codec.fromKernel(sample({ elements: [{ elementType: 6, faceElement: { faceIndex: 222, faceType: 3 } }] }), {}), { code: 'UNSUPPORTED' });
    state.capabilities.face = false;
    assert.equal((await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [{ type: 'face', data: { id: '14' } }] } })).retcode, 1404);
});

test('image codec accepts canonical base64 in array and CQ inputs while preserving mixed segment order', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const file = 'base64://' + png.toString('base64');
    const segments = [{ type: 'text', data: { text: ' before\n' } }, { type: 'image', data: { file, summary: 'test' } },
        { type: 'at', data: { qq: '22222' } }, { type: 'text', data: { text: ' after ' } }];
    assert.deepEqual(codec.parse(segments), segments);
    assert.deepEqual(codec.parse(codec.stringify(segments)), segments);
    assert.throws(() => codec.parse([{ type: 'image', data: { file: 'base64://Zh==' } }]), { code: 'INVALID_REQUEST' });
    assert.throws(() => codec.parse([{ type: 'image', data: { file: 'https://example.test/image.png' } }]), { code: 'UNSUPPORTED' });
});

test('image codec bounds the total decoded inline image bytes in one message', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const bytes = Buffer.alloc(6 * 1024 * 1024); png.copy(bytes);
    const image = { type: 'image', data: { file: 'base64://' + bytes.toString('base64') } };
    assert.equal(codec.parse([image]).length, 1);
    assert.throws(() => codec.parse([image, image]), { code: 'INVALID_REQUEST' });
});

test('a malformed inline image or unsupported trailing segment rejects the whole action before any QQ calls', async t => {
    const { service, calls } = fixture(t);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const image = { type: 'image', data: { file: 'base64://' + png.toString('base64') } };
    for (const message of [
        [{ type: 'text', data: { text: 'must not be sent' } }, { type: 'image', data: { file: 'base64://AA=' } }],
        [image, { type: 'text', data: { text: 'must not be sent' } }, { type: 'video', data: { file: 'unavailable' } }]
    ]) {
        const result = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message } });
        assert.equal(result.status, 'failed'); assert.ok([1400, 1404].includes(result.retcode));
        assert.deepEqual(calls, []);
    }
});

test('member-list action preserves real fields and binds the backend call to the current epoch', async t => {
    const { service, backend, calls } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => method === 'groupMembers'
        ? (calls.push({ method, params }), [{ group_id: Number(params.groupId), user_id: 22222, nickname: 'Name', card: 'Card', role: 'admin' }])
        : original(method, params);
    const result = await service.action({ action: 'get_group_member_list', params: { group_id: 12345, no_cache: true } });
    assert.equal(result.retcode, 0);
    assert.equal(result.data[0].card, 'Card');
    assert.deepEqual(calls.find(item => item.method === 'groupMembers').params, { groupId: '12345', refresh: true, expectedEpoch: 'session-1' });
});

test('history pages preserve long sequence order, exclude inclusive cursors and isolate conversations', async t => {
    const { service, backend, store } = fixture(t);
    const original = backend.call;
    const anchor = store.remember('11111', sample({ msgId: '10000', msgSeq: '9007199254740995' }));
    let page = [sample({ msgId: '10000', msgSeq: '9007199254740995' }),
        sample({ msgId: '9998', msgSeq: '9007199254740993' }), sample({ msgId: '9999', msgSeq: '9007199254740994' })];
    backend.call = async (method, params) => {
        if (method === 'history') { assert.equal(params.nativeId, '10000'); assert.equal(params.count, 3); return { records: page }; }
        return original(method, params);
    };
    const result = await service.action({ action: 'get_group_msg_history', params: { group_id: 12345, message_id: anchor.id, count: 2 } });
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages.map(item => store.get('11111', item.message_id).locator.nativeId), ['9998', '9999']);
    assert.equal(result.data.next_message_id, result.data.messages[0].message_id);
    assert.equal(result.data.has_more, null);
    assert.equal((await service.action({ action: 'get_group_msg_history', params: { group_id: 22222, message_id: anchor.id } })).retcode, 1404);
    assert.equal((await service.action({ action: 'get_group_msg_history', params: { group_id: 12345, count: 101 } })).retcode, 1400);
    page = [sample({ msgId: '10001', msgSeq: '9007199254740996' })];
    assert.equal((await service.action({ action: 'get_group_msg_history', params: { group_id: 12345, message_id: anchor.id, count: 2 } })).retcode, 1500);
});

test('delete_msg checks the current original message and requires a positive recall confirmation', async t => {
    const { service, backend, store, calls } = fixture(t);
    const entry = store.remember('11111', sample());
    const original = backend.call;
    backend.call = async (method, params) => method === 'recall' ? (calls.push({ method, params }), { recalled: true }) : original(method, params);
    const response = await service.action({ action: 'delete_msg', params: { message_id: entry.id }, echo: null });
    assert.equal(response.retcode, 0);
    assert.equal(response.data, null);
    assert.equal(response.echo, null);
    assert.equal(calls.find(item => item.method === 'recall').params.expectedEpoch, 'session-1');
    assert.equal(store.get('11111', entry.id).recalled, true);
    assert.equal((await service.action({ action: 'delete_msg', params: { message_id: entry.id } })).retcode, 1404);
    assert.equal(calls.filter(item => item.method === 'recall').length, 1);
});

test('recall notices use the original ID, resolve the real operator and persist separate deduplication', async t => {
    const { service, backend, store, directory } = fixture(t);
    const message = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    const record = sample({ recallTime: String(Math.floor(Date.now() / 1000)), elements: [
        { elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_operator' } } }] });
    const raw = { kind: 'notice', notice: 'recall', epoch: 'session-1', selfUin: '11111', record };
    const result = await service.event(raw);
    assert.equal(result.notice_type, 'group_recall');
    assert.equal(result.message_id, message.message_id);
    assert.equal(result.user_id, 22222);
    assert.equal(result.operator_id, 22222);
    assert.equal(store.get('11111', message.message_id).record.elements[0].elementType, 1);
    assert.equal(await service.event(raw), null);
    const restarted = new OneBotService({ backend, store: new MessageStore({ directory }) });
    assert.equal(await restarted.event(raw), null);
    assert.equal(await restarted.event({ ...raw, epoch: 'old-session' }), null);
});

test('recall notices do not guess from callbacks, old timestamps or inconsistent sender identities', async t => {
    const { service, store } = fixture(t);
    store.remember('11111', sample());
    const raw = { kind: 'notice', notice: 'recall', epoch: 'session-1', selfUin: '11111' };
    assert.equal(await service.event({ ...raw, record: sample({ recallTime: '1' }) }), null);
    assert.equal(await service.event({ ...raw, record: sample({ recallTime: String(Math.floor(Date.now() / 1000)), senderUin: '33333',
        elements: [{ elementType: 8, grayTipElement: { revokeElement: { operatorUid: 'u_operator' } } }] }) }), null);
    assert.equal(store.get('11111', 1).recalled, undefined);
});

test('authorization revoked during an awaited lookup prevents a later kernel send', async t => {
    const { backend, store, calls } = fixture(t);
    let authorized = true;
    const service = new OneBotService({ backend, store, authorizeSession: () => authorized });
    const original = backend.call;
    backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'resolve') authorized = false;
        return result;
    };
    const response = await service.action({ action: 'send_private_msg', params: { user_id: 22222, message: 'must not send' } });
    assert.equal(response.retcode, 1503);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('an awaited authorization check cannot extend the action deadline before a side effect', async t => {
    const { service, calls } = fixture(t);
    service.actionTimeoutMs = 10;
    service.authorizeSession = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return true; };
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'deadline' } });
    assert.equal(response.retcode, 1504);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('group mutation actions never coerce string booleans or pretend an unconfirmed mutation succeeded', async t => {
    const { service, backend, calls } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'groupAction') { calls.push({ method, params }); return { confirmed: true }; }
        if (method === 'groupMember') return { group_id: Number(params.groupId), user_id: Number(params.uin), role: params.uin === '11111' ? 'owner' : 'member' };
        return original(method, params);
    };
    for (const [action, params, expected] of [
        ['set_group_name', { group_id: 12345, group_name: 'Group Name' }, { operation: 'name', name: 'Group Name' }],
        ['set_group_whole_ban', { group_id: 12345, enable: false }, { operation: 'wholeBan', enable: false }],
        ['set_group_ban', { group_id: 12345, user_id: 22222, duration: 0 }, { operation: 'memberBan', uin: '22222', duration: 0 }],
        ['set_group_leave', { group_id: 12345 }, { operation: 'leave' }]
    ]) {
        const response = await service.action({ action, params });
        assert.equal(response.retcode, 0);
        assert.deepEqual(calls.filter(item => item.method === 'groupAction').at(-1).params, { groupId: '12345', ...expected, expectedEpoch: 'session-1' });
    }
    const before = calls.filter(item => item.method === 'groupAction').length;
    assert.equal((await service.action({ action: 'set_group_whole_ban', params: { group_id: 12345, enable: 'false' } })).retcode, 1400);
    assert.equal((await service.action({ action: 'set_group_leave', params: { group_id: 12345, is_dismiss: true } })).retcode, 1404);
    assert.equal((await service.action({ action: 'set_group_ban', params: { group_id: 12345, user_id: 22222, duration: 1.5 } })).retcode, 1400);
    assert.equal(calls.filter(item => item.method === 'groupAction').length, before);
    backend.call = async (method, params) => method === 'groupAction' ? {} : original(method, params);
    assert.equal((await service.action({ action: 'set_group_name', params: { group_id: 12345, group_name: 'Group' } })).retcode, 1500);
});

test('CQ strings preserve escapes, whitespace and literal auto_escape', () => {
    const text = 'a & [CQ:at,qq=123] ,\n';
    const segments = [{ type: 'text', data: { text } }, { type: 'at', data: { qq: '22222' } }];
    assert.deepEqual(codec.parse(codec.stringify(segments)), segments);
    assert.deepEqual(codec.parse('[CQ:at,qq=22222]', true), [{ type: 'text', data: { text: '[CQ:at,qq=22222]' } }]);
    assert.throws(() => codec.parse([{ type: 'image', data: { file: 'https://example.test/private' } }]), { code: 'UNSUPPORTED' });
    assert.throws(() => codec.parse('[CQ:at,qq=22222,qq=33333]'), { code: 'INVALID_REQUEST' });
});

test('persistent IDs preserve long native strings, isolate accounts and never reuse evicted IDs', t => {
    const { store, directory } = fixture(t, 1);
    const first = store.remember('11111', sample());
    assert.equal(first.id, 1);
    const second = store.remember('11111', sample({ msgId: '18446744073709551613' }));
    assert.equal(second.id, 2);
    assert.equal(store.get('11111', first.id).record, undefined);
    assert.equal(store.remember('33333', sample()).id, 1);
    const reopened = new MessageStore({ directory, maxMessages: 1 });
    assert.equal(reopened.remember('11111', sample()).id, 1);
    assert.equal(reopened.remember('11111', sample({ msgId: '18446744073709551614' })).id, 3);
    assert.equal(reopened.get('11111', 1).locator.nativeId, '18446744073709551612');
    assert.throws(() => reopened.remember('11111', sample({ msgId: 18446744073709551612 })), { code: 'INVALID_RESPONSE' });
    for (const key of ['msgSeq', 'clientSeq']) assert.throws(() => reopened.remember('11111', sample({ [key]: 18446744073709551612 })), { code: 'INVALID_RESPONSE' });
});

test('corrupted store refuses to reset IDs', t => {
    const { directory } = fixture(t);
    fs.writeFileSync(path.join(directory, '11111.json'), '{broken');
    const store = new MessageStore({ directory });
    assert.throws(() => store.remember('11111', sample()), { code: 'INVALID_STORE' });
});

test('message snapshots reject nested precision loss and cyclic data without allocating or replacing IDs', t => {
    const { store, directory } = fixture(t);
    const original = store.remember('11111', sample());
    const saved = fs.readFileSync(path.join(directory, '11111.json'), 'utf8');
    for (const bad of [9007199254740992, NaN, Infinity]) {
        assert.throws(() => store.remember('11111', sample({ msgId: 'new-invalid', extra: { msgSeq: bad } })), { code: 'INVALID_RESPONSE' });
        assert.throws(() => store.remember('11111', sample({ msgSeq: 'changed', extra: { msgSeq: bad } })), { code: 'INVALID_RESPONSE' });
    }
    const cyclic = sample({ msgSeq: 'changed' }); cyclic.cycle = cyclic;
    assert.throws(() => store.remember('11111', cyclic), { code: 'INVALID_RESPONSE' });
    assert.equal(original.locator.seq, '25'); assert.equal(original.record.msgSeq, '25');
    assert.equal(fs.readFileSync(path.join(directory, '11111.json'), 'utf8'), saved);
    assert.equal(store.remember('11111', sample({ msgId: 'valid-next', extra: { msgSeq: 18446744073709551614n } })).id, 2);
    assert.equal(store.get('11111', 2).record.extra.msgSeq, '18446744073709551614');
});

test('all echo values are preserved and unknown online is conservative with explicit diagnostic', async t => {
    const { service } = fixture(t);
    for (const echo of [0, false, null, '', { request: 5 }]) {
        const response = await service.action({ action: 'get_status', echo });
        assert.deepEqual(response.echo, echo);
        assert.deepEqual(response.data, { online: false, qq_online_state: 'unknown', good: false });
    }
    assert.equal(Object.hasOwn(await service.action({ action: 'get_status' }), 'echo'), false);
    assert.equal((await service.action({ action: 'unavailable', echo: 0 })).retcode, 1404);
    assert.equal((await service.action({ action: 'get_status', params: [] })).retcode, 1400);
    assert.equal((await service.action({ action: 'get_status', params: { self_id: '33333' } })).retcode, 1400);
    assert.equal((await service.action({ action: 'get_friend_list', params: { self_id: '33333' } })).retcode, 1400);
    assert.equal((await service.action({ action: 'get_version_info', params: { self_id: '33333' } })).retcode, 1400);
});

test('standard get_status keeps online boolean for known online and offline states', async t => {
    const { service, state } = fixture(t);
    for (const online of [true, false]) {
        state.online = online;
        const response = await service.action({ action: 'get_status' });
        assert.deepEqual(response.data, { online, qq_online_state: online ? 'online' : 'offline', good: online });
    }
});

test('backend parameter and session failures have explicit protocol return codes', async t => {
    const { service, backend } = fixture(t);
    const original = backend.call;
    for (const [code, retcode] of [['INVALID_PARAMS', 1400], ['SESSION_CHANGED', 1503]]) {
        backend.call = async (method, params) => {
            if (method === 'groups') throw Object.assign(new Error(code), { code });
            return original(method, params);
        };
        assert.equal((await service.action({ action: 'get_group_list' })).retcode, retcode);
    }
});

test('incoming events use arrays, real identities and native deduplication', async t => {
    const { service, directory } = fixture(t);
    const event = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    assert.equal(event.post_type, 'message');
    assert.equal(event.group_id, 12345);
    assert.equal(event.self_id, 11111);
    assert.equal(event.sender.card, '群名片');
    assert.deepEqual(event.message, [{ type: 'text', data: { text: '测试 你好\n' } }]);
    assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() }), null);
    const second = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample({ msgId: 'different-message' }) });
    assert.notEqual(second.message_id, event.message_id);
    const restarted = new OneBotService({ backend: service.backend, store: new MessageStore({ directory }) });
    assert.equal(await restarted.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() }), null);
});

test('self echoes and mixed media do not trigger partial text events', async t => {
    const { service } = fixture(t);
    assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample({ senderUin: '11111', senderUid: 'u_self' }) }), null);
    assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample({ elements: [
        { elementType: 1, textElement: { content: '部分', atType: 0 } }, { elementType: 2, picElement: {} }
    ] }) }), null);
});

test('private send resolves UID, preserves text and returns the confirmed message ID', async t => {
    const { service, calls, store } = fixture(t);
    const response = await service.action({ action: 'send_private_msg', params: { user_id: '22222', message: '  你好\n', auto_escape: true }, echo: false });
    assert.equal(response.retcode, 0);
    assert.equal(response.echo, false);
    const send = calls.find(item => item.method === 'sendMessage');
    assert.deepEqual(send.params.peer, { chatType: 1, peerUid: 'u_22222' });
    assert.equal(send.params.elements[0].textElement.content, '  你好\n');
    assert.equal(store.get('11111', response.data.message_id).locator.nativeId, '18446744073709551613');
});

test('unsupported segments fail before any QQ request', async t => {
    const { service, calls } = fixture(t);
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'text', data: { text: '不要部分发送' } }, { type: 'image', data: { file: 'x' } }] } });
    assert.equal(response.retcode, 1404);
    assert.equal(calls.some(item => item.method === 'sendMessage' || item.method === 'resolve'), false);
});

test('group reply and mention use real native quote fields and keep whitespace', async t => {
    const { service, calls } = fixture(t);
    const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [
        { type: 'reply', data: { id: String(received.message_id) } },
        { type: 'at', data: { qq: '22222' } }, { type: 'text', data: { text: ' 内容\n' } }
    ] } });
    assert.equal(response.retcode, 0);
    const elements = calls.find(item => item.method === 'sendMessage').params.elements;
    assert.equal(elements[0].replyElement.replayMsgId, sample().msgId);
    const lookup = calls.find(item => item.method === 'getMessage');
    assert.equal(lookup.params.nativeId, sample().msgId);
    assert.equal(lookup.params.expectedEpoch, 'session-1');
    assert.equal(elements[1].textElement.atType, 2);
    assert.equal(elements[1].textElement.atNtUid, 'u_22222');
    assert.equal(elements[2].textElement.content, ' 内容\n');
});

test('cross-conversation and missing quotes fail without sending', async t => {
    const { service, calls } = fixture(t);
    const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 99999,
        message: [{ type: 'reply', data: { id: received.message_id } }, { type: 'text', data: { text: 'x' } }] } });
    assert.equal(response.retcode, 1400);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
    assert.equal((await service.action({ action: 'get_msg', params: { message_id: 999 } })).retcode, 1404);
});

test('quoted incoming events and get_msg agree on message IDs', async t => {
    const { service } = fixture(t);
    const first = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    const next = sample({ msgId: '9001', msgSeq: '26', elements: [
        { elementType: 7, replyElement: { replayMsgId: sample().msgId, replayMsgSeq: '25', senderUin: '22222' } },
        { elementType: 1, textElement: { content: '@海豚', atType: 2, atUid: '11111', atNtUid: 'u_self' } },
        { elementType: 1, textElement: { content: ' 继续', atType: 0 } }
    ] });
    const reply = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: next });
    assert.equal(reply.message[0].data.id, String(first.message_id));
    assert.equal(reply.message[1].data.qq, '11111');
    const queried = await service.action({ action: 'get_msg', params: { message_id: reply.message_id } });
    assert.equal(queried.retcode, 0);
    assert.deepEqual(queried.data.message, reply.message);
});

test('evicted contents query QQ by a known peer and native ID', async t => {
    const { service, store, calls } = fixture(t, 1);
    const first = store.remember('11111', sample());
    store.remember('11111', sample({ msgId: 'another' }));
    const response = await service.action({ action: 'get_msg', params: { message_id: first.id } });
    assert.equal(response.retcode, 0);
    const request = calls.find(item => item.method === 'getMessage');
    assert.equal(request.params.nativeId, sample().msgId);
    assert.deepEqual(request.params.peer, { chatType: 2, peerUid: '12345' });
});

test('delivery timeout is surfaced once without resending', async t => {
    const { service, backend, calls } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'sendMessage') {
            calls.push({ method, params });
            throw Object.assign(new Error('Delivery is unknown'), { code: 'EXPIRED' });
        }
        return original(method, params);
    };
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'test' } });
    assert.equal(response.retcode, 1504);
    assert.equal(calls.filter(item => item.method === 'sendMessage').length, 1);
});

test('account change during conversion cancels the outgoing send', async t => {
    const { service, backend, state, calls } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        const value = await original(method, params);
        if (method === 'resolve') state.epoch = 'session-2';
        return value;
    };
    const response = await service.action({ action: 'send_private_msg', params: { user_id: 22222, message: 'test' } });
    assert.equal(response.retcode, 1503);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('reply without identity never guesses a unique message from sender alone', async t => {
    const { service, store } = fixture(t);
    await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    assert.equal(store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, senderUin: '22222' }), null);
    const reply = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample({ msgId: 'new', elements: [
        { elementType: 7, replyElement: { replayMsgId: '0', replayMsgSeq: '0', senderUin: '22222' } },
        { elementType: 1, textElement: { content: '不能猜引用', atType: 0 } }
    ] }) });
    assert.equal(reply, null);
});

test('rounded native quote IDs or sequences never reach a QQ lookup', async t => {
    const { service, calls } = fixture(t);
    for (const key of ['replayMsgId', 'replayMsgSeq', 'replyMsgClientSeq']) {
        const record = sample({ msgId: 'incoming-' + key, elements: [
            { elementType: 7, replyElement: { [key]: 18446744073709551612, senderUin: '22222' } },
            { elementType: 1, textElement: { content: 'quoted message', atType: 0 } }
        ] });
        assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record }), null);
    }
    assert.equal(calls.some(item => item.method === 'getMessage'), false);
});

test('concurrent duplicate event processing has one owner even while status lookup waits', async t => {
    const { service, backend } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'resolve') await new Promise(resolve => setTimeout(resolve, 15));
        return original(method, params);
    };
    const record = sample({ elements: [{ elementType: 1, textElement: {
        content: '@成员', atType: 2, atUid: '', atNtUid: 'u_sender' } }] });
    const responses = await Promise.all(Array.from({ length: 4 }, () => service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record })));
    assert.equal(responses.filter(Boolean).length, 1);
});

test('unscoped and stale-account incoming events are never stored or reported', async t => {
    const { service, store } = fixture(t);
    for (const metadata of [{}, { epoch: 'old-session', selfUin: '11111' }, { epoch: 'session-1', selfUin: '33333' }]) {
        assert.equal(await service.event({ kind: 'message', ...metadata, record: sample() }), null);
    }
    assert.equal(store.get('11111', 1), null);
});

test('send carries expected epoch and rejects account change after kernel acceptance', async t => {
    const { service, backend, calls, state, store } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'sendMessage') state.epoch = 'session-2';
        return result;
    };
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'test' } });
    assert.equal(response.retcode, 1503);
    assert.equal(calls.find(item => item.method === 'sendMessage').params.expectedEpoch, 'session-1');
    assert.equal(calls.filter(item => item.method === 'sendMessage').length, 1);
    assert.equal(store.get('11111', 1), null);
});

test('a WS request bound to an old account cannot send on the new account', async t => {
    const { service, calls } = fixture(t);
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: 'test' } },
        { epoch: 'old-session', selfUin: '33333' });
    assert.equal(response.retcode, 1503);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('get_msg fails if the session changes during its QQ fallback query', async t => {
    const { service, store, backend, state } = fixture(t, 1);
    const entry = store.remember('11111', sample());
    store.remember('11111', sample({ msgId: 'new-message' }));
    const original = backend.call;
    backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'getMessage') state.epoch = 'session-2';
        return result;
    };
    const response = await service.action({ action: 'get_msg', params: { message_id: entry.id } });
    assert.equal(response.retcode, 1503);
    assert.equal(store.get('11111', entry.id).record, undefined);
});

test('incoming mention conversion cannot cross the account epoch', async t => {
    const { service, backend, state, store } = fixture(t);
    const original = backend.call;
    backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'resolve') state.epoch = 'session-2';
        return result;
    };
    const message = sample({ elements: [{ elementType: 1, textElement: {
        content: '@成员', atType: 2, atUid: '', atNtUid: 'u_sender' } }] });
    assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: message }), null);
    assert.equal(store.get('11111', 1).emitted, false);
});

test('one incoming event has a total deadline across multiple kernel lookups', async t => {
    const { service, backend, store } = fixture(t);
    const original = backend.call;
    service.actionTimeoutMs = 50;
    backend.call = async (method, params) => {
        if (method === 'status') await new Promise(resolve => setTimeout(resolve, 30));
        return original(method, params);
    };
    const event = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    assert.equal(event, null);
    const entry = store.get('11111', 1);
    assert.ok(!entry || !entry.emitted);
});

test('get_login_info resolves an empty nickname through the authenticated UID', async t => {
    const { service, state, backend, calls } = fixture(t);
    state.self.nickname = '';
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'user') {
            calls.push({ method, params });
            return { user_id: 11111, nickname: '真实资料昵称' };
        }
        return original(method, params);
    };
    const response = await service.action({ action: 'get_login_info' });
    assert.equal(response.retcode, 0);
    assert.deepEqual(response.data, { user_id: 11111, nickname: '真实资料昵称' });
    assert.deepEqual(calls.find(item => item.method === 'user').params, { uid: 'u_self', expectedEpoch: 'session-1' });
});

test('get_login_info rejects a different account profile without leaking its nickname', async t => {
    const { service, state, backend } = fixture(t);
    state.self.nickname = '';
    const diagnostics = [];
    service.logger = (event, data) => diagnostics.push({ event, data });
    const original = backend.call;
    backend.call = async (method, params) => method === 'user'
        ? { user_id: 33333, nickname: '不应泄漏的昵称' } : original(method, params);
    const response = await service.action({ action: 'get_login_info' });
    assert.equal(response.retcode, 0);
    assert.deepEqual(response.data, { user_id: 11111, nickname: '' });
    assert.deepEqual(diagnostics, [{ event: 'self_profile_unavailable', data: { code: 'INVALID_RESPONSE' } }]);
});

test('get_login_info preserves an empty nickname when optional profile lookup fails', async t => {
    const { service, state, backend } = fixture(t);
    state.self.nickname = '';
    const diagnostics = [];
    service.logger = (event, data) => diagnostics.push({ event, data });
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'user') throw Object.assign(new Error('private profile details must not be logged'), { code: 'NOT_FOUND' });
        return original(method, params);
    };
    const response = await service.action({ action: 'get_login_info' });
    assert.equal(response.retcode, 0);
    assert.deepEqual(response.data, { user_id: 11111, nickname: '' });
    assert.deepEqual(diagnostics, [{ event: 'self_profile_unavailable', data: { code: 'NOT_FOUND' } }]);
});

test('get_login_info refuses old-account results after a session change during profile lookup', async t => {
    const { service, state, backend } = fixture(t);
    state.self.nickname = '';
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'user') {
            state.epoch = 'session-2';
            state.self = { uin: '33333', uid: 'u_new', nickname: '新账号' };
            return { user_id: 11111, nickname: '旧账号资料' };
        }
        return original(method, params);
    };
    const response = await service.action({ action: 'get_login_info' });
    assert.equal(response.retcode, 1503);
    assert.equal(response.data, null);
});

test('get_login_info keeps an already observed nickname without querying user profiles', async t => {
    const { service, calls } = fixture(t);
    const response = await service.action({ action: 'get_login_info' });
    assert.deepEqual(response.data, { user_id: 11111, nickname: '海豚' });
    assert.equal(calls.some(item => item.method === 'user'), false);
});

test('same-account restart preserves get_msg IDs but refreshes every outgoing quote in the current QQ session', async t => {
    const { service, backend, store, state, directory, calls } = fixture(t);
    const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    store.close();
    state.epoch = 'session-2';
    const reopened = new MessageStore({ directory });
    const restarted = new OneBotService({ backend, store: reopened });
    const queried = await restarted.action({ action: 'get_msg', params: { message_id: received.message_id } });
    assert.equal(queried.retcode, 0);
    assert.equal(queried.data.message_id, received.message_id);
    assert.equal(calls.some(item => item.method === 'getMessage'), false, 'get_msg can use the persistent cache');
    const sent = await restarted.action({ action: 'send_group_msg', params: { group_id: 12345, message: [
        { type: 'reply', data: { id: received.message_id } }, { type: 'text', data: { text: '确认当前会话引用' } }
    ] } });
    assert.equal(sent.retcode, 0);
    const lookup = calls.find(item => item.method === 'getMessage');
    assert.equal(lookup.params.expectedEpoch, 'session-2');
    assert.equal(lookup.params.nativeId, sample().msgId);
    assert.deepEqual(lookup.params.peer, { chatType: 2, peerUid: '12345' });
    assert.equal(reopened.get('11111', received.message_id).locator.nativeId, sample().msgId);
    assert.equal(calls.filter(item => item.method === 'sendMessage').length, 1);
});

test('a cached quote unavailable in the current QQ session fails without sending', async t => {
    const { service, backend, calls, state } = fixture(t);
    const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    state.epoch = 'session-2';
    const original = backend.call;
    backend.call = async (method, params) => {
        if (method === 'getMessage') throw Object.assign(new Error('No such native message in current QQ'), { code: 'NOT_FOUND' });
        return original(method, params);
    };
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [
        { type: 'reply', data: { id: received.message_id } }, { type: 'text', data: { text: '不能忽略引用发送' } }
    ] } });
    assert.equal(response.retcode, 1404);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('outgoing quotes reject different sender or sequence returned under the same native ID', async t => {
    for (const changes of [{ senderUin: '33333' }, { msgSeq: '26' }, { clientSeq: '32' }, { peerUid: '99999' }, { msgId: 'different' }]) {
        const { service, backend, calls } = fixture(t);
        const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
        const original = backend.call;
        backend.call = async (method, params) => method === 'getMessage' ? sample(changes) : original(method, params);
        const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [
            { type: 'reply', data: { id: received.message_id } }, { type: 'text', data: { text: 'must fail' } }
        ] } });
        assert.equal(response.status, 'failed', JSON.stringify(changes));
        assert.equal(calls.some(item => item.method === 'sendMessage'), false);
    }
});

test('a session change during outgoing quote refresh cannot lead to sending', async t => {
    const { service, backend, calls, state } = fixture(t);
    const received = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record: sample() });
    const original = backend.call;
    backend.call = async (method, params) => {
        const result = await original(method, params);
        if (method === 'getMessage') state.epoch = 'session-2';
        return result;
    };
    const response = await service.action({ action: 'send_group_msg', params: { group_id: 12345, message: [
        { type: 'reply', data: { id: received.message_id } }, { type: 'text', data: { text: 'must fail' } }
    ] } });
    assert.equal(response.retcode, 1503);
    assert.equal(calls.some(item => item.method === 'sendMessage'), false);
});

test('ATTYPEME is accepted only when it identifies the authenticated self account', async t => {
    const { service, calls } = fixture(t);
    for (const [index, target] of [{ atUid: '11111', atNtUid: 'u_self' }, { atUid: '', atNtUid: 'u_self' }, { atUid: '11111' }].entries()) {
        const record = sample({ msgId: String(9000 + index), elements: [
            { elementType: 1, textElement: { content: '@海豚', atType: 4, ...target } },
            { elementType: 1, textElement: { content: ' 唤醒', atType: 0 } }
        ] });
        const event = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record });
        assert.deepEqual(event.message, [{ type: 'at', data: { qq: '11111' } }, { type: 'text', data: { text: ' 唤醒' } }]);
    }
    assert.equal(calls.some(item => item.method === 'resolve'), false, 'known self UID is already verified by session identity');
    for (const [index, target] of [{ atUid: '22222', atNtUid: 'u_sender' }, { atUid: '22222', atNtUid: 'u_self' }, {}].entries()) {
        const record = sample({ msgId: String(10000 + index), elements: [
            { elementType: 1, textElement: { content: '@unknown', atType: 4, ...target } }
        ] });
        assert.equal(await service.event({ kind: 'message', epoch: 'session-1', selfUin: '11111', record }), null);
    }
});

test('signed int32 mention accounts are restored to uint32 and verified against kernel UID mappings', async () => {
    const lookups = [];
    const context = { selfUin: '11111', selfUid: 'u_self', resolveUid: async uid => {
        lookups.push(uid); return { uin: '4000000000', uid };
    } };
    const record = sample({ elements: [{ elementType: 1, textElement: {
        content: '@high-account', atType: 2, atUid: '-294967296', atNtUid: 'u_high' } }] });
    assert.deepEqual(await codec.fromKernel(record, context), [{ type: 'at', data: { qq: '4000000000' } }]);
    assert.deepEqual(lookups, ['u_high']);
    for (const [signed, expected] of [[-2147483648, '2147483648'], [-1, '4294967295']]) {
        const raw = sample({ elements: [{ elementType: 1, textElement: { content: '@signed', atType: 2, atUid: signed } }] });
        assert.deepEqual(await codec.fromKernel(raw, {}), [{ type: 'at', data: { qq: expected } }]);
    }
    await assert.rejects(codec.fromKernel(record, { resolveUid: async uid => ({ uin: '33333', uid }) }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(codec.fromKernel(record, { resolveUid: async () => ({ uin: '4000000000', uid: 'u_other' }) }), { code: 'INVALID_RESPONSE' });
});

test('mention integer normalization never coerces NaN, fractions, objects or out-of-range signed values', async () => {
    for (const atUid of [NaN, Infinity, -1.5, -2147483649, '-2147483649', '-1.0', '-01', '-1e1', true, {}, 'not-a-number']) {
        const record = sample({ elements: [{ elementType: 1, textElement: { content: '@invalid', atType: 2, atUid } }] });
        await assert.rejects(codec.fromKernel(record, {}), { code: 'INVALID_RESPONSE' });
    }
    const roleMention = sample({ elements: [{ elementType: 1, textElement: { content: '@role', atType: 8, atUid: '11111' } }] });
    await assert.rejects(codec.fromKernel(roleMention, { selfUin: '11111', selfUid: 'u_self' }), { code: 'UNSUPPORTED' });
});

test('signed self mention uses the authenticated high UIN without guessing from the marker', async t => {
    const { service, state } = fixture(t);
    state.self.uin = '4000000000';
    const record = sample({ elements: [{ elementType: 1, textElement: {
        content: '@high-self', atType: 4, atUid: '-294967296', atNtUid: 'u_self' } }] });
    const event = await service.event({ kind: 'message', epoch: 'session-1', selfUin: '4000000000', record });
    assert.deepEqual(event.message, [{ type: 'at', data: { qq: '4000000000' } }]);
    await assert.rejects(codec.fromKernel(record, {}), { code: 'NOT_FOUND' });
});
