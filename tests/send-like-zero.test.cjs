'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
    const calls = [], nativeCalls = [], handlers = {};
    const services = {
        profile: {
            getUidByUin(_source, uins) { return new Map(uins.map(uin => [uin, 'u_target'])); },
            getUinByUid(_source, uids) { return new Map(uids.map(uid => [uid, '45678'])); }
        },
        profileLike: {
            setBuddyProfileLike(value) {
                nativeCalls.push(structuredClone(value));
                return handlers.like ? handlers.like(value) : { result: 0, succCounts: value.doLikeCount };
            }
        }
    };
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    capture.ready = true; capture.online = true; capture.epoch = 'zero-like-session';
    capture.qqVersion = TARGET_VERSION; capture.self = { uin: '12345', uid: 'u_self' };
    capture.session = { getProfileService: () => services.profile, getProfileLikeService: () => services.profileLike };
    const backend = { async call(method, params = {}, context = {}) {
        if (method !== 'status') calls.push({ method, params: structuredClone(params) });
        const value = await capture.call(method, params, { expiresAt: Date.now() + (context.timeoutMs ?? 1000) });
        return handlers.backend ? handlers.backend(method, value) : value;
    } };
    const service = new OneBotService({ backend, store: {} });
    const action = params => service.action({ action: 'send_like', params: { user_id: 45678, ...params } });
    const native = (params = {}, context = {}) => capture.call('interaction', { operation: 'profile.like',
        uid: 'u_target', count: 0, expectedEpoch: capture.epoch, ...params }, { expiresAt: Date.now() + 1000, ...context });
    t.after(() => capture.close());
    return { capture, calls, nativeCalls, handlers, service, action, native };
}

test('send_like forwards numeric and canonical string zero through real Capture as one native zero request', async t => {
    const f = fixture(t);
    for (const times of [0, '0']) {
        const result = await f.action({ times });
        assert.equal(result.status, 'ok', result.message); assert.equal(result.retcode, 0); assert.equal(result.data, null);
    }
    assert.deepEqual(f.calls.map(call => call.method), ['resolve', 'interaction', 'resolve', 'interaction']);
    assert(f.calls.filter(call => call.method === 'interaction').every(call => call.params.count === 0));
    assert.deepEqual(f.nativeCalls, Array.from({ length: 2 }, () => ({ friendUid: 'u_target', sourceId: 71,
        doLikeCount: 0, doLikeTollCount: 0 })));
});

test('zero compatibility retains default one, maximum ten and exact typed input boundaries', async t => {
    const f = fixture(t);
    for (const params of [{}, { times: 10 }]) assert.equal((await f.action(params)).status, 'ok');
    assert.deepEqual(f.nativeCalls.map(value => value.doLikeCount), [1, 10]);
    f.calls.length = 0; f.nativeCalls.length = 0;
    for (const times of [11, 20, -1, 0.5, null, true, [], {}, '00', '0.0', ' 0 ', '0e0']) {
        const result = await f.action({ times });
        assert.equal(result.status, 'failed'); assert.equal(result.retcode, 1400);
    }
    for (const count of [11, -1, 0.5, null, true, '0', NaN, Infinity]) {
        await assert.rejects(f.native({ count }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls.length, 0);
});

test('native zero requires explicit result success and exact numeric succCounts zero without retry', async t => {
    const f = fixture(t);
    for (const result of [0, '0']) {
        f.handlers.like = () => ({ result, succCounts: 0 });
        assert.deepEqual(await f.native(), { uid: 'u_target', count: 0, confirmed: true });
    }
    const invalid = [undefined, {}, { result: 0 }, { result: 0, succCounts: '0' }, { result: 0, succCounts: 1 },
        { result: 0, succCounts: -1 }, { result: 7, succCounts: 0 }];
    for (const value of invalid) {
        const before = f.nativeCalls.length;
        f.handlers.like = () => value;
        await assert.rejects(f.native(), { code: value?.result === 7 ? 'KERNEL_ERROR' : 'INVALID_RESPONSE' });
        assert.equal(f.nativeCalls.length, before + 1);
    }
    f.handlers.like = () => undefined;
    const publicResult = await f.action({ times: 0 });
    assert.equal(publicResult.status, 'failed'); assert.equal(publicResult.retcode, 1500);
});

test('OneBot zero rejects a conflicting confirmed identity or count after one native request', async t => {
    const f = fixture(t);
    for (const change of [value => ({ ...value, count: 1 }), value => ({ ...value, uid: 'u_other' }),
        value => ({ ...value, confirmed: false })]) {
        f.handlers.backend = (method, value) => method === 'interaction' ? change(value) : value;
        const before = f.nativeCalls.length, result = await f.action({ times: 0 });
        assert.equal(result.status, 'failed'); assert.equal(result.retcode, 1500);
        assert.equal(f.nativeCalls.length, before + 1);
    }
});

test('a timed-out zero request keeps its target locked until native settlement', async t => {
    const f = fixture(t); let finish;
    f.handlers.like = () => new Promise(resolve => { finish = resolve; });
    await assert.rejects(f.native({}, { expiresAt: Date.now() + 30 }), { code: 'TIMEOUT' });
    await assert.rejects(f.native(), { code: 'BUSY' });
    assert.equal(f.nativeCalls.length, 1); assert.equal(f.nativeCalls[0].doLikeCount, 0);
    finish({ result: 0, succCounts: 0 }); await turn();
    f.handlers.like = () => ({ result: 0, succCounts: 0 });
    assert.equal((await f.native()).confirmed, true); assert.equal(f.nativeCalls.length, 2);
});

test('zero requests preserve session guards and old completions cannot confirm a new account', async t => {
    const f = fixture(t); let finish;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.native({}, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.native({ expectedEpoch: 'retired-session' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.native({}, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    assert.equal(f.nativeCalls.length, 0);
    f.handlers.like = () => new Promise(resolve => { finish = resolve; });
    const old = f.native(); old.catch(() => {}); await turn();
    f.capture.epoch = 'replacement-session';
    f.capture.session = { ...f.capture.session };
    f.handlers.like = () => ({ result: 0, succCounts: 0 });
    assert.equal((await f.native()).confirmed, true);
    finish({ result: 0, succCounts: 0 });
    await assert.rejects(old, { code: 'SESSION_CHANGED' });
    assert.equal(f.nativeCalls.length, 2);
});
