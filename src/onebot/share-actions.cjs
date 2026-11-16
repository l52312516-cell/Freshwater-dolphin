'use strict';

const protocol = require('../qq/share-oidb.cjs');
const { runInteraction } = require('./interactions.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({
    share_group_ex: 'groupArkShare', send_group_ark_share: 'groupArkShare',
    share_peer: 'arkShare', send_ark_share: 'arkShare',
    set_self_longnick: Object.freeze(['selfProfile', 'selfSignature'])
});
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
const READ_ONLY_ACTIONS = new Set(['share_group_ex', 'send_group_ark_share', 'share_peer', 'send_ark_share']);
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['self_id', ...allowed].includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected share action parameters');
}
async function runShareActions(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown share action');
    const groupOnly = ['share_group_ex', 'send_group_ark_share'].includes(action);
    fields(params, action === 'set_self_longnick' ? ['longNick', 'long_nick'] : groupOnly ? ['group_id'] : ['group_id', 'user_id', 'phone_number']);
    if (params.self_id !== undefined && protocol.id(params.self_id) !== String(state.self.uin)) throw problem('INVALID_PARAMS', 'self_id belongs to another account');
    if (action === 'set_self_longnick') {
        for (const key of ['longNick', 'long_nick']) if (params[key] !== undefined && typeof params[key] !== 'string') throw problem('INVALID_PARAMS', key + ' must be a string');
        const value = params.longNick !== undefined ? params.longNick : params.long_nick;
        if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) throw problem('INVALID_PARAMS', 'Invalid bounded longNick');
        await runInteraction(service, state, 'set_qq_profile', { personal_note: value });
        return {};
    }
    const groupId = params.group_id === undefined ? null : protocol.id(params.group_id),
        userId = params.user_id === undefined ? null : protocol.id(params.user_id), phoneNumber = protocol.phone(params.phone_number);
    if (groupOnly && groupId === null || !groupOnly && groupId === null && userId === null) throw problem('INVALID_PARAMS', 'A group_id or user_id is required');
    // The source contract validates both optional IDs, then gives group_id
    // precedence. A send_* name here still only returns a server Ark payload.
    const flag = groupId !== null ? 'groupArkShare' : 'peerArkShare';
    if (state.capabilities?.[flag] !== true) throw problem('UNSUPPORTED', 'This QQ session does not provide the requested Ark query');
    const request = groupId !== null ? { operation: 'group.ark', groupId } : { operation: 'peer.ark', userId, phoneNumber };
    const result = await service.sessionCall(state, 'shareQuery', request);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(request).some(key => result[key] !== request[key])) throw problem('INVALID_RESPONSE', 'QQ returned another Ark target or operation');
    const arkMsg = protocol.validateArk(result.arkMsg);
    await service.assertSession(state);
    return groupOnly ? arkMsg : { arkMsg };
}

module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, READ_ONLY_ACTIONS, runShareActions };
