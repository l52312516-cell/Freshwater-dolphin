'use strict';

// Two fixed read-only queries. Neither command names nor protobuf fields are
// accepted from callers. Native request correlation remains in msf-native.
const p = require('./proto.cjs');
const U32 = 0xffffffffn, MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const n = p.varintField, b = p.bytesField, join = Buffer.concat;
const OPERATIONS = new Set(['user.status', 'group.todos']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function integer(value, positive = false) {
    p.varint(value);
    const result = BigInt(value);
    if (result > U32 || positive && result === 0n) fail('INVALID_PARAMS', 'Invalid fixed query identifier');
    return result;
}
function prepare(operation, data = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed query');
    const key = operation === 'user.status' ? 'uin' : 'groupId';
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(name => name !== key)) fail('INVALID_PARAMS', 'Unexpected fixed query fields');
    const identifier = integer(data[key], true), command = operation === 'user.status' ? 0xfe1 : 0x9474;
    const sub = operation === 'user.status' ? 2 : 0, mode = operation === 'user.status' ? 1 : 0;
    const body = operation === 'user.status' ? join([n(1, identifier), b(3, n(1, 27372))]) : join([n(1, identifier), n(2, 1)]);
    return { operation, command, sub, mode, data: { [key]: String(identifier) },
        name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: join([n(1, command), n(2, sub), n(3, 0), b(4, body), n(12, mode)]) };
}
function fields(bytes) {
    const result = p.fields(bytes);
    if (result.size > 256 || [...result.values()].reduce((sum, items) => sum + items.length, 0) > 8192) fail('INVALID_RESPONSE', 'Fixed query response has too many fields');
    return result;
}
function one(values, field, wire, required = false) {
    const entries = values.get(field);
    if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Invalid or duplicate fixed query field');
    return entries[0].value;
}
function uint(values, field, maximum = U32, required = false) {
    const value = one(values, field, 0, required);
    if (value !== undefined && value > maximum) fail('INVALID_RESPONSE', 'Fixed query integer exceeds its range');
    return value;
}
function text(values, field, required = false, maximum = 16384) {
    const bytes = one(values, field, 2, required);
    if (bytes === undefined) return undefined;
    if (bytes.length > maximum) fail('INVALID_RESPONSE', 'Fixed query text exceeds its limit');
    try {
        const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (value.includes('\0')) throw new Error();
        return value;
    } catch { fail('INVALID_RESPONSE', 'Fixed query text is not valid UTF-8'); }
}
function nested(values, field, required = false) { const value = one(values, field, 2, required); return value === undefined ? undefined : fields(value); }
function list(values, field, maximum) {
    const entries = values.get(field) || [];
    if (entries.length > maximum || entries.some(item => item.wire !== 2)) fail('INVALID_RESPONSE', 'Fixed query list exceeds its limit or has an invalid wire type');
    return entries.map(item => fields(item.value));
}
function status(body, request) {
    const data = nested(body, 1, true), identities = [uint(data, 1), uint(data, 3)].filter(value => value !== undefined);
    if (!identities.length || identities.some(value => value !== BigInt(request.uin))) fail('INVALID_RESPONSE', 'QQ status does not identify the requested account');
    const properties = list(nested(data, 2, true), 1, 128), matching = [];
    const keys = new Set();
    for (const property of properties) {
        const key = uint(property, 1, U32, true);
        if (keys.has(String(key))) fail('INVALID_RESPONSE', 'QQ repeated a status property');
        keys.add(String(key));
        if (key === 27372n) matching.push(uint(property, 2, 0xffffffffffffffffn, true));
    }
    if (matching.length !== 1) fail('INVALID_RESPONSE', 'QQ omitted the requested status property');
    const raw = matching[0];
    return { uin: request.uin, ...(raw <= 10n ? { status: Number(raw) * 10, extStatus: 0 } :
        { status: 10, extStatus: Number((raw & 0xff00n) + ((raw >> 16n) & 0xffn)) }) };
}
function todos(body, request) {
    const items = [], seen = new Set();
    for (const banner of list(body, 1, 1000)) {
        const disappeared = uint(banner, 4, 1n);
        if (disappeared === 1n) continue;
        const sourceId = text(banner, 3, true, 64), match = /^([1-9]\d{0,9})_(-?(?:0|[1-9]\d{0,9}))$/.exec(sourceId);
        if (!match || match[2] === '-0' || BigInt(match[1]) > U32 || BigInt(match[2]) < -0x80000000n || BigInt(match[2]) > U32 || seen.has(sourceId)) fail('INVALID_RESPONSE', 'QQ todo has an invalid or duplicate source message');
        seen.add(sourceId);
        const sequence = Number(match[1]), random = Number(match[2]), common = nested(banner, 20), legacy = nested(banner, 12);
        const ui = common && nested(common, 1), jump = common && nested(common, 2), jumpParam = jump && text(jump, 3, false, 2048);
        if (jumpParam !== undefined && jumpParam !== '') {
            let value;
            try { value = JSON.parse(jumpParam); } catch { fail('INVALID_RESPONSE', 'QQ todo has an invalid jump identity'); }
            if (!value || typeof value !== 'object' || Array.isArray(value) || value.seq !== sequence || value.random !== random) fail('INVALID_RESPONSE', 'QQ todo source and jump identities disagree');
        }
        const content = ui && text(ui, 3), fallback = legacy && text(legacy, 2);
        if (content === undefined && fallback === undefined) fail('INVALID_RESPONSE', 'QQ todo omitted its text');
        const item = { sourceId, sequence, random, text: content ?? fallback };
        if (common) for (const [field, key] of [[3, 'createdAt'], [4, 'updatedAt']]) {
            const timestamp = uint(common, field, MAX_SAFE);
            if (timestamp !== undefined) item[key] = Number(timestamp);
        }
        items.push(item);
    }
    const next = uint(body, 3, 0xffffffffffffffffn);
    return { groupId: request.groupId, todos: items, ...(next !== undefined ? { newSequence: String(next) } : {}) };
}
function decode(bytes, prepared) {
    if (!prepared || !OPERATIONS.has(prepared.operation) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) fail('INVALID_RESPONSE', 'No bounded fixed query response');
    const top = fields(bytes), mode = one(top, 12, 0);
    if (one(top, 1, 0, true) !== BigInt(prepared.command) || (one(top, 2, 0) ?? 0n) !== BigInt(prepared.sub) ||
        mode !== undefined && mode !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'Fixed query response belongs to another operation');
    if (one(top, 3, 0, true) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the fixed query');
    const body = fields(one(top, 4, 2, true));
    return prepared.operation === 'user.status' ? status(body, prepared.data) : todos(body, prepared.data);
}
module.exports = { OPERATIONS, prepare, decode };
