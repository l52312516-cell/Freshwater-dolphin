'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { capabilities } = require('../src/onebot/capabilities.cjs');
function fixture(t) {
    const directory = fs.mkdtempSync(path.resolve(__dirname, '../work/temp/service-fields-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new MessageStore({ directory }), calls = [];
    const state = { epoch: 'one', ready: true, self: { uin: '123', uid: 'u_self' }, capabilities: { history: true } };
    const record = { chatType: 2, peerUid: '456', peerUin: '456', senderUid: 'u_sender', senderUin: '789',
        msgId: '18446744073709551613', msgSeq: '20', msgTime: String(Math.floor(Date.now() / 1000)),
        elements: [{ elementType: 3, fileElement: { fileUuid: 'opaque-file-id', fileName: '文档.txt', fileSize: '9007199254740993' } }] };
    const backend = { async call(method, params) {
        calls.push({ method, params });
        if (method === 'status') return structuredClone(state);
        if (method === 'history') return { records: [structuredClone(record)] };
        if (method === 'nativeGroupFileUrl') return { url: 'https://njc-download.ftn.qq.com/ftn_handler/abcd/?fname=', via: 'native-msf' };
        throw new Error('Unexpected method');
    } };
    return { store, record, calls, service: new OneBotService({ backend, store }), state };
}
test('get_msg and automatic file events retain exact metadata without claiming a download URL', async t => {
    const f = fixture(t), entry = f.store.remember('123', f.record);
    const query = await f.service.action({ action: 'get_msg', params: { message_id: entry.id } });
    assert.equal(query.retcode, 0);
    assert.deepEqual(query.data.message, [{ type: 'file', data: { file: 'opaque-file-id', file_id: 'opaque-file-id', name: '文档.txt', file_size: '9007199254740993' } }]);
    assert.equal(Object.hasOwn(query.data.message[0].data, 'url'), false);
    const event = await f.service.event({ kind: 'message', epoch: 'one', selfUin: '123', record: f.record });
    assert.deepEqual(event.message, query.data.message);
    assert.equal(event._freshwater, undefined);
});
test('group file events convert with a native download URL when the capability is present', async t => {
    const f = fixture(t); f.state.capabilities.groupFileUrl = true;
    const event = await f.service.event({ kind: 'message', epoch: 'one', selfUin: '123', record: f.record });
    assert.equal(event.message_type, 'group');
    assert.deepEqual(event.message, [{ type: 'file', data: { file: 'opaque-file-id', file_id: 'opaque-file-id',
        name: '文档.txt', file_size: '9007199254740993', url: 'https://njc-download.ftn.qq.com/ftn_handler/abcd/?fname=' } }]);
    const call = f.calls.find(item => item.method === 'nativeGroupFileUrl');
    assert.equal(call.params.groupId, '456'); assert.equal(call.params.fileId, 'opaque-file-id');
});
test('history queries retain a full file segment with its exact native identity and size', async t => {
    const f = fixture(t);
    const page = await f.service.action({ action: 'get_group_msg_history', params: { group_id: 456, count: 2 } });
    assert.equal(page.retcode, 0);
    assert.equal(page.data.messages.length, 1);
    assert.equal(page.data.messages[0].message[0].type, 'file');
    assert.equal(page.data.messages[0].message[0].data.file_size, '9007199254740993');
    assert.equal(f.calls.find(call => call.method === 'history').params.reverse, true);
});
test('profile no_cache rejects string booleans before starting a backend query', async t => {
    const f = fixture(t);
    for (const action of ['get_stranger_info', 'get_group_info', 'get_group_member_info', 'get_group_member_list']) {
        const result = await f.service.action({ action, params: { no_cache: 'false', user_id: 789, group_id: 456 } });
        assert.equal(result.retcode, 1400);
    }
    assert.equal(f.calls.length, 0);
});
test('capability catalogue distinguishes JSON reception, failed share rendering, videos and file extensions', () => {
    const value = capabilities({ ready: true, self: { uin: '123', uid: 'u_self' }, capabilities: { jsonReceive: true, share: true, video: true, file: true } });
    assert.equal(value.segments.length, 20);
    assert.equal(value.segments.find(row => row.name === 'json').receive, true);
    assert.equal(value.segments.find(row => row.name === 'json').send, false);
    assert.equal(value.segments.find(row => row.name === 'share').send, false);
    assert.equal(value.segments.find(row => row.name === 'share').receive, false);
    assert.equal(value.segments.find(row => row.name === 'share').implemented, true);
    assert.equal(value.segments.find(row => row.name === 'share').verification, 'unverified');
    assert.equal(value.segments.find(row => row.name === 'video').send, true);
    assert.equal(value.segment_extensions[0].name, 'file');
    assert.equal(value.segment_extensions[0].receive, false);
});
test('group-only file reception follows the native URL capability and actual session readiness', async t => {
    const f = fixture(t);
    f.state.capabilities = { file: true, groupFileUrl: true, groupFileSpace: false };
    const value = await f.service.capabilities();
    const file = value.segment_extensions.find(row => row.name === 'file');
    assert.equal(file.receive, true);
    assert.equal(file.send, false); // This service has no account media directory.
    assert.deepEqual(file.receive_contexts, ['group']);
    assert.deepEqual(file.send_contexts, ['private', 'group']);
    assert.equal(file.verification, 'offline-tested');
    assert.equal(value.extensions.filter(row => row.name === 'get_group_file_url').length, 1);
    assert.equal(value.extensions.filter(row => row.name === 'get_group_file_system_info').length, 1);
    assert.equal(value.extensions.find(row => row.name === 'get_group_file_url').available, true);
    assert.equal(value.extensions.find(row => row.name === 'get_group_file_system_info').available, false);
    f.state.capabilities.groupFileUrl = false;
    f.state.capabilities.groupFileSpace = true;
    const spaceOnly = await f.service.capabilities();
    assert.equal(spaceOnly.segment_extensions[0].receive, false);
    assert.equal(spaceOnly.extensions.find(row => row.name === 'get_group_file_url').available, false);
    assert.equal(spaceOnly.extensions.find(row => row.name === 'get_group_file_system_info').available, true);
    f.state.ready = false;
    f.state.capabilities.groupFileUrl = true;
    const notReady = await f.service.capabilities();
    assert.equal(notReady.segment_extensions[0].receive, false);
    assert.equal(notReady.extensions.find(row => row.name === 'get_group_file_system_info').available, false);
});
test('native group file availability never queries private file URLs through group methods', async t => {
    const f = fixture(t);
    f.state.capabilities.groupFileUrl = true;
    Object.assign(f.record, { chatType: 1, peerUid: 'u_sender', peerUin: '789' });
    const event = await f.service.event({ kind: 'message', epoch: 'one', selfUin: '123', record: f.record });
    assert.equal(event.message_type, 'private');
    assert.equal(event.message[0].type, 'file');
    assert.equal(event.message[0].data.url, undefined);
    assert.equal(f.calls.some(call => call.method === 'nativeGroupFileUrl'), false);
});
test('private file URL capabilities remain independent of group-file support and report only enabled contexts', async t => {
    const f = fixture(t);
    f.state.capabilities.privateFileUrl = true;
    const privateOnly = await f.service.capabilities();
    assert.equal(privateOnly.extensions.find(row => row.name === 'get_private_file_url').available, true);
    assert.equal(privateOnly.extensions.find(row => row.name === 'get_private_file_url').verification, 'offline-tested');
    assert.equal(privateOnly.extensions.find(row => row.name === 'get_group_file_url').available, false);
    assert.equal(privateOnly.segment_extensions[0].receive, true);
    assert.deepEqual(privateOnly.segment_extensions[0].receive_contexts, ['private']);
    f.state.capabilities.groupFileUrl = true;
    const both = await f.service.capabilities();
    assert.deepEqual(both.segment_extensions[0].receive_contexts, ['private', 'group']);
    f.state.ready = false;
    const stopped = await f.service.capabilities();
    assert.equal(stopped.extensions.find(row => row.name === 'get_private_file_url').available, false);
    assert.equal(stopped.segment_extensions[0].receive, false);
    assert.deepEqual(stopped.segment_extensions[0].receive_contexts, []);
});

test('limited native validation evidence never enables another version or a stopped account', () => {
    const { BASELINE, evaluateRuntimeIdentity } = require('../src/qq/runtime-profile.cjs');
    const target = capabilities({ qqVersion: '3.2.35-54395', ready: false, runtime_profile: evaluateRuntimeIdentity(BASELINE) });
    const privateFile = target.extensions.find(row => row.name === 'get_private_file_url');
    assert.equal(privateFile.available, false);
    assert.ok(privateFile.target_validation.scopes.includes('56041-byte-download'));
    assert.equal(privateFile.verification, 'offline-tested'); // Whole parameter surface remains unverified.
    const otherVersion = capabilities({ qqVersion: 'unverified', ready: false });
    assert.equal(Object.hasOwn(otherVersion.extensions.find(row => row.name === 'get_private_file_url'), 'target_validation'), false);
    const versionOnly = capabilities({ qqVersion: '3.2.35-54395', ready: false });
    assert.equal(Object.hasOwn(versionOnly.extensions.find(row => row.name === 'get_private_file_url'), 'target_validation'), false);
});
