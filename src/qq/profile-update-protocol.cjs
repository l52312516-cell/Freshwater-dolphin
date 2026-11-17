'use strict';

// Fixed self-profile sex field only. 0x112a/2: uin=1,
// intProfiles=3 -> { fieldId=1:20009, value=2:0..2 }, reserved=0.
// An envelope ACK is not a confirmed profile change; the caller reads back
// the exact authenticated account before returning OneBot success.
const p = require('./proto.cjs');
const OPERATIONS = new Set(['profile.sex']);
const fail = (code, message) => { throw p.problem(code, message); };
function sex(value) {
    if (!Number.isInteger(value) || value < 0 || value > 2) fail('INVALID_PARAMS', 'Profile sex must be 0, 1 or 2');
    return value;
}
function prepare(operation, data) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed profile operation');
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => !['uin', 'sex'].includes(key)) ||
        !['string', 'number'].includes(typeof data.uin) || !/^[1-9]\d{0,9}$/.test(String(data.uin)) ||
        !Number.isSafeInteger(Number(data.uin)) || BigInt(data.uin) > 0xffffffffn) {
        fail('INVALID_PARAMS', 'Fixed profile update requires an exact account UIN');
    }
    const requested = { uin: String(data.uin), sex: sex(data.sex) };
    const body = Buffer.concat([p.varintField(1, requested.uin),
        p.messageField(3, [p.varintField(1, 20009), p.varintField(2, requested.sex)])]);
    return { operation, command: 0x112a, sub: 2, mode: 0, data: requested,
        name: 'OidbSvcTrpcTcp.0x112a_2', body: Buffer.concat([
            p.varintField(1, 0x112a), p.varintField(2, 2), p.varintField(3, 0),
            p.bytesField(4, body), p.varintField(12, 0)]) };
}
function one(map, tag, wire, required = false) {
    const values = map.get(tag) || [];
    if (values.length > 1 || values.some(item => item.wire !== wire) || required && values.length !== 1) {
        fail('INVALID_RESPONSE', 'Invalid fixed profile acknowledgement field');
    }
    return values[0]?.value;
}
function decode(bytes, prepared) {
    if (!prepared || prepared.operation !== 'profile.sex' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536) {
        fail('INVALID_RESPONSE', 'No bounded fixed profile acknowledgement');
    }
    const map = p.fields(bytes);
    if (one(map, 1, 0, true) !== 0x112an || one(map, 2, 0, true) !== 2n || (one(map, 12, 0) ?? 0n) !== 0n) {
        fail('INVALID_RESPONSE', 'Profile acknowledgement belongs to another operation');
    }
    if ((one(map, 3, 0) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the profile field update; no retry was attempted');
    const body = one(map, 4, 2);
    if (body?.length) fail('INVALID_RESPONSE', 'Unrecognized profile acknowledgement body');
    return { operation: 'profile.sex', ...prepared.data, confirmed: false, confirmation: 'requires_profile_readback' };
}
module.exports = { OPERATIONS, prepare, decode, sex };
