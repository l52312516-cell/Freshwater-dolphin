'use strict';

const EXTENSION_REQUIREMENTS = Object.freeze({ get_rkey: 'downloadRkey', get_rkey_server: 'downloadRkey' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function project(result, now) {
    if (!result || !Array.isArray(result.rkeys) || !result.rkeys.length || result.rkeys.length > 128)
        fail('INVALID_RESPONSE', 'QQ returned no bounded download keys');
    const seen = new Set();
    return result.rkeys.map(entry => {
        if (!entry || !Number.isInteger(entry.type) || entry.type < 1 || entry.type > 0xffffffff || seen.has(entry.type) ||
            typeof entry.rkey !== 'string' || !entry.rkey.length || Buffer.byteLength(entry.rkey) > 8192 || /[\x00-\x20\x7f]/.test(entry.rkey) ||
            !Number.isSafeInteger(entry.rkeyTtlSec) || entry.rkeyTtlSec <= 0 ||
            !Number.isSafeInteger(entry.rkeyCreateTime) || entry.rkeyCreateTime <= 0 || entry.rkeyCreateTime > now + 300 ||
            !Number.isSafeInteger(entry.rkeyCreateTime + entry.rkeyTtlSec) || entry.rkeyCreateTime + entry.rkeyTtlSec <= now)
            fail('INVALID_RESPONSE', 'QQ returned an invalid, duplicate or expired download key');
        seen.add(entry.type);
        return { rkey: entry.rkey, type: entry.type, ttl: entry.rkeyTtlSec, create_time: entry.rkeyCreateTime };
    });
}
async function runRkeyActions(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown download-key action');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'self_id'))
        fail('INVALID_PARAMS', 'Download-key actions take no business parameters');
    if (params.self_id !== undefined && String(params.self_id) !== String(state.self.uin)) fail('INVALID_PARAMS', 'self_id belongs to another account');
    if (state.capabilities?.downloadRkey !== true) fail('UNSUPPORTED', 'This QQ session cannot query download keys');
    const result = await service.sessionCall(state, 'nativeRkey', { expectedUin: String(state.self.uin), via: 'native',
        timeoutMs: Math.min(10000, service.remaining()) });
    const keys = project(result, Math.floor(Date.now() / 1000));
    await service.assertSession(state);
    if (action === 'get_rkey') return keys;
    const relevant = keys.filter(entry => [10, 20].includes(entry.type));
    if (!relevant.length) fail('INVALID_RESPONSE', 'QQ returned no private or group download key');
    return { expired_time: Math.min(...relevant.map(entry => entry.create_time + entry.ttl)), name: 'Freshwater-dolphin',
        ...Object.fromEntries(relevant.map(entry => [entry.type === 10 ? 'private_rkey' : 'group_rkey', entry.rkey])) };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runRkeyActions };
