'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountQueries, validateProfileInfo } = require('../src/qq/account-queries.cjs');

function profile(uid = 'u_self') {
    return { uid, time: '1234567890', favoriteInfo: { userInfos: [], total_count: 4, last_time: 12, today_count: 1 },
        voteInfo: { userInfos: [{ uid: 'u_actual_voter', actual: true }], total_count: 700, new_count: 3, new_nearby_count: 2, last_visit_time: 123 } };
}
function fixture() {
    const calls = [], record = { chatType: 2, peerUid: '54321', msgId: '18446744073709551000', msgSeq: '18446744073709551001' };
    const capture = { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, ensureReady() {}, hasMethods: () => true,
        deadline: fn => Promise.resolve().then(fn),
        async getMessage(params) { calls.push({ locate: params }); return { ...record }; },
        async invoke(service, method, args) {
            calls.push({ service, method, args });
            return method === 'getBuddyProfileLike' ? { result: 0, info: { userLikeInfos: [profile(args[0].friendUids[0])] } } :
                { result: 0, emojiLikesList: [{ tinyId: '22222', nickName: '真实用户', headUrl: 'https://example.invalid/avatar' }], cookie: '', isFirstPage: true, isLastPage: true };
        } };
    const api = createAccountQueries(capture);
    return { capture, api, calls, record, run: (params, context = {}) => api.query({ ...params, expectedEpoch: 'e1' }, context),
        emoji: { operation: 'message.emojiLikes', peer: { chatType: 2, peerUid: record.peerUid }, nativeId: record.msgId, sequence: record.msgSeq, emojiId: '76', emojiType: '1' } };
}

test('profile-like reads use the exact fixed native contract and preserve genuine counts and voter fields', async () => {
    const f = fixture(), result = await f.run({ operation: 'profile.likes', uid: 'u_self' });
    assert.deepEqual(f.calls[0], { service: 'profileLike', method: 'getBuddyProfileLike', args: [{ friendUids: ['u_self'], basic: 1, vote: 1, favorite: 0, userProfile: 1, type: 2, start: 0, limit: 10 }] });
    assert.deepEqual(result.profile, profile());
    await f.run({ operation: 'profile.likes', uid: 'u_friend', start: '20', count: '5' });
    assert.equal(f.calls[1].args[0].type, 1); assert.equal(f.calls[1].args[0].start, 20); assert.equal(f.calls[1].args[0].limit, 5);
});

test('profile-like reads require explicit result zero and exactly one matching UID without filling missing counters', async () => {
    const f = fixture(), target = profile();
    for (const response of [undefined, { info: { userLikeInfos: [target] } }, { result: 7 }, { result: 0, errCode: 7, info: { userLikeInfos: [target] } },
        { result: 0, info: { userLikeInfos: [profile('u_other')] } }, { result: 0, info: { userLikeInfos: [target, target] } },
        { result: 0, info: { userLikeInfos: [{ ...target, voteInfo: { userInfos: [] } }] } }]) {
        f.capture.invoke = async () => response;
        await assert.rejects(f.run({ operation: 'profile.likes', uid: 'u_self' }), error => ['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));
    }
});

test('profile-like timestamps preserve both observed Linux numbers and exact decimal-string variants', async () => {
    const f = fixture();
    for (const time of [0, 1794815014, Number.MAX_SAFE_INTEGER, '0', '18446744073709551615']) {
        f.capture.invoke = async () => ({ result: 0, info: { userLikeInfos: [{ ...profile(), time }] } });
        const response = await f.run({ operation: 'profile.likes', uid: 'u_self' });
        assert.equal(response.profile.time, time);
    }
    for (const time of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, true, null, {}, '', '01', '-1', '18446744073709551616']) {
        f.capture.invoke = async () => ({ result: 0, info: { userLikeInfos: [{ ...profile(), time }] } });
        await assert.rejects(f.run({ operation: 'profile.likes', uid: 'u_self' }), { code: 'INVALID_RESPONSE' });
    }
});

test('reaction reads refresh the exact 64-bit message locator then call the seven-argument false-direction page contract', async () => {
    const f = fixture(), response = await f.run(f.emoji);
    assert.equal(f.calls[0].locate.nativeId, f.record.msgId);
    assert.deepEqual(f.calls[1].args, [{ chatType: 2, peerUid: '54321', guildId: '' }, f.record.msgSeq, '76', '1', '', false, 15]);
    assert.equal(response.users[0].tinyId, '22222'); assert.equal(response.isLastPage, true);
    f.record.msgSeq = '99';
    await assert.rejects(f.run(f.emoji), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.filter(call => call.method === 'getMsgEmojiLikesList').length, 1);
});

test('all account query inputs and method gates are checked before any lookup or native request', async () => {
    const f = fixture();
    for (const data of [{ operation: 'profile.likes', uid: 'u_self', count: 0 }, { operation: 'profile.likes', uid: 'u_self', start: -1 },
        { operation: 'profile.likes', uid: 'u_self', count: null }, { operation: 'profile.likes', uid: 'u_self', start: null },
        { operation: 'profile.likes', uid: '12345' }, { operation: 'profile.likes', uid: 'u_self', code: 'arbitrary' },
        { ...f.emoji, emojiType: 1 }, { ...f.emoji, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...f.emoji, cookie: '\0' }, { ...f.emoji, cookie: null }, { ...f.emoji, emojiId: '-1' }]) {
        await assert.rejects(f.run(data), { code: 'INVALID_PARAMS' });
    }
    f.capture.hasMethods = () => false;
    assert.deepEqual(f.api.capabilities(), { profileLikeRead: false, messageEmojiLikes: false });
    await assert.rejects(f.run(f.emoji), { code: 'UNSUPPORTED' });
    await assert.rejects(f.run({ operation: 'profile.likes', uid: 'u_self' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('reaction pages reject ambiguous status, malformed users and absent or nonadvancing pagination', async () => {
    const f = fixture(), good = { result: 0, emojiLikesList: [{ tinyId: '22222', nickName: '', headUrl: '' }], cookie: 'next', isFirstPage: true, isLastPage: false };
    for (const response of [{ ...good, result: true }, { ...good, emojiLikesList: Array(16).fill(good.emojiLikesList[0]) },
        { ...good, emojiLikesList: [{ tinyId: '22222', nickName: null, headUrl: '' }] }, { ...good, cookie: '' },
        { ...good, isLastPage: undefined }, { ...good, isFirstPage: false }]) {
        f.capture.invoke = async () => response;
        await assert.rejects(f.run(f.emoji), { code: 'INVALID_RESPONSE' });
    }
});

test('expired, aborted and changed sessions discard query results and never dispatch after a stale locator lookup', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    await assert.rejects(f.run(f.emoji, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.run(f.emoji, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    await assert.rejects(f.api.query({ ...f.emoji, expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.length, 0);
    f.capture.getMessage = async () => { f.capture.epoch = 'e2'; return f.record; };
    await assert.rejects(f.run(f.emoji), { code: 'SESSION_CHANGED' }); assert.equal(f.calls.length, 0);
    const g = fixture(); g.capture.invoke = async () => { g.capture.self = { uin: '99999', uid: 'u_other' }; return { result: 0, info: { userLikeInfos: [profile()] } }; };
    await assert.rejects(g.run({ operation: 'profile.likes', uid: 'u_self' }), { code: 'SESSION_CHANGED' });
});

test('native account-query budget remains occupied after caller timeouts until the native promise actually settles', async () => {
    const f = fixture(), complete = [], timeouts = [];
    f.capture.invoke = () => new Promise(resolve => complete.push(resolve));
    f.capture.deadline = operation => { const native = operation(); return Promise.race([native, new Promise((_, reject) => timeouts.push(() => reject(Object.assign(new Error('Caller timeout'), { code: 'TIMEOUT' }))))]); };
    const requests = Array.from({ length: 4 }, () => f.run({ operation: 'profile.likes', uid: 'u_self' }));
    await new Promise(resolve => setImmediate(resolve));
    for (const timeout of timeouts) timeout();
    for (const request of requests) await assert.rejects(request, { code: 'TIMEOUT' });
    await assert.rejects(f.run({ operation: 'profile.likes', uid: 'u_self' }), { code: 'BUSY' });
    assert.equal(complete.length, 4);
    complete[0]({ result: 0, info: { userLikeInfos: [profile()] } }); await new Promise(resolve => setImmediate(resolve));
    f.capture.deadline = fn => fn();
    f.capture.invoke = async () => ({ result: 0, info: { userLikeInfos: [profile()] } });
    assert.equal((await f.run({ operation: 'profile.likes', uid: 'u_self' })).profile.uid, 'u_self');
    for (const resolve of complete.slice(1)) resolve({ result: 0, info: { userLikeInfos: [profile()] } });
    await new Promise(resolve => setImmediate(resolve));
});

test('session changes cannot reset physical native slots or admit old results into the new account session', async () => {
    const f = fixture(), complete = [];
    f.capture.invoke = () => new Promise(resolve => complete.push(resolve));
    const requests = Array.from({ length: 4 }, () => f.run({ operation: 'profile.likes', uid: 'u_self' }));
    const results = Promise.allSettled(requests);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(complete.length, 4);
    for (const epoch of ['e2', 'e3', 'e4']) {
        f.capture.epoch = epoch; f.capture.session = {};
        assert.deepEqual(f.api.capabilities(), { profileLikeRead: true, messageEmojiLikes: true });
        await assert.rejects(f.api.query({ operation: 'profile.likes', uid: 'u_self', expectedEpoch: epoch }), { code: 'BUSY' });
        assert.equal(complete.length, 4);
    }
    complete[0]({ result: 0, info: { userLikeInfos: [profile()] } });
    await assert.rejects(requests[0], { code: 'SESSION_CHANGED' });
    await new Promise(resolve => setImmediate(resolve));
    const fresh = { ...profile(), time: 1794815014 };
    f.capture.invoke = async () => ({ result: 0, info: { userLikeInfos: [fresh] } });
    const next = await f.api.query({ operation: 'profile.likes', uid: 'u_self', expectedEpoch: 'e4' });
    assert.deepEqual(next.profile, fresh);
    for (const resolve of complete.slice(1)) resolve({ result: 0, info: { userLikeInfos: [profile()] } });
    assert.ok((await results).every(value => value.status === 'rejected' && value.reason.code === 'SESSION_CHANGED'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await f.api.query({ operation: 'profile.likes', uid: 'u_self', expectedEpoch: 'e4' })).profile, fresh);
});

test('profile JSON budgets reject repeated large strings, deep data, cycles and sparse arrays before serialization', () => {
    const large = profile(); large.voteInfo.userInfos = Array(1000).fill({ value: 'x'.repeat(64 * 1024) });
    assert.throws(() => validateProfileInfo(large, 'u_self'), { code: 'INVALID_RESPONSE' });
    const deep = profile(); let child = deep;
    for (let i = 0; i < 40; i++) { child.child = {}; child = child.child; }
    assert.throws(() => validateProfileInfo(deep, 'u_self'), { code: 'INVALID_RESPONSE' });
    const cyclic = profile(); cyclic.self = cyclic;
    assert.throws(() => validateProfileInfo(cyclic, 'u_self'), { code: 'INVALID_RESPONSE' });
    const sparse = profile(); sparse.voteInfo.userInfos = Array(3);
    assert.throws(() => validateProfileInfo(sparse, 'u_self'), { code: 'INVALID_RESPONSE' });
    const missing = profile(); delete missing.voteInfo.new_count;
    assert.throws(() => validateProfileInfo(missing, 'u_self'), error => error.code === 'INVALID_RESPONSE' && error.message.includes('voteInfo.new_count'));
    const nonplain = profile(); nonplain.nativeMap = new Map([['a', 1]]);
    assert.throws(() => validateProfileInfo(nonplain, 'u_self'), { code: 'INVALID_RESPONSE' });
});

test('reaction message locator queries share the physical pending budget and return no chat body', async () => {
    const f = fixture(), complete = [];
    f.capture.getMessage = () => new Promise(resolve => complete.push(resolve));
    f.capture.deadline = operation => { operation(); return Promise.reject(Object.assign(new Error('Timed out'), { code: 'TIMEOUT' })); };
    const request = { operation: 'message.locate', peer: f.emoji.peer, nativeId: f.emoji.nativeId, sequence: f.emoji.sequence };
    for (let i = 0; i < 4; i++) await assert.rejects(f.run(request), { code: 'TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(complete.length, 4); await assert.rejects(f.run(request), { code: 'BUSY' });
    for (const resolve of complete) resolve({ ...f.record, elements: [{ privateBody: 'do not return' }] });
    await new Promise(resolve => setImmediate(resolve));
    f.capture.deadline = operation => operation(); f.capture.getMessage = async () => ({ ...f.record, elements: ['private'] });
    assert.deepEqual(await f.run(request), request);
});

module.exports = { profile };
