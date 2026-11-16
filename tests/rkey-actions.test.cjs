'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRkeyActions } = require('../src/onebot/rkey-actions.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const { decodeHttpParameter } = require('../src/onebot/parameter-schema.cjs');
function fixture() {
    const now = Math.floor(Date.now() / 1000), calls = [];
    const state = { self: { uin: '12345', uid: 'u_self' }, epoch: 'e1', ready: true, capabilities: { downloadRkey: true } };
    const result = { rkeys: [{ type: 10, rkey: 'private-test-only', rkeyTtlSec: 1200, rkeyCreateTime: now - 100 },
        { type: 20, rkey: 'group-test-only', rkeyTtlSec: 600, rkeyCreateTime: now - 100 }] };
    const service = { remaining: () => 7000, async sessionCall(bound, method, params) { calls.push({ bound, method, params }); return result; },
        async assertSession(bound) { assert.equal(bound, state); } };
    return { state, result, calls, service, invoke: (action, params = {}) => runRkeyActions(service, state, action, params) };
}
test('download-key projections retain the server lifetime and account-bound native route', async () => {
    const f = fixture(), list = await f.invoke('get_rkey');
    assert.deepEqual(list.map(entry => entry.type), [10, 20]);
    const server = await f.invoke('get_rkey_server');
    assert.equal(server.expired_time, list[1].create_time + list[1].ttl);
    assert.equal(server.private_rkey, list[0].rkey);
    assert.equal(server.name, 'Freshwater-dolphin');
    assert.equal(f.calls[0].method, 'nativeRkey');
    assert.deepEqual(f.calls[0].params, { expectedUin: '12345', via: 'native', timeoutMs: 7000 });
});
test('download-key actions fail closed on missing, stale, duplicate or unsafe key metadata', async () => {
    for (const change of [entry => { delete entry.rkeyTtlSec; }, entry => { entry.rkeyCreateTime = 1; },
        entry => { entry.rkeyCreateTime = Number.MAX_SAFE_INTEGER; }, entry => { entry.rkeyTtlSec = 1n; },
        entry => { entry.rkey = 'unsafe\nvalue'; }, entry => { entry.type = 20; }]) {
        const f = fixture(); change(f.result.rkeys[0]);
        await assert.rejects(f.invoke('get_rkey'), { code: 'INVALID_RESPONSE' });
    }
    const f = fixture(); f.result.rkeys = [];
    await assert.rejects(f.invoke('get_rkey_server'), { code: 'INVALID_RESPONSE' });
});
test('download-key requests cannot select another account, command, raw body or route', async () => {
    for (const params of [{ self_id: '54321' }, { command: 'any' }, { url: 'https://example.org' }, { via: 'js' }]) {
        const f = fixture(); await assert.rejects(f.invoke('get_rkey', params), { code: 'INVALID_PARAMS' }); assert.equal(f.calls.length, 0);
    }
    const f = fixture(); f.state.capabilities.downloadRkey = false;
    await assert.rejects(f.invoke('get_rkey'), { code: 'UNSUPPORTED' });
});
test('multi-flag compatibility capabilities require every current-session dependency', () => {
    const state = { ready: true, self: { uin: '12345', uid: 'u_self' }, capabilities: { friendCategorySet: true } };
    const available = name => capabilities(state).extensions.find(entry => entry.name === name).available;
    assert.equal(available('set_friends_category'), false);
    state.capabilities.friendCategories = true;
    assert.equal(available('set_friends_category'), true);
    state.ready = false;
    assert.equal(available('set_friends_category'), false);
    assert.equal(decodeHttpParameter('uin', '12345'), 12345);
    assert.equal(decodeHttpParameter('categoryId', '0'), 0);
    assert.equal(decodeHttpParameter('refresh', 'false'), false);
    assert.equal(decodeHttpParameter('code', '0014'), '0014');
    assert.deepEqual(decodeHttpParameter('user_id', '[12345,54321]', 'set_group_kick_members'), [12345, 54321]);
    assert.equal(decodeHttpParameter('user_id', '[12345,54321]', 'get_stranger_info'), '[12345,54321]');
    assert.equal(decodeHttpParameter('user_id', '12345', 'get_stranger_info'), 12345);
});
