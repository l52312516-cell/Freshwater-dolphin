'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OneBotService } = require('../src/onebot/service.cjs');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

test('known unavailable actions retain their fixed name without dispatching a business operation', async () => {
    let calls = 0;
    const logs = [];
    const state = { ready: true, epoch: 'live', self: { uin: '3000000002', uid: 'u_self' }, capabilities: {} };
    const service = new OneBotService({ backend: { call(method) { if (method === 'status') return state; calls++; throw new Error('must not run'); } },
        store: {}, logger: (event, details) => logs.push({ event, ...details }) });
    for (const [action, params] of [['get_msg_emoji_likes', { message_id: 1 }], ['set_group_anonymous_ban', {}], ['bot_exit', {}], ['send_packet', { cmd: 'Test.Request' }]]) {
        const response = await service.action({ action, params, echo: { action } });
        assert.equal(response.retcode, 1404);
        assert.deepEqual(response.echo, { action });
        assert.equal(logs.at(-1).action, action);
        assert.equal(logs.at(-1).stage, 'validate');
    }
    assert.equal(calls, 0);
});

test('unknown action names remain absent from diagnostic logs even when they look like identifiers', async () => {
    const logs = [];
    const service = new OneBotService({ backend: { call() { throw new Error('must not run'); } },
        store: {}, logger: (event, details) => logs.push({ event, ...details }) });
    const secret = 'private_token_disguised_as_an_action';
    const response = await service.action({ action: secret });
    assert.equal(response.retcode, 1404);
    assert.equal(logs[0].action, 'unsupported');
    assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('forward RPC cannot act without the expected authenticated session epoch', async t => {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: TARGET_VERSION });
    t.after(() => capture.close());
    capture.ready = true; capture.session = {}; capture.self = { uin: '3000000002', uid: 'u_self' };
    let dispatched = 0;
    capture.forwardApi.run = async () => { dispatched++; return {}; };
    for (const expectedEpoch of [undefined, 'retired-epoch']) {
        await assert.rejects(capture.call('forwardOperation', { kind: 'forward', expectedEpoch }), { code: 'SESSION_CHANGED' });
    }
    assert.equal(dispatched, 0);
    await capture.call('forwardOperation', { kind: 'forward', expectedEpoch: capture.epoch });
    assert.equal(dispatched, 1);
});

test('group-list no_cache requests reach the native refresh boundary and reject string booleans', async () => {
    const calls = [];
    const state = { ready: true, epoch: 'live', self: { uin: '3000000002', uid: 'u_self' } };
    const service = new OneBotService({ store: {}, backend: { async call(method, params) {
        calls.push({ method, params }); return method === 'status' ? state : [];
    } } });
    const refreshed = await service.action({ action: 'get_group_list', params: { no_cache: true } });
    assert.equal(refreshed.status, 'ok');
    assert.deepEqual(calls.find(call => call.method === 'groups').params, { refresh: true, expectedEpoch: 'live' });
    calls.length = 0;
    assert.equal((await service.action({ action: 'get_group_list', params: { no_cache: 'true' } })).retcode, 1400);
    assert.equal(calls.length, 0);
});
