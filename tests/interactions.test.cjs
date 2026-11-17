'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createInteractions } = require('../src/qq/interactions.cjs');

function allowance(extra = {}) {
    return { errCode: 0, atInfo: { canAtAll: false, RemainAtAllCountForUin: 0,
        RemainAtAllCountForGroup: 7, atTimesMsg: '', canNotAtAllMsg: '今日额度不足', ...extra } };
}
function fixture(t, services = {}) {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    capture.ready = true; capture.epoch = 'generation-one'; capture.qqVersion = '3.2.35-54395';
    capture.self = { uin: '12345', uid: 'u_self' }; capture.session = {};
    capture.service = name => { capture.ensureReady(); return services[name] || {}; };
    const interactions = createInteractions(capture);
    t.after(() => capture.close());
    return { capture, interactions, services };
}
const deadline = () => ({ expiresAt: Date.now() + 1000 });

test('interaction availability is based on the current compatible session and actual services', t => {
    const f = fixture(t, { group: { getGroupRemainAtTimes() {} }, profileLike: { setBuddyProfileLike() {} } });
    assert.deepEqual(f.interactions.capabilities(), { profileLike: true, groupAtAllRemain: true });
    f.capture.qqVersion = 'unsupported';
    assert.deepEqual(f.interactions.capabilities(), { profileLike: false, groupAtAllRemain: false });
    f.capture.qqVersion = '3.2.35-54395'; f.capture.ready = false;
    assert.deepEqual(f.interactions.capabilities(), { profileLike: false, groupAtAllRemain: false });
});

test('likes call the fixed kernel contract once with no paid likes and an explicit full result', async t => {
    const calls = [];
    const f = fixture(t, { profileLike: { setBuddyProfileLike(value) { calls.push(value); return Promise.resolve({ result: 0, succCounts: 2 }); } } });
    assert.deepEqual(await f.interactions.dispatch('profile.like', { uid: 'u_target', count: 2 }), { uid: 'u_target', count: 2, confirmed: true });
    assert.deepEqual(calls, [{ friendUid: 'u_target', sourceId: 71, doLikeCount: 2, doLikeTollCount: 0 }]);
});

test('omitted count defaults to one while supplied invalid counts and raw UINs are rejected before dispatch', async t => {
    let calls = 0;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { calls++; return { result: '0', succCounts: 1 }; } } });
    assert.equal((await f.interactions.dispatch('profile.like', { uid: 'u_target' })).count, 1);
    for (const count of [null, -1, 11, 1.5, '1', true, NaN, Infinity]) {
        await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', count }), { code: 'INVALID_PARAMS' });
    }
    for (const uid of [12345, '12345', '', 'u_', 'u_bad space', 'u_' + 'a'.repeat(200)]) {
        await assert.rejects(f.interactions.dispatch('profile.like', { uid }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(calls, 1);
});

test('partial likes, void completions and malformed acknowledgements never become success or trigger retries', async t => {
    const outcomes = [undefined, null, true, 0, {}, { result: 0 }, { result: 0, succCounts: '2' },
        { result: 0, succCounts: 3 }, { result: 0, succCounts: -1 }, { result: 'bad', succCounts: 2 }];
    let calls = 0, output;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { calls++; return output; } } });
    for (output of outcomes) await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', count: 2 }), { code: 'INVALID_RESPONSE' });
    output = { result: 0, succCounts: 1 };
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', count: 2 }), { code: 'PARTIAL_RESULT' });
    output = { result: 9, succCounts: 2 };
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', count: 2 }), { code: 'KERNEL_ERROR' });
    output = { result: '9', succCounts: 2 };
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', count: 2 }), { code: 'KERNEL_ERROR' });
    assert.equal(calls, outcomes.length + 3);
});

test('native like exceptions are reported after exactly one invocation', async t => {
    let calls = 0;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { calls++; throw new Error('native failure'); } } });
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }), /native failure/);
    assert.equal(calls, 1);
});

test('concurrent likes for one target are rejected while different targets remain independent', async t => {
    let complete;
    const calls = [];
    const f = fixture(t, { profileLike: { setBuddyProfileLike(value) {
        calls.push(value.friendUid);
        return value.friendUid === 'u_target' ? new Promise(resolve => { complete = resolve; }) : { result: 0, succCounts: 1 };
    } } });
    const first = f.interactions.dispatch('profile.like', { uid: 'u_target' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }), { code: 'BUSY' });
    assert.equal((await f.interactions.dispatch('profile.like', { uid: 'u_other' })).confirmed, true);
    complete({ result: 0, succCounts: 1 }); await first;
    assert.deepEqual(calls, ['u_target', 'u_other']);
});

test('timed out native likes keep their target locked until native settlement and never repeat automatically', async t => {
    let calls = 0, complete;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { calls++; return new Promise(resolve => { complete = resolve; }); } } });
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }, { expiresAt: Date.now() + 20 }), { code: 'TIMEOUT' });
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }), { code: 'BUSY' });
    assert.equal(calls, 1);
    complete({ result: 0, succCounts: 1 }); await new Promise(resolve => setImmediate(resolve));
    f.services.profileLike.setBuddyProfileLike = () => { calls++; return { result: 0, succCounts: 1 }; };
    assert.equal((await f.interactions.dispatch('profile.like', { uid: 'u_target' })).confirmed, true);
    assert.equal(calls, 2);
});

test('stale session identities cannot confirm a like and old target locks do not cross generations', async t => {
    let complete;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { return new Promise(resolve => { complete = resolve; }); } } });
    const old = f.interactions.dispatch('profile.like', { uid: 'u_target' });
    await new Promise(resolve => setImmediate(resolve));
    f.capture.epoch = 'generation-two'; f.capture.session = {};
    f.services.profileLike.setBuddyProfileLike = () => ({ result: 0, succCounts: 1 });
    assert.equal((await f.interactions.dispatch('profile.like', { uid: 'u_target' })).confirmed, true);
    complete({ result: 0, succCounts: 1 }); await assert.rejects(old, { code: 'SESSION_CHANGED' });
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target', expectedEpoch: 'generation-one' }), { code: 'SESSION_CHANGED' });
});

test('cancelled or expired interactions do not reach the kernel', async t => {
    let calls = 0;
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { calls++; } } });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    assert.equal(calls, 0);
});

test('at-all allowance preserves real zero counters, false permission and empty text', async t => {
    const calls = [];
    const f = fixture(t, { group: { getGroupRemainAtTimes(value) { calls.push(value); return allowance(); } } });
    assert.deepEqual(await f.interactions.dispatch('group.atAllRemain', { groupId: 12345 }), {
        group_id: 12345, can_at_all: false, remain_at_all_count_for_uin: 0,
        remain_at_all_count_for_group: 7, at_times_msg: '', can_not_at_all_msg: '今日额度不足'
    });
    assert.deepEqual(calls, ['12345']);
});

test('allowance requires every native field and explicit kernel success without inventing defaults', async t => {
    let value;
    const f = fixture(t, { group: { getGroupRemainAtTimes() { return value; } } });
    for (value of [undefined, null, {}, { atInfo: allowance().atInfo }, { errCode: 0 }, allowance({ canAtAll: 1 }),
        allowance({ RemainAtAllCountForUin: '0' }), allowance({ RemainAtAllCountForUin: -1 }),
        allowance({ RemainAtAllCountForGroup: Number.MAX_SAFE_INTEGER }), allowance({ atTimesMsg: undefined }),
        allowance({ canNotAtAllMsg: null }), allowance({ atTimesMsg: 'x'.repeat(16385) })]) {
        await assert.rejects(f.interactions.dispatch('group.atAllRemain', { groupId: '12345' }), { code: 'INVALID_RESPONSE' });
    }
    value = { errCode: 4, atInfo: allowance().atInfo };
    await assert.rejects(f.interactions.dispatch('group.atAllRemain', { groupId: '12345' }), { code: 'KERNEL_ERROR' });
});
test('group identifiers and fixed operation fields are validated before any kernel invocation', async t => {
    let calls = 0;
    const f = fixture(t, { group: { getGroupRemainAtTimes() { calls++; return allowance(); } } });
    for (const groupId of [0, -1, 1.5, '01', ' 12345', 'u_group', '4294967296', {}, true]) {
        await assert.rejects(f.interactions.dispatch('group.atAllRemain', { groupId }), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(f.interactions.dispatch('group.atAllRemain', { groupId: 12345, method: 'arbitrary' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.interactions.dispatch('group.atAllRemain', []), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.interactions.dispatch('unknown', {}), { code: 'UNSUPPORTED' });
    assert.equal(calls, 0);
});

test('missing services are explicit unsupported results for each fixed operation', async t => {
    const f = fixture(t);
    await assert.rejects(f.interactions.dispatch('profile.like', { uid: 'u_target' }), { code: 'UNSUPPORTED' });
    await assert.rejects(f.interactions.dispatch('group.atAllRemain', { groupId: '12345' }), { code: 'UNSUPPORTED' });
});

test('late allowance results from a different identity or QQ generation are rejected', async t => {
    let complete;
    const f = fixture(t, { group: { getGroupRemainAtTimes() { return new Promise(resolve => { complete = resolve; }); } } });
    const pending = f.interactions.dispatch('group.atAllRemain', { groupId: '12345' });
    await new Promise(resolve => setImmediate(resolve));
    f.capture.self = { uin: '54321', uid: 'u_other_self' };
    complete(allowance()); await assert.rejects(pending, { code: 'SESSION_CHANGED' });
});

test('capture shutdown retires pending interaction calls without reporting successful delivery', async t => {
    const f = fixture(t, { profileLike: { setBuddyProfileLike() { return new Promise(() => {}); } } });
    const pending = f.interactions.dispatch('profile.like', { uid: 'u_target' }, deadline());
    await new Promise(resolve => setImmediate(resolve)); f.capture.close();
    await assert.rejects(pending, { code: 'NOT_READY' });
});
