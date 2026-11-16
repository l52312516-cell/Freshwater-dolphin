'use strict';
const { runAccountQuery, MAX_COUNT } = require('./account-queries.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ fetch_emoji_like: 'messageEmojiLikes' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runEmojiPagination(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown emoji pagination action');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['self_id', 'message_id', 'emojiId', 'count', 'cookie'].includes(key)))
        fail('INVALID_PARAMS', 'Unexpected emoji pagination parameters');
    const count = params.count === undefined ? 10 : params.count, cookie = params.cookie === undefined ? '' : params.cookie;
    if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT || typeof cookie !== 'string' || cookie.length > 262144 ||
        typeof params.emojiId !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(params.emojiId)) fail('INVALID_PARAMS', 'Expected an exact emojiId, bounded count and opaque cookie');
    const result = await runAccountQuery(service, state, 'get_emoji_likes', { message_id: params.message_id, emoji_id: params.emojiId,
        count, ...(params.self_id !== undefined ? { self_id: params.self_id } : {}), ...(cookie ? { cursor: cookie } : {}) });
    return { result: 0, errMsg: '', emojiLikesList: result.emoji_like_list.map(row => ({ tinyId: row.user_id, nickName: row.nick_name, headUrl: row.head_url })),
        cookie: result.next_cursor ?? '', isLastPage: !result.has_more, isFirstPage: cookie === '' };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runEmojiPagination };
