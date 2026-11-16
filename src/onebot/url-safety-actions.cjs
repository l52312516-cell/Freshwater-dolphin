'use strict';

const protocol = require('../qq/url-safety-protocol.cjs');
const ACTIONS = new Set(['check_url_safely']);
const EXTENSION_REQUIREMENTS = Object.freeze({ check_url_safely: 'urlSafety' });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runUrlSafety(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown URL safety action');
    protocol.fields(params, ['url', 'self_id']); const target = protocol.url(params.url);
    if (params.self_id !== undefined && (!['number', 'string'].includes(typeof params.self_id) || String(params.self_id) !== state.self?.uin || !/^[1-9]\d{0,9}$/.test(String(params.self_id)))) fail('INVALID_PARAMS', 'URL safety self_id belongs to another account');
    if (state.capabilities?.urlSafety !== true) fail('UNSUPPORTED', 'This QQ session lacks real URL reputation lookup');
    const result = await service.sessionCall(state, 'urlSafetyQuery', { url: target });
    if (!result || result.operation !== 'url.check' || result.uin !== state.self.uin || result.url !== target || ![1, 2, 3].includes(result.level)) fail('INVALID_RESPONSE', 'QQ returned an unrelated URL safety result');
    await service.assertSession(state); return { level: result.level };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runUrlSafety };
