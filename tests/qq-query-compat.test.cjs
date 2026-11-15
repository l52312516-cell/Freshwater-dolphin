'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

function fixture(t, response, query) {
    let listener;
    const group = {
        addKernelGroupListener(value) { listener = value; return 1; }, removeKernelGroupListener() {},
        getAllMemberList: async () => response,
        getMemberInfo: (code, uids, refresh) => query({ code, uids, refresh, listener })
    };
    const session = { getGroupService: () => group };
    const capture = new Capture({ install: false, processObject: { env: {} } }); t.after(() => capture.close());
    capture.resetSession(session, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION });
    capture.ready = true; capture.attach();
    return { capture, group, session };
}
const complete = (uid, extra = {}) => ({ uid, uin: uid.slice(2), nick: 'Member ' + uid, role: 2, ...extra });

test('complete member snapshots merge actual identity-array and detail-Map fields without dropping role or card', async t => {
    const f = fixture(t, { errCode: 0, result: { finish: true, ids: [{ uid: 'u_456', uin: '456', role: 4, cardName: 'Owner card' }],
        infos: new Map([['u_456', { uid: 'u_456', nick: 'Owner nickname', memberRealLevel: 18 }]]) } }, () => { throw new Error('Unexpected detail query'); });
    const values = await f.capture.call('groupMembers', { groupId: '200' });
    assert.equal(values[0].user_id, 456); assert.equal(values[0].role, 'owner');
    assert.equal(values[0].card, 'Owner card'); assert.equal(values[0].nickname, 'Owner nickname'); assert.equal(values[0].level, '18');
});

test('identity-only complete snapshots fetch genuine member callbacks in bounded batches and keep snapshot order', async t => {
    const ids = Array.from({ length: 121 }, (_, index) => 'u_' + (456 + index)), calls = [];
    const f = fixture(t, { errCode: 0, result: { finish: true, ids, infos: new Map() } }, ({ code, uids, refresh, listener }) => {
        calls.push([...uids]); assert.equal(code, '200'); assert.equal(refresh, true);
        assert.ok(f.capture.bus.listenerCount('groupMember') > 0);
        listener.onMemberInfoChange('201', 0, new Map(uids.map(uid => [uid, complete(uid, { nick: 'wrong group' })])));
        const middle = Math.ceil(uids.length / 2);
        listener.onMemberInfoChange(code, 0, new Map(uids.slice(middle).map(uid => [uid, complete(uid)])));
        listener.onMemberInfoChange(code, 0, new Map(uids.slice(0, middle).map(uid => [uid, complete(uid)])));
        return { result: 0 };
    });
    const members = await f.capture.call('groupMembers', { groupId: '200', refresh: true });
    assert.deepEqual(calls.map(batch => batch.length), [50, 50, 21]);
    assert.deepEqual(members.map(member => member.user_id), ids.map(uid => Number(uid.slice(2))));
    assert.equal(members[0].nickname, 'Member u_456'); assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
});

test('identity-only snapshots never become placeholder success when member callbacks omit records or real fields', async t => {
    for (const missingFields of [false, true]) {
        const f = fixture(t, { errCode: 0, result: { finish: true, ids: ['u_456', 'u_789'], infos: new Map() } }, ({ code, listener }) => {
            listener.onMemberInfoChange(code, 0, new Map([['u_456', complete('u_456')],
                ...(missingFields ? [['u_789', { uid: 'u_789' }]] : [])]));
            return { result: 0 };
        });
        await assert.rejects(f.capture.call('groupMembers', { groupId: '200' }, { expiresAt: Date.now() + 100 }), error =>
            missingFields ? ['INVALID_PARAMS', 'INVALID_RESPONSE'].includes(error.code) : error.code === 'TIMEOUT');
        assert.equal(f.capture.forward.has('456'), false); assert.equal(f.capture.forward.has('789'), false);
        assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
    }
});

test('incomplete snapshots, duplicate or foreign identities and mismatched member fields are rejected before cache updates', async t => {
    const responses = [
        { finish: false, ids: ['u_456'], infos: new Map() },
        { finish: true, ids: ['u_456', 'u_456'], infos: new Map() },
        { finish: true, ids: ['u_456'], infos: new Map([['u_789', complete('u_789')]]) },
        { finish: true, ids: ['u_456'], infos: new Map([['u_456', complete('u_789')]]) },
        { finish: true, ids: [{ uid: 'u_456', uin: '456' }], infos: new Map([['u_456', complete('u_456', { uin: '789' })]]) }
    ];
    for (const result of responses) {
        const f = fixture(t, { errCode: 0, result }, () => { throw new Error('Invalid snapshots must not query details'); });
        await assert.rejects(f.capture.call('groupMembers', { groupId: '200' }), { code: 'INVALID_RESPONSE' });
        assert.equal(f.capture.forward.has('456'), false); assert.equal(f.capture.forward.has('789'), false);
    }
});

test('switching sessions during supplementary member queries cannot write the old snapshot into the new account cache', async t => {
    let f;
    f = fixture(t, { errCode: 0, result: { finish: true, ids: ['u_456'], infos: new Map() } }, () => {
        f.capture.resetSession(f.session, { selfUin: '789', selfUid: 'u_789', clientVer: TARGET_VERSION });
        f.capture.ready = true; f.capture.attach();
        return { result: 0 };
    });
    await assert.rejects(f.capture.call('groupMembers', { groupId: '200' }), { code: 'SESSION_CHANGED' });
    assert.equal(f.capture.forward.has('456'), false); assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
});

test('a cached callback between waiter installation and native dispatch cannot confirm a query', async t => {
    const capture = new Capture({ install: false, processObject: { env: {} } }); t.after(() => capture.close());
    let calls = 0;
    const pending = capture.waiting('query-regression', value => value, () => {
        calls++; return { result: 0 };
    }, { expiresAt: Date.now() + 40 });
    capture.bus.emit('query-regression', 'stale snapshot');
    await assert.rejects(pending, { code: 'TIMEOUT' });
    assert.equal(calls, 1); assert.equal(capture.bus.listenerCount('query-regression'), 0);
    const current = await capture.waiting('query-regression', value => value, () => {
        capture.bus.emit('query-regression', 'current snapshot'); return { result: 0 };
    }, { expiresAt: Date.now() + 100 });
    assert.equal(current, 'current snapshot');
});

test('deleted member snapshots cannot confirm card changes and concurrent mutations do not share a confirmation', async t => {
    let calls = 0;
    const f = fixture(t, {}, ({ code, listener }) => {
        listener.onMemberInfoChange(code, 0, new Map([['u_456', complete('u_456', { cardName: 'New', isDelete: true })]]));
        return { result: 0 };
    });
    f.capture.remember('456', 'u_456');
    f.group.modifyMemberCardName = () => { calls++; };
    const params = { groupId: '200', uin: '456', operation: 'card', card: 'New', expectedEpoch: f.capture.epoch };
    const pending = f.capture.call('groupAction', params, { expiresAt: Date.now() + 60 });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.capture.call('groupAction', params), { code: 'BUSY' });
    await assert.rejects(pending, { code: 'TIMEOUT' });
    assert.equal(calls, 1); assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
    f.group.getMemberInfo = (code, uids) => {
        f.capture.bus.emit('groupMember', code, 0, new Map(uids.map(uid => [uid, complete(uid, { cardName: 'New' })])));
        return { result: 0 };
    };
    assert.deepEqual(await f.capture.call('groupAction', params), { confirmed: true });
    assert.equal(calls, 2);
});
