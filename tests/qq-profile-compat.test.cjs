'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

function profileDetail(uid = 'u_real_456') {
    return { uin: '456', uid, simpleInfo: {
        coreInfo: { uin: '456', uid, nick: 'Private nickname', remark: 'Private remark' },
        baseInfo: { sex: 2, age: 25, longNick: 'Private signature', eMail: 'private@example.invalid' }
    }, commonExt: { college: 'Private school', constellation: 5 } };
}

function fixture(t) {
    const diagnostics = [];
    const profile = {
        getUidByUin(_source, uins) { return new Map(uins.map(uin => [uin, `u_real_${uin}`])); },
        getUinByUid(_source, uids) { return new Map(uids.map(uid => [uid, uid.slice('u_real_'.length)])); },
        async getUserDetailInfoByUin(uin) { assert.equal(uin, '456'); return { result: 0, detail: profileDetail() }; }
    };
    const session = { getProfileService() { return profile; } };
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, log: entry => diagnostics.push(entry) });
    const initialize = (uin = '123') => {
        capture.resetSession(session, { selfUin: uin, selfUid: `u_real_${uin}`, clientVer: TARGET_VERSION });
        capture.ready = true;
    };
    initialize();
    t.after(() => capture.close());
    return { capture, profile, diagnostics, initialize };
}

test('exact profile UIN and UID retain the existing path without masked schema diagnostics', async t => {
    const f = fixture(t);
    const value = await f.capture.call('user', { uid: 'u_real_456' });
    assert.equal(value.user_id, 456);
    assert.equal(value.nickname, 'Private nickname');
    assert.equal(value.school, 'Private school');
    assert.equal(f.diagnostics.length, 0);
});

test('UIN-bound masked profile IDs expose real fields without replacing the resolved kernel UID', async t => {
    const f = fixture(t);
    f.profile.getUserDetailInfoByUin = async () => ({ result: 0, detail: {
        ...profileDetail('u_***********_456'),
        simpleInfo: { ...profileDetail('u_***********_456').simpleInfo, uid: 'u_*_456', uin: 456 }
    } });
    const value = await f.capture.call('user', { uin: '456' });
    assert.equal(value.user_id, 456); assert.equal(value.sex, 'female'); assert.equal(value.age, 25);
    assert.equal(value.signature, 'Private signature'); assert.equal(value.constellation, 5);
    assert.equal(f.capture.forward.get('456'), 'u_real_456');
    assert.equal(f.capture.reverse.get('u_real_456'), '456');
    assert.equal([...f.capture.reverse.keys()].some(uid => uid.includes('*')), false);
    assert.equal(value.uid, 'u_real_456');
    assert.equal(value.uid.includes('*'), false);
});

test('unavailable optional profile sections stay unavailable while the actual identity remains required', async t => {
    const f = fixture(t);
    f.profile.getUserDetailInfoByUin = async () => ({ result: 0,
        detail: { uin: '456', uid: 'u_***_456', simpleInfo: { coreInfo: { nick: 'Name' }, baseInfo: null }, commonExt: null } });
    const value = await f.capture.call('user', { uin: '456' });
    assert.equal(value.user_id, 456); assert.equal(value.nickname, 'Name'); assert.equal(value.sex, 'unknown');
    assert.equal(Object.hasOwn(value, 'school'), false); assert.equal(Object.hasOwn(value, 'age'), false);
});

test('masked compatibility refuses missing identities, foreign UIN suffixes and nested identity conflicts', async t => {
    const f = fixture(t);
    const badDetails = [
        { ...profileDetail('u_***_456'), uin: undefined },
        { ...profileDetail('u_***_456'), uin: '789' },
        { ...profileDetail(), uid: undefined },
        ...['u_other', 'u_***_789', 'u_***456', 'u_fake*_456', 'u_***_0456', 'u__456', 'u_***_456\n', 'u_***_456_extra']
            .map(uid => ({ ...profileDetail(), uid })),
        { ...profileDetail('u_***_456'), simpleInfo: { ...profileDetail().simpleInfo, uin: '789' } },
        { ...profileDetail('u_***_456'), simpleInfo: { ...profileDetail().simpleInfo, uid: 'u_other' } },
        { ...profileDetail('u_***_456'), simpleInfo: { coreInfo: { uin: '789', uid: 'u_***_456' } } },
        { ...profileDetail('u_***_456'), simpleInfo: { coreInfo: { uin: '456', uid: 'u_other' } } },
        { ...profileDetail('u_***_456'), simpleInfo: { coreInfo: { uin: '456', uid: 'u_***_789' } } },
        { ...profileDetail('u_***_456'), simpleInfo: { baseInfo: { uin: '789' } } },
        { ...profileDetail('u_***_456'), commonExt: { uid: 'u_other' } },
        { ...profileDetail('u_***_456'), simpleInfo: [] },
        { ...profileDetail('u_***_456'), simpleInfo: { coreInfo: [] } }
    ];
    for (const detail of badDetails) {
        f.profile.getUserDetailInfoByUin = async () => ({ result: 0, detail });
        await assert.rejects(f.capture.call('user', { uin: '456' }), { code: 'INVALID_RESPONSE' });
        assert.equal(f.capture.forward.get('456'), 'u_real_456');
        assert.equal(f.capture.reverse.has('u_other'), false);
    }
    assert.equal(f.diagnostics.length, 0);
});

test('masked schema diagnostics are once per session and contain only keys and identity booleans', async t => {
    const f = fixture(t);
    f.profile.getUserDetailInfoByUin = async () => ({ result: 0, detail: profileDetail('u_***_456') });
    await f.capture.call('user', { uin: '456' });
    await f.capture.call('user', { uin: '456' });
    assert.equal(f.diagnostics.length, 1);
    assert.equal(f.diagnostics[0].code, 'USER_DETAIL_SCHEMA');
    const schema = JSON.parse(f.diagnostics[0].message);
    assert.equal(schema.detailUidMasked, true); assert.equal(schema.detailUidExact, false);
    assert.equal(schema.detailUinMatches, true); assert.equal(schema.coreUidMasked, true);
    for (const [key, value] of Object.entries(schema)) {
        if (key.endsWith('Keys')) assert.ok(Array.isArray(value) && value.every(item => typeof item === 'string'));
        else assert.equal(typeof value, 'boolean');
    }
    const output = JSON.stringify(f.diagnostics);
    for (const secret of ['u_***_456', 'u_real_456', 'Private nickname', 'Private remark', 'Private signature', 'private@example.invalid', 'Private school']) {
        assert.equal(output.includes(secret), false);
    }
    f.initialize('789');
    await f.capture.call('user', { uin: '456' });
    assert.equal(f.diagnostics.length, 2);
});

test('late profile completions after cancellation or account changes cannot normalize or log stale details', async t => {
    for (const mode of ['cancel', 'session']) {
        const f = fixture(t);
        let release, invoked;
        const started = new Promise(resolve => { invoked = resolve; });
        f.profile.getUserDetailInfoByUin = () => { invoked(); return new Promise(resolve => { release = resolve; }); };
        let normalized = 0;
        f.capture.simpleUser = () => { normalized++; throw new Error('Stale profile must not be normalized'); };
        const controller = new AbortController();
        const pending = f.capture.call('user', { uin: '456' }, { signal: controller.signal });
        const rejected = assert.rejects(pending, { code: mode === 'cancel' ? 'EXPIRED' : 'SESSION_CHANGED' });
        await started;
        if (mode === 'cancel') controller.abort(); else f.initialize('789');
        release({ result: 0, detail: profileDetail('u_***_456') });
        await rejected;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(normalized, 0); assert.equal(f.diagnostics.length, 0);
        if (mode === 'session') assert.equal(f.capture.forward.has('456'), false);
    }
});
