'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chinaDay, collectSignedList } = require('../src/qq/query2-signin.cjs');
const { createGroupWeb } = require('../src/qq/group-web.cjs');
const { createExtendedQueries2, onlineClients } = require('../src/qq/extended-queries2.cjs');
const { runExtendedQueries2 } = require('../src/onebot/extended-queries2.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const wire = require('../src/qq/proto.cjs');
const fixed = require('../src/qq/query2-oidb.cjs');
const member = (index = 0) => ({ uid: String(10001 + index), uidGroupNick: '成员' + index, signedTimeStamp: '1700000000', signInRank: 2 * index + 1 });
const page = (infos = [], offset = 0, total = infos.length) => ({ retCode: 0, funcCode: 0, response: { page: [{ infos, offset, total }] } });
function capture() { return { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, registrations: [{ name: 'msg' }], ensureReady() {}, hasMethods: () => true, deadline: operation => operation() }; }

test('sign-in uses the China calendar independently from the host timezone', () => {
    assert.equal(chinaDay(Date.parse('2026-11-16T15:59:59Z')), '20261116');
    assert.equal(chinaDay(Date.parse('2026-11-16T16:00:00Z')), '20261117');
});

test('sign-in collects explicit contiguous pages and verifies every rank/account before returning complete', async () => {
    const calls = [], result = await collectSignedList(async request => {
        calls.push(request);
        return request.offset === 0 ? page(Array.from({ length: 100 }, (_v, index) => member(index)), 100, 101) : page([member(100)], 100, 101);
    }, '20001', '20261116');
    assert.equal(result.complete, true); assert.equal(result.members.length, 101); assert.equal(result.members.at(-1).rank, 101);
    assert.deepEqual(calls.map(request => request.offset), [0, 100]);
    assert.deepEqual((await collectSignedList(async () => page(), '20001', '20261116')).members, []);
    assert.deepEqual((await collectSignedList(async () => ({ retCode: 0, funcCode: 0, response: { page: [{ offset: 0, total: 0 }] } }), '20001', '20261116')).members, []);
    for (const code of [0, '0', 'Succ']) assert.deepEqual((await collectSignedList(async () => ({ ...page(), response: { ...page().response, ret: { code } } }), '20001', '20261116')).members, []);
    // Target QQ's official CGI: outer zeros, literal Succ, and an explicit
    // empty page without infos. This is distinct from auth/page-less errors.
    assert.deepEqual(await collectSignedList(async () => ({ retCode: 0, funcCode: 0, response: {
        ret: { code: 'Succ', msg: '' }, page: [{ offset: 0, total: 0 }]
    } }), '20001', '20261116'), { groupId: '20001', dayYmd: '20261116', members: [], complete: true });
});

test('auth-like, truncated, inconsistent and duplicate sign-in responses never become successful empty lists', async () => {
    for (const result of [{}, { retCode: 0, funcCode: 0, response: {} }, page([], 0, 1), page([member()], 3, 1),
        page([{ ...member(), signInRank: 2 }]), page([{ ...member(), uid: '001' }]), page([{ ...member(), signedTimeStamp: '9007199254740993' }]),
        page([member(), member()], 0, 2), { ...page(), retCode: 1 }, ...['5', 5, null, false, '', '00', 'SUCCESS', 'succ', 'Failure', undefined].map(code => ({ ...page(), response: { ret: { code }, page: [{ infos: [], offset: 0, total: 0 }] } }))]) {
        await assert.rejects(collectSignedList(async () => result, '20001', '20261116'));
    }
    let count = 0;
    await assert.rejects(collectSignedList(async () => count++ === 0 ? page([member()], 0, 2) : page([member(1)], 1, 3), '20001', '20261116'), { code: 'INVALID_RESPONSE' });
});

test('group sign-in web path keeps account tickets private and pins its JSON endpoint', async () => {
    const c = capture(), calls = [];
    c.hasMethods = (_service, methods) => !methods.includes('getPskey');
    c.invoke = async () => ({ result: 0, clientKey: 'PRIVATE-TICKET', keyIndex: '1' });
    const client = createGroupWeb(c, { fetchImpl: async (input, request) => {
        const url = new URL(input); calls.push({ url, request });
        if (url.hostname === 'ssl.ptlogin2.qq.com') return new Response('', { status: 302, headers: [
            ['Location', 'https://qun.qq.com/'], ['Set-Cookie', 'uin=o12345; Domain=qq.com; Path=/; Secure'], ['Set-Cookie', 'skey=SECRET-SKEY; Domain=qq.com; Path=/; Secure']
        ] });
        if (url.pathname === '/') return new Response('landing');
        return new Response(JSON.stringify(page([member()])));
    } });
    const result = await client.execute('group.signedList', { groupId: '20001' }, { expiresAt: Date.now() + 5000 }, { epoch: c.epoch, ...c.self });
    assert.equal(calls.at(-1).url.origin + calls.at(-1).url.pathname, 'https://qun.qq.com/v2/signin/trpc/GetDaySignedList');
    assert.equal(calls.at(-1).request.redirect, 'manual'); assert.equal(calls.at(-1).request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls.at(-1).request.body), { dayYmd: chinaDay(), offset: 0, limit: 100, uid: '12345', groupId: '20001' });
    assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('query adapter binds epoch/account and retains physical slots after caller deadlines', async () => {
    const c = capture(), requests = [];
    const api = createExtendedQueries2(c, { native: { available: () => true, async run(_c, request) { requests.push(request); return { uin: request.request.uin, status: 10, extStatus: 0 }; } } });
    const result = await api.query({ operation: 'user.status', uin: 10001, expectedEpoch: 'e1' });
    assert.equal(result.uin, '10001'); assert.equal(requests[0].op, 'fixedQuery2'); assert.equal(requests[0].expectedUin, '12345');
    assert.ok(requests[0].timeoutMs <= 10000);
    await assert.rejects(api.query({ operation: 'user.status', uin: 10001, expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    let finish;
    const changed = createExtendedQueries2(c, { native: { available: () => true, run: () => new Promise(resolve => { finish = resolve; }) } });
    const task = changed.query({ operation: 'user.status', uin: 10001, expectedEpoch: 'e1' });
    await Promise.resolve(); c.self = { uin: '12345', uid: 'u_changed' }; finish({ uin: '10001', status: 10, extStatus: 0 });
    await assert.rejects(task, { code: 'SESSION_CHANGED' });
    const stuck = capture(); let invocations = 0;
    stuck.deadline = async operation => { operation(); throw Object.assign(new Error('expired'), { code: 'TIMEOUT' }); };
    const limited = createExtendedQueries2(stuck, { native: { available: () => true, run: () => { invocations++; return new Promise(() => {}); } } });
    for (let index = 0; index < 8; index++) await assert.rejects(limited.query({ operation: 'user.status', uin: 10001, expectedEpoch: 'e1' }), { code: 'TIMEOUT' });
    stuck.epoch = 'e2';
    await assert.rejects(limited.query({ operation: 'user.status', uin: 10001, expectedEpoch: 'e2' }), { code: 'BUSY' });
    assert.equal(invocations, 8);
});

test('OneBot todo IDs come only from real native mappings and uncached fields stay explicit', async () => {
    const todo = { sourceId: '77_-123', sequence: 77, random: -123, text: '待办' };
    const state = { self: { uin: '12345' }, capabilities: { groupTodoList: true, userStatus: true, groupSignedList: true } };
    let cached = null, result = { groupId: '20001', todos: [todo] };
    const calls = [], service = { store: { find(account, request) { calls.push({ account, request }); return cached; } }, async sessionCall(_state, method, request) { calls.push({ method, request }); return result; } };
    assert.deepEqual(await runExtendedQueries2(service, state, 'get_group_todo_list', { group_id: 20001 }), [
        { message_id: null, message_seq: 77, message_random: -123, message: null, text: '待办' }
    ]);
    cached = { id: 15, locator: { peer: { chatType: 2, peerUid: '20001' }, seq: '77', nativeId: '123456789' }, record: { msgRandom: 4294967173 }, event: { message: [{ type: 'text', data: { text: '真实缓存消息' } }] } };
    assert.equal((await runExtendedQueries2(service, state, 'get_group_todo_list', { group_id: 20001 }))[0].message_id, 15);
    cached.record.msgRandom = 1;
    assert.equal((await runExtendedQueries2(service, state, 'get_group_todo_list', { group_id: 20001 }))[0].message_id, null);
    result = { groupId: '99999', todos: [] };
    await assert.rejects(runExtendedQueries2(service, state, 'get_group_todo_list', { group_id: 20001 }), { code: 'INVALID_RESPONSE' });
    result = { uin: '10001', status: 10, extStatus: 1024 };
    assert.deepEqual(await runExtendedQueries2(service, state, 'nc_get_user_status', { user_id: '10001' }), { status: 10, ext_status: 1024 });
    assert.equal(calls.find(call => call.method).method, 'extendedQuery2');
    await assert.rejects(runExtendedQueries2(service, state, 'nc_get_user_status', { user_id: 10001, raw: {} }), { code: 'INVALID_PARAMS' });
});

test('online clients wait for real native acceptance and snapshot, preserving native fields without fabricated app/name data', async () => {
    const c = capture(), calls = []; let api;
    c.invoke = (service, method, args) => {
        calls.push({ service, method, args });
        api.listenerMethods.msg.onLineDev([{ instanceId: 537269453, clientType: 0x14702, devUid: 'native-device-1' }]);
        return { result: 0, errMsg: '' };
    };
    api = createExtendedQueries2(c, { native: { available: () => true } });
    const snapshot = await api.query({ operation: 'account.onlineClients', expectedEpoch: 'e1' });
    assert.deepEqual(calls, [{ service: 'msg', method: 'getOnLineDev', args: [] }]);
    assert.deepEqual(snapshot, { selfUin: '12345', source: 'kernel_snapshot', clients: [{ instanceId: 537269453, clientType: 0x14702, devUid: 'native-device-1', deviceKind: '手机' }] });
    const result = await runExtendedQueries2({ async sessionCall() { return snapshot; } }, { self: c.self, capabilities: { onlineClients: true } }, 'get_online_clients', {});
    assert.deepEqual(result, { clients: [{ instance_id: 537269453, client_type: 0x14702, device_uid: 'native-device-1', device_kind: '手机' }] });
    assert.equal(Object.hasOwn(result.clients[0], 'app_id'), false); assert.equal(Object.hasOwn(result.clients[0], 'device_name'), false);
    c.invoke = () => { api.listenerMethods.msg.onLineDev([]); return { result: 0 }; };
    assert.deepEqual((await api.query({ operation: 'account.onlineClients', expectedEpoch: 'e1' })).clients, []);
    await assert.rejects(api.query({ operation: 'account.onlineClients', noCache: true, expectedEpoch: 'e1' }), { code: 'UNSUPPORTED' });
});

test('online snapshots reject malformed native data, ignored accessors and failure acknowledgements', async () => {
    const valid = { instanceId: 1, clientType: 7, devUid: 'phone' };
    let reads = 0;
    const row = { ...valid }; Object.defineProperty(row, 'unrelated', { get() { reads++; throw new Error('must not read'); } });
    assert.equal(onlineClients([row])[0].deviceKind, '手机'); assert.equal(reads, 0);
    for (const value of [null, {}, new Array(1), [{ ...valid, clientType: 0 }], [{ ...valid, devUid: '' }], [valid, valid], [{ ...valid, instanceId: 1.1 }]]) assert.throws(() => onlineClients(value), { code: 'INVALID_RESPONSE' });
    const c = capture(); let api;
    api = createExtendedQueries2(c, { native: { available: () => false } });
    c.invoke = () => { api.listenerMethods.msg.onLineDev([valid]); return { result: 1 }; };
    await assert.rejects(api.query({ operation: 'account.onlineClients', expectedEpoch: 'e1' }), { code: 'KERNEL_ERROR' });
    c.invoke = () => ({ result: 0 });
    const pending = api.query({ operation: 'account.onlineClients', expectedEpoch: 'e1' });
    await Promise.resolve();
    await assert.rejects(api.query({ operation: 'account.onlineClients', expectedEpoch: 'e1' }), { code: 'BUSY' });
    api.clear();
    await assert.rejects(pending, { code: 'SESSION_CHANGED' });
});

test('all four OneBot actions traverse the registered session-bound query2 route', async () => {
    const c = capture(); let api;
    c.hasMethods = (_service, methods) => !methods.includes('getPskey');
    c.invoke = async (service, method) => {
        if (service === 'ticket' && method === 'forceFetchClientKey') return { result: 0, clientKey: 'PRIVATE-TICKET', keyIndex: '1' };
        if (service === 'msg' && method === 'getOnLineDev') { api.listenerMethods.msg.onLineDev([{ instanceId: 1, clientType: 7, devUid: 'phone' }]); return { result: 0 }; }
        assert.fail('Unexpected native method');
    };
    api = createExtendedQueries2(c, { fetchImpl: async input => {
        const url = new URL(input);
        if (url.hostname === 'ssl.ptlogin2.qq.com') return new Response('', { status: 302, headers: [['Location', 'https://qun.qq.com/'],
            ['Set-Cookie', 'uin=o12345; Domain=qq.com; Path=/; Secure'], ['Set-Cookie', 'skey=SECRET; Domain=qq.com; Path=/; Secure']] });
        return new Response(url.pathname === '/' ? 'landing' : JSON.stringify(page([member()])));
    }, native: { available: () => true, async run(_capture, request) {
        const prepared = fixed.prepare(request.operation, request.request);
        const body = request.operation === 'user.status' ? wire.messageField(1, [wire.varintField(1, request.request.uin),
            wire.messageField(2, [wire.messageField(1, [wire.varintField(1, 27372), wire.varintField(2, 1)])])]) : Buffer.alloc(0);
        return fixed.decode(Buffer.concat([wire.varintField(1, prepared.command), wire.varintField(2, prepared.sub), wire.varintField(3, 0), wire.bytesField(4, body)]), prepared);
    } } });
    const service = new OneBotService({ store: { find: () => null }, backend: { async call(method, params, options) {
        if (method === 'status') return { ready: true, epoch: c.epoch, self: c.self, capabilities: api.capabilities() };
        if (method === 'extendedQuery2') return api.query(params, { expiresAt: Date.now() + options.timeoutMs });
        assert.fail('Unexpected backend method');
    } } });
    for (const [action, params, expected] of [['nc_get_user_status', { user_id: 10001 }, { status: 10, ext_status: 0 }],
        ['get_group_todo_list', { group_id: 20001 }, []], ['get_group_signed_list', { group_id: 20001 }, [{ user_id: 10001, nick: '成员0', time: 1700000000, rank: 1 }]],
        ['get_online_clients', {}, { clients: [{ instance_id: 1, client_type: 7, device_uid: 'phone', device_kind: '手机' }] }]]) {
        const response = await service.action({ action, params });
        assert.equal(response.retcode, 0, JSON.stringify(response)); assert.deepEqual(response.data, expected);
    }
});
