'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');

function fixture(t, account = '12345') {
    const capture = new Capture({ install: false });
    capture.ready = true; capture.online = true; capture.qqVersion = '3.2.35-54395';
    capture.epoch = 'group-files-' + account; capture.self = { uin: account, uid: 'u_' + account };
    capture.registrations.push({ name: 'msg', service: {}, remove: 'none' });
    const calls = [], rpc = [];
    const outcomes = {
        batchGetGroupFileCount: () => ({ result: 0, groupCodes: ['200'], groupFileCounts: [3] }),
        createGroupFolder: () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 },
            folderInfo: { folderId: 'created-folder', folderName: 'Integration folder' } } }),
        renameGroupFolder: () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 },
            folderInfo: { folderId: 'created-folder', folderName: 'Renamed folder' } } }),
        deleteGroupFolder: () => ({ result: 0, groupFileCommonResult: { retCode: 0 } }),
        deleteGroupFile: () => ({ result: 0, transGroupFileResult: { result: { retCode: 0 }, successFileIdList: ['file-A'], failFileIdList: [] } }),
        moveGroupFile: () => ({ result: 0, moveGroupFileResult: { result: { retCode: 0 }, successFileIdList: ['file-A'], failFileIdList: [] } }),
        transGroupFile: () => ({ result: 0, transGroupFileResult: { result: { retCode: 0 }, saveBusId: 102, saveFilePath: 'server/location' } }),
        renameGroupFile: () => ({ result: 0, renameGroupFileResult: { result: { retCode: 0 } } })
    };
    const rich = Object.fromEntries(Object.keys(outcomes).map(method => [method, (...args) => {
        calls.push({ method, args: structuredClone(args) }); return outcomes[method](...args);
    }]));
    rich.getGroupFileList = () => {
        setImmediate(() => capture.groupFilesApi.listenerMethods.msg.onGroupFileInfoUpdate({
            reqId: 17, retCode: 0, isEnd: true, nextIndex: 1, allFileCount: 0,
            item: [{ peerId: '200', type: 2, fileInfo: null,
                folderInfo: { folderId: 'created-folder', folderName: 'Renamed folder' } }]
        }));
        return 17;
    };
    capture.session = { getRichMediaService: () => rich };
    const backend = { call(method, params = {}, options = {}) {
        if (method !== 'status') rpc.push({ method, params: structuredClone(params) });
        return capture.call(method, params, { expiresAt: Date.now() + (options.timeoutMs ?? 10000), signal: options.signal });
    } };
    const service = new OneBotService({ backend, store: {}, actionTimeoutMs: 1000 });
    const action = (name, params = {}, echo = 'group-files-integration', expectedSession) => service.action({
        action: name, params: { group_id: 200, ...params }, echo
    }, expectedSession);
    t.after(() => capture.close());
    return { capture, outcomes, calls, rpc, rich, service, action };
}
function ok(response) { assert.equal(response.status, 'ok', response.message); assert.equal(response.retcode, 0); return response.data; }
function failed(response, code) { assert.equal(response.status, 'failed'); assert.equal(response.retcode, code, response.message); assert.equal(response.data, null); }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('all fixed group file actions cross OneBotService and the real Capture.call with their expected epoch intact', async t => {
    const f = fixture(t);
    assert.deepEqual(ok(await f.action('get_group_file_count')), { group_id: 200, file_count: 3 });
    assert.deepEqual(ok(await f.action('create_group_file_folder', { name: 'Integration folder' })), { folder_id: 'created-folder' });
    assert.equal(ok(await f.action('rename_group_file_folder', { folder_id: 'created-folder', new_folder_name: 'Renamed folder' })), null);
    assert.equal(ok(await f.action('delete_group_folder', { folder_id: 'created-folder' })), null);
    assert.equal(ok(await f.action('delete_group_file', { file_id: 'file-A', busid: 102 })), null);
    assert.equal(ok(await f.action('move_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', target_directory: 'target-folder' })), null);
    assert.deepEqual(ok(await f.action('trans_group_file', { file_id: 'file-A' })), {
        group_id: 200, file_id: 'file-A', save_busid: 102, save_file_path: 'server/location'
    });
    assert.deepEqual(ok(await f.action('rename_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', new_name: 'renamed.txt' })), { ok: true });
    assert.equal(f.rpc.length, 8);
    assert.ok(f.rpc.every(call => call.method === 'groupFiles' && call.params.expectedEpoch === f.capture.epoch));
    assert.deepEqual(f.calls.map(call => [call.method, call.args]), [
        ['batchGetGroupFileCount', [['200']]], ['createGroupFolder', ['200', 'Integration folder']],
        ['renameGroupFolder', ['200', 'created-folder', 'Renamed folder']], ['deleteGroupFolder', ['200', 'created-folder']],
        ['deleteGroupFile', ['200', [102], ['file-A']]], ['moveGroupFile', ['200', [102], ['file-A'], '/', 'target-folder']],
        ['transGroupFile', ['200', 'file-A']], ['renameGroupFile', ['200', 102, 'file-A', '/', 'renamed.txt']]
    ]);
});

test('the real capture bridge rejects missing or stale mutation epochs before native invocation', async t => {
    const f = fixture(t);
    for (const expectedEpoch of [undefined, 'previous-generation']) {
        await assert.rejects(f.capture.call('groupFiles', { operation: 'group.folderDelete', groupId: '200',
            folderId: 'created-folder', expectedEpoch }), { code: 'SESSION_CHANGED' });
    }
    failed(await f.action('delete_group_folder', { folder_id: 'created-folder' }, null,
        { epoch: 'previous-generation', selfUin: '12345' }), 1503);
    assert.equal(f.calls.length, 0);
});

test('omitted busid crosses the actual exact file browser before native delete, move and rename', async t => {
    const f = fixture(t), lookups = [];
    f.rich.getGroupFileList = (groupId, request) => {
        lookups.push({ groupId, request });
        setImmediate(() => f.capture.groupFilesApi.listenerMethods.msg.onGroupFileInfoUpdate({ reqId: 19, retCode: 0, isEnd: true,
            nextIndex: 1, allFileCount: 1, item: [{ peerId: groupId, type: 1, folderInfo: null,
                fileInfo: { fileId: 'file-A', busId: 101, fileName: 'actual.txt', fileSize: '13', parentFolderId: request.folderId } }] }));
        return 19;
    };
    assert.equal(ok(await f.action('delete_group_file', { file_id: 'file-A', folder_id: 'source-folder' })), null);
    assert.equal(ok(await f.action('move_group_file', { file_id: 'file-A', parent_directory: 'source-folder', target_directory: 'target-folder' })), null);
    assert.deepEqual(ok(await f.action('rename_group_file', { file_id: 'file-A', current_parent_directory: 'source-folder', new_name: 'renamed.txt' })), { ok: true });
    assert.equal(lookups.length, 3); assert.ok(lookups.every(item => item.groupId === '200' && item.request.folderId === 'source-folder'));
    assert.deepEqual(f.calls.map(call => [call.method, call.args]), [
        ['deleteGroupFile', ['200', [101], ['file-A']]], ['moveGroupFile', ['200', [101], ['file-A'], 'source-folder', 'target-folder']],
        ['renameGroupFile', ['200', 101, 'file-A', 'source-folder', 'renamed.txt']]
    ]);
    assert.deepEqual(f.rpc.map(call => call.params.operation), ['group.fileInfo', 'group.fileDelete', 'group.fileInfo', 'group.fileMove', 'group.fileInfo', 'group.fileRename']);
    assert.ok(f.rpc.every(call => call.params.expectedEpoch === f.capture.epoch));
});

test('native business rejections and partial batches retain echo and never dispatch a fallback or retry', async t => {
    const f = fixture(t), echo = { request: ['nested', 7] };
    for (const outcome of [undefined, { result: 7 }, { result: 0, groupFileCommonResult: { retCode: 9 } },
        { result: 0, groupFileCommonResult: { retCode: 0, errCode: 2 } }]) {
        f.outcomes.deleteGroupFolder = () => outcome;
        const response = await f.action('delete_group_folder', { folder_id: 'created-folder' }, echo);
        failed(response, 1500); assert.deepEqual(response.echo, echo);
    }
    f.outcomes.deleteGroupFile = () => ({ result: 0, transGroupFileResult: { result: { retCode: 0 },
        successFileIdList: ['file-A'], failFileIdList: ['file-B'] } });
    failed(await f.action('delete_group_file', { files: [{ file_id: 'file-A', busid: 102 }, { file_id: 'file-B', busid: 101 }] }), 1500);
    assert.equal(f.calls.length, 5);
});

test('invalid second batch entries and mismatched account parameters cannot reach Capture native dispatch', async t => {
    const f = fixture(t);
    failed(await f.action('delete_group_file', { files: [{ file_id: 'file-A', busid: 102 }, { file_id: 'file-B', busid: -1 }] }), 1400);
    failed(await f.action('delete_group_folder', { folder_id: 'created-folder', self_id: '54321' }), 1400);
    assert.equal(f.calls.length, 0); assert.equal(f.rpc.length, 0);
});

test('OneBot timeout retains the native group mutation lock until settlement and a later action can recover', async t => {
    const f = fixture(t), normalActionTimeoutMs = f.service.actionTimeoutMs; f.service.actionTimeoutMs = 50;
    let complete;
    f.outcomes.deleteGroupFolder = () => new Promise(resolve => { complete = resolve; });
    failed(await f.action('delete_group_folder', { folder_id: 'created-folder' }), 1504);
    failed(await f.action('rename_group_file_folder', { folder_id: 'created-folder', new_folder_name: 'Renamed folder' }), 1503);
    assert.equal(f.calls.length, 1);
    // The recovered rename includes a real asynchronous directory readback;
    // only the deliberately stalled request uses the short timeout budget.
    f.service.actionTimeoutMs = normalActionTimeoutMs;
    complete({ result: 0, groupFileCommonResult: { retCode: 0 } }); await tick();
    assert.equal(ok(await f.action('rename_group_file_folder', { folder_id: 'created-folder', new_folder_name: 'Renamed folder' })), null);
    assert.equal(f.calls.filter(call => call.method === 'deleteGroupFolder').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'renameGroupFolder').length, 1);
});

test('replacement of the acting session rejects a late native success and retires only its own generation locks', async t => {
    const f = fixture(t); let complete;
    f.outcomes.deleteGroupFolder = () => new Promise(resolve => { complete = resolve; });
    const pending = f.action('delete_group_folder', { folder_id: 'created-folder' }); await tick();
    f.capture.epoch = 'replacement-session';
    assert.equal(ok(await f.action('rename_group_file_folder', { folder_id: 'created-folder', new_folder_name: 'Renamed folder' })), null);
    complete({ result: 0, groupFileCommonResult: { retCode: 0 } }); failed(await pending, 1503);
    assert.equal(f.calls.length, 2);
});

test('two real capture instances isolate pending locks and native targets even for identical group and folder IDs', async t => {
    const a = fixture(t, '12345'), b = fixture(t, '54321'); let complete;
    a.outcomes.deleteGroupFolder = () => new Promise(resolve => { complete = resolve; });
    const pending = a.action('delete_group_folder', { folder_id: 'created-folder' }); await tick();
    assert.equal(ok(await b.action('delete_group_folder', { folder_id: 'created-folder', self_id: '54321' })), null);
    failed(await a.action('delete_group_folder', { folder_id: 'created-folder' }), 1503);
    complete({ result: 0, groupFileCommonResult: { retCode: 0 } }); assert.equal(ok(await pending), null);
    assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
    assert.ok(a.rpc.every(call => call.params.expectedEpoch === a.capture.epoch));
    assert.ok(b.rpc.every(call => call.params.expectedEpoch === b.capture.epoch));
});

test('missing native group file methods remain unsupported through the public action registry', async t => {
    const f = fixture(t); delete f.rich.deleteGroupFolder;
    failed(await f.action('delete_group_folder', { folder_id: 'created-folder' }), 1404);
    assert.equal(f.calls.length, 0);
});
