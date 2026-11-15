'use strict';

// These extensions use the same account-scoped sessionCall as message actions.
// Counts are counts only; no file count or request ID is presented as capacity.
const ACTION_REQUIREMENTS = Object.freeze({
    get_group_file_count: 'groupFileCount', create_group_file_folder: 'groupFolderCreate',
    rename_group_file_folder: 'groupFolderRename', delete_group_folder: 'groupFolderDelete',
    delete_group_file: 'groupFileDelete', move_group_file: 'groupFileMove',
    trans_group_file: 'groupFileTrans', rename_group_file: 'groupFileRename'
});
const ACTIONS = new Set(Object.keys(ACTION_REQUIREMENTS));
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function group(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Invalid group_id');
    return String(value);
}
function opaque(value, label) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return value;
}
function name(value) {
    if (typeof value !== 'string' || !value || value.trim() !== value || Buffer.byteLength(value) > 255 ||
        ['.', '..'].includes(value) || /[\x00-\x1f\x7f/\\]/.test(value)) throw problem('INVALID_PARAMS', 'Invalid file or folder name');
    return value;
}
function bus(value) {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Invalid busid');
    return Number(value);
}
function fields(value, names) {
    if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).some(key => !['group_id', 'self_id', ...names].includes(key))) {
        throw problem('INVALID_PARAMS', 'Unexpected group file parameters');
    }
}
function files(params) {
    if (params.files !== undefined) {
        if (params.file_id !== undefined || params.busid !== undefined || !Array.isArray(params.files) ||
            !params.files.length || params.files.length > 100) throw problem('INVALID_PARAMS', 'Expected a single file or 1 to 100 batch files');
        const list = params.files.map(item => {
            if (!object(item) || Object.keys(item).some(key => !['file_id', 'busid'].includes(key))) throw problem('INVALID_PARAMS', 'Invalid file batch');
            return { fileId: opaque(item.file_id, 'file_id'), busId: bus(item.busid) };
        });
        if (new Set(list.map(item => item.fileId)).size !== list.length) throw problem('INVALID_PARAMS', 'Duplicate file_id');
        return list;
    }
    return [{ fileId: opaque(params.file_id, 'file_id'), busId: bus(params.busid) }];
}
async function runGroupFiles(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown group file extension');
    if (state.capabilities?.[ACTION_REQUIREMENTS[action]] !== true) throw problem('UNSUPPORTED', 'The current QQ session does not provide this group file capability');
    const allowed = {
        get_group_file_count: [], create_group_file_folder: ['name', 'parent_id'],
        rename_group_file_folder: ['folder_id', 'new_folder_name'], delete_group_folder: ['folder_id'],
        delete_group_file: ['file_id', 'busid', 'files'], move_group_file: ['file_id', 'busid', 'files', 'parent_directory', 'target_directory'],
        trans_group_file: ['file_id'], rename_group_file: ['file_id', 'busid', 'parent_directory', 'new_name']
    };
    fields(params, allowed[action]);
    const groupId = group(params.group_id);
    let input, expected;
    if (action === 'get_group_file_count') input = { operation: 'group.fileCount', groupIds: [groupId] };
    else if (action === 'create_group_file_folder') {
        const parentDirectory = params.parent_id ?? '/';
        if (parentDirectory !== '/') throw problem('UNSUPPORTED', 'Group folders can only be created at the root on this QQ build');
        input = { operation: 'group.folderCreate', groupId, parentDirectory, name: name(params.name) };
    } else if (action === 'rename_group_file_folder') {
        input = { operation: 'group.folderRename', groupId, folderId: opaque(params.folder_id, 'folder_id'), name: name(params.new_folder_name) };
    } else if (action === 'delete_group_folder') input = { operation: 'group.folderDelete', groupId, folderId: opaque(params.folder_id, 'folder_id') };
    else if (['delete_group_file', 'move_group_file'].includes(action)) {
        expected = files(params);
        input = { operation: action === 'delete_group_file' ? 'group.fileDelete' : 'group.fileMove', groupId, files: expected };
        if (action === 'move_group_file') {
            input.sourceDirectory = opaque(params.parent_directory, 'parent_directory');
            input.destinationDirectory = opaque(params.target_directory, 'target_directory');
            if (input.sourceDirectory === input.destinationDirectory) throw problem('INVALID_PARAMS', 'Source and destination directory are identical');
        }
    } else if (action === 'trans_group_file') input = { operation: 'group.fileTrans', groupId, fileId: opaque(params.file_id, 'file_id') };
    else input = { operation: 'group.fileRename', groupId, fileId: opaque(params.file_id, 'file_id'), busId: bus(params.busid),
        parentDirectory: opaque(params.parent_directory, 'parent_directory'), name: name(params.new_name) };
    const result = await service.sessionCall(state, 'groupFiles', input);
    if (action === 'get_group_file_count') {
        if (!object(result?.counts) || Object.keys(result.counts).length !== 1 || !Object.hasOwn(result.counts, groupId) ||
            !Number.isInteger(result.counts[groupId]) || result.counts[groupId] < 0 || result.counts[groupId] > 0xffffffff) {
            throw problem('INVALID_RESPONSE', 'QQ returned an incomplete or unrelated group file count');
        }
        return { group_id: Number(groupId), file_count: result.counts[groupId] };
    }
    if (result?.confirmed !== true || result.groupId !== groupId) throw problem('INVALID_RESPONSE', 'QQ did not confirm the requested group file operation');
    if (action === 'create_group_file_folder') {
        try { opaque(result.folderId, 'folder_id'); } catch { throw problem('INVALID_RESPONSE', 'QQ omitted the created folder identity'); }
        if (result.name !== input.name) throw problem('INVALID_RESPONSE', 'QQ confirmed a different created folder name');
        return { folder_id: result.folderId };
    }
    if (['rename_group_file_folder', 'delete_group_folder'].includes(action)) {
        if (result.folderId !== input.folderId || action === 'rename_group_file_folder' && result.name !== input.name) {
            throw problem('INVALID_RESPONSE', 'QQ confirmed a different group folder');
        }
    } else if (expected) {
        if (!Array.isArray(result.fileIds) || result.fileIds.length !== expected.length || new Set(result.fileIds).size !== expected.length ||
            result.fileIds.some(id => !expected.some(file => file.fileId === id))) throw problem('INVALID_RESPONSE', 'QQ did not confirm every requested file');
    } else {
        if (result.fileId !== input.fileId || action === 'rename_group_file' && result.name !== input.name) {
            throw problem('INVALID_RESPONSE', 'QQ confirmed a different group file');
        }
        if (action === 'trans_group_file') {
            if (!Number.isInteger(result.saveBusId) || result.saveBusId < 0 || result.saveBusId > 0xffffffff) {
                throw problem('INVALID_RESPONSE', 'QQ omitted the transferred file bus ID');
            }
            try { opaque(result.saveFilePath, 'save_file_path'); } catch { throw problem('INVALID_RESPONSE', 'QQ omitted the transferred file location'); }
            return { group_id: Number(groupId), file_id: input.fileId, save_busid: result.saveBusId, save_file_path: result.saveFilePath };
        }
    }
    return null;
}

module.exports = { ACTIONS, ACTION_REQUIREMENTS, runGroupFiles };
