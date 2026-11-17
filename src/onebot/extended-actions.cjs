'use strict';

const { locator } = require('./store.cjs');
const media = require('../qq/media.cjs');
const { importAccountImage, callAvatarAction } = require('./image-import.cjs');
const STANDARD_REQUIREMENTS = Object.freeze({ get_group_honor_info: 'groupHonor', set_group_special_title: 'groupSpecialTitle' });
const EXTENSION_REQUIREMENTS = Object.freeze({ send_poke: 'messagePoke', group_poke: 'messagePoke', friend_poke: 'messagePoke',
    set_msg_emoji_like: 'messageEmoji', set_essence_msg: 'groupEssence', delete_essence_msg: 'groupEssence',
    get_essence_msg_list: 'groupEssenceList', set_friend_category: 'friendCategorySet',
    _get_group_notice: 'groupNoticeList', _send_group_notice: 'groupNoticePublish', _del_group_notice: 'groupNoticeDelete',
    delete_friend: 'friendDelete', set_online_status: 'selfStatus', set_qq_avatar: 'selfAvatar', set_group_portrait: 'groupAvatar',
    ocr_image: 'imageOcr', get_ai_characters: 'aiVoiceCharacters', get_system_face_list: 'systemFaceList', get_system_face: 'systemFaceGet' });
const REQUIREMENTS = Object.freeze({ ...STANDARD_REQUIREMENTS, ...EXTENSION_REQUIREMENTS });
const ACTIONS = new Set(Object.keys(REQUIREMENTS));
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(params, allowed) {
    if (!object(params) || Object.keys(params).some(key => key !== 'self_id' && !allowed.includes(key))) throw problem('INVALID_PARAMS', 'Unexpected extended action parameters');
}
function integer(value, name, max = 0xffffffff, min = 0) {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw problem('INVALID_PARAMS', 'Invalid ' + name);
    return Number(value);
}
function id(value, name) { return String(integer(value, name, 0xffffffff, 1)); }
function short(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Invalid message_id');
    return Number(value);
}
function text(value, name, maximum, empty = false) {
    if (typeof value !== 'string' || !empty && !value.trim() || Buffer.byteLength(value) > maximum || /[\x00\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw problem('INVALID_PARAMS', 'Invalid ' + name);
    return value;
}
function boolean(value, name, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw problem('INVALID_PARAMS', name + ' must be boolean');
    return value;
}
async function resolve(service, state, uin) {
    const result = await service.sessionCall(state, 'resolve', { uin });
    if (!result || result.uin !== uin || typeof result.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(result.uid)) throw problem('INVALID_RESPONSE', 'QQ did not resolve the requested account');
    return result.uid;
}
function confirmed(result, request) {
    if (!object(result) || result.confirmed !== true || result.operation !== request.operation) throw problem('INVALID_RESPONSE', 'QQ did not confirm the extended operation');
    for (const key of ['groupId', 'uid', 'peerUin', 'targetUid', 'targetUin', 'nativeId', 'sequence', 'random', 'emojiId', 'set', 'categoryId', 'noticeId', 'content', 'title',
        'file', 'status', 'extStatus', 'batteryStatus', 'block', 'both']) {
        if (Object.hasOwn(request, key) && result[key] !== request[key]) throw problem('INVALID_RESPONSE', 'QQ confirmed a different extended operation target or value');
    }
    if (request.peer && (result.peer?.chatType !== request.peer.chatType || result.peer.peerUid !== request.peer.peerUid)) throw problem('INVALID_RESPONSE', 'QQ confirmed a different conversation');
}
function query(result, request, collection, max) {
    if (!object(result) || result.groupId !== request.groupId || !Array.isArray(result[collection]) || result[collection].length > max ||
        result[collection].some(row => !object(row))) throw problem('INVALID_RESPONSE', 'QQ returned an invalid or unrelated extended query');
    return result;
}

async function runExtended(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown extended action');
    if (state.capabilities?.[REQUIREMENTS[action]] !== true) throw problem('UNSUPPORTED', 'This QQ session does not provide the requested extended capability');
    let request;
    if (action === 'delete_friend') {
        fields(params, ['user_id', 'block', 'both']);
        const uin = id(params.user_id, 'user_id'), block = boolean(params.block, 'block', false), both = boolean(params.both, 'both', false);
        if (uin === String(state.self.uin)) throw problem('INVALID_PARAMS', 'Cannot delete the authenticated account as a friend');
        request = { operation: 'friend.delete', uid: await resolve(service, state, uin), block, both };
    } else if (action === 'set_online_status') {
        fields(params, ['status', 'ext_status', 'battery_status']);
        request = { operation: 'self.status', status: integer(params.status, 'status', 0xffffffff, 1), extStatus: integer(params.ext_status === undefined ? 0 : params.ext_status, 'ext_status'),
            batteryStatus: integer(params.battery_status === undefined ? 100 : params.battery_status, 'battery_status') };
    } else if (action === 'set_qq_avatar' || action === 'set_group_portrait') {
        fields(params, action === 'set_qq_avatar' ? ['file'] : ['file', 'group_id']);
        const groupId = action === 'set_group_portrait' ? id(params.group_id, 'group_id') : undefined;
        const file = await importAccountImage(service, state, params.file);
        request = action === 'set_qq_avatar' ? { operation: 'self.avatar', file } :
            { operation: 'group.avatar', groupId, file };
        const result = await callAvatarAction(service, state, request);
        confirmed(result, request); return null;
    } else if (action === 'ocr_image') {
        fields(params, ['image']);
        let imageUrl = text(params.image, 'image', 8192);
        if (media.IMAGE_RESOURCE.test(imageUrl)) {
            const info = await service.sessionCall(state, 'imageInfo', { file: imageUrl });
            if (info?.file !== imageUrl) throw problem('INVALID_RESPONSE', 'QQ returned a different OCR image resource');
            imageUrl = media.signedImageUrl(service, imageUrl);
        }
        let url; try { url = new URL(imageUrl); } catch { throw problem('INVALID_PARAMS', 'OCR needs an absolute image URL or account image handle'); }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(imageUrl)) throw problem('INVALID_PARAMS', 'Invalid OCR image URL');
        request = { operation: 'image.ocr', imageUrl };
        const result = await service.sessionCall(state, 'extendedQuery', request);
        if (!object(result) || result.imageUrl !== imageUrl || !Array.isArray(result.texts) || result.texts.length > 10000 ||
            result.texts.some(row => !object(row) || typeof row.text !== 'string' || Buffer.byteLength(row.text) > 65536)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid OCR result');
        return { texts: result.texts, ...(typeof result.language === 'string' ? { language: result.language } : {}) };
    } else if (action === 'get_ai_characters') {
        fields(params, ['group_id', 'chat_type']);
        request = { operation: 'voice.characters', groupId: id(params.group_id, 'group_id'), chatType: integer(params.chat_type ?? 1, 'chat_type', 2, 1) };
        const result = query(await service.sessionCall(state, 'extendedQuery', request), request, 'characters', 10000);
        if (result.chatType !== request.chatType) throw problem('INVALID_RESPONSE', 'QQ returned a different voice catalog context');
        let voices = 0;
        return result.characters.map(category => {
            if (typeof category.category !== 'string' || !Array.isArray(category.voices)) throw problem('INVALID_RESPONSE', 'QQ omitted the native AI voice category or character list');
            const characters = category.voices.map(voice => {
                if (++voices > 5000 || !object(voice) || typeof voice.voiceId !== 'string' || !voice.voiceId ||
                    typeof voice.voiceDisplayName !== 'string' || typeof voice.voiceExampleUrl !== 'string') throw problem('INVALID_RESPONSE', 'QQ omitted actual AI voice identity, name or preview URL');
                return { ...voice, character_id: voice.voiceId, character_name: voice.voiceDisplayName, preview_url: voice.voiceExampleUrl };
            });
            return { ...category, type: category.category, characters };
        });
    } else if (action === 'get_system_face_list' || action === 'get_system_face') {
        fields(params, action === 'get_system_face' ? ['face_id'] : []);
        request = action === 'get_system_face' ? { operation: 'face.get', faceId: String(integer(params.face_id, 'face_id')) } : { operation: 'face.list' };
        const result = await service.sessionCall(state, 'extendedQuery', request);
        if (action === 'get_system_face') {
            if (!object(result) || result.faceId !== request.faceId || !object(result.face)) throw problem('INVALID_RESPONSE', 'QQ returned a different system face');
            return result.face;
        }
        if (!object(result) || !Array.isArray(result.faces) || result.faces.length > 10000 || result.faces.some(row => !object(row))) throw problem('INVALID_RESPONSE', 'QQ returned an invalid system face catalog');
        return result.faces;
    } else if (['send_poke', 'group_poke', 'friend_poke'].includes(action)) {
        fields(params, action === 'friend_poke' ? ['user_id', 'target_id'] : ['group_id', 'user_id']);
        const peerUin = id(params.user_id, 'user_id');
        const targetUin = action === 'friend_poke' && params.target_id !== undefined ? id(params.target_id, 'target_id') : peerUin;
        const hasGroup = params.group_id !== undefined;
        if (action === 'group_poke' && !hasGroup || action === 'friend_poke' && hasGroup) throw problem('INVALID_PARAMS', 'Poke action and conversation do not match');
        const groupId = hasGroup ? id(params.group_id, 'group_id') : null;
        const resolvePoke = async uin => {
            const mapped = await resolve(service, state, uin);
            if ((uin === String(state.self.uin)) !== (mapped === state.self.uid)) throw problem('INVALID_RESPONSE', 'Poke account mapping conflicts with the current QQ identity');
            return mapped;
        };
        const peerUid = groupId ? groupId : await resolvePoke(peerUin);
        const targetUid = !groupId && targetUin === peerUin ? peerUid : await resolvePoke(targetUin);
        if (!groupId && targetUin !== peerUin && targetUid === peerUid) throw problem('INVALID_RESPONSE', 'Different poke accounts share a UID');
        request = { operation: 'message.poke', peer: { chatType: groupId ? 2 : 1, peerUid },
            ...(!groupId ? { peerUin } : {}), targetUid, targetUin };
    } else if (action === 'set_msg_emoji_like' || ['set_essence_msg', 'delete_essence_msg'].includes(action)) {
        fields(params, action === 'set_msg_emoji_like' ? ['message_id', 'emoji_id', 'set'] : ['message_id']);
        const set = action === 'set_msg_emoji_like' ? boolean(params.set, 'set', true) : action === 'set_essence_msg';
        const emojiId = action === 'set_msg_emoji_like' ? String(integer(params.emoji_id, 'emoji_id', 0x10ffff)) : null;
        const record = await service.record(state, short(params.message_id), undefined, { refresh: true });
        const where = locator(record);
        if (where.peer.chatType !== 2) throw problem('UNSUPPORTED', 'Message reactions and essence require a group message');
        const groupId = id(where.peer.peerUid, 'message group'), sequence = String(integer(where.seq, 'message sequence', 0xffffffff, 1));
        if (action === 'set_msg_emoji_like') request = { operation: 'message.emoji', peer: where.peer, groupId, nativeId: where.nativeId, sequence, emojiId, set };
        else {
            const candidates = [record.msgRandom, record.msg_random].filter(value => value !== undefined && value !== null);
            if (!candidates.length) throw problem('UNSUPPORTED', 'This message has no explicitly observed random value for essence management');
            const random = String(integer(candidates[0], 'observed message random'));
            if (candidates.some(value => String(integer(value, 'observed message random')) !== random)) throw problem('INVALID_RESPONSE', 'Message random metadata conflicts');
            request = { operation: 'group.essence', groupId, nativeId: where.nativeId, sequence, random, set };
        }
    } else if (action === 'set_friend_category') {
        fields(params, ['user_id', 'category_id']);
        const uin = id(params.user_id, 'user_id'), categoryId = integer(params.category_id, 'category_id');
        request = { operation: 'friend.category', uid: await resolve(service, state, uin), categoryId };
    } else if (action === 'set_group_special_title') {
        fields(params, ['group_id', 'user_id', 'special_title', 'duration']);
        const groupId = id(params.group_id, 'group_id'), uin = id(params.user_id, 'user_id');
        const title = text(params.special_title === undefined ? '' : params.special_title, 'special_title', 256, true);
        if (params.duration !== undefined && params.duration !== -1 && params.duration !== '-1') throw problem('UNSUPPORTED', 'This QQ version only supports persistent special titles');
        request = { operation: 'group.memberTitle', groupId, uid: await resolve(service, state, uin), title };
    } else {
        const allowed = action === 'get_group_honor_info' ? ['group_id', 'type'] : action === 'get_essence_msg_list' ? ['group_id', 'page_start', 'count'] :
            action === '_get_group_notice' ? ['group_id', 'page', 'count'] : action === '_send_group_notice' ? ['group_id', 'content'] : ['group_id', 'notice_id', 'fid'];
        fields(params, allowed);
        const groupId = id(params.group_id, 'group_id');
        if (action === 'get_group_honor_info') {
            const type = params.type ?? 'talkative';
            if (!['talkative', 'performer', 'legend', 'emotion'].includes(type)) throw problem('UNSUPPORTED', 'The requested honor category is not verified on this QQ version');
            request = { operation: 'group.honor', groupId, type };
            const result = query(await service.sessionCall(state, 'extendedQuery', request), request, 'members', 3000);
            if (result.type !== type) throw problem('INVALID_RESPONSE', 'QQ returned a different honor category');
            const members = result.members.map(member => ({ ...member, user_id: Number(id(member.user_id ?? member.uin, 'honor member')) }));
            return { group_id: Number(groupId), [type === 'talkative' ? 'talkative_list' : type === 'emotion' ? 'emotion_list' : type === 'legend' ? 'legend_list' : 'performer_list']: members };
        }
        if (action === 'get_essence_msg_list') {
            request = { operation: 'group.essenceList', groupId, start: integer(params.page_start ?? 0, 'page_start', 0x7fffffff), count: integer(params.count ?? 50, 'count', 100, 1) };
            const result = query(await service.sessionCall(state, 'extendedQuery', request), request, 'messages', request.count);
            if (typeof result.isEnd !== 'boolean') throw problem('INVALID_RESPONSE', 'QQ omitted essence pagination state');
            return result.messages;
        }
        if (action === '_get_group_notice') {
            request = { operation: 'group.noticeList', groupId, page: integer(params.page ?? 0, 'page', 0x7fffffff), count: integer(params.count ?? 20, 'count', 100, 1) };
            return query(await service.sessionCall(state, 'extendedQuery', request), request, 'notices', 1000).notices.map(notice => {
                const result = { ...notice };
                const noticeId = notice.notice_id ?? notice.fid, message = notice.message ?? notice.msg;
                if (typeof noticeId === 'string' && noticeId) result.notice_id = noticeId;
                if (object(message) && typeof message.text === 'string') result.message = { ...message };
                if (notice.sender_id !== undefined || notice.u !== undefined) result.sender_id = Number(id(notice.sender_id ?? notice.u, 'notice sender'));
                if (notice.publish_time !== undefined || notice.pubt !== undefined) result.publish_time = integer(notice.publish_time ?? notice.pubt, 'notice publication time', Number.MAX_SAFE_INTEGER);
                return result;
            });
        }
        if (action === '_del_group_notice') {
            for (const key of ['fid', 'notice_id']) if (params[key] !== undefined) text(params[key], key, 1024, true);
        }
        request = action === '_send_group_notice' ? { operation: 'group.noticePublish', groupId, content: text(params.content, 'content', 20000) } :
            { operation: 'group.noticeDelete', groupId, noticeId: text(params.fid || params.notice_id, 'notice_id', 1024) };
    }
    const result = await service.sessionCall(state, 'extendedAction', request);
    confirmed(result, request);
    return null;
}

module.exports = { ACTIONS, STANDARD_REQUIREMENTS, EXTENSION_REQUIREMENTS, REQUIREMENTS, runExtended };
