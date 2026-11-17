'use strict';

const codec = require('./codec.cjs');
const { isPartial } = require('./message-compat.cjs');
const { annotate } = require('../diagnostics.cjs');

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_REQUEST' }); }

async function executeQuickOperation(event, operation, invoke) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !operation || typeof operation !== 'object' || Array.isArray(operation)) {
        throw invalid('Quick operation requires event and operation objects');
    }
    if (isPartial(event) && (operation.delete === true || operation.kick === true || operation.ban === true ||
        event.post_type === 'request' && operation.approve !== undefined)) {
        throw annotate(Object.assign(new Error('Quick operations require complete original message content'), { code: 'UNSUPPORTED' }),
            { reason: 'partial_quick_operation', phase: 'quick_operation' });
    }
    for (const key of ['auto_escape', 'at_sender', 'delete', 'kick', 'ban', 'approve', 'reject_add_request']) {
        if (operation[key] !== undefined && typeof operation[key] !== 'boolean') throw invalid(key + ' must be boolean');
    }
    if (operation.ban_duration !== undefined && (!Number.isInteger(operation.ban_duration) || operation.ban_duration < 0 || operation.ban_duration > 2592000)) throw invalid('Invalid ban_duration');
    const requests = [];
    if (event.post_type === 'message') {
        if (!['private', 'group'].includes(event.message_type)) throw invalid('Invalid message context');
        if (operation.reply !== undefined && operation.reply !== null && operation.reply !== '') {
            const message = codec.parse(operation.reply, operation.auto_escape === true);
            if (event.message_type === 'group' && operation.at_sender !== false && !event.anonymous) {
                message.unshift({ type: 'at', data: { qq: String(event.user_id) } });
            }
            requests.push({ action: event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg', params: {
                ...(event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id }), message } });
        }
        if (operation.delete === true) requests.push({ action: 'delete_msg', params: { message_id: event.message_id } });
        if (event.message_type === 'group') {
            if (operation.ban === true) requests.push({ action: event.anonymous ? 'set_group_anonymous_ban' : 'set_group_ban', params: {
                group_id: event.group_id, ...(event.anonymous ? { anonymous: event.anonymous } : { user_id: event.user_id }), duration: operation.ban_duration ?? 1800 } });
            if (operation.kick === true) {
                if (event.anonymous) throw invalid('Cannot kick an anonymous sender');
                requests.push({ action: 'set_group_kick', params: { group_id: event.group_id, user_id: event.user_id, reject_add_request: operation.reject_add_request === true } });
            }
        }
    } else if (event.post_type === 'request' && operation.approve !== undefined) {
        if (event.request_type === 'friend') requests.push({ action: 'set_friend_add_request', params: {
            flag: event.flag, approve: operation.approve, remark: operation.remark ?? '' } });
        else if (event.request_type === 'group') requests.push({ action: 'set_group_add_request', params: {
            flag: event.flag, sub_type: event.sub_type, approve: operation.approve, reason: operation.reason ?? '' } });
        else throw invalid('Invalid request context');
    }
    // Prepare and validate all quick-operation fields before starting effects.
    for (const request of requests) {
        const response = await invoke(request);
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
            throw Object.assign(new Error('Quick operation failed'), { code: 'ACTION_FAILED', response });
        }
    }
    return null;
}

module.exports = { executeQuickOperation };
