'use strict';

const protocol = require('../qq/collection-create.cjs');
const ACTIONS = new Set(['create_collection']);
const EXTENSION_REQUIREMENTS = Object.freeze({ create_collection: 'collectionCreate' });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runCollectionCreate(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown collection creation action');
    const value = protocol.input(params);
    if (params.self_id !== undefined && (!['number', 'string'].includes(typeof params.self_id) ||
        !/^[1-9]\d{0,9}$/.test(String(params.self_id)) || String(params.self_id) !== state.self?.uin)) fail('INVALID_PARAMS', 'Collection author must be the current QQ account');
    if (state.capabilities?.collectionCreate !== true) fail('UNSUPPORTED', 'This QQ session lacks native collection creation');
    const result = await service.sessionCall(state, 'collectionCreate', value);
    if (!result || result.uin !== state.self.uin || result.digest !== protocol.digest(value) || result.confirmation !== 'native_business_ack') fail('INVALID_RESPONSE', 'QQ confirmed a different collection creation scope');
    const ack = protocol.acknowledgement({ result: result.result, errMsg: result.errMsg });
    await service.assertSession(state);
    return ack;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runCollectionCreate };
