'use strict';

const MAX_BODY_BYTES = 65536;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function prepare(params) {
    if (typeof params.cmd !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,126}$/.test(params.cmd)) fail('INVALID_PARAMS', 'Invalid SSO command name');
    const data = params.data === undefined ? '' : params.data, rsp = params.rsp === undefined ? true : params.rsp;
    if (typeof data !== 'string' || data.length > MAX_BODY_BYTES * 2 || data.length % 2 || !/^[0-9a-fA-F]*$/.test(data)) fail('INVALID_PARAMS', 'Packet data must be bounded even-length hexadecimal');
    if (typeof rsp !== 'boolean') fail('INVALID_PARAMS', 'Packet rsp must be boolean');
    return { command: params.cmd, body: Buffer.from(data, 'hex'), rsp };
}
module.exports = { prepare, MAX_BODY_BYTES };
