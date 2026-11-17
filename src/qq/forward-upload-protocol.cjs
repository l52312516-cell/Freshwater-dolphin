'use strict';

// Fixed long-message resource upload/readback. These packets store a resource;
// neither command sends a chat message or stages messages in the self chat.
const p = require('./proto.cjs');
const { gzipSync, gunzipSync } = require('node:zlib');
const { plain, uint, text } = require('./admin-oidb.cjs');
const MAX_BYTES = 256 * 1024, MAX_NODES = 100, MAX_TEXT = 65536, MAX_SEGMENTS = 1000;
const COMMANDS = Object.freeze({ 'forward.upload': 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',
    'forward.readUploaded': 'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg' });
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const join = (...values) => Buffer.concat(values);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected fixed forward upload parameters');
}
function uid(value) {
    if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value)) fail('INVALID_PARAMS', 'Forward upload needs an authenticated QQ UID');
    return value;
}
function resource(value, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x20\x7f]/.test(value) || Buffer.from(value).toString('utf8') !== value) fail(code, 'Invalid QQ forward resource identity');
    return value;
}
function array(value, max, label) {
    if (!Array.isArray(value) || !value.length || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail('INVALID_PARAMS', 'Invalid bounded ' + label);
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) ?? {}, 'value')) fail('INVALID_PARAMS', 'Forward upload arrays must be dense ordinary values');
    return value;
}
function normalizeNodes(nodes, metadata = false) {
    let total = 0, segments = 0;
    return array(nodes, MAX_NODES, 'forward nodes').map(node => {
        fields(node, metadata ? ['nickname', 'texts', 'sequence', 'random', 'time', 'authorUin', 'authorUid'] :
            ['nickname', 'texts', 'authorUin', 'authorUid', 'time']);
        const nickname = text(node.nickname, 'node nickname', 512, false);
        if (!nickname.trim() || /[\x00-\x1f\x7f]/.test(nickname)) fail('INVALID_PARAMS', 'Invalid forward display name');
        const texts = array(node.texts, MAX_SEGMENTS, 'forward text segments').map(value => {
            const result = text(value, 'forward text', MAX_TEXT);
            total += Buffer.byteLength(result); segments++;
            if (total > MAX_TEXT || segments > MAX_SEGMENTS) fail('INVALID_PARAMS', 'Forward content exceeds its aggregate text or segment budget');
            return result;
        });
        return { nickname, texts,
            ...(node.authorUin === undefined ? {} : { authorUin: uint(node.authorUin, 'node author account', 0xffffffffn, 1n) }),
            ...(node.authorUid === undefined ? {} : { authorUid: uid(node.authorUid) }),
            ...(node.time === undefined && !metadata ? {} : { time: uint(node.time, 'node display time', 0xffffffffn, metadata ? 1n : 0n) }),
            ...(metadata ? { sequence: uint(node.sequence, 'node display sequence', 0xffffffffn, 1n),
                random: uint(node.random, 'node display random', 0xffffffffn, 1n) } : {}) };
    });
}
function payload(data) {
    const nodes = data.nodes.map(node => {
        const head = join(n(1, node.authorUin ?? data.selfUin), ...(node.authorUid ? [s(2, node.authorUid)] : []),
            s(6, data.selfUid), b(7, s(6, node.nickname)));
        const content = join(n(1, 9), n(2, 4), n(3, 0), n(4, node.random), n(5, node.sequence), n(6, node.time));
        const rich = join(...node.texts.map(value => b(2, b(1, s(1, value)))));
        return b(1, join(b(1, head), b(2, content), b(3, b(1, rich))));
    });
    const result = b(2, join(s(1, 'MultiMsg'), b(2, join(...nodes))));
    if (result.length > MAX_BYTES) fail('INVALID_PARAMS', 'Forward long-message payload is too large');
    return result;
}
function prepare(operation, request = {}) {
    if (!Object.hasOwn(COMMANDS, operation)) fail('UNSUPPORTED', 'Unknown fixed forward upload operation');
    if (operation === 'forward.readUploaded') {
        fields(request, ['selfUid', 'resId']);
        const data = { selfUid: uid(request.selfUid), resId: resource(request.resId) };
        return { operation, name: COMMANDS[operation], data, body: join(b(1, join(b(1, s(2, data.selfUid)), s(2, data.resId), n(3, 1))),
            b(15, join(n(1, 2), n(2, 0), n(3, 0), n(4, 0)))) };
    }
    fields(request, ['selfUin', 'selfUid', 'groupId', 'nodes']);
    const data = { selfUin: uint(request.selfUin, 'self account', 0xffffffffn, 1n), selfUid: uid(request.selfUid),
        ...(request.groupId === undefined ? {} : { groupId: uint(request.groupId, 'forward resource group', 0xffffffffn, 1n) }), nodes: normalizeNodes(request.nodes, true) };
    if (new Set(data.nodes.map(node => node.sequence)).size !== data.nodes.length || new Set(data.nodes.map(node => node.random)).size !== data.nodes.length) fail('INVALID_PARAMS', 'Forward display-node identities must be distinct');
    const rawPayload = payload(data), compressed = gzipSync(rawPayload);
    return { operation, name: COMMANDS[operation], data, rawPayload,
        body: join(b(2, join(n(1, data.groupId ? 3 : 1), b(2, s(2, data.groupId || data.selfUid)),
            ...(data.groupId ? [n(3, data.groupId)] : []), b(4, compressed))), b(15, join(n(1, 4), n(2, 1), n(3, 7), n(4, 0)))) };
}
function one(map, field, wire, required = true) {
    const values = map.get(field);
    if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'QQ returned a malformed forward resource response');
    return values[0].value;
}
function string(value) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
    catch { fail('INVALID_RESPONSE', 'QQ forward response contains invalid UTF-8'); }
}
function payloadFields(raw, allowed, repeated = []) {
    const result = p.fields(raw);
    if ([...result].some(([field, values]) => !allowed.includes(field) ||
        !repeated.includes(field) && values.length !== 1)) fail('INVALID_RESPONSE', 'QQ forward payload has unknown or duplicate fields');
    return result;
}
function payloadUint(map, field, { required = true, minimum = 0n, maximum = 0xffffffffn, exact } = {}) {
    const value = one(map, field, 0, required);
    if (value === undefined) return undefined;
    if (value < minimum || value > maximum || exact !== undefined && value !== exact) {
        fail('INVALID_RESPONSE', 'QQ forward payload has an invalid metadata integer');
    }
    return String(value);
}
function payloadText(map, field, { required = true, maximum = 512, nativeUid = false } = {}) {
    const value = one(map, field, 2, required);
    if (value === undefined) return undefined;
    if (!value.length || value.length > maximum) fail('INVALID_RESPONSE', 'QQ forward payload has an invalid bounded string');
    const result = string(value);
    if (nativeUid ? !/^u_[A-Za-z0-9_-]{1,126}$/.test(result) : !result.trim() || /[\x00-\x1f\x7f]/.test(result)) {
        fail('INVALID_RESPONSE', 'QQ forward payload has an invalid display or identity string');
    }
    return result;
}
function serverMetadata(map) {
    const raw = one(map, 15, 2, false);
    if (raw === undefined) return;
    // The target server adds one reserve envelope: type 2 and two opaque
    // signature blobs. Their contents are server-owned, not node metadata.
    const reserved = payloadFields(raw, [3, 4, 5]);
    payloadUint(reserved, 3, { exact: 2n });
    for (const field of [4, 5]) {
        const value = one(reserved, field, 2);
        if (!value.length || value.length > 4096) fail('INVALID_RESPONSE', 'QQ forward server metadata exceeds its bound');
    }
}
function decodePayload(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) fail('INVALID_RESPONSE', 'QQ forward payload is absent or exceeds its bound');
    const root = payloadFields(raw, [2]), action = payloadFields(one(root, 2, 2), [1, 2]);
    if (!one(action, 1, 2).equals(Buffer.from('MultiMsg'))) fail('INVALID_RESPONSE', 'QQ forward payload is not one MultiMsg resource');
    const content = payloadFields(one(action, 2, 2), [1], [1]), values = content.get(1);
    if (!values || !values.length || values.length > MAX_NODES || values.some(value => value.wire !== 2)) {
        fail('INVALID_RESPONSE', 'QQ forward payload has an invalid bounded node list');
    }
    const nodes = values.map(value => {
        const node = payloadFields(value.value, [1, 2, 3]);
        const head = payloadFields(one(node, 1, 2), [1, 2, 6, 7]);
        const authorUin = payloadUint(head, 1, { minimum: 1n });
        const authorUid = payloadText(head, 2, { required: false, maximum: 128, nativeUid: true });
        const toUid = payloadText(head, 6, { required: false, maximum: 128, nativeUid: true });
        if (authorUid === undefined && toUid === undefined) fail('INVALID_RESPONSE', 'QQ forward node has no native identity envelope');
        const forward = payloadFields(one(head, 7, 2), [6, 11]);
        const nickname = payloadText(forward, 6);
        payloadUint(forward, 11, { required: false, exact: 1n });
        const metadata = payloadFields(one(node, 2, 2), [1, 2, 3, 4, 5, 6, 15]);
        const msgType = payloadUint(metadata, 1, { exact: 9n });
        const subType = payloadUint(metadata, 2, { required: false, exact: 4n });
        const c2cCommand = payloadUint(metadata, 3, { required: false, exact: 0n });
        const random = payloadUint(metadata, 4, { minimum: 1n });
        const sequence = payloadUint(metadata, 5, { minimum: 1n });
        const time = payloadUint(metadata, 6, { minimum: 1n });
        serverMetadata(metadata);
        const body = one(node, 3, 2), message = payloadFields(body, [1]);
        const rich = one(message, 1, 2);
        if (!rich.length) fail('INVALID_RESPONSE', 'QQ forward node has no rich message body');
        // Rich media carries native resource descriptors. Preserve every byte
        // instead of rebuilding or partially interpreting image sub-protocols.
        p.fields(rich);
        return { authorUin, ...(authorUid === undefined ? {} : { authorUid }), ...(toUid === undefined ? {} : { toUid }),
            nickname, time, sequence, random, msgType, ...(subType === undefined ? {} : { subType }),
            ...(c2cCommand === undefined ? {} : { c2cCommand }), body: Buffer.from(body) };
    });
    return { nodes };
}
function verifyPayload(expectedRaw, returnedRaw, options = {}) {
    fields(options, ['authorUids']);
    const authorUids = options.authorUids ?? new Map();
    if (!(authorUids instanceof Map) || Object.getPrototypeOf(authorUids) !== Map.prototype || authorUids.size > MAX_NODES) {
        fail('INVALID_PARAMS', 'Forward verification requires a bounded author UID map');
    }
    const verifiedAuthors = new Map();
    for (const [author, nativeUid] of authorUids) {
        const account = uint(author, 'verified node author', 0xffffffffn, 1n);
        if (verifiedAuthors.has(account)) fail('INVALID_PARAMS', 'Forward author UID aliases conflict');
        verifiedAuthors.set(account, uid(nativeUid));
    }
    const expected = decodePayload(expectedRaw).nodes, returned = decodePayload(returnedRaw).nodes;
    if (expected.length !== returned.length) fail('INVALID_RESPONSE', 'QQ forward resource node count changed');
    for (let index = 0; index < expected.length; index++) {
        const wanted = expected[index], actual = returned[index], boundUid = verifiedAuthors.get(wanted.authorUin);
        if (['authorUin', 'nickname', 'msgType', 'random', 'sequence', 'time'].some(field => wanted[field] !== actual[field]) ||
            !wanted.body.equals(actual.body)) fail('INVALID_RESPONSE', 'QQ forward resource node metadata or complete body changed');
        if (boundUid !== undefined && (wanted.authorUid !== undefined && wanted.authorUid !== boundUid ||
            actual.authorUid !== undefined && actual.authorUid !== boundUid)) fail('INVALID_RESPONSE', 'QQ forward resource author UID conflicts with its verified account');
        if (wanted.authorUid !== undefined && actual.authorUid !== wanted.authorUid ||
            wanted.authorUid === undefined && actual.authorUid !== undefined && actual.authorUid !== boundUid) {
            fail('INVALID_RESPONSE', 'QQ forward resource author UID is not verified');
        }
        if (actual.toUid !== undefined && actual.toUid !== wanted.toUid ||
            wanted.toUid !== undefined && actual.toUid === undefined &&
            (actual.authorUid === undefined || actual.authorUid !== (wanted.authorUid ?? boundUid))) {
            fail('INVALID_RESPONSE', 'QQ forward resource changed an unverified identity envelope');
        }
    }
    return { verified: true, nodeCount: expected.length, exactBytes: expectedRaw.equals(returnedRaw) };
}
function decode(raw, prepared) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) fail('INVALID_RESPONSE', 'QQ forward response has no bounded protobuf body');
    const root = p.fields(raw), result = p.fields(one(root, prepared.operation === 'forward.upload' ? 2 : 1, 2));
    if (prepared.operation === 'forward.upload') return { operation: prepared.operation, resId: resource(string(one(result, 3, 2)), 'INVALID_RESPONSE') };
    const echo = one(result, 3, 2, false);
    if (echo !== undefined && resource(string(echo), 'INVALID_RESPONSE') !== prepared.data.resId) fail('INVALID_RESPONSE', 'QQ returned a different uploaded resource');
    const compressed = one(result, 4, 2);
    if (!compressed.length || compressed.length > MAX_BYTES) fail('INVALID_RESPONSE', 'QQ omitted the uploaded forward payload');
    let value;
    try { value = gunzipSync(compressed, { maxOutputLength: MAX_BYTES }); }
    catch { fail('INVALID_RESPONSE', 'QQ forward payload is invalid or exceeds the decompression limit'); }
    if (!value.length) fail('INVALID_RESPONSE', 'QQ returned an empty uploaded forward payload');
    p.fields(value);
    return { operation: prepared.operation, resId: prepared.data.resId, payloadBase64: value.toString('base64') };
}
module.exports = { prepare, decode, decodePayload, verifyPayload, normalizeNodes, fields, resource, MAX_BYTES, MAX_NODES };
