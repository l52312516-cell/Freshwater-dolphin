'use strict';

const { normalizeMergedNodes, existingNodeIds } = require('./merged-nodes.cjs');
const { runMerged } = require('./merged.cjs');
const { finalResource } = require('../qq/forward.cjs');
const { locator } = require('./store.cjs');
const { uint } = require('../qq/admin-oidb.cjs');
const protocol = require('../qq/forward-upload-protocol.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ upload_forward_msg: 'forwardUpload', upload_foward_msg: 'forwardUpload',
    send_forward_msg: 'mergeCustom' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
const UNSUPPORTED_ACTIONS = Object.freeze({ get_msg_emoji_likes: 'This QQ build exposes no verified complete per-message emoji summary with authoritative last reaction times' });
const READ_ONLY_ACTIONS = new Set(['get_msg_emoji_likes']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function short(value) {
    if (!['number', 'string'].includes(typeof value) || !/^-?[1-9]\d{0,9}$/.test(String(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) fail('INVALID_PARAMS', 'Use an exact current-account short message_id');
    return Number(value);
}
async function runForwardExtra(service, state, action, params) {
    if (!ACTIONS.has(action) && !Object.hasOwn(UNSUPPORTED_ACTIONS, action)) fail('UNSUPPORTED', 'Unknown extended forward action');
    protocol.fields(params, action === 'get_msg_emoji_likes' ? ['self_id', 'message_id'] :
        action === 'send_forward_msg' ? ['self_id', 'message', 'messages', 'message_type', 'group_id', 'user_id', 'source', 'summary', 'prompt', 'news'] : ['self_id', 'message', 'messages', 'group_id']);
    if (params.self_id !== undefined && uint(params.self_id, 'self_id', 0xffffffffn, 1n) !== String(state.self.uin)) fail('INVALID_PARAMS', 'self_id belongs to another account');
    if (action === 'get_msg_emoji_likes') {
        short(params.message_id);
        // 0x9084 is the recent-used catalog; 0x9083 only pages one known emoji.
        // Neither proves all emojis or the real last reaction time. A partial
        // local event cache must not become a successful complete response.
        fail('UNSUPPORTED', UNSUPPORTED_ACTIONS[action]);
    }
    if (params.message !== undefined && params.messages !== undefined) fail('INVALID_PARAMS', 'Provide one of message or messages');
    const messages = params.messages ?? params.message;
    if (messages === undefined) fail('INVALID_PARAMS', 'message/messages is required');
    if (['source', 'summary', 'prompt', 'news'].some(key => Object.hasOwn(params, key))) fail('UNSUPPORTED', 'Custom merged-forward preview metadata is not supported by the confirmed native send path');
    const groupId = params.group_id === undefined ? '0' : uint(params.group_id, 'group_id'),
        userId = params.user_id === undefined ? '0' : uint(params.user_id, 'user_id'), messageType = params.message_type ?? '';
    if (!['', 'group', 'private'].includes(messageType)) fail('INVALID_PARAMS', 'message_type must be group or private');
    if (action === 'send_forward_msg' && (messageType === 'group' || groupId !== '0' || messageType === 'private' || userId !== '0')) {
        const group = messageType === 'group' || groupId !== '0', target = group ? groupId : userId;
        if (target === '0') fail('INVALID_PARAMS', group ? 'group_id is required' : 'user_id is required');
        const sent = await runMerged(service, state, group ? 'send_group_forward_msg' : 'send_private_forward_msg', {
            [group ? 'group_id' : 'user_id']: target, messages, ...(params.self_id === undefined ? {} : { self_id: params.self_id }) });
        await service.assertSession(state);
        const entry = service.store.get(String(state.self.uin), sent.message_id), record = entry?.record;
        if (!record || entry.id !== sent.message_id || record.sendStatus !== 2 || record.senderUid !== state.self.uid || String(record.senderUin) !== String(state.self.uin)) fail('INVALID_RESPONSE', 'QQ merged send has no retained confirmed resource root');
        const where = locator(record);
        if (where.peer.chatType !== (group ? 2 : 1) || group && where.peer.peerUid !== target) fail('INVALID_RESPONSE', 'QQ retained a different merged destination');
        const resId = protocol.resource(finalResource(record), 'INVALID_RESPONSE');
        return { message_id: sent.message_id, res_id: resId, forward_id: resId };
    }
    if (existingNodeIds(messages)) fail('UNSUPPORTED', 'Upload-only forwarding currently requires custom text nodes');
    const normalized = normalizeMergedNodes(messages, { selfId: String(state.self.uin) });
    if (normalized.some(node => node.content.some(segment => segment.type !== 'text'))) fail('UNSUPPORTED', 'Upload-only forwarding currently supports complete text nodes; image uploads need a separate verified resource upload path');
    if (state.capabilities?.forwardUpload !== true) fail('UNSUPPORTED', 'QQ fixed forward resource upload is unavailable');
    const nodes = normalized.map(node => ({ nickname: node.nickname, texts: node.content.map(segment => segment.data.text) }));
    const result = await service.sessionCall(state, 'forwardUpload', { nodes, ...(groupId !== '0' ? { groupId } : {}) });
    await service.assertSession(state);
    if (result?.uploaded !== true || result.sent !== false || result.confirmation !== 'fixed-longmsg-resource-and-exact-readback' || result.nodeCount !== nodes.length ||
        (groupId === '0' ? result.groupId !== undefined : result.groupId !== groupId)) fail('INVALID_RESPONSE', 'QQ supplied no exact upload-only forward resource confirmation');
    const resId = protocol.resource(result.resId, 'INVALID_RESPONSE');
    return { message_id: 0, res_id: resId, forward_id: resId, ...(action === 'upload_forward_msg' && groupId !== '0' ? { group_id: Number(groupId) } : {}) };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, UNSUPPORTED_ACTIONS, runForwardExtra };
