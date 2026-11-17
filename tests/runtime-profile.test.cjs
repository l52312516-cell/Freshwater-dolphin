'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { BASELINE, BASELINE_PROFILE_ID, normalizeRuntimeSelection, evaluateRuntimeIdentity, permitsMethod } = require('../src/qq/runtime-profile.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
const native = require('../src/qq/msf-native.cjs');
const { selectRuntime, inspectQQTree } = require('../tools/qq-runtime-entry.cjs');
const temporary = path.resolve(__dirname, '../work/temp');
function directory(t) { fs.mkdirSync(temporary, { recursive: true }); const root = fs.mkdtempSync(path.join(temporary, 'runtime-profile-'));
    t.after(() => { assert.ok(root.startsWith(temporary + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }); return root; }
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

test('runtime selections retain old defaults and reject malformed or executable-looking fields', () => {
    assert.deepEqual(normalizeRuntimeSelection(), { packageId: null, profileId: BASELINE_PROFILE_ID, experimental: false });
    const previous = { packageId: 'qq-candidate', profileId: 'linux-x64-3.2.36-70000', experimental: true };
    assert.deepEqual(normalizeRuntimeSelection(undefined, previous), previous);
    assert.deepEqual(normalizeRuntimeSelection({ experimental: false }, previous), { ...previous, experimental: false });
    for (const value of [null, [], { packageId: '../bad' }, { packageId: 'a/b' }, { experimental: 'true' }, { profileId: 'a\nb' }, { command: 'echo x' }])
        assert.throws(() => normalizeRuntimeSelection(value), { code: 'INVALID_CONFIG' });
});
test('exact native eligibility requires both known hashes and the Linux guest architecture and complete build', () => {
    const exact = evaluateRuntimeIdentity(BASELINE); assert.equal(exact.native_eligible, true); assert.equal(exact.admission, 'stable');
    for (const changes of [{ packageSha256: undefined }, { wrapperSha256: undefined }, { packageSha256: 'a'.repeat(64) },
        { wrapperSha256: 'b'.repeat(64) }, { platform: 'win32' }, { architecture: 'arm64' }, { qqVersion: '3.2.35' }, { profileId: 'another-profile' }]) {
        const value = evaluateRuntimeIdentity({ ...BASELINE, ...changes }); assert.equal(value.native_eligible, false); assert.equal(value.evidence, 'unverified');
    }
    assert.equal(evaluateRuntimeIdentity({ ...BASELINE, wrapperSha256: undefined }).admission, 'legacy-unverified');
    assert.equal(evaluateRuntimeIdentity({ ...BASELINE, wrapperSha256: 'b'.repeat(64) }).admission, 'denied');
});
test('unknown Linux builds need opt-in and cannot dispatch non-text mutations or mention elements', () => {
    const value = { ...BASELINE, qqVersion: '3.2.36-70000', profileId: 'candidate', packageSha256: 'a'.repeat(64) };
    assert.equal(evaluateRuntimeIdentity(value).admission, 'denied');
    const candidate = evaluateRuntimeIdentity({ ...value, experimental: true }); assert.equal(candidate.admission, 'experimental-basic');
    for (const method of ['friends', 'groups', 'groupInfo', 'getMessage', 'history']) assert.equal(permitsMethod(candidate, method), true);
    for (const method of ['groupAction', 'recall', 'nativeRkey', 'rawPacket', 'voiceExtra', 'prepareMedia']) assert.equal(permitsMethod(candidate, method), false);
    const elements = [{ elementType: 1, textElement: { content: 'test', atType: 0 } }];
    assert.equal(permitsMethod(candidate, 'sendMessage', { elements }), true);
    assert.equal(permitsMethod(candidate, 'sendMessage', { elements: [...elements, { elementType: 2, picElement: {} }] }), false);
    assert.equal(permitsMethod(candidate, 'sendMessage', { elements: [{ elementType: 1, textElement: { content: '@all', atType: 1 } }] }), false);
});
test('structural probes stay independent of version admission and denied calls fail before kernel dispatch', async () => {
    let writes = 0;
    const capture = new Capture({ install: false, processObject: { env: {}, platform: 'linux', arch: 'x64' } });
    capture.qqVersion = '3.2.36-70000'; capture.ready = true; capture.self = { uin: '123', uid: 'u_self' };
    capture.session = { getGroupService: () => ({ modifyGroupName() { writes++; } }) };
    try {
        assert.equal(capture.hasMethods('group', ['modifyGroupName']), true);
        await assert.rejects(capture.call('groupAction', { operation: 'name', groupId: '200', name: 'changed' }), error => error.code === 'UNSUPPORTED' && error.diagnostic.reason === 'runtime_profile_denied');
        capture.runtimeIdentity.experimental = true;
        await assert.rejects(capture.call('groupAction', { operation: 'name', groupId: '200', name: 'changed' }), error => error.diagnostic.reason === 'experimental_operation_disabled');
        assert.equal(writes, 0);
        assert.equal(capture.state().capabilities.groupName, false);
    } finally { capture.close(); }
});
test('production native channel refuses unknown identity before loading or installing a hook', async () => {
    const capture = { epoch: 'one', self: { uin: '123' }, runtimeProfile: () => evaluateRuntimeIdentity({ ...BASELINE, wrapperSha256: undefined }) };
    assert.equal(native.available(capture), false);
    await assert.rejects(native.run(capture, { op: 'fetchRkey', timeoutMs: 100 }), error => error.code === 'UNSUPPORTED' && error.diagnostic.reason === 'native_profile_mismatch');
});
test('capabilities do not transfer baseline evidence by version number or fabricated evidence labels', () => {
    const state = { qqVersion: BASELINE.qqVersion, ready: true, self: { uin: '123', uid: 'u_self' }, capabilities: { privateFileUrl: true } };
    const find = value => value.extensions.find(item => item.name === 'get_private_file_url');
    assert.equal(find(capabilities(state)).runtime_verification, 'unverified');
    assert.equal(find(capabilities(state)).target_validation, undefined);
    const profile = evaluateRuntimeIdentity(BASELINE);
    assert.equal(find(capabilities({ ...state, runtime_profile: profile })).runtime_verification, 'historical-scope');
    assert.equal(find(capabilities({ ...state, runtime_profile: { ...profile, package_sha256: null } })).target_validation, undefined);
    assert.equal(find(capabilities({ ...state, qqVersion: '3.2.36-70000', runtime_profile: profile })).target_validation, undefined);
});
test('package repository selection pins the manifest, actual package digest and exact declared build', t => {
    const root = directory(t), base = path.join(root, 'work/qq-packages/candidate'); fs.mkdirSync(base, { recursive: true });
    const bytes = Buffer.from('synthetic-deb'), packageSha256 = digest(bytes), selection = { packageId: 'candidate', profileId: 'linux-x64-3.2.36-70000', experimental: true };
    fs.writeFileSync(path.join(base, 'QQ.deb'), bytes);
    fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...selection, architecture: 'x64', qqVersion: '3.2.36-70000', packageSha256, wrapperSha256: 'a'.repeat(64) }));
    const configFile = path.join(root, 'config.json'); fs.writeFileSync(configFile, JSON.stringify({ qqRuntime: selection }));
    const options = { root, configFile, readMetadata: () => ({ architecture: 'amd64', version: '3.2.36-70000' }) };
    assert.equal(selectRuntime(options).packageSha256, packageSha256);
    assert.throws(() => selectRuntime({ ...options, readMetadata: () => ({ architecture: 'amd64', version: '3.2.36-70001' }) }), /version or architecture/);
    fs.writeFileSync(path.join(base, 'QQ.deb'), 'changed'); assert.throws(() => selectRuntime(options), /SHA256 mismatch/);
});
test('private QQ tree inspection rejects ambiguous wrappers and build changes before bootstrap', t => {
    const root = directory(t), app = path.join(root, 'opt/QQ/resources/app'), wrapper = Buffer.from('synthetic-wrapper'); fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '3.2.36', buildVersion: '70000', platform: 'linux', eleArch: 'x64' }));
    fs.writeFileSync(path.join(app, 'wrapper.node'), wrapper);
    assert.equal(inspectQQTree(root, { expectedVersion: '3.2.36-70000', expectedWrapperHash: digest(wrapper) }).wrapperSha256, digest(wrapper));
    assert.throws(() => inspectQQTree(root, { expectedVersion: '3.2.36-70001' }), /identity/);
    assert.throws(() => inspectQQTree(root, { expectedVersion: '3.2.36-70000', expectedWrapperHash: 'f'.repeat(64) }), /SHA256/);
    fs.mkdirSync(path.join(app, 'other')); fs.writeFileSync(path.join(app, 'other/wrapper.node'), wrapper);
    assert.throws(() => inspectQQTree(root, { expectedVersion: '3.2.36-70000' }), /one identifiable/);
});
