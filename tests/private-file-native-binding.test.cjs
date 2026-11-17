'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const native = require('../src/qq/msf-native.cjs');

function fixture(t, resource = {}) {
    const capture = new Capture({ install: false, processObject: { env: {} } });
    Object.assign(capture, { ready: true, online: true, qqVersion: TARGET_VERSION,
        epoch: 'binding-epoch', self: { uin: '12345', uid: 'u_self' } });
    const file = { fileUuid: 'private-file-id', file10MMd5: 'opaque.Hash+/=非MD5', ...resource };
    const record = { chatType: 1, peerUid: 'u_peer', msgId: '18446744073709551612',
        elements: [{ elementType: 3, elementId: '18446744073709551613', fileElement: file }] };
    let getMessageCalls = 0, getResult = () => ({ result: 0, msgList: [record] }), startLookup;
    const lookupStarted = new Promise(resolve => { startLookup = resolve; });
    capture.session = { getMsgService: () => ({ getMsgsByMsgId: () => {
        getMessageCalls++; startLookup(); return getResult();
    } }) };
    const nativeCalls = [], result = { fileId: file.fileUuid, url: 'https://download.qq.com/fixture' };
    t.mock.method(native, 'run', async (cap, params) => {
        assert.equal(cap, capture); nativeCalls.push(params); return result;
    });
    const params = { peer: { chatType: 1, peerUid: 'u_peer' }, nativeId: record.msgId,
        elementId: record.elements[0].elementId, expectedEpoch: capture.epoch, expectedUin: capture.self.uin,
        expectedFileId: file.fileUuid, expectedFileHash: file.file10MMd5 };
    t.after(() => capture.close());
    return { capture, record, file, params, nativeCalls, lookupStarted, result,
        get getMessageCalls() { return getMessageCalls; }, set getResult(value) { getResult = value; } };
}

test('private file expected binding must be a complete valid pair before native message reads', async t => {
    const id = 'private-file-id', hash = 'opaque.Hash+/=非MD5';
    const cases = [
        ['UUID only', { expectedFileId: id }], ['hash only', { expectedFileHash: hash }],
        ['both undefined', { expectedFileId: undefined, expectedFileHash: undefined }],
        ['undefined UUID', { expectedFileId: undefined, expectedFileHash: hash }],
        ['undefined hash', { expectedFileId: id, expectedFileHash: undefined }]
    ];
    for (const [name, value] of [['null', null], ['empty', ''], ['number', 1], ['control', 'bad\nvalue'],
        ['DEL', 'bad\x7fvalue'], ['unpaired high surrogate', '\ud800'], ['unpaired low surrogate', '\udc00']]) {
        cases.push([`${name} UUID`, { expectedFileId: value, expectedFileHash: hash }],
            [`${name} hash`, { expectedFileId: id, expectedFileHash: value }]);
    }
    cases.push(['UUID over byte limit', { expectedFileId: '文'.repeat(342), expectedFileHash: hash }],
        ['hash over byte limit', { expectedFileId: id, expectedFileHash: '文'.repeat(1366) }],
        ['UUID over ASCII limit', { expectedFileId: 'x'.repeat(1025), expectedFileHash: hash }],
        ['hash over ASCII limit', { expectedFileId: id, expectedFileHash: 'x'.repeat(4097) }]);
    for (const [name, binding] of cases) await t.test(name, async nested => {
        const f = fixture(nested), { expectedFileId, expectedFileHash, ...locator } = f.params;
        await assert.rejects(f.capture.call('nativePrivateFileUrl', { ...locator, ...binding }), { code: 'INVALID_PARAMS' });
        assert.equal(f.getMessageCalls, 0); assert.equal(f.nativeCalls.length, 0);
    });
});

test('private file complete binding preserves exact opaque UTF8 input through native submission', async t => {
    for (const [name, resource] of [['opaque', { fileUuid: 'UUID+/=非规范', file10MMd5: ' opaque.Hash+/=非MD5 ' }],
        ['exact byte limits', { fileUuid: '文'.repeat(341) + 'x', file10MMd5: '文'.repeat(1365) + 'x' }]]) {
        await t.test(name, async nested => {
            const f = fixture(nested, resource);
            assert.deepEqual(await f.capture.call('nativePrivateFileUrl', f.params), f.result);
            assert.equal(f.getMessageCalls, 1); assert.equal(f.nativeCalls.length, 1);
            const call = f.nativeCalls[0];
            assert.equal(call.op, 'fetchPrivateFileUrl'); assert.equal(call.fileId, resource.fileUuid);
            assert.equal(call.fileHash, resource.file10MMd5); assert.equal(call.expectedEpoch, 'binding-epoch');
            assert.equal(call.expectedUin, '12345'); assert.ok(call.signal instanceof AbortSignal);
            assert.equal(Object.hasOwn(call, 'expectedFileId'), false);
            assert.equal(Object.hasOwn(call, 'expectedFileHash'), false);
        });
    }
});

test('private file reread cannot replace the bound UUID or opaque hash before SSO', async t => {
    const cases = [
        ['UUID changed', {}, { fileUuid: 'different-file-id' }],
        ['hash changed', {}, { file10MMd5: 'different-hash' }],
        ['opaque hash case changed', {}, { file10MMd5: 'opaque.hash+/=非MD5' }],
        ['hex hash case changed', { file10MMd5: 'a'.repeat(32) }, { file10MMd5: 'A'.repeat(32) }],
        ['hash trimmed', { file10MMd5: ' opaque ' }, { file10MMd5: 'opaque' }],
        ['UUID case changed', { fileUuid: 'File-ID' }, { fileUuid: 'file-id' }]
    ];
    for (const [name, original, replacement] of cases) await t.test(name, async nested => {
        const f = fixture(nested, original); Object.assign(f.file, replacement);
        await assert.rejects(f.capture.call('nativePrivateFileUrl', f.params), {
            code: 'INVALID_RESPONSE', message: 'QQ private file does not match the expected resource'
        });
        assert.equal(f.getMessageCalls, 1); assert.equal(f.nativeCalls.length, 0);
    });
});

test('private file legacy internal callers can omit both expected fields in normal or diagnostic mode', async t => {
    for (const diagnostic of [undefined, 'resource-metadata']) await t.test(diagnostic || 'normal', async nested => {
        const f = fixture(nested), { expectedFileId, expectedFileHash, ...params } = f.params;
        if (diagnostic) Object.assign(params, { diagnostic, transport: 'oidb' });
        assert.deepEqual(await f.capture.call('nativePrivateFileUrl', params), f.result);
        assert.equal(f.getMessageCalls, 1); assert.equal(f.nativeCalls.length, 1);
        assert.equal(f.nativeCalls[0].fileId, f.file.fileUuid); assert.equal(f.nativeCalls[0].fileHash, f.file.file10MMd5);
        assert.equal(f.nativeCalls[0].diagnostic, diagnostic);
    });
});

test('private file diagnostic mode cannot bypass an expected resource mismatch', async t => {
    const f = fixture(t); f.file.file10MMd5 = 'different-hash';
    await assert.rejects(f.capture.call('nativePrivateFileUrl', {
        ...f.params, diagnostic: 'resource-metadata', transport: 'oidb'
    }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.getMessageCalls, 1); assert.equal(f.nativeCalls.length, 0);
});

test('private file bound lookup never submits after session change, cancellation or late completion', async t => {
    for (const change of ['epoch', 'cancel', 'timeout']) await t.test(change, async nested => {
        const f = fixture(nested), controller = new AbortController(); let resolve;
        f.getResult = () => new Promise(done => { resolve = done; });
        const pending = f.capture.call('nativePrivateFileUrl', { ...f.params, timeoutMs: change === 'timeout' ? 20 : 1000 },
            { signal: controller.signal });
        await f.lookupStarted;
        const code = { epoch: 'SESSION_CHANGED', cancel: 'EXPIRED', timeout: 'TIMEOUT' }[change];
        const rejected = assert.rejects(pending, { code });
        if (change === 'epoch') {
            f.capture.epoch = 'another-epoch'; resolve({ result: 0, msgList: [f.record] });
        } else {
            if (change === 'cancel') controller.abort();
            await rejected; resolve({ result: 0, msgList: [f.record] });
        }
        await rejected; await new Promise(done => setImmediate(done));
        assert.equal(f.getMessageCalls, 1); assert.equal(f.nativeCalls.length, 0);
    });
});
