'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { decodeHttpParameter } = require('../src/onebot/parameter-schema.cjs');
const { createCollectionQueries } = require('../src/qq/collection-queries.cjs');
const collectionWire = require('./helpers/collection-wire.cjs');
const { createContactExtra } = require('../src/qq/contact-extra.cjs');
const { cancellable } = require('../src/ipc/common.cjs');

async function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'query-rpc-'));
    const capture = new Capture({ install: false }), calls = [];
    capture.session = {};
    capture.epoch = 'query-rpc-session'; capture.qqVersion = TARGET_VERSION; capture.ready = true; capture.online = true;
    capture.self = { uin: '12345', uid: 'u_self', nickname: 'Self' };
    const source = { chatType: 2, peerUid: '33333', msgId: '18446744073709551000', msgSeq: '77',
        senderUin: '54321', senderUid: 'u_sender', msgTime: String(Math.floor(Date.now() / 1000)),
        elements: [{ elementType: 1, textElement: { content: 'Synthetic source', atType: 0 } }] };
    let groupListener;
    const group = {
        addKernelGroupListener(value) { groupListener = value; return 1; }, removeKernelGroupListener() {},
        getGroupDetailInfo(id, type) {
            calls.push(['detail', id, type]);
            groupListener.onGroupDetailInfoChange({ groupCode: id, groupName: 'Native detail', memberNum: 2,
                maxMemberNum: 200, groupMemo: 'Real field preserved', shutUpAllTimestamp: 0, remarkName: 'Remark' });
            return { result: 0 };
        },
        getGroupExt0xEF0Info(ids) { calls.push(['ext', ids]); return { result: { groupExtInfos: new Map([[ids[0], { luckyWord: 'Native EF0' }]]) } }; },
        getAllMemberList(id) {
            calls.push(['shut', id]);
            return { errCode: 0, result: { finish: true, ids: ['u_sender'], infos: new Map([
                ['u_sender', { uid: 'u_sender', uin: '54321', nick: 'Sender', role: 2, shutUpTime: 1900000000,
                    groupHonor: new Map([[1, 10]]), nativeBuffer: Buffer.from([1, 2]), nativeWideNumber: Number.MAX_SAFE_INTEGER + 1 }]
            ]) } };
        }
    };
    const msg = {
        addKernelMsgListener() { return 1; }, removeKernelMsgListener() {},
        getMsgsByMsgId() { calls.push(['message']); return { result: 0, msgList: [source] }; },
        getMsgEmojiLikesList(_peer, _seq, _emoji, _type, cookie, forward, count) {
            calls.push(['emoji', cookie, forward, count]); return { result: 0, emojiLikesList: [{ tinyId: '54321', nickName: 'Sender', headUrl: '' }], cookie: '', isFirstPage: true, isLastPage: true };
        }
    };
    const profile = { addKernelProfileListener() { return 1; }, removeKernelProfileListener() {} };
    capture.session = { getGroupService: () => group, getMsgService: () => msg, getProfileService: () => profile,
        getProfileLikeService: () => ({ getBuddyProfileLike(input) {
            calls.push(['profile', input]); return { result: 0, info: { userLikeInfos: [{ uid: 'u_self', time: '1794810000',
                favoriteInfo: { userInfos: [], total_count: 0, last_time: 0, today_count: 0 },
                voteInfo: { userInfos: [{ uin: '54321' }], total_count: 1, new_count: 1, new_nearby_count: 0, last_visit_time: 1794810000 } }] } };
        } }),
        getTipOffService: () => ({ getPskey(domains, refresh) {
            calls.push(['collection-ticket', domains, refresh]);
            return { result: 0, domainPskeyMap: new Map([['weiyun.com', 'synthetic-ticket']]) };
        } }) };
    capture.collectionQueries = createCollectionQueries(capture, { fetchImpl: async (url, options) => {
        assert.equal(url, 'https://collector.weiyun.com/collector.fcg');
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
        const request = collectionWire.request(options.body);
        calls.push(['collection', request.count]);
        return new Response(collectionWire.page([], { uin: '12345', sequence: request.sequence }));
    } });
    capture.contactExtraApi = createContactExtra(capture, { native: { available: () => true, async run(_capture, input) {
        calls.push(['contact', input.operation, input.request]);
        if (input.operation === 'translate') return { words: ['你好', '世界'], sourceWords: input.request.words };
        if (input.operation === 'unidirectional') return { items: [], limit: 99, complete: false };
        if (input.operation === 'doubt.list') return { items: [], limit: input.request.count };
        if (input.operation === 'group.filtered') return { items: [], cursor: '0', filtered: true };
        throw new Error('Unexpected contact mutation');
    } } });
    capture.attach();
    const server = await startServer({ dir: path.join(root, 'rpc'), backend: capture, pollMs: 1 });
    const backend = new RpcClient({ directory: path.join(root, 'rpc'), timeoutMs: 3000 });
    const store = new MessageStore({ directory: path.join(root, 'data') });
    const service = new OneBotService({ backend, store, actionTimeoutMs: 2000 });
    const messageId = store.remember('12345', source).id;
    t.after(async () => { backend.close(); await server.close(); capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { capture, service, calls, messageId };
}

test('six read-only OneBot extensions cross actual file RPC, fixed dispatch and session capability checks', async t => {
    const f = await fixture(t);
    const requests = [
        ['get_group_detail_info', { group_id: 33333 }], ['get_group_info_ex', { group_id: 33333 }],
        ['get_group_shut_list', { group_id: 33333 }], ['get_collection_list', { count: 2 }],
        ['get_profile_like', {}], ['get_emoji_likes', { message_id: f.messageId, emoji_id: '76', count: 1 }]
    ];
    const caps = await f.service.action({ action: 'get_capabilities' });
    for (const [action, params] of requests) {
        assert.equal(caps.data.extensions.find(row => row.name === action)?.available, true, action);
        const result = await f.service.action({ action, params, echo: { action } });
        assert.equal(result.retcode, 0, action + ': ' + JSON.stringify(result));
        assert.deepEqual(result.echo, { action });
        if (action === 'get_group_detail_info') assert.equal(result.data.groupMemo, 'Real field preserved');
        if (action === 'get_group_info_ex') assert.equal(result.data.luckyWord, 'Native EF0');
        if (action === 'get_group_shut_list') assert.deepEqual(result.data, [
            { uid: 'u_sender', uin: '54321', nick: 'Sender', role: 2, shutUpTime: 1900000000,
                user_id: 54321, nickname: 'Sender', shut_up_time: 1900000000 }
        ]);
        if (action === 'get_profile_like') assert.equal(result.data.voteInfo.total_count, 1);
        if (action === 'get_emoji_likes') { assert.equal(result.data.emoji_like_list[0].user_id, '54321'); assert.equal(result.data.has_more, false); }
        if (action === 'get_collection_list') assert.equal(result.data.collectionSearchList.hasMore, false);
    }
    assert.deepEqual(f.calls.find(row => row[0] === 'emoji').slice(1), ['', false, 15]);
    assert.deepEqual(f.calls.find(row => row[0] === 'collection-ticket').slice(1), [['weiyun.com'], true]);
    assert.equal(f.calls.find(row => row[0] === 'collection')[1], 2);
    assert.equal(f.calls.filter(row => ['detail', 'ext', 'shut', 'profile', 'collection', 'emoji'].includes(row[0])).length, 6);
});

test('new query actions reject cross-account identity and unknown methods without native dispatch', async t => {
    const f = await fixture(t);
    for (const action of ['get_group_detail_info', 'get_group_info_ex', 'get_group_shut_list', 'get_collection_list', 'get_profile_like', 'get_emoji_likes']) {
        const response = await f.service.action({ action, params: { self_id: 99999 } });
        assert.equal(response.retcode, 1400, action);
    }
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.capture.call('arbitraryQuery', {}), { code: 'UNSUPPORTED' });
    await assert.rejects(f.capture.call('collectionQuery', { expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.length, 0);
});

test('HTTP query pagination decodes only schema integer fields and preserves exact timestamp and emoji strings', () => {
    for (const name of ['category', 'count', 'start']) assert.equal(decodeHttpParameter(name, '12'), 12);
    assert.equal(decodeHttpParameter('time_stamp', '18446744073709551615'), '18446744073709551615');
    assert.equal(decodeHttpParameter('emoji_id', '128512'), '128512');
    assert.equal(decodeHttpParameter('cursor', 'opaque.cursor'), 'opaque.cursor');
});

test('contact reads cross the actual file RPC with capability and account gates; only read operations are cancellable', async t => {
    const f = await fixture(t);
    const requests = [['translate_en2zh', { words: ['hello', 'world'] }], ['get_unidirectional_friend_list', {}],
        ['get_doubt_friends_add_request', { count: 10 }], ['get_group_ignore_add_request', {}], ['get_group_ignored_notifies', {}]];
    const caps = await f.service.action({ action: 'get_capabilities' });
    for (const [action, params] of requests) {
        assert.equal(caps.data.extensions.find(row => row.name === action)?.available, true, action);
        const result = await f.service.action({ action, params });
        assert.equal(result.retcode, 0, action + ': ' + JSON.stringify(result));
        assert.deepEqual(result.data, action === 'translate_en2zh' ? { words: ['你好', '世界'] } : []);
        assert.equal((await f.service.action({ action, params: { ...params, self_id: 99999 } })).retcode, 1400);
    }
    assert.equal(f.calls.filter(row => row[0] === 'contact').length, 5);
    for (const operation of ['translate', 'unidirectional', 'doubt.list', 'group.filtered']) assert.equal(cancellable('contactExtra', { operation }), true);
    for (const operation of ['input.status', 'read.all', 'doubt.handle', 'unknown']) assert.equal(cancellable('contactExtra', { operation }), false);
    assert.equal(cancellable('contactExtra', {}), false);
    assert.deepEqual(decodeHttpParameter('words', '["hello","world"]', 'translate_en2zh'), ['hello', 'world']);
    assert.equal(decodeHttpParameter('event_type', '0', 'set_input_status'), 0);
    const count = f.calls.length;
    assert.equal((await f.service.action({ action: 'set_input_status', params: { user_id: 54321, event_type: null } })).retcode, 1400);
    assert.equal(f.calls.length, count);
    f.capture.withdrawReady(Object.assign(new Error('Session withdrawn'), { code: 'NOT_READY' }));
    assert.equal((await f.service.action({ action: 'translate_en2zh', params: { words: ['hello', 'world'] } })).retcode, 1503);
});
