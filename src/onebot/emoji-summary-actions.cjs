'use strict';

const protocol = require('../qq/emoji-summary.cjs');
const ACTIONS = new Set(['get_msg_emoji_likes']);
const EXTENSION_REQUIREMENTS = Object.freeze({ get_msg_emoji_likes: 'messageEmojiSummary' });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runEmojiSummary(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown reaction summary action');
    if (!params || typeof params !== 'object' || Object.getPrototypeOf(params) !== Object.prototype ||
        Reflect.ownKeys(params).some(key => typeof key !== 'string' || !['self_id', 'message_id'].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(params, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected reaction summary parameters');
    const id = params.message_id;
    if (!['number', 'string'].includes(typeof id) || !/^-?[1-9]\d{0,9}$/.test(String(id)) || !Number.isInteger(Number(id)) ||
        Number(id) < -0x80000000 || Number(id) > 0x7fffffff) fail('INVALID_PARAMS', 'Expected an exact current-account message_id');
    if (params.self_id !== undefined && (!['number', 'string'].includes(typeof params.self_id) || String(params.self_id) !== state.self?.uin || !/^[1-9]\d{0,9}$/.test(String(params.self_id)))) fail('INVALID_PARAMS', 'Reaction summary self_id belongs to another account');
    if (state.capabilities?.messageEmojiSummary !== true) fail('UNSUPPORTED', 'This QQ session lacks complete native reaction summaries');
    const entry = service.store.get(state.self.uin, Number(id));
    if (!entry) fail('NOT_FOUND', 'Reaction message_id is unknown to this QQ account');
    const where = entry.locator, request = protocol.request({ peer: where?.peer, nativeId: where?.nativeId, sequence: where?.seq });
    const reply = await service.sessionCall(state, 'emojiSummaryQuery', request);
    if (!reply || reply.uin !== state.self.uin || reply.nativeId !== request.nativeId || reply.sequence !== request.sequence ||
        reply.peer?.chatType !== request.peer.chatType || reply.peer?.peerUid !== request.peer.peerUid) fail('INVALID_RESPONSE', 'QQ returned another message reaction summary');
    const result = protocol.validateSummary(reply.summary); await service.assertSession(state);
    return { message_id: Number(id), ...result };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runEmojiSummary };
