'use strict';

const ACTIONS = new Set(['set_friend_add_request', 'set_group_add_request', 'set_friend_remark',
    'get_friends_with_category', 'get_recent_contact', 'get_friend_requests', 'get_group_system_msg',
    'mark_private_msg_as_read', 'mark_group_msg_as_read', 'mark_msg_as_read']);
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function number(value, label) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return String(value);
}
function short(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Invalid message_id');
    return Number(value);
}
function details(source) {
    const result = {};
    for (const key of ['nickname', 'group_name', 'warning_tips']) {
        if (source[key] === undefined) continue;
        if (typeof source[key] !== 'string' || Buffer.byteLength(source[key]) > 16384 || source[key].includes('\0')) {
            throw problem('INVALID_RESPONSE', 'Invalid QQ request text metadata');
        }
        result[key] = source[key];
    }
    for (const key of ['source_id', 'common_friend_count']) {
        if (source[key] === undefined) continue;
        if (!Number.isSafeInteger(source[key]) || source[key] < 0) throw problem('INVALID_RESPONSE', 'Invalid QQ request numeric metadata');
        result[key] = source[key];
    }
    if (source.source_group_id !== undefined) {
        try { result.source_group_id = Number(number(source.source_group_id, 'source_group_id')); }
        catch { throw problem('INVALID_RESPONSE', 'Invalid QQ request source group identity'); }
    }
    if (source.doubt !== undefined) {
        if (typeof source.doubt !== 'boolean') throw problem('INVALID_RESPONSE', 'Invalid QQ request risk metadata');
        result.doubt = source.doubt;
    }
    return result;
}
async function resolve(service, state, params) {
    const result = await service.sessionCall(state, 'resolve', params);
    if (!result || !/^u_[A-Za-z0-9_-]+$/.test(result.uid || '') || (params.uid && result.uid !== params.uid) ||
        (params.uin && result.uin !== params.uin)) throw problem('INVALID_RESPONSE', 'QQ identity conversion is inconsistent');
    try { number(result.uin, 'resolved account'); }
    catch { throw problem('INVALID_RESPONSE', 'QQ returned an invalid resolved account'); }
    return result;
}
async function runSocial(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unsupported social action');
    if (action === 'get_friends_with_category') return service.sessionCall(state, 'socialQuery', { operation: 'categories' });
    if (action === 'get_recent_contact') {
        const count = params.count ?? 10;
        if (!Number.isInteger(count) || count < 1 || count > 100) throw problem('INVALID_PARAMS', 'count must be 1..100');
        const rows = await service.sessionCall(state, 'socialQuery', { operation: 'recent', count });
        if (!Array.isArray(rows)) throw problem('INVALID_RESPONSE', 'Invalid QQ recent contacts');
        return rows.map(row => {
            const known = service.store.find(state.self.uin, { peer: { chatType: row.chatType, peerUid: row.peerUid }, nativeId: row.nativeMsgId });
            const result = { ...row }; delete result.nativeMsgId;
            // Do not expose a lossy 64-bit native ID as a OneBot message ID.
            if (known) result.message_id = known.id;
            return result;
        });
    }
    if (['get_friend_requests', 'get_group_system_msg'].includes(action)) {
        const type = action === 'get_friend_requests' ? 'friend' : 'group';
        const rows = await service.sessionCall(state, 'socialQuery', { operation: type === 'friend' ? 'friendRequests' : 'groupRequests' });
        if (!Array.isArray(rows)) throw problem('INVALID_RESPONSE', 'Invalid QQ requests');
        const results = [];
        for (const row of rows) {
            const who = await resolve(service, state, { uid: row.uid });
            if (!/^fwd_req_[a-f0-9]{48}$/.test(row.flag || '') || typeof row.comment !== 'string' ||
                row.time !== null && (!Number.isSafeInteger(row.time) || row.time <= 0) ||
                type === 'group' && !['add', 'invite'].includes(row.subType)) throw problem('INVALID_RESPONSE', 'Invalid QQ request record');
            results.push({ flag: row.flag, user_id: Number(who.uin), comment: row.comment, time: row.time, ...details(row),
                ...(type === 'group' ? { group_id: Number(number(row.groupId, 'group_id')), sub_type: row.subType } : {}) });
        }
        if (type === 'friend') return results;
        return { invited_requests: results.filter(row => row.sub_type === 'invite'), join_requests: results.filter(row => row.sub_type === 'add') };
    }
    if (['set_friend_add_request', 'set_group_add_request'].includes(action)) {
        const approve = params.approve ?? true;
        if (typeof approve !== 'boolean' || typeof params.flag !== 'string' || !/^fwd_req_[a-f0-9]{48}$/.test(params.flag)) {
            throw problem('INVALID_PARAMS', 'Expected boolean approve and an opaque request flag');
        }
        const friend = action === 'set_friend_add_request';
        if (!friend && !['add', 'invite'].includes(params.sub_type)) throw problem('INVALID_PARAMS', 'Expected add or invite sub_type');
        const result = await service.sessionCall(state, 'socialAction', { operation: friend ? 'friendRequest' : 'groupRequest',
            flag: params.flag, approve, ...(friend ? (params.remark !== undefined ? { remark: params.remark } : {}) : { subType: params.sub_type, reason: params.reason ?? '' }) });
        if (result?.handled !== true) throw problem('INVALID_RESPONSE', 'QQ did not confirm request handling');
        return null;
    }
    if (action === 'set_friend_remark') {
        if (typeof params.remark !== 'string') throw problem('INVALID_PARAMS', 'remark must be a string');
        const result = await service.sessionCall(state, 'socialAction', { operation: 'remark', uin: number(params.user_id, 'user_id'), remark: params.remark });
        if (result?.updated !== true) throw problem('INVALID_RESPONSE', 'QQ did not confirm friend remark');
        return null;
    }
    const selectors = ['message_id', 'user_id', 'group_id'].filter(key => params[key] !== undefined);
    if (selectors.length !== 1 || action === 'mark_private_msg_as_read' && selectors[0] !== 'user_id' ||
        action === 'mark_group_msg_as_read' && selectors[0] !== 'group_id') throw problem('INVALID_PARAMS', 'Expected exactly one read conversation');
    let peer;
    if (action === 'mark_msg_as_read' && params.message_id !== undefined) {
        const entry = service.store.get(state.self.uin, short(params.message_id));
        if (!entry) throw problem('NOT_FOUND', 'Message is outside the known account history');
        peer = entry.locator.peer;
    } else if (action === 'mark_private_msg_as_read' || (action === 'mark_msg_as_read' && params.user_id !== undefined && params.group_id === undefined)) {
        const who = await resolve(service, state, { uin: number(params.user_id, 'user_id') });
        peer = { chatType: 1, peerUid: who.uid };
    } else if (action === 'mark_group_msg_as_read' || (action === 'mark_msg_as_read' && params.group_id !== undefined && params.user_id === undefined)) {
        peer = { chatType: 2, peerUid: number(params.group_id, 'group_id') };
    } else throw problem('INVALID_PARAMS', 'Expected exactly one read conversation');
    const result = await service.sessionCall(state, 'socialAction', { operation: 'read', peer });
    if (result?.read !== true) throw problem('INVALID_RESPONSE', 'QQ did not confirm marking the conversation read');
    return null;
}
async function convertSocialEvent(service, state, event) {
    if (event?.kind !== 'request' || !event.request || event.epoch !== state.epoch || String(event.selfUin) !== String(state.self.uin)) return null;
    const request = event.request;
    if (!['friend', 'group'].includes(request.type) || !/^fwd_req_[a-f0-9]{48}$/.test(request.flag || '') ||
        typeof request.comment !== 'string' || !Number.isSafeInteger(event.time) || event.time <= 0 || event.time * 1000 > Date.now() + 30000 ||
        (state.readyAt && event.time * 1000 + 1000 < state.readyAt)) throw problem('INVALID_RESPONSE', 'Invalid QQ request event');
    if (request.type === 'group' && !['add', 'invite'].includes(request.subType)) throw problem('INVALID_RESPONSE', 'Invalid group request sub_type');
    const who = await resolve(service, state, { uid: request.uid });
    await service.assertSession(state);
    return { time: event.time, self_id: Number(state.self.uin), post_type: 'request', request_type: request.type,
        user_id: Number(who.uin), comment: request.comment, flag: request.flag, ...details(request),
        ...(request.type === 'group' ? { group_id: Number(number(request.groupId, 'group_id')), sub_type: request.subType } : {}) };
}

module.exports = { ACTIONS, runSocial, convertSocialEvent };
