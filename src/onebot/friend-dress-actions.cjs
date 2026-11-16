'use strict';

const p = require('../qq/qzone-protocol.cjs');
const ACTIONS = new Set(['_get_friend_dress']);
const EXTENSION_REQUIREMENTS = Object.freeze({ _get_friend_dress: 'friendDress' });
async function runFriendDress(service, state, action, params) {
    if (!ACTIONS.has(action)) p.fail('UNSUPPORTED', 'Unknown friend dress action');
    if (state.capabilities?.friendDress !== true) p.fail('UNSUPPORTED', 'This QQ session lacks friend dress lookup');
    if (!p.object(params) || Object.keys(params).some(key => !['self_id', 'user_id'].includes(key)) || params.self_id !== undefined && p.uin(params.self_id) !== String(state.self.uin)) p.fail('INVALID_PARAMS', 'Unexpected friend dress action fields');
    const target = p.uin(params.user_id), response = await service.sessionCall(state, 'friendDressQuery', { targetUin: target });
    if (!p.object(response) || response.uin !== String(state.self.uin) || response.targetUin !== target || response.result?.target_uin !== target || typeof response.result.is_svip !== 'boolean' ||
        typeof response.result.avatar_url !== 'string' || !Array.isArray(response.result.items) || response.result.items.length > 256) p.fail('INVALID_RESPONSE', 'Friend dress response lacks account, target or catalog evidence');
    return response.result;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, REQUIREMENTS: EXTENSION_REQUIREMENTS, runFriendDress };
