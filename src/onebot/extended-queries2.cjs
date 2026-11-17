'use strict';
const { isPartial } = require('./message-compat.cjs');

const REQUIREMENTS = Object.freeze({ nc_get_user_status: 'userStatus', get_group_todo_list: 'groupTodoList', get_group_signed_list: 'groupSignedList', get_online_clients: 'onlineClients' });
const ACTIONS = new Set(Object.keys(REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function uint(value, positive = false, maximum = 0xffffffff) {
    return ['string', 'number'].includes(typeof value) && /^(0|[1-9]\d{0,15})$/.test(String(value)) &&
        Number.isSafeInteger(Number(value)) && Number(value) <= maximum && (!positive || Number(value) > 0);
}
function text(value, maximum) { return typeof value === 'string' && Buffer.byteLength(value) <= maximum && !value.includes('\0') && Buffer.from(value).toString('utf8') === value; }
function mapping(service, state, groupId, todo) {
    const entry = service.store.find(String(state.self.uin), { peer: { chatType: 2, peerUid: groupId }, seq: String(todo.sequence) });
    if (!entry) return null;
    for (const key of ['msgRandom', 'msg_random']) if (entry.record?.[key] !== undefined) {
        const value = entry.record[key];
        if (!['string', 'number'].includes(typeof value) || !/^-?(0|[1-9]\d{0,9})$/.test(String(value)) ||
            !Number.isSafeInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0xffffffff ||
            BigInt.asUintN(32, BigInt(value)) !== BigInt.asUintN(32, BigInt(todo.random))) return null;
    }
    if (!Number.isInteger(entry.id) || entry.id < 1 || entry.id > 0x7fffffff || entry.locator?.peer?.chatType !== 2 ||
        entry.locator.peer.peerUid !== groupId || entry.locator.seq !== String(todo.sequence) || !entry.locator.nativeId) fail('INVALID_RESPONSE', 'Todo cache lookup returned an unrelated message');
    return entry;
}
async function runExtendedQueries2(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown fixed query action');
    if (action === 'get_online_clients') {
        if (!object(params) || Object.keys(params).some(name => !['self_id', 'no_cache'].includes(name)) || params.no_cache !== undefined && typeof params.no_cache !== 'boolean') fail('INVALID_PARAMS', 'Expected only optional boolean no_cache for online clients');
        if (params.no_cache === true) fail('UNSUPPORTED', 'QQ online clients cannot force a network refresh');
        if (state.capabilities?.onlineClients !== true) fail('UNSUPPORTED', 'The current QQ session lacks online-device snapshots');
        const result = await service.sessionCall(state, 'extendedQuery2', { operation: 'account.onlineClients', noCache: false });
        if (!object(result) || result.selfUin !== String(state.self.uin) || result.source !== 'kernel_snapshot' || !Array.isArray(result.clients) || result.clients.length > 32) fail('INVALID_RESPONSE', 'QQ returned no current account online-device snapshot');
        const seen = new Set();
        return { clients: result.clients.map(item => {
            if (!object(item) || !Number.isInteger(item.instanceId) || !uint(item.instanceId) || !Number.isInteger(item.clientType) || !uint(item.clientType, true) ||
                !text(item.devUid, 128) || !item.devUid || seen.has(item.devUid) || !['电脑', '手机', 'Pad', '未知设备'].includes(item.deviceKind)) fail('INVALID_RESPONSE', 'QQ returned an invalid online-device snapshot entry');
            seen.add(item.devUid);
            // The target kernel exposes neither a real app ID nor a device
            // name. Preserve its observed fields rather than inventing them.
            return { instance_id: item.instanceId, client_type: item.clientType, device_uid: item.devUid, device_kind: item.deviceKind };
        }) };
    }
    const key = action === 'nc_get_user_status' ? 'user_id' : 'group_id';
    if (!object(params) || Object.keys(params).some(name => ![key, 'self_id'].includes(name)) || !uint(params[key], true)) fail('INVALID_PARAMS', 'Expected only an exact ' + key + ' for this fixed query');
    if (state.capabilities?.[REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'The current QQ session lacks this fixed query capability');
    const identifier = String(params[key]);
    const operation = action === 'nc_get_user_status' ? 'user.status' : action === 'get_group_todo_list' ? 'group.todos' : 'group.signedList';
    const result = await service.sessionCall(state, 'extendedQuery2', { operation, [key === 'user_id' ? 'uin' : 'groupId']: identifier });
    if (!object(result) || result[key === 'user_id' ? 'uin' : 'groupId'] !== identifier) fail('INVALID_RESPONSE', 'QQ returned an unrelated fixed query result');
    if (action === 'nc_get_user_status') {
        if (!uint(result.status) || ![0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(result.status) || !Number.isInteger(result.extStatus) || !uint(result.extStatus, false, 65535) ||
            result.status !== 10 && result.extStatus !== 0) fail('INVALID_RESPONSE', 'QQ returned an invalid user status');
        return { status: result.status, ext_status: result.extStatus };
    }
    if (action === 'get_group_signed_list') {
        if (result.complete !== true || !/^\d{8}$/.test(result.dayYmd) || !Array.isArray(result.members) || result.members.length > 10000) fail('INVALID_RESPONSE', 'QQ returned no complete bounded sign-in list');
        const accounts = new Set(), ranks = new Set();
        return result.members.map(item => {
            if (!object(item) || typeof item.uin !== 'string' || !uint(item.uin, true) || !text(item.nickname, 1024) || !Number.isSafeInteger(item.time) || !uint(item.time, false, Number.MAX_SAFE_INTEGER) ||
                !Number.isInteger(item.rank) || !uint(item.rank, true, result.members.length) || accounts.has(item.uin) || ranks.has(item.rank)) fail('INVALID_RESPONSE', 'QQ returned an invalid or duplicate sign-in member');
            accounts.add(item.uin); ranks.add(item.rank);
            return { user_id: Number(item.uin), nick: item.nickname, time: item.time, rank: item.rank };
        });
    }
    if (!Array.isArray(result.todos) || result.todos.length > 1000) fail('INVALID_RESPONSE', 'QQ returned no bounded todo list');
    const identities = new Set();
    return result.todos.map(item => {
        if (!object(item) || !Number.isInteger(item.sequence) || !uint(item.sequence, true) || !Number.isSafeInteger(item.random) || item.random < -0x80000000 || item.random > 0xffffffff ||
            item.sourceId !== item.sequence + '_' + item.random || !text(item.text, 16384) || identities.has(item.sourceId) ||
            ['createdAt', 'updatedAt'].some(key => item[key] !== undefined && (!Number.isSafeInteger(item[key]) || !uint(item[key], false, Number.MAX_SAFE_INTEGER)))) fail('INVALID_RESPONSE', 'QQ returned an invalid or duplicate todo identity');
        identities.add(item.sourceId);
        const entry = mapping(service, state, identifier, item);
        return { message_id: entry?.id ?? null, message_seq: item.sequence, message_random: item.random,
            message: Array.isArray(entry?.event?.message) ? entry.event.message : null, text: item.text,
            ...(isPartial(entry?.event) ? { _freshwater: entry.event._freshwater } : {}),
            ...(item.createdAt !== undefined ? { create_time: item.createdAt } : {}), ...(item.updatedAt !== undefined ? { update_time: item.updatedAt } : {}) };
    });
}
module.exports = { ACTIONS, REQUIREMENTS, EXTENSION_REQUIREMENTS: REQUIREMENTS, runExtendedQueries2 };
