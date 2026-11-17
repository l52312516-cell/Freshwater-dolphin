'use strict';
const { locator } = require('./store.cjs');
const { annotate } = require('../diagnostics.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ forward_friend_single_msg: Object.freeze(['reply', 'text']),
    forward_group_single_msg: Object.freeze(['reply', 'text']) });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runSingleForward(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown single-message forward action');
    const group = action === 'forward_group_single_msg', key = group ? 'group_id' : 'user_id';
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(name => !['self_id', 'message_id', key].includes(name))) fail('INVALID_PARAMS', 'Unexpected single-message forward parameters');
    const target = params[key], id = params.message_id;
    if (!['number', 'string'].includes(typeof target) || !/^[1-9]\d{0,9}$/.test(String(target)) || BigInt(target) > 0xffffffffn ||
        !['number', 'string'].includes(typeof id) || !/^-?[1-9]\d{0,9}$/.test(String(id)) || Number(id) < -0x80000000 || Number(id) > 0x7fffffff) fail('INVALID_PARAMS', 'Expected an exact target and current-account short message ID');
    if (EXTENSION_REQUIREMENTS[action].some(flag => state.capabilities?.[flag] !== true)) fail('UNSUPPORTED', 'QQ lacks source-message reading or confirmed delivery');
    const record = await service.record(state, Number(id), undefined, { refresh: true });
    locator(record);
    // Validate the complete source before downloading any media or sending.
    // Replies, forwards, files and cards need their own destination contexts.
    if (!Array.isArray(record.elements) || !record.elements.length || record.elements.length > 1000 || record.elements.some(element => ![1, 2, 4, 5, 6].includes(element?.elementType))) fail('UNSUPPORTED', 'Single forwarding currently supports text, mentions, faces, images, voice and video');
    const converted = await service.convert(state, record, Number(id), { mode: 'strict' });
    if (converted?._freshwater?.content_status === 'partial') throw annotate(Object.assign(new Error('A partial message cannot be forwarded as complete original content'), { code: 'UNSUPPORTED' }), { reason: 'partial_source_not_sendable', phase: 'prepare' });
    if (!Array.isArray(converted?.message) || !converted.message.length) fail('INVALID_RESPONSE', 'The refreshed source has no complete supported content');
    const content = converted.message.map(segment => {
        if (!segment?.data || !['text', 'at', 'face', 'image', 'record', 'video'].includes(segment.type)) fail('UNSUPPORTED', 'The source contains an unsupported forward segment');
        if (['image', 'record', 'video'].includes(segment.type)) {
            if (typeof segment.data.file !== 'string') fail('INVALID_RESPONSE', 'The source media has no account resource');
            return { type: segment.type, data: { file: segment.data.file,
                ...(segment.type === 'image' && segment.data.sub_type !== undefined ? { sub_type: segment.data.sub_type } : {}),
                ...(segment.type === 'image' && segment.data.summary !== undefined ? { summary: segment.data.summary } : {}) } };
        }
        return { type: segment.type, data: { ...segment.data } };
    });
    await service.assertSession(state);
    // SnowLuma single forwarding also re-sends the restored content as self.
    // Use the existing exact native send/confirmation/store path and its ID.
    return service.send(state, { [key]: Number(target), message: content }, group ? 'send_group_msg' : 'send_private_msg');
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runSingleForward };
