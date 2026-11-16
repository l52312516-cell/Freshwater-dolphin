'use strict';

const { prepare } = require('../qq/raw-packet.cjs');
const ACTIONS = new Set(['send_packet', '.send_packet', 'nc_get_packet_status']);
const EXTENSION_REQUIREMENTS = Object.freeze({ send_packet: 'rawPacket', '.send_packet': 'rawPacket', nc_get_packet_status: 'packetStatus' });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function runRawPacket(service, state, action, params) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown packet action');
    if (action === 'nc_get_packet_status') {
        if (Object.keys(params).some(key => key !== 'self_id')) fail('INVALID_PARAMS', 'Packet statistics takes no parameters');
        return service.sessionCall(state, 'packetStatus', { expectedUin: String(state.self.uin) });
    }
    if (Object.keys(params).some(key => !['cmd', 'data', 'rsp', 'self_id'].includes(key))) fail('INVALID_PARAMS', 'Unexpected packet parameters');
    const request = prepare(params);
    if (state.capabilities?.rawPacket !== true) fail('UNSUPPORTED', 'Raw SSO transport is unavailable on this QQ version');
    const result = await service.sessionCall(state, 'rawPacket', { cmd: request.command, data: request.body.toString('hex'), rsp: request.rsp, timeoutMs: service.remaining(), expectedUin: String(state.self.uin) });
    if (!request.rsp) {
        if (result?.submitted !== true) fail('INVALID_RESPONSE', 'QQ did not confirm packet submission');
        return null;
    }
    if (typeof result?.responseHex !== 'string' || result.responseHex.length > 524288 || result.responseHex.length % 2 || !/^[0-9a-f]*$/.test(result.responseHex)) fail('INVALID_RESPONSE', 'QQ returned an invalid bounded packet response');
    return result.responseHex;
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, runRawPacket };
