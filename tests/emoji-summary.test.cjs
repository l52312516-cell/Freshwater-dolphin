'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const protocol = require('../src/qq/emoji-summary.cjs');
const { runEmojiSummary } = require('../src/onebot/emoji-summary-actions.cjs');
const input = { peer: { chatType: 2, peerUid: '55555' }, nativeId: '90001', sequence: '123' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const category = (emojiId, likesCnt, emojiType = '1') => ({ emojiId, emojiType, likesCnt: String(likesCnt), isClicked: false });
const user = value => ({ tinyId: String(value), nickName: '', headUrl: '' });
function fixture(categories = [category('76', 16), category('128512', 1, '2')]) {
    const calls = [], reads = [], capture = { epoch: 'e1', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, hasMethods: () => true, deadline: Capture.prototype.deadline };
    let records = (_index) => categories, response = args => {
        const emoji = categories.find(item => item.emojiId === args[2]), count = Number(emoji.likesCnt), offset = args[4] === '' ? 0 : Number(args[4]);
        const amount = Math.min(15, count - offset), last = offset + amount === count;
        return { result: 0, errMsg: '', emojiLikesList: Array.from({ length: amount }, (_, i) => user(20000 + offset + i)),
            cookie: last ? '' : String(offset + amount), isFirstPage: offset === 0, isLastPage: last };
    };
    capture.getMessage = async request => { reads.push(request); return { ...input.peer, msgId: input.nativeId, msgSeq: input.sequence, emojiLikesList: await records(reads.length) }; };
    capture.invoke = async (service, method, args) => { assert.equal(service, 'msg'); assert.equal(method, 'getMsgEmojiLikesList'); calls.push(args); return response(args); };
    const api = protocol.createEmojiSummary(capture), state = { self: capture.self, epoch: 'e1', capabilities: { messageEmojiSummary: true } };
    const service = { store: { get(uin, id) { return uin === '11111' && id === -12 ? { locator: { peer: input.peer, nativeId: input.nativeId, seq: input.sequence } } : null; } },
        sessionCall: (_state, method, request) => { assert.equal(method, 'emojiSummaryQuery'); return api.query({ ...request, expectedEpoch: state.epoch }); }, assertSession: async () => {} };
    return { capture, api, state, service, calls, reads, records(value) { records = value; }, response(value) { response = value; },
        query: (context = {}) => api.query({ ...input, expectedEpoch: capture.epoch }, context),
        action: (params = { message_id: -12 }) => runEmojiSummary(service, state, 'get_msg_emoji_likes', params) };
}
test('native message reaction categories and every real user page produce a bounded sourced summary', async () => {
    const f = fixture(); const result = await f.action();
    assert.equal(result.message_id, -12); assert.equal(result.source, protocol.SOURCE); assert.equal(result.complete, true);
    assert.equal(result.completeness_scope, 'qq_message_record'); assert.equal(result.last_reaction_time_available, false);
    assert.equal(result.emoji_likes.length, 2); assert.equal(result.emoji_likes[0].count, 16); assert.equal(result.emoji_likes[0].users.length, 16);
    assert.equal(result.emoji_likes[0].last_reaction_time, null); assert.equal(result.emoji_likes[1].emoji_type, 2);
    assert.deepEqual(result.emoji_likes[0].users[15], { user_id: 20015 }); assert.equal(f.calls.length, 3); assert.equal(f.reads.length, 2);
    assert.deepEqual(f.calls[0], [{ chatType: 2, peerUid: '55555', guildId: '' }, '123', '76', '1', '', false, 15]);
    assert.equal(f.calls[1][4], '15'); assert.deepEqual(f.reads, [ { peer: input.peer, nativeId: input.nativeId }, { peer: input.peer, nativeId: input.nativeId } ]);
});
test('an explicitly empty native directory still receives two refreshes and explicit completeness metadata', async () => {
    const f = fixture([]); const result = await f.action(); assert.deepEqual(result.emoji_likes, []); assert.equal(result.complete, true);
    assert.equal(result.last_reaction_time_available, false); assert.equal(f.reads.length, 2); assert.equal(f.calls.length, 0);
    const zero = fixture([category('76', 0)]); assert.equal((await zero.action()).emoji_likes[0].count, 0); assert.equal(zero.calls.length, 1);
});
test('missing, duplicate, malformed or oversized native reaction directories never become empty success', async () => {
    for (const values of [undefined, null, [category('76', 1), category('76', 1)], [category('76', 1025)],
        [category('76', '01')], [{ ...category('76', 1), emojiType: '3' }], Array.from({ length: 65 }, (_, i) => category(String(i), 0)),
        Array.from({ length: 5 }, (_, i) => category(String(i), 1024)), new Array(1)]) {
        const f = fixture(); f.records(() => values); await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 0);
    }
});
test('repeated users, premature terminal pages, nonprogressing cookies and failures never publish partial completeness', async () => {
    const cases = [
        () => ({ result: 0, emojiLikesList: [user(20000)], cookie: '', isFirstPage: true, isLastPage: true }),
        () => ({ result: 0, emojiLikesList: [user(20000), user(20000)], cookie: '', isFirstPage: true, isLastPage: true }),
        () => ({ result: 0, emojiLikesList: [], cookie: 'next', isFirstPage: true, isLastPage: false }),
        () => ({ result: 0, emojiLikesList: [user(20000)], cookie: '', isFirstPage: true, isLastPage: false }),
        () => ({ result: 0, emojiLikesList: [user(20000)], cookie: '', isFirstPage: false, isLastPage: true }),
        () => ({ result: 0, emojiLikesList: [user('u_not_a_QQ_number')], cookie: '', isFirstPage: true, isLastPage: true }),
        () => ({ emojiLikesList: [], cookie: '', isFirstPage: true, isLastPage: true })
    ];
    for (const response of cases) { const f = fixture([category('76', 16)]); f.response(response); await assert.rejects(f.action(), { code: 'INVALID_RESPONSE' }); }
    const denied = fixture(); denied.response(() => ({ result: 5, errMsg: 'private diagnostic' }));
    await assert.rejects(denied.action(), error => error.code === 'KERNEL_ERROR' && !error.message.includes('private')); assert.equal(denied.calls.length, 1);
    const repeated = fixture([category('76', 16)]); const page = repeated.calls;
    repeated.response(() => ({ result: 0, emojiLikesList: Array.from({ length: page.length === 1 ? 15 : 1 }, (_, i) => user(20000 + i)), cookie: page.length === 1 ? 'next' : '', isFirstPage: page.length === 1, isLastPage: page.length !== 1 }));
    await assert.rejects(repeated.action(), { code: 'INVALID_RESPONSE' }); assert.equal(repeated.calls.length, 2);
});
test('directory count, category or clicked-state changes during paging fail the whole summary', async () => {
    for (const changed of [[category('76', 15), category('128512', 1, '2')], [category('76', 16)],
        [{ ...category('76', 16), isClicked: true }, category('128512', 1, '2')]]) {
        const f = fixture(); f.records(index => index === 1 ? [category('76', 16), category('128512', 1, '2')] : changed);
        await assert.rejects(f.action(), { code: 'QUERY_FAILED' }); assert.equal(f.reads.length, 2);
    }
    const reordered = fixture(); reordered.records(index => index === 1 ? [category('76', 16), category('128512', 1, '2')] : [category('128512', 1, '2'), category('76', 16)]);
    assert.equal((await reordered.action()).complete, true);
});
test('summary account, message locator, capability and response metadata are independently checked', async () => {
    const f = fixture(); for (const params of [{ message_id: -12, self_id: '22222' }, { message_id: 0 }, { message_id: '01' }, { message_id: -12, cookie: 'unknown' }]) await assert.rejects(f.action(params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.action({ message_id: -13 }), { code: 'NOT_FOUND' }); f.state.capabilities.messageEmojiSummary = false; await assert.rejects(f.action(), { code: 'UNSUPPORTED' }); assert.equal(f.reads.length, 0);
    const g = fixture(); g.service.sessionCall = async () => ({ uin: '22222', ...input, summary: protocol.summary([]) }); await assert.rejects(g.action(), { code: 'INVALID_RESPONSE' });
    for (const value of [{ ...protocol.summary([]), complete: false }, { ...protocol.summary([]), last_reaction_time_available: true }, { ...protocol.summary([]), emoji_likes: new Array(1) }]) assert.throws(() => protocol.validateSummary(value), { code: 'INVALID_RESPONSE' });
    await assert.rejects(g.api.query({ ...input, peer: { chatType: 1, peerUid: 'u_other' }, expectedEpoch: 'e1' }), { code: 'UNSUPPORTED' });
});
test('cancelled summaries retain physical slots and stale sessions cannot emit results or start more pages', async () => {
    const f = fixture(), finish = [];
    f.records(() => new Promise(resolve => finish.push(resolve)));
    for (let i = 0; i < 2; i++) { const controller = new AbortController(), pending = f.query({ signal: controller.signal }), rejected = assert.rejects(pending, { code: 'EXPIRED' }); await tick(); controller.abort(); await rejected; }
    f.api.clear(); await assert.rejects(f.query(), { code: 'BUSY' }); assert.equal(f.calls.length, 0);
    for (const resolve of finish) resolve([]); await tick(); f.records(() => []); assert.equal((await f.query()).summary.complete, true);
    const g = fixture(); let release; g.records(() => new Promise(resolve => { release = resolve; })); const pending = g.query(), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' }); await tick();
    g.capture.self = { uin: '22222', uid: 'u_other' }; release([category('76', 16)]); await rejected; assert.equal(g.calls.length, 0);
});
