'use strict';

const fs = require('node:fs');
const p = require('../qq/qzone-protocol.cjs');
const { identity, REQUIREMENTS } = require('../qq/qzone.cjs');
const media = require('../qq/media.cjs');
const OPERATIONS = Object.freeze({ comment_qzone: 'qzone.comment', delete_qzone_msg: 'qzone.delete', get_qzone_feeds: 'qzone.feeds', get_qzone_msg_detail: 'qzone.detail',
    get_qzone_msg_list: 'qzone.list', like_qzone: 'qzone.like', send_qzone_msg: 'qzone.publish', set_qzone_ban: 'qzone.ban', set_qzone_msg_right: 'qzone.right', unlike_qzone: 'qzone.unlike' });
const ACTIONS = new Set(Object.keys(OPERATIONS));
const EXTENSION_REQUIREMENTS = Object.freeze(Object.fromEntries(Object.entries(OPERATIONS).map(([action, operation]) => [action, REQUIREMENTS[operation]])));
const FIELDS = Object.freeze({ target_uin: 'targetUin', user_id: 'userId', page_num: 'pageNum', ugc_right: 'ugcRight', target_uins: 'targetUins', comment_id: 'commentId', comment_uin: 'commentUin', reply_uin: 'replyUin', reply_name: 'replyName' });
function verifyResult(result, data) {
    if (data.operation === 'qzone.list') {
        if (!p.object(result) || !Array.isArray(result.msglist) || result.msglist.length > data.num) p.fail('INVALID_RESPONSE', 'Qzone returned no bounded public post list');
        p.integer(result.total, 10000000, 0, 'INVALID_RESPONSE');
        for (const row of result.msglist) {
            if (!p.object(row) || typeof row.is_private !== 'boolean' || !Array.isArray(row.images) || row.images.length > 100) p.fail('INVALID_RESPONSE', 'Invalid Qzone public post');
            p.identifier(row.tid, 'INVALID_RESPONSE'); p.string(row.content, 131072, true, 'INVALID_RESPONSE'); p.integer(row.time, 0xffffffff, 0, 'INVALID_RESPONSE'); p.integer(row.comment_num, 10000000, 0, 'INVALID_RESPONSE'); row.images.forEach(value => p.imageUrl(value));
        }
    } else if (data.operation === 'qzone.detail') {
        if (!p.object(result) || result.tid !== data.tid || !Array.isArray(result.comments) || result.comments.length > data.num) p.fail('INVALID_RESPONSE', 'Qzone returned no matching public post detail');
        p.string(result.content, 131072, true, 'INVALID_RESPONSE'); p.integer(result.comment_num, 10000000, 0, 'INVALID_RESPONSE');
        for (const row of result.comments) {
            const comment = item => { if (!p.object(item)) p.fail('INVALID_RESPONSE', 'Invalid Qzone public comment'); p.identifier(item.comment_id, 'INVALID_RESPONSE'); p.uin(item.uin, 'INVALID_RESPONSE'); p.string(item.name, 4096, true, 'INVALID_RESPONSE'); p.string(item.content, 131072, true, 'INVALID_RESPONSE'); p.integer(item.time, 0xffffffff, 0, 'INVALID_RESPONSE'); };
            comment(row); if (!Array.isArray(row.replies) || row.replies.length > 1000) p.fail('INVALID_RESPONSE', 'Invalid Qzone public inline reply collection');
            for (const reply of row.replies) { comment(reply); if (reply.parent_comment_id !== row.comment_id || reply.parent_comment_uin !== row.uin) p.fail('INVALID_RESPONSE', 'Qzone inline reply belongs to another parent'); }
        }
    } else if (data.operation === 'qzone.feeds') {
        if (!p.object(result) || !Array.isArray(result.feeds) || result.feeds.length > data.count || typeof result.has_more !== 'boolean' ||
            (result.has_more ? typeof result.next_cursor !== 'string' || result.next_cursor.length > 65536 || !result.next_cursor : result.next_cursor !== null)) p.fail('INVALID_RESPONSE', 'Qzone returned no bounded public feed continuation');
        for (const row of result.feeds) {
            if (!p.object(row) || typeof row.uin !== 'number') p.fail('INVALID_RESPONSE', 'Invalid Qzone public feed'); p.integer(row.uin, 0xffffffff, 0, 'INVALID_RESPONSE');
            if (row.author_kind !== (row.uin === 0 ? 'system-or-unattributed' : 'qq-user')) p.fail('INVALID_RESPONSE', 'Qzone feed author sentinel does not match its kind');
            p.string(row.nickname, 4096, true, 'INVALID_RESPONSE'); p.string(row.key, 1024, false, 'INVALID_RESPONSE'); p.string(row.html, 1048576, true, 'INVALID_RESPONSE'); p.integer(row.time, 0xffffffff, 0, 'INVALID_RESPONSE'); p.integer(row.appid, 0xffffffff, 0, 'INVALID_RESPONSE');
            if (row.tid !== null) p.identifier(row.tid, 'INVALID_RESPONSE'); if (row.content !== null) p.string(row.content, 1048576, true, 'INVALID_RESPONSE');
            if (row.content_complete !== null && typeof row.content_complete !== 'boolean' || row.images !== null && (!Array.isArray(row.images) || row.images.length > 1000)) p.fail('INVALID_RESPONSE', 'Invalid Qzone structured feed content');
            row.images?.forEach(value => p.imageUrl(value)); for (const key of ['like_count', 'comment_count']) if (row[key] !== null) p.integer(row[key], 1000000000, 0, 'INVALID_RESPONSE');
        }
    } else if (data.operation === 'qzone.publish') {
        if (!p.object(result)) p.fail('INVALID_RESPONSE', 'Qzone supplied no created post identity'); p.identifier(result.tid, 'INVALID_RESPONSE'); p.integer(result.time, 0xffffffff, 1, 'INVALID_RESPONSE');
    } else if (data.operation === 'qzone.comment') {
        if (!p.object(result)) p.fail('INVALID_RESPONSE', 'Qzone supplied no created comment identity'); p.identifier(result.comment_id, 'INVALID_RESPONSE');
        if (data.commentId !== undefined && (result.parent_comment_id !== data.commentId || result.parent_comment_uin !== Number(data.commentUin))) p.fail('INVALID_RESPONSE', 'Qzone replied to another parent comment');
    } else if (data.operation === 'qzone.right') {
        if (!p.object(result) || result.ugc_right !== data.ugcRight) p.fail('INVALID_RESPONSE', 'Qzone confirmed another visibility');
    } else if (result !== null) p.fail('INVALID_RESPONSE', 'Qzone mutation supplied no exact public acknowledgement');
    return result;
}
async function runQzone(service, state, action, params) {
    const operation = OPERATIONS[action]; if (!operation) p.fail('UNSUPPORTED', 'Unknown Qzone action');
    if (!p.object(params)) p.fail('INVALID_PARAMS', 'Qzone action parameters must be an object');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) p.fail('UNSUPPORTED', 'This QQ session lacks the required Qzone capability');
    const mutation = Object.hasOwn(p.ACTIONS, operation), allowed = (mutation ? p.ACTIONS : p.QUERIES)[operation];
    const raw = { operation };
    for (const [name, value] of Object.entries(params)) {
        if (name === 'self_id') { if (p.uin(value) !== String(state.self.uin)) p.fail('INVALID_PARAMS', 'Qzone self_id belongs to another account'); continue; }
        const key = FIELDS[name] || name;
        // Only the public snake_case spelling is accepted for aliased fields.
        if (!allowed.includes(key) || Object.values(FIELDS).includes(name)) p.fail('INVALID_PARAMS', 'Unexpected Qzone action parameter');
        raw[key] = value;
    }
    const input = raw.images;
    if (input !== undefined && (!Array.isArray(input) || input.length > 9 || input.some(value => typeof value !== 'string' || !media.IMAGE_RESOURCE.test(value) && !value.startsWith('base64://')))) p.fail('INVALID_PARAMS', 'Qzone images accept bounded account handles or canonical base64 images');
    if (input?.length && state.capabilities?.qzoneImages !== true) p.fail('UNSUPPORTED', 'Qzone image uploads are unavailable in this session');
    if (raw.commentId !== undefined && input?.length) p.fail('INVALID_PARAMS', 'Qzone inline replies support text only');
    const data = p.validate({ ...raw, ...(allowed.includes('images') ? { images: [] } : {}) }, mutation), staged = [];
    let size = 0, dispatched = false, received = false;
    try {
        const loaded = (input || []).map(value => {
            const image = media.IMAGE_RESOURCE.test(value) ? media.readImage(service.mediaDirectory, media.resourceInfo(service.mediaDirectory, value).path) : media.readImage(service.mediaDirectory, value);
            size += image.bytes.length; if (size > media.MAX_IMAGE_BYTES) p.fail('INVALID_PARAMS', 'A Qzone action is limited to 10 MiB of decoded images');
            return { value, image };
        });
        if (allowed.includes('images')) data.images = loaded.map(({ value, image }) => {
            if (media.IMAGE_RESOURCE.test(value)) return value;
            const resource = media.exportImage(service.mediaDirectory, image); staged.push(resource.path); return resource.file;
        });
        dispatched = true;
        const response = await service.sessionCall(state, mutation ? 'qzoneAction' : 'qzoneQuery', data); received = true;
        const expected = identity(data, String(state.self.uin));
        if (!p.object(response) || Object.entries(expected).some(([key, value]) => JSON.stringify(response[key]) !== JSON.stringify(value))) p.fail('INVALID_RESPONSE', 'Qzone result is not bound to the requested account and target');
        if (mutation && (response.confirmed !== true || response.confirmation !== (operation === 'qzone.right' ? 'ack_and_visibility_readback' : 'server_ack'))) p.fail('INVALID_RESPONSE', 'Qzone mutation has no verified business acknowledgement');
        return verifyResult(response.result, data);
    } finally {
        // Retain staged bytes after a lost RPC response: the bridge may still be
        // reading them. They remain ordinary bounded account cache resources.
        if (!dispatched || received) for (const filename of staged) try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') service.log?.('qzone_import_cleanup_failed', { code: 'MEDIA_CLEANUP' }); }
    }
}
module.exports = { ACTIONS, OPERATIONS, EXTENSION_REQUIREMENTS, REQUIREMENTS: EXTENSION_REQUIREMENTS, runQzone };
