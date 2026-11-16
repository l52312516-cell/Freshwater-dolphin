'use strict';

// Only server-generated recommend-contact Ark queries. Command numbers and
// fields follow contact-ark.ts; callers cannot supply commands or raw bodies.
const p = require('./proto.cjs');
const U32 = 0xffffffffn;
const MAX_ARK_BYTES = 262144, MAX_RESPONSE_BYTES = MAX_ARK_BYTES + 4096, MAX_JSON_BYTES = 1024 * 1024;
const OPERATIONS = new Set(['group.ark', 'peer.ark']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function input(value, allowed) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected Ark query parameters');
}
function id(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || BigInt(value) > U32) fail('INVALID_PARAMS', 'Ark target must be an exact positive uint32');
    return String(value);
}
function phone(value = '') {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid bounded Ark phone number');
    return value;
}
const string = (field, value) => p.bytesField(field, Buffer.from(value, 'utf8'));
function prepare(operation, value = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed Ark query');
    input(value, operation === 'group.ark' ? ['groupId'] : ['userId', 'phoneNumber']);
    let command, sub, mode, data, body;
    if (operation === 'group.ark') {
        command = 0x8b7; sub = 5; mode = 1; data = { groupId: id(value.groupId) };
        body = Buffer.concat([p.varintField(1, 1), p.varintField(2, data.groupId), p.varintField(5, 1)]);
    } else {
        command = 0x12b6; sub = 0; mode = 0; data = { userId: id(value.userId), phoneNumber: phone(value.phoneNumber) };
        const jumpUrl = 'mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=' + data.userId;
        body = Buffer.concat([p.varintField(1, data.userId), string(2, data.phoneNumber || '-'), string(3, jumpUrl)]);
    }
    return { operation, command, sub, mode, data, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: Buffer.concat([p.varintField(1, command), p.varintField(2, sub), p.varintField(3, 0), p.bytesField(4, body), p.varintField(12, mode)]) };
}
function one(fields, field, wire, required = false) {
    const entries = fields.get(field);
    if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed fixed Ark response field');
    return entries[0].value;
}
function status(fields, field) {
    const value = one(fields, field, 0) ?? 0n;
    if (value > U32) fail('INVALID_RESPONSE', 'Ark response business status exceeds uint32');
    if (value !== 0n) fail('KERNEL_ERROR', 'QQ rejected the Ark query (code=' + value + '); it was not retried');
}
function validateArk(value) {
    if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > MAX_ARK_BYTES ||
        Buffer.from(value).toString('utf8') !== value || Buffer.byteLength(JSON.stringify({ arkMsg: value })) > MAX_JSON_BYTES) {
        fail('INVALID_RESPONSE', 'QQ returned no bounded Ark JSON string');
    }
    let root;
    try { root = JSON.parse(value); } catch { fail('INVALID_RESPONSE', 'QQ returned malformed Ark JSON'); }
    if (!plain(root) || typeof root.app !== 'string' || !root.app.length || Buffer.byteLength(root.app) > 256) fail('INVALID_RESPONSE', 'QQ returned no Ark application object');
    let nodes = 0;
    const visit = (item, depth) => {
        if (++nodes > 20000 || depth > 32) fail('INVALID_RESPONSE', 'QQ returned excessively complex Ark JSON');
        if (typeof item === 'number' && !Number.isFinite(item)) fail('INVALID_RESPONSE', 'QQ returned a non-finite Ark JSON number');
        if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
    };
    visit(root, 0);
    // Preserve the exact service string; this is never a locally built card.
    return value;
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'No bounded fixed Ark response');
    const top = p.fields(bytes), mode = one(top, 12, 0);
    if (one(top, 1, 0, true) !== BigInt(prepared.command) || (one(top, 2, 0) ?? 0n) !== BigInt(prepared.sub) ||
        mode !== undefined && mode !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'QQ returned another Ark operation');
    status(top, 3);
    const raw = one(top, 4, 2, true), body = p.fields(raw);
    if (prepared.operation === 'group.ark') status(body, 1);
    const payload = one(body, prepared.operation === 'group.ark' ? 5 : 1, 2, true);
    if (!payload.length || payload.length > MAX_ARK_BYTES) fail('INVALID_RESPONSE', 'QQ omitted the bounded Ark payload');
    let arkMsg;
    try { arkMsg = new TextDecoder('utf-8', { fatal: true }).decode(payload); }
    catch { fail('INVALID_RESPONSE', 'QQ returned invalid Ark UTF-8'); }
    return { operation: prepared.operation, ...prepared.data, arkMsg: validateArk(arkMsg) };
}

module.exports = { OPERATIONS, prepare, decode, validateArk, id, phone, MAX_ARK_BYTES, MAX_RESPONSE_BYTES, MAX_JSON_BYTES };
