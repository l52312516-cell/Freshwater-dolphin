'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const { createGroupFiles } = require('../src/qq/group-files.cjs');

function fixture(t) {
    const capture = new Capture({ install: false });
    t.after(() => capture.close());
    capture.qqVersion = '3.2.35-54395'; capture.ready = true; capture.epoch = 'files-session';
    capture.self = { uin: '12345', uid: 'u_test' };
    capture.registrations.push({ name: 'msg', service: {}, remove: 'none' });
    const calls = [], api = createGroupFiles(capture);
    const emit = value => api.listenerMethods.msg.onGroupFileInfoUpdate(value);
    const info = () => ({ fileId: 'doc-alpha', fileName: 'example.txt', busId: 102,
        fileSize: '18446744073709551614', uploadTime: 123, parentFolderId: '/' });
    const page = (reqId = 19) => ({ reqId, retCode: 0, isEnd: true, nextIndex: 1, allFileCount: 1,
        item: [{ peerId: '200', type: 1, fileInfo: info(), folderInfo: null }] });
    const rich = {
        getGroupFileList(...args) { calls.push(args); setImmediate(() => emit(page())); return 19; },
        getGroupFileInfo() { throw new Error('The unresponsive direct detail getter must not be invoked'); }
    };
    capture.session = { getRichMediaService: () => rich };
    const list = (params = {}, context = {}) => api.dispatch('group.filesList', { groupId: '200', ...params }, context);
    const detail = (params = {}, context = {}) => api.dispatch('group.fileInfo', { groupId: '200', fileId: 'doc-alpha', ...params }, context);
    return { capture, api, emit, info, page, rich, calls, list, detail };
}

test('group file pages use a real request callback and preserve exact sizes and native metadata', async t => {
    const f = fixture(t);
    assert.deepEqual(f.api.capabilities(), { groupFiles: true, groupFileInfo: true });
    const result = await f.list({ count: 3, startIndex: 2, directory: 'folder-alpha' });
    assert.deepEqual(f.calls, [['200', { sortType: 1, fileCount: 3, startIndex: 2, sortOrder: 1,
        showOnlinedocFolder: 0, folderId: 'folder-alpha' }]]);
    assert.equal(result.items[0].fileInfo.fileSize, '18446744073709551614');
    assert.equal(result.items[0].fileInfo.parentFolderId, '/');
    assert.deepEqual([result.groupId, result.directory, result.startIndex, result.isEnd, result.allFileCount],
        ['200', 'folder-alpha', 2, true, 1]);
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('synchronous matching callbacks are retained until request zero is returned', async t => {
    const f = fixture(t), raw = f.page(0);
    f.rich.getGroupFileList = () => { f.emit(f.page(88)); f.emit(raw); raw.item[0].fileInfo.fileName = 'later'; return 0; };
    const result = await f.list();
    assert.equal(result.items[0].fileInfo.fileName, 'example.txt');
    result.items[0].fileInfo.fileId = 'changed';
    assert.equal(raw.item[0].fileInfo.fileId, 'doc-alpha');
});

test('empty folders require a matching explicit successful completed page', async t => {
    const f = fixture(t);
    f.rich.getGroupFileList = () => { f.emit({ reqId: 0, retCode: 0, isEnd: true, nextIndex: 0, allFileCount: 0, item: [] }); return 0; };
    assert.deepEqual((await f.list()).items, []);
    f.rich.getGroupFileList = () => 0;
    await assert.rejects(f.list({}, { expiresAt: Date.now() + 20 }), { code: 'TIMEOUT' });
});

test('wrong request IDs and replay before dispatch cannot satisfy a page', async t => {
    const f = fixture(t), add = f.capture.bus.on.bind(f.capture.bus);
    f.capture.bus.on = (name, handler) => { add(name, handler); handler(f.page()); return f.capture.bus; };
    f.rich.getGroupFileList = () => { f.emit(f.page(20)); return 19; };
    await assert.rejects(f.list({}, { expiresAt: Date.now() + 20 }), { code: 'TIMEOUT' });
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('group file page validation rejects cross-group records, invalid cursors and malformed identities', async t => {
    const f = fixture(t);
    for (const change of [x => { x.item[0].peerId = '201'; }, x => { x.retCode = undefined; },
        x => { x.item[0].type = 3; }, x => { x.isEnd = false; x.nextIndex = 0; },
        x => { x.allFileCount = 0; }, x => { x.item.push(x.item[0]); },
        x => { x.item[0].folderInfo = { folderId: 'x' }; }, x => { x.item[0].fileInfo.fileSize = 18446744073709551614; }]) {
        f.rich.getGroupFileList = () => { const raw = f.page(); change(raw); f.emit(raw); return 19; };
        await assert.rejects(f.list(), { code: 'INVALID_RESPONSE' });
    }
    f.rich.getGroupFileList = () => { f.emit({ ...f.page(), retCode: 4 }); return 19; };
    await assert.rejects(f.list(), { code: 'KERNEL_ERROR' });
});

test('folders are preserved without synthetic file metadata', async t => {
    const f = fixture(t);
    f.rich.getGroupFileList = () => {
        f.emit({ ...f.page(), item: [{ peerId: '200', type: 2, fileInfo: null,
            folderInfo: { folderId: 'folder-a', folderName: 'Notes', parentFolderId: '/', createUin: '12345' } }] });
        return 19;
    };
    const result = await f.list();
    assert.equal(result.items[0].folderInfo.folderName, 'Notes');
    assert.equal(result.items[0].fileInfo, null);
});

test('mixed pages count files separately from folder entries and preserve native cursors', async t => {
    const f = fixture(t);
    const folder = { peerId: '200', type: 2, fileInfo: null, folderInfo: { folderId: 'folder-a', folderName: 'Notes' } };
    f.rich.getGroupFileList = () => {
        f.emit({ ...f.page(), allFileCount: 4, nextIndex: 5,
            item: [...Array.from({ length: 4 }, (_, index) => ({ peerId: '200', type: 1, folderInfo: null,
                fileInfo: { ...f.info(), fileId: 'file-' + index } })), folder] });
        return 19;
    };
    const result = await f.list({ count: 5 });
    assert.equal(result.items.length, 5); assert.equal(result.allFileCount, 4);
    assert.equal(result.nextIndex, 5); assert.equal(result.items.filter(item => item.type === 2).length, 1);
    const original = f.rich.getGroupFileList;
    f.rich.getGroupFileList = () => {
        f.emit({ ...f.page(), allFileCount: 0, nextIndex: 1, item: [folder] }); return 19;
    };
    const folders = await f.list();
    assert.equal(folders.allFileCount, 0); assert.equal(folders.items.length, 1);
    assert.equal(folders.items[0].folderInfo.folderId, 'folder-a');
    f.rich.getGroupFileList = original;
    await assert.rejects(f.list({ count: 4 }), { code: 'INVALID_RESPONSE' });
});

test('invalid page diagnostics expose only structural counts and pagination fields', async t => {
    const f = fixture(t);
    f.rich.getGroupFileList = () => {
        const raw = f.page(); raw.allFileCount = 0;
        raw.item[0].fileInfo.fileName = 'private-file-name'; raw.item[0].fileInfo.fileId = 'private-file-id';
        f.emit(raw); return 19;
    };
    await assert.rejects(f.list(), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.match(error.message, /entries=1,files=1,folders=0,total=0,end=true,next=1,start=0,limit=50/);
        assert.doesNotMatch(error.message, /private-file/); return true;
    });
});

test('void and promise returns are never mistaken for file-list correlation IDs', async t => {
    const f = fixture(t);
    for (const result of [undefined, null, '19', {}, -1, 0x100000000, Promise.resolve(19)]) {
        let calls = 0;
        f.rich.getGroupFileList = () => { calls++; return result; };
        await assert.rejects(f.list(), { code: 'INVALID_RESPONSE' });
        assert.equal(calls, 1); assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    }
});

test('cancellation, session replacement and deadline clean up file-page observers', async t => {
    const f = fixture(t), controller = new AbortController();
    f.rich.getGroupFileList = () => { setImmediate(() => controller.abort()); return 19; };
    await assert.rejects(f.list({}, { signal: controller.signal }), { code: 'EXPIRED' });
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    f.rich.getGroupFileList = () => { setImmediate(() => { f.capture.epoch = 'new'; f.emit(f.page()); }); return 19; };
    await assert.rejects(f.list(), { code: 'SESSION_CHANGED' });
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    f.emit(f.page());
});

test('simultaneous group file pages are correlated independently and active ID collisions fail both', async t => {
    const f = fixture(t); let next = 0;
    f.rich.getGroupFileList = () => { const id = ++next; setImmediate(() => f.emit(f.page(id))); return id; };
    const pages = await Promise.all([f.list(), f.list()]);
    assert.equal(pages.length, 2);
    f.rich.getGroupFileList = () => 30;
    const [first, second] = await Promise.allSettled([f.list(), f.list()]);
    assert.equal(first.reason.code, 'INVALID_RESPONSE'); assert.equal(second.reason.code, 'INVALID_RESPONSE');
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('file queries are bounded and invalid parameters stop before native invocation', async t => {
    const f = fixture(t);
    for (const params of [{ groupId: '4294967296' }, { count: 0 }, { count: 101 }, { startIndex: -1 },
        { directory: '' }, { operation: 'group.fileInfo' }, { source: 'arbitrary' }]) {
        await assert.rejects(f.list(params), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.length, 0);
    let next = 0;
    f.rich.getGroupFileList = () => ++next;
    const controller = new AbortController();
    const pending = Array.from({ length: 8 }, () => f.list({}, { signal: controller.signal }));
    await assert.rejects(f.list(), { code: 'BUSY' });
    controller.abort();
    await Promise.allSettled(pending);
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('unavailable group-file contracts are explicit and do not dispatch', async t => {
    const f = fixture(t);
    f.capture.registrations.length = 0;
    assert.equal(f.api.capabilities().groupFiles, false);
    await assert.rejects(f.list(), { code: 'UNSUPPORTED' });
    delete f.rich.getGroupFileInfo;
    assert.equal(f.api.capabilities().groupFileInfo, false);
    await assert.rejects(f.detail(), { code: 'UNSUPPORTED' });
    f.capture.registrations.push({ name: 'msg', service: {}, remove: 'none' });
    assert.equal(f.api.capabilities().groupFileInfo, true);
    delete f.rich.getGroupFileList;
    assert.deepEqual(f.api.capabilities(), { groupFiles: false, groupFileInfo: false });
    await assert.rejects(f.detail(), { code: 'UNSUPPORTED' });
    await assert.rejects(f.api.dispatch('group.fileUrl', {}), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
});

test('group-file details use a fresh correlated listing rather than the unresponsive native getter', async t => {
    const f = fixture(t), detail = await f.detail();
    assert.equal(detail.fileInfo.fileSize, '18446744073709551614');
    assert.equal(detail.fileInfo.fileId, 'doc-alpha');
    assert.deepEqual(f.calls, [['200', { sortType: 1, fileCount: 100, startIndex: 0, sortOrder: 1, showOnlinedocFolder: 0 }]]);
    f.rich.getGroupFileList = () => { f.emit({ ...f.page(), retCode: 4 }); return 19; };
    await assert.rejects(f.detail(), { code: 'KERNEL_ERROR' });
    f.rich.getGroupFileList = () => { const page = f.page(); page.item[0].peerId = '201'; f.emit(page); return 19; };
    await assert.rejects(f.detail(), { code: 'INVALID_RESPONSE' });
    f.rich.getGroupFileList = () => 19;
    await assert.rejects(f.detail({}, { expiresAt: Date.now() + 20 }), { code: 'TIMEOUT' });
});

test('detail lookup follows directory page cursors with one shared deadline and exact file identity', async t => {
    const f = fixture(t), deadlines = [], original = f.capture.deadline;
    f.capture.deadline = function (operation, context, ...rest) {
        deadlines.push(context.expiresAt);
        return original.call(this, operation, context, ...rest);
    };
    let count = 0;
    f.rich.getGroupFileList = (group, params) => {
        f.calls.push([group, params]);
        const id = ++count, page = f.page(id);
        page.isEnd = id === 2; page.nextIndex = id === 1 ? 3 : 4; page.allFileCount = 2;
        page.item[0].fileInfo.fileId = id === 1 ? 'other-file' : 'doc-alpha';
        f.emit(page); return id;
    };
    const detail = await f.detail({ directory: 'folder-a' });
    assert.equal(detail.fileInfo.fileId, 'doc-alpha');
    assert.deepEqual(f.calls.map(([, params]) => [params.startIndex, params.folderId]), [[0, 'folder-a'], [3, 'folder-a']]);
    assert.ok(deadlines.length >= 3 && deadlines.every(value => value === deadlines[0]));
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});

test('file absence is scoped to the selected directory and bounded incomplete search is distinct', async t => {
    const f = fixture(t);
    await assert.rejects(f.detail({ fileId: 'missing-file', directory: 'folder-a' }), error =>
        error.code === 'NOT_FOUND' && error.message.includes('queried group directory'));
    let calls = 0;
    f.rich.getGroupFileList = (_group, params) => {
        const id = ++calls;
        f.emit({ ...f.page(id), isEnd: false, nextIndex: params.startIndex + 1, allFileCount: 30 });
        return id;
    };
    await assert.rejects(f.detail({ fileId: 'missing-file' }), { code: 'QUERY_LIMIT' });
    assert.equal(calls, 20);
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    for (const params of [{ fileId: '' }, { directory: '' }, { directory: 'bad\nfolder' }, { startIndex: 2 }]) {
        await assert.rejects(f.detail(params), { code: 'INVALID_PARAMS' });
    }
});

test('detail lookup stops between pages on cancellation or session replacement', async t => {
    for (const reason of ['abort', 'session']) {
        const f = fixture(t), controller = new AbortController(); let calls = 0;
        f.rich.getGroupFileList = (_group, params) => {
            const id = ++calls;
            setImmediate(() => {
                f.emit({ ...f.page(id), isEnd: false, nextIndex: params.startIndex + 1, allFileCount: 10 });
                if (reason === 'abort') controller.abort(); else f.capture.epoch = 'another-session';
            });
            return id;
        };
        await assert.rejects(f.detail({ fileId: 'missing-file' }, { signal: controller.signal }),
            { code: reason === 'abort' ? 'EXPIRED' : 'SESSION_CHANGED' });
        assert.equal(calls, 1);
        assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
    }
});

test('eight detail lookups can query concurrently without reserving duplicate query slots', async t => {
    const f = fixture(t); let next = 0;
    f.rich.getGroupFileList = () => {
        const id = ++next;
        setImmediate(() => f.emit(f.page(id)));
        return id;
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => f.detail()));
    assert.equal(results.length, 8); assert.equal(next, 8);
    assert.ok(results.every(result => result.fileInfo.fileId === 'doc-alpha'));
    assert.equal(f.capture.bus.listenerCount('groupFilePage'), 0);
});
