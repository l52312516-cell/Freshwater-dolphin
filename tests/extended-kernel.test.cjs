'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtended } = require('../src/qq/extended.cjs');
function fixture() {
    const calls = [], record = { chatType: 2, peerUid: '2000000001', msgId: '18446744073709551000', msgSeq: '77', msgRandom: '0' };
    let buddy = true, category = 0;
    const capture = { epoch: 'e1', self: { uin: '12345', uid: 'u_self' }, session: {},
        ensureReady() {}, hasMethods() { return true; }, deadline(fn) { return Promise.resolve().then(fn); },
        async resolve({ uid }) { return { uid, uin: '54321' }; }, async getMessage() { return { ...record }; },
        async user({ uid }) { return { uid, category_id: category }; },
        invoke(service, method, args) {
            calls.push({ service, method, args });
            if (method === 'isBuddy') return buddy;
            if (method === 'delBuddy') { buddy = false; return Promise.resolve(); }
            return Promise.resolve({ result: 0 });
        } };
    const native = { available: () => true, async run(_capture, params) {
        calls.push({ native: params.operation, request: params.request });
        if (params.operation === 'friend.category') category = params.request.categoryId;
        return { ...params.request, confirmed: true, confirmation: 'server_ack' };
    } };
    const api = createExtended(capture, { native });
    return { capture, api, calls, record, run: data => api.action({ ...data, expectedEpoch: 'e1' }) };
}

test('extended poke resolves a real UID and reports exactly the acknowledged target', async () => {
    const f = fixture();
    const request = { operation: 'message.poke', peer: { chatType: 2, peerUid: '2000000001' }, targetUid: 'u_friend', targetUin: '54321' };
    const result = await f.run(request);
    assert.equal(result.operation, request.operation); assert.equal(result.targetUid, request.targetUid);
    assert.equal(f.calls[0].request.targetUin, '54321');
    await assert.rejects(f.run({ ...request, targetUin: '99999' }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 1);
});

test('private poke resolves peer and target independently, including self and third-party real targets', async () => {
    for (const [targetUid, targetUin] of [['u_self', '12345'], ['u_third', '67890'], ['u_friend', '54321']]) {
        const f = fixture(), resolutions = [];
        const ids = { u_self: '12345', u_friend: '54321', u_third: '67890' };
        f.capture.resolve = async ({ uid }) => { resolutions.push(uid); return { uid, uin: ids[uid] }; };
        const result = await f.run({ operation: 'message.poke', peer: { chatType: 1, peerUid: 'u_friend' }, peerUin: '54321', targetUid, targetUin });
        assert.deepEqual(f.calls[0].request, { chatType: 1, peerUin: '54321', targetUin });
        assert.equal(result.peerUin, '54321'); assert.equal(result.targetUin, targetUin);
        assert.deepEqual(result.peer, { chatType: 1, peerUid: 'u_friend' }); assert.equal(result.targetUid, targetUid);
        assert.deepEqual(new Set(resolutions), new Set(['u_friend', targetUid]));
        assert.equal(f.calls.length, 1); assert.equal(result.confirmation, 'server_ack');
    }
});

test('private poke rejects mismapped peer, target, self and identity collisions without a native dispatch', async () => {
    const base = { operation: 'message.poke', peer: { chatType: 1, peerUid: 'u_friend' }, peerUin: '54321', targetUid: 'u_self', targetUin: '12345' };
    for (const [request, ids] of [[{ ...base, peerUin: '99999' }, { u_friend: '54321', u_self: '12345' }],
        [{ ...base, targetUin: '99999' }, { u_friend: '54321', u_self: '12345' }],
        [base, { u_friend: '12345', u_self: '12345' }], [base, { u_friend: '54321', u_self: '77777' }],
        [{ ...base, targetUid: 'u_third', targetUin: '54321' }, { u_friend: '54321', u_third: '54321' }]]) {
        const f = fixture(); f.capture.resolve = async ({ uid }) => ({ uid, uin: ids[uid] });
        await assert.rejects(f.run(request), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 0);
    }
    for (const invalid of [{ peerUin: null }, { targetUin: null }, { peerUin: '0' }, { targetUin: '0' }, { targetUid: 'made-up' }]) {
        const f = fixture(); let resolves = 0; f.capture.resolve = async () => { resolves++; throw new Error('must validate first'); };
        await assert.rejects(f.run({ ...base, ...invalid }), { code: 'INVALID_PARAMS' });
        assert.equal(resolves, 0); assert.equal(f.calls.length, 0);
    }
    for (const bad of [null, { uid: 'u_wrong', uin: '54321' }, { uid: 'u_friend', uin: '0' },
        { uid: 'u_friend', uin: '4294967296' }]) {
        const f = fixture(); f.capture.resolve = async () => bad;
        await assert.rejects(f.run(base), { code: 'INVALID_RESPONSE' }); assert.equal(f.calls.length, 0);
    }
});

test('private poke binds both identity lookups to the same session and does not resend native failures', async () => {
    const base = { operation: 'message.poke', peer: { chatType: 1, peerUid: 'u_friend' }, peerUin: '54321', targetUid: 'u_self', targetUin: '12345' };
    for (const changeAfter of [1, 2]) for (const change of ['epoch', 'session', 'selfUin', 'selfUid']) {
        const f = fixture(); let resolves = 0;
        f.capture.resolve = async ({ uid }) => {
            if (++resolves === changeAfter) {
                if (change === 'epoch') f.capture.epoch = 'e2';
                else if (change === 'session') f.capture.session = {};
                else if (change === 'selfUin') f.capture.self = { ...f.capture.self, uin: '99999' };
                else f.capture.self = { ...f.capture.self, uid: 'u_other_self' };
            }
            return { uid, uin: uid === 'u_self' ? '12345' : '54321' };
        };
        await assert.rejects(f.run(base), { code: 'SESSION_CHANGED' }); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); let writes = 0;
    f.capture.resolve = async ({ uid }) => ({ uid, uin: uid === 'u_self' ? '12345' : '54321' });
    const api = createExtended(f.capture, { native: { available: () => true, async run() { writes++; throw Object.assign(new Error('ambiguous'), { code: 'TIMEOUT' }); } } });
    await assert.rejects(api.action({ ...base, expectedEpoch: 'e1' }), { code: 'TIMEOUT' }); assert.equal(writes, 1);
});

test('message reaction and essence re-read exact 64-bit locators and never guess a random', async () => {
    const f = fixture(), base = { groupId: f.record.peerUid, nativeId: f.record.msgId, sequence: '77', set: true };
    const result = await f.run({ operation: 'group.essence', ...base, random: '0' });
    assert.equal(result.random, '0'); assert.equal(result.nativeId, f.record.msgId);
    f.record.msgRandom = undefined;
    await assert.rejects(f.run({ operation: 'group.essence', ...base, random: '0' }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(f.run({ operation: 'message.emoji', ...base, peer: { chatType: 2, peerUid: base.groupId }, sequence: '78', emojiId: '66' }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 1, 'failed locator checks never dispatch QQ');
});

test('friend category confirms the real profile and friend deletion confirms absence', async () => {
    const f = fixture();
    assert.equal((await f.run({ operation: 'friend.category', uid: 'u_friend', categoryId: 3 })).confirmation, 'profile_readback');
    assert.equal((await f.run({ operation: 'friend.delete', uid: 'u_friend' })).confirmation, 'friend_absence');
    await assert.rejects(f.run({ operation: 'friend.delete', uid: 'u_friend' }), { code: 'NOT_FOUND' });
    assert.equal(f.calls.filter(call => call.method === 'delBuddy').length, 1);
});

test('native failure and ambiguous status completion are errors, and sessions cannot be selected through params', async () => {
    const f = fixture();
    f.capture.invoke = () => undefined;
    await assert.rejects(f.run({ operation: 'self.status', status: 10, extStatus: 0, batteryStatus: 0 }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(f.api.action({ operation: 'self.status', status: 10, extStatus: 0, batteryStatus: 0, expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.run({ operation: 'self.status', status: 10, extStatus: 0, batteryStatus: 0, code: 'arbitrary' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.api.query({ operation: 'friend.delete', expectedEpoch: 'e1', uid: 'u_friend' }), { code: 'UNSUPPORTED' });
    await assert.rejects(f.run({ operation: 'self.avatar', file: 'C:/secret.png' }), { code: 'INVALID_PARAMS' });
});

test('an expired or changed session never dispatches a queued extended operation', async () => {
    const f = fixture(), controller = new AbortController();
    controller.abort();
    await assert.rejects(f.api.action({ operation: 'self.status', status: 10, extStatus: 0, batteryStatus: 0, expectedEpoch: 'e1' }, { signal: controller.signal }), { code: 'EXPIRED' });
    assert.equal(f.calls.length, 0);
});

test('reaction success requires the exact original message and this account clicked state', async () => {
    for (const set of [true, false]) {
        const f = fixture(), base = { operation: 'message.emoji', groupId: f.record.peerUid, nativeId: f.record.msgId,
            sequence: '77', emojiId: '76', set };
        let reads = 0;
        f.capture.getMessage = async () => ({ ...f.record, emojiLikesList: ++reads === 1 ? [] :
            set ? [{ emojiId: '76', emojiType: '1', likesCnt: '1', isClicked: true }] : [] });
        assert.equal((await f.run(base)).confirmation, 'message_readback');
        assert.equal(reads, 2);
        assert.equal(f.calls.filter(call => call.native === 'message.emoji').length, 1);
    }
    const other = fixture();
    other.capture.getMessage = async () => ({ ...other.record, emojiLikesList: [{ emojiId: '76', emojiType: '1', likesCnt: '3', isClicked: false }] });
    assert.equal((await other.run({ operation: 'message.emoji', groupId: other.record.peerUid, nativeId: other.record.msgId,
        sequence: '77', emojiId: '76', set: false })).confirmed, true, 'other users reactions do not count as our own click');
});

test('ambiguous reaction metadata, wrong identities and stale state never turn an ACK into success or resend', async () => {
    const row = { emojiId: '76', emojiType: '1', likesCnt: '1', isClicked: true };
    for (const observed of [undefined, [row, row], [{ ...row, isClicked: 'true' }], [{ ...row, likesCnt: '0' }]]) {
        const f = fixture(); f.record.emojiLikesList = observed;
        await assert.rejects(f.run({ operation: 'message.emoji', groupId: f.record.peerUid, nativeId: f.record.msgId,
            sequence: '77', emojiId: '76', set: true }), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.filter(call => call.native === 'message.emoji').length, 1);
    }
    const wrong = fixture(); let reads = 0;
    wrong.capture.getMessage = async () => ({ ...wrong.record, ...(++reads > 1 ? { peerUid: '99999' } : {}), emojiLikesList: [row] });
    await assert.rejects(wrong.run({ operation: 'message.emoji', groupId: wrong.record.peerUid, nativeId: wrong.record.msgId,
        sequence: '77', emojiId: '76', set: true }), { code: 'INVALID_RESPONSE' });
    const stale = fixture(); stale.record.emojiLikesList = [];
    await assert.rejects(stale.api.action({ operation: 'message.emoji', groupId: stale.record.peerUid, nativeId: stale.record.msgId,
        sequence: '77', emojiId: '76', set: true, expectedEpoch: 'e1' }, { expiresAt: Date.now() + 25 }), error => ['EXPIRED', 'TIMEOUT'].includes(error.code));
    assert.equal(stale.calls.filter(call => call.native === 'message.emoji').length, 1);
});
