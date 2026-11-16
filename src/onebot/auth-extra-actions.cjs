'use strict';

const { uint } = require('../qq/admin-oidb.cjs');
const { fields } = require('../qq/db-key-protocol.cjs');
const { domain, credential } = require('../qq/auth-extra.cjs');
const OPERATIONS = Object.freeze({ get_clientkey: 'auth.clientKey', get_cookies: 'auth.cookies', get_csrf_token: 'auth.csrf', get_credentials: 'auth.credentials', request_decrypt_key: 'auth.decryptKey' });
const EXTENSION_REQUIREMENTS = Object.freeze({ get_clientkey: 'authClientKey', get_cookies: 'authCookies', get_csrf_token: 'authCsrf', get_credentials: 'authCredentials', request_decrypt_key: 'databaseKey' });
const ACTIONS = new Set(Object.keys(OPERATIONS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runAuthExtra(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown authentication action');
    fields(params, ['self_id', ...(['get_cookies', 'get_credentials'].includes(action) ? ['domain'] : action === 'request_decrypt_key' ? ['db_path'] : [])]);
    if (params.self_id !== undefined && uint(params.self_id, 'self_id', 0xffffffffn, 1n) !== String(state.self.uin)) fail('INVALID_PARAMS', 'Authentication action belongs to another account');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) fail('UNSUPPORTED', 'This account lacks the required authentication capability');
    const operation = OPERATIONS[action], request = { operation };
    if (['get_cookies', 'get_credentials'].includes(action)) request.domain = domain(params.domain);
    if (action === 'request_decrypt_key') { if (typeof params.db_path !== 'string' || !params.db_path.length) fail('INVALID_PARAMS', 'Database path is required'); request.dbPath = params.db_path; }
    const response = await service.sessionCall(state, 'authQuery', request); await service.assertSession(state);
    if (response?.operation !== operation || response.uin !== String(state.self.uin) || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) fail('INVALID_RESPONSE', 'Authentication response belongs to another account or operation');
    const result = response.result, keys = operation === 'auth.clientKey' ? ['clientKey', 'expireTime', 'keyIndex'] : operation === 'auth.credentials' ? ['cookies', 'token', 'csrf_token'] : operation === 'auth.cookies' ? ['cookies'] : operation === 'auth.csrf' ? ['token'] : ['db_key'];
    if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) fail('INVALID_RESPONSE', 'Authentication response omitted its exact result');
    if (['auth.cookies', 'auth.credentials'].includes(operation) && (typeof result.cookies !== 'string' || !result.cookies || Buffer.byteLength(result.cookies) > 65536 || /[\r\n\0]/.test(result.cookies))) fail('INVALID_RESPONSE', 'Invalid authentication cookie response');
    if (['auth.csrf', 'auth.credentials'].includes(operation) && (!Number.isInteger(result.token) || result.token < 0 || result.token > 0x7fffffff || operation === 'auth.credentials' && result.csrf_token !== result.token)) fail('INVALID_RESPONSE', 'Invalid authentication token response');
    if (operation === 'auth.clientKey') {
        if (!credential(result.clientKey)) fail('INVALID_RESPONSE', 'Invalid client ticket response');
        try { uint(result.expireTime, 'ticket expiry', 0xffffffffffffffffn, 1n); uint(result.keyIndex, 'ticket index'); }
        catch { fail('INVALID_RESPONSE', 'Invalid client ticket metadata'); }
    }
    if (operation === 'auth.decryptKey' && !credential(result.db_key)) fail('INVALID_RESPONSE', 'Invalid database key response');
    return Object.fromEntries(keys.map(key => [key, result[key]]));
}
module.exports = { ACTIONS, OPERATIONS, EXTENSION_REQUIREMENTS, runAuthExtra };
