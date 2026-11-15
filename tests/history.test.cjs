'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

const parent = path.resolve(__dirname, '../work/temp');
function message(seq, extra = {}) {
    return { chatType: 2, peerUid: '12345', msgId: '18446744073709551' + String(seq),
        msgSeq: String(seq), msgTime: '1800000000', senderUin: '22222', senderUid: 'u_sender',
        elements: [{ elementType: 1, textElement: { atType: 0, content: 'history ' + seq } }], ...extra };
}
function gray(seq, extra = {}) {
    return message(seq, { senderUin: '0', senderUid: '', msgType: 5, subMsgType: 8,
        elements: [{ elementType: 8, grayTipElement: {} }], ...extra });
}
function nativeGray(seq, kind = 'groupElement') {
    const grayTipElement = { subElementType: 1, revokeElement: null, proclamationElement: null,
        emojiReplyElement: null, groupElement: null, buddyElement: null, feedMsgElement: null,
        essenceElement: null, xmlElement: null, fileReceiptElement: null, localGrayTipElement: null,
        blockGrayTipElement: null, aioOpGrayTipElement: null, jsonGrayTipElement: null, walletGrayTipElement: null };
    grayTipElement[kind] = kind === 'groupElement'
        ? { type: 1, role: 2, groupName: '', memberUid: 'u_member', memberNick: '', memberRemark: '',
            adminUid: 'u_admin', adminNick: '', adminRemark: '', createGroup: null, memberAdd: null,
            shutUp: { curTime: '1800000000', duration: '60', admin: {}, member: {} } }
        : kind === 'jsonGrayTipElement' ? { busiId: '1', jsonStr: '{}', recentAbstract: '', isServer: true,
            xmlToJsonParam: { busiType: '1', busiId: '1', c2cType: 0, serviceType: 0, ctrlFlag: 0,
                content: '', templId: '1', seqId: '1', templParam: {}, pbReserv: null, members: {} } }
            : { busiType: '1', busiId: '1', c2cType: 0, serviceType: 0, ctrlFlag: 0,
                content: '', templId: '1', seqId: '1', templParam: {}, pbReserv: null, members: {} };
    return gray(seq, { elements: [{ elementType: 8, elementId: 'synthetic-element', elementGroupId: '',
        extBufForUI: {}, textElement: null, faceElement: null, picElement: null, pttElement: null,
        replyElement: null, videoElement: null, fileElement: null, grayTipElement }] });
}
function failedSelf(seq, extra = {}) {
    return message(seq, { senderUin: '11111', senderUid: 'u_self', sendStatus: 0, ...extra });
}
function privateGray(seq, kind = 'aioOpGrayTipElement') {
    const record = nativeGray(seq, 'jsonGrayTipElement');
    record.chatType = 1; record.peerUid = 'u_22222';
    const gray = record.elements[0].grayTipElement;
    gray.jsonGrayTipElement = null;
    if (kind === 'aioOpGrayTipElement') {
        record.subMsgType = 15; gray.subElementType = 15;
        gray.aioOpGrayTipElement = { operateType: 2, peerUid: record.peerUid, fromGrpCodeOfTmpChat: '0' };
    } else {
        record.subMsgType = 12; gray.subElementType = 17;
        gray.jsonGrayTipElement = { busiId: kind === 'poke' ? '1061' : '19324', jsonStr: JSON.stringify({
            align: 'center', items: kind === 'poke'
                ? [{ type: 'qq', uid: 'u_actor' }, { type: 'nor', txt: 'synthetic poke' }, { type: 'qq', uid: 'u_target' }]
                : [{ type: 'nor', txt: 'synthetic system notice' }]
        }), recentAbstract: '', isServer: true, xmlToJsonParam: {} };
    }
    return record;
}
function fixture(t) {
    fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'history-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new MessageStore({ directory });
    const state = { ready: true, epoch: 'epoch-1', self: { uin: '11111', uid: 'u_self' } };
    const calls = [], pages = [];
    const backend = { async call(method, params) {
        if (method === 'status') return structuredClone(state);
        calls.push({ method, params });
        if (method === 'history') {
            assert.equal(params.reverse, true, 'older history must use the verified QQ direction');
            return { records: pages.shift() || [] };
        }
        if (method === 'resolve') return { uin: params.uin || '22222', uid: params.uid || 'u_' + params.uin };
        if (method === 'getMessage') return message(70, { msgId: params.nativeId, ...params.peer });
        throw new Error('Unexpected call: ' + method);
    } };
    const service = new OneBotService({ backend, store, profileId: 'profile-a' });
    const query = (params = {}) => service.action({ action: 'get_group_msg_history', params: { group_id: 12345, count: 3, ...params } });
    return { service, store, state, pages, calls, backend, directory, query };
}
function imageOf(store, account = '11111') {
    const state = store.state(account);
    return JSON.stringify({ next: state.nextId, entries: [...state.byId.values()], recent: state.recent });
}

function recalled(seq, extra = {}) {
    return message(seq, { msgType: 5, subMsgType: 4, sendStatus: 2,
        recallTime: String(Math.floor(Date.now() / 1000) - 60),
        elements: [{ elementType: 8, grayTipElement: { subElementType: 1,
            revokeElement: { operatorUid: 'u_operator', origMsgSenderUid: 'u_sender', wording: 'not user text' },
            groupElement: null, jsonGrayTipElement: null } }], ...extra });
}

test('history reports recalled native stubs as gaps and resumes past their original locator', async t => {
    const f = fixture(t), removed = recalled(89), retained = message(90);
    f.pages.push([retained, removed]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1);
    assert.equal(result.data.skipped_recalled_count, 1);
    assert.equal(result.data.skipped_system_count, 0);
    assert.equal(result.data.next_message_id, null);
    assert.equal(f.store.state('11111').byId.size, 1);
    assert.equal(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: removed.msgId }), null);
    f.pages.push([removed, message(88)]);
    const next = await f.query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.messages.length, 1);
    assert.equal(next.data.skipped_recalled_count, 0);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.nativeId, removed.msgId);
});

test('an entirely recalled page advances its raw cursor without assigning OneBot message IDs', async t => {
    const f = fixture(t), before = imageOf(f.store);
    f.pages.push([recalled(89, { msgSeq: '0' }), recalled(90, { msgSeq: '0' })]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages, []);
    assert.equal(result.data.skipped_recalled_count, 2);
    assert.equal(typeof result.data.next_history_cursor, 'string');
    assert.equal(imageOf(f.store), before);
    assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
});

test('unverified recall shapes and mixed user content remain whole-page errors', async t => {
    const cases = [];
    for (const patch of [{ subMsgType: 12 }, { recallTime: '0' }, { recallTime: '1e9' },
        { recallTime: String(Date.now() + 60000) }, { senderUid: '' }]) cases.push(recalled(89, patch));
    const wrongSender = recalled(89); wrongSender.elements[0].grayTipElement.revokeElement.origMsgSenderUid = 'u_other'; cases.push(wrongSender);
    const badOperator = recalled(89); badOperator.elements[0].grayTipElement.revokeElement.operatorUid = ''; cases.push(badOperator);
    const unknownPayload = recalled(89); unknownPayload.elements[0].grayTipElement.unknownElement = {}; cases.push(unknownPayload);
    const mixed = recalled(89); mixed.elements.push({ elementType: 1, textElement: { atType: 0, content: 'must not disappear' } }); cases.push(mixed);
    for (const record of cases) {
        const f = fixture(t), before = imageOf(f.store);
        f.pages.push([message(88), record]);
        assert.equal((await f.query()).status, 'failed');
        assert.equal(imageOf(f.store), before);
    }
});

test('history excludes only the known authorless system record and keeps a raw-page boundary cursor', async t => {
    const f = fixture(t);
    const existing = f.store.remember('11111', message(91));
    f.pages.push([message(93), gray(90), message(91)]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages.map(item => item.message_id), [existing.id, 2]);
    assert.equal(result.data.next_message_id, null);
    assert.equal(result.data.has_more, null);
    assert.equal(typeof result.data.next_history_cursor, 'string');
    assert.equal(f.store.state('11111').byId.size, 2);
    assert.equal(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: gray(90).msgId }), null);
    f.pages.push([gray(90), message(89), gray(88)]);
    const next = await f.query({ history_cursor: result.data.next_history_cursor, count: 2 });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.messages.length, 1);
    assert.equal(next.data.next_message_id, null);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.nativeId, gray(90).msgId);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.count, 3);
});

test('older history explicitly requests the native reverse=true direction before validating its inclusive page', async t => {
    const f = fixture(t);
    const anchor = f.store.remember('11111', message(254));
    const first = nativeGray(252); first.msgId = '18446744073709550001';
    const second = nativeGray(252); second.msgId = '18446744073709550002';
    const third = nativeGray(253); third.msgId = '18446744073709550003';
    const original = f.backend.call;
    f.backend.call = async (method, params) => {
        if (method !== 'history') return original(method, params);
        f.calls.push({ method, params });
        assert.equal(params.nativeId, message(254).msgId);
        assert.equal(params.count, 6);
        return { records: params.reverse === true
            ? [message(252), first, second, message(253), third, message(254)]
            : [254, 255, 256, 257, 258].map(seq => message(seq)) };
    };
    const result = await f.query({ count: 5, message_id: anchor.id });
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages.map(item => f.store.get('11111', item.message_id).locator.seq), ['252', '253']);
    assert.equal(f.calls.find(call => call.method === 'history').params.reverse, true);
    assert.equal(result.data.direction, 'older');
});

test('all-system history pages advance without allocating message IDs or claiming the end of history', async t => {
    const f = fixture(t);
    const before = imageOf(f.store);
    f.pages.push([gray(92), gray(91), gray(90)]);
    const first = await f.query();
    assert.equal(first.retcode, 0);
    assert.deepEqual(first.data.messages, []);
    assert.equal(first.data.next_message_id, null);
    assert.equal(first.data.has_more, null);
    assert.equal(imageOf(f.store), before);
    assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
    f.pages.push([gray(90), gray(89), gray(88)]);
    const second = await f.query({ history_cursor: first.data.next_history_cursor, count: 2 });
    assert.equal(second.retcode, 0);
    assert.notEqual(second.data.next_history_cursor, first.data.next_history_cursor);
    f.pages.push([]);
    const last = await f.query({ history_cursor: second.data.next_history_cursor });
    assert.equal(last.retcode, 0);
    assert.equal(last.data.next_history_cursor, null);
    assert.equal(imageOf(f.store), before);
});

test('native group, JSON and XML authorless gray-tip envelopes are excluded without parsing their content', async t => {
    const f = fixture(t), before = imageOf(f.store);
    f.pages.push([nativeGray(90), nativeGray(91, 'jsonGrayTipElement'), nativeGray(92, 'xmlElement')]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages, []);
    assert.equal(typeof result.data.next_history_cursor, 'string');
    assert.equal(imageOf(f.store), before);
    for (const mutate of [
        record => { record.elements[0].textElement = { content: 'must not be discarded' }; },
        record => { record.elements[0].grayTipElement.walletGrayTipElement = {}; },
        record => { record.elements[0].grayTipElement.subElementType = '1'; },
        record => { record.elements[0].grayTipElement.unknownElement = null; },
        record => { record.elements[0].grayTipElement.groupElement = []; }
    ]) {
        const record = nativeGray(80); mutate(record); f.pages.push([record]);
        assert.equal((await f.query()).status, 'failed');
        assert.equal(imageOf(f.store), before);
    }
});

test('the verified subtype-12 authorless system envelope follows the same strict payload checks', async t => {
    const f = fixture(t), before = imageOf(f.store);
    const record = nativeGray(90, 'jsonGrayTipElement'); record.subMsgType = 12;
    f.pages.push([record]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages, []);
    assert.equal(typeof result.data.next_history_cursor, 'string');
    assert.equal(imageOf(f.store), before);
    record.elements[0].textElement = { content: 'must not be discarded' };
    f.pages.push([record]);
    assert.equal((await f.query()).status, 'failed');
    assert.equal(imageOf(f.store), before);
});

test('distinct native identities preserve ordinary messages alongside multiple same-sequence gray tips', async t => {
    const f = fixture(t);
    const first = nativeGray(90); first.msgId = '18446744073709551001';
    const second = nativeGray(90, 'jsonGrayTipElement'); second.msgId = '18446744073709551002'; second.subMsgType = 12;
    f.pages.push([first, message(90), second]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1);
    assert.equal(f.store.state('11111').byId.size, 1);
    const third = nativeGray(90); third.msgId = '18446744073709551999';
    f.pages.push([first, third, second]);
    const next = await f.query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.deepEqual(next.data.messages, []);
    assert.notEqual(next.data.next_history_cursor, result.data.next_history_cursor);
    f.pages.push([first, second, third]);
    const loop = await f.query({ history_cursor: next.data.next_history_cursor });
    assert.equal(loop.retcode, 1500);
    assert.match(loop.message, /without advancing/);
});

test('zero-sequence system cursors advance by native identity without discarding older ordinary messages', async t => {
    const f = fixture(t);
    const first = nativeGray(0); first.msgId = '18446744073709551001';
    f.pages.push([message(90), first]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1);
    const second = nativeGray(0); second.msgId = '18446744073709551002';
    f.pages.push([first, message(89), second]);
    const next = await f.query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.messages.length, 1);
    assert.equal(f.store.get('11111', next.data.messages[0].message_id).locator.seq, '89');
    assert.equal(next.data.next_message_id, null);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.nativeId, first.msgId);
    f.pages.push([message(88, { msgSeq: '0' })]);
    assert.equal((await f.query({ history_cursor: next.data.next_history_cursor })).retcode, 1500);
});

test('undelivered self video sharing a successful message sequence does not invalidate its history page', async t => {
    const f = fixture(t);
    const failed = failedSelf(90, { msgId: '18446744073709551999', msgType: 2, subMsgType: 6,
        elements: [{ elementType: 5, videoElement: { fileName: 'not-delivered.mp4' } }] });
    f.pages.push([failed, message(90), message(91)]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 2);
    assert.equal(result.data.skipped_failed_count, 1);
    assert.equal(result.data.skipped_system_count, 0);
    assert.equal(result.data.next_message_id, null);
    assert.equal(f.store.state('11111').byId.size, 2);
    assert.equal(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: failed.msgId }), null);
    f.pages.push([failed, message(90), message(89)]);
    const next = await f.query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.messages.length, 1);
    assert.equal(next.data.skipped_failed_count, 0);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.nativeId, failed.msgId);
});

test('zero-sequence failed private sends advance their raw cursor without allocating successful IDs', async t => {
    const f = fixture(t);
    const privateRecord = record => ({ ...record, chatType: 1, peerUid: 'u_22222' });
    const records = [
        failedSelf(0, { msgId: '18446744073709551001' }),
        failedSelf(0, { msgId: '18446744073709551002', msgType: 3, subMsgType: 1,
            elements: [{ elementType: 3, fileElement: { fileName: 'not-delivered.bin' } }] }),
        failedSelf(0, { msgId: '18446744073709551003', msgType: 2, subMsgType: 3,
            elements: [{ elementType: 2, picElement: {} }, ...message(1).elements] })
    ].map(privateRecord);
    const query = params => f.service.action({ action: 'get_friend_msg_history', params: { user_id: 22222, count: 3, ...params } });
    const before = imageOf(f.store);
    f.pages.push(records);
    const result = await query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages, []);
    assert.equal(result.data.skipped_failed_count, 3);
    assert.equal(result.data.next_message_id, null);
    assert.equal(imageOf(f.store), before);
    assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
    f.pages.push([records[0], privateRecord(message(89)), privateRecord(message(90))]);
    const next = await query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.messages.length, 2);
    assert.equal(next.data.skipped_failed_count, 0);
    assert.equal(f.calls.filter(call => call.method === 'history')[1].params.nativeId, records[0].msgId);
    assert.equal(f.store.state('11111').byId.size, 2);
});

test('only exact self identity and numeric failed sendStatus qualify for skipped history records', async t => {
    for (const extra of [
        { senderUin: '22222' }, { senderUid: 'u_other' }, { senderUid: '' },
        { sendStatus: '0' }, { sendStatus: undefined }, { sendStatus: 2 }
    ]) {
        const f = fixture(t), before = imageOf(f.store);
        f.pages.push([message(89), failedSelf(0, extra)]);
        assert.equal((await f.query()).retcode, 1500);
        assert.equal(imageOf(f.store), before);
    }
    const f = fixture(t);
    f.pages.push([failedSelf(90, { senderUin: '22222', senderUid: 'u_sender' })]);
    const result = await f.query();
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1, 'another sender is never silently treated as a failed local send');
    assert.equal(result.data.skipped_failed_count, 0);
});

test('failed local sends still reject crossed peers, duplicate identities and malformed timestamps atomically', async t => {
    for (const extra of [
        { peerUid: '54321' }, { chatType: 1, peerUid: 'u_12345' }, { msgTime: '1e9' },
        { msgId: message(89).msgId }, { msgId: '0' }
    ]) {
        const f = fixture(t), before = imageOf(f.store);
        f.pages.push([message(89), failedSelf(0, extra)]);
        assert.equal((await f.query()).retcode, 1500);
        assert.equal(imageOf(f.store), before);
    }
});

test('verified private AIO, JSON19324 and poke gray tips are skipped without creating user messages', async t => {
    const f = fixture(t), before = imageOf(f.store);
    const aio = privateGray(0); aio.msgId = '18446744073709551001';
    const notice = privateGray(1, 'notice'); notice.msgId = '18446744073709551002';
    const poke = privateGray(1, 'poke'); poke.msgId = '18446744073709551003';
    f.pages.push([aio, notice, poke]);
    const query = params => f.service.action({ action: 'get_friend_msg_history', params: { user_id: 22222, count: 3, ...params } });
    const result = await query();
    assert.equal(result.retcode, 0);
    assert.deepEqual(result.data.messages, []);
    assert.equal(result.data.skipped_system_count, 3);
    assert.equal(result.data.skipped_failed_count, 0);
    assert.equal(imageOf(f.store), before);
    const older = privateGray(0); older.msgId = '18446744073709551004';
    older.elements[0].grayTipElement.aioOpGrayTipElement.fromGrpCodeOfTmpChat = '';
    f.pages.push([aio, older]);
    const next = await query({ history_cursor: result.data.next_history_cursor });
    assert.equal(next.retcode, 0);
    assert.equal(next.data.skipped_system_count, 1);
    assert.equal(imageOf(f.store), before);
    assert.equal((await f.query({ history_cursor: result.data.next_history_cursor })).retcode, 1404);
    assert.equal((await query({ user_id: 33333, history_cursor: result.data.next_history_cursor })).retcode, 1404);
    f.state.epoch = 'changed';
    assert.equal((await query({ history_cursor: result.data.next_history_cursor })).retcode, 1404);
});

test('mixed private failed sends and verified system tips retain ordinary messages with the same native sequence', async t => {
    const f = fixture(t);
    const failed = failedSelf(0, { chatType: 1, peerUid: 'u_22222', msgId: '18446744073709551001' });
    const aio = privateGray(0); aio.msgId = '18446744073709551002';
    const notice = privateGray(1, 'notice'); notice.msgId = '18446744073709551003';
    const ordinary = message(1, { chatType: 1, peerUid: 'u_22222', msgId: '18446744073709551004' });
    f.pages.push([failed, aio, ordinary, notice]);
    const result = await f.service.action({ action: 'get_friend_msg_history', params: { user_id: 22222, count: 4 } });
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1);
    assert.equal(result.data.skipped_failed_count, 1);
    assert.equal(result.data.skipped_system_count, 2);
    assert.equal(f.store.state('11111').byId.size, 1);
});

test('unknown or mixed private gray-tip payloads fail atomically instead of silently discarding content', async t => {
    for (const [kind, mutate] of [
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.aioOpGrayTipElement.peerUid = 'u_other'; }],
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.aioOpGrayTipElement.operateType = 3; }],
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.aioOpGrayTipElement.operateType = '2'; }],
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.aioOpGrayTipElement.fromGrpCodeOfTmpChat = '12345'; }],
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.aioOpGrayTipElement.extra = true; }],
        ['aioOpGrayTipElement', record => { record.elements[0].grayTipElement.jsonGrayTipElement = {}; }],
        ['aioOpGrayTipElement', record => { record.elements[0].textElement = { content: 'must not be lost' }; }],
        ['aioOpGrayTipElement', record => { record.peerUid = 'u_wrong'; }],
        ['aioOpGrayTipElement', record => { record.subMsgType = 12; }],
        ['notice', record => { record.elements[0].grayTipElement.jsonGrayTipElement.busiId = '19325'; }],
        ['notice', record => { record.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = '{'; }],
        ['notice', record => { record.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = JSON.stringify({ align: 'center', items: [{ type: 'qq', uid: 'u_sender' }] }); }],
        ['notice', record => { record.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = JSON.stringify({ align: 'center', items: [{ type: 'nor', txt: 'system', extra: true }] }); }],
        ['poke', record => { record.elements[0].grayTipElement.groupElement = {}; }],
        ['poke', record => { record.elements[0].grayTipElement.jsonGrayTipElement.jsonStr = JSON.stringify({ items: [{ type: 'qq', uid: 'u_actor' }] }); }]
    ]) {
        const f = fixture(t), before = imageOf(f.store), record = privateGray(0, kind);
        mutate(record);
        f.pages.push([message(1, { chatType: 1, peerUid: 'u_22222' }), record]);
        const result = await f.service.action({ action: 'get_friend_msg_history', params: { user_id: 22222 } });
        assert.equal(result.status, 'failed');
        assert.equal(imageOf(f.store), before);
        assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
    }
});

test('a full hundred-record shared-sequence page produces a usable bounded cursor longer than 2048 bytes', async t => {
    const f = fixture(t);
    const records = Array.from({ length: 99 }, (_, index) => {
        const record = nativeGray(90); record.msgId = String(18446744073709551000n + BigInt(index)); return record;
    });
    records.splice(45, 0, message(90));
    f.pages.push(records);
    const result = await f.query({ count: 100 });
    assert.equal(result.retcode, 0);
    assert.equal(result.data.messages.length, 1);
    assert.ok(result.data.next_history_cursor.length > 2048);
    assert.ok(result.data.next_history_cursor.length < 65536);
    const next = nativeGray(90); next.msgId = '18446744073709551999';
    f.pages.push([records[0], next]);
    const followed = await f.query({ count: 100, history_cursor: result.data.next_history_cursor });
    assert.equal(followed.retcode, 0);
    assert.deepEqual(followed.data.messages, []);
});

test('a cursor chain fails explicitly at its consumed-ID limit without silently forgetting earlier identities', async t => {
    const f = fixture(t), before = imageOf(f.store);
    let cursor;
    for (let page = 0; page < 11; page++) {
        const records = Array.from({ length: page === 10 ? 25 : 100 }, (_, index) => {
            const record = nativeGray(0);
            record.msgId = String(18446744073709540000n + BigInt(page * 100 + index));
            return record;
        });
        f.pages.push(records);
        const result = await f.query({ count: 100, ...(cursor ? { history_cursor: cursor } : {}) });
        if (page < 10) {
            assert.equal(result.retcode, 0);
            cursor = result.data.next_history_cursor;
        } else {
            assert.equal(result.retcode, 1404);
            assert.match(result.message, /1024-record limit/);
        }
    }
    assert.equal(imageOf(f.store), before);
});

test('history cursors reject tampering, mixed cursor modes, other conversations, sessions and worker instances', async t => {
    const f = fixture(t);
    f.pages.push([gray(90)]);
    const cursor = (await f.query()).data.next_history_cursor;
    assert.equal((await f.query({ history_cursor: cursor, message_id: 1 })).retcode, 1400);
    const tampered = cursor[0] === 'A' ? 'B' + cursor.slice(1) : 'A' + cursor.slice(1);
    assert.equal((await f.query({ history_cursor: tampered })).retcode, 1404);
    assert.equal((await f.query({ history_cursor: cursor, group_id: 54321 })).retcode, 1404);
    const epoch = f.state.epoch; f.state.epoch = 'epoch-2';
    assert.equal((await f.query({ history_cursor: cursor })).retcode, 1404);
    f.state.epoch = epoch;
    f.state.self.uin = '33333';
    assert.equal((await f.query({ history_cursor: cursor })).retcode, 1404);
    f.state.self.uin = '11111';
    const other = new OneBotService({ backend: f.backend, store: f.store, profileId: 'profile-a' });
    const restarted = await other.action({ action: 'get_group_msg_history', params: { group_id: 12345, history_cursor: cursor } });
    assert.equal(restarted.retcode, 1404);
    assert.equal(f.calls.filter(call => call.method === 'history').length, 1);
});

test('unknown gray records, authorless private records and mixed elements fail without leaving mappings', async t => {
    for (const record of [gray(90, { subMsgType: 9 }), gray(90, { senderUin: undefined }),
        gray(90, { elements: [] }), gray(90, { elements: [{ elementType: 8, grayTipElement: { unknown: true } }] }),
        gray(90, { elements: [...gray(90).elements, ...message(90).elements] })]) {
        const f = fixture(t), before = imageOf(f.store);
        f.pages.push([message(89), record]);
        assert.equal((await f.query()).status, 'failed');
        assert.equal(imageOf(f.store), before);
        assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
    }
    const f = fixture(t), before = imageOf(f.store);
    f.pages.push([gray(90, { chatType: 1, peerUid: 'u_22222' })]);
    const result = await f.service.action({ action: 'get_friend_msg_history', params: { user_id: 22222 } });
    assert.equal(result.status, 'failed');
    assert.equal(imageOf(f.store), before);
});

test('history rejects duplicate IDs, duplicate sequences, malformed timestamps and crossed pages atomically', async t => {
    for (const records of [
        [message(89), message(90, { msgId: message(89).msgId })],
        [message(89), message(90, { msgSeq: '89' })],
        [message(89), message(90, { msgTime: '1e9' })],
        [message(89), message(90, { peerUid: '54321' })],
        [message(89), message(90, { msgId: 18446744073709551615 })]
    ]) {
        const f = fixture(t), before = imageOf(f.store);
        f.pages.push(records);
        assert.equal((await f.query()).retcode, 1500);
        assert.equal(imageOf(f.store), before);
    }
});

test('a failed later conversion also discards staged IDs created while resolving earlier quoted messages', async t => {
    const f = fixture(t), before = imageOf(f.store);
    f.pages.push([message(88, { elements: [{ elementType: 7, replyElement: { replayMsgId: '777', replayMsgSeq: '70' } }] }),
        message(89, { elements: [{ elementType: 999 }] })]);
    const result = await f.query();
    assert.equal(result.retcode, 1404);
    assert.ok(f.calls.some(call => call.method === 'getMessage'));
    assert.equal(imageOf(f.store), before);
    assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
});

test('history detects a session change during conversion before publishing any message IDs', async t => {
    const f = fixture(t), before = imageOf(f.store), original = f.service.convert;
    f.service.convert = async function (...args) {
        const result = await original.apply(this, args);
        f.state.epoch = 'changed';
        return result;
    };
    f.pages.push([message(90)]);
    assert.equal((await f.query()).retcode, 1503);
    assert.equal(imageOf(f.store), before);
});

test('history conversion deadlines and media failures never publish partial mappings', async t => {
    for (const code of ['TIMEOUT', 'UNSUPPORTED', 'NOT_FOUND']) {
        const f = fixture(t), before = imageOf(f.store), original = f.service.convert;
        let calls = 0;
        f.service.convert = async function (...args) {
            if (++calls === 2) throw Object.assign(new Error('Synthetic conversion failure'), { code });
            return original.apply(this, args);
        };
        f.pages.push([message(89), message(90)]);
        const result = await f.query();
        assert.equal(result.status, 'failed');
        assert.equal(imageOf(f.store), before);
        assert.equal(fs.existsSync(path.join(f.directory, '11111.json')), false);
    }
});

test('an opaque history cursor expires and cannot be used to fetch, recall or quote a system record', async t => {
    const f = fixture(t);
    f.pages.push([gray(90)]);
    const cursor = (await f.query()).data.next_history_cursor;
    for (const action of ['get_msg', 'delete_msg']) {
        assert.equal((await f.service.action({ action, params: { message_id: cursor } })).retcode, 1400);
    }
    const quoted = await f.service.action({ action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'reply', data: { id: cursor } }, { type: 'text', data: { text: 'not sent' } }] } });
    assert.equal(quoted.status, 'failed');
    const originalNow = Date.now;
    Date.now = () => originalNow() + 16 * 60 * 1000;
    try { assert.equal((await f.query({ history_cursor: cursor })).retcode, 1404); }
    finally { Date.now = originalNow; }
    assert.equal(f.calls.filter(call => call.method === 'history').length, 1);
});

test('history batch commits preserve preexisting IDs and reject a concurrent writer without overwriting it', async t => {
    const f = fixture(t), existing = f.store.remember('11111', message(80));
    const original = f.service.convert;
    f.service.convert = async function (...args) {
        const result = await original.apply(this, args);
        f.store.remember('11111', message(95));
        return result;
    };
    f.pages.push([message(90)]);
    assert.equal((await f.query()).retcode, 1503);
    assert.equal(f.store.get('11111', existing.id).locator.nativeId, message(80).msgId);
    assert.equal(f.store.state('11111').byId.size, 2);
    assert.equal(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: message(90).msgId }), null);
    assert.ok(f.store.find('11111', { peer: { chatType: 2, peerUid: '12345' }, nativeId: message(95).msgId }));
});

test('failed atomic persistence leaves the active history mapping and next ID unchanged', async t => {
    const f = fixture(t);
    f.store.remember('11111', message(80));
    const before = imageOf(f.store), file = path.join(f.directory, '11111.json'), disk = fs.readFileSync(file, 'utf8');
    f.store.persist = () => { throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' }); };
    f.pages.push([message(90)]);
    assert.equal((await f.query()).retcode, 1500);
    assert.equal(imageOf(f.store), before);
    assert.equal(fs.readFileSync(file, 'utf8'), disk);
    const reopened = new MessageStore({ directory: f.directory });
    assert.equal(imageOf(reopened), before);
});
