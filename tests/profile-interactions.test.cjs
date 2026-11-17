'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createInteractions } = require('../src/qq/interactions.cjs');
const { ACTIONS, REQUIREMENTS, runInteraction } = require('../src/onebot/interactions.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

function fixture(t) {
    const calls = [], values = { nickname: 'Original name', personalNote: 'Original signature', remark: 'Original group remark' };
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    capture.ready = true; capture.epoch = 'profile-generation-one'; capture.qqVersion = '3.2.35-54395';
    capture.self = { uin: '12345', uid: 'u_self' }; capture.session = {};
    const services = {
        profile: {
            getCoreAndBaseInfo(store, ids) {
                calls.push(['readSelf', store, [...ids]]);
                return new Map([['u_self', { uid: 'u_self', uin: '12345', coreInfo: { uid: 'u_self', nick: values.nickname },
                    baseInfo: { longNick: values.personalNote } }]]);
            },
            setNickName(value) { calls.push(['nickname', value]); values.nickname = value; },
            setLongNick(value) { calls.push(['signature', value]); values.personalNote = value; return { result: 0 }; }
        },
        group: {
            getGroupList() {},
            modifyGroupRemark(id, value) { calls.push(['remark', id, value]); values.remark = value; return { result: 0 }; }
        }
    };
    capture.service = name => { capture.ensureReady(); return services[name] || {}; };
    capture.groups = async params => { calls.push(['readGroups', { ...params }]); return [{ group_id: 56789, group_remark: values.remark }]; };
    const interactions = createInteractions(capture);
    const dispatch = (method, params, context) => interactions.dispatch(method, params, context);
    t.after(() => capture.close());
    return { capture, services, interactions, dispatch, calls, values };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('profile capabilities expose actual setters and readback methods, without advertising absent signatures', t => {
    const f = fixture(t);
    assert.equal(f.interactions.capabilities().selfProfile, true);
    assert.equal(f.interactions.capabilities().selfNickname, true);
    assert.equal(f.interactions.capabilities().selfSignature, true);
    assert.equal(f.interactions.capabilities().groupRemark, true);
    delete f.services.profile.setLongNick;
    assert.equal(f.interactions.capabilities().selfNickname, true);
    assert.equal(f.interactions.capabilities().selfSignature, false);
    delete f.services.profile.getCoreAndBaseInfo;
    assert.notEqual(f.interactions.capabilities().selfProfile, true);
    f.capture.qqVersion = 'unverified';
    assert.notEqual(f.interactions.capabilities().groupRemark, true);
});

test('nickname and signature updates query originals and verify exact self identity after each fixed setter', async t => {
    const f = fixture(t);
    const output = await f.dispatch('profile.update', { nickname: 'New nickname', personalNote: 'new\nsignature', expectedEpoch: f.capture.epoch });
    assert.deepEqual(output, { confirmed: true, uin: '12345', uid: 'u_self', nickname: 'New nickname', personalNote: 'new\nsignature',
        previous: { nickname: 'Original name', personalNote: 'Original signature' }, changed: true });
    assert.deepEqual(f.calls, [
        ['readSelf', 'nodeStore', ['u_self']], ['nickname', 'New nickname'], ['readSelf', 'nodeStore', ['u_self']],
        ['signature', 'new\nsignature'], ['readSelf', 'nodeStore', ['u_self']]
    ]);
});

test('unchanged real profile values and empty signatures are confirmed without unnecessary setters', async t => {
    const f = fixture(t);
    const same = await f.dispatch('profile.update', { nickname: f.values.nickname });
    assert.equal(same.changed, false); assert.deepEqual(f.calls.map(row => row[0]), ['readSelf']);
    const cleared = await f.dispatch('profile.update', { personalNote: '' });
    assert.equal(cleared.personalNote, ''); assert.equal(f.values.personalNote, '');
});

test('an empty profile update is a no-op without profile queries or setters', async t => {
    const f = fixture(t);
    delete f.services.profile.getCoreAndBaseInfo;
    delete f.services.profile.setNickName;
    delete f.services.profile.setLongNick;
    const output = await f.dispatch('profile.update', {});
    assert.deepEqual(output, { confirmed: true, changed: false, uin: '12345', uid: 'u_self', previous: {} });
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(f.dispatch('profile.update', {}, { signal: cancelled.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.dispatch('profile.update', {}, { expiresAt: Date.now() - 1 }), { code: 'EXPIRED' });
    assert.deepEqual(f.calls, []);
});

test('empty and whitespace nicknames are passed exactly once and require exact self readback', async t => {
    const f = fixture(t);
    for (const nickname of ['', '  ']) {
        f.calls.length = 0;
        const output = await f.dispatch('profile.update', { nickname });
        assert.equal(output.nickname, nickname); assert.equal(output.confirmed, true);
        assert.deepEqual(f.calls.map(row => row[0]), ['readSelf', 'nickname', 'readSelf']);
        assert.deepEqual(f.calls.find(row => row[0] === 'nickname'), ['nickname', nickname]);
    }
    f.services.profile.setNickName = () => {};
    await assert.rejects(f.dispatch('profile.update', { nickname: '' }, { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
});

test('every requested field and operation is validated before any native query or mutation', async t => {
    const f = fixture(t);
    for (const params of [{ nickname: null }, { nickname: 'x'.repeat(257) },
        { nickname: 'Valid', personalNote: 'x'.repeat(4097) }, { nickname: 'Valid', personalNote: undefined },
        { personalNote: 'bad\0note' }, { nickname: 'Valid', nativeMethod: 'execute' }, { sex: 3 }]) {
        await assert.rejects(f.dispatch('profile.update', params), { code: 'INVALID_PARAMS' });
    }
    for (const params of [{ groupId: '56789' }, { groupId: 0, remark: '' }, { groupId: '4294967296', remark: '' },
        { groupId: '056789', remark: '' }, { groupId: '56789', remark: null }, { groupId: '56789', remark: 'x'.repeat(1025) },
        { groupId: '56789', remark: 'bad\0remark' }, { groupId: '56789', remark: '', shell: 'invalid' }]) {
        await assert.rejects(f.dispatch('group.remark', params), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.length, 0);
});

test('missing one requested setter rejects the whole update before another field can be written', async t => {
    const f = fixture(t); delete f.services.profile.setLongNick;
    await assert.rejects(f.dispatch('profile.update', { nickname: 'New', personalNote: 'new signature' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.dispatch('profile.update', { nickname: 'New' })).confirmed, true);
});

test('wrong account maps, contradictory identities and missing original values block all profile mutation', async t => {
    const f = fixture(t);
    for (const value of [new Map(), {}, new Map([['u_self', { coreInfo: { nick: 'Old' } }]]),
        new Map([['u_self', { uid: 'u_other', coreInfo: { uid: 'u_self', nick: 'Old' } }]]),
        new Map([['u_self', { uid: 'u_self', uin: '98765', coreInfo: { nick: 'Old' } }]]),
        new Map([['u_self', { uid: 'u_self', coreInfo: { nick: null } }]]),
        new Map([['u_self', { uid: 'u_self', coreInfo: { nick: 'x'.repeat(257) } }]])]) {
        f.services.profile.getCoreAndBaseInfo = () => value;
        await assert.rejects(f.dispatch('profile.update', { nickname: 'New' }), { code: 'INVALID_RESPONSE' });
    }
    f.services.profile.getCoreAndBaseInfo = () => new Map([['u_self', { uid: 'u_self', coreInfo: { nick: 'Old' }, baseInfo: { uid: 'u_other', longNick: 'Old' } }]]);
    await assert.rejects(f.dispatch('profile.update', { personalNote: 'New' }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.length, 0);
});

test('void completions need actual readback and explicit rejected or malformed acknowledgements cannot become success', async t => {
    const f = fixture(t); let writes = 0;
    f.services.profile.setNickName = () => { writes++; };
    await assert.rejects(f.dispatch('profile.update', { nickname: 'New' }, { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    for (const outcome of [null, 0, true, {}, { result: 'bad' }, { result: 7 }, { result: 0, errorCode: 3 }]) {
        f.services.profile.setNickName = () => { writes++; return outcome; };
        await assert.rejects(f.dispatch('profile.update', { nickname: 'New' }));
    }
    assert.equal(writes, 8);
});

test('delayed nickname and signature snapshots are polled read-only and the second setter waits for the first confirmation', async t => {
    const f = fixture(t), originalRead = f.services.profile.getCoreAndBaseInfo;
    let pending, remainingReads = 0;
    f.services.profile.getCoreAndBaseInfo = (...args) => {
        if (pending && --remainingReads === 0) { f.values[pending.key] = pending.value; pending = null; }
        return originalRead(...args);
    };
    f.services.profile.setNickName = value => {
        f.calls.push(['nickname', value]); pending = { key: 'nickname', value }; remainingReads = 2;
    };
    f.services.profile.setLongNick = value => {
        assert.equal(pending, null); assert.equal(f.values.nickname, 'Eventually visible');
        f.calls.push(['signature', value]); pending = { key: 'personalNote', value }; remainingReads = 2;
        return { result: 0 };
    };
    const result = await f.dispatch('profile.update', { nickname: 'Eventually visible', personalNote: 'Delayed signature' });
    assert.equal(result.confirmed, true); assert.equal(result.nickname, 'Eventually visible');
    assert.equal(result.personalNote, 'Delayed signature');
    assert.deepEqual(result.previous, { nickname: 'Original name', personalNote: 'Original signature' });
    assert.deepEqual(f.calls.map(row => row[0]), ['readSelf', 'nickname', 'readSelf', 'readSelf', 'signature', 'readSelf', 'readSelf']);
});

test('profile polling accepts a later exact snapshot without resending after an intermediate stale value', async t => {
    const f = fixture(t), originalRead = f.services.profile.getCoreAndBaseInfo;
    let changed = false, readsAfterWrite = 0, writes = 0;
    f.services.profile.setNickName = () => { writes++; changed = true; };
    f.services.profile.getCoreAndBaseInfo = (...args) => {
        if (changed) f.values.nickname = ++readsAfterWrite < 2 ? 'Another cached value' : 'Exact requested value';
        return originalRead(...args);
    };
    const result = await f.dispatch('profile.update', { nickname: 'Exact requested value' });
    assert.equal(result.nickname, 'Exact requested value'); assert.equal(writes, 1); assert.equal(readsAfterWrite, 2);
});

test('an unconfirmed first field expires under the original deadline without sending the second field', async t => {
    const f = fixture(t); let nicknameWrites = 0, signatureWrites = 0;
    f.services.profile.setNickName = () => { nicknameWrites++; };
    f.services.profile.setLongNick = () => { signatureWrites++; };
    await assert.rejects(f.dispatch('profile.update', { nickname: 'Never visible', personalNote: 'Must not send' },
        { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await tick();
    assert.equal(nicknameWrites, 1); assert.equal(signatureWrites, 0);
    assert.equal(f.capture.pending.size, 0);
    assert.equal((await f.dispatch('profile.update', { nickname: 'Original name' })).changed, false);
});

test('a delayed second field times out as unknown confirmation instead of incorrectly reporting partial rejection', async t => {
    const f = fixture(t); let signatureWrites = 0;
    f.services.profile.setLongNick = value => { f.calls.push(['signature', value]); signatureWrites++; return { result: 0 }; };
    await assert.rejects(f.dispatch('profile.update', { nickname: 'Confirmed first', personalNote: 'Still pending' },
        { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    assert.equal(f.values.nickname, 'Confirmed first'); assert.equal(f.values.personalNote, 'Original signature');
    assert.equal(f.calls.filter(row => row[0] === 'nickname').length, 1); assert.equal(signatureWrites, 1);
});

test('same-profile writes stay locked during stale read polling while another target remains independent', async t => {
    const f = fixture(t), originalRead = f.services.profile.getCoreAndBaseInfo;
    let written = false, reads = 0;
    f.services.profile.setNickName = () => { written = true; f.calls.push(['nickname']); };
    f.services.profile.getCoreAndBaseInfo = (...args) => {
        if (written && ++reads === 2) f.values.nickname = 'Confirmed later';
        return originalRead(...args);
    };
    const pending = f.dispatch('profile.update', { nickname: 'Confirmed later' }); await tick();
    await assert.rejects(f.dispatch('profile.update', { personalNote: 'Overlapping' }), { code: 'BUSY' });
    assert.equal((await f.dispatch('group.remark', { groupId: '56789', remark: 'Original group remark' })).changed, false);
    assert.equal((await pending).confirmed, true);
    assert.equal(f.calls.filter(row => row[0] === 'nickname').length, 1);
});

test('cancellation during the poll delay clears its timer, stops reads and releases the completed setter lock', async t => {
    const f = fixture(t); let writes = 0;
    f.services.profile.setNickName = () => { writes++; };
    const controller = new AbortController();
    const pending = f.dispatch('profile.update', { nickname: 'Pending', personalNote: 'Must not send' }, { signal: controller.signal });
    await tick();
    assert.deepEqual(f.calls.map(row => row[0]), ['readSelf', 'readSelf']);
    controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' }); await tick();
    const readCount = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 275));
    assert.equal(f.calls.length, readCount); assert.equal(writes, 1); assert.equal(f.capture.pending.size, 0);
    assert.equal((await f.dispatch('profile.update', { personalNote: 'New request' })).confirmed, true);
});

test('a pending confirmation read holds the target after timeout and cannot later send another field', async t => {
    const f = fixture(t), originalRead = f.services.profile.getCoreAndBaseInfo;
    let written = false, complete, writes = 0;
    f.services.profile.setNickName = () => { written = true; writes++; };
    f.services.profile.getCoreAndBaseInfo = (...args) => written
        ? new Promise(resolve => { complete = () => resolve(originalRead(...args)); }) : originalRead(...args);
    await assert.rejects(f.dispatch('profile.update', { nickname: 'Pending', personalNote: 'Must not send' },
        { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await assert.rejects(f.dispatch('profile.update', { personalNote: 'Overlap' }), { code: 'BUSY' });
    complete(); await tick();
    assert.equal(writes, 1); assert.equal(f.calls.filter(row => row[0] === 'signature').length, 0);
    f.services.profile.getCoreAndBaseInfo = originalRead;
    assert.equal((await f.dispatch('profile.update', { personalNote: 'After read settles' })).confirmed, true);
});

test('session replacement during polling suppresses old reads and the second setter without corrupting new locks', async t => {
    const f = fixture(t); let writes = 0;
    f.services.profile.setNickName = () => { writes++; };
    const pending = f.dispatch('profile.update', { nickname: 'Old session', personalNote: 'Must not send' }); await tick();
    f.capture.epoch = 'profile-generation-two'; f.capture.session = {};
    assert.equal((await f.dispatch('profile.update', { personalNote: 'New session value' })).confirmed, true);
    await assert.rejects(pending, { code: 'SESSION_CHANGED' });
    assert.equal(writes, 1); assert.equal(f.calls.filter(row => row[0] === 'signature').length, 1);
    assert.equal(f.values.personalNote, 'New session value');
});

test('a failed second field reports partial completion, sends once, and never rolls back or retries', async t => {
    const f = fixture(t);
    f.services.profile.setLongNick = value => { f.calls.push(['signature', value]); return { result: 7 }; };
    await assert.rejects(f.dispatch('profile.update', { nickname: 'New name', personalNote: 'New signature' }), { code: 'PARTIAL_RESULT' });
    assert.equal(f.values.nickname, 'New name'); assert.equal(f.values.personalNote, 'Original signature');
    assert.equal(f.calls.filter(row => row[0] === 'nickname').length, 1);
    assert.equal(f.calls.filter(row => row[0] === 'signature').length, 1);
});

test('profile target remains locked after timeout until the unknown native operation settles', async t => {
    const f = fixture(t); let complete, writes = 0;
    f.services.profile.setNickName = () => { writes++; return new Promise(resolve => { complete = resolve; }); };
    await assert.rejects(f.dispatch('profile.update', { nickname: 'New' }, { expiresAt: Date.now() + 25 }), { code: 'TIMEOUT' });
    await assert.rejects(f.dispatch('profile.update', { personalNote: 'Next' }), { code: 'BUSY' });
    assert.equal(writes, 1);
    complete(); await tick();
    assert.equal((await f.dispatch('profile.update', { personalNote: 'Next' })).confirmed, true);
    assert.equal(writes, 1);
});

test('expired or cancelled reads cannot later dispatch profile modifications', async t => {
    const f = fixture(t); let complete;
    const original = f.services.profile.getCoreAndBaseInfo;
    f.services.profile.getCoreAndBaseInfo = (...args) => new Promise(resolve => { complete = () => resolve(original(...args)); });
    const controller = new AbortController();
    const pending = f.dispatch('profile.update', { nickname: 'New' }, { signal: controller.signal });
    await tick(); controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' });
    complete(); await tick();
    assert.equal(f.calls.filter(row => row[0] === 'nickname').length, 0);
    const expired = new AbortController(); expired.abort();
    await assert.rejects(f.dispatch('profile.update', { nickname: 'New' }, { signal: expired.signal }), { code: 'EXPIRED' });
});

test('session change rejects late confirmations and retires old profile locks without clearing newer locks', async t => {
    const f = fixture(t); let complete;
    f.services.profile.setNickName = () => new Promise(resolve => { complete = resolve; });
    const pending = f.dispatch('profile.update', { nickname: 'New' }); await tick();
    f.capture.epoch = 'profile-generation-two'; f.capture.session = {};
    assert.equal((await f.dispatch('profile.update', { personalNote: 'New generation' })).confirmed, true);
    complete(); await assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await assert.rejects(f.dispatch('profile.update', { nickname: 'Other', expectedEpoch: 'profile-generation-one' }), { code: 'SESSION_CHANGED' });
});

test('group remark uses a forced original snapshot, fixed setter and forced matching readback', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.dispatch('group.remark', { groupId: '56789', remark: '' }), {
        confirmed: true, groupId: '56789', remark: '', previous: 'Original group remark', changed: true
    });
    assert.deepEqual(f.calls, [['readGroups', { refresh: true }], ['remark', '56789', ''], ['readGroups', { refresh: true }]]);
    f.calls.length = 0;
    assert.equal((await f.dispatch('group.remark', { groupId: '56789', remark: '' })).changed, false);
    assert.equal(f.calls.length, 1);
});

test('missing, duplicate and unverified group remark originals stop the mutation', async t => {
    const f = fixture(t);
    for (const list of [undefined, [], [{ group_id: 98765, group_remark: 'Other group' }],
        [{ group_id: 56789 }], [{ group_id: 56789, group_remark: 'x'.repeat(1025) }],
        [{ group_id: 56789, group_remark: '' }, { group_id: 56789, group_remark: '' }]]) {
        f.capture.groups = async () => list;
        await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'New' }));
    }
    assert.equal(f.calls.length, 0);
});

test('group remark requires explicit business success and actual final value, with no automatic retry', async t => {
    const f = fixture(t); let writes = 0;
    for (const outcome of [undefined, 0, {}, { result: 4 }, { result: 0 }]) {
        f.services.group.modifyGroupRemark = () => { writes++; return outcome; };
        await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'New' }, { expiresAt: Date.now() + 40 }));
    }
    assert.equal(writes, 5);
});

test('group remark polls forced snapshots until the acknowledged value is visible and sends the setter once', async t => {
    const f = fixture(t); let written = false, reads = 0, writes = 0;
    f.services.group.modifyGroupRemark = (id, value) => {
        assert.equal(id, '56789'); assert.equal(value, 'Delayed remark');
        written = true; writes++; return { result: 0 };
    };
    f.capture.groups = async params => {
        assert.deepEqual(params, { refresh: true }); f.calls.push(['readGroups']);
        if (written && ++reads === 2) f.values.remark = 'Delayed remark';
        return [{ group_id: 56789, group_remark: f.values.remark }];
    };
    const result = await f.dispatch('group.remark', { groupId: '56789', remark: 'Delayed remark' });
    assert.deepEqual(result, { confirmed: true, groupId: '56789', remark: 'Delayed remark', previous: 'Original group remark', changed: true });
    assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(f.calls.length, 3);
});

test('group polling retains the target lock without blocking another group while waiting for readback', async t => {
    const f = fixture(t); let written = false, reads = 0, writes = 0;
    f.services.group.modifyGroupRemark = () => { written = true; writes++; return { result: 0 }; };
    f.capture.groups = async () => {
        if (written && ++reads === 3) f.values.remark = 'Later';
        return [{ group_id: 56789, group_remark: f.values.remark }, { group_id: 67890, group_remark: 'Unchanged' }];
    };
    const pending = f.dispatch('group.remark', { groupId: '56789', remark: 'Later' }); await tick();
    await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'Overlap' }), { code: 'BUSY' });
    assert.equal((await f.dispatch('group.remark', { groupId: '67890', remark: 'Unchanged' })).changed, false);
    assert.equal((await pending).confirmed, true); assert.equal(writes, 1);
});

test('unconfirmed group snapshots expire without resending or leaving an active polling timer', async t => {
    const f = fixture(t); let writes = 0;
    f.services.group.modifyGroupRemark = () => { writes++; return { result: 0 }; };
    await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'Never confirmed' },
        { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await tick(); const reads = f.calls.length;
    await new Promise(resolve => setTimeout(resolve, 275));
    assert.equal(f.calls.length, reads); assert.equal(writes, 1); assert.equal(f.capture.pending.size, 0);
    assert.equal((await f.dispatch('group.remark', { groupId: '56789', remark: 'Original group remark' })).changed, false);
});

test('cancelling group readback polling stops further reads and allows a separate later operation', async t => {
    const f = fixture(t); let writes = 0;
    f.services.group.modifyGroupRemark = () => { writes++; return { result: 0 }; };
    const controller = new AbortController();
    const pending = f.dispatch('group.remark', { groupId: '56789', remark: 'Not visible' }, { signal: controller.signal });
    await tick(); controller.abort(); await assert.rejects(pending, { code: 'EXPIRED' }); await tick();
    assert.equal(writes, 1); assert.equal(f.calls.filter(row => row[0] === 'readGroups').length, 2);
    assert.equal((await f.dispatch('group.remark', { groupId: '56789', remark: 'Original group remark' })).confirmed, true);
    assert.equal(writes, 1);
});

test('a hanging forced group readback keeps the target locked after timeout until its native query settles', async t => {
    const f = fixture(t); let written = false, complete, writes = 0;
    f.services.group.modifyGroupRemark = () => { written = true; writes++; return { result: 0 }; };
    f.capture.groups = async () => written ? new Promise(resolve => { complete = () => resolve([{ group_id: 56789, group_remark: 'Late' }]); })
        : [{ group_id: 56789, group_remark: 'Original group remark' }];
    await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'Late' },
        { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'Overlap' }), { code: 'BUSY' });
    complete(); await tick();
    f.capture.groups = async () => [{ group_id: 56789, group_remark: 'Late' }];
    assert.equal((await f.dispatch('group.remark', { groupId: '56789', remark: 'Late' })).changed, false);
    assert.equal(writes, 1);
});

test('different group targets are independent while same-target pending writes cannot overlap', async t => {
    const f = fixture(t); let complete;
    f.capture.groups = async () => [{ group_id: 56789, group_remark: f.values.remark }, { group_id: 67890, group_remark: 'Already' }];
    f.services.group.modifyGroupRemark = () => new Promise(resolve => { complete = resolve; });
    const pending = f.dispatch('group.remark', { groupId: '56789', remark: 'New' }); await tick();
    await assert.rejects(f.dispatch('group.remark', { groupId: '56789', remark: 'Next' }), { code: 'BUSY' });
    assert.equal((await f.dispatch('group.remark', { groupId: '67890', remark: 'Already' })).confirmed, true);
    f.values.remark = 'New'; complete({ result: 0 }); await pending;
});

test('real Capture interaction RPC waits for synchronous native group snapshots before and after the remark', async t => {
    const f = fixture(t); delete f.capture.groups;
    f.services.group.getGroupList = force => {
        f.calls.push(['nativeGroups', force]);
        f.capture.bus.emit('groups', [{ groupCode: '56789', groupName: 'Test group', remarkName: f.values.remark }]);
        return { result: 0 };
    };
    const output = await f.capture.call('interaction', { operation: 'group.remark', groupId: '56789',
        remark: 'New native remark', expectedEpoch: f.capture.epoch });
    assert.equal(output.confirmed, true); assert.equal(output.previous, 'Original group remark');
    assert.deepEqual(f.calls, [['nativeGroups', true], ['remark', '56789', 'New native remark'], ['nativeGroups', true]]);
    assert.equal(f.capture.bus.listenerCount('groups'), 0); assert.equal(f.capture.queries.size, 0);
});

test('timed out group snapshots retire their waiter and cannot dispatch a late remark', async t => {
    const f = fixture(t); delete f.capture.groups;
    f.services.group.getGroupList = () => ({ result: 0 });
    await assert.rejects(f.capture.call('interaction', { operation: 'group.remark', groupId: '56789', remark: 'New',
        expectedEpoch: f.capture.epoch }, { expiresAt: Date.now() + 25 }), { code: 'TIMEOUT' });
    f.capture.bus.emit('groups', [{ groupCode: '56789', groupName: 'Late', remarkName: 'Old' }]); await tick();
    assert.equal(f.calls.filter(row => row[0] === 'remark').length, 0);
    assert.equal(f.capture.bus.listenerCount('groups'), 0); assert.equal(f.capture.queries.size, 0);
});

test('session replacement while the group setter is pending suppresses confirmation and further queries', async t => {
    const f = fixture(t); let complete;
    f.services.group.modifyGroupRemark = () => new Promise(resolve => { complete = resolve; });
    const pending = f.dispatch('group.remark', { groupId: '56789', remark: 'New' }); await tick();
    f.capture.self = { uin: '54321', uid: 'u_other' };
    complete({ result: 0 }); await assert.rejects(pending, { code: 'SESSION_CHANGED' });
    assert.equal(f.calls.filter(row => row[0] === 'readGroups').length, 1);
});

function onebotFixture() {
    const state = { epoch: 'onebot-profile', self: { uin: '12345', uid: 'u_self' },
        capabilities: { selfProfile: true, selfNickname: true, selfSignature: true, groupRemark: true } };
    const calls = [];
    const service = { async sessionCall(received, method, params) {
        assert.equal(received, state); calls.push([method, structuredClone(params)]);
        return params.operation === 'profile.update'
            ? { confirmed: true, changed: true, uid: 'u_self', uin: '12345',
                ...(Object.hasOwn(params, 'nickname') ? { nickname: params.nickname } : {}),
                ...(Object.hasOwn(params, 'personalNote') ? { personalNote: params.personalNote } : {}),
                previous: { nickname: 'Old', personalNote: '' } }
            : { confirmed: true, changed: true, groupId: params.groupId, remark: params.remark, previous: '' };
    } };
    return { state, calls, service, run: (action, params) => runInteraction(service, state, action, params) };
}

test('OneBot interaction module has fixed actions and translates profile fields without exposing kernel methods', async () => {
    const f = onebotFixture();
    assert.deepEqual([...ACTIONS], ['set_qq_profile', 'set_group_remark']);
    assert.deepEqual(REQUIREMENTS, { set_qq_profile: 'selfProfile', set_group_remark: 'groupRemark' });
    assert.equal(await f.run('set_qq_profile', { nickname: 'New', personal_note: '' }), null);
    assert.equal(await f.run('set_group_remark', { group_id: 56789, remark: '' }), null);
    assert.deepEqual(f.calls, [['interaction', { operation: 'profile.update', nickname: 'New', personalNote: '' }],
        ['interaction', { operation: 'group.remark', groupId: '56789', remark: '' }]]);
});

test('OneBot profile no-input is a no-op and empty nickname is forwarded without coercion', async () => {
    const f = onebotFixture();
    f.state.capabilities = {};
    assert.equal(await f.run('set_qq_profile', {}), null);
    assert.equal(await f.run('set_qq_profile', { self_id: 12345 }), null);
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.run('set_qq_profile', { self_id: 54321 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.run('set_qq_profile', { nickname: undefined }), { code: 'INVALID_PARAMS' });
    f.state.capabilities = { selfProfile: true, selfNickname: true };
    assert.equal(await f.run('set_qq_profile', { nickname: '' }), null);
    assert.deepEqual(f.calls, [['interaction', { operation: 'profile.update', nickname: '' }]]);
});

test('public profile no-input returns null with echo after identity checks and never dispatches a modification', async () => {
    const calls = [], state = { ready: true, epoch: 'no-input-profile', self: { uin: '12345', uid: 'u_self' }, capabilities: {} };
    const service = new OneBotService({ store: {}, backend: { async call(method) {
        calls.push(method); assert.equal(method, 'status'); return structuredClone(state);
    } } });
    assert.deepEqual(await service.action({ action: 'set_qq_profile', params: {}, echo: 'no-input' }),
        { status: 'ok', retcode: 0, data: null, echo: 'no-input' });
    assert.deepEqual(calls, ['status']);
    assert.equal((await service.action({ action: 'set_qq_profile', params: { self_id: 12345 } })).retcode, 0);
    assert.equal((await service.action({ action: 'set_qq_profile', params: { nickname: undefined } })).retcode, 1400);
    assert.equal((await service.action({ action: 'set_qq_profile', params: { self_id: 54321 } })).retcode, 1400);
    assert.equal((await service.action({ action: 'set_qq_profile', params: {} }, { epoch: 'old', selfUin: '12345' })).retcode, 1503);
    state.ready = false;
    assert.equal((await service.action({ action: 'set_qq_profile', params: {} })).retcode, 1503);
    assert.equal(calls.every(method => method === 'status'), true);
});

test('public empty nickname reaches the real profile updater and succeeds only after matching self readback', async t => {
    const f = fixture(t), methods = [];
    const service = new OneBotService({ store: {}, backend: { async call(method, params, options) {
        methods.push(method);
        if (method === 'status') return { ready: true, epoch: f.capture.epoch,
            self: structuredClone(f.capture.self), capabilities: f.interactions.capabilities() };
        assert.equal(method, 'interaction');
        return f.capture.interaction(params, { expiresAt: Date.now() + options.timeoutMs });
    } } });
    for (const nickname of ['', '  ']) {
        f.calls.length = 0; methods.length = 0;
        const response = await service.action({ action: 'set_qq_profile', params: { nickname } });
        assert.deepEqual(response, { status: 'ok', retcode: 0, data: null });
        assert.equal(methods.filter(method => method === 'interaction').length, 1);
        assert.deepEqual(f.calls.map(row => row[0]), ['readSelf', 'nickname', 'readSelf']);
        assert.equal(f.values.nickname, nickname);
    }
});

test('OneBot rejects invalid or unsupported compound changes before the backend can perform a partial action', async () => {
    const f = onebotFixture();
    for (const params of [{ nickname: 'New', personal_note: null }, { nickname: 'New', sex: 3 },
        { personal_note: 'x'.repeat(4097) }, { nickname: 'New', self_id: '54321' }]) {
        await assert.rejects(f.run('set_qq_profile', params), { code: 'INVALID_PARAMS' });
    }
    for (const params of [{ group_id: 'u_group', remark: '' }, { group_id: 56789 }, { group_id: 56789, remark: '', native: 'raw' }]) {
        await assert.rejects(f.run('set_group_remark', params), { code: 'INVALID_PARAMS' });
    }
    f.state.capabilities.selfSignature = false;
    await assert.rejects(f.run('set_qq_profile', { nickname: 'New', personal_note: 'New' }), { code: 'UNSUPPORTED' });
    f.state.capabilities.groupRemark = false;
    await assert.rejects(f.run('set_group_remark', { group_id: 56789, remark: '' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('OneBot never converts missing, wrong-identity or wrong-value confirmations into successful actions', async () => {
    const f = onebotFixture(); let value, calls = 0;
    f.service.sessionCall = async () => { calls++; return value; };
    for (value of [undefined, {}, { confirmed: true },
        { confirmed: true, changed: true, uin: '54321', uid: 'u_self', nickname: 'New', previous: { nickname: 'Old' } },
        { confirmed: true, changed: true, uin: '12345', uid: 'u_other', nickname: 'New', previous: { nickname: 'Old' } },
        { confirmed: true, changed: true, uin: '12345', uid: 'u_self', nickname: 'Wrong', previous: { nickname: 'Old' } }]) {
        await assert.rejects(f.run('set_qq_profile', { nickname: 'New' }), { code: 'INVALID_RESPONSE' });
    }
    value = { confirmed: true, changed: true, groupId: '67890', remark: '', previous: '' };
    await assert.rejects(f.run('set_group_remark', { group_id: 56789, remark: '' }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 7);
});
