'use strict';

const p = require('./proto.cjs');
const OPERATIONS = new Set(['db.key']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key =>
        typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected fixed authentication fields');
}
function salt(value) {
    if (typeof value !== 'string' || !/^[0-9a-fA-F]{128}$/.test(value)) fail('INVALID_PARAMS', 'Database salt must be exactly 128 hexadecimal characters');
    return value.toLowerCase();
}
function one(values, field, wire, required = false) {
    const rows = values.get(field);
    if (!rows) { if (required) fail('INVALID_RESPONSE', 'Database key response omitted a required field'); return undefined; }
    if (rows.length !== 1 || rows[0].wire !== wire) fail('INVALID_RESPONSE', 'Database key response has an ambiguous field');
    return rows[0].value;
}
function prepare(operation, request) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed database key operation');
    fields(request, ['salt']);
    const value = salt(request.salt), body = p.messageField(2, [p.bytesField(1, Buffer.from(value))]);
    return { operation, command: 0xcde, sub: 2, mode: 0, name: 'OidbSvcTrpcTcp.0xcde_2', data: { salt: value },
        body: Buffer.concat([p.varintField(1, 0xcde), p.varintField(2, 2), p.varintField(3, 0), p.bytesField(4, body), p.varintField(12, 0)]) };
}
function decode(bytes, prepared) {
    if (!prepared || prepared.operation !== 'db.key' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16384) fail('INVALID_RESPONSE', 'No bounded database key response');
    const top = p.fields(bytes), command = one(top, 1, 0, true), sub = one(top, 2, 0, true), mode = one(top, 12, 0);
    if (command !== 0xcden || sub !== 2n || mode !== undefined && mode !== 0n) fail('INVALID_RESPONSE', 'Database key response belongs to another fixed operation');
    const result = one(top, 3, 0);
    if (result !== undefined && (result > 0xffffffffn || result !== 0n)) fail(result > 0xffffffffn ? 'INVALID_RESPONSE' : 'KERNEL_ERROR', 'QQ did not confirm the database key request');
    const body = p.fields(one(top, 4, 2, true)), info = p.fields(one(body, 2, 2, true)), raw = one(info, 1, 2, true);
    if (!raw.length || raw.length > 4096) fail('INVALID_RESPONSE', 'QQ returned no bounded database key');
    let key; try { key = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('INVALID_RESPONSE', 'QQ returned an invalid database key encoding'); }
    if (/[\u0000-\u0020\u007f]/.test(key)) fail('INVALID_RESPONSE', 'QQ returned an invalid database key encoding');
    return { key };
}
module.exports = { OPERATIONS, prepare, decode, salt, fields };
