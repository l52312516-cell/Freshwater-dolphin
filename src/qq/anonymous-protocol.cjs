'use strict';

const p = require('./proto.cjs');
const { uint, text } = require('./admin-oidb.cjs');
const { fields } = require('./db-key-protocol.cjs');
const OPERATIONS = new Set(['group.anonymous']);
const ENDPOINT = 'https://qqweb.qq.com/c/anonymoustalk/blacklist';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function group(value) { return uint(value, 'anonymous group ID', 0xffffffffn, 1n); }
function duration(value = 1800) { return Number(uint(value, 'anonymous ban duration', 2592000n, 1n)); }
function flag(value) {
    text(value, 'anonymous flag', 4096, false);
    const split = value.lastIndexOf('@'), name = value.slice(0, split), id = value.slice(split + 1);
    if (split < 1 || !name.trim() || /[\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > 256 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(id)) fail('INVALID_PARAMS', 'Anonymous flag must contain its real name and canonical base64 anonymous ID');
    const bytes = Buffer.from(id, 'base64');
    if (!bytes.length || bytes.length > 2048 || bytes.toString('base64') !== id) fail('INVALID_PARAMS', 'Anonymous flag has no bounded canonical anonymous ID');
    return { name, id };
}
function csrf(value) {
    if (typeof value !== 'string' || !value.length || value.length > 4096 || !/^[\x21-\x3a\x3c-\x7e]+$/.test(value)) fail('AUTH_FAILED', 'Anonymous ban requires an authenticated QQ skey');
    let hash = 5381; for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 33) + value.charCodeAt(i)) | 0;
    return String(hash & 0x7fffffff);
}
function prepare(operation, request) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed anonymous group protocol');
    fields(request, ['groupId', 'enable']);
    const groupId = group(request.groupId), enable = request.enable;
    if (typeof enable !== 'boolean') fail('INVALID_PARAMS', 'Anonymous group setting requires an explicit boolean');
    // Both OICQ and MiraiGo use this legacy service and a five-byte body.
    // Its optional Android version string is deliberately omitted on desktop.
    const body = Buffer.alloc(5); body.writeUInt32BE(Number(groupId)); body[4] = enable ? 1 : 0;
    return { operation, command: 0x568, sub: 22, data: { groupId, enable }, name: 'OidbSvc.0x568_22',
        body: Buffer.concat([p.varintField(1, 0x568), p.varintField(2, 22), p.varintField(3, 0), p.bytesField(4, body)]) };
}
function one(map, field, wire, required = false) {
    const values = map.get(field);
    if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'QQ returned an ambiguous anonymous setting acknowledgement');
    return values[0].value;
}
function decode(bytes, prepared) {
    if (!prepared || prepared.operation !== 'group.anonymous' || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16384) fail('INVALID_RESPONSE', 'QQ returned no bounded anonymous setting acknowledgement');
    const top = p.fields(bytes);
    if ([...top.keys()].some(key => ![1, 2, 3, 4, 5, 6].includes(key)) || one(top, 1, 0, true) !== 0x568n || one(top, 2, 0, true) !== 22n) fail('INVALID_RESPONSE', 'Anonymous setting acknowledgement belongs to another operation');
    const status = one(top, 3, 0, true), body = one(top, 4, 2);
    if (status !== 0n) fail(status > 0xffffffffn ? 'INVALID_RESPONSE' : 'KERNEL_ERROR', 'QQ did not confirm the anonymous group setting; it was not retried');
    for (const key of [5, 6]) { const raw = one(top, key, 2); if (raw && raw.length > 4096) fail('INVALID_RESPONSE', 'Anonymous setting acknowledgement text exceeds its bound'); }
    if (body?.length) fail('INVALID_RESPONSE', 'QQ returned an unrecognized anonymous setting business acknowledgement');
    return { operation: prepared.operation, ...prepared.data, confirmed: true, confirmation: 'server_ack' };
}
function banRequest(request, skey) {
    fields(request, ['groupId', 'flag', 'duration']);
    const groupId = group(request.groupId), seconds = duration(request.duration), anonymous = flag(request.flag);
    return { groupId, duration: seconds, url: ENDPOINT, body: new URLSearchParams({
        anony_id: anonymous.id, group_code: groupId, seconds: String(seconds), anony_nick: anonymous.name, bkn: csrf(skey)
    }).toString() };
}
function banAck(source) {
    let value;
    // The literal parser rejects duplicate keys, expressions and unsafe numbers.
    // JSON.parse additionally requires the endpoint's actual JSON format.
    try { require('./qzone-protocol.cjs').parse(source); value = JSON.parse(source); }
    catch { fail('INVALID_RESPONSE', 'QQ returned no exact anonymous ban JSON acknowledgement'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.retcode) || !Number.isSafeInteger(value.cgicode)) fail('INVALID_RESPONSE', 'QQ omitted explicit anonymous ban business status');
    if (value.retcode !== 0 || value.cgicode !== 0) fail('KERNEL_ERROR', 'QQ rejected the anonymous ban; it was not retried');
    return { confirmed: true, confirmation: 'server_ack' };
}
module.exports = { OPERATIONS, ENDPOINT, prepare, decode, fields, group, duration, flag, csrf, banRequest, banAck };
