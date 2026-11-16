'use strict';

// Fixed contact/misc commands. Native request IDs provide correlation; no
// caller can select an SSO name, envelope mode, destination or raw body.
const p = require('./proto.cjs');
const U32 = 0xffffffffn, U64 = 0xffffffffffffffffn;
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const join = values => Buffer.concat(values);
const OPERATIONS = new Set(['translate', 'unidirectional', 'doubt.list', 'doubt.approve', 'doubt.reject', 'group.filtered', 'input.status']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function integer(value, maximum = U32, positive = false) {
    p.varint(value); const result = BigInt(value);
    if (result > maximum || positive && result === 0n) fail('INVALID_PARAMS', 'Contact integer is out of range');
    return result;
}
function text(value, maximum = 4096, empty = true) {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid contact text');
    return value;
}
function uid(value) { if (!/^u_[A-Za-z0-9_-]{1,126}$/.test(text(value, 128, false))) fail('INVALID_PARAMS', 'A real QQ UID is required'); return value; }
function words(value) {
    if (!Array.isArray(value) || !value.length || value.length > 50) fail('INVALID_PARAMS', 'Translation requires 1..50 strings');
    const result = value.map(word => text(word, 4096, false));
    if (result.reduce((sum, word) => sum + Buffer.byteLength(word), 0) > 16384) fail('INVALID_PARAMS', 'Translation input exceeds 16 KiB');
    return result;
}
function prepare(operation, data = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed contact operation');
    const keys = { translate: ['words'], unidirectional: ['selfUin'], 'doubt.list': ['count'],
        'doubt.approve': ['selfUid', 'targetUid'], 'doubt.reject': ['targetUid'], 'group.filtered': ['count', 'cursor'], 'input.status': ['targetUid', 'eventType'] }[operation];
    if (!object(data) || Object.keys(data).some(key => !keys.includes(key))) fail('INVALID_PARAMS', 'Unexpected fixed contact fields');
    let command, sub = 0, mode = 0, body, request;
    if (operation === 'unidirectional') {
        const selfUin = integer(data.selfUin, U32, true).toString();
        return { operation, data: { selfUin }, name: 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0',
            body: join([n(2, 0), s(3, JSON.stringify({ uint64_uin: selfUin, uint64_top: 0, uint32_req_num: 99, bytes_cookies: '' }))]) };
    }
    if (operation === 'translate') {
        request = { words: words(data.words) }; command = 0x990; sub = 2;
        body = join([b(2, join([s(1, 'en'), s(2, 'zh'), ...request.words.map(word => s(3, word))])), n(10, 1), n(12, 1)]);
    } else if (operation === 'doubt.list') {
        const count = integer(data.count, 100n, true); request = { count: Number(count) }; command = 0xd69; mode = 1;
        body = join([n(1, 1), b(2, n(1, count))]);
    } else if (operation === 'doubt.approve') {
        request = { selfUid: uid(data.selfUid), targetUid: uid(data.targetUid) }; command = 0xd72;
        // The two zero/default fields are explicitly optional on this command.
        body = join([s(1, request.selfUid), s(2, request.targetUid), n(3, 0), s(4, '')]);
    } else if (operation === 'doubt.reject') {
        request = { targetUid: uid(data.targetUid) }; command = 0xd69; mode = 1;
        body = join([n(1, 3), b(3, s(1, request.targetUid))]);
    } else if (operation === 'group.filtered') {
        const count = integer(data.count, 100n, true), cursor = integer(data.cursor, U64);
        request = { count: Number(count), cursor: String(cursor) }; command = 0x10c0; sub = 2; mode = 1;
        body = join([n(1, count), ...(cursor ? [n(2, cursor)] : [])]);
    } else {
        request = { targetUid: uid(data.targetUid), eventType: Number(integer(data.eventType)) }; command = 0xcd4; sub = 1;
        body = b(1, join([s(1, request.targetUid), ...(request.eventType ? [n(3, request.eventType)] : [])]));
    }
    return { operation, command, sub, mode, data: request, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: join([n(1, command), ...(sub ? [n(2, sub)] : []), b(4, body), ...(mode ? [n(12, mode)] : [])]) };
}
function one(values, field, wire, required = false) {
    const entries = values.get(field);
    if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Invalid fixed contact field');
    return entries[0].value;
}
function fields(bytes) {
    // Count before allocating field maps. A tiny-scalar flood must not expand
    // a bounded transport frame into hundreds of thousands of JS objects.
    let offset = 0, count = 0;
    while (offset < bytes.length) {
        if (++count > 20000) fail('INVALID_RESPONSE', 'Contact response exceeds its field budget');
        const tag = p.readVarint(bytes, offset); offset = tag.offset;
        const wire = Number(tag.value & 7n);
        if (wire === 0) offset = p.readVarint(bytes, offset).offset;
        else if (wire === 2) {
            const length = p.readVarint(bytes, offset); offset = length.offset;
            if (length.value > BigInt(bytes.length - offset)) fail('INVALID_RESPONSE', 'Truncated contact response');
            offset += Number(length.value);
        } else if (wire === 1 || wire === 5) {
            offset += wire === 1 ? 8 : 4;
            if (offset > bytes.length) fail('INVALID_RESPONSE', 'Truncated contact response');
        } else fail('INVALID_RESPONSE', 'Unsupported contact wire type');
    }
    return p.fields(bytes);
}
function uint(values, field, maximum = U32, required = false) {
    const value = one(values, field, 0, required);
    if (value !== undefined && value > maximum) fail('INVALID_RESPONSE', 'Contact response integer exceeds its range');
    return value;
}
function utf8(bytes, maximum) {
    if (bytes.length > maximum) fail('INVALID_RESPONSE', 'Contact response text exceeds its limit');
    try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (value.includes('\0')) throw new Error(); return value; }
    catch { fail('INVALID_RESPONSE', 'Contact response contains invalid UTF-8'); }
}
function string(values, field, maximum = 4096, required = false) {
    const bytes = one(values, field, 2, required); return bytes === undefined ? undefined : utf8(bytes, maximum);
}
function list(values, field, maximum, decode) {
    const entries = values.get(field) || [];
    if (entries.length > maximum || entries.some(entry => entry.wire !== 2)) fail('INVALID_RESPONSE', 'Invalid bounded contact result list');
    return entries.map(entry => decode(fields(entry.value)));
}
function nested(values, field, required = false) { const bytes = one(values, field, 2, required); return bytes === undefined ? undefined : fields(bytes); }
function account(values, field, optional = false) {
    const entries = values.get(field);
    if (!entries) { if (optional) return {}; fail('INVALID_RESPONSE', 'QQ omitted a contact identity'); }
    if (entries.length !== 1) fail('INVALID_RESPONSE', 'QQ repeated a contact identity');
    const entry = entries[0];
    if (optional && entry.wire === 0 && entry.value === 0n) return {};
    if (entry.wire === 0 && entry.value > 0n && entry.value <= U32) return { uin: String(entry.value) };
    if (entry.wire === 2) {
        const value = utf8(entry.value, 128);
        if (optional && value === '') return {};
        // Numeric strings are observed in some UIN-form group records.
        if (/^[1-9]\d{0,9}$/.test(value) && BigInt(value) <= U32) return { uin: value };
        if (/^u_[A-Za-z0-9_-]{1,126}$/.test(value)) return { uid: value };
    }
    fail('INVALID_RESPONSE', 'QQ returned no exact contact identity');
}
function unidirectional(top) {
    // This service has a custom response schema, not an OIDB envelope.
    // Only tags 3/4/5 are defined. Native callback IDs bind the fixed service;
    // unknown tags 1/2 must not be interpreted as command/subcommand echoes.
    if ((uint(top, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the one-way friend query');
    const raw = string(top, 4, 512 * 1024, true); let value;
    try { value = JSON.parse(raw); } catch { fail('INVALID_RESPONSE', 'Invalid one-way friend JSON'); }
    if (!object(value) || value.ActionStatus !== 'OK' || value.ErrorCode !== 0) fail('KERNEL_ERROR', 'QQ did not confirm the one-way friend query');
    if (!Array.isArray(value.rpt_block_list) || value.rpt_block_list.length > 99) fail('INVALID_RESPONSE', 'QQ omitted a bounded one-way friend list');
    const seen = new Set();
    const items = value.rpt_block_list.map(row => {
        if (!object(row)) fail('INVALID_RESPONSE', 'Invalid one-way friend entry');
        let uin;
        try { uin = String(integer(row.uint64_uin, U32, true)); } catch { fail('INVALID_RESPONSE', 'Invalid one-way friend account'); }
        if (seen.has(uin)) fail('INVALID_RESPONSE', 'QQ repeated a one-way friend account'); seen.add(uin);
        const item = { uin };
        if (row.str_uid !== undefined) { try { item.uid = uid(row.str_uid); } catch { fail('INVALID_RESPONSE', 'Invalid one-way friend UID'); } }
        if (row.uint32_age !== undefined) {
            if (!Number.isInteger(row.uint32_age) || row.uint32_age < 0 || row.uint32_age > 150) fail('INVALID_RESPONSE', 'Invalid one-way friend age');
            item.age = row.uint32_age;
        }
        for (const [key, target] of [['bytes_nick', 'nick_name'], ['bytes_source', 'source']]) if (row[key] !== undefined) {
            const encoded = row[key];
            if (typeof encoded !== 'string' || encoded.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('INVALID_RESPONSE', 'Invalid encoded one-way friend text');
            item[target] = utf8(Buffer.from(encoded, 'base64'), 4096);
        }
        return item;
    });
    return { items, limit: 99, complete: false };
}
function decode(bytes, prepared) {
    if (!prepared || !OPERATIONS.has(prepared.operation) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) fail('INVALID_RESPONSE', 'No bounded fixed contact response');
    const top = fields(bytes);
    if (prepared.operation === 'unidirectional') return unidirectional(top);
    if (uint(top, 1, U32, true) !== BigInt(prepared.command) || (uint(top, 2) ?? 0n) !== BigInt(prepared.sub) ||
        top.has(12) && uint(top, 12) !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'QQ returned another fixed contact operation');
    if ((uint(top, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the fixed contact operation; it was not retried');
    const raw = one(top, 4, 2);
    if (['input.status', 'doubt.approve', 'doubt.reject'].includes(prepared.operation)) {
        if (raw?.length) fail('INVALID_RESPONSE', 'Unrecognized fixed contact acknowledgement');
        return { confirmed: true, confirmation: 'server_ack', ...prepared.data };
    }
    if (raw === undefined) fail('INVALID_RESPONSE', 'QQ omitted the fixed contact query body');
    const body = fields(raw);
    if (prepared.operation === 'translate') {
        const result = nested(body, 2, true);
        if ((uint(result, 1) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the translation');
        for (const [field, language] of [[3, 'en'], [4, 'zh']]) if (result.has(field) && string(result, field, 16) !== language) fail('INVALID_RESPONSE', 'QQ returned another translation language');
        const strings = field => {
            const values = result.get(field) || [];
            if (values.length > 50 || values.some(entry => entry.wire !== 2)) fail('INVALID_RESPONSE', 'Invalid translation list');
            return values.map(entry => utf8(entry.value, 16384));
        };
        const source = strings(5), translated = strings(6);
        if (translated.length !== prepared.data.words.length || source.length && (source.length !== prepared.data.words.length || source.some((word, index) => word !== prepared.data.words[index]))) fail('INVALID_RESPONSE', 'Translation result does not match its input');
        return { words: translated, sourceWords: [...prepared.data.words] };
    }
    if (prepared.operation === 'doubt.list') {
        // Tag 1 is the get-operation discriminator, not a success/error code.
        if (uint(body, 1, U32, true) !== 1n) fail('INVALID_RESPONSE', 'QQ returned another filtered-friend operation');
        const content = nested(body, 2), seen = new Set();
        const items = content ? list(content, 1, prepared.data.count, row => {
            const who = account(row, 1), time = String(uint(row, 8, U64) ?? 0n), key = JSON.stringify([who, time]);
            if (seen.has(key)) fail('INVALID_RESPONSE', 'QQ repeated a filtered friend request'); seen.add(key);
            const result = { ...who, reqTime: time };
            for (const [field, name] of [[2, 'nick'], [5, 'msg'], [6, 'source'], [7, 'reason']]) if (row.has(field)) result[name] = string(row, field, 16384);
            if (row.has(9)) result.groupCode = String(uint(row, 9, U64));
            for (const [field, name] of [[3, 'age'], [4, 'sex'], [10, 'commonFriendCount']]) if (row.has(field)) result[name] = Number(uint(row, field));
            return result;
        }) : [];
        return { items, limit: prepared.data.count, complete: false };
    }
    const seen = new Set(), items = list(body, 1, prepared.data.count, row => {
        const sequence = uint(row, 1, U64, true), eventType = uint(row, 2) ?? 0n, state = uint(row, 3) ?? 0n;
        if (!sequence || seen.has(String(sequence)) || state > 4n) fail('INVALID_RESPONSE', 'Invalid filtered group request'); seen.add(String(sequence));
        const group = nested(row, 4, true), groupId = uint(group, 1, U32, true);
        if (!groupId) fail('INVALID_RESPONSE', 'Filtered group request omitted its group');
        const result = { sequence: String(sequence), eventType: Number(eventType), state: Number(state), groupId: String(groupId) };
        if (group.has(2)) result.groupName = string(group, 2, 4096);
        if (row.has(10)) result.comment = string(row, 10, 16384);
        for (const [field, label] of [[5, 'target'], [6, 'invitor'], [7, 'operator']]) {
            const person = nested(row, field);
            if (person) { const identity = account(person, 1, true); if (person.has(2)) identity.name = string(person, 2, 4096); result[label] = identity; }
        }
        return result;
    });
    const cursor = String(uint(body, 2, U64) ?? 0n);
    if (cursor !== '0' && (cursor === prepared.data.cursor || !items.length)) fail('INVALID_RESPONSE', 'Filtered group request cursor did not advance');
    return { items, cursor, filtered: true };
}
module.exports = { OPERATIONS, prepare, decode, words, object };
