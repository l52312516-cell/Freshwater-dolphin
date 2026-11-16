'use strict';

const fs = require('node:fs');
const protocol = require('../qq/custom-face-protocol.cjs');
const media = require('../qq/media.cjs');
const codec = require('./codec.cjs');
const { locator } = require('./store.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ fetch_custom_face: 'customFaceRead', fetch_custom_face_detail: 'customFaceRead',
    add_custom_face: 'customFaceAdd', delete_custom_face: 'customFaceWrite', modify_custom_face: 'customFaceWrite', move_custom_face_to_front: 'customFaceWrite', send_custom_face: 'customFaceSend' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !['self_id', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected custom face action parameters');
}
function uint(value, maximum = 0xffffffff, positive = false) {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,9})$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum || positive && Number(value) === 0) fail('INVALID_PARAMS', 'Invalid exact custom face integer');
    return Number(value);
}
function desc(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid custom face description');
    return value;
}
function targetId(value) { return String(uint(value, 0xffffffff, true)); }
function replyId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d{0,9}$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) fail('INVALID_PARAMS', 'Invalid reply_to message ID');
    return Number(value);
}
async function send(service, state, params) {
    fields(params, ['emoji_id', 'group_id', 'user_id', 'reply_to']);
    if ((params.group_id === undefined) === (params.user_id === undefined)) fail('INVALID_PARAMS', 'Exactly one custom face target is required');
    if (typeof params.emoji_id !== 'string' || !( /^[A-Fa-f0-9]{32}$/.test(params.emoji_id) || protocol.emoji(params.emoji_id, state.self.uin))) fail('INVALID_PARAMS', 'Expected a saved custom face ID or MD5');
    const chatType = params.group_id === undefined ? 1 : 2, target = targetId(params.group_id ?? params.user_id);
    const reply = params.reply_to === undefined ? undefined : replyId(params.reply_to);
    const who = chatType === 1 ? await service.sessionCall(state, 'resolve', { uin: target }) : null;
    if (chatType === 1 && (!who || who.uin !== target || typeof who.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(who.uid))) fail('INVALID_RESPONSE', 'QQ did not resolve the custom face private target');
    const peer = { chatType, peerUid: chatType === 2 ? target : who.uid };
    const replyElements = reply === undefined ? [] : await codec.toKernel([{ type: 'reply', data: { id: String(reply) } }], { peer, reply: id => service.record(state, id, peer, { refresh: true }) });
    const prepared = await service.sessionCall(state, 'customFaceQuery', { operation: 'face.prepare', emojiId: params.emoji_id });
    if (!object(prepared) || prepared.uin !== String(state.self.uin) || typeof prepared.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(prepared.md5) ||
        protocol.emoji(prepared.emojiId, state.self.uin, 'INVALID_RESPONSE').md5 !== prepared.md5.toUpperCase() ||
        (params.emoji_id.length === 32 ? prepared.md5 !== params.emoji_id.toLowerCase() : prepared.emojiId !== params.emoji_id)) fail('INVALID_RESPONSE', 'QQ prepared another saved custom face');
    const element = prepared.element;
    if (element?.elementType !== 2 || element.picElement?.md5HexStr !== prepared.md5 || element.picElement.picSubType !== 1 || element.picElement.summary !== '[动画表情]') fail('INVALID_RESPONSE', 'QQ custom face preparation lost its saved-sticker display style');
    const record = await service.sessionCall(state, 'sendMessage', { peer, elements: [...replyElements, element], timeoutMs: service.remaining() });
    const where = locator(record), images = record.elements?.filter(item => item?.elementType === 2);
    if (where.peer.chatType !== peer.chatType || where.peer.peerUid !== peer.peerUid || String(record.senderUin) !== String(state.self.uin) ||
        images?.length !== 1 || images[0].picElement?.md5HexStr?.toLowerCase() !== prepared.md5 || images[0].picElement.picSubType !== 1) fail('INVALID_RESPONSE', 'QQ did not confirm the exact custom face and display style in the target conversation');
    const entry = service.store.remember(state.self.uin, record);
    service.queueSentMessage({ selfId: state.self.uin, messageId: entry.id, messageType: chatType === 2 ? 'group' : 'private', userId: state.self.uin,
        ...(chatType === 2 ? { groupId: target } : { peerId: target }), senderName: state.self.nickname || record.sendNickName, groupName: record.groupName,
        segments: [{ type: 'image', data: { file: 'custom-face', sub_type: 1, summary: '[动画表情]' } }] });
    return { message_id: entry.id };
}
async function runCustomFace(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown custom face action');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'The current QQ session lacks this custom face capability');
    if (action === 'send_custom_face') return send(service, state, params);
    const uin = String(state.self.uin);
    if (action === 'fetch_custom_face' || action === 'fetch_custom_face_detail') {
        fields(params, action === 'fetch_custom_face' ? ['count', 'return_type'] : ['count']);
        const count = uint(params.count === undefined ? (action === 'fetch_custom_face' ? 10 : 48) : params.count, 1000);
        const detail = action === 'fetch_custom_face_detail', type = params.return_type === undefined ? 'url' : params.return_type;
        if (!['url', 'id'].includes(type)) fail('INVALID_PARAMS', 'return_type must be url or id');
        const result = await service.sessionCall(state, 'customFaceQuery', { operation: 'face.list', count, detail });
        if (!object(result) || result.uin !== uin || !Array.isArray(result.faces) || result.faces.length > count || !Number.isInteger(result.total) || result.total < result.faces.length || result.total > 1000 || result.complete !== (result.total === result.faces.length)) fail('INVALID_RESPONSE', 'QQ supplied no bounded custom face catalog result');
        const seen = new Set();
        return result.faces.map(item => {
            if (!object(item)) fail('INVALID_RESPONSE', 'QQ supplied an invalid custom face entry');
            const expected = protocol.emoji(item.emojiId, uin, 'INVALID_RESPONSE');
            if (seen.has(item.emojiId) || item.md5 !== expected.md5 || item.url !== 'https://p.qpic.cn/qq_expression/' + uin + '/' + item.emojiId + '/0') fail('INVALID_RESPONSE', 'QQ custom face URL or digest differs from its account catalog');
            seen.add(item.emojiId);
            return detail ? { emoji_id: item.emojiId, resId: item.emojiId, url: item.url, md5: item.md5, desc: desc(item.desc) } : type === 'id' ? item.emojiId : item.url;
        });
    }
    let request, temporary, expectedDigest;
    if (action === 'add_custom_face') {
        fields(params, ['file']);
        if (typeof params.file === 'string' && media.IMAGE_RESOURCE.test(params.file)) {
            const resource = media.resourceInfo(service.mediaDirectory, params.file); expectedDigest = resource.md5.toUpperCase(); request = { operation: 'face.add', file: params.file };
        } else if (typeof params.file === 'string' && params.file.startsWith('base64://')) {
            const resource = media.exportImage(service.mediaDirectory, media.readImage(service.mediaDirectory, params.file));
            temporary = resource.path; expectedDigest = resource.md5.toUpperCase(); request = { operation: 'face.add', file: resource.file };
        } else fail('INVALID_PARAMS', 'add_custom_face requires an account image handle or canonical base64 image');
    } else {
        fields(params, action === 'modify_custom_face' ? ['emoji_id', 'desc'] : ['emoji_id']);
        const emojiId = protocol.emoji(params.emoji_id, uin).emojiId;
        request = { operation: action === 'delete_custom_face' ? 'face.delete' : action === 'modify_custom_face' ? 'face.modify' : 'face.moveFront', emojiId,
            ...(action === 'modify_custom_face' ? { desc: desc(params.desc ?? '') } : {}) };
    }
    try {
        const result = await service.sessionCall(state, 'customFaceAction', request);
        if (!object(result) || result.operation !== request.operation || result.uin !== uin || result.confirmed !== true ||
            result.confirmation !== { 'face.add': 'catalog_readback', 'face.delete': 'catalog_absence', 'face.modify': 'description_readback', 'face.moveFront': 'order_readback' }[request.operation]) fail('INVALID_RESPONSE', 'QQ did not confirm the custom face mutation');
        const identity = protocol.emoji(result.emojiId, uin, 'INVALID_RESPONSE');
        if (expectedDigest !== undefined && identity.md5 !== expectedDigest) fail('INVALID_RESPONSE', 'QQ saved a different custom face image digest');
        if (request.emojiId !== undefined && result.emojiId !== request.emojiId || request.desc !== undefined && result.desc !== request.desc) fail('INVALID_RESPONSE', 'QQ confirmed a different custom face target or description');
        return action === 'add_custom_face' ? { emoji_id: result.emojiId } : null;
    } finally { if (temporary) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') service.log('custom_face_import_cleanup_failed', { code: 'MEDIA_CLEANUP' }); } }
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, REQUIREMENTS: EXTENSION_REQUIREMENTS, runCustomFace };
