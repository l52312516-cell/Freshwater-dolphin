'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAccountQuery, MAX_COUNT, MAX_PAGES } = require('../src/onebot/account-queries.cjs');

function profile(uid = 'u_self') {
    return { uid, time: '1234567890', favoriteInfo: { userInfos: [], total_count: 4, last_time: 12, today_count: 1 },
        voteInfo: { userInfos: [{ uid: 'u_voter' }], total_count: 700, new_count: 3, new_nearby_count: 2, last_visit_time: 123 } };
}
function fixture() {
    const calls = [], where = { peer: { chatType: 2, peerUid: '54321' }, nativeId: '18446744073709551000', seq: '18446744073709551001' },
        state = { epoch: 'e1', self: { uin: '12345', uid: 'u_self' }, capabilities: { profileLikeRead: true, messageEmojiLikes: true } };
    const service = { profileId: 'account-one', store: { get(account, id) { return String(account) === '12345' && id === 1 ? { locator: where } : null; } },
        async assertSession(current) { if (current.epoch !== state.epoch) throw Object.assign(new Error('Session changed'), { code: 'NOT_READY' }); },
        async sessionCall(current, method, params) {
            await this.assertSession(current); calls.push({ method, params });
            if (method === 'resolve') return { uin: params.uin, uid: 'u_friend' };
            if (method === 'getMessage') return { chatType: where.peer.chatType, peerUid: where.peer.peerUid, msgId: where.nativeId, msgSeq: where.seq };
            if (params.operation === 'message.locate') return { ...params };
            if (params.operation === 'profile.likes') return { ...params, profile: profile(params.uid) };
            const page = params.cookie ? Number(params.cookie.slice(1)) : 0;
            return { ...params, users: Array.from({ length: 15 }, (_, i) => ({ tinyId: String(20000 + page * 15 + i), nickName: '用户' + (page * 15 + i), headUrl: '' })),
                cookie: 'p' + (page + 1), isFirstPage: page === 0, isLastPage: false };
        } };
    return { service, state, calls, where, run: (action, params) => runAccountQuery(service, state, action, params), emoji: { message_id: 1, emoji_id: '76' } };
}

test('profile-like queries default to self and preserve native counters without adding fabricated user UINs', async () => {
    const f = fixture();
    assert.deepEqual(await f.run('get_profile_like', {}), profile());
    assert.deepEqual(f.calls[0], { method: 'accountQuery', params: { operation: 'profile.likes', uid: 'u_self', start: 0, count: 10 } });
    const result = await f.run('get_profile_like', { user_id: '54321', start: '20', count: '5' });
    assert.equal(f.calls[1].method, 'resolve'); assert.equal(f.calls[2].params.uid, 'u_friend'); assert.equal(result.uid, 'u_friend');
    assert.equal(Object.hasOwn(result.voteInfo.userInfos[0], 'uin'), false);
});

test('profile identity and all pagination fields are validated before resolving another account', async () => {
    const f = fixture();
    for (const params of [{ user_id: '54321', start: -1 }, { user_id: '54321', count: 0 }, { user_id: '54321', count: 101 }, { start: null }, { count: null },
        { user_id: '54321', count: true }, { user_id: '54321', extra: true }, { user_id: '0' }, { self_id: '99999' }]) {
        await assert.rejects(f.run('get_profile_like', params), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.length, 0);
    f.state.capabilities.profileLikeRead = false;
    await assert.rejects(f.run('get_profile_like', { user_id: '54321' }), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 0);
});

test('emoji count zero is bounded to ten pages and returns an explicit continuation', async () => {
    const f = fixture(), response = await f.run('get_emoji_likes', f.emoji);
    assert.equal(response.emoji_like_list.length, MAX_COUNT); assert.equal(response.fetched_pages, MAX_PAGES);
    assert.equal(response.has_more, true); assert.equal(response.partial, true); assert.equal(response.limit, 150);
    assert.equal(typeof response.next_cursor, 'string'); assert.equal(f.calls.filter(call => call.params.operation === 'message.emojiLikes').length, 10);
    assert.equal(response.emoji_like_list[149].user_id, '20149');
    const next = await f.run('get_emoji_likes', { ...f.emoji, count: 1, cursor: response.next_cursor });
    assert.equal(next.emoji_like_list[0].user_id, '20150');
});

test('reaction cursors retain unread native page entries so small requested counts never skip users', async () => {
    const f = fixture();
    const first = await f.run('get_emoji_likes', { ...f.emoji, count: 1 });
    assert.equal(first.emoji_like_list[0].user_id, '20000');
    const second = await f.run('get_emoji_likes', { ...f.emoji, count: 14, cursor: first.next_cursor });
    assert.equal(second.emoji_like_list[0].user_id, '20001'); assert.equal(second.emoji_like_list.at(-1).user_id, '20014');
    assert.equal(second.fetched_pages, 0); assert.equal(second.has_more, true);
    const third = await f.run('get_emoji_likes', { ...f.emoji, count: 1, cursor: second.next_cursor });
    assert.equal(third.emoji_like_list[0].user_id, '20015');
    assert.equal(f.calls.filter(call => call.params.operation === 'message.emojiLikes').length, 2);
});

test('a confirmed last page still exposes a continuation until all buffered users have been returned', async () => {
    const f = fixture(), original = f.service.sessionCall.bind(f.service);
    f.service.sessionCall = async (...args) => { const value = await original(...args); if (args[2].operation === 'message.emojiLikes') { value.isLastPage = true; value.cookie = ''; } return value; };
    const first = await f.run('get_emoji_likes', { ...f.emoji, count: 2 });
    assert.equal(first.has_more, true); assert.equal(first.partial, true);
    const next = await f.run('get_emoji_likes', { ...f.emoji, count: 15, cursor: first.next_cursor });
    assert.equal(next.emoji_like_list.length, 13); assert.equal(next.has_more, false); assert.equal(next.partial, false); assert.equal(next.next_cursor, null);
    assert.equal(next.fetched_pages, 0);
});

test('invalid or cross-scope reaction cursors fail before any QQ call', async () => {
    const f = fixture(), first = await f.run('get_emoji_likes', { ...f.emoji, count: 1 });
    f.calls.length = 0;
    for (const params of [{ ...f.emoji, cursor: first.next_cursor + 'x' }, { ...f.emoji, emoji_id: '77', cursor: first.next_cursor },
        { ...f.emoji, emoji_type: '2', cursor: first.next_cursor }, { ...f.emoji, cursor: '' }]) {
        await assert.rejects(f.run('get_emoji_likes', params), { code: 'NOT_FOUND' });
    }
    f.state.epoch = 'e2'; await assert.rejects(f.run('get_emoji_likes', { ...f.emoji, cursor: first.next_cursor }), { code: 'NOT_FOUND' }); f.state.epoch = 'e1';
    f.service.profileId = 'account-two'; await assert.rejects(f.run('get_emoji_likes', { ...f.emoji, cursor: first.next_cursor }), { code: 'NOT_FOUND' }); f.service.profileId = 'account-one';
    f.where.seq = '999'; await assert.rejects(f.run('get_emoji_likes', { ...f.emoji, cursor: first.next_cursor }), { code: 'NOT_FOUND' });
    assert.equal(f.calls.length, 0);
});

test('unknown messages, invalid counts/types and a mismatched group never trigger QQ lookups', async () => {
    const f = fixture();
    for (const params of [{ ...f.emoji, count: 151 }, { ...f.emoji, count: -1 }, { ...f.emoji, count: null }, { ...f.emoji, emoji_type: null }, { ...f.emoji, emoji_type: 1 }, { ...f.emoji, emoji_id: '01' },
        { ...f.emoji, group_id: '99999' }, { ...f.emoji, cookie: 'unbound-raw-cookie' }, { ...f.emoji, message_id: f.where.nativeId }]) {
        await assert.rejects(f.run('get_emoji_likes', params), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(f.run('get_emoji_likes', { ...f.emoji, message_id: 2 }), { code: 'NOT_FOUND' });
    f.state.capabilities.messageEmojiLikes = false; await assert.rejects(f.run('get_emoji_likes', f.emoji), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('mismatched refreshed messages, unrelated native pages and repeated page identities fail explicitly', async () => {
    const wrong = fixture(), original = wrong.service.sessionCall.bind(wrong.service);
    wrong.service.sessionCall = async (...args) => { const value = await original(...args); if (args[2].operation === 'message.locate') value.sequence = '9'; return value; };
    await assert.rejects(wrong.run('get_emoji_likes', wrong.emoji), { code: 'INVALID_RESPONSE' });
    assert.equal(wrong.calls.filter(call => call.params.operation === 'message.emojiLikes').length, 0);
    for (const change of [value => { value.sequence = '9'; }, value => { value.cookie = ''; }, value => { value.users[0].nickName = null; }]) {
        const f = fixture(), normal = f.service.sessionCall.bind(f.service);
        f.service.sessionCall = async (...args) => { const value = await normal(...args); if (args[2].operation === 'message.emojiLikes') change(value); return value; };
        await assert.rejects(f.run('get_emoji_likes', f.emoji), { code: 'INVALID_RESPONSE' });
    }
    const repeated = fixture(), normal = repeated.service.sessionCall.bind(repeated.service);
    repeated.service.sessionCall = async (...args) => { const value = await normal(...args); if (args[2].operation === 'message.emojiLikes') value.users[0].tinyId = '20000'; return value; };
    await assert.rejects(repeated.run('get_emoji_likes', { ...repeated.emoji, count: 30 }), { code: 'INVALID_RESPONSE' });
});

test('empty nonterminal pages stop at the page budget and report partial rather than a complete empty list', async () => {
    const f = fixture(), normal = f.service.sessionCall.bind(f.service);
    f.service.sessionCall = async (...args) => { const value = await normal(...args); if (args[2].operation === 'message.emojiLikes') value.users = []; return value; };
    const response = await f.run('get_emoji_likes', f.emoji);
    assert.equal(response.emoji_like_list.length, 0); assert.equal(response.has_more, true); assert.equal(response.partial, true);
    assert.equal(response.fetched_pages, 10); assert.equal(typeof response.next_cursor, 'string');
});

test('continuation tokens encrypt the native cookie and remain smaller than transport frame limits', async () => {
    const f = fixture(), normal = f.service.sessionCall.bind(f.service), privateCookie = 'PRIVATE-NATIVE-COOKIE-MARKER-1234567890';
    f.service.sessionCall = async (...args) => { const value = await normal(...args); if (args[2].operation === 'message.emojiLikes') value.cookie = privateCookie; return value; };
    const first = await f.run('get_emoji_likes', { ...f.emoji, count: 1 });
    assert.match(first.next_cursor, /^eq1\./); assert.ok(Buffer.byteLength(first.next_cursor) <= 262144);
    assert.equal(Buffer.from(first.next_cursor.slice(4), 'base64url').includes(Buffer.from(privateCookie)), false);
    assert.equal(Object.hasOwn(first, 'cookie'), false);
});
