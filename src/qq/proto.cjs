'use strict';

// Minimal protobuf wire primitives shared by the native MSF command modules
// (group-file-url.cjs and future OIDB commands). rkey.cjs keeps its own local
// copy of these helpers; this module is the foundation for new commands so the
// verified rkey path is not disturbed during expansion.

function problem(code, message) { return Object.assign(new Error(message), { code }); }
const U64_MAX = 0xffffffffffffffffn;
const MAX_FIELD = 0x1fffffff;

function uint64(value) {
    let number;
    if (typeof value === 'bigint') number = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) number = BigInt(value);
    else if (typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value)) number = BigInt(value);
    else throw problem('INVALID_PARAMS', 'Protobuf value must be an exact unsigned integer');
    if (number < 0n || number > U64_MAX) throw problem('INVALID_PARAMS', 'Protobuf unsigned integer is out of range');
    return number;
}
function tag(field, wire) {
    if (!Number.isSafeInteger(field) || field < 1 || field > MAX_FIELD) throw problem('INVALID_PARAMS', 'Invalid protobuf field number');
    return varint(BigInt(field) * 8n + BigInt(wire));
}

function varint(value) {
    const out = [];
    let rest = uint64(value);
    do {
        const byte = Number(rest & 0x7fn);
        rest >>= 7n;
        out.push(rest > 0n ? byte | 0x80 : byte);
    } while (rest > 0n);
    return Buffer.from(out);
}
function varintField(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
function bytesField(field, payload) {
    if (!Buffer.isBuffer(payload)) throw problem('INVALID_PARAMS', 'Protobuf bytes must be a Buffer');
    return Buffer.concat([tag(field, 2), varint(payload.length), payload]);
}
function messageField(field, parts) {
    if (!Array.isArray(parts) || parts.some(part => !Buffer.isBuffer(part))) throw problem('INVALID_PARAMS', 'Protobuf message parts must be Buffers');
    return bytesField(field, Buffer.concat(parts));
}
function latin1(buffer) {
    let text = '';
    for (const byte of buffer) text += String.fromCharCode(byte);
    return text;
}
function toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw;
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (typeof raw === 'string') return Buffer.from(raw, 'latin1');
    return null;
}

function readVarint(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) {
        throw problem('INVALID_RESPONSE', 'Invalid protobuf input or offset');
    }
    let value = 0n;
    for (let count = 0; count < 10; count++) {
        if (offset >= buffer.length) throw problem('INVALID_RESPONSE', 'Truncated protobuf response');
        const byte = buffer[offset++];
        if (count === 9 && byte > 1) throw problem('INVALID_RESPONSE', 'Oversized protobuf varint');
        value |= BigInt(byte & 0x7f) << BigInt(count * 7);
        if (!(byte & 0x80)) return { value, offset };
    }
    throw problem('INVALID_RESPONSE', 'Oversized protobuf varint');
}
function fields(buffer) {
    if (!Buffer.isBuffer(buffer)) throw problem('INVALID_RESPONSE', 'Protobuf response must be a Buffer');
    const out = new Map();
    let i = 0;
    while (i < buffer.length) {
        const tag = readVarint(buffer, i); i = tag.offset;
        const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
        if (field < 1 || field > MAX_FIELD) throw problem('INVALID_RESPONSE', 'Invalid protobuf field number');
        let entry;
        if (wire === 0) { const v = readVarint(buffer, i); i = v.offset; entry = { wire, value: v.value }; }
        else if (wire === 2) {
            const len = readVarint(buffer, i); i = len.offset;
            // Compare before converting to Number; a malicious uint64 length must
            // never round, wrap, or move the cursor beyond this actual Buffer.
            if (len.value > BigInt(buffer.length - i)) throw problem('INVALID_RESPONSE', 'Truncated protobuf bytes');
            const end = i + Number(len.value);
            entry = { wire, value: buffer.subarray(i, end) }; i = end;
        } else if (wire === 5 || wire === 1) {
            const width = wire === 5 ? 4 : 8;
            if (buffer.length - i < width) throw problem('INVALID_RESPONSE', 'Truncated protobuf fixed-width value');
            entry = { wire, value: buffer.subarray(i, i + width) }; i += width;
        }
        else throw problem('INVALID_RESPONSE', `Unsupported protobuf wire ${wire}`);
        const entries = out.get(field);
        if (entries) entries.push(entry); else out.set(field, [entry]);
    }
    return out;
}
const one = (map, field) => (map.get(field) || [])[0];
function unsigned(entry, maximum) {
    if (entry === undefined || entry === null) return null;
    // Missing protobuf zero values may default to zero. Present malformed or
    // out-of-range values must never use that same default in error fields.
    if (entry.wire !== 0 || typeof entry.value !== 'bigint' || entry.value < 0n ||
        typeof maximum !== 'bigint' || maximum < 0n || maximum > U64_MAX || entry.value > maximum) {
        throw problem('INVALID_RESPONSE', 'Invalid protobuf unsigned integer');
    }
    return entry.value;
}
function text(entry, maxBytes) {
    if (!entry || entry.wire !== 2 || !Buffer.isBuffer(entry.value) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || entry.value.length > maxBytes) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(entry.value); }
    catch { return null; }
}

module.exports = { problem, varint, varintField, bytesField, messageField, latin1, toBuffer, readVarint, fields, one, unsigned, text };
