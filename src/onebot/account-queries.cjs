'use strict';

const crypto = require('node:crypto');
const { validateProfileInfo, validateEmojiUsers } = require('../qq/account-queries.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ get_profile_like: 'profileLikeRead', get_emoji_likes: 'messageEmojiLikes' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
const MAX_COUNT = 150, MAX_PAGES = 10, MAX_CURSOR = 262144, MAX_USERS = 1024, MAX_COOKIES = 256, CURSOR_TTL = 15 * 60 * 1000;
const keys = new WeakMap();
function problem(code, message) { return Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(params, allowed) {
    if (!object(params) || Object.keys(params).some(key => !['self_id', ...allowed].includes(key))) throw problem('INVALID_PARAMS', 'Unexpected account query parameters');
}
function integer(value, name, max = 0xffffffffffffffffn, min = 0n) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) < min || BigInt(value) > max) throw problem('INVALID_PARAMS', 'Invalid exact ' + name);
    return String(value);
}
function uin(value) { return integer(value, 'user_id', BigInt(Number.MAX_SAFE_INTEGER), 1n); }
function short(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Use a current-account short message_id');
    return Number(value);
}
function secret(service) { if (!keys.has(service)) keys.set(service, crypto.randomBytes(32)); return keys.get(service); }
function binding(service, state, where, emojiId, emojiType) {
    return [1, service.profileId ?? null, String(state.self.uin), state.self.uid, state.epoch, where.peer.chatType, where.peer.peerUid, where.nativeId, where.seq, emojiId, emojiType];
}
function encodeCursor(service, bound, page) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', secret(service), iv);
    cipher.setAAD(Buffer.from(JSON.stringify(bound)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ expires: Date.now() + CURSOR_TTL, ...page }), 'utf8'), cipher.final()]);
    const token = 'eq1.' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    if (token.length > MAX_CURSOR) throw problem('UNSUPPORTED', 'Reaction cursor reached its bounded size limit');
    return token;
}
function parseCursor(service, bound, value) {
    const invalid = () => problem('NOT_FOUND', 'Reaction cursor is invalid, expired or belongs to another message, emoji or account session');
    if (typeof value !== 'string' || value.length > MAX_CURSOR || !/^eq1\.[A-Za-z0-9_-]+$/.test(value)) throw invalid();
    const payload = Buffer.from(value.slice(4), 'base64url');
    if (payload.length < 29 || payload.toString('base64url') !== value.slice(4)) throw invalid();
    let page;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', secret(service), payload.subarray(0, 12));
        decipher.setAAD(Buffer.from(JSON.stringify(bound))); decipher.setAuthTag(payload.subarray(12, 28));
        page = JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { throw invalid(); }
    if (!object(page) || !Number.isSafeInteger(page.expires) || page.expires <= Date.now() || page.expires > Date.now() + CURSOR_TTL ||
        typeof page.cookie !== 'string' || Buffer.byteLength(page.cookie) > 4096 || /[\u0000-\u001f\u007f]/u.test(page.cookie) || typeof page.last !== 'boolean' ||
        !Array.isArray(page.seenUsers) || page.seenUsers.length > MAX_USERS || page.seenUsers.some(item => typeof item !== 'string' || !item.length || Buffer.byteLength(item) > 128) ||
        new Set(page.seenUsers).size !== page.seenUsers.length || !Array.isArray(page.seenCookies) || page.seenCookies.length > MAX_COOKIES ||
        page.seenCookies.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item)) || new Set(page.seenCookies).size !== page.seenCookies.length) throw invalid();
    try { page.buffer = validateEmojiUsers(page.buffer); } catch { throw invalid(); }
    if (page.buffer.some(item => !page.seenUsers.includes(item.tinyId)) || !page.last && !page.cookie || page.last && !page.buffer.length) throw invalid();
    return page;
}
function queryResult(value, request) {
    if (!object(value) || value.operation !== request.operation) throw problem('INVALID_RESPONSE', 'QQ supplied an unrelated account query response');
    for (const name of ['uid', 'start', 'count', 'nativeId', 'sequence', 'emojiId', 'emojiType']) if (Object.hasOwn(request, name) && request[name] !== value[name]) throw problem('INVALID_RESPONSE', 'QQ supplied another account query target');
    if (request.peer && (value.peer?.chatType !== request.peer.chatType || value.peer.peerUid !== request.peer.peerUid)) throw problem('INVALID_RESPONSE', 'QQ supplied another reaction conversation');
    return value;
}

async function runAccountQuery(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown account query');
    fields(params, action === 'get_profile_like' ? ['user_id', 'start', 'count'] : ['message_id', 'group_id', 'emoji_id', 'emoji_type', 'count', 'cursor']);
    if (params.self_id !== undefined && uin(params.self_id) !== String(state.self.uin)) throw problem('INVALID_PARAMS', 'self_id belongs to another account');
    if (action === 'get_profile_like') {
        const target = params.user_id === undefined ? String(state.self.uin) : uin(params.user_id),
            start = Number(integer(params.start === undefined ? 0 : params.start, 'profile offset', 0x7fffffffn)), count = Number(integer(params.count === undefined ? 10 : params.count, 'profile count', 100n, 1n));
        if (state.capabilities?.profileLikeRead !== true) throw problem('UNSUPPORTED', 'This QQ session cannot query profile likes');
        let uid = state.self.uid;
        if (target !== String(state.self.uin)) {
            const resolved = await service.sessionCall(state, 'resolve', { uin: target });
            if (resolved?.uin !== target || typeof resolved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(resolved.uid)) throw problem('INVALID_RESPONSE', 'QQ did not resolve the requested profile account');
            uid = resolved.uid;
        }
        const request = { operation: 'profile.likes', uid, start, count };
        const response = queryResult(await service.sessionCall(state, 'accountQuery', request), request);
        const profile = validateProfileInfo(response.profile, uid);
        await service.assertSession(state);
        return profile;
    }
    const messageId = short(params.message_id), emojiId = integer(params.emoji_id, 'emoji_id'), emojiType = params.emoji_type === undefined ? (emojiId.length > 3 ? '2' : '1') : params.emoji_type,
        requested = Number(integer(params.count === undefined ? 0 : params.count, 'reaction count', BigInt(MAX_COUNT))), count = requested === 0 ? MAX_COUNT : requested,
        groupId = params.group_id === undefined ? null : integer(params.group_id, 'group_id', 0xffffffffn, 1n);
    if (!['1', '2'].includes(emojiType)) throw problem('INVALID_PARAMS', 'emoji_type must be string 1 or 2');
    const entry = service.store.get(state.self.uin, messageId);
    if (!entry) throw problem('NOT_FOUND', 'Reaction message_id is unknown to this account');
    const where = entry.locator;
    if (!object(where) || !object(where.peer) || ![1, 2].includes(where.peer.chatType) ||
        (where.peer.chatType === 1 ? typeof where.peer.peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(where.peer.peerUid) : integer(where.peer.peerUid, 'message group', 0xffffffffn, 1n) !== where.peer.peerUid)) throw problem('INVALID_RESPONSE', 'Stored reaction peer is invalid');
    if (typeof where.nativeId !== 'string' || typeof where.seq !== 'string') throw problem('INVALID_RESPONSE', 'Stored reaction locator is not exact');
    integer(where.nativeId, 'native message ID', 0xffffffffffffffffn, 1n); integer(where.seq, 'message sequence', 0xffffffffffffffffn, 1n);
    if (groupId !== null && (where.peer.chatType !== 2 || where.peer.peerUid !== groupId)) throw problem('INVALID_PARAMS', 'group_id differs from the stored reaction conversation');
    const bound = binding(service, state, where, emojiId, emojiType);
    const page = params.cursor === undefined ? { cookie: '', last: false, buffer: [], seenUsers: [], seenCookies: [] } : parseCursor(service, bound, params.cursor);
    if (state.capabilities?.messageEmojiLikes !== true) throw problem('UNSUPPORTED', 'This QQ session cannot query message reactions');
    const locationRequest = { operation: 'message.locate', peer: where.peer, nativeId: where.nativeId, sequence: where.seq };
    queryResult(await service.sessionCall(state, 'accountQuery', locationRequest), locationRequest);
    const users = [], seenUsers = new Set(page.seenUsers), seenCookies = new Set(page.seenCookies);
    let fetched = 0;
    while (users.length < count) {
        users.push(...page.buffer.splice(0, count - users.length));
        if (users.length === count || page.last || fetched >= MAX_PAGES) break;
        if (seenUsers.size >= MAX_USERS || seenCookies.size >= MAX_COOKIES) throw problem('UNSUPPORTED', 'Reaction pagination reached its bounded session cursor limit');
        const request = { operation: 'message.emojiLikes', peer: where.peer, nativeId: where.nativeId, sequence: where.seq, emojiId, emojiType, cookie: page.cookie };
        const response = queryResult(await service.sessionCall(state, 'accountQuery', request), request);
        const received = validateEmojiUsers(response.users);
        if (typeof response.cookie !== 'string' || Buffer.byteLength(response.cookie) > 4096 || /[\u0000-\u001f\u007f]/u.test(response.cookie) ||
            typeof response.isFirstPage !== 'boolean' || response.isFirstPage !== (page.cookie === '') || typeof response.isLastPage !== 'boolean') throw problem('INVALID_RESPONSE', 'QQ supplied invalid reaction pagination state');
        const cookieHash = crypto.createHash('sha256').update(response.cookie).digest('base64url');
        if (!response.isLastPage && (!response.cookie || seenCookies.has(cookieHash)) || received.some(item => seenUsers.has(item.tinyId)) || seenUsers.size + received.length > MAX_USERS) throw problem('INVALID_RESPONSE', 'QQ reaction pages repeated users or failed to advance');
        for (const item of received) seenUsers.add(item.tinyId);
        if (!response.isLastPage) seenCookies.add(cookieHash);
        page.buffer = received; page.cookie = response.cookie; page.last = response.isLastPage; fetched++;
    }
    const hasMore = page.buffer.length > 0 || !page.last;
    const next = hasMore ? encodeCursor(service, bound, { cookie: page.cookie, last: page.last, buffer: page.buffer, seenUsers: [...seenUsers], seenCookies: [...seenCookies] }) : null;
    await service.assertSession(state);
    return { emoji_like_list: users.map(row => ({ user_id: row.tinyId, nick_name: row.nickName, head_url: row.headUrl })),
        has_more: hasMore, partial: hasMore, next_cursor: next, limit: count, fetched_pages: fetched, page_limit: MAX_PAGES };
}

module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runAccountQuery, MAX_COUNT, MAX_PAGES };
