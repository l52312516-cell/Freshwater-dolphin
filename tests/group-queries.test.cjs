'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createGroupQueries, EXT_FILTER, MAX_MEMBERS, MAX_QUERIES, MAX_WAITERS } = require('../src/qq/group-queries.cjs');
const { ACTIONS, REQUIREMENTS, runGroupQueries } = require('../src/onebot/group-queries.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options) {
    const capture = new Capture({ install: false });
    capture.ready = true; capture.qqVersion = '3.2.35-54395'; capture.epoch = 'group-query-session';
    capture.self = { uin: '12345', uid: 'u_self' };
    capture.registrations.push({ name: 'group', service: {}, remove: 'none' });
    const api = createGroupQueries(capture, options), calls = [];
    const detail = (groupCode = '200') => ({ groupCode, groupName: '真实群', memberNum: 2, maxMemberNum: 200,
        remarkName: '群备注', shutUpAllTimestamp: 0, groupMemo: 'memo', groupExt: { luckyWord: 'word' } });
    const member = (uin = '22222') => ({ uid: 'u_' + uin, uin, nick: '成员', cardName: 'Card', role: 2, shutUpTime: 1900000000 });
    const emitDetail = value => capture.bus.emit('groupInfo', value);
    const emitMembers = (groupId, list) => capture.bus.emit('groupMember', groupId, 0, new Map(list.map(value => [value.uid, value])));
    const memberSnapshot = list => ({ errCode: 0, result: { finish: true, ids: list.map(value => value?.uid),
        infos: new Map(list.map(value => [value?.uid, value])) } });
    const methods = {
        getGroupDetailInfo(...args) { calls.push({ method: 'detail', args }); emitDetail(detail(args[0])); return { result: 0 }; },
        getGroupExt0xEF0Info(...args) { calls.push({ method: 'ext', args }); return { result: { groupExtInfos: new Map([[args[0][0], { groupInfoExtSeq: 9, luckyWord: '真实扩展' }]]) } }; },
        getAllMemberList(...args) { calls.push({ method: 'shut', args }); return memberSnapshot([member()]); },
        getMemberInfo(groupId, uids) { emitMembers(groupId, uids.map(uid => member(uid.slice(2)))); return { result: 0 }; },
        getGroupShutUpMemberList() { throw new Error('The unreliable dedicated mute-list callback must not be used'); }
    };
    capture.session = { getGroupService: () => methods };
    t.after(async () => { api.clear(); capture.close(); await tick(); });
    const query = (operation = 'group.detail', params = {}, context = {}) => api.dispatch(operation,
        { groupId: '200', expectedEpoch: capture.epoch, ...params }, context);
    return { capture, api, calls, methods, detail, member, emitDetail, emitMembers, memberSnapshot, query };
}

test('detail, EF0 extension and muted members use distinct fixed native query contracts', async t => {
    const f = fixture(t);
    assert.deepEqual(f.api.capabilities(), { groupDetail: true, groupInfoEx: true, groupShutList: true });
    assert.deepEqual(await f.query(), { groupId: '200', detail: f.detail() });
    assert.deepEqual(await f.query('group.ext'), { groupId: '200', info: { groupInfoExtSeq: 9, luckyWord: '真实扩展' } });
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [f.member()] });
    assert.deepEqual(f.calls, [{ method: 'detail', args: ['200', 2] },
        { method: 'ext', args: [['200'], [], EXT_FILTER, true] }, { method: 'shut', args: ['200', false] }]);
    assert.equal(Object.keys(EXT_FILTER).length, 32);
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
    assert.equal(f.capture.bus.listenerCount('groupShutList'), 0);
});

test('callback contracts require explicit acceptance as well as a real matching callback', async t => {
    const f = fixture(t, { queryTimeoutMs: 25 });
    for (const operation of ['group.detail']) {
        const method = 'getGroupDetailInfo';
        const emit = () => f.emitDetail(f.detail());
        for (const value of [undefined, 0, {}, { result: undefined }]) {
            f.methods[method] = () => { emit(); return value; };
            await assert.rejects(f.query(operation), { code: 'INVALID_RESPONSE' });
        }
        f.methods[method] = () => { emit(); return { result: '4' }; };
        await assert.rejects(f.query(operation), { code: 'KERNEL_ERROR' });
        f.methods[method] = () => ({ result: 0 });
        await assert.rejects(f.query(operation, {}, { expiresAt: Date.now() + 100 }), { code: 'TIMEOUT' });
    }
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
    assert.equal(f.capture.bus.listenerCount('groupShutList'), 0);
});

test('complete member snapshots select genuine future mute timestamps without waiting for the dedicated mute callback', async t => {
    const f = fixture(t);
    const now = Math.floor(Date.now() / 1000), muted = { ...f.member('22222'), shutUpTime: now + 600 };
    f.methods.getAllMemberList = () => f.memberSnapshot([muted, { ...f.member('33333'), shutUpTime: now - 1 },
        { ...f.member('44444'), shutUpTime: 0 }]);
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [muted] });
    f.methods.getAllMemberList = () => f.memberSnapshot([{ ...f.member(), shutUpTime: 0 }]);
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [] });
    f.methods.getAllMemberList = () => f.memberSnapshot([]);
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [] });
    for (const response of [{ result: 0 }, { errCode: 4, result: { finish: true, ids: [], infos: new Map() } },
        { errCode: 0, result: { finish: false, ids: [], infos: new Map() } }]) {
        f.methods.getAllMemberList = () => response;
        await assert.rejects(f.query('group.shutList'), error => ['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));
    }
});

test('pre-dispatch and cross-group callbacks cannot complete a detail query', async t => {
    const f = fixture(t, { queryTimeoutMs: 25 }), on = f.capture.bus.on.bind(f.capture.bus);
    f.capture.bus.on = (event, listener) => { on(event, listener); if (event === 'groupInfo') listener(f.detail()); return f.capture.bus; };
    f.methods.getGroupDetailInfo = () => { f.emitDetail(f.detail('201')); return { result: 0 }; };
    await assert.rejects(f.query('group.detail', {}, { expiresAt: Date.now() + 100 }), { code: 'TIMEOUT' });
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
});

test('callback snapshots are detached immediately and native rejection beats an early valid callback', async t => {
    const f = fixture(t), raw = f.detail();
    f.methods.getGroupDetailInfo = () => {
        f.emitDetail(raw); raw.groupName = 'mutated'; raw.groupExt.luckyWord = 'changed';
        return Promise.resolve({ result: 0 });
    };
    assert.equal((await f.query()).detail.groupExt.luckyWord, 'word');
    f.methods.getGroupDetailInfo = () => { f.emitDetail(f.detail()); return Promise.resolve({ result: -1 }); };
    await assert.rejects(f.query(), { code: 'KERNEL_ERROR' });
});

test('invalid group details reject incomplete counts, invalid timestamps and oversized native data', async t => {
    const f = fixture(t); let generation = 0;
    for (const patch of [{ groupName: undefined }, { memberNum: 201 }, { maxMemberNum: 0 },
        { memberNum: Number.MAX_SAFE_INTEGER + 1 }, { shutUpAllTimestamp: -1 }, { remarkName: false },
        { groupMemo: 'x'.repeat(65537) }, { groupExt: { bytes: () => {} } }]) {
        f.capture.epoch = 'invalid-detail-' + generation++;
        f.methods.getGroupDetailInfo = () => { f.emitDetail({ ...f.detail(), ...patch }); return { result: 0 }; };
        await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    }
});

test('muted member lists reject malformed members, duplicates and incomplete oversized lists', async t => {
    const f = fixture(t); let generation = 0;
    for (const list of [[f.member(), f.member()], [{ ...f.member(), uid: '' }],
        [{ ...f.member(), uin: '0' }], [{ ...f.member(), shutUpTime: -1 }], [{ ...f.member(), role: 9 }],
        [{ ...f.member(), cardName: new Map() }], [f.member(), { ...f.member('33333'), shutUpTime: -1 }],
        [f.member(), { ...f.member('33333'), nick: false, shutUpTime: 0 }],
        [{ ...f.member(), groupCode: '201' }], Array(MAX_MEMBERS + 1).fill(f.member())]) {
        f.capture.epoch = 'invalid-members-' + generation++;
        f.methods.getAllMemberList = () => f.memberSnapshot(list);
        f.methods.getMemberInfo = groupId => { f.emitMembers(groupId, list); return { result: 0 }; };
        await assert.rejects(f.query('group.shutList'), { code: 'INVALID_RESPONSE' });
    }
});

test('mute queries reuse bounded complete-member hydration and require an observed mute timestamp for every member', async t => {
    const f = fixture(t), ids = Array.from({ length: 121 }, (_, index) => 'u_' + (30000 + index)), batches = [];
    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids: ids.map(uid => ({ uid,
        uin: uid.slice(2), nick: 'Known identity', role: 2 })), infos: new Map() } });
    f.methods.getMemberInfo = (groupId, uids, refresh) => {
        batches.push([...uids]); assert.equal(refresh, false);
        f.emitMembers('201', uids.map(uid => ({ ...f.member(uid.slice(2)), nick: 'Wrong group' })));
        f.emitMembers(groupId, uids.map(uid => ({ ...f.member(uid.slice(2)), shutUpTime: uid === ids[0] ? 1900000000 : 0 })));
        return { result: 0 };
    };
    const result = await f.query('group.shutList');
    assert.deepEqual(batches.map(batch => batch.length), [50, 50, 21]);
    assert.deepEqual(result.members.map(value => value.uid), [ids[0]]);
    assert.equal(result.members[0].nick, '成员');
    assert.equal(f.capture.bus.listenerCount('groupMember'), 0);

    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids: ['u_22222'], infos: new Map() } });
    f.methods.getMemberInfo = groupId => { f.emitMembers(groupId, [{ uid: 'u_22222', uin: '22222', nick: 'Missing mute state', role: 2 }]); return { result: 0 }; };
    await assert.rejects(f.query('group.shutList'), { code: 'INVALID_RESPONSE' });
    await assert.rejects(f.query('group.shutList'), { code: 'BUSY' });
});

test('mute output projects verified scalar fields without reading opaque native extensions in snapshots or hydration', async t => {
    const f = fixture(t), expected = f.member(), circular = {}; circular.self = circular;
    let getterReads = 0;
    const raw = { ...expected, groupHonor: new Map([[1, 10]]), nativeBuffer: Buffer.from([1, 2]),
        nativeSet: new Set([1]), nativeTime: new Date(), wideNumber: Number.MAX_SAFE_INTEGER + 1,
        opaqueContext: circular, nativeMethod() {} };
    Object.defineProperty(raw, 'opaqueGetter', { enumerable: true, get() { getterReads++; throw new Error('Opaque member extension was read'); } });
    const unmuted = { ...f.member('33333'), shutUpTime: 0, groupHonor: new Map([[1, 5]]) };
    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids: [raw, unmuted],
        infos: new Map([[raw.uid, raw], [unmuted.uid, unmuted]]) } });
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [expected] });
    assert.equal(getterReads, 0);
    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids: [raw.uid], infos: new Map() } });
    f.methods.getMemberInfo = groupId => { f.emitMembers(groupId, [raw]); return { result: 0 }; };
    assert.deepEqual(await f.query('group.shutList'), { groupId: '200', members: [expected] });
    assert.equal(getterReads, 0);
});

test('unresolved full-member native queries retain their actual pending budget after timeout', async t => {
    const f = fixture(t, { queryTimeoutMs: 25 }), native = [];
    f.methods.getAllMemberList = groupId => new Promise(resolve => native.push({ groupId, resolve }));
    const results = await Promise.allSettled(Array.from({ length: MAX_QUERIES }, (_, index) =>
        f.query('group.shutList', { groupId: String(300 + index) })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
    await assert.rejects(f.query('group.shutList', { groupId: '999' }), { code: 'BUSY' });
    assert.equal(native.length, MAX_QUERIES);
    let lateBatches = 0;
    f.methods.getMemberInfo = () => { lateBatches++; return { result: 0 }; };
    for (const entry of native) entry.resolve({ errCode: 0, result: { finish: true, ids: ['u_22222'], infos: new Map() } });
    await tick();
    assert.equal(lateBatches, 0);
    f.methods.getAllMemberList = () => f.memberSnapshot([]);
    assert.deepEqual(await f.query('group.shutList', { groupId: '999' }), { groupId: '999', members: [] });
});

test('mute hydration timeouts quarantine late unidentified callbacks and session changes prohibit another batch', async t => {
    const f = fixture(t, { queryTimeoutMs: 25 }), ids = Array.from({ length: 51 }, (_, index) => 'u_' + (30000 + index));
    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids, infos: new Map() } });
    f.methods.getMemberInfo = () => ({ result: 0 });
    await assert.rejects(f.query('group.shutList'), { code: 'TIMEOUT' });
    await assert.rejects(f.query('group.shutList'), { code: 'BUSY' });
    assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
    f.capture.epoch = 'new-mute-session'; let batches = 0;
    f.methods.getMemberInfo = (groupId, uids) => {
        batches++; f.capture.self = { ...f.capture.self, uid: 'u_changed' };
        f.emitMembers(groupId, uids.map(uid => f.member(uid.slice(2)))); return { result: 0 };
    };
    await assert.rejects(f.query('group.shutList'), { code: 'SESSION_CHANGED' });
    assert.equal(batches, 1);
});

test('a second hydration batch with pending native acceptance keeps its budget even after a matching callback and timeout', async t => {
    const f = fixture(t, { queryTimeoutMs: 100 }), native = [], ids = Array.from({ length: 51 }, (_, index) => 'u_' + (30000 + index));
    f.methods.getAllMemberList = () => ({ errCode: 0, result: { finish: true, ids, infos: new Map() } });
    f.methods.getMemberInfo = (groupId, uids) => {
        f.emitMembers(groupId, uids.map(uid => ({ ...f.member(uid.slice(2)), shutUpTime: 0 })));
        return uids.length === 50 ? { result: 0 } : new Promise(resolve => native.push(resolve));
    };
    const results = await Promise.allSettled(Array.from({ length: MAX_QUERIES }, (_, index) =>
        f.query('group.shutList', { groupId: String(300 + index) })));
    assert.equal(native.length, MAX_QUERIES);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
    assert.equal(f.capture.bus.listenerCount('groupMember'), 0);
    await assert.rejects(f.query('group.shutList', { groupId: '999' }), { code: 'BUSY' });
    native[0]({ result: 0 }); await tick();
    f.methods.getAllMemberList = () => f.memberSnapshot([]);
    assert.deepEqual(await f.query('group.shutList', { groupId: '999' }), { groupId: '999', members: [] });
    for (const resolve of native.slice(1)) resolve({ result: 0 });
});

test('the full-member byte bound applies before filtering unmuted records out of an apparently empty result', async t => {
    const f = fixture(t);
    f.methods.getAllMemberList = () => f.memberSnapshot(Array.from({ length: 20 }, (_, index) =>
        ({ ...f.member(String(30000 + index)), shutUpTime: 0, nick: 'x'.repeat(65536) })));
    await assert.rejects(f.query('group.shutList'), { code: 'INVALID_RESPONSE' });
});

test('EF0 replies require the exact requested Map key, actual extension data and successful explicit codes', async t => {
    const f = fixture(t);
    for (const response of [{ result: 0 }, {}, { result: { groupExtInfos: { 200: { luckyWord: 'not a map' } } } },
        { result: { groupExtInfos: new Map([['201', { luckyWord: 'wrong group' }]]) } },
        { result: { groupExtInfos: new Map([[200, { luckyWord: 'numeric key' }]]) } },
        { result: { groupExtInfos: new Map([['200', {}]]) } },
        { result: { groupExtInfos: new Map([['200', { groupCode: '201' }]]) } }]) {
        f.methods.getGroupExt0xEF0Info = () => response;
        await assert.rejects(f.query('group.ext'), { code: 'INVALID_RESPONSE' });
    }
    f.methods.getGroupExt0xEF0Info = () => ({ errCode: 4, result: { groupExtInfos: new Map([['200', { luckyWord: 'must fail' }]]) } });
    await assert.rejects(f.query('group.ext'), { code: 'KERNEL_ERROR' });
    f.methods.getGroupExt0xEF0Info = () => ({ result: { retCode: -1, groupExtInfos: new Map([['200', { luckyWord: 'must fail' }]]) } });
    await assert.rejects(f.query('group.ext'), { code: 'KERNEL_ERROR' });
});

test('invalid parameters, stale epochs and missing callbacks fail before native dispatch', async t => {
    const f = fixture(t);
    for (const params of [{ groupId: 0 }, { groupId: '0200' }, { groupId: 0x100000000 }, { extra: true }, { operation: 'group.ext' }]) {
        await assert.rejects(f.query('group.detail', params), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(f.query('unknown'), { code: 'UNSUPPORTED' });
    await assert.rejects(f.query('group.detail', { expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.query('group.detail', { expectedEpoch: undefined }), { code: 'SESSION_CHANGED' });
    f.capture.registrations.length = 0;
    assert.equal(f.api.capabilities().groupDetail, false);
    assert.equal(f.api.capabilities().groupShutList, false);
    assert.equal(f.api.capabilities().groupInfoEx, true);
    await assert.rejects(f.query(), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('same-group callers share native work while cancellation leaves another waiter alive', async t => {
    const f = fixture(t), controller = new AbortController(); let dispatched = 0;
    f.methods.getGroupDetailInfo = () => { dispatched++; return { result: 0 }; };
    const first = f.query('group.detail', {}, { signal: controller.signal });
    const second = f.query();
    const rejected = assert.rejects(first, { code: 'EXPIRED' });
    await tick(); assert.equal(dispatched, 1);
    controller.abort(); await rejected;
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 1);
    f.emitDetail(f.detail());
    assert.equal((await second).detail.groupName, '真实群');
    await tick(); assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
});

test('the last cancelled waiter leaves bounded shared observation and a later caller joins without redispatch', async t => {
    const f = fixture(t), controller = new AbortController(); let dispatched = 0;
    f.methods.getGroupDetailInfo = () => { dispatched++; return { result: 0 }; };
    const pending = f.query('group.detail', {}, { signal: controller.signal });
    const rejected = assert.rejects(pending, { code: 'EXPIRED' });
    await tick(); controller.abort(); await rejected; await tick();
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 1);
    const next = f.query(); await tick(); assert.equal(dispatched, 1);
    f.emitDetail(f.detail()); await next; await tick();
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
});

test('one shared response is copied separately for each caller', async t => {
    const f = fixture(t);
    f.methods.getGroupDetailInfo = () => { setImmediate(() => f.emitDetail(f.detail())); return { result: 0 }; };
    const [first, second] = await Promise.all([f.query(), f.query()]);
    first.detail.groupExt.luckyWord = 'caller changed';
    assert.equal(second.detail.groupExt.luckyWord, 'word');
});

test('session identity changes, deadlines and explicit clearing clean all callback observations', async t => {
    const f = fixture(t);
    f.methods.getGroupDetailInfo = () => {
        setImmediate(() => { f.capture.self = { ...f.capture.self, uid: 'u_changed' }; f.emitDetail(f.detail()); });
        return { result: 0 };
    };
    await assert.rejects(f.query(), { code: 'SESSION_CHANGED' });
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
    f.methods.getGroupDetailInfo = () => ({ result: 0 });
    await assert.rejects(f.query('group.detail', {}, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    const first = f.query(), second = f.query();
    const rejected = Promise.all([assert.rejects(first, { code: 'EXPIRED' }), assert.rejects(second, { code: 'EXPIRED' })]);
    await tick(); f.api.clear(); await rejected; await tick();
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
});

test('concurrent query and waiter budgets reject before extra native dispatch and release after cancellation', async t => {
    const f = fixture(t), controller = new AbortController(); let dispatched = 0;
    f.methods.getGroupDetailInfo = () => { dispatched++; return { result: 0 }; };
    const requests = Array.from({ length: MAX_WAITERS }, () => f.query('group.detail', {}, { signal: controller.signal }));
    const settled = Promise.allSettled(requests);
    await assert.rejects(f.query(), { code: 'BUSY' });
    await tick(); assert.equal(dispatched, 1);
    controller.abort(); await settled; await tick();
    f.api.clear(); await tick();
    const nextController = new AbortController();
    const groups = Array.from({ length: MAX_QUERIES }, (_, index) => f.query('group.detail', { groupId: String(300 + index) }, { signal: nextController.signal }));
    const groupsSettled = Promise.allSettled(groups);
    await assert.rejects(f.query('group.detail', { groupId: '999' }), { code: 'BUSY' });
    await tick(); assert.equal(dispatched, 1 + MAX_QUERIES);
    nextController.abort(); await groupsSettled; await tick();
    f.api.clear(); await tick();
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
});

test('native promises retain their eight-slot budget after caller and observation timeouts', async t => {
    const f = fixture(t, { queryTimeoutMs: 30 }), native = [];
    f.methods.getGroupExt0xEF0Info = (...args) => new Promise(resolve => native.push({ groupId: args[0][0], resolve }));
    const requests = Array.from({ length: MAX_QUERIES }, (_, index) => f.query('group.ext', { groupId: String(300 + index) }));
    const results = await Promise.allSettled(requests);
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'TIMEOUT'));
    assert.equal(native.length, MAX_QUERIES);
    await assert.rejects(f.query('group.ext', { groupId: '999' }), { code: 'BUSY' });
    assert.equal(native.length, MAX_QUERIES);
    const first = native[0]; first.resolve({ result: { groupExtInfos: new Map([[first.groupId, { luckyWord: 'late result' }]]) } });
    await tick();
    const next = f.query('group.ext', { groupId: '999' });
    await tick(); assert.equal(native.length, MAX_QUERIES + 1);
    native.at(-1).resolve({ result: { groupExtInfos: new Map([['999', { luckyWord: 'new result' }]]) } });
    assert.equal((await next).info.luckyWord, 'new result');
    for (const pending of native.slice(1, MAX_QUERIES)) pending.resolve({ result: { groupExtInfos: new Map([[pending.groupId, { luckyWord: 'cleanup' }]]) } });
});

test('unidentified callback timeouts quarantine only their operation and group until the QQ session changes', async t => {
    const f = fixture(t, { queryTimeoutMs: 25 }); let calls = 0;
    f.methods.getGroupDetailInfo = () => { calls++; return { result: 0 }; };
    await assert.rejects(f.query(), { code: 'TIMEOUT' });
    assert.equal(f.capture.bus.listenerCount('groupInfo'), 0);
    await assert.rejects(f.query(), error => error.code === 'BUSY' && /previous group query remains unresolved/.test(error.message));
    assert.equal(calls, 1);
    assert.equal((await f.query('group.ext')).info.luckyWord, '真实扩展');
    f.methods.getGroupDetailInfo = groupId => { calls++; f.emitDetail(f.detail(groupId)); return { result: 0 }; };
    assert.equal((await f.query('group.detail', { groupId: '201' })).detail.groupCode, '201');
    f.capture.epoch = 'new-group-session';
    assert.equal((await f.query()).detail.groupCode, '200');
    assert.equal(calls, 3);
});

test('missing or malformed acceptance and malformed matching callbacks cannot authorize same-session redispatch', async t => {
    const f = fixture(t); let generation = 0;
    for (const value of [undefined, {}, { result: 'invalid' }]) {
        f.capture.epoch = 'unknown-acceptance-' + generation++;
        f.methods.getGroupDetailInfo = () => value;
        await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
        await assert.rejects(f.query(), { code: 'BUSY' });
    }
    f.capture.epoch = 'malformed-callback';
    f.methods.getGroupDetailInfo = () => { f.emitDetail({ ...f.detail(), memberNum: -1 }); return { result: 0 }; };
    await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    await assert.rejects(f.query(), { code: 'BUSY' });
    f.capture.epoch = 'explicit-rejection';
    f.methods.getGroupDetailInfo = () => ({ result: -1 });
    await assert.rejects(f.query(), { code: 'KERNEL_ERROR' });
    f.methods.getGroupDetailInfo = () => { f.emitDetail(f.detail()); return { result: 0 }; };
    assert.equal((await f.query()).detail.groupCode, '200');
});

test('native snapshot byte accounting rejects repeated large strings before building an expanded JSON response', async t => {
    const f = fixture(t); let tailReads = 0;
    const repeated = 'x'.repeat(65536);
    f.methods.getGroupDetailInfo = () => {
        const raw = { ...f.detail(), tagRecord: Array(10000).fill(repeated) };
        Object.defineProperty(raw, 'tail', { enumerable: true, get() { tailReads++; return 'must not read after exceeding the budget'; } });
        f.emitDetail(raw); return { result: 0 };
    };
    await assert.rejects(f.query(), { code: 'INVALID_RESPONSE' });
    assert.equal(tailReads, 0);
});

test('OneBot group query actions preserve three distinct real native outputs and normalized detail fields', async () => {
    const calls = [], state = { capabilities: { groupDetail: true, groupInfoEx: true, groupShutList: true } };
    const detail = { groupCode: '200', groupName: 'Group', memberNum: 2, maxMemberNum: 200, remarkName: 'Remark',
        shutUpAllTimestamp: Math.floor(Date.now() / 1000) + 600, groupMemo: 'native memo' };
    const member = { uid: 'u_member', uin: '22222', nick: 'Nick', shutUpTime: 1900000000 };
    const service = { sessionCall: async (actual, method, params) => {
        assert.equal(actual, state); calls.push({ method, params });
        return { groupId: '200', ...({ 'group.detail': { detail }, 'group.ext': { info: { luckyWord: 'native extension' } }, 'group.shutList': { members: [member] } }[params.operation]) };
    } };
    assert.deepEqual([...ACTIONS], ['get_group_detail_info', 'get_group_info_ex', 'get_group_shut_list']);
    assert.deepEqual(await runGroupQueries(service, state, 'get_group_detail_info', { group_id: 200 }), {
        ...detail, group_id: 200, group_name: 'Group', member_count: 2, max_member_count: 200, group_all_shut: -1, group_remark: 'Remark' });
    assert.deepEqual(await runGroupQueries(service, state, 'get_group_info_ex', { group_id: '200' }), { luckyWord: 'native extension' });
    assert.deepEqual(await runGroupQueries(service, state, 'get_group_shut_list', { group_id: '200' }), [member]);
    assert.deepEqual(calls.map(value => value.method), ['groupQuery', 'groupQuery', 'groupQuery']);
    assert.deepEqual(calls.map(value => value.params.operation), ['group.detail', 'group.ext', 'group.shutList']);
    assert.ok(calls.every(value => value.params.groupId === '200'));
});

test('OneBot group detail does not invent missing remark or mute fields and evaluates expired mute timestamps', async () => {
    const state = { capabilities: { groupDetail: true } };
    const detail = { groupCode: '200', groupName: 'Group', memberNum: 0, maxMemberNum: 200 };
    const service = { sessionCall: async () => ({ groupId: '200', detail }) };
    const result = await runGroupQueries(service, state, 'get_group_detail_info', { group_id: '200' });
    assert.equal(Object.hasOwn(result, 'group_remark'), false);
    assert.equal(Object.hasOwn(result, 'group_all_shut'), false);
    detail.group_all_shut = -1; detail.group_remark = 'unrecognized source';
    const withoutNativeSources = await runGroupQueries(service, state, 'get_group_detail_info', { group_id: '200' });
    assert.equal(Object.hasOwn(withoutNativeSources, 'group_remark'), false);
    assert.equal(Object.hasOwn(withoutNativeSources, 'group_all_shut'), false);
    detail.shutUpAllTimestamp = Math.floor(Date.now() / 1000) - 1;
    assert.equal((await runGroupQueries(service, state, 'get_group_detail_info', { group_id: '200' })).group_all_shut, 0);
});

test('OneBot group query validation rejects unsupported capability, extra parameters and unrelated backend results', async () => {
    let calls = 0;
    const service = { sessionCall: async () => { calls++; return { groupId: '201', members: [] }; } };
    for (const action of ACTIONS) {
        const state = { capabilities: { [REQUIREMENTS[action]]: true } };
        for (const params of [{ group_id: 0 }, { group_id: '0200' }, { group_id: '200', no_cache: true }]) {
            await assert.rejects(runGroupQueries(service, state, action, params), { code: 'INVALID_PARAMS' });
        }
        await assert.rejects(runGroupQueries(service, { capabilities: {} }, action, { group_id: '200' }), { code: 'UNSUPPORTED' });
        assert.equal(calls, 0);
    }
    await assert.rejects(runGroupQueries(service, { capabilities: { groupShutList: true } }, 'get_group_shut_list', { group_id: '200' }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 1);
});
