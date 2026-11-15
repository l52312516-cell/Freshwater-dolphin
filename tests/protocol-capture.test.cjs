'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { METHODS } = require('../src/ipc/common.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');

function filePage(groupId = '12345', reqId = 0) {
    return { reqId, retCode: 0, isEnd: true, nextIndex: 1, allFileCount: 1,
        item: [{ type: 1, peerId: groupId, fileInfo: { fileId: '/fixture-file', fileName: 'fixture.txt',
            busId: 102, fileSize: '9007199254740993' } }] };
}
function fixture(t, options = {}) {
    const listeners = {}, registrations = [], removals = [], calls = [];
    let nextListener = 0;
    function observing(name, add, remove, methods = {}) {
        return { ...methods, [add](listener) { listeners[name] = listener; registrations.push(name); return ++nextListener; },
            [remove](id) { removals.push({ name, id }); delete listeners[name]; } };
    }
    const services = {
        msg: observing('msg', 'addKernelMsgListener', 'removeKernelMsgListener'),
        profile: observing('profile', 'addKernelProfileListener', 'removeKernelProfileListener'),
        group: observing('group', 'addKernelGroupListener', 'removeKernelGroupListener', {
            getGroupRemainAtTimes(groupId) {
                calls.push({ method: 'atAll', groupId });
                return { errCode: 0, atInfo: { canAtAll: true, RemainAtAllCountForUin: 3,
                    RemainAtAllCountForGroup: 4, atTimesMsg: '', canNotAtAllMsg: '' } };
            }
        }),
        buddy: observing('buddy', 'addKernelBuddyListener', 'removeKernelBuddyListener'),
        profileLike: { setBuddyProfileLike(value) {
            assert.equal(this, services.profileLike); calls.push({ method: 'like', value });
            return { result: 0, succCounts: value.doLikeCount };
        } },
        richMedia: {
            getGroupFileList(groupId, params) {
                assert.equal(this, services.richMedia); calls.push({ method: 'files', groupId, params });
                listeners.msg.onGroupFileInfoUpdate(filePage(groupId)); return 0;
            },
            getGroupFileInfo(groupId, fileId) {
                calls.push({ method: 'fileInfo', groupId, fileId });
                return { result: 0, groupFileInfoResult: { retCode: 0,
                    fileInfo: { fileId, busId: 102, fileSize: '9007199254740993' } } };
            }
        }
    };
    const getters = { msg: 'getMsgService', profile: 'getProfileService', group: 'getGroupService',
        buddy: 'getBuddyService', profileLike: 'getProfileLikeService', richMedia: 'getRichMediaService' };
    const session = {
        init(_config, _dependencies, _dispatcher, completion) {
            completion.onSessionInitComplete({ result: 0 }); return 'native-initialization';
        },
        ...Object.fromEntries(Object.entries(getters).map(([name, getter]) => [getter, () => services[name]]))
    };
    const capture = new Capture({ install: false });
    capture.observeSession(session);
    function initialize(config = {}) {
        const result = session.init({ selfUin: '23456', selfUid: 'u_self', clientVer: TARGET_VERSION, ...config }, {}, {},
            { onSessionInitComplete() {} });
        assert.equal(result, 'native-initialization');
    }
    if (options.initialize !== false) initialize();
    t.after(() => capture.close());
    return { capture, session, services, listeners, registrations, removals, calls, initialize };
}
function call(f, method, params, context = {}) {
    return f.capture.call(method, { ...params, expectedEpoch: f.capture.epoch },
        { expiresAt: Date.now() + 1000, ...context });
}

test('fixed IPC and Capture allowlists contain the two bridges without exposing raw operations', async t => {
    const f = fixture(t);
    assert.equal(METHODS.has('interaction'), true); assert.equal(METHODS.has('groupFiles'), true);
    for (const method of ['profile.like', 'group.filesList', 'getGroupFileInfo', 'eval', 'exec']) {
        assert.equal(METHODS.has(method), false);
        await assert.rejects(f.capture.call(method, {}), { code: 'UNSUPPORTED' });
    }
    assert.equal(f.calls.length, 0);
});

test('natural QQ session initialization exposes new method-presence capabilities after readiness only', async t => {
    const f = fixture(t, { initialize: false });
    let state = await f.capture.call('status');
    for (const name of ['profileLike', 'groupAtAllRemain', 'groupFiles', 'groupFileInfo']) assert.equal(state.capabilities[name], false);
    f.initialize(); state = await f.capture.call('status');
    for (const name of ['profileLike', 'groupAtAllRemain', 'groupFiles', 'groupFileInfo']) assert.equal(state.capabilities[name], true);
    assert.ok(f.registrations.includes('msg'));
});

test('Capture.call strips interaction operation while preserving caller parameters and expected generation', async t => {
    const f = fixture(t);
    const params = { operation: 'profile.like', uid: 'u_friend', count: 2, expectedEpoch: f.capture.epoch };
    const before = { ...params };
    assert.deepEqual(await f.capture.call('interaction', params), { uid: 'u_friend', count: 2, confirmed: true });
    assert.deepEqual(params, before);
    assert.deepEqual(f.calls, [{ method: 'like', value: {
        friendUid: 'u_friend', sourceId: 71, doLikeCount: 2, doLikeTollCount: 0 } }]);
    const allowance = await call(f, 'interaction', { operation: 'group.atAllRemain', groupId: '12345' });
    assert.equal(allowance.group_id, 12345); assert.equal(allowance.remain_at_all_count_for_uin, 3);
});

test('Capture.call group file list forwards synchronous callback and request ID zero with expectedEpoch', async t => {
    const f = fixture(t);
    const params = { operation: 'group.filesList', groupId: '12345', count: 5, expectedEpoch: f.capture.epoch };
    const output = await f.capture.call('groupFiles', params, { expiresAt: Date.now() + 1000 });
    assert.equal(output.groupId, '12345'); assert.equal(output.isEnd, true);
    assert.equal(output.items[0].fileInfo.fileSize, '9007199254740993');
    assert.equal(params.operation, 'group.filesList'); assert.equal(params.expectedEpoch, f.capture.epoch);
    assert.deepEqual(f.calls, [{ method: 'files', groupId: '12345', params: {
        sortType: 1, fileCount: 5, startIndex: 0, sortOrder: 1, showOnlinedocFolder: 0 } }]);
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('Capture.call group file details use a real list callback and never invoke the native detail getter', async t => {
    const f = fixture(t);
    let forbidden = 0;
    f.services.richMedia.getGroupFileInfo = () => { forbidden++; throw new Error('Unverified native detail getter must stay unused'); };
    const output = await call(f, 'groupFiles', { operation: 'group.fileInfo', groupId: '12345', fileId: '/fixture-file' });
    assert.deepEqual(output, { groupId: '12345', fileInfo: {
        fileId: '/fixture-file', fileName: 'fixture.txt', busId: 102, fileSize: '9007199254740993' } });
    assert.equal(forbidden, 0); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, 'files'); assert.equal(f.calls[0].groupId, '12345');
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('Capture.call group file details advance real pages within the requested directory', async t => {
    const f = fixture(t);
    const pages = [];
    delete f.services.richMedia.getGroupFileInfo;
    f.services.richMedia.getGroupFileList = (groupId, params) => {
        assert.equal(groupId, '12345'); assert.equal(params.folderId, '/nested'); pages.push(params.startIndex);
        const first = params.startIndex === 0;
        const result = filePage(groupId, first ? 0 : 1);
        result.item[0].fileInfo.parentFolderId = '/nested';
        if (first) {
            result.item[0].fileInfo.fileId = '/other-file'; result.isEnd = false;
            result.allFileCount = 2; result.nextIndex = 1;
        } else { result.allFileCount = 2; result.nextIndex = 2; }
        f.listeners.msg.onGroupFileInfoUpdate(result); return first ? 0 : 1;
    };
    assert.equal((await f.capture.call('status')).capabilities.groupFileInfo, true);
    const output = await call(f, 'groupFiles', { operation: 'group.fileInfo', groupId: '12345',
        fileId: '/fixture-file', directory: '/nested' });
    assert.equal(output.fileInfo.fileId, '/fixture-file'); assert.equal(output.fileInfo.parentFolderId, '/nested');
    assert.deepEqual(pages, [0, 1]); assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('group file details require the list callback capability even when a native detail getter exists', async t => {
    const f = fixture(t);
    delete f.services.richMedia.getGroupFileList;
    const state = await f.capture.call('status');
    assert.equal(state.capabilities.groupFileInfo, false); assert.equal(state.capabilities.groupFiles, false);
    await assert.rejects(call(f, 'groupFiles', { operation: 'group.fileInfo', groupId: '12345', fileId: '/fixture-file' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('group file details report not found from a completed live page without invoking the native getter', async t => {
    const f = fixture(t);
    const output = call(f, 'groupFiles', { operation: 'group.fileInfo', groupId: '12345', fileId: '/unknown-file' });
    await assert.rejects(output, { code: 'NOT_FOUND' });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'files');
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('stale expectedEpoch is rejected before either newly registered bridge can dispatch', async t => {
    const f = fixture(t);
    for (const [method, params] of [['interaction', { operation: 'profile.like', uid: 'u_friend' }],
        ['groupFiles', { operation: 'group.filesList', groupId: '12345' }],
        ['groupFiles', { operation: 'group.fileInfo', groupId: '12345', fileId: '/fixture-file' }]]) {
        await assert.rejects(f.capture.call(method, { ...params, expectedEpoch: 'previous-generation' }), { code: 'SESSION_CHANGED' });
    }
    assert.equal(f.calls.length, 0);
});

test('fixed bridge operations reject missing operation or unknown fields before touching QQ', async t => {
    const f = fixture(t);
    await assert.rejects(call(f, 'interaction', { uid: 'u_friend' }), { code: 'UNSUPPORTED' });
    await assert.rejects(call(f, 'groupFiles', { groupId: '12345' }), { code: 'UNSUPPORTED' });
    await assert.rejects(call(f, 'interaction', { operation: 'profile.like', uid: 'u_friend', nativeOptions: {} }), { code: 'INVALID_PARAMS' });
    await assert.rejects(call(f, 'groupFiles', { operation: 'group.filesList', groupId: '12345', nativeOptions: {} }), { code: 'INVALID_PARAMS' });
    assert.equal(f.calls.length, 0);
});

test('missing QQ services and unsupported versions suppress capabilities and do not invoke alternatives', async t => {
    const f = fixture(t);
    delete f.session.getProfileLikeService; delete f.services.group.getGroupRemainAtTimes;
    delete f.session.getRichMediaService;
    const state = await f.capture.call('status');
    for (const name of ['profileLike', 'groupAtAllRemain', 'groupFiles', 'groupFileInfo']) assert.equal(state.capabilities[name], false);
    await assert.rejects(call(f, 'interaction', { operation: 'profile.like', uid: 'u_friend' }), { code: 'UNSUPPORTED' });
    await assert.rejects(call(f, 'interaction', { operation: 'group.atAllRemain', groupId: '12345' }), { code: 'UNSUPPORTED' });
    await assert.rejects(call(f, 'groupFiles', { operation: 'group.filesList', groupId: '12345' }), { code: 'UNSUPPORTED' });
    f.initialize({ clientVer: '3.2.99-unknown' });
    const unsupported = await f.capture.call('status');
    for (const name of ['profileLike', 'groupAtAllRemain', 'groupFiles', 'groupFileInfo']) assert.equal(unsupported.capabilities[name], false);
    await assert.rejects(f.capture.call('interaction', { operation: 'profile.like', uid: 'u_friend' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('session reset rejects pending likes and old native results cannot confirm the next account', async t => {
    const f = fixture(t);
    let complete;
    f.services.profileLike.setBuddyProfileLike = () => new Promise(resolve => { complete = resolve; });
    const pending = call(f, 'interaction', { operation: 'profile.like', uid: 'u_friend' });
    const rejection = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await new Promise(resolve => setImmediate(resolve));
    const oldEpoch = f.capture.epoch; f.initialize({ selfUin: '34567', selfUid: 'u_new_self' });
    assert.notEqual(f.capture.epoch, oldEpoch); await rejection;
    f.services.profileLike.setBuddyProfileLike = () => ({ result: 0, succCounts: 1 });
    assert.equal((await call(f, 'interaction', { operation: 'profile.like', uid: 'u_friend' })).confirmed, true);
    complete({ result: 0, succCounts: 1 }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.capture.pending.size, 0);
});

test('session reset detaches old file callbacks even when QQ reuses the same native request ID', async t => {
    const f = fixture(t);
    f.services.richMedia.getGroupFileList = () => 0;
    const oldListener = f.listeners.msg;
    const pending = call(f, 'groupFiles', { operation: 'group.filesList', groupId: '12345' });
    const rejection = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await new Promise(resolve => setImmediate(resolve)); f.initialize(); await rejection;
    assert.ok(f.removals.some(row => row.name === 'msg'));
    let settled = false;
    const current = call(f, 'groupFiles', { operation: 'group.filesList', groupId: '12345' });
    current.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    oldListener.onGroupFileInfoUpdate(filePage());
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    f.listeners.msg.onGroupFileInfoUpdate(filePage());
    assert.equal((await current).items.length, 1); assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('file RPC round-trips the new bridges through the real Capture dispatcher and rejects raw methods', async t => {
    const f = fixture(t);
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporary, 'protocol-capture-'));
    let server, client;
    t.after(async () => { client?.close(); await server?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    server = await startServer({ dir: directory, backend: f.capture, pollMs: 5 });
    client = new RpcClient({ directory, timeoutMs: 2000 });
    assert.equal((await client.call('interaction', { operation: 'profile.like', uid: 'u_friend', expectedEpoch: f.capture.epoch })).confirmed, true);
    const page = await client.call('groupFiles', { operation: 'group.filesList', groupId: '12345', expectedEpoch: f.capture.epoch });
    assert.equal(page.items[0].fileInfo.fileSize, '9007199254740993');
    const details = await client.call('groupFiles', { operation: 'group.fileInfo', groupId: '12345',
        fileId: '/fixture-file', expectedEpoch: f.capture.epoch });
    assert.equal(details.fileInfo.fileId, '/fixture-file');
    assert.equal(f.calls.some(value => value.method === 'fileInfo'), false);
    await assert.rejects(client.call('profile.like', { uid: 'u_friend' }), { code: 'UNSUPPORTED' });
    await assert.rejects(client.call('groupFiles', { operation: 'group.filesList', groupId: '12345', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
});
