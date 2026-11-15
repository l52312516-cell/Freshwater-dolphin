'use strict';

// The file browser is a request/callback API: its immediate numeric return is
// a correlation identifier, including zero, rather than a business result.
const EVENT = 'groupFilePage';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_LOOKUP_PAGES = 20;
const LOOKUP_PAGE_SIZE = 100;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function u32(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
function exactUnsigned(value) {
    return (typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value)) &&
        /^(0|[1-9]\d*)$/.test(String(value)) && BigInt(value) <= 0xffffffffffffffffn;
}
function identifier(value) {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
}
function group(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 0xffffffffn) {
        throw problem('INVALID_PARAMS', 'Invalid group file account');
    }
    return value;
}
function copy(value) {
    let encoded;
    try {
        encoded = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'bigint') return String(item);
            if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) {
                throw new Error('Inexact native number');
            }
            return item;
        });
    } catch { throw problem('INVALID_RESPONSE', 'QQ returned non-serializable group file data'); }
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_PAGE_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ group file data exceeds its limit');
    }
    return { value: JSON.parse(encoded), bytes: Buffer.byteLength(encoded) };
}
function fileInfo(value, expectedId) {
    if (!object(value) || !identifier(value.fileId) || expectedId !== undefined && value.fileId !== expectedId ||
        !u32(value.busId) || !exactUnsigned(value.fileSize)) {
        throw problem('INVALID_RESPONSE', 'QQ returned incomplete or mismatched group file metadata');
    }
    return { ...value, fileSize: String(value.fileSize) };
}
function pageFailure(value, request) {
    const items = Array.isArray(value?.item) ? value.item : [];
    const number = item => Number.isSafeInteger(item) ? String(item) : 'invalid';
    // Only counters/flags enter the diagnostic; names, IDs and native records
    // remain private. This also distinguishes a total mismatch from a cursor
    // or completion-field mismatch on a previously unseen native response.
    return problem('INVALID_RESPONSE', 'QQ returned an invalid group file page (entries=' +
        (Array.isArray(value?.item) ? items.length : 'missing') + ',files=' + items.filter(item => item?.type === 1).length +
        ',folders=' + items.filter(item => item?.type === 2).length + ',total=' + number(value?.allFileCount) +
        ',end=' + (typeof value?.isEnd === 'boolean' ? value.isEnd : 'invalid') + ',next=' + number(value?.nextIndex) +
        ',start=' + request.startIndex + ',limit=' + request.count + ')');
}
function page(value, request) {
    if (!object(value) || !Number.isInteger(value.retCode)) throw problem('INVALID_RESPONSE', 'QQ omitted the group file result');
    if (value.retCode !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the group file query');
    if (!Array.isArray(value.item) || value.item.length > request.count || !u32(value.nextIndex) ||
        !u32(value.allFileCount) || typeof value.isEnd !== 'boolean' ||
        !value.isEnd && value.nextIndex <= request.startIndex) {
        throw pageFailure(value, request);
    }
    const identities = new Set();
    const items = value.item.map(entry => {
        if (!object(entry) || entry.peerId !== request.groupId || ![1, 2].includes(entry.type)) {
            throw problem('INVALID_RESPONSE', 'QQ returned an unrelated group file item');
        }
        let identity, result;
        if (entry.type === 1) {
            if (entry.folderInfo != null) throw problem('INVALID_RESPONSE', 'QQ returned conflicting group file metadata');
            const info = fileInfo(entry.fileInfo);
            identity = 'file:' + info.fileId;
            result = { ...entry, fileInfo: info };
        } else {
            if (entry.fileInfo != null || !object(entry.folderInfo) || !identifier(entry.folderInfo.folderId)) {
                throw problem('INVALID_RESPONSE', 'QQ returned incomplete group folder metadata');
            }
            identity = 'folder:' + entry.folderInfo.folderId;
            result = entry;
        }
        if (identities.has(identity)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate group file identities');
        identities.add(identity);
        return result;
    });
    // allFileCount counts files. Native directory pages can also contain
    // folders, including a folder-only page while allFileCount is zero.
    // Cursors continue to describe mixed entries and are not file counters.
    if (items.filter(entry => entry.type === 1).length > value.allFileCount) {
        throw pageFailure(value, request);
    }
    return { groupId: request.groupId, directory: request.directory, startIndex: request.startIndex,
        items, isEnd: value.isEnd, nextIndex: value.nextIndex, allFileCount: value.allFileCount };
}

function createGroupFiles(capture) {
    let running = 0;
    const requests = new Map();
    const queryAvailable = () => capture.registrations?.some(entry => entry.name === 'msg') === true &&
        capture.hasMethods('richMedia', ['getGroupFileList']);
    const management = createGroupFileManagement(capture, {
        available: queryAvailable,
        list: (params, context) => dispatch('group.filesList', params, context)
    });
    const listenerMethods = { msg: { onGroupFileInfoUpdate(value) { capture.bus.emit(EVENT, value); } } };
    function capabilities() {
        const available = queryAvailable();
        return { groupFiles: available, groupFileInfo: available, ...management.capabilities() };
    }
    async function dispatch(method, params = {}, context = {}) {
        if (Object.hasOwn(MANAGEMENT, method)) return management.dispatch(method, params, context);
        if (!['group.filesList', 'group.fileInfo'].includes(method)) throw problem('UNSUPPORTED', 'Unsupported group file operation');
        const allowed = method === 'group.filesList' ? ['operation', 'groupId', 'directory', 'startIndex', 'count', 'expectedEpoch'] : ['operation', 'groupId', 'fileId', 'directory', 'expectedEpoch'];
        if (!object(params) || Object.keys(params).some(key => !allowed.includes(key)) ||
            params.operation !== undefined && params.operation !== method) throw problem('INVALID_PARAMS', 'Invalid group file parameters');
        const groupId = group(params.groupId);
        const request = method === 'group.filesList'
            ? { groupId, directory: params.directory ?? '/', startIndex: params.startIndex ?? 0, count: params.count ?? 50 }
            : { groupId, fileId: params.fileId, directory: params.directory ?? '/' };
        if (method === 'group.filesList' ? !identifier(request.directory) || !u32(request.startIndex) ||
            !Number.isInteger(request.count) || request.count < 1 || request.count > 100 : !identifier(request.fileId) || !identifier(request.directory)) {
            throw problem('INVALID_PARAMS', 'Invalid group file page or identity');
        }
        capture.ensureReady();
        if (params.expectedEpoch !== undefined && params.expectedEpoch !== capture.epoch) {
            throw problem('SESSION_CHANGED', 'Group file query belongs to another QQ session');
        }
        const epoch = capture.epoch, self = { ...capture.self };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== epoch || capture.self?.uin !== self.uin || capture.self?.uid !== self.uid) {
                throw problem('SESSION_CHANGED', 'QQ changed during the group file query');
            }
            if (context.signal?.aborted || context.expiresAt !== undefined && Date.now() >= context.expiresAt) {
                throw problem('EXPIRED', 'Group file query expired');
            }
        };
        active();
        if (!capabilities()[method === 'group.filesList' ? 'groupFiles' : 'groupFileInfo']) {
            throw problem('UNSUPPORTED', 'QQ group file query contract is unavailable');
        }
        if (method === 'group.fileInfo') {
            // The direct getter does not complete on the target QQ build. Read
            // fresh, correlated directory pages instead, within one deadline.
            const scope = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + 10000) };
            return capture.deadline(async () => {
                let startIndex = 0, inspected = 0;
                for (let pageIndex = 0; pageIndex < MAX_LOOKUP_PAGES; pageIndex++) {
                    active();
                    const result = await dispatch('group.filesList', { groupId, directory: request.directory,
                        startIndex, count: LOOKUP_PAGE_SIZE }, scope);
                    active(); inspected += result.items.length;
                    const matched = result.items.find(entry => entry.type === 1 && entry.fileInfo.fileId === request.fileId);
                    if (matched) return { groupId, fileInfo: matched.fileInfo };
                    if (result.isEnd) throw problem('NOT_FOUND', 'File was not found in the queried group directory');
                    if (inspected >= MAX_LOOKUP_PAGES * LOOKUP_PAGE_SIZE) break;
                    startIndex = result.nextIndex;
                }
                throw problem('QUERY_LIMIT', 'File was not located within the bounded group directory search');
            }, scope);
        }
        if (running >= 8) throw problem('BUSY', 'Too many group file queries');
        running++;
        let handler, requestId, resolve, reject, dispatched = false;
        const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
        pending.catch(() => {});
        const early = [];
        let earlyBytes = 0;
        const accept = value => {
            if (value?.reqId !== requestId) return;
            try { active(); resolve(page(value, request)); } catch (error) { reject(error); }
        };
        try {
            handler = value => {
                if (!dispatched || !object(value) || !u32(value.reqId)) return;
                if (requestId !== undefined) {
                    if (value.reqId !== requestId) return;
                    try { accept(copy(value).value); } catch (error) { reject(error); }
                } else if (early.length < 16) {
                    try {
                        const snapshot = copy(value);
                        if (earlyBytes + snapshot.bytes > MAX_PAGE_BYTES) return;
                        earlyBytes += snapshot.bytes; early.push({ id: value.reqId, value: snapshot.value });
                    } catch (error) { early.push({ id: value.reqId, error }); }
                }
            };
            capture.bus.on(EVENT, handler);
            return await capture.deadline(async () => {
                active(); dispatched = true;
                const result = capture.invoke('richMedia', 'getGroupFileList', [groupId, {
                    sortType: 1, fileCount: request.count, startIndex: request.startIndex,
                    sortOrder: 1, showOnlinedocFolder: 0,
                    ...(request.directory === '/' ? {} : { folderId: request.directory })
                }]);
                if (!u32(result)) {
                    if (typeof result?.catch === 'function') result.catch(() => {});
                    throw problem('INVALID_RESPONSE', 'QQ returned no exact group file request identifier');
                }
                requestId = result;
                if (requests.has(requestId)) {
                    const error = problem('INVALID_RESPONSE', 'QQ reused an active group file request identifier');
                    requests.get(requestId).reject(error); throw error;
                }
                requests.set(requestId, { handler, reject });
                for (const entry of early) if (entry.id === requestId) {
                    if (entry.error) reject(entry.error); else accept(entry.value);
                }
                early.length = 0;
                const response = await pending; active(); return response;
            }, context);
        } finally {
            running--;
            if (handler) capture.bus.removeListener(EVENT, handler);
            if (requests.get(requestId)?.handler === handler) requests.delete(requestId);
        }
    }
    return { dispatch, capabilities, listenerMethods };
}

const MANAGEMENT = Object.freeze({
    'group.fileCount': ['groupFileCount', 'batchGetGroupFileCount', ['groupIds']],
    'group.folderCreate': ['groupFolderCreate', 'createGroupFolder', ['groupId', 'name', 'parentDirectory']],
    'group.folderRename': ['groupFolderRename', 'renameGroupFolder', ['groupId', 'folderId', 'name']],
    'group.folderDelete': ['groupFolderDelete', 'deleteGroupFolder', ['groupId', 'folderId']],
    'group.fileDelete': ['groupFileDelete', 'deleteGroupFile', ['groupId', 'files']],
    'group.fileMove': ['groupFileMove', 'moveGroupFile', ['groupId', 'files', 'sourceDirectory', 'destinationDirectory']],
    'group.fileTrans': ['groupFileTrans', 'transGroupFile', ['groupId', 'fileId']],
    'group.fileRename': ['groupFileRename', 'renameGroupFile', ['groupId', 'fileId', 'busId', 'parentDirectory', 'name']]
});
function fields(value, names) {
    if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).some(key => !['operation', 'expectedEpoch', ...names].includes(key))) {
        throw problem('INVALID_PARAMS', 'Invalid group file management parameters');
    }
}
function opaque(value, label) {
    if (!identifier(value)) throw problem('INVALID_PARAMS', 'Invalid ' + label);
    return value;
}
function name(value) {
    if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value) > 255 ||
        ['.', '..'].includes(value) || /[\x00-\x1f\x7f/\\]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Invalid file or folder name');
    }
    return value;
}
function checkedCodes(value) {
    if (!object(value)) return;
    for (const key of ['result', 'retCode', 'errCode', 'retcode', 'errcode']) {
        if (!Object.hasOwn(value, key) || key === 'result' && object(value[key])) continue;
        if (!Number.isSafeInteger(value[key])) throw problem('INVALID_RESPONSE', 'QQ returned an invalid group file business result');
        if (value[key] !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the group file operation (' + key + '=' + value[key] + '); it was not retried');
    }
}
function code(value, key) {
    if (!object(value) || !Number.isSafeInteger(value[key])) throw problem('INVALID_RESPONSE', 'QQ omitted an explicit group file business result');
    checkedCodes(value);
    return value;
}
function resultWith(value, container, direct = false) {
    code(value, 'result');
    const wrapper = value[container];
    checkedCodes(wrapper);
    code(direct ? wrapper : wrapper?.result, 'retCode');
    return wrapper;
}
function completeFiles(value, requested) {
    if (!Array.isArray(value.successFileIdList) || !Array.isArray(value.failFileIdList) || value.failFileIdList.length ||
        value.successFileIdList.length !== requested.length || new Set(value.successFileIdList).size !== requested.length ||
        value.successFileIdList.some(id => !requested.includes(id))) {
        throw problem('PARTIAL_RESULT', 'QQ did not confirm every requested file; it was not retried');
    }
}
function returnedFolder(wrapper, groupId) {
    const candidates = [];
    // Native result unions keep inactive members as null. A null direct
    // member must not hide the real folder carried by a GroupItem.
    if (wrapper.folderInfo != null) candidates.push(wrapper.folderInfo);
    if (wrapper.groupItem !== undefined) {
        const groupItem = wrapper.groupItem;
        // Native result records can retain an unused default groupItem beside
        // the authoritative folderInfo. Empty defaults carry no conflicting
        // identity; they must never supply or replace a missing folder ID.
        const empty = groupItem === null || Array.isArray(groupItem) && groupItem.length === 0 ||
            object(groupItem) && [Object.prototype, null].includes(Object.getPrototypeOf(groupItem)) && Reflect.ownKeys(groupItem).length === 0;
        if (!empty) {
            const legacy = Array.isArray(groupItem);
            if (legacy ? groupItem.length !== 1 || !object(groupItem[0]) : !object(groupItem)) {
                const kind = groupItem === null ? 'null' : Array.isArray(groupItem) ? 'array' : typeof groupItem;
                const keys = object(groupItem) ? Object.keys(groupItem).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 24) : [];
                throw problem('INVALID_RESPONSE', 'QQ returned an ambiguous folder result; kind=' + kind +
                    '; length=' + (Array.isArray(groupItem) ? groupItem.length : -1) + '; keys=' + keys.join(','));
            }
            const item = legacy ? groupItem[0] : groupItem;
            // The current native result is a single discriminated GroupItem,
            // not an array or a flat FolderInfo. Bind its peer and union type
            // before trusting nested metadata, including inside old arrays.
            const native = !legacy || ['peerId', 'type', 'fileInfo'].some(key => Object.hasOwn(item, key));
            if (native && (item.peerId !== groupId || item.type !== 2 || item.fileInfo != null || !object(item.folderInfo))) {
                throw problem('INVALID_RESPONSE', 'QQ returned an unrelated or conflicting group folder item');
            }
            if (item.folderInfo !== undefined) candidates.push(item.folderInfo);
            if (item.folderInfo === undefined || item.folderId !== undefined || item.folderName !== undefined) candidates.push(item);
        }
    }
    if (!candidates.length || candidates.some(info => !object(info) || !identifier(info.folderId) || !identifier(info.folderName) ||
        info.folderId !== candidates[0].folderId || info.folderName !== candidates[0].folderName)) {
        throw problem('INVALID_RESPONSE', 'QQ returned incomplete or conflicting folder identities');
    }
    return candidates[0];
}
function renameEcho(wrapper, groupId, folderId) {
    const plain = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
    const kind = value => value === undefined ? 'missing' : value === null ? 'null' :
        Array.isArray(value) ? (value.length === 0 ? 'empty-array' : 'nonempty-array') :
        plain(value) ? (Reflect.ownKeys(value).length === 0 ? 'empty-object' : 'object') :
        typeof value === 'string' ? (value.length === 0 ? 'empty-string' : 'string') : typeof value;
    const malformed = () => {
        const item = Array.isArray(wrapper.groupItem) ? wrapper.groupItem[0] : wrapper.groupItem;
        return problem('INVALID_RESPONSE', 'QQ returned an unrecognized folder rename echo (direct=' + kind(wrapper.folderInfo) +
            ',item=' + kind(wrapper.groupItem) + ',peer=' + kind(item?.peerId) + ',tag=' + kind(item?.type) +
            ',folder=' + kind(item?.folderInfo) + ',file=' + kind(item?.fileInfo) + ')');
    };
    const conflict = () => problem('INVALID_RESPONSE', 'QQ returned conflicting group folder rename identities');
    const checkFields = info => {
        if (!plain(info)) throw malformed();
        for (const key of ['peerId', 'groupId', 'groupCode']) {
            const value = info[key];
            if (value == null || value === '' || value === '0') continue;
            if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 0xffffffffn) throw malformed();
            if (value !== groupId) throw conflict();
        }
        for (const key of ['folderId', 'fileId']) {
            const value = info[key];
            if (value == null || value === '') continue;
            if (!identifier(value)) throw malformed();
            if (key === 'fileId' || value !== folderId) throw conflict();
        }
        if (info.folderName != null && info.folderName !== '' && !identifier(info.folderName)) throw malformed();
        if (info.type != null && !u32(info.type)) throw malformed();
    };
    const checkRecord = info => {
        checkFields(info);
        for (const key of ['folderInfo', 'fileInfo']) if (info[key] != null) checkFields(info[key]);
    };
    // A zero-code rename receipt can contain incomplete/default SDK metadata.
    // It supplies only negative identity evidence, never success. Every accepted
    // shape still requires complete, independently correlated root readback.
    checkRecord(wrapper);
    if (wrapper.groupItem == null) return;
    if (Array.isArray(wrapper.groupItem)) {
        if (wrapper.groupItem.length === 0) return;
        if (wrapper.groupItem.length !== 1) throw malformed();
        checkRecord(wrapper.groupItem[0]);
    } else checkRecord(wrapper.groupItem);
}
function createGroupFileManagement(capture, queries) {
    let owner;
    const mutations = new Map();
    const snapshot = () => ({ epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid });
    const same = (a, b) => a && b && a.epoch === b.epoch && a.session === b.session && a.uin === b.uin && a.uid === b.uid;
    function synchronize() {
        const state = snapshot();
        if (!same(state, owner)) { mutations.clear(); owner = state; }
    }
    function capabilities() {
        // Omitted flags are unavailable. Preserve the pre-existing query-only
        // capability shape when these methods are absent on a QQ build.
        return Object.fromEntries(Object.values(MANAGEMENT).filter(([, method]) =>
            capture.hasMethods('richMedia', [method]) &&
            (method !== 'renameGroupFolder' || queries.available())).map(([flag]) => [flag, true]));
    }
    function active(state, context) {
        capture.ensureReady();
        if (!same(state, snapshot())) throw problem('SESSION_CHANGED', 'QQ account changed during group file management');
        if (context.signal?.aborted || Date.now() >= context.expiresAt) {
            throw problem('EXPIRED', 'Group file operation expired; its result may be unknown; do not retry automatically');
        }
    }
    function confirmationDelay(state, context) {
        active(state, context);
        return new Promise((resolve, reject) => {
            let timer, done = false;
            const finish = error => {
                if (done) return;
                done = true; clearTimeout(timer);
                context.signal?.removeEventListener('abort', cancelled);
                if (error) reject(error); else resolve();
            };
            const cancelled = () => finish(problem('EXPIRED', 'Group folder confirmation was cancelled; its result may be unknown'));
            timer = setTimeout(() => {
                try { active(state, context); finish(); } catch (error) { finish(error); }
            }, Math.max(1, Math.min(250, context.expiresAt - Date.now())));
            context.signal?.addEventListener('abort', cancelled, { once: true });
            if (context.signal?.aborted) cancelled();
        });
    }
    async function confirmFolderRename(groupId, folderId, requestedName, state, context) {
        // A rename acknowledgement can retain a default SDK GroupItem. Its
        // payload is not a fresh directory snapshot. Confirm the requested
        // stable ID from complete, correlated root pages without a second write.
        for (;;) {
            let startIndex = 0, found, complete = false;
            const seen = new Set();
            for (let index = 0; index < MAX_LOOKUP_PAGES; index++) {
                active(state, context);
                const result = await queries.list({ groupId, directory: '/', startIndex, count: LOOKUP_PAGE_SIZE,
                    expectedEpoch: state.epoch }, context);
                active(state, context);
                for (const item of result.items) {
                    const identity = item.type === 1 ? 'file:' + item.fileInfo.fileId : 'folder:' + item.folderInfo.folderId;
                    if (seen.has(identity)) throw problem('INVALID_RESPONSE', 'QQ repeated a group file identity across directory pages');
                    seen.add(identity);
                    if (item.type === 2 && item.folderInfo.folderId === folderId) {
                        if (!identifier(item.folderInfo.folderName)) {
                            throw problem('INVALID_RESPONSE', 'QQ omitted the queried group folder name');
                        }
                        found = item.folderInfo;
                    }
                }
                if (result.isEnd) { complete = true; break; }
                startIndex = result.nextIndex;
            }
            if (!complete) throw problem('QUERY_LIMIT', 'Group folder confirmation exceeded the bounded root directory search');
            if (found?.folderName === requestedName) return { confirmed: true, groupId, folderId, name: found.folderName };
            await confirmationDelay(state, context);
        }
    }
    async function dispatch(operation, params, context) {
        const [flag, nativeMethod, allowed] = MANAGEMENT[operation];
        fields(params, allowed);
        if (params.operation !== undefined && params.operation !== operation) throw problem('INVALID_PARAMS', 'Conflicting group file operation');
        const read = operation === 'group.fileCount';
        let groups, groupId, folderId, fileId, fileName, parent, from, to, files;
        if (read) {
            if (!Array.isArray(params.groupIds) || !params.groupIds.length || params.groupIds.length > 100) {
                throw problem('INVALID_PARAMS', 'Expected 1 to 100 group identifiers');
            }
            groups = params.groupIds.map(group);
            if (new Set(groups).size !== groups.length) throw problem('INVALID_PARAMS', 'Duplicate group identifiers');
        } else {
            groupId = group(params.groupId);
            if (['group.folderRename', 'group.folderDelete'].includes(operation)) folderId = opaque(params.folderId, 'folder ID');
            if (['group.folderCreate', 'group.folderRename', 'group.fileRename'].includes(operation)) fileName = name(params.name);
            if (operation === 'group.folderCreate') {
                parent = params.parentDirectory ?? '/';
                if (parent !== '/') throw problem('UNSUPPORTED', 'This QQ build can only create group folders at the root');
            }
            if (['group.fileTrans', 'group.fileRename'].includes(operation)) fileId = opaque(params.fileId, 'file ID');
            if (operation === 'group.fileRename') {
                if (!u32(params.busId)) throw problem('INVALID_PARAMS', 'Invalid file bus ID');
                parent = opaque(params.parentDirectory, 'parent directory');
            }
            if (['group.fileDelete', 'group.fileMove'].includes(operation)) {
                if (!Array.isArray(params.files) || !params.files.length || params.files.length > 100) {
                    throw problem('INVALID_PARAMS', 'Expected 1 to 100 files');
                }
                files = params.files.map(file => {
                    if (!object(file) || Object.keys(file).some(key => !['fileId', 'busId'].includes(key)) || !u32(file.busId)) {
                        throw problem('INVALID_PARAMS', 'Invalid group file batch');
                    }
                    return { fileId: opaque(file.fileId, 'file ID'), busId: file.busId };
                });
                if (new Set(files.map(file => file.fileId)).size !== files.length) throw problem('INVALID_PARAMS', 'Duplicate file IDs');
                if (operation === 'group.fileMove') {
                    from = opaque(params.sourceDirectory, 'source directory'); to = opaque(params.destinationDirectory, 'destination directory');
                    if (from === to) throw problem('INVALID_PARAMS', 'Source and destination directory are identical');
                }
            }
        }
        capture.ensureReady(); synchronize();
        const state = snapshot();
        if (typeof state.epoch !== 'string' || !state.epoch || typeof state.uin !== 'string' ||
            !/^[1-9]\d{0,9}$/.test(state.uin) || BigInt(state.uin) > 0xffffffffn ||
            typeof state.uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(state.uid)) {
            throw problem('NOT_READY', 'The acting QQ identity is not initialized');
        }
        if ((!read || params.expectedEpoch !== undefined) && params.expectedEpoch !== state.epoch) {
            throw problem('SESSION_CHANGED', 'Group file management belongs to another QQ session');
        }
        if (capabilities()[flag] !== true) throw problem('UNSUPPORTED', 'The QQ group file operation is unavailable');
        const controller = new AbortController();
        const scope = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + 10000),
            signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
        active(state, scope);
        if (!read && mutations.has(groupId)) throw problem('BUSY', 'A group file mutation is still awaiting its native result');
        if (!read && mutations.size >= 32) throw problem('BUSY', 'Too many pending group file mutations');
        const token = {};
        if (!read) mutations.set(groupId, token);
        const task = Promise.resolve().then(async () => {
            active(state, scope);
            let args;
            if (read) args = [groups];
            else if (operation === 'group.folderCreate') args = [groupId, fileName];
            else if (operation === 'group.folderRename') args = [groupId, folderId, fileName];
            else if (operation === 'group.folderDelete') args = [groupId, folderId];
            else if (operation === 'group.fileTrans') args = [groupId, fileId];
            else if (operation === 'group.fileRename') args = [groupId, params.busId, fileId, parent, fileName];
            else args = [groupId, files.map(file => file.busId), files.map(file => file.fileId),
                ...(operation === 'group.fileMove' ? [from, to] : [])];
            const value = await capture.invoke('richMedia', nativeMethod, args);
            active(state, scope);
            code(value, 'result');
            if (read) {
                if (!Array.isArray(value.groupCodes) || !Array.isArray(value.groupFileCounts) ||
                    value.groupCodes.length !== groups.length || value.groupFileCounts.length !== groups.length ||
                    new Set(value.groupCodes).size !== groups.length ||
                    value.groupCodes.some(id => typeof id !== 'string' || !groups.includes(id)) || !value.groupFileCounts.every(u32)) {
                    throw problem('INVALID_RESPONSE', 'QQ returned incomplete or mismatched group file counts');
                }
                return { counts: Object.fromEntries(value.groupCodes.map((id, i) => [id, value.groupFileCounts[i]])) };
            }
            if (value.groupId !== undefined && value.groupId !== groupId || value.groupCode !== undefined && value.groupCode !== groupId) {
                throw problem('INVALID_RESPONSE', 'QQ returned a different group identity');
            }
            const confirmed = { confirmed: true, groupId };
            if (operation === 'group.folderDelete') { resultWith(value, 'groupFileCommonResult', true); return { ...confirmed, folderId }; }
            if (operation === 'group.folderRename') {
                const wrapper = resultWith(value, 'resultWithGroupItem');
                renameEcho(wrapper, groupId, folderId);
                return confirmFolderRename(groupId, folderId, fileName, state, scope);
            }
            if (operation === 'group.folderCreate') {
                const info = returnedFolder(resultWith(value, 'resultWithGroupItem'), groupId);
                if (!object(info) || !identifier(info.folderId) || info.folderName !== fileName) {
                    throw problem('INVALID_RESPONSE', 'QQ did not confirm the exact folder identity and name');
                }
                return { ...confirmed, folderId: info.folderId, name: info.folderName };
            }
            if (operation === 'group.fileTrans') {
                const transferred = resultWith(value, 'transGroupFileResult');
                if (!u32(transferred.saveBusId) || !identifier(transferred.saveFilePath)) throw problem('INVALID_RESPONSE', 'QQ omitted the transferred file location');
                return { ...confirmed, fileId, saveBusId: transferred.saveBusId, saveFilePath: transferred.saveFilePath };
            }
            if (operation === 'group.fileRename') {
                const renamed = resultWith(value, 'renameGroupFileResult');
                if (renamed.fileInfo !== undefined && (!object(renamed.fileInfo) || renamed.fileInfo.fileId !== fileId ||
                    renamed.fileInfo.fileName !== undefined && renamed.fileInfo.fileName !== fileName)) {
                    throw problem('INVALID_RESPONSE', 'QQ returned a different renamed file');
                }
                return { ...confirmed, fileId, name: fileName };
            }
            const wrapper = resultWith(value, operation === 'group.fileMove' ? 'moveGroupFileResult' : 'transGroupFileResult');
            const ids = files.map(file => file.fileId);
            completeFiles(wrapper, ids);
            return { ...confirmed, fileIds: ids };
        });
        task.finally(() => { if (!read && mutations.get(groupId) === token) mutations.delete(groupId); }).catch(() => {});
        try {
            return await capture.deadline(() => task, scope);
        } finally {
            // The outer timer can settle before a nested directory-page timer.
            // Retire its callback observer before returning to the caller. The
            // native-result task still owns the mutation lock until it settles.
            controller.abort();
            await Promise.resolve();
        }
    }
    return { capabilities, dispatch };
}

module.exports = { createGroupFiles };
