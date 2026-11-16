'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createSocial } = require('../src/qq/social.cjs');
const { runSocial, convertSocialEvent } = require('../src/onebot/social-actions.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

function fixture(overrides = {}, options = {}) {
    const capture = new Capture({ install: false });
    capture.epoch = 'one'; capture.ready = true; capture.readyAt = Date.now() - 1000;
    capture.qqVersion = '3.2.35-54395'; capture.self = { uin: '1000000001', uid: 'u_self' };
    const services = { buddy: {}, group: {}, profile: {}, recent: {}, msg: {}, ...overrides };
    const getters = { buddy: 'getBuddyService', group: 'getGroupService', profile: 'getProfileService', recent: 'getRecentContactService', msg: 'getMsgService' };
    capture.session = Object.fromEntries(Object.entries(getters).map(([name, getter]) => [getter, () => services[name]]));
    // The new social module can also be exercised against Capture versions
    // before its small service/listener integration is applied.
    capture.service = name => { capture.ensureReady(); return services[name]; };
    capture.registrations = [{ name: 'buddy' }, { name: 'group' }];
    capture.remember('1000000003', 'u_friend');
    const events = []; const diagnostics = [];
    capture.on('event', event => events.push(event)); capture.diagnostic = error => diagnostics.push(error.code);
    const social = createSocial(capture, options);
    capture.social = social;
    return { capture, social, services, events, diagnostics };
}
function friend(extra = {}) {
    return { friendUid: 'u_friend', reqTime: String(Math.floor(Date.now() / 1000)), reqType: 1,
        isDecide: false, isUnread: true, isInitiator: false, extWords: 'hello\nworld', ...extra };
}
function group(extra = {}) {
    return { seq: '9007199254740993123456', type: 7, status: 1,
        group: { groupCode: '12345678', groupName: 'Group' }, user1: { uid: 'u_friend' }, user2: { uid: 'u_inviter' },
        actionTime: String(Math.floor(Date.now() / 1000)), postscript: 'join\nplease', ...extra };
}
function observeFriend(f, value = friend()) { f.social.listenerMethods.buddy.onBuddyReqChange({ buddyReqs: [value] }); return value; }
function observeGroup(f, value = group(), doubt = false) { f.social.listenerMethods.group.onGroupNotifiesUpdated(doubt, [value]); return value; }
// Success cases must tolerate process scheduling on the small cloud host.
// Deadline-specific cases below still pass their explicit short deadlines.
function limit(ms = 1000) { return { expiresAt: Date.now() + ms }; }

test('friend request callbacks deduplicate native identity, retain comments and exclude old/self/doubt requests', () => {
    const f = fixture(); const record = observeFriend(f);
    observeFriend(f, record);
    observeFriend(f, friend({ friendUid: 'u_other', reqTime: '1700000000' }));
    observeFriend(f, friend({ friendUid: 'u_self', isInitiator: true }));
    observeFriend(f, friend({ friendUid: 'u_doubt', isDoubt: true }));
    observeFriend(f, friend({ friendUid: 'u_read', isUnread: false }));
    assert.equal(f.events.length, 1); assert.equal(f.events[0].request.comment, 'hello\nworld');
    assert.match(f.events[0].request.flag, /^fwd_req_[a-f0-9]{48}$/);
});

test('friend approval waiter observes a synchronous callback and consumes opaque flag once', async () => {
    const f = fixture(); const record = observeFriend(f); const flag = f.events[0].request.flag;
    let calls = 0;
    f.services.buddy.approvalFriendRequest = async args => {
        calls++; assert.deepEqual(args, { friendUid: 'u_friend', reqTime: record.reqTime, accept: true });
        observeFriend(f, { ...record, reqType: 3, isDecide: true });
    };
    assert.deepEqual(await f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { handled: true });
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'BUSY' });
    assert.equal(calls, 1);
});

test('a void native approval without matching callback times out and cannot be retried automatically', async () => {
    const f = fixture(); observeFriend(f); const flag = f.events[0].request.flag;
    f.services.buddy.approvalFriendRequest = async () => {};
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit(20)), { code: 'TIMEOUT' });
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'BUSY' });
    assert.equal(f.capture.bus.listenerCount('social:friend'), 0);
});

test('unrelated request callback and opposite friend outcome cannot prove success', async () => {
    const f = fixture(); const record = observeFriend(f); const flag = f.events[0].request.flag;
    f.services.buddy.approvalFriendRequest = async () => {
        observeFriend(f, { ...record, friendUid: 'u_other', reqType: 3, isDecide: true });
        observeFriend(f, { ...record, reqType: 7, isDecide: true });
    };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'KERNEL_ERROR' });
});

test('group request matches doubt, exact long native seq, group, type and confirmed outcome', async () => {
    const f = fixture(); const record = observeGroup(f, group(), true); const flag = f.events[0].request.flag;
    f.services.group.operateSysNotify = async (doubt, args) => {
        assert.equal(doubt, true);
        assert.deepEqual(args, { operateType: 2, targetMsg: { seq: '9007199254740993123456', type: 7, groupCode: '12345678', postscript: 'reason' } });
        observeGroup(f, { ...record, seq: '9007199254740993123457', status: 3 }, true);
        observeGroup(f, { ...record, status: 3 }, false);
        observeGroup(f, { ...record, status: 3 }, true);
    };
    assert.deepEqual(await f.social.action({ operation: 'groupRequest', subType: 'add', flag, approve: false, reason: 'reason' }, limit()), { handled: true });
});

test('group invite takes inviter UID and refuses unsupported type and absent real timestamp', () => {
    const f = fixture(); observeGroup(f, group({ type: 1 }));
    observeGroup(f, group({ type: 5, seq: '55' }));
    observeGroup(f, group({ seq: '56', actionTime: '' }));
    assert.equal(f.events.length, 1); assert.equal(f.events[0].request.uid, 'u_inviter');
    assert.equal(f.events[0].request.subType, 'invite');
});

test('flags bind QQ epoch and request type, and reset removes previous session handles', async () => {
    const f = fixture(); observeFriend(f); const flag = f.events[0].request.flag;
    await assert.rejects(f.social.action({ operation: 'groupRequest', flag, subType: 'add', approve: true }), { code: 'INVALID_PARAMS' });
    f.capture.epoch = 'two';
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }), { code: 'NOT_FOUND' });
});

test('request queue is bounded and expired handles do not remain valid', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const f = fixture({}, { maximumRequests: 1, requestTtlMs: 10 });
    t.after(() => f.capture.close());
    const original = observeFriend(f);
    const flag = f.events[0].request.flag;
    observeFriend(f, friend({ friendUid: 'u_other' }));
    assert.equal(f.events.length, 1); assert.ok(f.diagnostics.includes('BUSY'));
    t.mock.timers.tick(15);
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }), { code: 'NOT_FOUND' });
    // Replay the same native request; generating a new timestamp here makes
    // this a different valid request when the wall clock crosses a second.
    observeFriend(f, original);
    assert.equal(f.events.length, 1, 'an expired native request must not mint another flag or event');
});

test('approval with an unavailable remark setter fails before processing the request', async () => {
    const f = fixture(); observeFriend(f); let calls = 0;
    f.services.buddy.approvalFriendRequest = async () => { calls++; };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag: f.events[0].request.flag,
        approve: true, remark: 'new' }), { code: 'UNSUPPORTED' });
    assert.equal(calls, 0);
});

test('epoch switch during a pending native operation rejects its late completion', async () => {
    const f = fixture(); const record = observeFriend(f);
    f.services.buddy.approvalFriendRequest = async () => {
        f.capture.epoch = 'two'; f.capture.rejectPending(Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }));
        observeFriend(f, { ...record, reqType: 3, isDecide: true });
    };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag: f.events[0].request.flag,
        approve: true }, limit()), { code: 'SESSION_CHANGED' });
    assert.equal(f.capture.bus.listenerCount('social:friend'), 0);
});

test('query requires real callback rather than a successful request return and exposes historical pending flags without events', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const f = fixture(); t.after(() => f.capture.close());
    let requested, reads = 0;
    const entered = new Promise(resolve => { requested = resolve; });
    f.services.buddy.approvalFriendRequest = async () => {};
    f.services.buddy.getBuddyReq = async () => { reads++; requested(); return { result: 0 }; };
    const pending = f.social.query({ operation: 'friendRequests' }, limit(20));
    const rejected = assert.rejects(pending, { code: 'TIMEOUT' });
    await entered; await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(20); await rejected;
    assert.equal(reads, 1); assert.equal(f.capture.bus.listenerCount('social:friend'), 0);
    assert.equal(f.capture.pending.size, 0);
    f.services.buddy.getBuddyReq = async () => { observeFriend(f, friend({ reqTime: '1700000000' })); return { result: 0 }; };
    const rows = await f.social.query({ operation: 'friendRequests' }, limit());
    assert.equal(rows.length, 1); assert.match(rows[0].flag, /^fwd_req_/); assert.equal(f.events.length, 0);
});

test('friend remark requires read-back of the exact verified identity and value', async () => {
    const f = fixture(); let args;
    f.services.buddy.setBuddyRemark = value => { args = value; };
    f.services.profile.getCoreAndBaseInfo = () => new Map([['u_friend', { uid: 'u_friend', uin: '1000000003', coreInfo: { remark: 'old' } }]]);
    await assert.rejects(f.social.action({ operation: 'remark', uin: '1000000003', remark: 'new' }), { code: 'KERNEL_ERROR' });
    f.services.profile.getCoreAndBaseInfo = () => new Map([['u_friend', { uid: 'u_friend', uin: '1000000003', coreInfo: { remark: 'new' } }]]);
    assert.deepEqual(await f.social.action({ operation: 'remark', uin: '1000000003', remark: 'new' }), { updated: true });
    assert.deepEqual(args, { uid: 'u_friend', remark: 'new' });
});

test('group request queries require screen responses and do not accept ordinary notification pushes', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    f.services.group.operateSysNotify = async () => {};
    f.services.group.getSingleScreenNotifies = async doubt => { observeGroup(f, group(), doubt); return { result: 0 }; };
    await assert.rejects(f.social.query({ operation: 'groupRequests' }, limit(30)), { code: 'TIMEOUT' });
    assert.equal(f.capture.bus.listenerCount('social:groupScreen'), 0);
    f.services.group.getSingleScreenNotifies = async doubt => {
        f.social.listenerMethods.group.onGroupSingleScreenNotifies(doubt, '', [group()]); return { result: 0 };
    };
    const rows = await f.social.query({ operation: 'groupRequests' }, limit(100));
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.doubt), [false, true]);
});

test('malformed request query callbacks fail instead of becoming an empty successful list', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    f.services.buddy.approvalFriendRequest = async () => {};
    f.services.buddy.getBuddyReq = async () => {
        f.social.listenerMethods.buddy.onBuddyReqChange({ buddyReqs: [friend({ reqTime: 9007199254740992 })] });
        return { result: 0 };
    };
    await assert.rejects(f.social.query({ operation: 'friendRequests' }, limit(100)), { code: 'INVALID_RESPONSE' });
    f.services.group.operateSysNotify = async () => {};
    f.services.group.getSingleScreenNotifies = async doubt => {
        f.social.listenerMethods.group.onGroupSingleScreenNotifies(doubt, '', [group({ seq: 9007199254740992 })]); return { result: 0 };
    };
    await assert.rejects(f.social.query({ operation: 'groupRequests' }, limit(100)), { code: 'INVALID_RESPONSE' });
});

test('categories return the real category IDs, names and verified friend profiles, rejecting incomplete results', async () => {
    const f = fixture();
    f.services.buddy.getBuddyListV2 = () => ({ result: 0, data: [{ categoryId: 3, categroyName: 'Friends', categroyMbCount: 1, buddyUids: ['u_friend'] }] });
    f.services.profile.getCoreAndBaseInfo = () => new Map();
    await assert.rejects(f.social.query({ operation: 'categories' }), { code: 'INVALID_RESPONSE' });
    f.services.profile.getCoreAndBaseInfo = () => new Map([['u_friend', { uid: 'u_friend', uin: '1000000003', coreInfo: { nick: 'Name' } }]]);
    const result = await f.social.query({ operation: 'categories' });
    assert.equal(result[0].categoryId, 3); assert.equal(result[0].buddyList[0].user_id, 1000000003);
});

test('mark read sends a real kernel UID and requires confirmed QQ result', async () => {
    const f = fixture(); let args;
    f.services.msg.setMsgRead = value => { args = value; return { result: 0 }; };
    assert.deepEqual(await f.social.action({ operation: 'read', peer: { chatType: 1, peerUid: 'u_friend' } }), { read: true });
    assert.deepEqual(args, { chatType: 1, peerUid: 'u_friend' });
    await assert.rejects(f.social.action({ operation: 'read', peer: { chatType: 1, peerUid: '1000000003' } }), { code: 'INVALID_PARAMS' });
    f.services.msg.setMsgRead = () => undefined;
    await assert.rejects(f.social.action({ operation: 'read', peer: { chatType: 2, peerUid: '12345678' } }), { code: 'KERNEL_ERROR' });
});

test('recent contacts preserve 64-bit native IDs internally and reject inconsistent UID/UIN mapping', async () => {
    const f = fixture();
    const row = { chatType: 1, peerUid: 'u_friend', peerUin: '1000000003', msgId: '9007199254740993123456', msgTime: String(Math.floor(Date.now() / 1000)), peerName: 'Friend' };
    f.services.recent.getRecentContactListSnapShot = () => ({ result: 0, info: { errCode: 0, changedList: [row] } });
    assert.equal((await f.social.query({ operation: 'recent' }))[0].nativeMsgId, row.msgId);
    row.peerUin = '3000000002';
    await assert.rejects(f.social.query({ operation: 'recent' }), { code: 'INVALID_RESPONSE' });
});

function onebotFixture() {
    const state = { epoch: 'one', self: { uin: '1000000001', uid: 'u_self' }, readyAt: Date.now() - 1000 };
    const calls = [];
    const service = { store: { get: () => undefined, find: () => undefined }, assertSession: async () => {},
        sessionCall: async (_state, method, params) => {
            calls.push({ method, params });
            if (method === 'resolve') return { uin: params.uin || '1000000003', uid: params.uid || 'u_friend' };
            if (method === 'socialAction') return { read: true, handled: true, updated: true };
            return [];
        } };
    return { service, state, calls };
}

test('OneBot validates booleans, subtype and opaque flags before any kernel side effect', async () => {
    const f = onebotFixture();
    await assert.rejects(runSocial(f.service, f.state, 'set_friend_add_request', { flag: '123', approve: true }), { code: 'INVALID_PARAMS' });
    await assert.rejects(runSocial(f.service, f.state, 'set_friend_add_request', { flag: 'fwd_req_' + 'a'.repeat(48), approve: 'false' }), { code: 'INVALID_PARAMS' });
    assert.equal(f.calls.length, 0);
    await runSocial(f.service, f.state, 'mark_private_msg_as_read', { user_id: 1000000003 });
    assert.deepEqual(f.calls[1].params, { operation: 'read', peer: { chatType: 1, peerUid: 'u_friend' } });
});

test('OneBot request events use real sender identity and session-bound opaque flags', async () => {
    const f = onebotFixture(); const event = { kind: 'request', epoch: 'one', selfUin: '1000000001', time: Math.floor(Date.now() / 1000),
        request: { type: 'group', subType: 'invite', groupId: '12345678', uid: 'u_friend', flag: 'fwd_req_' + 'a'.repeat(48), comment: 'space\nline' } };
    const result = await convertSocialEvent(f.service, f.state, event);
    assert.deepEqual(result, { time: event.time, self_id: 1000000001, post_type: 'request', request_type: 'group',
        sub_type: 'invite', group_id: 12345678, user_id: 1000000003, flag: event.request.flag, comment: 'space\nline' });
    assert.equal(await convertSocialEvent(f.service, f.state, { ...event, epoch: 'two' }), null);
});

test('OneBot recent contacts expose mapped message ID only and never a numeric native ID', async () => {
    const f = onebotFixture();
    f.service.sessionCall = async () => [{ chatType: 1, peerUid: 'u_friend', peerUin: '1000000003', nativeMsgId: '9007199254740993123456' }];
    assert.deepEqual(await runSocial(f.service, f.state, 'get_recent_contact', {}), [{ chatType: 1, peerUid: 'u_friend', peerUin: '1000000003' }]);
    f.service.store.find = () => ({ id: 101 });
    assert.equal((await runSocial(f.service, f.state, 'get_recent_contact', {}))[0].message_id, 101);
});

test('OneBot service and Capture fixed-method dispatch integrate request event and confirmed approval', async () => {
    const f = fixture(); const record = observeFriend(f);
    f.services.buddy.approvalFriendRequest = async () => { observeFriend(f, { ...record, reqType: 3, isDecide: true }); };
    const service = new OneBotService({ backend: { call: (method, params, options) => f.capture.call(method, params,
        { expiresAt: Date.now() + options.timeoutMs }) }, store: {}, actionTimeoutMs: 1000 });
    const event = await service.event(f.events[0]);
    assert.equal(event.post_type, 'request'); assert.equal(event.user_id, 1000000003);
    const response = await service.action({ action: 'set_friend_add_request', params: { flag: event.flag }, echo: false });
    assert.deepEqual(response, { status: 'ok', retcode: 0, data: null, echo: false });
});

test('native session observation registers social listeners and retired epoch callbacks cannot reappear', async t => {
    const listeners = {};
    const capture = new Capture({ install: false }); t.after(() => capture.close());
    const events = []; capture.on('event', event => { if (event.kind === 'request') events.push(event); });
    const record = friend();
    let completion;
    const registration = name => ({ ['addKernel' + name[0].toUpperCase() + name.slice(1) + 'Listener'](value) { listeners[name] = value; return 1; },
        ['removeKernel' + name[0].toUpperCase() + name.slice(1) + 'Listener']() {} });
    const buddy = { ...registration('buddy'),
        async getBuddyReq() { listeners.buddy.onBuddyReqChange({ buddyReqs: [record] }); return { result: 0 }; },
        async approvalFriendRequest() { listeners.buddy.onBuddyReqChange({ buddyReqs: [{ ...record, reqType: 3, isDecide: true }] }); } };
    const session = {
        init(_config, _depends, _dispatcher, handler) { completion = handler; },
        getMsgService: () => registration('msg'), getGroupService: () => registration('group'), getBuddyService: () => buddy,
        getProfileService: () => ({ ...registration('profile'), getUinByUid: (_source, values) => new Map(values.map(value => [value, '1000000003'])) })
    };
    capture.observeSession(session);
    const config = { selfUin: '1000000001', selfUid: 'u_self', clientVer: '3.2.35-54395' };
    session.init(config, {}, {}, { onSessionInitComplete() {} }); completion.onSessionInitComplete({ result: 0 });
    const state = await capture.call('status'); assert.equal(state.capabilities.friendRequests, true);
    const rows = await capture.call('socialQuery', { operation: 'friendRequests', expectedEpoch: state.epoch });
    assert.equal(rows.length, 1); assert.equal(events.length, 1);
    const service = new OneBotService({ backend: { call: (method, params, options) => capture.call(method, params,
        { expiresAt: Date.now() + options.timeoutMs }) }, store: {} });
    const event = await service.event(events[0]); assert.equal(event.user_id, 1000000003);
    assert.equal((await service.action({ action: 'set_friend_add_request', params: { flag: event.flag } })).status, 'ok');
    const retired = listeners.buddy;
    session.init(config, {}, {}, { onSessionInitComplete() {} }); completion.onSessionInitComplete({ result: 0 });
    retired.onBuddyReqChange({ buddyReqs: [{ ...record, reqTime: String(Number(record.reqTime) + 1) }] });
    assert.equal(events.length, 1);
});

test('a native UID lookup that finishes after cancellation cannot modify a friend remark', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    let release, changed = 0;
    f.capture.resolve = () => new Promise(resolve => { release = resolve; });
    f.services.buddy.setBuddyRemark = () => { changed++; };
    f.services.profile.getCoreAndBaseInfo = () => new Map();
    const pending = f.capture.call('socialAction', { operation: 'remark', uin: '1000000003', remark: 'Late', expectedEpoch: f.capture.epoch }, limit(20));
    await assert.rejects(pending, { code: 'TIMEOUT' });
    release({ uid: 'u_friend', uin: '1000000003' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changed, 0);
});

test('one request callback batch cannot select a successful first row over a conflicting outcome', async () => {
    const f = fixture(); const record = observeFriend(f); const flag = f.events[0].request.flag;
    f.services.buddy.approvalFriendRequest = () => {
        f.social.listenerMethods.buddy.onBuddyReqChange({ buddyReqs: [
            { ...record, reqType: 3, isDecide: true }, { ...record, reqType: 7, isDecide: true }
        ] });
    };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'KERNEL_ERROR' });
    const g = fixture(); const request = observeGroup(g); const groupFlag = g.events[0].request.flag;
    g.services.group.operateSysNotify = () => {
        g.social.listenerMethods.group.onGroupNotifiesUpdated(false, [
            { ...request, status: 2 }, { ...request, status: 3 }
        ]);
    };
    await assert.rejects(g.social.action({ operation: 'groupRequest', flag: groupFlag, subType: 'add', approve: true }, limit()), { code: 'KERNEL_ERROR' });
});

test('friend approval reads back the exact pending request after Promise<void> without replaying its mutation', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    const record = observeFriend(f), flag = f.events[0].request.flag;
    let writes = 0, reads = 0;
    f.services.buddy.approvalFriendRequest = async () => { writes++; };
    f.services.buddy.getBuddyReq = async () => {
        reads++; observeFriend(f, { ...record, reqType: 3, isDecide: true }); return { result: 0 };
    };
    assert.deepEqual(await f.social.action({ operation: 'friendRequest', flag, approve: true }, limit(100)), { handled: true });
    assert.equal(writes, 1); assert.equal(reads, 1);
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'BUSY' });
    assert.equal(writes, 1);
});

test('group approval reads back the original doubt inbox and exact outcome after Promise<void>', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    const record = observeGroup(f, group(), true), flag = f.events[0].request.flag;
    let writes = 0, reads = 0;
    f.services.group.operateSysNotify = async () => { writes++; };
    f.services.group.getSingleScreenNotifies = async (...args) => {
        reads++; assert.deepEqual(args, [true, '', 100]);
        f.social.listenerMethods.group.onGroupSingleScreenNotifies(true, '', [{ ...record, status: 2 }]);
        return { result: 0 };
    };
    assert.deepEqual(await f.social.action({ operation: 'groupRequest', flag, subType: 'add', approve: true }, limit(100)), { handled: true });
    assert.equal(writes, 1); assert.equal(reads, 1);
});

test('successful approval refresh without a matching decided record is still a timeout', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    const record = observeFriend(f), flag = f.events[0].request.flag;
    let writes = 0, reads = 0;
    f.services.buddy.approvalFriendRequest = async () => { writes++; };
    f.services.buddy.getBuddyReq = async () => { reads++; observeFriend(f, record); return { result: 0 }; };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit(20)), { code: 'TIMEOUT' });
    assert.equal(writes, 1); assert.equal(reads, 1);
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit()), { code: 'BUSY' });
    assert.equal(writes, 1);
});

test('an explicitly refused native approval does not refresh or masquerade as accepted', async t => {
    const f = fixture(); t.after(() => f.capture.close());
    const flag = (observeFriend(f), f.events[0].request.flag);
    let reads = 0;
    f.services.buddy.approvalFriendRequest = async () => ({ result: 120001 });
    f.services.buddy.getBuddyReq = async () => { reads++; return { result: 0 }; };
    await assert.rejects(f.social.action({ operation: 'friendRequest', flag, approve: true }, limit(100)), { code: 'KERNEL_ERROR' });
    assert.equal(reads, 0);
});

test('late approval completion after its deadline cannot issue a confirmation refresh', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const f = fixture(); t.after(() => f.capture.close());
    const flag = (observeFriend(f), f.events[0].request.flag);
    let release, began, reads = 0;
    const started = new Promise(resolve => { began = resolve; });
    f.services.buddy.approvalFriendRequest = () => { began(); return new Promise(resolve => { release = resolve; }); };
    f.services.buddy.getBuddyReq = async () => { reads++; return { result: 0 }; };
    const task = f.social.action({ operation: 'friendRequest', flag, approve: true }, limit(20));
    const rejected = assert.rejects(task, { code: 'TIMEOUT' });
    await started;
    t.mock.timers.tick(21);
    await rejected;
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0);
});
