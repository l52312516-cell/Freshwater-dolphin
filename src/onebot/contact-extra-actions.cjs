'use strict';

const REQUIREMENTS = Object.freeze({ translate_en2zh: 'translateEn2zh', get_unidirectional_friend_list: 'unidirectionalFriends',
    set_input_status: 'inputStatus', _mark_all_as_read: 'markAllRead', get_doubt_friends_add_request: 'doubtFriendRequests',
    set_doubt_friends_add_request: 'doubtFriendApproval', get_group_ignore_add_request: 'filteredGroupRequests', get_group_ignored_notifies: 'filteredGroupRequests' });
const ACTIONS = new Set(Object.keys(REQUIREMENTS));
const WRITE_ACTIONS = new Set(['set_input_status', '_mark_all_as_read', 'set_doubt_friends_add_request']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function uint(value, maximum = 0xffffffffn, positive = false) {
    return ['number', 'string'].includes(typeof value) && (typeof value !== 'number' || Number.isSafeInteger(value)) &&
        /^(0|[1-9]\d{0,19})$/.test(String(value)) && BigInt(value) <= maximum && (!positive || BigInt(value) > 0n);
}
function text(value, maximum = 16384) { return typeof value === 'string' && Buffer.byteLength(value) <= maximum && !value.includes('\0') && Buffer.from(value).toString('utf8') === value; }
const uid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value);
const flag = value => typeof value === 'string' && /^fwd_doubt_[a-f0-9]{48}$/.test(value);
function parameters(action, params) {
    const allowed = action === 'translate_en2zh' ? ['words'] : action === 'set_input_status' ? ['user_id', 'event_type'] :
        action === 'get_doubt_friends_add_request' ? ['count'] : action === 'set_doubt_friends_add_request' ? ['flag', 'approve'] : [];
    if (!object(params) || Object.keys(params).some(key => !['self_id', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected contact action parameters');
    if (action === 'translate_en2zh') {
        if (!Array.isArray(params.words) || !params.words.length || params.words.length > 50 || params.words.some(word => !text(word, 4096) || !word.length) ||
            params.words.reduce((sum, word) => sum + Buffer.byteLength(word), 0) > 16384) fail('INVALID_PARAMS', 'Translation requires 1..50 bounded strings and at most 16 KiB');
        return { operation: 'translate', words: [...params.words] };
    }
    if (action === 'set_input_status') {
        const eventType = params.event_type === undefined ? 0 : params.event_type;
        if (!uint(params.user_id, 0xffffffffn, true) || !uint(eventType)) fail('INVALID_PARAMS', 'Invalid input-status target or event type');
        return { operation: 'input.status', uin: String(params.user_id), eventType: Number(eventType) };
    }
    if (action === 'get_doubt_friends_add_request') {
        const count = params.count === undefined ? 50 : params.count;
        if (!uint(count, 100n, true)) fail('INVALID_PARAMS', 'Doubt request count must be 1..100');
        return { operation: 'doubt.list', count: Number(count) };
    }
    if (action === 'set_doubt_friends_add_request') {
        if (!flag(params.flag) || params.approve !== undefined && typeof params.approve !== 'boolean') fail('INVALID_PARAMS', 'Expected an observed filtered-request flag and optional boolean approve');
        return { operation: 'doubt.handle', flag: params.flag, approve: params.approve ?? true };
    }
    return { operation: action === '_mark_all_as_read' ? 'read.all' : action === 'get_unidirectional_friend_list' ? 'unidirectional' : 'group.filtered' };
}
function optionalText(source, names, target) {
    for (const [from, to = from] of names) if (source[from] !== undefined) {
        if (!text(source[from])) fail('INVALID_RESPONSE', 'Invalid contact result text'); target[to] = source[from];
    }
}
async function runContactExtraActions(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown contact extension action');
    const input = parameters(action, params);
    if (state.capabilities?.[REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'This session lacks the contact extension capability');
    const response = await service.sessionCall(state, 'contactExtra', input);
    if (!object(response) || response.operation !== input.operation || response.selfUin !== String(state.self.uin) || !object(response.result)) fail('INVALID_RESPONSE', 'QQ returned an unrelated contact result');
    const result = response.result;
    let output;
    if (WRITE_ACTIONS.has(action)) {
        if (result.confirmed !== true || !['server_ack', 'kernel_ack'].includes(result.confirmation)) fail('INVALID_RESPONSE', 'QQ did not confirm the contact operation');
        if (input.operation === 'input.status' && (result.uin !== input.uin || result.eventType !== input.eventType || !uid(result.targetUid))) fail('INVALID_RESPONSE', 'QQ confirmed another input-status target');
        if (input.operation === 'doubt.handle' && (result.flag !== input.flag || result.approve !== input.approve)) fail('INVALID_RESPONSE', 'QQ confirmed another filtered friend request');
        return action === 'set_input_status' ? {} : null;
    }
    if (input.operation === 'translate') {
        if (!Array.isArray(result.words) || result.words.length !== input.words.length || result.words.some(word => !text(word)) ||
            !Array.isArray(result.sourceWords) || result.sourceWords.length !== input.words.length || result.sourceWords.some((word, index) => word !== input.words[index])) fail('INVALID_RESPONSE', 'QQ translation does not match its input');
        output = { words: [...result.words] };
    } else {
        const maximum = input.operation === 'unidirectional' ? 99 : input.operation === 'doubt.list' ? input.count : 1000;
        if (!Array.isArray(result.items) || result.items.length > maximum) fail('INVALID_RESPONSE', 'QQ returned no bounded contact list');
        const seen = new Set();
        if (input.operation === 'unidirectional') {
            if (result.limit !== 99 || result.complete !== false) fail('INVALID_RESPONSE', 'QQ omitted its one-way friend screen scope');
            output = result.items.map(item => {
                if (!object(item) || typeof item.uin !== 'string' || !uint(item.uin, 0xffffffffn, true) || seen.has(item.uin)) fail('INVALID_RESPONSE', 'Invalid one-way friend identity'); seen.add(item.uin);
                const row = { uin: Number(item.uin) };
                if (item.uid !== undefined) { if (!uid(item.uid)) fail('INVALID_RESPONSE', 'Invalid one-way friend UID'); row.uid = item.uid; }
                if (item.age !== undefined) { if (!Number.isInteger(item.age) || item.age < 0 || item.age > 150) fail('INVALID_RESPONSE', 'Invalid one-way friend age'); row.age = item.age; }
                optionalText(item, [['nick_name'], ['source']], row); return row;
            });
        } else if (input.operation === 'doubt.list') {
            if (result.limit !== input.count) fail('INVALID_RESPONSE', 'QQ returned another filtered friend screen');
            output = result.items.map(item => {
                if (!object(item) || !uid(item.uid) || typeof item.uin !== 'string' || !uint(item.uin, 0xffffffffn, true) ||
                    typeof item.reqTime !== 'string' || !uint(item.reqTime, 0xffffffffffffffffn) || item.flag !== null && !flag(item.flag)) fail('INVALID_RESPONSE', 'Invalid filtered friend request identity');
                const identity = item.uid + ':' + item.reqTime;
                if (seen.has(identity)) fail('INVALID_RESPONSE', 'QQ repeated a filtered friend request'); seen.add(identity);
                const row = { uid: item.uid, user_id: Number(item.uin), flag: item.flag, reqTime: item.reqTime, type: 'doubt' };
                optionalText(item, [['nick'], ['source'], ['reason'], ['msg']], row);
                if (item.groupCode !== undefined) { if (!uint(item.groupCode, 0xffffffffffffffffn)) fail('INVALID_RESPONSE', 'Invalid filtered friend source group'); row.group_code = item.groupCode; }
                for (const name of ['age', 'sex', 'commonFriendCount']) if (item[name] !== undefined) {
                    if (!Number.isInteger(item[name]) || !uint(item[name])) fail('INVALID_RESPONSE', 'Invalid filtered friend numeric metadata'); row[name] = item[name];
                }
                return row;
            });
        } else {
            if (result.filtered !== true || result.complete !== true) fail('INVALID_RESPONSE', 'QQ did not confirm a complete filtered group inbox');
            output = result.items.map(item => {
                if (!object(item) || ![1, 2].includes(item.eventType) || !Number.isInteger(item.state) || item.state < 0 || item.state > 4 ||
                    typeof item.groupId !== 'string' || !uint(item.groupId, 0xffffffffn, true) || typeof item.sequence !== 'string' || !uint(item.sequence, 0xffffffffffffffffn, true)) fail('INVALID_RESPONSE', 'Invalid filtered group request');
                const identity = item.groupId + ':' + item.sequence;
                if (seen.has(identity)) fail('INVALID_RESPONSE', 'QQ repeated a filtered group request'); seen.add(identity);
                const row = { request_id: item.sequence, group_id: Number(item.groupId), checked: item.state !== 1, event_type: item.eventType };
                optionalText(item, [['groupName', 'group_name'], ['comment', 'message']], row);
                for (const [key, accountKey, nameKey] of [['target', 'requester_uin', 'requester_nick'], ['invitor', 'invitor_uin', 'invitor_nick'], ['operator', 'actor', 'actor_nick']]) if (item[key] !== undefined) {
                    const who = item[key]; if (!object(who)) fail('INVALID_RESPONSE', 'Invalid filtered group participant');
                    if (who.uin !== undefined) { if (typeof who.uin !== 'string' || !uint(who.uin, 0xffffffffn, true)) fail('INVALID_RESPONSE', 'Invalid filtered group participant account'); row[accountKey] = Number(who.uin); }
                    if (who.uid !== undefined && !uid(who.uid)) fail('INVALID_RESPONSE', 'Invalid filtered group participant UID');
                    optionalText(who, [['name', nameKey]], row);
                }
                return row;
            }).filter(item => action === 'get_group_ignored_notifies' || item.event_type === 1);
        }
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) fail('INVALID_RESPONSE', 'Contact action result exceeds 1 MiB');
    return output;
}
module.exports = { ACTIONS, REQUIREMENTS, WRITE_ACTIONS, runContactExtraActions, parameters };
