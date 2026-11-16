'use strict';

// Fixed official Weiyun collector operation 20000. Callers cannot choose a
// destination, operation number, ticket domain or raw protobuf body.
const p = require('./proto.cjs');
const ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const U64 = 0xffffffffffffffffn, U32 = 0xffffffffn;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024, MAX_JSON_BYTES = 1024 * 1024;
const MAGIC = Buffer.from([0x20, 0x13, 0x03, 0x29, 0x00, 0x01]);
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
function fail(code, text) { throw Object.assign(new Error(text), { code }); }
function credential(value) { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value); }
function unsigned(value, maximum = U64, positive = false) {
    if (!['number', 'string', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) > maximum || positive && BigInt(value) === 0n) fail('INVALID_PARAMS', 'Invalid fixed collector integer');
    return BigInt(value);
}
function encodeRequest({ uin, pskey, timeStamp = '0', count = 50, sequence = 1 }) {
    if (!credential(pskey)) fail('AUTH_FAILED', 'QQ supplied no bounded Weiyun ticket');
    const timestamp = unsigned(timeStamp), size = unsigned(count, 50n, true), seq = unsigned(sequence, U32, true);
    const head = Buffer.concat([n(1, unsigned(uin, U64, true)), n(2, seq), n(3, 1), n(4, 20000), n(5, 0x6105f5e164fn),
        n(6, 4), n(7, 27), s(11, pskey), n(14, 8), n(15, 9)]);
    const body = b(1, b(20000, Buffer.concat([n(4, timestamp === 0n ? U64 : timestamp), n(5, 2), n(7, size), n(8, 1)])));
    const prefix = Buffer.alloc(16);
    MAGIC.copy(prefix); prefix.writeUInt32BE(16 + head.length + body.length, 6); prefix.writeUInt32BE(body.length, 10);
    return Buffer.concat([prefix, head, body]);
}
function decodeResponse(bytes, { count = 50, timeStamp = '0', uin, sequence = 1 } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length <= 16 || bytes.length > MAX_RESPONSE_BYTES || !bytes.subarray(0, 6).equals(MAGIC) ||
        bytes.readUInt32BE(6) !== bytes.length || bytes.readUInt16BE(14) !== 0) fail('INVALID_RESPONSE', 'Collector returned an invalid envelope');
    const bodyLength = bytes.readUInt32BE(10), split = bytes.length - bodyLength;
    if (!bodyLength || split <= 16) fail('INVALID_RESPONSE', 'Collector returned an invalid body length');
    let nodes = 0, jsonBytes = 0;
    const spend = amount => { jsonBytes += amount; if (jsonBytes > MAX_JSON_BYTES) fail('INVALID_RESPONSE', 'Collector page exceeds its JSON byte budget'); };
    function fields(buffer) {
        const values = new Map(); let offset = 0;
        while (offset < buffer.length) {
            if (++nodes > 50000) fail('INVALID_RESPONSE', 'Collector response exceeds its field budget');
            const tag = p.readVarint(buffer, offset); offset = tag.offset;
            const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
            if (field < 1 || field > 0x1fffffff) fail('INVALID_RESPONSE', 'Collector returned an invalid field tag');
            let value;
            if (wire === 0) { const entry = p.readVarint(buffer, offset); value = entry.value; offset = entry.offset; }
            else if (wire === 2) {
                const length = p.readVarint(buffer, offset); offset = length.offset;
                if (length.value > BigInt(buffer.length - offset)) fail('INVALID_RESPONSE', 'Collector returned truncated bytes');
                value = buffer.subarray(offset, offset + Number(length.value)); offset += Number(length.value);
            } else if (wire === 1 || wire === 5) {
                const length = wire === 1 ? 8 : 4;
                if (buffer.length - offset < length) fail('INVALID_RESPONSE', 'Collector returned a truncated fixed value');
                value = buffer.subarray(offset, offset + length); offset += length;
            } else fail('INVALID_RESPONSE', 'Collector returned an unsupported wire type');
            const entries = values.get(field), entry = { wire, value };
            if (entries) entries.push(entry); else values.set(field, [entry]);
        }
        return values;
    }
    function one(map, field, wire) {
        const entries = map.get(field);
        if (!entries) return undefined;
        if (entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Collector returned an ambiguous field');
        return entries[0].value;
    }
    function number(map, field, maximum = U32) {
        const value = one(map, field, 0) ?? 0n;
        if (value > maximum) fail('INVALID_RESPONSE', 'Collector integer exceeds its field range');
        return Number(value);
    }
    function decimal(map, field) { return String(one(map, field, 0) ?? 0n); }
    function boolean(map, field) { return Boolean(number(map, field, 1n)); }
    function text(map, field, maximum = 65536) {
        const value = one(map, field, 2);
        if (value === undefined) { spend(2); return ''; }
        if (value.length > maximum) fail('INVALID_RESPONSE', 'Collector text exceeds its byte limit');
        let result;
        try { result = new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { fail('INVALID_RESPONSE', 'Collector returned invalid UTF-8'); }
        if (result.includes('\0')) fail('INVALID_RESPONSE', 'Collector returned invalid text');
        spend(Buffer.byteLength(JSON.stringify(result))); return result;
    }
    function raw(map, field) {
        const value = one(map, field, 2);
        if (!value) return '';
        if (value.length > 65536) fail('INVALID_RESPONSE', 'Collector bytes exceed their field limit');
        const result = value.toString('base64'); spend(result.length + 2); return result;
    }
    function nested(map, field, decode) { const value = one(map, field, 2); return value === undefined ? null : decode(fields(value)); }
    function repeated(map, field, decode, maximum = 1000) {
        const entries = map.get(field) || [];
        if (entries.length > maximum || entries.some(entry => entry.wire !== 2)) fail('INVALID_RESPONSE', 'Collector returned an oversized or malformed list');
        return entries.map(entry => decode(fields(entry.value)));
    }
    function author(map) { return { type: number(map, 1), numId: decimal(map, 2), strId: text(map, 3),
        groupId: decimal(map, 4), groupName: text(map, 5), uid: text(map, 6) }; }
    function picture(map) { return { url: text(map, 1), field2: raw(map, 2), field3: raw(map, 3), field4: text(map, 4), field5: text(map, 5),
        field6: number(map, 6), field7: number(map, 7), field8: number(map, 8), field9: number(map, 9), author: nested(map, 10, author), field11: text(map, 11) }; }
    function file(map) { return { field1: number(map, 1), field2: decimal(map, 2), field3: number(map, 3), field4: text(map, 4), field5: text(map, 5),
        field6: decimal(map, 6), field7: raw(map, 7), field8: raw(map, 8), field9: number(map, 9), field10: text(map, 10) }; }
    function double(map, field) {
        const value = one(map, field, 1), result = value === undefined ? 0 : value.readDoubleLE();
        if (!Number.isFinite(result)) fail('INVALID_RESPONSE', 'Collector returned a non-finite coordinate');
        return result;
    }
    function summary(map) {
        return {
            textSummary: nested(map, 1, value => ({ text: text(value, 1), truncated: boolean(value, 2) })),
            linkSummary: nested(map, 2, value => ({ url: text(value, 1), title: text(value, 2), publisher: text(value, 3), brief: text(value, 4),
                picList: repeated(value, 5, picture), contentType: number(value, 6), field7: text(value, 7) })),
            gallerySummary: nested(map, 3, value => ({ picList: repeated(value, 1, picture), field2: text(value, 2) })),
            audioSummary: nested(map, 4, value => ({ field1: number(value, 1), field2: text(value, 2), field3: text(value, 3) })),
            videoSummary: nested(map, 5, value => ({ field1: text(value, 1), field2: number(value, 2), field3: number(value, 3),
                field10: number(value, 10), field20: number(value, 20), picture: nested(value, 21, picture), field30: number(value, 30), file: nested(value, 31, file) })),
            fileSummary: nested(map, 6, value => ({ first: nested(value, 1, file), second: nested(value, 2, file) })),
            locationSummary: nested(map, 7, value => ({ name: text(value, 1), latitude: double(value, 2), longitude: double(value, 3),
                altitude: double(value, 4), field5: text(value, 5), field6: text(value, 6) })),
            richMediaSummary: nested(map, 8, value => ({ title: text(value, 1), subTitle: text(value, 2), brief: text(value, 3),
                picList: repeated(value, 4, picture), contentType: number(value, 5), originalUri: text(value, 6), publisher: text(value, 7), richMediaVersion: number(value, 8) }))
        };
    }
    function item(map) {
        const cid = text(map, 1, 256), actualAuthor = nested(map, 4, author), modified = one(map, 11, 0);
        if (!cid || !actualAuthor || modified === undefined || modified === 0n) fail('INVALID_RESPONSE', 'Collector omitted required item identity or timestamp');
        const result = { cid, type: number(map, 2), status: number(map, 3), author: actualAuthor, bid: number(map, 5), category: number(map, 8),
            createTime: decimal(map, 9), collectTime: decimal(map, 10), modifyTime: modified.toString(), sequence: decimal(map, 12),
            shareUrl: text(map, 18), customGroupId: number(map, 20), securityBeat: boolean(map, 21),
            summary: nested(map, 15, summary) || summary(new Map()) };
        spend(512); return result;
    }
    const head = fields(bytes.subarray(16, split)), status = one(head, 101, 0) ?? 0n;
    if (uin !== undefined && (one(head, 1, 0) !== unsigned(uin, U64, true) || one(head, 2, 0) !== unsigned(sequence, U32, true) ||
        one(head, 3, 0) !== 2n || one(head, 4, 0) !== 20000n)) fail('INVALID_RESPONSE', 'Collector response does not match the active account and request');
    if (status > U32 && status < U64 - 0x7fffffffn) fail('INVALID_RESPONSE', 'Collector returned an invalid business status');
    const retCode = Number(BigInt.asIntN(32, status));
    if (retCode !== 0) fail('KERNEL_ERROR', 'Collector rejected the collection query (retCode=' + retCode + '); it was not retried');
    // Do not forward service text: even successful headers can contain private details.
    const body = fields(bytes.subarray(split)), operation = nested(body, 2, value => value);
    if (!operation) fail('INVALID_RESPONSE', 'Collector omitted its operation response');
    const list = nested(operation, 20000, value => value);
    if (!list) fail('INVALID_RESPONSE', 'Collector omitted operation 20000');
    const items = repeated(list, 1, item, count), seen = new Set();
    // This field is uint32, not bool. The reference client treats every
    // nonzero value as terminal; real empty accounts return 215000 with a
    // successful, identity-matched header and totalCount=0. Missing/zero is
    // nonterminal, so it can never certify an empty inventory by itself.
    const more = number(list, 3) === 0;
    if (list.has(2)) number(list, 2); // Validate the optional uint32 total.
    let bottom = null;
    for (const entry of items) {
        if (seen.has(entry.cid)) fail('INVALID_RESPONSE', 'Collector repeated an item identity in one page');
        seen.add(entry.cid);
        const timestamp = BigInt(entry.modifyTime);
        if (bottom === null || timestamp < bottom) bottom = timestamp;
    }
    const initial = timeStamp === '0' ? U64 : unsigned(timeStamp);
    if (items.some(entry => BigInt(entry.modifyTime) > initial) || more && (bottom === null || bottom >= initial)) fail('INVALID_RESPONSE', 'Collector pagination did not advance');
    const result = { items, hasMore: more, bottomTimeStamp: String(bottom ?? 0n) };
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON_BYTES) fail('INVALID_RESPONSE', 'Collector page exceeds its JSON byte budget');
    return result;
}
module.exports = { ENDPOINT, MAX_RESPONSE_BYTES, MAX_JSON_BYTES, credential, encodeRequest, decodeResponse };
