'use strict';

const fixed = require('../qq/flash-transfer-protocol.cjs');
const business = require('../qq/flash-transfer.cjs');
const REQUIREMENTS = Object.freeze({ create_flash_task: 'flashCreate', delete_flash_file: 'flashDelete', download_fileset: 'flashDownload',
    get_fileset_id: 'flashResolve', get_fileset_info: 'flashRead', get_flash_file_list: 'flashRead', get_flash_file_url: 'flashDownload',
    get_share_link: 'flashRead', list_filesets: 'flashRead', rename_flash_file: 'flashWrite', send_flash_msg: 'flashWrite' });
const ACTIONS = new Set(Object.keys(REQUIREMENTS));
const WRITE_ACTIONS = new Set(['create_flash_task', 'delete_flash_file', 'rename_flash_file', 'send_flash_msg']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function parameters(action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown flash action');
    const keys = action === 'list_filesets' ? [] : action === 'create_flash_task' ? ['files', 'name', 'thumb_path'] : action === 'get_fileset_id' ? ['share_code'] :
        ['download_fileset', 'get_flash_file_url'].includes(action) ? ['fileset_id', 'file_index', 'file_name'] : action === 'rename_flash_file' ? ['fileset_id', 'new_name'] : action === 'send_flash_msg' ? ['fileset_id', 'user_id', 'group_id'] : ['fileset_id'];
    if (!fixed.object(params) || Object.keys(params).some(key => !['self_id', ...keys].includes(key))) fail('INVALID_PARAMS', 'Unexpected flash action parameters');
    const op = { create_flash_task: 'create', delete_flash_file: 'delete', download_fileset: 'download', get_fileset_id: 'resolve', get_fileset_info: 'detail',
        get_flash_file_list: 'detail', get_flash_file_url: 'download', get_share_link: 'share', list_filesets: 'list', rename_flash_file: 'rename', send_flash_msg: 'send' }[action];
    const input = { operation: op };
    for (const [source, target] of [['fileset_id', 'filesetId'], ['file_index', 'fileIndex'], ['file_name', 'fileName'], ['share_code', 'shareCode'], ['new_name', 'name'],
        ['files', 'files'], ['name', 'name'], ['thumb_path', 'thumbnail'], ['user_id', 'userId'], ['group_id', 'groupId']]) if (params[source] !== undefined) input[target] = params[source];
    business.request(input); return input;
}
function responseUuid(value) { try { return fixed.uuid(value); } catch { fail('INVALID_RESPONSE', 'QQ returned an invalid fileset identity'); } }
function exactSize(value) {
    try { if (typeof value !== 'string') throw new Error(); fixed.integer(value, 0xffffffffffffffffn); }
    catch { fail('INVALID_RESPONSE', 'QQ returned an invalid exact flash file size'); }
    // Keep source-compatible safe numbers, preserve exact larger uint64 values.
    return BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}
function fileRows(result, expectedId) {
    if (!fixed.object(result) || !Array.isArray(result.items) || result.items.length > 1000 || result.complete !== false) fail('INVALID_RESPONSE', 'QQ supplied no bounded flash list');
    const seen = new Set();
    return result.items.map(item => {
        if (!fixed.object(item)) fail('INVALID_RESPONSE', 'Invalid flash list row');
        const id = responseUuid(item.filesetId);
        if (expectedId && id !== expectedId || seen.has(id)) fail('INVALID_RESPONSE', 'QQ repeated or changed the requested fileset'); seen.add(id);
        const row = { fileset_id: id };
        for (const [key, target] of [['name', 'file_name'], ['origName', 'orig_name']]) if (item[key] !== undefined) {
            if (typeof item[key] !== 'string' || Buffer.byteLength(item[key]) > 512 || /[\x00-\x1f\x7f]/.test(item[key]) || Buffer.from(item[key]).toString('utf8') !== item[key]) fail('INVALID_RESPONSE', 'Invalid flash metadata text');
            row[target] = item[key];
        }
        if (item.size !== undefined) row.size = exactSize(item.size);
        if (item.type !== undefined) { if (!Number.isInteger(item.type) || item.type < 0 || item.type > 0xffffffff) fail('INVALID_RESPONSE', 'Invalid flash metadata type'); row.type = item.type; }
        if (item.shareUrl !== undefined) { try { if (fixed.shareUrl(item.shareUrl) !== item.shareUrl) throw new Error(); } catch { fail('INVALID_RESPONSE', 'QQ returned an invalid official share link'); } row.share_url = item.shareUrl; }
        return row;
    });
}
async function runFlashTransferActions(service, state, action, params) {
    const input = parameters(action, params);
    if (state.capabilities?.[REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'The current account lacks this flash transfer capability');
    const reply = await service.sessionCall(state, 'flashTransfer', input);
    if (!fixed.object(reply) || reply.operation !== input.operation || String(reply.selfUin) !== String(state.self.uin) || !fixed.object(reply.result)) fail('INVALID_RESPONSE', 'QQ returned another account or flash operation');
    const result = reply.result; let output;
    if (['list', 'detail'].includes(input.operation)) {
        if (input.operation === 'detail' && result.filesetId !== input.filesetId) fail('INVALID_RESPONSE', 'QQ returned another fileset detail');
        const items = fileRows(result, input.filesetId);
        // The known request has no demonstrated paging/terminal contract. State
        // that boundary in the data instead of claiming a complete inventory.
        output = input.operation === 'list' ? { file_list: items, complete: false } : action === 'get_fileset_info' ? { fileset_id: input.filesetId, file_list: items, complete: false } : items;
    } else if (input.operation === 'create') {
        responseUuid(result.filesetId);
        const expected = business.inputFiles(params.files).length;
        if (result.confirmed !== true || result.confirmation !== 'upload_ack_and_metadata_readback' || result.fileCount !== expected) fail('INVALID_RESPONSE', 'QQ did not confirm all flash uploads');
        output = { fileset_id: result.filesetId, task_id: result.filesetId };
    } else if (input.operation === 'resolve') output = { fileset_id: responseUuid(result.filesetId) };
    else {
        if (result.filesetId !== input.filesetId) fail('INVALID_RESPONSE', 'QQ returned another fileset result');
        if (input.operation === 'share') {
            try { if (fixed.shareUrl(result.shareUrl) !== result.shareUrl) throw new Error(); } catch { fail('INVALID_RESPONSE', 'QQ returned no official share URL'); } output = result.shareUrl;
        } else if (input.operation === 'download') {
            if (typeof result.url !== 'string' || !Number.isInteger(result.fileIndex) || result.fileIndex !== Number(input.fileIndex === undefined ? 1 : input.fileIndex)) fail('INVALID_RESPONSE', 'QQ returned another flash file index');
            try { fixed.name(result.name); const url = new URL(result.url); fixed.officialDownload(result.url, url.searchParams.get('fileid')); } catch { fail('INVALID_RESPONSE', 'QQ returned no main file download URL'); }
            if (input.fileName !== undefined && result.name !== input.fileName) fail('INVALID_RESPONSE', 'QQ returned another flash filename');
            output = action === 'get_flash_file_url' ? { url: result.url } : { url: result.url, file_name: result.name, file_size: exactSize(result.size) };
        } else {
            if (result.confirmed !== true) fail('INVALID_RESPONSE', 'QQ did not confirm the flash mutation');
            if (input.operation === 'send') {
                if (result.confirmation !== 'target_ack' || (input.groupId !== undefined ? String(result.groupId) !== String(input.groupId) : !/^u_[A-Za-z0-9_-]{1,126}$/.test(result.targetUid))) fail('INVALID_RESPONSE', 'QQ did not acknowledge the flash recipient');
                output = { sent: true, message_id: null, confirmation: 'target_ack' };
            } else {
                if (result.confirmation !== (input.operation === 'rename' ? 'name_readback' : 'account_history_removed') || input.operation === 'rename' && result.name !== input.name) fail('INVALID_RESPONSE', 'QQ did not confirm the exact fileset mutation'); output = null;
            }
        }
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) fail('INVALID_RESPONSE', 'Flash action result exceeds its byte budget');
    return output;
}
module.exports = { ACTIONS, REQUIREMENTS, WRITE_ACTIONS, runFlashTransferActions, parameters };
