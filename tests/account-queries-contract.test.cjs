'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountQueries } = require('../src/qq/account-queries.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

test('fetch_emoji_like retains native profile fields and an account-bound buffered opaque cookie', async () => {
    const f = fixture();
    const first = await f.service.action({ action: 'fetch_emoji_like', params: { message_id: 1, emojiId: '76', count: 1 } });
    assert.equal(first.retcode, 0, JSON.stringify(first));
    assert.deepEqual(first.data.emojiLikesList, [{ tinyId: '20000', nickName: 'person-0', headUrl: '' }]);
    assert.equal(first.data.isFirstPage, true); assert.equal(first.data.isLastPage, false);
    assert.match(first.data.cookie, /^eq1\./); assert.equal(first.data.cookie.includes('PRIVATE-NATIVE'), false);
    const next = await f.service.action({ action: 'fetch_emoji_like', params: { message_id: 1, emojiId: '76', count: 2, cookie: first.data.cookie } });
    assert.equal(next.retcode, 0, JSON.stringify(next));
    assert.deepEqual(next.data.emojiLikesList.map(row => row.tinyId), ['20001', '20002']);
    assert.equal(next.data.isFirstPage, false); assert.equal(next.data.isLastPage, true); assert.equal(next.data.cookie, '');
    const calls = f.calls.length;
    for (const params of [{ message_id: 1, emojiId: '76', cookie: '1' }, { message_id: 1, emojiId: '76', count: -1 },
        { message_id: 1, emojiId: '76', self_id: 99999 }, { message_id: 1, emojiId: '76', count: null },
        { message_id: 1, emojiId: '76', cookie: null }]) {
        assert.notEqual((await f.service.action({ action: 'fetch_emoji_like', params })).retcode, 0);
    }
    assert.equal(f.calls.length, calls);
});

function fixture() {
    const calls = [], logs = [], record = { chatType: 2, peerUid: '54321', msgId: '18446744073709551000', msgSeq: '18446744073709551001' },
        profile = { uid: 'u_self', time: '1234567890', favoriteInfo: { userInfos: [], total_count: 3, last_time: 2, today_count: 1 },
            voteInfo: { userInfos: [], total_count: 4, new_count: 2, new_nearby_count: 1, last_visit_time: 3 } };
    const capture = { epoch: 'real-contract-epoch', session: {}, self: { uin: '12345', uid: 'u_self' },
        ensureReady() {}, hasMethods: () => true, deadline: fn => fn(), async getMessage() { return { ...record }; },
        async invoke(service, method, args) {
            calls.push({ service, method, args });
            if (method === 'getBuddyProfileLike') return { result: 0, info: { userLikeInfos: [profile] } };
            return { result: 0, emojiLikesList: Array.from({ length: 3 }, (_, i) => ({ tinyId: String(20000 + i), nickName: 'person-' + i, headUrl: '' })),
                cookie: 'PRIVATE-NATIVE-PAGE-COOKIE', isFirstPage: args[4] === '', isLastPage: true };
        } };
    const api = createAccountQueries(capture);
    const service = new OneBotService({ profileId: 'account-one', store: { get(account, id) { return account === '12345' && id === 1 ? {
        locator: { peer: { chatType: record.chatType, peerUid: record.peerUid }, nativeId: record.msgId, seq: record.msgSeq } } : null; } },
        logger: (event, details) => logs.push({ event, details }), backend: { async call(method, params, options) {
            if (method === 'status') return { ready: true, self: capture.self, epoch: capture.epoch, capabilities: api.capabilities() };
            if (method === 'getMessage') return capture.getMessage(params);
            if (method === 'accountQuery') return api.query(params, { expiresAt: Date.now() + options.timeoutMs });
            throw new Error('Unexpected account contract method ' + method);
        } } });
    return { capture, service, calls, logs, profile };
}

test('actual OneBot dispatch and QQ factory agree on profile defaults, reaction locators and encrypted buffered continuation', async () => {
    const f = fixture(), profile = await f.service.action({ action: 'get_profile_like', params: {} });
    assert.equal(profile.retcode, 0, JSON.stringify(profile)); assert.deepEqual(profile.data, f.profile);
    const first = await f.service.action({ action: 'get_emoji_likes', params: { message_id: 1, emoji_id: '76', count: 1 } });
    assert.equal(first.retcode, 0, JSON.stringify(first)); assert.equal(first.data.has_more, true); assert.equal(first.data.emoji_like_list[0].user_id, '20000');
    const next = await f.service.action({ action: 'get_emoji_likes', params: { message_id: '1', emoji_id: '76', count: 2, cursor: first.data.next_cursor } });
    assert.equal(next.retcode, 0, JSON.stringify(next)); assert.equal(next.data.has_more, false);
    assert.deepEqual(next.data.emoji_like_list.map(user => user.user_id), ['20001', '20002']);
    const native = f.calls.find(call => call.method === 'getMsgEmojiLikesList');
    assert.equal(native.args[1], '18446744073709551001'); assert.equal(native.args[5], false); assert.equal(native.args[6], 15);
    assert.equal(f.calls.filter(call => call.method === 'getMsgEmojiLikesList').length, 1);
    assert.equal(JSON.stringify(f.logs).includes('PRIVATE-NATIVE-PAGE-COOKIE'), false);
    const capabilities = await f.service.action({ action: 'get_capabilities', params: {} });
    for (const name of ['get_profile_like', 'get_emoji_likes']) {
        const entry = capabilities.data.extensions.find(item => item.name === name);
        assert.equal(entry.implemented, true); assert.equal(entry.available, true); assert.equal(entry.verification, 'offline-tested');
    }
});

test('actual OneBot errors reject absent account-query methods and conflicting native result codes without logging raw profile fields', async () => {
    const f = fixture(); f.capture.hasMethods = () => false;
    const unsupported = await f.service.action({ action: 'get_profile_like', params: {} });
    assert.equal(unsupported.status, 'failed'); assert.equal(unsupported.retcode, 1404); assert.equal(f.calls.length, 0);
    f.capture.hasMethods = () => true;
    f.capture.invoke = async () => ({ result: 0, errorCode: 8, info: { userLikeInfos: [{ ...f.profile, nickname: 'PRIVATE-NATIVE-NICKNAME' }] } });
    const failed = await f.service.action({ action: 'get_profile_like', params: {} });
    assert.equal(failed.status, 'failed'); assert.equal(failed.data, null);
    assert.equal(JSON.stringify(f.logs).includes('PRIVATE-NATIVE-NICKNAME'), false);
});
