'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OneBotService } = require('../src/onebot/service.cjs');

function fixture() {
    const state = { epoch: 'extensions-session', ready: true, online: true,
        self: { uin: '12345', uid: 'u_self', nickname: 'Test' },
        capabilities: { profileLike: true, groupAtAllRemain: true, groupFiles: true, groupFileInfo: true } };
    const calls = [];
    const file = () => ({ fileId: 'file-alpha', busId: 102, fileSize: '18446744073709551614',
        fileName: 'document.txt', uploadTime: 100, uploaderUin: '45678', parentFolderId: '/' });
    const page = params => ({ groupId: params.groupId, directory: params.directory, startIndex: params.startIndex,
        items: [{ peerId: params.groupId, type: 1, fileInfo: file(), folderInfo: null }],
        isEnd: false, nextIndex: params.startIndex + 1, allFileCount: 2 });
    const handlers = {
        resolve: params => ({ uin: params.uin, uid: 'u_target' }),
        interaction: params => params.operation === 'profile.like'
            ? { confirmed: true, uid: params.uid, count: params.count }
            : { group_id: Number(params.groupId), can_at_all: false,
                remain_at_all_count_for_uin: 0, remain_at_all_count_for_group: 0 },
        groupFiles: params => params.operation === 'group.filesList' ? page(params)
            : { groupId: params.groupId, fileInfo: file() }
    };
    const backend = { async call(method, params, context) {
        if (method === 'status') return structuredClone(state);
        calls.push({ method, params: structuredClone(params), context: { ...context } });
        if (!handlers[method]) throw new Error('Unexpected backend method');
        return handlers[method](params, context);
    } };
    const service = new OneBotService({ backend, store: {} });
    const action = (name, params = {}, extra = {}, expectedSession) => service.action({ action: name, params, ...extra }, expectedSession);
    return { state, calls, file, page, handlers, service, action };
}
function succeeded(response) { assert.equal(response.status, 'ok', response.message); assert.equal(response.retcode, 0); return response.data; }
function failed(response, retcode) { assert.equal(response.status, 'failed'); assert.equal(response.retcode, retcode); assert.equal(response.data, null); }

test('send_like resolves the exact QQ account before a single native like action', async () => {
    const f = fixture();
    assert.equal(succeeded(await f.action('send_like', { user_id: 45678 })), null);
    assert.deepEqual(f.calls.map(x => [x.method, x.params]), [
        ['resolve', { uin: '45678', expectedEpoch: 'extensions-session' }],
        ['interaction', { operation: 'profile.like', uid: 'u_target', count: 1, expectedEpoch: 'extensions-session' }]
    ]);
    assert.ok(f.calls.every(x => x.context.timeoutMs > 0 && x.context.timeoutMs <= 10000));
});

test('send_like accepts exact bounded times and rejects malformed variants before resolving identity', async () => {
    const f = fixture();
    for (const times of [1, 10, '2']) {
        succeeded(await f.action('send_like', { user_id: '45678', times }));
        assert.equal(f.calls.at(-1).params.count, Number(times));
    }
    f.calls.length = 0;
    for (const times of [0, 11, -1, 1.5, true, null, [], {}, '01', '1.0', ' 2 ', 'NaN']) {
        failed(await f.action('send_like', { user_id: '45678', times }), 1400);
    }
    for (const user_id of [0, true, 'u_target', '45678junk', 9007199254740992]) {
        failed(await f.action('send_like', { user_id }), 1400);
    }
    assert.equal(f.calls.length, 0);
});

test('mismatched UID conversions cannot dispatch profile likes', async () => {
    const f = fixture();
    for (const result of [undefined, { uin: '45679', uid: 'u_target' }, { uin: '45678', uid: '45678' }, { uin: '45678', uid: '' }]) {
        f.handlers.resolve = () => result;
        failed(await f.action('send_like', { user_id: 45678 }), 1500);
    }
    assert.equal(f.calls.filter(x => x.method === 'interaction').length, 0);
});

test('like success requires exact confirmation and unknown or partial results are never retried', async () => {
    const f = fixture();
    for (const response of [undefined, {}, { confirmed: false, uid: 'u_target', count: 2 },
        { confirmed: true, uid: 'u_other', count: 2 }, { confirmed: true, uid: 'u_target', count: 1 }]) {
        f.calls.length = 0; f.handlers.interaction = () => response;
        failed(await f.action('send_like', { user_id: 45678, times: 2 }), 1500);
        assert.equal(f.calls.filter(x => x.method === 'interaction').length, 1);
    }
    f.calls.length = 0;
    f.handlers.interaction = () => { throw Object.assign(new Error('Unknown completion; do not retry'), { code: 'TIMEOUT' }); };
    failed(await f.action('send_like', { user_id: 45678 }), 1504);
    assert.equal(f.calls.filter(x => x.method === 'interaction').length, 1);
});

test('at-all allowance retains real zero budgets and validates the returned group', async () => {
    const f = fixture();
    assert.deepEqual(succeeded(await f.action('get_group_at_all_remain', { group_id: 200 })),
        { group_id: 200, can_at_all: false, remain_at_all_count_for_uin: 0, remain_at_all_count_for_group: 0 });
    assert.equal(f.calls[0].params.operation, 'group.atAllRemain');
    for (const response of [{ group_id: 201, can_at_all: false, remain_at_all_count_for_uin: 0, remain_at_all_count_for_group: 0 },
        { group_id: 200, can_at_all: 'false', remain_at_all_count_for_uin: 0, remain_at_all_count_for_group: 0 },
        { group_id: 200, can_at_all: true, remain_at_all_count_for_uin: -1, remain_at_all_count_for_group: 0 }]) {
        f.handlers.interaction = () => response;
        failed(await f.action('get_group_at_all_remain', { group_id: 200 }), 1500);
    }
});

test('root and folder file queries preserve partial pages and exact uint64 sizes', async () => {
    const f = fixture();
    const root = succeeded(await f.action('get_group_root_files', { group_id: 200, count: '1', start_index: '5' }));
    assert.equal(root.files[0].file_size, '18446744073709551614');
    assert.equal(root.files[0].file_name, 'document.txt');
    assert.equal(root.files[0].upload_time, 100);
    assert.equal(root.files[0].uploader, '45678');
    assert.equal(root.start_index, 5); assert.equal(root.next_index, 6);
    assert.equal(root.has_more, true); assert.equal(root.is_end, false); assert.equal(root.total_file_count, 2);
    assert.deepEqual(f.calls[0].params, { operation: 'group.filesList', groupId: '200', directory: '/', startIndex: 5,
        count: 1, expectedEpoch: 'extensions-session' });
    f.handlers.groupFiles = params => ({ ...f.page(params), isEnd: true,
        items: [{ peerId: '200', type: 2, fileInfo: null, folderInfo: { folderId: 'child', folderName: 'Notes', createUin: '45678' } }] });
    const folder = succeeded(await f.action('get_group_files_by_folder', { group_id: '200', folder_id: 'parent', count: 3 }));
    assert.equal(f.calls.at(-1).params.directory, 'parent');
    assert.deepEqual(folder.files, []);
    assert.deepEqual(folder.folders[0], { group_id: 200, folder_id: 'child', folder_name: 'Notes', creator: '45678' });
    assert.equal(folder.has_more, false);
});

test('completed empty folders are distinct from missing or invalid file pages', async () => {
    const f = fixture();
    f.handlers.groupFiles = params => ({ ...f.page(params), items: [], isEnd: true, nextIndex: 0, allFileCount: 0 });
    const empty = succeeded(await f.action('get_group_root_files', { group_id: 200 }));
    assert.deepEqual(empty.files, []); assert.deepEqual(empty.folders, []); assert.equal(empty.is_end, true);
    for (const change of [x => { x.groupId = '201'; }, x => { x.directory = 'wrong'; },
        x => { x.startIndex = 1; }, x => { x.nextIndex = 0; }, x => { x.allFileCount = -1; },
        x => { x.items[0].type = 3; }, x => { x.items[0].folderInfo = { folderId: 'conflict' }; }]) {
        f.handlers.groupFiles = params => { const page = f.page(params); change(page); return page; };
        failed(await f.action('get_group_root_files', { group_id: 200 }), 1500);
    }
    f.handlers.groupFiles = () => undefined;
    failed(await f.action('get_group_root_files', { group_id: 200 }), 1500);
});

test('OneBot mixed and folder-only pages preserve file-only totals instead of counting folders as files', async () => {
    const f = fixture();
    const folder = { peerId: '200', type: 2, fileInfo: null, folderInfo: { folderId: 'child', folderName: 'Notes' } };
    f.handlers.groupFiles = params => ({ ...f.page(params), isEnd: true, nextIndex: 5, allFileCount: 4,
        items: [...Array.from({ length: 4 }, (_, index) => ({ peerId: '200', type: 1, folderInfo: null,
            fileInfo: { ...f.file(), fileId: 'file-' + index } })), folder] });
    const mixed = succeeded(await f.action('get_group_root_files', { group_id: 200 }));
    assert.equal(mixed.files.length, 4); assert.equal(mixed.folders.length, 1);
    assert.equal(mixed.total_file_count, 4); assert.equal(mixed.next_index, 5);
    f.handlers.groupFiles = params => ({ ...f.page(params), isEnd: true, nextIndex: 1, allFileCount: 0, items: [folder] });
    const folders = succeeded(await f.action('get_group_files_by_folder', { group_id: 200, folder_id: 'parent' }));
    assert.equal(folders.files.length, 0); assert.equal(folders.folders.length, 1); assert.equal(folders.total_file_count, 0);
    f.handlers.groupFiles = params => ({ ...f.page(params), allFileCount: 0 });
    failed(await f.action('get_group_root_files', { group_id: 200 }), 1500);
});

test('group file entries cannot be relabelled from another group at the action boundary', async () => {
    const f = fixture();
    f.handlers.groupFiles = params => { const page = f.page(params); page.items[0].peerId = '201'; return page; };
    failed(await f.action('get_group_root_files', { group_id: 200 }), 1500);
});

test('group file detail preserves small numeric sizes and validates exact target identity', async () => {
    const f = fixture();
    f.handlers.groupFiles = params => ({ groupId: params.groupId, fileInfo: { ...f.file(), fileSize: '42' } });
    const detail = succeeded(await f.action('get_group_file_info', { group_id: 200, file_id: 'file-alpha' }));
    assert.equal(detail.file_size, 42); assert.equal(detail.file_id, 'file-alpha');
    for (const response of [{ groupId: '201', fileInfo: f.file() },
        { groupId: '200', fileInfo: { ...f.file(), fileId: 'file-other' } }]) {
        f.handlers.groupFiles = () => response;
        failed(await f.action('get_group_file_info', { group_id: 200, file_id: 'file-alpha' }), 1500);
    }
});

test('file metadata rejects inexact numbers, out-of-range native fields and empty identities', async () => {
    const f = fixture();
    for (const modify of [info => { info.fileSize = 18446744073709551614; }, info => { info.fileSize = '18446744073709551616'; },
        info => { info.busId = 4294967296; }, info => { info.fileId = ''; }]) {
        f.handlers.groupFiles = params => { const page = f.page(params); modify(page.items[0].fileInfo); return page; };
        failed(await f.action('get_group_root_files', { group_id: 200 }), 1500);
    }
});

test('invalid query parameters and missing capability flags block the native bridge', async () => {
    const f = fixture();
    for (const [action, params] of [['get_group_root_files', { group_id: 200, count: 0 }],
        ['get_group_root_files', { group_id: 200, start_index: -1 }], ['get_group_root_files', { group_id: 200, count: 101 }],
        ['get_group_files_by_folder', { group_id: 200, folder_id: '' }], ['get_group_file_info', { group_id: 200, file_id: 'bad\nfile' }]]) {
        failed(await f.action(action, params), 1400);
    }
    assert.equal(f.calls.length, 0);
    for (const [action, flag, params] of [['send_like', 'profileLike', { user_id: 45678 }],
        ['get_group_at_all_remain', 'groupAtAllRemain', { group_id: 200 }],
        ['get_group_root_files', 'groupFiles', { group_id: 200 }],
        ['get_group_file_info', 'groupFileInfo', { group_id: 200, file_id: 'file-alpha' }]]) {
        f.state.capabilities[flag] = false;
        failed(await f.action(action, params), 1404);
    }
    assert.equal(f.calls.length, 0);
});

test('query actions enforce account authorization and reject stale expected sessions', async () => {
    const f = fixture();
    f.service.authorizeSession = () => false;
    failed(await f.action('send_like', { user_id: 45678 }), 1503);
    failed(await f.action('get_group_root_files', { group_id: 200 }), 1503);
    assert.equal(f.calls.length, 0);
    f.service.authorizeSession = () => true;
    failed(await f.action('get_group_root_files', { group_id: 200 }, {}, { epoch: 'old', selfUin: '12345' }), 1503);
    failed(await f.action('get_group_root_files', { group_id: 200, self_id: 12346 }), 1400);
    assert.equal(f.calls.length, 0);
});

test('session replacement or authorization revocation during conversion suppresses the like mutation', async () => {
    for (const revoke of [f => { f.state.epoch = 'new-session'; }, f => { f.service.authorizeSession = () => false; }]) {
        const f = fixture();
        f.handlers.resolve = params => { revoke(f); return { uin: params.uin, uid: 'u_target' }; };
        failed(await f.action('send_like', { user_id: 45678 }), 1503);
        assert.equal(f.calls.filter(x => x.method === 'interaction').length, 0);
    }
});

test('session changes discard returned query data and echo survives both success and failure unchanged', async () => {
    const f = fixture(), echo = { id: [0, null, 'same'], meta: { bool: false } };
    const success = await f.action('get_group_at_all_remain', { group_id: 200 }, { echo });
    succeeded(success); assert.deepEqual(success.echo, echo);
    f.handlers.groupFiles = params => { f.state.epoch = 'new-session'; return f.page(params); };
    const failure = await f.action('get_group_root_files', { group_id: 200 }, { echo });
    failed(failure, 1503); assert.deepEqual(failure.echo, echo);
    assert.equal(f.calls.filter(x => x.method === 'groupFiles').length, 1);
    for (const echo of [0, false, null, '']) {
        const response = await f.action('send_like', { user_id: 0 }, { echo });
        failed(response, 1400); assert.deepEqual(response.echo, echo);
    }
});
