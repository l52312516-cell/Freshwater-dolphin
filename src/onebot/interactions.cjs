'use strict';

const ACTIONS = new Set(['set_qq_profile', 'set_group_remark']);
const REQUIREMENTS = Object.freeze({ set_qq_profile: 'selfProfile', set_group_remark: 'groupRemark' });
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, maximum, empty, label) {
    if (typeof value !== 'string' || !empty && !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) {
        throw problem('INVALID_PARAMS', 'Invalid ' + label);
    }
    return value;
}
function group(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Invalid group_id');
    return String(value);
}
async function runInteraction(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown profile interaction');
    const allowed = action === 'set_qq_profile' ? ['nickname', 'personal_note', 'self_id'] : ['group_id', 'remark', 'self_id'];
    if (!object(params) || Object.keys(params).some(key => !allowed.includes(key))) throw problem('INVALID_PARAMS', 'Unexpected profile interaction parameters');
    if (params.self_id !== undefined && group(params.self_id) !== String(state.self?.uin)) {
        throw problem('INVALID_PARAMS', 'self_id belongs to another account');
    }
    let request;
    if (action === 'set_qq_profile') {
        request = { operation: 'profile.update' };
        if (Object.hasOwn(params, 'nickname')) request.nickname = text(params.nickname, 256, false, 'nickname');
        if (Object.hasOwn(params, 'personal_note')) request.personalNote = text(params.personal_note, 4096, true, 'personal_note');
        if (!Object.hasOwn(request, 'nickname') && !Object.hasOwn(request, 'personalNote')) throw problem('INVALID_PARAMS', 'At least one profile field is required');
        if (state.capabilities?.selfProfile !== true ||
            Object.hasOwn(request, 'nickname') && state.capabilities?.selfNickname !== true ||
            Object.hasOwn(request, 'personalNote') && state.capabilities?.selfSignature !== true) {
            throw problem('UNSUPPORTED', 'The QQ session cannot update and verify all requested profile fields');
        }
    } else {
        request = { operation: 'group.remark', groupId: group(params.group_id), remark: text(params.remark, 1024, true, 'remark') };
        if (state.capabilities?.groupRemark !== true) throw problem('UNSUPPORTED', 'The QQ session cannot update group remarks');
    }
    const result = await service.sessionCall(state, 'interaction', request);
    if (!object(result) || result.confirmed !== true || typeof result.changed !== 'boolean') {
        throw problem('INVALID_RESPONSE', 'QQ did not confirm the requested profile modification');
    }
    if (action === 'set_qq_profile') {
        const keys = ['nickname', 'personalNote'].filter(key => Object.hasOwn(request, key));
        if (result.uin !== String(state.self?.uin) || result.uid !== state.self?.uid || !object(result.previous) ||
            keys.some(key => result[key] !== request[key] || typeof result.previous[key] !== 'string')) {
            throw problem('INVALID_RESPONSE', 'QQ profile confirmation belongs to another identity or value');
        }
    } else if (result.groupId !== request.groupId || result.remark !== request.remark || typeof result.previous !== 'string') {
        throw problem('INVALID_RESPONSE', 'QQ group remark confirmation belongs to another target or value');
    }
    return null;
}

module.exports = { ACTIONS, REQUIREMENTS, runInteraction };
