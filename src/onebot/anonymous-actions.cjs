'use strict';

const p = require('../qq/anonymous-protocol.cjs');
const { uint } = require('../qq/admin-oidb.cjs');
const ACTION_REQUIREMENTS = Object.freeze({ set_group_anonymous: 'groupAnonymous', set_group_anonymous_ban: 'groupAnonymousBan' });
const ACTIONS = new Set(Object.keys(ACTION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function anonymousFlag(params) {
    let flag;
    if (params.anonymous !== undefined && params.anonymous !== null) {
        p.fields(params.anonymous, ['id', 'name', 'flag']);
        flag = params.anonymous.flag;
        const parsed = p.flag(flag);
        if (params.anonymous.name !== undefined && params.anonymous.name !== parsed.name) fail('INVALID_PARAMS', 'Anonymous object name does not match its opaque flag');
        if (params.anonymous.id !== undefined) uint(params.anonymous.id, 'anonymous event ID', 0xffffffffffffffffn);
    }
    if (params.anonymous_flag !== undefined) {
        p.flag(params.anonymous_flag);
        if (flag !== undefined && flag !== params.anonymous_flag) fail('INVALID_PARAMS', 'Anonymous flags do not match');
        flag = params.anonymous_flag;
    }
    p.flag(flag); return flag;
}
async function runAnonymous(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown anonymous group action');
    const setting = action === 'set_group_anonymous';
    p.fields(params, ['self_id', 'group_id', ...(setting ? ['enable'] : ['anonymous', 'anonymous_flag', 'duration'])]);
    if (params.self_id !== undefined && p.group(params.self_id) !== String(state.self.uin)) fail('INVALID_PARAMS', 'Anonymous action belongs to another account');
    if (state.capabilities?.[ACTION_REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'This QQ session lacks the required anonymous transport');
    const groupId = p.group(params.group_id), operation = setting ? 'group.anonymous' : 'group.anonymousBan';
    const request = { operation, groupId, ...(setting ? { enable: params.enable === undefined ? true : params.enable } : { flag: anonymousFlag(params), duration: p.duration(params.duration) }) };
    if (setting) p.prepare(operation, { groupId, enable: request.enable });
    const response = await service.sessionCall(state, 'anonymousAction', request); await service.assertSession(state);
    const result = response?.result;
    if (response?.operation !== operation || response.uin !== String(state.self.uin) || !result || typeof result !== 'object' || Array.isArray(result) ||
        result.groupId !== groupId || result.confirmed !== true || result.confirmation !== 'server_ack' ||
        (setting ? result.enable !== request.enable : result.duration !== request.duration) ||
        Object.keys(result).length !== 4) fail('INVALID_RESPONSE', 'QQ supplied no matching anonymous operation acknowledgement');
    return null;
}
module.exports = { ACTIONS, ACTION_REQUIREMENTS, runAnonymous, anonymousFlag };
