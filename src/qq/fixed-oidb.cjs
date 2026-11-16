'use strict';

// Independent fixed command serializers. No caller can select an SSO command,
// field number or raw body. All acknowledgements retain their real scope.
const p = require('./proto.cjs');
const U32 = 0xffffffffn, U64 = 0xffffffffffffffffn;
const n = p.varintField, b = p.bytesField;
const s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const join = parts => Buffer.concat(parts);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function integer(value, maximum = U32, positive = false) {
    const number = p.varint(value); // Validate before numeric conversion.
    void number;
    const result = BigInt(value);
    if (result > maximum || positive && result === 0n) fail('INVALID_PARAMS', 'Fixed QQ integer is out of range');
    return result;
}
function text(value, maximum, empty = false) {
    if (typeof value !== 'string' || !empty && !value.length || value.includes('\0') ||
        Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid fixed QQ text');
    return value;
}
function uid(value) { if (!/^u_[A-Za-z0-9_-]{1,126}$/.test(text(value, 128))) fail('INVALID_PARAMS', 'A real QQ UID is required'); return value; }
function bool(value) { if (typeof value !== 'boolean') fail('INVALID_PARAMS', 'An explicit boolean is required'); return value; }
const OPERATIONS = new Set(['message.poke', 'message.emoji', 'group.essence', 'group.title', 'friend.category', 'image.ocr', 'voice.characters', 'face.list', 'face.get']);
function prepare(operation, data = {}) {
    if (!OPERATIONS.has(operation) || !data || typeof data !== 'object' || Array.isArray(data)) fail('UNSUPPORTED', 'Unknown fixed QQ operation');
    const allowed = {
        'message.poke': ['chatType', 'peerUin', 'targetUin'], 'message.emoji': ['groupId', 'sequence', 'emojiId', 'set'],
        'group.essence': ['groupId', 'sequence', 'random', 'set'], 'group.title': ['groupId', 'uid', 'title'],
        'friend.category': ['uid', 'categoryId'], 'image.ocr': ['imageUrl'], 'voice.characters': ['groupId', 'chatType'],
        'face.list': [], 'face.get': ['faceId']
    }[operation];
    if (Object.keys(data).some(key => !allowed.includes(key))) fail('INVALID_PARAMS', 'Unexpected fixed QQ operation field');
    let command, sub = 0, mode = 0, body;
    switch (operation) {
    case 'message.poke': {
        if (![1, 2].includes(data.chatType)) fail('INVALID_PARAMS', 'Poke requires a private or group peer');
        const peer = integer(data.peerUin, U32, true), target = integer(data.targetUin, U32, true);
        if (data.chatType === 1 && target !== peer) fail('INVALID_PARAMS', 'Private poke target differs from peer');
        command = 0xed3; sub = 1;
        body = join([n(1, target), n(2, data.chatType === 2 ? peer : 0), n(5, data.chatType === 1 ? peer : 0), n(6, 0)]); break;
    }
    case 'message.emoji': {
        const emoji = text(data.emojiId, 7);
        if (!/^(0|[1-9]\d{0,6})$/.test(emoji) || emoji.length > 3 && BigInt(emoji) > 0x10ffffn) fail('INVALID_PARAMS', 'Unknown reaction identifier');
        command = 0x9082; sub = bool(data.set) ? 1 : 2;
        body = join([n(2, integer(data.groupId, U32, true)), n(3, integer(data.sequence, U32, true)), s(4, emoji), n(5, emoji.length > 3 ? 2 : 1), n(6, 0), n(7, 0)]); break;
    }
    case 'group.essence':
        command = 0xeac; sub = bool(data.set) ? 1 : 2;
        body = join([n(1, integer(data.groupId, U32, true)), n(2, integer(data.sequence, U32, true)), n(3, integer(data.random))]); break;
    case 'group.title': {
        command = 0x8fc; sub = 2; const title = text(data.title, 256, true);
        body = join([n(1, integer(data.groupId, U32, true)), b(3, join([s(1, uid(data.uid)), s(5, title), n(6, U64), s(7, title)]))]); break;
    }
    case 'friend.category':
        command = 0x1255; mode = 1; body = join([s(1, uid(data.uid)), n(2, integer(data.categoryId))]); break;
    case 'image.ocr': {
        const source = text(data.imageUrl, 8192); let url;
        try { url = new URL(source); } catch { fail('INVALID_PARAMS', 'OCR requires an absolute HTTP image URL'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(source)) fail('INVALID_PARAMS', 'Invalid OCR image URL');
        command = 0xe07; body = join([n(1, 1), n(2, 0), n(3, 1), b(10, join([s(1, source), ...[10, 11, 12, 13, 14].map(field => s(field, '')), n(15, 0)]))]); break;
    }
    case 'voice.characters':
        if (data.chatType !== undefined && ![1, 2].includes(data.chatType)) fail('INVALID_PARAMS', 'Voice catalog type must be sound or song');
        command = 0x929d; body = join([n(1, integer(data.groupId, U32, true)), n(2, data.chatType ?? 1)]); break;
    case 'face.list': command = 0x9154; sub = 1; body = join([n(1, 0), n(2, 7), n(3, 0)]); break;
    case 'face.get': command = 0x9155; sub = 1; body = s(1, integer(data.faceId).toString()); break;
    }
    return { operation, command, sub, mode, data: { ...data }, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: join([n(1, command), n(2, sub), n(3, 0), b(4, body), n(12, mode)]) };
}
function one(fields, field, wire, required = false) {
    const entries = fields.get(field);
    if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed fixed QQ response field');
    return entries[0].value;
}
function string(fields, field, required = false, maximum = 4096) {
    const bytes = one(fields, field, 2, required);
    if (bytes === undefined) return undefined;
    if (bytes.length > maximum) fail('INVALID_RESPONSE', 'Oversized fixed QQ response text');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_RESPONSE', 'Invalid QQ response UTF-8'); }
}
function list(fields, field, maximum = 1000) {
    const entries = fields.get(field) || [];
    if (entries.length > maximum || entries.some(item => item.wire !== 2)) fail('INVALID_RESPONSE', 'Malformed fixed QQ result list');
    return entries.map(item => p.fields(item.value));
}
function small(fields, field, signed = false) {
    const value = one(fields, field, 0);
    if (value === undefined) return 0;
    if (value > U32 && !(signed && value >= U64 - 0x7fffffffn)) fail('INVALID_RESPONSE', 'QQ response integer exceeds its range');
    return Number(signed ? BigInt.asIntN(32, value) : value);
}
function face(fields) {
    const faceId = string(fields, 1, true, 128);
    if (!faceId) fail('INVALID_RESPONSE', 'QQ face has no identity');
    const result = { qSid: faceId };
    for (const [field, label] of [[2, 'qDes'], [3, 'emCode']]) { const value = string(fields, field); if (value !== undefined) result[label] = value; }
    for (const [field, label] of [[4, 'qCid'], [5, 'aniStickerType'], [6, 'aniStickerPackId'], [7, 'aniStickerId'], [13, 'aniStickerWidth'], [14, 'aniStickerHeight']]) if (fields.has(field)) result[label] = small(fields, field, true);
    const resource = one(fields, 8, 2);
    if (resource) {
        const urls = p.fields(resource), baseUrl = string(urls, 1), advUrl = string(urls, 2);
        result.resourceUrl = { ...(baseUrl !== undefined ? { baseUrl } : {}), ...(advUrl !== undefined ? { advUrl } : {}) };
    }
    const aliases = fields.get(9) || [];
    if (aliases.length > 128 || aliases.some(item => item.wire !== 2 || item.value.length > 1024)) fail('INVALID_RESPONSE', 'Invalid system face aliases');
    result.emojiNameAlias = aliases.map(item => { try { return new TextDecoder('utf-8', { fatal: true }).decode(item.value); } catch { fail('INVALID_RESPONSE', 'Invalid face alias encoding'); } });
    return result;
}
// Error diagnostics expose only wire structure and tiny scalar flags. Never
// include protocol text, URLs, opaque identifiers or arbitrary response bytes.
function responseShape(bytes) {
    if (!Buffer.isBuffer(bytes)) return 'invalid';
    try {
        const items = [];
        for (const [field, entries] of p.fields(bytes)) {
            if (items.length >= 16) { items.push('more'); break; }
            const sample = entries[0];
            const detail = sample.wire === 0 ? (sample.value <= 255n ? 'flag=' + sample.value : 'integer') : 'bytes=' + sample.value.length;
            items.push(field + '/' + sample.wire + '/count=' + entries.length + '/' + detail);
        }
        return 'bytes=' + bytes.length + ';' + items.join(',');
    } catch { return 'bytes=' + bytes.length + ';malformed'; }
}
function decode(bytes, prepared) {
    const maximum = prepared.operation === 'face.list' ? 262144 : 65536;
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximum) fail('INVALID_RESPONSE', 'No bounded fixed QQ response');
    const top = p.fields(bytes);
    const responseMode = one(top, 12, 0);
    if (one(top, 1, 0, true) !== BigInt(prepared.command) || (one(top, 2, 0) ?? 0n) !== BigInt(prepared.sub) ||
        responseMode !== undefined && responseMode !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'Fixed QQ response belongs to another operation');
    const error = one(top, 3, 0, true);
    const unchanged = prepared.operation === 'friend.category' && error === 2001002n;
    if (error !== 0n && !unchanged) fail('KERNEL_ERROR', 'QQ rejected the fixed operation; no retry was attempted');
    const raw = one(top, 4, 2);
    if (prepared.operation === 'message.emoji') {
        if (raw?.length) {
            const values = p.fields(raw), message = one(values, 1, 2, true), opaque2 = one(values, 2, 0, true), opaque3 = one(values, 3, 0, true);
            // QQ 3.2.35 replies with an empty message and two changing counters.
            // Neither counter is a business status or an operation echo. This
            // exact shape is only a candidate ACK; the caller must read back
            // its own isClicked state on the exact original message.
            if (values.size !== 3 || message.length || opaque2 === 0n || opaque2 > U32 || opaque3 === 0n || opaque3 > U32) {
                fail('INVALID_RESPONSE', 'Unrecognized reaction acknowledgement [' + responseShape(raw) + ']');
            }
        }
        return { ...prepared.data, confirmed: false, confirmation: 'requires_message_readback' };
    }
    if (['message.poke', 'group.essence', 'group.title', 'friend.category'].includes(prepared.operation)) {
        if (raw?.length) fail('INVALID_RESPONSE', 'Unrecognized business body for QQ acknowledgement [' + responseShape(raw) + ']');
        return { ...prepared.data, confirmed: true, confirmation: 'server_ack', ...(unchanged ? { alreadyApplied: true } : {}) };
    }
    if (!raw?.length) fail('INVALID_RESPONSE', 'QQ omitted the requested result');
    const body = p.fields(raw);
    if (prepared.operation === 'image.ocr') {
        if (small(body, 1, true) !== 0) fail('QUERY_FAILED', 'QQ OCR rejected the image');
        const result = p.fields(one(body, 10, 2, true));
        return { texts: list(result, 1, 1024).map(item => {
            const polygon = one(item, 3, 2);
            return { text: string(item, 1, true, 65536), confidence: small(item, 2), coordinates: polygon ?
                list(p.fields(polygon), 1, 128).map(point => ({ x: small(point, 1, true), y: small(point, 2, true) })) : [] };
        }), language: string(result, 2, false, 256), requestId: string(result, 3, false, 256) };
    }
    if (prepared.operation === 'voice.characters') {
        let total = 0;
        return { ...prepared.data, categories: list(body, 1, 128).map(category => ({ category: string(category, 1, true, 1024), voices: list(category, 2).map(voice => {
            if (++total > 5000) fail('INVALID_RESPONSE', 'QQ voice catalog is too large');
            return { voiceId: string(voice, 1, true, 128), voiceDisplayName: string(voice, 2), voiceExampleUrl: string(voice, 3, false, 8192) };
        }) })) };
    }
    if (prepared.operation === 'face.get') {
        const value = face(p.fields(one(body, 1, 2, true)));
        if (value.qSid !== String(prepared.data.faceId)) fail('INVALID_RESPONSE', 'QQ returned another face');
        return { face: value };
    }
    const packs = []; let total = 0;
    for (const [field, source] of [[2, 'common'], [3, 'special-big'], [4, 'magic']]) {
        const rawPanel = one(body, field, 2); if (!rawPanel) continue;
        for (const pack of list(p.fields(rawPanel), 1, 512)) packs.push({ source, packName: string(pack, 1), emojis: list(pack, 2, 5000).map(item => {
            if (++total > 5000) fail('INVALID_RESPONSE', 'QQ face catalog is too large'); return face(item);
        }) });
    }
    if (![2, 3, 4].some(field => body.has(field))) fail('INVALID_RESPONSE', 'QQ omitted face catalog panels');
    return { packs };
}
module.exports = { OPERATIONS, prepare, decode };
