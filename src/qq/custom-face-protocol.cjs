'use strict';

// Fixed Faceroam, OIDB and Highway serializers. Raw SSO commands, fields,
// credential bytes and upload destinations are never caller-selectable.
const p = require('./proto.cjs');
const crypto = require('node:crypto');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const m = (field, parts) => b(field, Buffer.concat(parts));
const OPERATIONS = new Set(['face.list', 'face.detail', 'face.delete', 'face.modify', 'face.order', 'face.reorder', 'face.uploadSession', 'face.uploadTicket']);
const OS_VERSION = '10.0.26200';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function uint(value, maximum = 0xffffffffn, positive = false) {
    p.varint(value); const result = BigInt(value);
    if (result > maximum || positive && result === 0n) fail('INVALID_PARAMS', 'Custom face integer exceeds its range');
    return result;
}
function text(value, maximum, empty = false, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail(code, 'Invalid bounded custom face text');
    return value;
}
function emoji(value, uin, code = 'INVALID_PARAMS') {
    const match = typeof value === 'string' && /^([1-9]\d{0,9})_0_0_0_([A-Fa-f0-9]{32})_0_0$/.exec(value);
    if (!match || BigInt(match[1]) > 0xffffffffn || uin !== undefined && match[1] !== String(uin)) fail(code, 'Custom face identity does not belong to this account');
    return { emojiId: value, md5: match[2].toUpperCase() };
}
function ids(value, uin) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 1000 || new Set(value).size !== value.length) fail('INVALID_PARAMS', 'Expected a unique bounded custom face identity list');
    return value.map(id => emoji(id, uin));
}
function prepare(operation, data = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed custom face operation');
    const allowed = { 'face.list': ['uin'], 'face.detail': ['uin', 'ids'], 'face.delete': ['uin', 'emojiId'], 'face.modify': ['uin', 'emojiId', 'desc'],
        'face.order': ['uin', 'emojiId'], 'face.reorder': ['uin', 'ids'], 'face.uploadSession': [], 'face.uploadTicket': ['uin', 'md5', 'size'] }[operation];
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key))) fail('INVALID_PARAMS', 'Unexpected custom face protocol parameters');
    const uin = operation === 'face.uploadSession' ? undefined : String(uint(data.uin, 0xffffffffn, true));
    const saved = { ...data, ...(uin ? { uin } : {}) };
    let name, body, command, sub = 1, mode = 0;
    if (['face.list', 'face.delete'].includes(operation)) {
        name = 'Faceroam.OpReq';
        body = Buffer.concat([m(1, [n(1, 1), s(2, OS_VERSION), ...(operation === 'face.list' ? [s(3, '9.9.28-46928')] : [])]), n(2, uin),
            n(3, operation === 'face.list' ? 1 : 2), ...(operation === 'face.list' ? [n(6, 1)] : [m(5, [s(1, emoji(data.emojiId, uin).emojiId)])])]);
    } else if (operation === 'face.uploadSession') {
        name = 'HttpConn.0x6ff_501';
        body = m(0x501, [n(1, 0), n(2, 0), n(3, 16), n(4, 1), n(6, 3), ...[1, 5, 10, 21].map(value => n(7, value)), n(9, 2), n(10, 9), n(11, 8), s(15, '1.0.1')]);
    } else if (operation === 'face.uploadTicket') {
        if (typeof data.md5 !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(data.md5)) fail('INVALID_PARAMS', 'Custom face upload requires an exact digest');
        const size = uint(data.size, 10n * 1024n * 1024n, true);
        name = 'ImgStore.BDHExpressionRoam';
        body = Buffer.concat([n(1, 3), n(2, 1), m(3, [n(1, 0), n(2, uin), n(3, 0), b(4, Buffer.from(data.md5, 'hex')), n(5, size), n(7, 2), n(8, 0), n(9, 1), s(13, '1.0.0'), n(16, 1)]),
            n(7, 9), m(1001, [m(1, [n(1, 0), n(2, 0), s(3, '0')]), n(2, 1)])]);
    } else {
        command = operation === 'face.order' ? 0x902f : 0x902e;
        mode = operation === 'face.modify' ? 0 : 1;
        if (operation === 'face.order') body = Buffer.concat([m(1, [n(1, 1024), s(2, OS_VERSION), s(3, '9.9.26')]), s(2, emoji(data.emojiId, uin).emojiId), n(3, 1)]);
        else if (operation === 'face.modify') {
            const item = emoji(data.emojiId, uin), desc = text(data.desc, 1024, true);
            body = Buffer.concat([n(1, 1), s(2, OS_VERSION), n(3, 3), m(5, [m(1, [s(1, item.emojiId), s(2, item.md5)]), s(2, desc)]), n(12, 1)]);
        } else {
            saved.ids = [...data.ids];
            body = Buffer.concat([n(1, 1), s(2, OS_VERSION), n(3, 2), ...ids(data.ids, uin).map(item => m(4, [s(1, item.emojiId), s(2, item.md5)]))]);
        }
        name = 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_1';
        body = Buffer.concat([n(1, command), n(2, 1), n(3, 0), b(4, body), n(12, mode)]);
    }
    return { operation, data: saved, command, sub, mode, name, body, allowEmptyResponse: operation === 'face.delete' };
}
function fields(bytes) {
    const value = p.fields(bytes);
    if (value.size > 128 || [...value.values()].reduce((sum, list) => sum + list.length, 0) > 4096) fail('INVALID_RESPONSE', 'Custom face response has too many fields');
    return value;
}
function one(map, field, wire, required = false) {
    const values = map.get(field);
    if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed or duplicate custom face response field');
    return values[0].value;
}
function number(map, field, maximum = 0xffffffffn, required = false) {
    const value = one(map, field, 0, required);
    if (value !== undefined && value > maximum) fail('INVALID_RESPONSE', 'Custom face response integer exceeds its range');
    return value;
}
function string(map, field, required = false, maximum = 1024) {
    const value = one(map, field, 2, required);
    if (value === undefined) return undefined;
    if (value.length > maximum) fail('INVALID_RESPONSE', 'Custom face response string exceeds its limit');
    try { return text(new TextDecoder('utf-8', { fatal: true }).decode(value), maximum, true, 'INVALID_RESPONSE'); }
    catch { fail('INVALID_RESPONSE', 'Invalid custom face response UTF-8'); }
}
function list(map, field, maximum = 1000) {
    const values = map.get(field) || [];
    if (values.length > maximum || values.some(value => value.wire !== 2)) fail('INVALID_RESPONSE', 'Invalid bounded custom face response list');
    return values.map(value => fields(value.value));
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || !bytes.length && !prepared?.allowEmptyResponse || bytes.length > 1024 * 1024 || !OPERATIONS.has(prepared?.operation)) fail('INVALID_RESPONSE', 'No bounded custom face response');
    let body = fields(bytes);
    if (prepared.command !== undefined) {
        const mode = number(body, 12);
        if (number(body, 1, 0xffffffffn, true) !== BigInt(prepared.command) || (number(body, 2) ?? 0n) !== 1n || mode !== undefined && mode !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'Custom face response belongs to another command');
        if ((number(body, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the custom face operation');
        const writeAck = ['face.modify', 'face.order', 'face.reorder'].includes(prepared.operation);
        body = fields(one(body, 4, 2, !writeAck) || Buffer.alloc(0));
    }
    const operation = prepared.operation, data = prepared.data;
    if (operation === 'face.uploadSession') {
        const connection = fields(one(body, 0x501, 2, true)), servers = [];
        for (const info of list(connection, 3, 32)) {
            if (number(info, 1) !== 1n) continue;
            for (const address of list(info, 2, 32)) {
                const raw = one(address, 2, 5, true), port = number(address, 3, 65535n, true);
                const parts = [...raw], host = parts.join('.');
                if (port === 0n || parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 || parts[0] === 169 && parts[1] === 254 ||
                    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) fail('INVALID_RESPONSE', 'QQ supplied a nonpublic upload node');
                if (!servers.some(server => server.host === host && server.port === Number(port))) servers.push({ host, port: Number(port) });
            }
        }
        if (!servers.length) fail('INVALID_RESPONSE', 'QQ supplied no public custom face upload node');
        return { servers };
    }
    if (operation === 'face.uploadTicket') {
        const inner = fields(one(body, 3, 2, true)), token = one(inner, 8, 2, true);
        if (token.length < 16 || token.length > 4096) fail('INVALID_RESPONSE', 'QQ supplied no bounded custom face upload ticket');
        return { token: Buffer.from(token) };
    }
    if ((number(body, 1) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the custom face business operation');
    if (operation === 'face.list') {
        const item = fields(one(body, 4, 2, true)), entries = item.get(1) || [];
        if (entries.length > 1000 || entries.some(entry => entry.wire !== 2)) fail('INVALID_RESPONSE', 'QQ supplied no bounded complete custom face list');
        const found = entries.map(entry => { const value = string(new Map([[1, [entry]]]), 1, true, 128); emoji(value, data.uin, 'INVALID_RESPONSE'); return value; });
        // The real empty account returns tag4=500: it is an account quota,
        // despite the reference name totalCount. Faceroam op1 returns all IDs
        // in one container and has no pagination request/cursor contract.
        number(item, 4);
        if (new Set(found).size !== found.length) fail('INVALID_RESPONSE', 'Custom face list contains duplicates');
        return { uin: data.uin, ids: found, complete: true };
    }
    if (operation === 'face.detail' || operation === 'face.modify') {
        const responseOperation = number(body, 3);
        if (responseOperation !== undefined && responseOperation !== (operation === 'face.modify' ? 3n : 2n)) fail('INVALID_RESPONSE', 'QQ custom face response echoed another business operation');
        const expected = new Set(operation === 'face.detail' ? data.ids : [data.emojiId]), seen = new Set();
        const entries = list(body, 4).map(entry => {
            const identity = fields(one(entry, 1, 2, true)), emojiId = string(identity, 1, true, 128), item = emoji(emojiId, data.uin, 'INVALID_RESPONSE');
            const md5 = string(identity, 2, false, 32), desc = string(entry, 3), legacy = string(entry, 2);
            if (!expected.has(emojiId) || seen.has(emojiId) || md5 !== undefined && md5.toUpperCase() !== item.md5) fail('INVALID_RESPONSE', 'Custom face detail identity differs from the requested account catalog');
            seen.add(emojiId); return { emojiId, desc: desc || legacy || '' };
        });
        if (operation === 'face.detail') return { uin: data.uin, entries };
        return { ...data, acknowledged: true, entries };
    }
    return { ...data, acknowledged: true };
}
function uploadFrame({ uin, emojiId, md5, bytes, token }) {
    const identity = emoji(emojiId, uin);
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024 || !Buffer.isBuffer(token) || token.length < 16 || token.length > 4096 || !/^[A-Fa-f0-9]{32}$/.test(md5)) fail('INVALID_PARAMS', 'Invalid custom face upload frame inputs');
    if (identity.md5 !== md5.toUpperCase() || crypto.createHash('md5').update(bytes).digest('hex') !== md5.toLowerCase()) fail('INVALID_PARAMS', 'Custom face upload bytes, identifier and digest disagree');
    const digest = Buffer.from(md5, 'hex');
    const head = Buffer.concat([m(1, [n(1, 1), s(2, uin), s(3, 'PicUp.DataUp'), n(4, 1), n(5, 0), n(6, bytes.length), n(7, 16), n(8, 9)]),
        m(2, [n(1, 0), n(2, bytes.length), n(3, 0), n(4, bytes.length), b(6, token), b(8, digest), b(9, digest)]), m(3, [s(1, emojiId)]), n(4, 0), n(8, 9)]);
    const prefix = Buffer.alloc(9); prefix[0] = 0x28; prefix.writeUInt32BE(head.length, 1); prefix.writeUInt32BE(bytes.length, 5);
    return Buffer.concat([prefix, head, bytes, Buffer.from([0x29])]);
}
function uploadAck(bytes, size) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 10 || bytes.length > 65536 || bytes[0] !== 0x28 || bytes.at(-1) !== 0x29) fail('INVALID_RESPONSE', 'Custom face upload returned no valid Highway frame');
    const headLength = bytes.readUInt32BE(1), bodyLength = bytes.readUInt32BE(5);
    if (headLength + bodyLength + 10 !== bytes.length) fail('INVALID_RESPONSE', 'Custom face upload returned a truncated Highway frame');
    const head = fields(bytes.subarray(9, 9 + headLength));
    if ((number(head, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the custom face upload');
    const segment = fields(one(head, 2, 2, true));
    if ((number(segment, 5) ?? 0n) !== 0n || number(segment, 2, 0xffffffffffffffffn, true) !== BigInt(size) ||
        number(segment, 3, 0xffffffffffffffffn, true) !== 0n || number(segment, 4, 0xffffffffn, true) !== BigInt(size)) fail('INVALID_RESPONSE', 'QQ did not acknowledge the exact complete custom face upload');
    return true;
}
module.exports = { OPERATIONS, prepare, decode, emoji, uploadFrame, uploadAck };
