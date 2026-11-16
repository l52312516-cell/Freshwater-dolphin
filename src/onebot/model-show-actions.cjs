'use strict';
const p = require('../qq/qzone-protocol.cjs');
const ACTIONS = new Set(['_get_model_show', '_set_model_show']);
const EXTENSION_REQUIREMENTS = Object.freeze({ _get_model_show: 'modelShowRead', _set_model_show: 'modelShowSet' });
async function runModelShow(service, state, action, params) {
    if (!ACTIONS.has(action)) p.fail('UNSUPPORTED', 'Unknown model display action');
    const mutation = action === '_set_model_show';
    if (!p.object(params) || Object.keys(params).some(key => !['self_id', 'model', ...(mutation ? ['model_show'] : [])].includes(key))) p.fail('INVALID_PARAMS', 'Unexpected model display parameters');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) p.fail('UNSUPPORTED', 'This QQ session lacks model display authentication');
    const model = p.string(params.model ?? '', 512), modelShow = mutation ? p.string(params.model_show, 512) : undefined;
    const result = await service.sessionCall(state, 'modelShow', { operation: mutation ? 'set' : 'get', model, ...(mutation ? { modelShow } : {}) });
    if (result?.uin !== String(state.self.uin) || result.operation !== (mutation ? 'set' : 'get')) p.fail('INVALID_RESPONSE', 'Model display result belongs to another account or operation');
    if (mutation) {
        if (result.result?.confirmed !== true || result.result.confirmation !== 'server_ack') p.fail('INVALID_RESPONSE', 'QQ supplied no model display change acknowledgement');
        return null;
    }
    if (!Array.isArray(result.result) || result.result.some(item => typeof item?.variants?.model_show !== 'string' || typeof item.variants.need_pay !== 'boolean')) p.fail('INVALID_RESPONSE', 'QQ supplied no model display variants');
    return result.result;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runModelShow };
