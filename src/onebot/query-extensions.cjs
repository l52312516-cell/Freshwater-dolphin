'use strict';

const ACTIONS = new Set(['send_like', 'get_group_at_all_remain', 'get_group_root_files',
    'get_group_files_by_folder', 'get_group_file_info']);
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function identifier(value, label) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value))) throw problem('INVALID_PARAMS', 'Invalid ' + label);
    return String(value);
}
function integer(value, fallback, maximum, label, minimum = 0) {
    if (value === undefined) return fallback;
    if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return Number(value);
}
function opaque(value, label) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return value;
}
function metadata(source, specification) {
    const output = {};
    for (const [from, to, kind] of specification) {
        const value = source[from];
        if (value === undefined || value === null) continue;
        if (kind === 'text') {
            if (typeof value !== 'string' || Buffer.byteLength(value) > 16384 || value.includes('\0')) {
                throw problem('INVALID_RESPONSE', 'QQ returned invalid group file text metadata');
            }
            output[to] = value;
        } else if (kind === 'identity') {
            // A zero native owner is unknown, rather than a real QQ account.
            if (value === 0 || value === '0' || value === '') continue;
            if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) ||
                !Number.isSafeInteger(Number(value))) throw problem('INVALID_RESPONSE', 'QQ returned invalid group file owner');
            output[to] = String(value);
        } else if (kind === 'hash') {
            // QQ's file browser can expose opaque native digest strings with
            // no verified byte encoding. They are optional metadata: guessing
            // Latin-1/UTF-8 would invent a checksum, while rejecting the whole
            // page would discard otherwise verified file identities and sizes.
            const lengths = from === 'md5' ? [32] : from === 'sha' ? [40] : [56, 64, 96, 128];
            if (typeof value !== 'string' || !lengths.includes(value.length) || !/^[a-fA-F0-9]+$/.test(value)) continue;
            output[to] = value;
        } else {
            if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) ||
                typeof value === 'number' && !Number.isSafeInteger(value) || BigInt(value) > 0xffffffffffffffffn ||
                kind !== 'uint64' && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw problem('INVALID_RESPONSE', 'QQ returned invalid group file numeric metadata');
            }
            output[to] = BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : String(value);
        }
    }
    return output;
}
function fileInfo(info, groupId) {
    if (!info || typeof info.fileId !== 'string' || !info.fileId || Buffer.byteLength(info.fileId) > 1024 || /[\x00-\x1f\x7f]/.test(info.fileId) ||
        !Number.isSafeInteger(info.busId) || info.busId < 0 || info.busId > 0xffffffff ||
        !['string', 'number'].includes(typeof info.fileSize) || !/^(0|[1-9]\d*)$/.test(String(info.fileSize)) ||
        typeof info.fileSize === 'number' && !Number.isSafeInteger(info.fileSize)) {
        throw problem('INVALID_RESPONSE', 'QQ returned invalid group file metadata');
    }
    const size = String(info.fileSize);
    if (BigInt(size) > 0xffffffffffffffffn) throw problem('INVALID_RESPONSE', 'QQ returned an out-of-range group file size');
    const exactSize = BigInt(size) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size;
    return { group_id: Number(groupId), file_id: info.fileId, busid: info.busId, file_size: exactSize, size: exactSize,
        ...metadata(info, [['fileName', 'file_name', 'text'], ['uploadTime', 'upload_time', 'integer'], ['deadTime', 'dead_time', 'integer'],
            ['modifyTime', 'modify_time', 'integer'], ['downloadTimes', 'download_times', 'integer'], ['parentFolderId', 'parent_folder_id', 'text'],
            ['uploaderUin', 'uploader', 'identity'], ['uploaderName', 'uploader_name', 'text'], ['uploadedSize', 'uploaded_size', 'uint64'],
            ['md5', 'md5', 'hash'], ['sha', 'sha', 'hash'], ['sha3', 'sha3', 'hash']]) };
}
function folderInfo(info, groupId) {
    if (!info || typeof info.folderId !== 'string' || !info.folderId || Buffer.byteLength(info.folderId) > 1024 || /[\x00-\x1f\x7f]/.test(info.folderId)) {
        throw problem('INVALID_RESPONSE', 'QQ returned invalid group folder metadata');
    }
    return { group_id: Number(groupId), folder_id: info.folderId,
        ...metadata({ ...info, creatorName: info.creatorName ?? info.createName }, [['folderName', 'folder_name', 'text'],
            ['createTime', 'create_time', 'integer'], ['createUin', 'creator', 'identity'], ['creatorName', 'creator_name', 'text'],
            ['totalFileCount', 'total_file_count', 'integer'], ['parentFolderId', 'parent_folder_id', 'text'],
            ['modifyTime', 'modify_time', 'integer'], ['modifyUin', 'modifier', 'identity'], ['modifyName', 'modifier_name', 'text'],
            ['usedSpace', 'used_space', 'uint64']]) };
}
async function runQueryExtension(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown query extension');
    const flag = action === 'send_like' ? 'profileLike' : action === 'get_group_at_all_remain' ? 'groupAtAllRemain' :
        action === 'get_group_file_info' ? 'groupFileInfo' : 'groupFiles';
    if (state.capabilities?.[flag] !== true) throw problem('UNSUPPORTED', 'The current QQ session does not provide this capability');
    if (action === 'send_like') {
        const uin = identifier(params.user_id, 'user_id');
        const count = integer(params.times, 1, 10, 'times', 1);
        const resolved = await service.sessionCall(state, 'resolve', { uin });
        if (resolved?.uin !== uin || typeof resolved.uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(resolved.uid)) {
            throw problem('INVALID_RESPONSE', 'QQ did not resolve the requested profile identity');
        }
        const result = await service.sessionCall(state, 'interaction', { operation: 'profile.like', uid: resolved.uid, count });
        if (result?.confirmed !== true || result.uid !== resolved.uid || result.count !== count) {
            throw problem('INVALID_RESPONSE', 'QQ did not confirm the requested profile likes');
        }
        return null;
    }
    const groupId = identifier(params.group_id, 'group_id');
    if (action === 'get_group_at_all_remain') {
        const result = await service.sessionCall(state, 'interaction', { operation: 'group.atAllRemain', groupId });
        if (result?.group_id !== Number(groupId) || typeof result.can_at_all !== 'boolean' ||
            !Number.isSafeInteger(result.remain_at_all_count_for_uin) || result.remain_at_all_count_for_uin < 0 ||
            !Number.isSafeInteger(result.remain_at_all_count_for_group) || result.remain_at_all_count_for_group < 0) {
            throw problem('INVALID_RESPONSE', 'QQ returned invalid at-all allowances');
        }
        return result;
    }
    if (action === 'get_group_file_info') {
        const fileId = opaque(params.file_id, 'file_id');
        const result = await service.sessionCall(state, 'groupFiles', { operation: 'group.fileInfo', groupId, fileId,
            ...(params.folder_id === undefined ? {} : { directory: opaque(params.folder_id, 'folder_id') }) });
        if (result?.groupId !== groupId || result.fileInfo?.fileId !== fileId) throw problem('INVALID_RESPONSE', 'QQ returned a different group file');
        return fileInfo(result.fileInfo, groupId);
    }
    const startIndex = integer(params.start_index, 0, 0xffffffff, 'start_index');
    const count = integer(params.count, 100, 100, 'count', 1);
    const directory = action === 'get_group_files_by_folder' ? opaque(params.folder_id, 'folder_id') : '/';
    const page = await service.sessionCall(state, 'groupFiles', { operation: 'group.filesList', groupId, directory, startIndex, count });
    if (page?.groupId !== groupId || page.directory !== directory || page.startIndex !== startIndex ||
        !Array.isArray(page.items) || page.items.length > count || typeof page.isEnd !== 'boolean' ||
        !Number.isInteger(page.nextIndex) || page.nextIndex < 0 || page.nextIndex > 0xffffffff ||
        !Number.isInteger(page.allFileCount) || page.allFileCount < 0 || page.allFileCount > 0xffffffff ||
        !page.isEnd && page.nextIndex <= startIndex) throw problem('INVALID_RESPONSE', 'QQ returned invalid group file pagination');
    const files = [], folders = [], identities = new Set();
    for (const entry of page.items) {
        if (String(entry?.peerId) !== groupId) throw problem('INVALID_RESPONSE', 'QQ returned a file from another group');
        let identity;
        if (entry?.type === 1 && entry.folderInfo == null) { const info = fileInfo(entry.fileInfo, groupId); identity = 'file:' + info.file_id; files.push(info); }
        else if (entry?.type === 2 && entry.fileInfo == null) { const info = folderInfo(entry.folderInfo, groupId); identity = 'folder:' + info.folder_id; folders.push(info); }
        else throw problem('INVALID_RESPONSE', 'QQ returned an unknown group file entry');
        if (identities.has(identity)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate group file identities');
        identities.add(identity);
    }
    // The native total excludes folder entries even though both entry kinds
    // share the same page and cursor. Preserve its actual file-only value.
    if (files.length > page.allFileCount) throw problem('INVALID_RESPONSE', 'QQ returned an inconsistent group file count');
    return { files, folders, start_index: startIndex, next_index: page.nextIndex, has_more: !page.isEnd,
        is_end: page.isEnd, total_file_count: page.allFileCount };
}

module.exports = { ACTIONS, runQueryExtension };
