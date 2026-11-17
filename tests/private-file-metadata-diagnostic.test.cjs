'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const pfu = require('../src/qq/private-file-url.cjs');
const { varintField: n, bytesField: b, messageField: m, fields, one } = require('../src/qq/proto.cjs');
const native = require('../src/qq/msf-native.cjs');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const s = (tag, value) => b(tag, Buffer.from(value));
const expected = { fileId: 'PRIVATE_UUID_SECRET', fileHash: '0123456789abcdef0123456789abcdef' };
const routing = Buffer.concat([s(20, 'download.qq.com'), n(40, 80), s(50, '/PRIVATE_PATH?token=PRIVATE_SIGNED_URL')]);
function reply(metadata, { result = routing, status = 0 } = {}) {
    return Buffer.concat([n(1, 0xe37), n(2, 1200), n(3, 0), n(12, 0), m(4, [m(14, [n(10, status), b(30, result),
        ...(metadata === undefined ? [] : [b(40, metadata)])])])]);
}
const observe = (metadata, input = expected) => pfu.decodeResponse(reply(metadata), input, 'resource-metadata');
function assertClosed(value) {
    assert.equal(value.diagnosticOnly, true); assert.equal(value.diagnostic, 'resource-metadata'); assert.equal(value.businessSuccess, false);
    assert.equal(value.version, 2); assert.equal(typeof value.checks.directChecksumMatches, 'boolean');
    assert.deepEqual(Object.keys(value).sort(), ['businessSuccess', 'checks', 'decoderAccepted', 'diagnostic', 'diagnosticOnly', 'errorCode',
        'failedChecks', 'metadataParsed', 'metadataPresent', 'phase', 'version', ...(value.via ? ['via'] : [])].sort());
    assert(Object.values(value.checks).every(item => typeof item === 'boolean'));
    assert(value.failedChecks.length <= 3); assert(value.failedChecks.every(item =>
        ['ID_ALIAS_NOT_MATCHED', 'HASH_ALIAS_NOT_MATCHED', 'ORIGINAL_ALIAS_CHECKSUM_REQUIRED'].includes(item)));
    const output = JSON.stringify(value);
    for (const secret of [expected.fileId, expected.fileHash, 'PRIVATE_FOREIGN_UUID', 'PRIVATE_FOREIGN_HASH', 'PRIVATE_NAME.txt', 'PRIVATE_SIGNED_URL',
        'PRIVATE_PATH', 'download.qq.com', 'u_self', 'u_peer', '18446744073709551612']) assert(!output.includes(secret));
    for (const key of ['url', 'fileId', 'fileName', 'fileHash', 'responseHex', 'raw', 'message']) assert.equal(Object.hasOwn(value, key), false);
}
test('diagnostic acceptance observes the unchanged default decoder without returning its URL or resource values', () => {
    const metadata = Buffer.concat([s(6, expected.fileId), s(140, expected.fileHash), s(7, 'PRIVATE_NAME.txt')]);
    const normal = pfu.decodeResponse(reply(metadata), expected), diagnostic = observe(metadata);
    assert.equal(normal.fileId, expected.fileId); assert(normal.url.includes('PRIVATE_SIGNED_URL')); assert.equal(normal.fileName, 'PRIVATE_NAME.txt');
    assertClosed(diagnostic); assert.equal(diagnostic.decoderAccepted, true); assert.equal(diagnostic.phase, 'complete'); assert.equal(diagnostic.errorCode, null);
    assert.equal(diagnostic.checks.id6EqualsInput, true); assert.equal(diagnostic.checks.hash140EqualsInput, true); assert.deepEqual(diagnostic.failedChecks, []);
    const absent = observe(undefined); assertClosed(absent); assert.equal(absent.metadataPresent, false); assert.equal(absent.decoderAccepted, true);
});
test('all original resource rejection branches are reported and normal rejection stays unchanged', () => {
    const metadata = Buffer.concat([s(6, 'PRIVATE_FOREIGN_UUID'), s(140, 'PRIVATE_FOREIGN_HASH')]);
    assert.throws(() => pfu.decodeResponse(reply(metadata), expected), { code: 'INVALID_RESPONSE', message: 'Private file response belongs to another resource' });
    const result = observe(metadata); assertClosed(result); assert.equal(result.decoderAccepted, false); assert.equal(result.errorCode, 'INVALID_RESPONSE');
    assert.deepEqual(result.failedChecks, ['ID_ALIAS_NOT_MATCHED', 'HASH_ALIAS_NOT_MATCHED']);
    assert.equal(result.checks.id6Present, true); assert.equal(result.checks.id144Present, false); assert.equal(result.checks.idMatches, false);
});
test('original-alias checksum guard remains required even when field140 matches the input hash', () => {
    const metadata = Buffer.concat([s(6, 'PRIVATE_FOREIGN_UUID'), s(144, expected.fileId), s(140, expected.fileHash), s(145, 'PRIVATE_FOREIGN_HASH')]);
    const result = observe(metadata); assertClosed(result); assert.equal(result.checks.idMatches, true); assert.equal(result.checks.hashMatches, true);
    assert.equal(result.checks.aliasChecksumRequired, true); assert.equal(result.checks.checksumComparisonApplicable, false);
    assert.deepEqual(result.failedChecks, ['ORIGINAL_ALIAS_CHECKSUM_REQUIRED']);
    assert.throws(() => pfu.decodeResponse(reply(metadata), expected), { code: 'INVALID_RESPONSE' });
});
test('verified original alias checksum reports exact booleans; wrong or inapplicable checksums never relax matching', () => {
    const aliases = Buffer.concat([s(6, 'PRIVATE_FOREIGN_UUID'), s(144, expected.fileId), s(140, 'PRIVATE_FOREIGN_HASH'), s(145, 'PRIVATE_FOREIGN_HASH')]);
    const accepted = observe(Buffer.concat([aliases, b(100, Buffer.from(expected.fileHash, 'hex'))]));
    assertClosed(accepted); assert.equal(accepted.decoderAccepted, true); assert.equal(accepted.checks.originalChecksumMatches, true);
    assert.equal(accepted.checks.checksumComparisonApplicable, true); assert.equal(accepted.checks.checksum100EqualsInput, true);
    for (const [input, checksum, applicable] of [[expected, Buffer.alloc(16), true], [expected, Buffer.alloc(15), false],
        [{ ...expected, fileHash: 'PRIVATE_OPAQUE_HASH' }, Buffer.alloc(16), false]]) {
        const result = observe(Buffer.concat([aliases, b(100, checksum)]), input); assertClosed(result);
        assert.equal(result.decoderAccepted, false); assert.equal(result.checks.checksumComparisonApplicable, applicable);
        assert.equal(result.checks.originalChecksumMatches, false);
        assert.deepEqual(result.failedChecks, ['HASH_ALIAS_NOT_MATCHED', 'ORIGINAL_ALIAS_CHECKSUM_REQUIRED']);
    }
});
test('direct UUID plus exact original checksum accepts the observed variant without weakening UUID or original-alias guards', () => {
    const hash = b(100, Buffer.from(expected.fileHash, 'hex'));
    const metadata = Buffer.concat([s(6, expected.fileId), s(140, 'PRIVATE_FOREIGN_HASH'), hash]);
    const accepted = observe(metadata); assertClosed(accepted); assert.equal(accepted.decoderAccepted, true);
    assert.equal(accepted.checks.id6EqualsInput, true); assert.equal(accepted.checks.id144Present, false);
    assert.equal(accepted.checks.directChecksumMatches, true); assert.equal(accepted.checks.originalChecksumMatches, false);
    assert.equal(accepted.checks.hashMatches, true); assert.deepEqual(accepted.failedChecks, []);
    for (const prefix of [Buffer.alloc(0), s(6, 'PRIVATE_FOREIGN_UUID'), Buffer.concat([s(6, 'PRIVATE_FOREIGN_UUID'), s(144, 'PRIVATE_FOREIGN_UUID')])]) {
        const rejected = observe(Buffer.concat([prefix, s(140, 'PRIVATE_FOREIGN_HASH'), hash])); assertClosed(rejected);
        assert.equal(rejected.decoderAccepted, false); assert.equal(rejected.checks.directChecksumMatches, false); assert.equal(rejected.checks.idMatches, false);
        assert.throws(() => pfu.decodeResponse(reply(Buffer.concat([prefix, s(140, 'PRIVATE_FOREIGN_HASH'), hash])), expected), { code: 'INVALID_RESPONSE' });
    }
    const foreignAlias = observe(Buffer.concat([metadata, s(144, 'PRIVATE_FOREIGN_UUID')])); assertClosed(foreignAlias);
    assert.equal(foreignAlias.decoderAccepted, true); assert.equal(foreignAlias.checks.id6EqualsInput, true); assert.equal(foreignAlias.checks.directChecksumMatches, true);
    const guarded = observe(Buffer.concat([s(144, expected.fileId), s(140, expected.fileHash), b(100, Buffer.alloc(16))]));
    assertClosed(guarded); assert.equal(guarded.decoderAccepted, false); assert.deepEqual(guarded.failedChecks, ['ORIGINAL_ALIAS_CHECKSUM_REQUIRED']);
});
test('malformed metadata produces only a fixed failed diagnostic and default mode still rejects', () => {
    for (const metadata of [Buffer.concat([s(6, expected.fileId), s(6, 'PRIVATE_FOREIGN_UUID')]), n(100, 1), b(6, Buffer.from([0xff])),
        s(140, 'X'.repeat(4097)), Buffer.from([0x32, 0xff])]) {
        const result = observe(metadata); assertClosed(result); assert.equal(result.decoderAccepted, false); assert.equal(result.errorCode, 'INVALID_RESPONSE');
        assert.equal(result.metadataParsed, false); assert.deepEqual(result.failedChecks, []); assert.equal(result.phase, 'resource-metadata');
        assert.throws(() => pfu.decodeResponse(reply(metadata), expected), { code: 'INVALID_RESPONSE' });
    }
    const badName = observe(Buffer.concat([s(6, expected.fileId), n(7, 1)])); assertClosed(badName);
    assert.equal(badName.metadataParsed, true); assert.equal(badName.phase, 'resource-name'); assert.equal(badName.decoderAccepted, false);
});
test('diagnostics cannot promote invalid URLs, unknown server status or unknown diagnostic mode to acceptance', () => {
    const invalidUrl = pfu.decodeResponse(reply(s(6, expected.fileId), { result: Buffer.concat([s(20, 'attacker.example'), n(40, 80), s(50, '/secret')]) }), expected, 'resource-metadata');
    assertClosed(invalidUrl); assert.equal(invalidUrl.phase, 'url-validation'); assert.equal(invalidUrl.decoderAccepted, false);
    const status = pfu.decodeResponse(reply(undefined, { status: 145 }), expected, 'resource-metadata'); assertClosed(status); assert.equal(status.errorCode, 'UNSUPPORTED');
    for (const mode of ['', 'other', null, false, {}, ['resource-metadata']]) assert.throws(() => pfu.decodeResponse(reply(), expected, mode), { code: 'INVALID_PARAMS' });
});
function integration(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'private-metadata-'));
    const capture = new Capture({ install: false, processObject: { env: {} } });
    Object.assign(capture, { ready: true, online: true, qqVersion: TARGET_VERSION, epoch: 'diag-epoch', self: { uin: '12345', uid: 'u_self' } });
    const record = { chatType: 1, peerUid: 'u_peer', peerUin: '22222', msgId: '18446744073709551612', msgSeq: '1', clientSeq: '2',
        senderUid: 'u_self', senderUin: '12345', msgTime: '1800000000', sendStatus: 2,
        elements: [{ elementType: 3, elementId: '18446744073709551613', fileElement: { fileUuid: expected.fileId, file10MMd5: expected.fileHash,
            fileName: 'PRIVATE_NAME.txt', fileSize: '42' } }] };
    let body = reply(Buffer.concat([s(6, 'PRIVATE_FOREIGN_UUID'), s(140, 'PRIVATE_FOREIGN_HASH')])), getMessageCalls = 0, onRead, getResult = () => ({ result: 0, msgList: [record] });
    capture.session = { getMsgService: () => ({ getMsgsByMsgId: () => { getMessageCalls++; return getResult(); } }) };
    const sent = [], released = [], nativeCalls = [];
    const addon = { resetSession() {}, install: () => ({ ok: true }), readTemplate: () => ({ haveTemplate: true }),
        send(command, request) { assert.equal(command, pfu.NATIVE_CMD); sent.push({ command, request }); return { ok: true, requestId: String(sent.length) }; },
        readResponse(requestId) { if (onRead) onRead(); return { requestId, result: 0, count: 1, body }; }, release(id) { released.push(id); } };
    const channel = native.createChannel({ loadNative: () => addon });
    t.mock.method(native, 'run', (cap, params) => { nativeCalls.push(params); return channel.run(cap, params); });
    const state = () => ({ ready: true, online: true, epoch: capture.epoch, self: capture.self, capabilities: { privateFileUrl: true, messages: true } });
    const backend = { async call(method, params, options) { if (method === 'status') return state(); return capture.call(method, params,
        { expiresAt: Date.now() + (options?.timeoutMs ?? 10000), signal: options?.signal }); } };
    const store = new MessageStore({ directory: path.join(root, 'data') }), id = store.remember('12345', record).id;
    const service = new OneBotService({ backend, store, actionTimeoutMs: 1000 });
    const params = { peer: { chatType: 1, peerUid: 'u_peer' }, nativeId: record.msgId, elementId: record.elements[0].elementId,
        expectedEpoch: 'diag-epoch', expectedUin: '12345', transport: 'oidb', diagnostic: 'resource-metadata' };
    t.after(() => { capture.close(); store.close(); assert(path.resolve(root).startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true }); });
    return { capture, channel, params, sent, released, nativeCalls, record, service, id, backend,
        get getMessageCalls() { return getMessageCalls; }, set body(value) { body = value; }, set onRead(value) { onRead = value; }, set getResult(value) { getResult = value; } };
}
test('fixed opt-in crosses Capture/MSF with original resource input and produces a closed diagnostic that cannot pass public URL checks', async t => {
    const f = integration(t), result = await f.capture.call('nativePrivateFileUrl', f.params); assertClosed(result); assert.equal(result.via, 'native-msf');
    assert.equal(f.sent.length, 1); assert.deepEqual(f.released, ['1']);
    const request = fields(Buffer.from(f.sent[0].request, 'hex')), body = fields(one(request, 4).value), file = fields(one(body, 14).value);
    assert.equal(one(file, 20).value.toString(), expected.fileId); assert.equal(one(file, 60).value.toString(), expected.fileHash);
    assert.equal(f.nativeCalls[0].diagnostic, 'resource-metadata'); assert.equal(f.nativeCalls[0].expectedEpoch, 'diag-epoch');
    const originalCall = f.backend.call; f.backend.call = async (method, params, options) => method === 'nativePrivateFileUrl' ? result : originalCall(method, params, options);
    const action = await f.service.action({ action: 'get_private_file_url', params: { message_id: f.id, file_id: expected.fileId } });
    assert.equal(action.status, 'failed'); assert.equal(action.data, null); assert.equal(action.message, 'QQ returned another private file');
});
test('normal public/private URL successes and normal resource rejection remain unchanged', async t => {
    const f = integration(t); f.body = reply(Buffer.concat([s(6, expected.fileId), s(140, expected.fileHash)]));
    const { diagnostic, ...normal } = f.params; const result = await f.capture.call('nativePrivateFileUrl', normal);
    assert.equal(result.fileId, expected.fileId); assert(result.url.includes('PRIVATE_SIGNED_URL')); assert.equal(result.diagnosticOnly, undefined);
    const action = await f.service.action({ action: 'get_private_file_url', params: { message_id: f.id, file_id: expected.fileId } }); assert.equal(action.retcode, 0);
    f.body = reply(s(6, 'PRIVATE_FOREIGN_UUID'));
    await assert.rejects(f.capture.call('nativePrivateFileUrl', normal), { code: 'INVALID_RESPONSE', message: 'Private file response belongs to another resource' });
});
test('unknown/offline diagnostics and use on another fixed operation are rejected before native reads or submission', async t => {
    const f = integration(t);
    for (const patch of [{ diagnostic: 'other' }, { diagnostic: null }, { diagnostic: false }, { transport: 'offline' }, { transport: 'other' }]) {
        await assert.rejects(f.capture.call('nativePrivateFileUrl', { ...f.params, ...patch }), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(f.channel.run(f.capture, { op: 'fetchGroupFileSpace', diagnostic: 'resource-metadata' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.channel.run(f.capture, { op: 'fetchPrivateFileUrl', diagnostic: 'resource-metadata', transport: 'offline' }), { code: 'INVALID_PARAMS' });
    assert.equal(f.getMessageCalls, 0); assert.equal(f.sent.length, 0); assert.equal(f.nativeCalls.length, 0);
});
test('diagnostic response cannot bypass native cancellation or a session change after submission', async t => {
    for (const change of ['cancel', 'epoch']) await t.test(change, async nested => {
        const f = integration(nested), controller = new AbortController();
        f.onRead = () => { if (change === 'cancel') controller.abort(); else f.capture.epoch = 'new-epoch'; };
        await assert.rejects(f.capture.call('nativePrivateFileUrl', f.params, { signal: controller.signal }), { code: change === 'cancel' ? 'EXPIRED' : 'SESSION_CHANGED' });
        assert.equal(f.sent.length, 1); assert.deepEqual(f.released, ['1']);
    });
});
test('message lookup time consumes the same total diagnostic deadline and late completion cannot submit a query', async t => {
    const f = integration(t); let resolve;
    f.getResult = () => new Promise(done => { resolve = done; });
    const pending = f.capture.call('nativePrivateFileUrl', { ...f.params, timeoutMs: 10 });
    await assert.rejects(pending, { code: 'TIMEOUT' }); resolve({ result: 0, msgList: [f.record] }); await new Promise(done => setImmediate(done));
    assert.equal(f.sent.length, 0); assert.equal(f.nativeCalls.length, 0);
});
