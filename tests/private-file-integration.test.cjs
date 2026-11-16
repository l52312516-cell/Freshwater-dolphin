'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const native = require('../src/qq/msf-native.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { METHODS } = require('../src/ipc/common.cjs');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'private-file-integration-'));
    const capture = new Capture({ install: false, processObject: { env: {} } });
    capture.ready = true; capture.online = true; capture.qqVersion = TARGET_VERSION;
    capture.epoch = 'private-session'; capture.self = { uin: '12345', uid: 'u_self' };
    const record = { chatType: 1, peerUid: 'u_peer', peerUin: '22222', msgId: '18446744073709551612',
        msgSeq: '1', clientSeq: '2', senderUid: 'u_peer', senderUin: '22222', msgTime: '1800000000', sendNickName: 'sender',
        elements: [{ elementType: 3, elementId: '18446744073709551613', fileElement: {
            fileUuid: 'private-file-id', file10MMd5: 'real-opaque-addon', fileName: 'example.txt', fileSize: '42' } }] };
    let queryResult = record;
    capture.session = { getMsgService: () => ({ getMsgsByMsgId: () => ({ result: 0, msgList: [queryResult] }) }) };
    const state = () => ({ epoch: capture.epoch, ready: capture.ready, online: true, self: capture.self,
        qqVersion: TARGET_VERSION, capabilities: { privateFileUrl: enabled, messages: true } });
    let enabled = true, outcome = () => ({ fileId: 'private-file-id', url: 'https://download.qq.com/private?token=fixture' });
    const nativeCalls = [], rpc = [];
    t.mock.method(native, 'run', async (cap, params) => {
        assert.equal(cap, capture); nativeCalls.push(params); return outcome(params);
    });
    const backend = { call(method, params = {}, options = {}) {
        if (method === 'status') return Promise.resolve(state());
        rpc.push({ method, params });
        return capture.call(method, params, { expiresAt: Date.now() + (options.timeoutMs ?? 10000), signal: options.signal });
    } };
    const store = new MessageStore({ directory: path.join(root, 'messages') });
    const id = store.remember('12345', record).id;
    const service = new OneBotService({ backend, store, actionTimeoutMs: 1000 });
    t.after(() => { capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { capture, record, service, store, id, nativeCalls, rpc,
        state, set enabled(value) { enabled = value; }, set outcome(value) { outcome = value; },
        set queryResult(value) { queryResult = value; },
        action(params = {}, echo = { request: ['private', 1] }) {
            return service.action({ action: 'get_private_file_url', params: { message_id: id, ...params }, echo });
        } };
}

test('private file action crosses OneBot and Capture with exact account, message, element and real opaque hash', async t => {
    const f = fixture(t), echo = { nested: [null, 3] };
    const result = await f.action({ file_id: 'private-file-id' }, echo);
    assert.equal(result.retcode, 0, result.message); assert.deepEqual(result.echo, echo);
    assert.deepEqual(result.data, { url: 'https://download.qq.com/private?token=fixture' });
    assert.equal(f.nativeCalls.length, 1);
    const actual = f.nativeCalls[0];
    assert.equal(actual.op, 'fetchPrivateFileUrl'); assert.equal(actual.fileId, 'private-file-id');
    assert.equal(actual.fileHash, 'real-opaque-addon'); assert.equal(actual.expectedUin, '12345');
    assert.equal(actual.expectedEpoch, 'private-session'); assert.ok(actual.signal instanceof AbortSignal);
    const rpc = f.rpc.find(call => call.method === 'nativePrivateFileUrl');
    assert.equal(rpc.params.nativeId, f.record.msgId); assert.equal(rpc.params.elementId, f.record.elements[0].elementId);
    assert.equal(METHODS.has('nativePrivateFileUrl'), true);
    for (const removed of ['probeApi', 'probeCall', 'probeWatch', 'probeLog', 'msfCapture']) {
        assert.equal(METHODS.has(removed), false);
        await assert.rejects(f.capture.call(removed), { code: 'UNSUPPORTED' });
    }
});

test('private file action never substitutes another file, message, account or ambiguous element', async t => {
    const f = fixture(t);
    for (const params of [{ message_id: f.id + 100 }, { file_id: 'foreign' }, { file_id: '' }, { file_id: 1 }]) {
        const result = await f.action(params); assert.equal(result.status, 'failed'); assert.equal(result.data, null);
    }
    f.record.elements.push(structuredClone(f.record.elements[0]));
    assert.equal((await f.action()).status, 'failed'); f.record.elements.pop();
    f.queryResult = { ...f.record, peerUid: 'u_other' };
    assert.equal((await f.action()).status, 'failed');
    f.queryResult = f.record;
    f.capture.self = { uin: '54321', uid: 'u_other' };
    assert.equal((await f.action()).status, 'failed');
    assert.equal(f.nativeCalls.length, 0);
});

test('private file RPC rejects stale sessions, group peers, missing hashes and duplicate exact identities', async t => {
    const f = fixture(t), params = { peer: { chatType: 1, peerUid: 'u_peer' }, nativeId: f.record.msgId,
        elementId: f.record.elements[0].elementId, expectedEpoch: f.capture.epoch, expectedUin: '12345' };
    for (const patch of [{ expectedEpoch: 'old' }, { expectedUin: '54321' }, { peer: { chatType: 2, peerUid: '200' } }]) {
        await assert.rejects(f.capture.call('nativePrivateFileUrl', { ...params, ...patch }));
    }
    delete f.record.elements[0].fileElement.file10MMd5;
    await assert.rejects(f.capture.call('nativePrivateFileUrl', params), { code: 'INVALID_PARAMS' });
    f.record.elements[0].fileElement.file10MMd5 = 'addon'; f.record.elements.push(structuredClone(f.record.elements[0]));
    await assert.rejects(f.capture.call('nativePrivateFileUrl', params), { code: 'NOT_FOUND' });
    assert.equal(f.nativeCalls.length, 0);
});

test('private file errors and session changes never turn into action success or automatic retries', async t => {
    const f = fixture(t);
    for (const code of ['TIMEOUT', 'QUERY_FAILED', 'UNSUPPORTED']) {
        f.outcome = () => { throw Object.assign(new Error('Native query failed'), { code }); };
        const before = f.nativeCalls.length, value = await f.action();
        assert.equal(value.status, 'failed'); assert.equal(value.data, null); assert.equal(f.nativeCalls.length, before + 1);
    }
    f.outcome = () => ({ fileId: 'another-file', url: 'https://download.qq.com/fixture' });
    assert.equal((await f.action()).status, 'failed');
    for (const url of ['javascript:alert(1)', 'https://attacker.example/file', 'https://user:pass@download.qq.com/file', 'https://download.qq.com/file#secret']) {
        f.outcome = () => ({ fileId: 'private-file-id', url });
        assert.equal((await f.action()).status, 'failed');
    }
    f.outcome = () => { f.capture.epoch = 'new-session'; return { fileId: 'private-file-id', url: 'https://download.qq.com/fixture' }; };
    assert.equal((await f.action()).status, 'failed');
    f.enabled = false;
    const before = f.nativeCalls.length;
    assert.equal((await f.action()).retcode, 1404); assert.equal(f.nativeCalls.length, before);
});

test('private inbound file conversion includes a matching URL and retains explicit metadata on lookup failure', async t => {
    const f = fixture(t);
    const value = await f.service.convert(f.state(), f.record, f.id);
    assert.equal(value.message[0].type, 'file'); assert.equal(value.message[0].data.file_id, 'private-file-id');
    assert.equal(value.message[0].data.url, 'https://download.qq.com/private?token=fixture');
    f.outcome = () => { throw Object.assign(new Error('Unavailable'), { code: 'QUERY_FAILED' }); };
    const failed = await f.service.convert(f.state(), f.record, f.id);
    assert.equal(failed.message[0].type, 'file'); assert.equal(failed.message[0].data.name, 'example.txt');
    assert.equal(Object.hasOwn(failed.message[0].data, 'url'), false);
});
