'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createGroupFiles } = require('../src/qq/group-files.cjs');
const { ACTIONS, ACTION_REQUIREMENTS, runGroupFiles } = require('../src/onebot/group-files.cjs');

function fixture(t) {
    const capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' } });
    t.after(() => capture.close());
    capture.ready = true; capture.qqVersion = '3.2.35-54395'; capture.epoch = 'management-session';
    capture.self = { uid: 'u_self', uin: '12345' };
    capture.registrations.push({ name: 'msg', service: {}, remove: 'none' });
    const calls = [], queryCalls = [], rich = {}, api = createGroupFiles(capture);
    const emit = value => api.listenerMethods.msg.onGroupFileInfoUpdate(value);
    const rootPage = (folderName = 'Renamed', reqId = queryCalls.length) => ({ reqId, retCode: 0, isEnd: true,
        nextIndex: 1, allFileCount: 0, item: [{ peerId: '200', type: 2, fileInfo: null,
            folderInfo: { folderId: 'folder-A', folderName } }] });
    rich.getGroupFileList = (...args) => {
        queryCalls.push(structuredClone(args)); const reqId = queryCalls.length;
        setImmediate(() => emit(rootPage('Renamed', reqId))); return reqId;
    };
    capture.session = { getRichMediaService: () => rich };
    const methods = {
        batchGetGroupFileCount: () => ({ result: 0, groupCodes: ['200'], groupFileCounts: [4] }),
        createGroupFolder: () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: { folderId: 'folder-A', folderName: 'Test' } } }),
        renameGroupFolder: () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: { folderId: 'folder-A', folderName: 'Renamed' } } }),
        deleteGroupFolder: () => ({ result: 0, groupFileCommonResult: { retCode: 0 } }),
        deleteGroupFile: () => ({ result: 0, transGroupFileResult: { result: { retCode: 0 }, successFileIdList: ['file-A'], failFileIdList: [] } }),
        moveGroupFile: () => ({ result: 0, moveGroupFileResult: { result: { retCode: 0 }, successFileIdList: ['file-A'], failFileIdList: [] } }),
        transGroupFile: () => ({ result: 0, transGroupFileResult: { result: { retCode: 0 }, saveBusId: 102, saveFilePath: 'server/opaque/location' } }),
        renameGroupFile: () => ({ result: 0, renameGroupFileResult: { result: { retCode: 0 } } })
    };
    for (const [method, response] of Object.entries(methods)) rich[method] = (...args) => { calls.push({ method, args: structuredClone(args) }); return response(); };
    const params = {
        'group.fileCount': { groupIds: ['200'] },
        'group.folderCreate': { groupId: '200', name: 'Test', parentDirectory: '/' },
        'group.folderRename': { groupId: '200', folderId: 'folder-A', name: 'Renamed' },
        'group.folderDelete': { groupId: '200', folderId: 'folder-A' },
        'group.fileDelete': { groupId: '200', files: [{ fileId: 'file-A', busId: 102 }] },
        'group.fileMove': { groupId: '200', files: [{ fileId: 'file-A', busId: 102 }], sourceDirectory: '/', destinationDirectory: 'folder-A' },
        'group.fileTrans': { groupId: '200', fileId: 'file-A' },
        'group.fileRename': { groupId: '200', fileId: 'file-A', busId: 102, parentDirectory: '/', name: 'new.txt' }
    };
    const dispatch = (operation, extra = {}, context = {}) => api.dispatch(operation,
        { ...structuredClone(params[operation]), expectedEpoch: capture.epoch, ...extra }, context);
    return { capture, calls, queryCalls, api, emit, rootPage, rich, params, methods, dispatch };
}

test('group file management uses fixed native signatures and exact account-scoped results', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.dispatch('group.fileCount'), { counts: { 200: 4 } });
    assert.deepEqual(await f.dispatch('group.folderCreate'), { confirmed: true, groupId: '200', folderId: 'folder-A', name: 'Test' });
    assert.deepEqual(await f.dispatch('group.folderRename'), { confirmed: true, groupId: '200', folderId: 'folder-A', name: 'Renamed' });
    assert.deepEqual(await f.dispatch('group.folderDelete'), { confirmed: true, groupId: '200', folderId: 'folder-A' });
    assert.deepEqual(await f.dispatch('group.fileDelete'), { confirmed: true, groupId: '200', fileIds: ['file-A'] });
    assert.deepEqual(await f.dispatch('group.fileMove'), { confirmed: true, groupId: '200', fileIds: ['file-A'] });
    assert.deepEqual(await f.dispatch('group.fileTrans'), { confirmed: true, groupId: '200', fileId: 'file-A', saveBusId: 102, saveFilePath: 'server/opaque/location' });
    assert.deepEqual(await f.dispatch('group.fileRename'), { confirmed: true, groupId: '200', fileId: 'file-A', name: 'new.txt' });
    assert.deepEqual(f.calls, [
        { method: 'batchGetGroupFileCount', args: [['200']] }, { method: 'createGroupFolder', args: ['200', 'Test'] },
        { method: 'renameGroupFolder', args: ['200', 'folder-A', 'Renamed'] }, { method: 'deleteGroupFolder', args: ['200', 'folder-A'] },
        { method: 'deleteGroupFile', args: ['200', [102], ['file-A']] }, { method: 'moveGroupFile', args: ['200', [102], ['file-A'], '/', 'folder-A'] },
        { method: 'transGroupFile', args: ['200', 'file-A'] }, { method: 'renameGroupFile', args: ['200', 102, 'file-A', '/', 'new.txt'] }
    ]);
    assert.equal(Object.hasOwn(f.api.capabilities(), 'groupFileSpace'), false);
    assert.equal(f.api.capabilities().groupFolderCreate, true);
    delete f.rich.createGroupFolder;
    assert.equal(f.api.capabilities().groupFolderCreate === true, false);
    await assert.rejects(f.dispatch('group.folderCreate'), { code: 'UNSUPPORTED' });
});

test('group file counts match the complete requested identity set without invented capacity', async t => {
    const f = fixture(t);
    f.rich.batchGetGroupFileCount = () => ({ result: 0, groupCodes: ['201', '200'], groupFileCounts: [0, 4] });
    assert.deepEqual(await f.dispatch('group.fileCount', { groupIds: ['200', '201'] }), { counts: { 200: 4, 201: 0 } });
    for (const patch of [{ groupCodes: ['200'] }, { groupCodes: ['200', '200'] }, { groupCodes: ['201', 200] },
        { groupFileCounts: [4] }, { groupFileCounts: [0, -1] }, { groupFileCounts: [0, '4'] }, { groupFileCounts: [0, Number.MAX_SAFE_INTEGER] }]) {
        f.rich.batchGetGroupFileCount = () => ({ result: 0, groupCodes: ['201', '200'], groupFileCounts: [0, 4], ...patch });
        await assert.rejects(f.dispatch('group.fileCount', { groupIds: ['200', '201'] }), { code: 'INVALID_RESPONSE' });
    }
});

test('all native management operations reject dispatch-only and missing business outcomes', async t => {
    const f = fixture(t);
    for (const operation of Object.keys(f.params)) {
        const original = f.calls.length;
        const nativeMethod = Object.keys(f.methods)[Object.keys(f.params).indexOf(operation)];
        for (const result of [undefined, null, 0, {}, { result: 0 }, { result: '0' }]) {
            f.rich[nativeMethod] = () => result;
            await assert.rejects(f.dispatch(operation), { code: 'INVALID_RESPONSE' }, operation);
        }
        assert.equal(f.calls.length, original);
    }
});

test('nested business errors cannot be hidden behind a successful top-level code', async t => {
    const f = fixture(t);
    for (const [operation, method, response] of [
        ['group.folderDelete', 'deleteGroupFolder', { result: 0, groupFileCommonResult: { retCode: 4 } }],
        ['group.folderCreate', 'createGroupFolder', { result: 0, resultWithGroupItem: { result: { retCode: 4 } } }],
        ['group.fileDelete', 'deleteGroupFile', { result: 0, transGroupFileResult: { result: { retCode: 4 }, successFileIdList: ['file-A'], failFileIdList: [] } }],
        ['group.fileMove', 'moveGroupFile', { result: 0, moveGroupFileResult: { result: { retCode: 4 } } }],
        ['group.fileRename', 'renameGroupFile', { result: 0, renameGroupFileResult: { result: { retCode: 4 } } }],
        ['group.fileTrans', 'transGroupFile', { result: 0, transGroupFileResult: { result: { retCode: 4 } } }],
        ['group.folderDelete', 'deleteGroupFolder', { result: 0, groupFileCommonResult: { retCode: 0, errCode: 2 } }]
    ]) {
        f.rich[method] = () => response;
        await assert.rejects(f.dispatch(operation), { code: 'KERNEL_ERROR' });
    }
});

test('nonzero business diagnostics preserve only validated numeric codes at every result layer without leaking private data', async t => {
    const f = fixture(t), secret = 'PRIVATE_RETMSG_FILENAME_AND_FILEID', privateFields = {
        retMsg: secret, errMsg: secret, fileName: secret, fileId: secret, folderName: secret, folderId: secret
    };
    let nativeCalls = 0;
    const rename = extra => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, ...extra }, ...privateFields });
    const cases = [
        ['group.folderRename', 'renameGroupFolder', 'result', -3, { result: -3, ...privateFields }],
        ['group.folderRename', 'renameGroupFolder', 'retCode', 17, { result: 0, retCode: 17, ...privateFields }],
        ['group.folderRename', 'renameGroupFolder', 'errCode', -10001, { result: 0, errCode: -10001, ...privateFields }],
        ['group.folderRename', 'renameGroupFolder', 'retcode', 53, { result: 0, retcode: 53, ...privateFields }],
        ['group.folderRename', 'renameGroupFolder', 'errcode', Number.MAX_SAFE_INTEGER,
            { result: 0, errcode: Number.MAX_SAFE_INTEGER, ...privateFields }],
        ['group.folderRename', 'renameGroupFolder', 'errCode', 67, rename({ errCode: 67, ...privateFields })],
        ['group.folderRename', 'renameGroupFolder', 'retCode', -117,
            rename({ result: { retCode: -117, ...privateFields } })],
        ['group.folderRename', 'renameGroupFolder', 'errcode', 203,
            rename({ result: { retCode: 0, errcode: 203, ...privateFields } })],
        ['group.folderDelete', 'deleteGroupFolder', 'retCode', 307,
            { result: 0, groupFileCommonResult: { retCode: 307, ...privateFields }, ...privateFields }]
    ];
    for (const [operation, method, key, value, response] of cases) {
        f.rich[method] = () => { nativeCalls++; return response; };
        await assert.rejects(f.dispatch(operation), error => {
            assert.equal(error.code, 'KERNEL_ERROR');
            assert.equal(error.message, 'QQ rejected the group file operation (' + key + '=' + value + '); it was not retried');
            assert.equal(error.message.includes(secret), false);
            return true;
        });
    }
    assert.equal(nativeCalls, cases.length, 'each failed mutation is dispatched only once');
});

test('non-numeric or unsafe business code fields are never interpolated or coerced into diagnostics', async t => {
    const f = fixture(t); let nativeCalls = 0, coerced = false;
    const secret = 'PRIVATE_UNTRUSTED_BUSINESS_CODE';
    const invalid = [secret, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1n, null,
        { toString() { coerced = true; throw new Error(secret); } }];
    for (const value of invalid) {
        for (const nested of [false, true]) {
            f.rich.renameGroupFolder = () => {
                nativeCalls++;
                return nested
                    ? { result: 0, resultWithGroupItem: { result: { retCode: 0, errCode: value }, retMsg: secret } }
                    : { result: 0, errCode: value, retMsg: secret, fileName: secret, fileId: secret };
            };
            await assert.rejects(f.dispatch('group.folderRename'), error => {
                assert.equal(error.code, 'INVALID_RESPONSE');
                assert.equal(error.message, 'QQ returned an invalid group file business result');
                assert.equal(error.message.includes(secret), false);
                return true;
            });
        }
    }
    assert.equal(coerced, false); assert.equal(nativeCalls, invalid.length * 2);
});

test('file batches require exact complete success lists and do not resend partial results', async t => {
    const f = fixture(t);
    for (const [operation, method, wrapper] of [['group.fileDelete', 'deleteGroupFile', 'transGroupFileResult'],
        ['group.fileMove', 'moveGroupFile', 'moveGroupFileResult']]) {
        let calls = 0;
        const files = [{ fileId: 'file-A', busId: 102 }, { fileId: 'file-B', busId: 101 }];
        for (const [ok, failed] of [[['file-A'], []], [['file-A', 'other'], []], [['file-A', 'file-A'], []], [['file-A', 'file-B'], ['file-B']], [undefined, []]]) {
            f.rich[method] = () => { calls++; return { result: 0, [wrapper]: { result: { retCode: 0 }, successFileIdList: ok, failFileIdList: failed } }; };
            await assert.rejects(f.dispatch(operation, { files }), { code: 'PARTIAL_RESULT' });
        }
        assert.equal(calls, 5);
        f.rich[method] = (...args) => { calls++; assert.deepEqual(args.slice(0, 3), ['200', [102, 101], ['file-A', 'file-B']]);
            return { result: 0, [wrapper]: { result: { retCode: 0 }, successFileIdList: ['file-B', 'file-A'], failFileIdList: [] } }; };
        assert.deepEqual((await f.dispatch(operation, { files })).fileIds, ['file-A', 'file-B']);
        assert.equal(calls, 6);
    }
});

test('invalid entire batches, directory/name mismatches and unknown keys cause no native calls', async t => {
    const f = fixture(t);
    const cases = [
        ['group.fileCount', { groupIds: ['200', '200'] }], ['group.fileCount', { groupIds: [] }],
        ['group.fileDelete', { files: [{ fileId: 'file-A', busId: 102 }, { fileId: 'file-B', busId: -1 }] }],
        ['group.fileDelete', { files: [{ fileId: 'file-A', busId: 102 }, { fileId: 'file-A', busId: 101 }] }],
        ['group.fileDelete', { files: [{ fileId: 'file-A', busId: 102, arbitrary: true }] }],
        ['group.fileMove', { destinationDirectory: '/' }], ['group.fileMove', { sourceDirectory: '' }],
        ['group.folderCreate', { name: '../unsafe' }], ['group.folderRename', { name: 'bad\nname' }],
        ['group.fileRename', { busId: '102' }], ['group.fileTrans', { fileId: 'bad\0id' }],
        ['group.folderDelete', { groupId: '4294967296' }], ['group.folderDelete', { nativeOptions: {} }],
        ['group.folderDelete', { operation: 'group.fileMove' }]
    ];
    for (const [operation, params] of cases) await assert.rejects(f.dispatch(operation, params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.dispatch('group.folderCreate', { parentDirectory: 'child' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('every mutation requires a matching epoch and initialized acting account before dispatch', async t => {
    const f = fixture(t);
    for (const operation of Object.keys(f.params).filter(key => key !== 'group.fileCount')) {
        await assert.rejects(f.dispatch(operation, { expectedEpoch: undefined }), { code: 'SESSION_CHANGED' });
        await assert.rejects(f.dispatch(operation, { expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    }
    f.capture.self = { uin: null, uid: null };
    await assert.rejects(f.dispatch('group.folderDelete'), { code: 'NOT_READY' });
    assert.equal(f.calls.length, 0);
});

test('resource identity contradictions and missing transfer locators are rejected', async t => {
    const f = fixture(t);
    for (const [operation, method, value] of [
        ['group.folderCreate', 'createGroupFolder', { result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: { folderId: 'folder-A', folderName: 'other' } } }],
        ['group.folderRename', 'renameGroupFolder', { result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: { folderId: 'other', folderName: 'Renamed' } } }],
        ['group.folderDelete', 'deleteGroupFolder', { result: 0, groupId: '201', groupFileCommonResult: { retCode: 0 } }],
        ['group.fileTrans', 'transGroupFile', { result: 0, transGroupFileResult: { result: { retCode: 0 }, saveBusId: 102 } }],
        ['group.fileRename', 'renameGroupFile', { result: 0, renameGroupFileResult: { result: { retCode: 0 }, fileInfo: { fileId: 'other' } } }]
    ]) {
        f.rich[method] = () => value;
        await assert.rejects(f.dispatch(operation), { code: 'INVALID_RESPONSE' });
    }
});

test('folder results accept the fixed one-item native wrapper but reject ambiguous or conflicting identities', async t => {
    const f = fixture(t), folder = { folderId: 'folder-A', folderName: 'Test' };
    for (const groupItem of [[folder], [{ folderInfo: folder }]]) {
        f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, groupItem } });
        assert.equal((await f.dispatch('group.folderCreate')).folderId, 'folder-A');
    }
    for (const fields of [{ groupItem: [folder, folder] }, { groupItem: [] },
        { folderInfo: folder, groupItem: [{ folderId: 'other', folderName: 'Test' }] }]) {
        f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, ...fields } });
        await assert.rejects(f.dispatch('group.folderCreate'), { code: 'INVALID_RESPONSE' });
    }
});

test('valid folderInfo tolerates empty default groupItem records on folder create and rename', async t => {
    const f = fixture(t);
    for (const groupItem of [null, [], {}]) {
        f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, groupItem,
            folderInfo: { folderId: 'folder-A', folderName: 'Test' } } });
        assert.deepEqual(await f.dispatch('group.folderCreate'), { confirmed: true, groupId: '200', folderId: 'folder-A', name: 'Test' });
        f.rich.renameGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, groupItem,
            folderInfo: { folderId: 'folder-A', folderName: 'Renamed' } } });
        assert.deepEqual(await f.dispatch('group.folderRename'), { confirmed: true, groupId: '200', folderId: 'folder-A', name: 'Renamed' });
    }
});

test('native folder GroupItems bind the requested group on create and rename, including inactive direct members', async t => {
    const f = fixture(t);
    for (const [operation, method, folderName] of [
        ['group.folderCreate', 'createGroupFolder', 'Test'], ['group.folderRename', 'renameGroupFolder', 'Renamed']
    ]) {
        const folder = { folderId: 'folder-A', folderName };
        for (const folderInfo of [undefined, null, structuredClone(folder)]) {
            for (const array of [false, true]) {
                const item = { peerId: '200', type: 2, folderInfo: structuredClone(folder), fileInfo: null };
                f.rich[method] = () => ({ result: 0, resultWithGroupItem: {
                    result: { retCode: 0 }, folderInfo, groupItem: array ? [item] : item
                } });
                assert.deepEqual(await f.dispatch(operation), { confirmed: true, groupId: '200', folderId: 'folder-A', name: folderName });
            }
        }
        f.rich[method] = () => ({ result: 0, resultWithGroupItem: {
            result: { retCode: 0 }, groupItem: { peerId: '200', type: 2, folderInfo: folder }
        } });
        assert.equal((await f.dispatch(operation)).name, folderName);
    }
});

test('native folder create GroupItems cannot hide wrong peers, union types or file identities behind valid direct folders', async t => {
    const f = fixture(t);
    let nativeCalls = 0, attempts = 0;
    for (const [operation, method, folderName] of [
        ['group.folderCreate', 'createGroupFolder', 'Test']
    ]) {
        const folder = { folderId: 'folder-A', folderName };
        const valid = { peerId: '200', type: 2, folderInfo: folder, fileInfo: null };
        const malformed = [
            { ...valid, peerId: '201' }, { ...valid, peerId: 200 }, { ...valid, peerId: undefined },
            { ...valid, type: undefined }, { ...valid, type: 1 }, { ...valid, type: '2' },
            { ...valid, folderInfo: null }, { ...valid, folderInfo: undefined },
            { ...valid, folderInfo: {} }, { ...valid, folderInfo: { folderName } },
            { ...valid, folderInfo: { folderId: 'folder-A' } },
            { ...valid, folderInfo: { folderId: '', folderName } },
            { ...valid, folderInfo: { folderId: 'folder-A', folderName: '' } },
            { ...valid, folderInfo: { folderId: 'other', folderName } },
            { ...valid, folderInfo: { folderId: 'folder-A', folderName: 'Other' } },
            { ...valid, fileInfo: {} }, { ...valid, fileInfo: { fileId: 'file-A' } },
            { ...valid, folderId: 'other', folderName },
            { folderInfo: folder }, { folderId: 'folder-A', folderName }
        ];
        for (const groupItem of malformed) {
            f.rich[method] = () => { nativeCalls++; return { result: 0, resultWithGroupItem: {
                result: { retCode: 0 }, folderInfo: folder, groupItem
            } }; };
            attempts++;
            await assert.rejects(f.dispatch(operation), { code: 'INVALID_RESPONSE' });
        }
        // Old one-element arrays do not bypass native identity validation.
        for (const groupItem of malformed.slice(0, 18).map(item => [item])) {
            f.rich[method] = () => { nativeCalls++; return { result: 0, resultWithGroupItem: {
                result: { retCode: 0 }, folderInfo: folder, groupItem
            } }; };
            attempts++;
            await assert.rejects(f.dispatch(operation), { code: 'INVALID_RESPONSE' });
        }
    }
    assert.equal(nativeCalls, attempts, 'unknown outcomes are never dispatched again automatically');
});

test('inactive direct folder members alone never confirm a native folder mutation', async t => {
    const f = fixture(t);
    for (const groupItem of [undefined, null, {}, [], { peerId: '200', type: 2, folderInfo: null, fileInfo: null }]) {
        f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: null, groupItem } });
        await assert.rejects(f.dispatch('group.folderCreate'), { code: 'INVALID_RESPONSE' });
    }
});

test('empty groupItem defaults never replace missing identities or conceal nonempty contradictions', async t => {
    const f = fixture(t), folder = { folderId: 'folder-A', folderName: 'Test' };
    for (const groupItem of [null, [], {}]) {
        for (const folderInfo of [undefined, null, {}, { folderName: 'Test' }, { folderId: '', folderName: 'Test' }]) {
            f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, groupItem, folderInfo } });
            await assert.rejects(f.dispatch('group.folderCreate'), { code: 'INVALID_RESPONSE' });
        }
    }
    for (const groupItem of [{ folderId: 'other', folderName: 'Test' }, [{ folderId: 'other', folderName: 'Test' }],
        [{ folderInfo: { folderId: 'other', folderName: 'Test' } }], [{ folderInfo: folder, folderId: 'other', folderName: 'Test' }],
        [{ folderId: 'folder-A', folderName: 'other' }], [folder, folder], [undefined]]) {
        f.rich.createGroupFolder = () => ({ result: 0, resultWithGroupItem: { result: { retCode: 0 }, folderInfo: folder, groupItem } });
        await assert.rejects(f.dispatch('group.folderCreate'), { code: 'INVALID_RESPONSE' });
    }
});

test('folder rename requires an independent root readback after explicit success, including incomplete SDK echoes', async t => {
    const f = fixture(t), neutral = { peerId: '0', type: 0, folderInfo: null, fileInfo: null };
    let writes = 0;
    const echoes = [undefined, null, {}, [], neutral, { ...neutral, peerId: '' }, [neutral],
        { peerId: '200', type: 2, folderInfo: { folderId: '', folderName: '' }, fileInfo: null },
        { peerId: '200', folderInfo: { folderId: 'folder-A' } }, { folderInfo: {} },
        { folderInfo: { folderName: 'Old' } }, { type: 1, folderInfo: null, fileInfo: {} },
        { type: 0, fileInfo: { fileId: '' } }, { ...neutral, extra: 'unused' },
        { folderId: 'folder-A' }, [{ folderInfo: { folderId: 'folder-A' }, fileInfo: {} }]];
    for (const groupItem of echoes) {
        f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: {
            result: { retCode: 0 }, groupItem, folderInfo: null
        } }; };
        assert.deepEqual(await f.dispatch('group.folderRename'), { confirmed: true, groupId: '200', folderId: 'folder-A', name: 'Renamed' });
    }
    // Echo names are not a fresh snapshot; the exact stable ID is still bound.
    f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: {
        result: { retCode: 0 }, folderInfo: { folderId: 'folder-A', folderName: 'Old name' },
        groupItem: { peerId: '200', type: 2, fileInfo: null, folderInfo: { folderId: 'folder-A', folderName: 'Older name' } }
    } }; };
    assert.equal((await f.dispatch('group.folderRename')).confirmed, true);
    assert.equal(writes, echoes.length + 1); assert.equal(f.queryCalls.length, writes);
    assert.ok(f.queryCalls.every(([id, request]) => id === '200' && request.startIndex === 0 && request.fileCount === 100 &&
        !Object.hasOwn(request, 'folderId')));
});

test('rename rejects concrete echo identity conflicts and unknown shapes before directory confirmation without exposing values', async t => {
    const f = fixture(t), secret = 'PRIVATE_FOLDER_FILE_AND_PEER', folder = { folderId: 'folder-A', folderName: 'Old' };
    const valid = { peerId: '200', type: 2, folderInfo: folder, fileInfo: null };
    const neutral = { peerId: '0', type: 0, folderInfo: null, fileInfo: null };
    let writes = 0;
    const echoes = [
        { ...valid, peerId: '201' }, { ...valid, peerId: 200 }, { ...valid, peerId: '4294967296' },
        { ...valid, groupCode: '201' }, { ...valid, type: '2' }, { ...valid, type: -1 }, { ...valid, type: 0.5 },
        { ...valid, folderInfo: { folderId: secret, folderName: 'Other' } },
        { ...valid, folderInfo: { folderId: 1 } }, { ...valid, folderInfo: { folderName: 1 } },
        { ...valid, fileInfo: { fileId: secret } }, { ...valid, fileInfo: { fileId: 1 } },
        { ...valid, folderId: secret, folderName: secret }, { ...valid, folderInfo: [] },
        { ...neutral, fileInfo: new Date(0) }, [valid, valid], [undefined], [null], secret, new Date(0)
    ];
    for (const groupItem of echoes) {
        f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: {
            result: { retCode: 0 }, folderInfo: folder, groupItem
        } }; };
        await assert.rejects(f.dispatch('group.folderRename'), error => {
            assert.equal(error.code, 'INVALID_RESPONSE'); assert.doesNotMatch(error.message, /PRIVATE_|201|folder-A|Old/); return true;
        });
    }
    assert.equal(writes, echoes.length); assert.equal(f.queryCalls.length, 0);
});

test('incomplete rename echoes cannot confirm a wrong group, another folder or stale root name', async t => {
    for (const outcome of ['group', 'folder', 'name']) {
        const f = fixture(t); let writes = 0, reads = 0;
        f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: {
            result: { retCode: 0 }, groupItem: { peerId: '200', type: 2, folderInfo: {}, fileInfo: {} }
        } }; };
        f.rich.getGroupFileList = () => {
            const reqId = ++reads, page = f.rootPage(outcome === 'name' ? 'Old' : 'Renamed', reqId);
            if (outcome === 'group') page.item[0].peerId = '201';
            if (outcome === 'folder') page.item[0].folderInfo.folderId = 'other-folder';
            setImmediate(() => f.emit(page)); return reqId;
        };
        await assert.rejects(f.dispatch('group.folderRename', {}, { expiresAt: Date.now() + 80 }),
            error => outcome === 'group' ? error.code === 'INVALID_RESPONSE' : ['EXPIRED', 'TIMEOUT'].includes(error.code));
        assert.equal(writes, 1); assert.ok(reads > 0);
    }
});

test('rename polls stale or absent identities by reads alone and does not confuse another same-name folder with the target', async t => {
    const f = fixture(t); let writes = 0, reads = 0;
    f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: { result: { retCode: 0 } } }; };
    f.rich.getGroupFileList = () => {
        const reqId = ++reads;
        const page = f.rootPage(reads === 2 ? 'Old' : 'Renamed', reqId);
        if (reads === 1) page.item[0].folderInfo.folderId = 'other-folder';
        setImmediate(() => f.emit(page)); return reqId;
    };
    assert.equal((await f.dispatch('group.folderRename', {}, { expiresAt: Date.now() + 1500 })).confirmed, true);
    assert.equal(writes, 1); assert.equal(reads, 3);
});

test('rename reads complete root pagination before success and rejects repeated identities across pages', async t => {
    const f = fixture(t); let writes = 0, reads = 0;
    f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: { result: { retCode: 0 } } }; };
    f.rich.getGroupFileList = (_group, request) => {
        const reqId = ++reads, page = f.rootPage('Renamed', reqId);
        if (request.startIndex === 0) { page.isEnd = false; page.nextIndex = 100; }
        setImmediate(() => f.emit(page)); return reqId;
    };
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'INVALID_RESPONSE' });
    assert.equal(writes, 1); assert.equal(reads, 2);
    reads = 0;
    f.rich.getGroupFileList = (_group, request) => {
        const reqId = ++reads, page = f.rootPage('Renamed', reqId);
        if (request.startIndex === 0) { page.isEnd = false; page.nextIndex = 100; }
        else page.item[0].folderInfo.folderId = 'other-folder';
        setImmediate(() => f.emit(page)); return reqId;
    };
    assert.equal((await f.dispatch('group.folderRename')).confirmed, true);
    assert.equal(writes, 2); assert.equal(reads, 2);
});

test('rename bounds root scanning and cannot let a correct echo bypass a readback timeout or query error', async t => {
    const f = fixture(t); let writes = 0, reads = 0;
    f.rich.renameGroupFolder = () => { writes++; return { result: 0, resultWithGroupItem: {
        result: { retCode: 0 }, folderInfo: { folderId: 'folder-A', folderName: 'Renamed' }
    } }; };
    f.rich.getGroupFileList = (_group, request) => {
        const reqId = ++reads, page = f.rootPage('Renamed', reqId);
        page.item[0].folderInfo.folderId = 'unrelated-' + reqId; page.isEnd = false; page.nextIndex = request.startIndex + 100;
        setImmediate(() => f.emit(page)); return reqId;
    };
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'QUERY_LIMIT' });
    assert.equal(reads, 20); assert.equal(writes, 1);
    f.rich.getGroupFileList = () => ++reads;
    await assert.rejects(f.dispatch('group.folderRename', {}, { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 2); assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    f.rich.getGroupFileList = () => {
        const reqId = ++reads; setImmediate(() => f.emit({ ...f.rootPage('Renamed', reqId), retCode: 5 })); return reqId;
    };
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'KERNEL_ERROR' }); assert.equal(writes, 3);
});

test('an outer rename deadline retires a slower nested page observer before returning', async t => {
    const f = fixture(t), caller = new AbortController();
    const deadline = f.capture.deadline.bind(f.capture);
    let deadlines = 0, nestedSignal, writes = 0, reads = 0;
    f.capture.deadline = (operation, context, ...args) => {
        if (++deadlines === 1) return deadline(operation, context, ...args);
        nestedSignal = context.signal;
        // Force the nested timer to remain pending after the outer deadline.
        // Cancellation, rather than timer ordering or an extra sleep, must
        // remove its observer before the public operation rejects.
        return deadline(operation, { ...context, expiresAt: Date.now() + 30000 }, ...args);
    };
    f.rich.renameGroupFolder = () => {
        writes++; return { result: 0, resultWithGroupItem: { result: { retCode: 0 } } };
    };
    f.rich.getGroupFileList = () => { reads++; return 17; };
    await assert.rejects(f.dispatch('group.folderRename', {}, {
        signal: caller.signal, expiresAt: Date.now() + 40
    }), { code: 'TIMEOUT' });
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.equal(nestedSignal.aborted, true); assert.equal(caller.signal.aborted, false);
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    assert.equal(f.capture.pending.size, 0);
    f.emit(f.rootPage('Renamed', 17));
    assert.equal(writes, 1); assert.equal(reads, 1);
});

test('rename requires query capability before writing and keeps the group locked throughout readback', async t => {
    const f = fixture(t), original = f.rich.getGroupFileList;
    delete f.rich.getGroupFileList;
    assert.equal(f.api.capabilities().groupFolderRename, undefined);
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
    f.rich.getGroupFileList = original; f.capture.registrations.length = 0;
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'UNSUPPORTED' }); assert.equal(f.calls.length, 0);
    f.capture.registrations.push({ name: 'msg', service: {}, remove: 'none' });
    f.rich.getGroupFileList = () => 17;
    const pending = f.dispatch('group.folderRename'); pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.dispatch('group.folderDelete'), { code: 'BUSY' });
    assert.equal(f.calls.length, 1);
    f.emit(f.rootPage('Renamed', 17)); assert.equal((await pending).confirmed, true);
    assert.equal((await f.dispatch('group.folderDelete')).confirmed, true);
});

test('rename readback cancellation and session replacement cannot confirm late pages or leak observers', async t => {
    for (const changeSession of [false, true]) {
        const f = fixture(t), controller = new AbortController();
        f.rich.getGroupFileList = () => 17;
        const pending = f.dispatch('group.folderRename', {}, { signal: controller.signal }); pending.catch(() => {});
        await new Promise(resolve => setImmediate(resolve));
        if (changeSession) { f.capture.epoch = 'next-session'; f.emit(f.rootPage('Renamed', 17)); }
        else controller.abort();
        await assert.rejects(pending, { code: changeSession ? 'SESSION_CHANGED' : 'EXPIRED' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
        assert.equal(f.calls.filter(call => call.method === 'renameGroupFolder').length, 1);
    }
});

test('mutation locks isolate groups while a native response remains unresolved', async t => {
    const f = fixture(t), releases = new Map();
    f.rich.deleteGroupFolder = id => new Promise(resolve => releases.set(id, resolve));
    const first = f.dispatch('group.folderDelete');
    const other = f.dispatch('group.folderDelete', { groupId: '201' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases.size, 2);
    releases.get('201')({ result: 0, groupFileCommonResult: { retCode: 0 } });
    assert.equal((await other).groupId, '201');
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'BUSY' });
    releases.get('200')({ result: 0, groupFileCommonResult: { retCode: 0 } });
    assert.equal((await first).groupId, '200');
});

test('a native timeout keeps the conflicting mutation locked without automatic resend', async t => {
    const f = fixture(t);
    let complete, calls = 0;
    f.rich.deleteGroupFolder = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
    await assert.rejects(f.dispatch('group.folderDelete', {}, { expiresAt: Date.now() + 40 }), { code: 'TIMEOUT' });
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'BUSY' });
    assert.equal(calls, 1);
    complete({ result: 0, groupFileCommonResult: { retCode: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal((await f.dispatch('group.folderRename')).confirmed, true);
});

test('late results from a replaced account or session cannot confirm or unlock new operations', async t => {
    const f = fixture(t);
    let oldComplete, newComplete;
    f.rich.deleteGroupFolder = () => new Promise(resolve => { oldComplete = resolve; });
    const old = f.dispatch('group.folderDelete'); old.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    f.capture.epoch = 'next-session';
    f.rich.deleteGroupFolder = () => new Promise(resolve => { newComplete = resolve; });
    const next = f.dispatch('group.folderDelete'); next.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    oldComplete({ result: 0, groupFileCommonResult: { retCode: 0 } });
    await assert.rejects(old, { code: 'SESSION_CHANGED' });
    await assert.rejects(f.dispatch('group.folderRename'), { code: 'BUSY' });
    newComplete({ result: 0, groupFileCommonResult: { retCode: 0 } });
    assert.equal((await next).confirmed, true);
    f.rich.deleteGroupFolder = () => { f.capture.self.uid = 'u_other'; return { result: 0, groupFileCommonResult: { retCode: 0 } }; };
    await assert.rejects(f.dispatch('group.folderDelete'), { code: 'SESSION_CHANGED' });
});

test('abort before native dispatch performs no work and unknown storage operations stay unsupported', async t => {
    const f = fixture(t), controller = new AbortController(); controller.abort();
    await assert.rejects(f.dispatch('group.folderDelete', {}, { signal: controller.signal }), { code: 'EXPIRED' });
    await assert.rejects(f.api.dispatch('group.fileSpace', {}), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

function protocolFixture() {
    const calls = [], state = { epoch: 'current', self: { uin: '12345', uid: 'u_self' },
        capabilities: { ...Object.fromEntries(Object.values(ACTION_REQUIREMENTS).map(flag => [flag, true])), groupFileInfo: true } };
    let transform = value => value;
    const service = { async assertSession(actual) { assert.equal(actual, state); }, async sessionCall(actual, method, params) {
        assert.equal(actual, state); assert.equal(method, 'groupFiles'); calls.push(structuredClone(params));
        const response = params.operation === 'group.fileCount' ? { counts: { 200: 4 } }
            : params.operation === 'group.fileInfo' ? { groupId: params.groupId, fileInfo: { fileId: params.fileId,
                busId: params.fileId === 'file-B' ? 101 : 102, parentFolderId: params.directory } }
            : { confirmed: true, groupId: params.groupId,
                ...(params.operation === 'group.folderCreate' ? { folderId: 'folder-A', name: params.name } : {}),
                ...(params.folderId ? { folderId: params.folderId, name: params.name } : {}),
                ...(params.files ? { fileIds: params.files.map(file => file.fileId) } : {}),
                ...(params.fileId ? { fileId: params.fileId, name: params.name } : {}),
                ...(params.operation === 'group.fileTrans' ? { saveBusId: 102, saveFilePath: 'server/opaque/location' } : {}) };
        return transform(response);
    } };
    const action = (name, params = {}) => runGroupFiles(service, state, name, { group_id: 200, ...params });
    return { calls, state, service, action, response: fn => { transform = fn; } };
}

test('OneBot group file extensions map to the fixed account-scoped bridge without storage fabrication', async () => {
    const f = protocolFixture();
    assert.equal(ACTIONS.size, 8);
    assert.deepEqual(await f.action('get_group_file_count'), { group_id: 200, file_count: 4 });
    assert.deepEqual(await f.action('create_group_file_folder', { name: 'Test' }), { folder_id: 'folder-A' });
    assert.equal(await f.action('rename_group_file_folder', { folder_id: 'folder-A', new_folder_name: 'Renamed' }), null);
    assert.equal(await f.action('delete_group_folder', { folder_id: 'folder-A' }), null);
    assert.equal(await f.action('delete_group_file', { file_id: 'file-A', busid: '102' }), null);
    assert.equal(await f.action('move_group_file', { files: [{ file_id: 'file-A', busid: 102 }], parent_directory: '/', target_directory: 'folder-A' }), null);
    assert.deepEqual(await f.action('trans_group_file', { file_id: 'file-A' }), { group_id: 200, file_id: 'file-A', save_busid: 102, save_file_path: 'server/opaque/location' });
    assert.deepEqual(await f.action('rename_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', new_name: 'new.txt' }), { ok: true });
    assert.deepEqual(f.calls.map(value => value.operation), ['group.fileCount', 'group.folderCreate', 'group.folderRename', 'group.folderDelete',
        'group.fileDelete', 'group.fileMove', 'group.fileTrans', 'group.fileRename']);
    assert.deepEqual(f.calls[4].files, [{ fileId: 'file-A', busId: 102 }]);
    await assert.rejects(f.action('get_group_file_system_info'), { code: 'UNSUPPORTED' });
});

test('OneBot validates complete batches, strict parameters and capabilities before invoking the bridge', async () => {
    const f = protocolFixture();
    for (const [action, params] of [
        ['delete_group_file', { files: [{ file_id: 'file-A', busid: 102 }, { file_id: 'file-B', busid: -1 }] }],
        ['delete_group_file', { files: [{ file_id: 'file-A', busid: 102 }, { file_id: 'file-A', busid: 102 }] }],
        ['delete_group_file', { files: [{ file_id: 'file-A', busid: 102 }], file_id: 'file-A' }],
        ['move_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', target_directory: '/' }],
        ['rename_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', new_name: '../bad' }],
        ['create_group_file_folder', { name: 'bad\nname' }], ['get_group_file_count', { group_id: 1.5 }],
        ['get_group_file_count', { raw: 'arbitrary' }]
    ]) await assert.rejects(f.action(action, params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.action('create_group_file_folder', { name: 'Test', parent_id: 'child' }), { code: 'UNSUPPORTED' });
    f.state.capabilities.groupFolderCreate = false;
    await assert.rejects(f.action('create_group_file_folder', { name: 'Test' }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('folder rename name alias preserves real target, preferred alias and single confirmed dispatch', async () => {
    const f = protocolFixture();
    for (const [params, expected] of [[{ name: 'Alias name' }, 'Alias name'], [{ new_folder_name: '', name: 'Fallback name' }, 'Fallback name'],
        [{ new_folder_name: 'Preferred name', name: 'Other name' }, 'Preferred name']]) {
        const before = f.calls.length;
        assert.equal(await f.action('rename_group_file_folder', { folder_id: 'folder-A', ...params }), null);
        assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).name, expected);
        assert.equal(f.calls.at(-1).folderId, 'folder-A'); assert.equal(f.calls.at(-1).groupId, '200');
    }
    const before = f.calls.length;
    for (const params of [{ name: '' }, { name: '../bad' }, { name: null }, { new_folder_name: 7, name: 'actual' }, { new_folder_name: 'actual', name: {} }]) {
        await assert.rejects(f.action('rename_group_file_folder', { folder_id: 'folder-A', ...params }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.length, before);
});

test('omitted storage IDs come only from each exact source file before one complete batch mutation', async () => {
    for (const [action, params, directory, operation] of [
        ['delete_group_file', { files: [{ file_id: 'file-A' }, { file_id: 'file-B' }], folder_id: 'source-folder' }, 'source-folder', 'group.fileDelete'],
        ['move_group_file', { files: [{ file_id: 'file-A' }, { file_id: 'file-B', busid: 101 }], parent_directory: 'source-folder', target_directory: 'target-folder' }, 'source-folder', 'group.fileMove']]) {
        const f = protocolFixture(); assert.equal(await f.action(action, params), null);
        const mutations = f.calls.filter(call => call.operation !== 'group.fileInfo'); assert.equal(mutations.length, 1);
        assert.equal(mutations[0].operation, operation); assert.deepEqual(mutations[0].files, [{ fileId: 'file-A', busId: 102 }, { fileId: 'file-B', busId: 101 }]);
        assert.ok(f.calls.slice(0, -1).every(call => call.operation === 'group.fileInfo' && call.groupId === '200' && call.directory === directory));
        assert.equal(f.calls.filter(call => call.operation === 'group.fileInfo').length, action === 'delete_group_file' ? 2 : 1);
    }
});

test('file rename accepts current_parent_directory and returns reference success only after exact confirmation', async () => {
    for (const [params, directory] of [[{}, '/'], [{ current_parent_directory: 'source-folder' }, 'source-folder'],
        [{ current_parent_directory: '', parent_directory: 'legacy-folder' }, 'legacy-folder'],
        [{ current_parent_directory: 'preferred-folder', parent_directory: 'legacy-folder' }, 'preferred-folder']]) {
        const f = protocolFixture();
        assert.deepEqual(await f.action('rename_group_file', { file_id: 'file-A', new_name: 'actual.txt', ...params }), { ok: true });
        assert.deepEqual(f.calls.map(call => call.operation), ['group.fileInfo', 'group.fileRename']);
        assert.equal(f.calls[0].directory, directory); assert.equal(f.calls[1].parentDirectory, directory); assert.equal(f.calls[1].busId, 102);
    }
});

test('wrong group/file/directory, missing or malformed metadata, and changed sessions cannot authorize a mutation', async () => {
    for (const mutate of [value => ({ ...value, groupId: '201' }), value => ({ ...value, fileInfo: { ...value.fileInfo, fileId: 'other' } }),
        value => ({ ...value, fileInfo: { ...value.fileInfo, parentFolderId: 'other-folder' } }), value => ({ ...value, fileInfo: { ...value.fileInfo, busId: undefined } }),
        value => ({ ...value, fileInfo: { ...value.fileInfo, busId: '102' } }), value => ({ ...value, fileInfo: { ...value.fileInfo, busId: -1 } })]) {
        const f = protocolFixture(); f.response(mutate);
        await assert.rejects(f.action('delete_group_file', { file_id: 'file-A' }), { code: 'INVALID_RESPONSE' });
        assert.deepEqual(f.calls.map(call => call.operation), ['group.fileInfo']);
    }
    const f = protocolFixture();
    f.service.assertSession = async () => { throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); };
    await assert.rejects(f.action('delete_group_file', { file_id: 'file-A' }), { code: 'SESSION_CHANGED' });
    assert.deepEqual(f.calls.map(call => call.operation), ['group.fileInfo']);
});

test('an unresolved later batch file stops every write and missing query capability fails before reads', async () => {
    const f = protocolFixture();
    f.response(value => value.fileInfo?.fileId === 'file-B' ? { ...value, fileInfo: { ...value.fileInfo, busId: undefined } } : value);
    await assert.rejects(f.action('delete_group_file', { files: [{ file_id: 'file-A' }, { file_id: 'file-B' }] }), { code: 'INVALID_RESPONSE' });
    assert.deepEqual(f.calls.map(call => call.operation), ['group.fileInfo', 'group.fileInfo']);
    const g = protocolFixture(); g.state.capabilities.groupFileInfo = false;
    await assert.rejects(g.action('delete_group_file', { file_id: 'file-A' }), { code: 'UNSUPPORTED' }); assert.equal(g.calls.length, 0);
    for (const params of [{ file_id: 'file-A', busid: null }, { file_id: 'file-A', folder_id: null }, { file_id: 'file-A', self_id: 54321 }]) {
        await assert.rejects(g.action('delete_group_file', params), { code: 'INVALID_PARAMS' });
    }
    assert.equal(g.calls.length, 0);
});

test('OneBot rejects unconfirmed, mismatched and partial bridge outcomes', async () => {
    const f = protocolFixture();
    for (const response of [undefined, { counts: {} }, { counts: { 201: 4 } }, { counts: { 200: 4, 201: 3 } }, { counts: { 200: '4' } }]) {
        f.response(() => response);
        await assert.rejects(f.action('get_group_file_count'), { code: 'INVALID_RESPONSE' });
    }
    for (const response of [undefined, { confirmed: false, groupId: '200', fileIds: ['file-A'] },
        { confirmed: true, groupId: '201', fileIds: ['file-A'] }, { confirmed: true, groupId: '200', fileIds: [] },
        { confirmed: true, groupId: '200', fileIds: ['other'] }]) {
        f.response(() => response);
        await assert.rejects(f.action('delete_group_file', { file_id: 'file-A', busid: 102 }), { code: 'INVALID_RESPONSE' });
    }
    f.response(value => ({ ...value, folderId: 'other' }));
    await assert.rejects(f.action('delete_group_folder', { folder_id: 'folder-A' }), { code: 'INVALID_RESPONSE' });
    f.response(value => ({ ...value, saveBusId: -1 }));
    await assert.rejects(f.action('trans_group_file', { file_id: 'file-A' }), { code: 'INVALID_RESPONSE' });
    f.response(value => ({ ...value, name: 'other' }));
    await assert.rejects(f.action('rename_group_file', { file_id: 'file-A', busid: 102, parent_directory: '/', new_name: 'new.txt' }), { code: 'INVALID_RESPONSE' });
});
