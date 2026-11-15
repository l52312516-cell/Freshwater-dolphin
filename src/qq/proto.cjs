'use strict';

// Minimal protobuf wire primitives shared by the native MSF command modules
// (group-file-url.cjs and future OIDB commands). rkey.cjs keeps its own local
// copy of these helpers; this module is the foundation for new commands so the
// verified rkey path is not disturbed during expansion.

function problem(code, message) { return Object.assign(new Error(message), { code }); }

function varint(value) {
    const out = [];
    let rest = BigInt(value);
    do {
        const byte = Number(rest & 0x7fn);
        rest >>= 7n;
        out.push(rest > 0n ? byte | 0x80 : byte);
    } while (rest > 0n);
    return Buffer.from(out);
}
function varintField(field, value) { return Buffer.concat([varint(field << 3), varint(value)]); }
function bytesField(field, payload) { return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]); }
function messageField(field, parts) { return bytesField(field, Buffer.concat(parts)); }
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
    let shift = 0n, value = 0n, byte;
    do {
        if (offset >= buffer.length) throw problem('INVALID_RESPONSE', 'Truncated protobuf response');
        byte = buffer[offset++];
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if (shift > 63n) throw problem('INVALID_RESPONSE', 'Oversized protobuf varint');
    } while (byte & 0x80);
    return { value, offset };
}
function fields(buffer) {
    const out = new Map();
    let i = 0;
    while (i < buffer.length) {
        const tag = readVarint(buffer, i); i = tag.offset;
        const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
        if (field === 0) throw problem('INVALID_RESPONSE', 'Invalid protobuf field number');
        let entry;
        if (wire === 0) { const v = readVarint(buffer, i); i = v.offset; entry = { wire, value: v.value }; }
        else if (wire === 2) {
            const len = readVarint(buffer, i); i = len.offset;
            const end = i + Number(len.value);
            if (end > buffer.length) throw problem('INVALID_RESPONSE', 'Truncated protobuf bytes');
            entry = { wire, value: buffer.subarray(i, end) }; i = end;
        } else if (wire === 5) { entry = { wire, value: buffer.subarray(i, i + 4) }; i += 4; }
        else if (wire === 1) { entry = { wire, value: buffer.subarray(i, i + 8) }; i += 8; }
        else throw problem('INVALID_RESPONSE', `Unsupported protobuf wire ${wire}`);
        out.set(field, [...(out.get(field) || []), entry]);
    }
    return out;
}
const one = (map, field) => (map.get(field) || [])[0];
function unsigned(entry, maximum) {
    if (!entry || entry.wire !== 0) return null;
    return entry.value <= maximum ? entry.value : null;
}
function text(entry, maxBytes) {
    if (!entry || entry.wire !== 2 || entry.value.length > maxBytes) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(entry.value); }
    catch { return null; }
}

module.exports = { problem, varint, varintField, bytesField, messageField, latin1, toBuffer, readVarint, fields, one, unsigned, text };
