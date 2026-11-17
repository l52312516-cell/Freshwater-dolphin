'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

function fixture(t) {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    t.after(() => capture.close());
    capture.ready = true; capture.epoch = 'kick-session'; capture.qqVersion = '3.2.35-54395';
    capture.self = { uin: '123', uid: 'u_123' };
    const members = new Map([['u_123', { uid: 'u_123', uin: '123', role: 3, isDelete: false }],
        ['u_456', { uid: 'u_456', uin: '456', role: 2, isDelete: false }]]);
    const calls = [];
    const group = {
        async getAllMemberList(groupId, refresh) {
            calls.push({ method: 'list', groupId, refresh });
            return { errCode: 0, result: { finish: true,
                ids: [...members.keys()].map((uid, index) => ({ uid, index })), infos: new Map([...members].map(([uid, row]) => [uid, { ...row }])) } };
        },
        async kickMember(...args) { calls.push({ method: 'kick', args }); members.delete(args[1][0]); }
    };
    const profile = {
        getUidByUin(_source, values) { return new Map(values.map(uin => [uin, 'u_' + uin])); },
        getUinByUid(_source, values) { return new Map(values.map(uid => [uid, uid.slice(2)])); }
    };
    capture.session = { getGroupService: () => group, getProfileService: () => profile };
    const params = { operation: 'kick', groupId: '200', uin: '456', rejectAddRequest: false, reason: '', expectedEpoch: capture.epoch };
    return { capture, members, calls, group, params };
}

test('native kick sends once and requires exact member disappearance in a complete forced refresh', async t => {
    const f = fixture(t);
    assert.equal(f.capture.state().capabilities.groupKick, true);
    assert.deepEqual(await f.capture.call('groupAction', f.params), { confirmed: true });
    assert.deepEqual(f.calls, [{ method: 'list', groupId: '200', refresh: true },
        { method: 'kick', args: ['200', ['u_456'], false, ''] }, { method: 'list', groupId: '200', refresh: true }]);
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'NOT_FOUND' });
    assert.equal(f.calls.filter(x => x.method === 'kick').length, 1);
});

test('kick target absent before dispatch is not presented as a successful removal', async t => {
    const f = fixture(t); f.members.delete('u_456');
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'NOT_FOUND' });
    assert.equal(f.calls.some(x => x.method === 'kick'), false);
});

test('kick accepts explicit zero dispatch codes only when a refreshed snapshot confirms absence', async t => {
    for (const result of [{ result: 0 }, { errCode: 0, errMsg: '' }, { result: 0, errCode: 0 }]) {
        const f = fixture(t); let sent = 0;
        f.group.kickMember = async () => { sent++; f.members.delete('u_456'); return result; };
        assert.deepEqual(await f.capture.call('groupAction', f.params), { confirmed: true });
        assert.equal(sent, 1); assert.equal(f.calls.filter(x => x.method === 'list').length, 2);
    }
});

test('explicit failure and conflicting native dispatch codes never become a success or cause a retry', async t => {
    for (const result of [{ result: 1 }, { errCode: 1 }, { result: 0, errCode: 1 }, { result: 1, errCode: 0 },
        { retCode: 1 }, { retCode: '1' }, new Error('native failure')]) {
        const f = fixture(t); let sent = 0;
        f.group.kickMember = async () => { sent++; return result; };
        await assert.rejects(f.capture.call('groupAction', f.params), { code: 'KERNEL_ERROR' });
        assert.equal(sent, 1); assert.equal(f.calls.filter(x => x.method === 'list').length, 1);
    }
});

test('opaque native completions and request numbers require real disappearance before success', async t => {
    for (const result of [null, 42, 'request-42', {}, { requestId: 42 }, { result: { requestId: 42 } }]) {
        const f = fixture(t); let sent = 0;
        f.group.kickMember = async () => { sent++; f.members.delete('u_456'); return result; };
        assert.deepEqual(await f.capture.call('groupAction', f.params), { confirmed: true });
        assert.equal(sent, 1); assert.equal(f.calls.filter(x => x.method === 'list').length, 2);
    }
});

test('opaque native completion without disappearance still times out without resending', async t => {
    for (const result of [null, 42, { requestId: 42 }]) {
        const f = fixture(t); let sent = 0;
        f.group.kickMember = async () => { sent++; return result; };
        await assert.rejects(f.capture.call('groupAction', f.params, { expiresAt: Date.now() + 25 }),
            error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(sent, 1);
    }
});

test('kick snapshots reject incomplete identities, duplicate accounts and unrelated records before dispatch', async t => {
    for (const mutate of [r => { r.result.finish = false; }, r => { r.result.ids.push({ uid: 'u_456' }); },
        r => { r.result.infos.get('u_456').uin = '123'; }, r => { r.result.infos.get('u_456').uid = 'u_wrong'; },
        r => { r.result.infos.delete('u_456'); }, r => { r.result.ids = ['u_123', 'u_456']; },
        r => { r.result.infos.get('u_456').isDelete = true; }, r => { r.result.infos.get('u_456').role = 9; }]) {
        const f = fixture(t), original = f.group.getAllMemberList;
        f.group.getAllMemberList = async (...args) => { const result = await original(...args); mutate(result); return result; };
        await assert.rejects(f.capture.call('groupAction', f.params), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.some(x => x.method === 'kick'), false);
    }
});

test('kick checks actor and target roles and cannot silently remove the acting account', async t => {
    for (const [selfRole, targetRole] of [[2, 2], [3, 3], [3, 4], [4, 4]]) {
        const f = fixture(t); f.members.get('u_123').role = selfRole; f.members.get('u_456').role = targetRole;
        await assert.rejects(f.capture.call('groupAction', f.params), { code: 'UNSUPPORTED' });
        assert.equal(f.calls.some(x => x.method === 'kick'), false);
    }
    const f = fixture(t);
    await assert.rejects(f.capture.call('groupAction', { ...f.params, uin: '123' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('kick rejects invalid parameters and missing verification methods without dispatch', async t => {
    const f = fixture(t);
    for (const patch of [{ rejectAddRequest: 'false' }, { reason: '\0' }, { reason: 'x'.repeat(1025) }, { uin: '4294967296' }]) {
        await assert.rejects(f.capture.call('groupAction', { ...f.params, ...patch }), { code: 'INVALID_PARAMS' });
    }
    delete f.group.getAllMemberList;
    assert.equal(f.capture.state().capabilities.groupKick, false);
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('a void kick without observed disappearance times out and never retries the mutation', async t => {
    const f = fixture(t); let sent = 0;
    f.group.kickMember = async () => { sent++; };
    await assert.rejects(f.capture.call('groupAction', f.params, { expiresAt: Date.now() + 25 }),
        error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sent, 1); assert.equal(f.capture.memberMutations.size, 0);
});

test('a late native completion after cancellation cannot perform another query or removal', async t => {
    const f = fixture(t); let release, sent = 0;
    f.group.kickMember = () => { sent++; return new Promise(resolve => { release = resolve; }); };
    const controller = new AbortController();
    const task = f.capture.call('groupAction', f.params, { signal: controller.signal });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(task, { code: 'EXPIRED' });
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent, 1); assert.equal(f.calls.length, 1); assert.equal(f.capture.memberMutations.size, 0);
});

test('a session switch during native removal cannot confirm against the next account', async t => {
    const f = fixture(t); let sent = 0;
    f.group.kickMember = async () => { sent++; f.capture.epoch = 'next-session'; };
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'SESSION_CHANGED' });
    assert.equal(sent, 1); assert.equal(f.calls.length, 1);
});

test('a failed or malformed post-kick snapshot never becomes a confirmed result or a second kick', async t => {
    const f = fixture(t); let sent = 0;
    f.group.kickMember = async () => { sent++; f.group.getAllMemberList = async () => ({ errCode: 0, result: { finish: false } }); };
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'INVALID_RESPONSE' });
    assert.equal(sent, 1);
});

test('concurrent mutations for the same member cannot dispatch two native removals', async t => {
    const f = fixture(t); let release, sent = 0;
    f.group.kickMember = () => { sent++; return new Promise(resolve => { release = () => { f.members.delete('u_456'); resolve(); }; }); };
    const first = f.capture.call('groupAction', f.params);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.capture.call('groupAction', f.params), { code: 'BUSY' });
    release(); assert.deepEqual(await first, { confirmed: true }); assert.equal(sent, 1);
});

test('OneBot kick preserves echo and maps typed parameters into the fixed account-bound mutation', async t => {
    const f = fixture(t);
    const service = new OneBotService({ backend: { call: (method, params, options) => f.capture.call(method, params,
        { expiresAt: Date.now() + options.timeoutMs }) }, store: {} });
    const result = await service.action({ action: 'set_group_kick', params: { group_id: 200, user_id: 456,
        reject_add_request: true, reason: 'test removal' }, echo: { number: 5 } });
    assert.deepEqual(result, { status: 'ok', retcode: 0, data: null, echo: { number: 5 } });
    assert.deepEqual(f.calls.find(x => x.method === 'kick').args, ['200', ['u_456'], true, 'test removal']);
});

test('OneBot kick refuses invalid booleans before any native query or write', async t => {
    const f = fixture(t);
    const service = new OneBotService({ backend: { call: (method, params) => f.capture.call(method, params) }, store: {} });
    assert.equal((await service.action({ action: 'set_group_kick', params: { group_id: 200, user_id: 456, reject_add_request: 'false' } })).retcode, 1400);
    assert.equal(f.calls.length, 0);
});
