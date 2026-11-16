'use strict';

const { runExtended } = require('./extended-actions.cjs');
const { runGroupFiles } = require('./group-files.cjs');

// Names and response projections follow SnowLuma's executable registry. These
// adapters retain the existing account session and action deadline.
const EXTENSION_REQUIREMENTS = Object.freeze({
    delete_group_file_folder: 'groupFolderDelete',
    set_friends_category: Object.freeze(['friendCategorySet', 'friendCategories']),
    set_group_reaction: 'messageEmoji',
    fetch_sys_faces: 'systemFaceList',
    fetch_face_entity: Object.freeze(['systemFaceList', 'systemFaceGet']),
    search_sys_faces: 'systemFaceList',
    fetch_super_face_id: Object.freeze(['systemFaceList', 'systemFaceGet'])
});
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
const READ_ONLY_ACTIONS = new Set(['fetch_sys_faces', 'fetch_face_entity', 'search_sys_faces', 'fetch_super_face_id']);
const MAX_FACES = 5000, MAX_PACKS = 1536, MAX_RESULT_BYTES = 1024 * 1024;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function own(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw problem('INVALID_RESPONSE', 'QQ returned an accessor instead of response data');
    return descriptor?.value;
}
function fields(value, allowed) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['self_id', ...allowed].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected compatibility action parameters');
}
function integer(value, name, maximum = 0xffffffff, minimum = 0, code = 'INVALID_PARAMS') {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,9})$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw problem(code, 'Invalid exact ' + name);
    return Number(value);
}
function short(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Use a current-account short message_id');
    return Number(value);
}
function text(value, name, maximum, empty = false, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum ||
        Buffer.from(value).toString('utf8') !== value) throw problem(code, 'Invalid bounded ' + name);
    return value;
}
function boolean(value, fallback = false) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw problem('INVALID_PARAMS', 'Expected an explicit boolean');
    return value;
}
function responseText(value, name, maximum, fallback) {
    return value === undefined ? fallback : text(value, name, maximum, true, 'INVALID_RESPONSE');
}
function array(value, maximum, label) {
    if (!Array.isArray(value) || value.length > maximum) throw problem('INVALID_RESPONSE', 'QQ returned an invalid bounded ' + label);
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw problem('INVALID_RESPONSE', 'QQ returned a sparse or accessor result list');
    }
    return value;
}
function face(value) {
    if (!plain(value)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid system face');
    const output = {
        q_sid: text(own(value, 'qSid'), 'system face identity', 128, false, 'INVALID_RESPONSE'),
        q_des: responseText(own(value, 'qDes'), 'system face description', 4096, ''),
        em_code: responseText(own(value, 'emCode'), 'system face code', 4096, '')
    };
    for (const [source, target] of [['qCid', 'q_cid'], ['aniStickerType', 'ani_sticker_type'], ['aniStickerPackId', 'ani_sticker_pack_id'],
        ['aniStickerId', 'ani_sticker_id'], ['aniStickerWidth', 'ani_sticker_width'], ['aniStickerHeight', 'ani_sticker_height']]) {
        const number = own(value, source);
        if (number !== undefined && (typeof number !== 'number' || !Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid system face integer');
        output[target] = number === undefined ? null : number;
    }
    const resource = own(value, 'resourceUrl');
    if (resource !== undefined && !plain(resource)) throw problem('INVALID_RESPONSE', 'QQ returned invalid system face resources');
    output.url = resource === undefined ? null : responseText(own(resource, 'baseUrl'), 'system face URL', 4096, null);
    const aliases = own(value, 'emojiNameAlias');
    output.emoji_name_alias = aliases === undefined ? [] : array(aliases, 128, 'system face aliases').map(value =>
        text(value, 'system face alias', 1024, true, 'INVALID_RESPONSE'));
    output.is_super = output.ani_sticker_type !== null && output.ani_sticker_type > 0;
    return output;
}
function catalog(value) {
    if (!plain(value)) throw problem('INVALID_RESPONSE', 'QQ returned no system face catalog');
    let total = 0, bytes = Buffer.byteLength('{"packs":[]}');
    const packs = array(own(value, 'packs'), MAX_PACKS, 'system face packs').map((pack, packIndex) => {
        if (!plain(pack) || !['common', 'special-big', 'magic'].includes(own(pack, 'source'))) throw problem('INVALID_RESPONSE', 'QQ returned an unknown system face panel');
        const name = responseText(own(pack, 'packName'), 'system face pack name', 4096, '');
        const output = { pack_name: name || (own(pack, 'source') === 'magic' ? 'MagicFace' : ''), emojis: [] };
        bytes += Buffer.byteLength(JSON.stringify(output)) + (packIndex ? 1 : 0);
        if (bytes > MAX_RESULT_BYTES) throw problem('INVALID_RESPONSE', 'QQ system face catalog exceeded its result budget');
        for (const entry of array(own(pack, 'emojis'), MAX_FACES, 'system faces')) {
            if (++total > MAX_FACES) throw problem('INVALID_RESPONSE', 'QQ system face catalog has too many entries');
            const projected = face(entry);
            bytes += Buffer.byteLength(JSON.stringify(projected)) + (output.emojis.length ? 1 : 0);
            if (bytes > MAX_RESULT_BYTES) throw problem('INVALID_RESPONSE', 'QQ system face catalog exceeded its result budget');
            output.emojis.push(projected);
        }
        return output;
    });
    return { packs };
}
function friendTarget(value, target, selector) {
    const categories = array(value, 1000, 'friend categories'), ids = new Set(), users = new Set(), uids = new Set(), matches = [];
    let friend, total = 0;
    for (const category of categories) {
        if (!plain(category)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid friend category');
        const categoryId = integer(own(category, 'categoryId'), 'friend category ID', 0xffffffff, 0, 'INVALID_RESPONSE'),
            categoryName = text(own(category, 'categoryName'), 'friend category name', 4096, true, 'INVALID_RESPONSE'),
            count = integer(own(category, 'categoryMbCount'), 'friend category count', 50000, 0, 'INVALID_RESPONSE'),
            members = array(own(category, 'buddyList'), 50000, 'friend category members');
        if (typeof own(category, 'categoryId') !== 'number' || typeof own(category, 'categoryMbCount') !== 'number' ||
            ids.has(categoryId) || count !== members.length || (total += members.length) > 50000) throw problem('INVALID_RESPONSE', 'QQ returned duplicate or incomplete friend categories');
        ids.add(categoryId);
        if (selector.categoryId === categoryId || selector.categoryName !== undefined && selector.categoryName === categoryName) matches.push(categoryId);
        for (const member of members) {
            if (!plain(member)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid categorized friend');
            const uin = String(integer(own(member, 'user_id'), 'categorized friend', 0xffffffff, 1, 'INVALID_RESPONSE')), uid = own(member, 'uid');
            if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(uid) || users.has(uin) || uids.has(uid)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate or invalid friend identities');
            users.add(uin); uids.add(uid);
            if (uin === target) friend = { uin, uid };
        }
    }
    if (!friend) throw problem('NOT_FOUND', 'The requested account is not in the live friend roster');
    if (!matches.length) throw problem('NOT_FOUND', 'The requested friend category does not exist');
    if (matches.length !== 1) throw problem('INVALID_PARAMS', 'Friend category name is ambiguous');
    return { ...friend, categoryId: matches[0] };
}

async function runCompatActions(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown compatibility action');
    const allowed = action === 'delete_group_file_folder' ? ['group_id', 'folder_id'] : action === 'set_friends_category' ? ['uin', 'categoryId', 'categoryName'] :
        action === 'set_group_reaction' ? ['message_id', 'group_id', 'code', 'is_set'] : action === 'search_sys_faces' ? ['query'] :
            action === 'fetch_sys_faces' ? ['refresh'] : ['face_id', 'refresh'];
    fields(params, allowed);
    if (params.self_id !== undefined && String(integer(params.self_id, 'self_id', 0xffffffff, 1)) !== String(state.self.uin)) throw problem('INVALID_PARAMS', 'self_id belongs to another account');
    const requirements = [].concat(EXTENSION_REQUIREMENTS[action]);
    if (requirements.some(flag => state.capabilities?.[flag] !== true)) throw problem('UNSUPPORTED', 'This QQ session does not provide the requested compatibility capability');
    if (action === 'delete_group_file_folder') return runGroupFiles(service, state, 'delete_group_folder', params);
    if (action === 'set_friends_category') {
        const uin = String(integer(params.uin, 'uin', 0xffffffff, 1)), hasId = params.categoryId !== undefined, hasName = params.categoryName !== undefined;
        if (hasId === hasName) throw problem('INVALID_PARAMS', 'Exactly one of categoryId or categoryName is required');
        const selector = hasId ? { categoryId: integer(params.categoryId, 'categoryId') } : { categoryName: text(params.categoryName, 'categoryName', 4096) };
        const target = friendTarget(await service.sessionCall(state, 'socialQuery', { operation: 'categories' }), uin, selector);
        // Reuse the existing setter's ACK/readback and require its UID resolver
        // to agree with the same live roster used to select the category.
        const guarded = { async sessionCall(bound, method, request) {
            const result = await service.sessionCall(bound, method, request);
            if (method === 'resolve' && (request.uin !== target.uin || result?.uid !== target.uid)) throw problem('INVALID_RESPONSE', 'Friend UID resolver disagrees with the live roster');
            return result;
        } };
        return runExtended(guarded, state, 'set_friend_category', { user_id: uin, category_id: target.categoryId });
    }
    if (action === 'set_group_reaction') {
        const messageId = short(params.message_id), code = text(params.code, 'code', 7), set = boolean(params.is_set, true),
            groupId = params.group_id === undefined ? null : String(integer(params.group_id, 'group_id', 0xffffffff, 1));
        integer(code, 'numeric reaction code', 0x10ffff);
        const entry = service.store.get(state.self.uin, messageId), peer = entry?.locator?.peer;
        if (!entry) throw problem('NOT_FOUND', 'Reaction message_id is unknown to this account');
        if (!peer || peer.chatType !== 2) throw problem('UNSUPPORTED', 'Group reactions require a stored group message');
        const observedGroup = String(integer(peer.peerUid, 'stored message group', 0xffffffff, 1, 'INVALID_RESPONSE'));
        if (groupId !== null && groupId !== observedGroup) throw problem('INVALID_PARAMS', 'group_id differs from the stored reaction conversation');
        return runExtended(service, state, 'set_msg_emoji_like', { message_id: messageId, emoji_id: code, set });
    }
    const refresh = action === 'search_sys_faces' ? false : boolean(params.refresh),
        faceId = ['fetch_face_entity', 'fetch_super_face_id'].includes(action) ? String(integer(params.face_id, 'face_id')) : null,
        query = action === 'search_sys_faces' ? text(params.query, 'query', 4096) : null;
    const result = catalog(await service.sessionCall(state, 'extendedQuery', { operation: 'face.list' }));
    if (action === 'fetch_sys_faces') { await service.assertSession(state); return result; }
    const canonical = new Map();
    for (const pack of result.packs) for (const entry of pack.emojis) if (!canonical.has(entry.q_sid)) canonical.set(entry.q_sid, entry);
    if (action === 'search_sys_faces') {
        const needle = query.trim().toLocaleLowerCase(), faces = [], matched = new Set();
        if (needle) for (const pack of result.packs) for (const entry of pack.emojis) {
            if (!matched.has(entry.q_sid) && [entry.q_sid, entry.q_des, entry.em_code, pack.pack_name, ...entry.emoji_name_alias].some(value => value.toLocaleLowerCase().includes(needle))) {
                faces.push(canonical.get(entry.q_sid)); matched.add(entry.q_sid);
            }
        }
        await service.assertSession(state);
        return { faces };
    }
    let selected = canonical.get(faceId) ?? null;
    if (selected === null && !refresh) {
        const single = await service.sessionCall(state, 'extendedQuery', { operation: 'face.get', faceId });
        if (!plain(single) || own(single, 'faceId') !== faceId) throw problem('INVALID_RESPONSE', 'QQ returned an unrelated system face lookup');
        const entity = own(single, 'face');
        selected = entity === null ? null : face(entity);
        if (selected !== null && selected.q_sid !== faceId) throw problem('INVALID_RESPONSE', 'QQ returned a different system face identity');
    }
    await service.assertSession(state);
    return action === 'fetch_super_face_id' ? { is_super: selected?.is_super === true } : selected;
}

module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, runCompatActions, MAX_FACES, MAX_PACKS, MAX_RESULT_BYTES };
