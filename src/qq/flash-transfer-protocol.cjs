'use strict';

// Sources: SnowLuma 2.4.2 fixed operations; LLBot 0308b628 server upload grants.
// This module exposes only
// named fixed operations; upload credentials never cross the public RPC.
const p = require('./proto.cjs');
const { createHash } = require('node:crypto');
const N = p.varintField, B = p.bytesField, S = (tag, value) => B(tag, Buffer.from(value));
const C = parts => Buffer.concat(parts), E = tag => B(tag, Buffer.alloc(0));
const U32 = 0xffffffffn, U64 = 0xffffffffffffffffn, MAX_FRAME = 1024 * 1024;
const KEYS = Object.freeze({ list: [], detail: ['filesetId'], metadata: ['filesetId'], delete: ['filesetId'],
    rename: ['filesetId', 'name'], send: ['filesetId', 'targetUid', 'groupId'],
    create: ['name', 'size', 'typeCode', 'selfUin', 'selfUid', 'nickname'], commit: ['filesetId', 'entries'],
    complete: ['filesetId'], ready: ['filesetId'], prepare: ['filesetId', 'fileUuid', 'name', 'size', 'sha1', 'fileIndex', 'formatCode', 'thumbType'],
    apply: ['filesetId', 'fileUuid', 'name', 'size', 'sha1', 'md5', 'fileId', 'time', 'ttl', 'fileIndex', 'formatCode', 'thumbType'],
    download: ['filesetId', 'fileUuid', 'fileId', 'name'] });
let sequence = 300;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function text(value, max = 1024, empty = false) {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid flash text');
    return value;
}
function name(value) { text(value, 512); if (!value.trim() || /[\\/]/.test(value)) fail('INVALID_PARAMS', 'Invalid flash display name'); return value; }
function uuid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) fail('INVALID_PARAMS', 'A canonical fileset/file UUID is required'); return value; }
function uid(value) { if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value)) fail('INVALID_PARAMS', 'A real target QQ UID is required'); return value; }
function integer(value, max = U32, positive = false) {
    if (!['number', 'string', 'bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value)) fail('INVALID_PARAMS', 'An exact flash integer is required');
    p.varint(value); const result = BigInt(value);
    if (result > max || positive && result === 0n) fail('INVALID_PARAMS', 'Flash integer exceeds its range');
    return result;
}
function fileId(value) {
    text(value, 4096);
    // A server credential is opaque. Keep punctuation, padding and Unicode
    // unchanged; only bounded printable text may reach a fixed request/URL.
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(value)) fail('INVALID_PARAMS', 'Invalid main file ID'); return value;
}
function uploadGrant(value) {
    try {
        if (!object(value) || typeof value.time !== 'number' || typeof value.ttl !== 'number') throw new Error();
        return { token: fileId(value.token), time: Number(integer(value.time)), ttl: Number(integer(value.ttl)) };
    } catch { fail('INVALID_RESPONSE', 'QQ omitted a bounded server-issued flash upload token, time or TTL'); }
}
function digest(value, size) { if (typeof value !== 'string' || !new RegExp('^[a-f0-9]{' + size + '}$').test(value)) fail('INVALID_PARAMS', 'Invalid flash digest'); return value; }
function only(value, keys) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_PARAMS', 'Unexpected fixed flash fields'); }
function shareUrl(input) {
    let code = text(input, 2048);
    if (code.includes('://')) {
        let url; try { url = new URL(code); } catch { fail('INVALID_PARAMS', 'Invalid official QQ share link'); }
        const match = /^\/q\/([^/]+)\/?$/.exec(url.pathname);
        if (url.protocol !== 'https:' || url.host !== 'qfile.qq.com' || url.username || url.password || url.search || url.hash || !match) fail('INVALID_PARAMS', 'Only the official QQ share origin is allowed');
        try { code = decodeURIComponent(match[1]); } catch { fail('INVALID_PARAMS', 'Invalid QQ share code'); }
    }
    if (code.length > 256 || ['.', '..'].includes(code) || /[\s\\/?#]/u.test(code)) fail('INVALID_PARAMS', 'Invalid QQ share code');
    return 'https://qfile.qq.com/q/' + encodeURIComponent(code);
}
function mediaHead(sub, seq, type = 22) {
    return B(1, C([B(1, C([N(1, seq), N(2, sub)])), B(2, C([N(101, 2), N(102, 4), N(103, type), N(200, 5)])), B(3, N(1, 1))]));
}
function uploadData(data, apply) {
    const result = { filesetId: uuid(data.filesetId), fileUuid: uuid(data.fileUuid), name: name(data.name),
        size: Number(integer(data.size, U32, true)), sha1: digest(data.sha1, 40), fileIndex: Number(integer(data.fileIndex, 1000n, true)),
        formatCode: Number(integer(data.formatCode, 27n, true)) };
    if (data.thumbType !== undefined) { if (!['png', 'jpg'].includes(data.thumbType)) fail('INVALID_PARAMS', 'Invalid flash thumbnail type'); result.thumbType = data.thumbType; }
    if (apply) { result.md5 = digest(data.md5, 32); result.fileId = fileId(data.fileId); result.time = Number(integer(data.time)); result.ttl = Number(integer(data.ttl)); }
    return result;
}
function prepare(operation, input = {}) {
    if (!Object.hasOwn(KEYS, operation)) fail('UNSUPPORTED', 'Unknown fixed flash operation');
    only(input, KEYS[operation]); let data, body, command, sub = 1, mode = 0;
    if (operation === 'list') { command = 0x93d2; data = {}; body = C([N(1, 3), N(3, 10)]); }
    else if (operation === 'create') {
        command = 0x93cf; data = { name: name(input.name), size: String(integer(input.size, U32, true)), typeCode: Number(integer(input.typeCode, 7n, true)),
            selfUin: String(integer(input.selfUin, U32, true)), selfUid: uid(input.selfUid), nickname: text(input.nickname, 512, true) };
        if (![2, 6, 7].includes(data.typeCode)) fail('INVALID_PARAMS', 'Invalid fileset coarse type');
        body = C([N(1, 1), B(2, C([S(2, data.name), S(3, data.name), N(4, 1), N(5, data.size),
            B(10, C([S(1, data.selfUin), ...(data.nickname ? [S(2, data.nickname)] : []), S(3, data.selfUid), E(4)])), N(16, 1)])), N(3, data.typeCode), N(12, 1)]);
    } else if (operation === 'prepare' || operation === 'apply') {
        command = 0x12a9; sub = operation === 'prepare' ? 100 : 103; mode = 1;
        data = uploadData(input, sub === 103); data.seq = sequence++ >>> 0;
        const jpg = data.thumbType === 'jpg', thumb = data.thumbType !== undefined;
        const info = B(1, C([N(1, data.size), S(2, data.md5 || ''), S(3, data.sha1), S(4, data.name),
            B(5, C([N(1, jpg ? 1 : 0), N(2, 0), N(3, 0), N(4, 0)])), N(6, thumb ? 526 : 0), N(7, thumb ? 360 : 0), N(8, 0), N(9, jpg ? 0 : 1)]));
        const wrap = B(sub === 100 ? 9 : 10, C([S(1, data.filesetId), S(2, data.filesetId), S(3, data.fileUuid), N(4, data.fileIndex),
            N(5, sub === 103 && thumb && !jpg ? 1 : 0), N(6, sub === 100 ? (thumb ? 1 : 0) : (jpg ? 1 : 0)),
            N(7, thumb ? (jpg ? 2 : 26) : data.formatCode), E(8), N(9, 1), ...[10, 11, 12, 13, 14].map(tag => N(tag, 0))]));
        const payload = sub === 100 ? C([B(1, C([info, N(2, 0)])), N(2, 1), N(3, 0), N(4, 0), N(5, 0),
            B(6, C([B(1, C([N(1, 0), E(2)])), B(2, E(3)), B(3, C([E(11), E(12)])), N(10, 0)])), N(7, 0), N(8, 0), wrap]) :
            C([B(1, C([info, S(2, data.fileId), N(3, 1), N(4, data.time), N(5, data.ttl), N(6, 0)])),
                B(2, N(1, 2)), B(3, C([N(1, 0), N(2, 0), N(3, 0), E(4)])), wrap]);
        body = C([mediaHead(sub, data.seq, thumb ? (jpg ? 24 : 23) : 22), B(sub === 100 ? 2 : 12, payload)]);
    } else {
        data = { filesetId: uuid(input.filesetId) };
        if (operation === 'detail') { command = 0x93d3; body = C([S(1, data.filesetId), N(2, 7)]); }
        else if (operation === 'metadata') { command = 0x93d4; body = C([S(1, data.filesetId), B(2, C([N(2, 1), N(3, 18), E(5), E(6)])), N(3, 7), N(4, 1)]); }
        else if (operation === 'delete') { command = 0x9407; body = C([S(1, data.filesetId), N(3, 7)]); }
        else if (operation === 'rename') { command = 0x9427; sub = 0; mode = 1; data.name = name(input.name); body = C([S(1, data.filesetId), B(2, C([S(1, data.name), S(2, data.name)])), E(3)]); }
        else if (operation === 'complete') { command = 0x93db; body = S(1, data.filesetId); }
        else if (operation === 'ready') { command = 0x93d1; body = C([S(1, data.filesetId), N(2, 6)]); }
        else if (operation === 'commit') {
            command = 0x93d0;
            if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 8) fail('INVALID_PARAMS', 'Flash commit needs 1..8 files');
            const seen = new Set(); data.entries = input.entries.map((row, index) => {
                only(row, ['fileUuid', 'name', 'size', 'formatCode', 'fileIndex']);
                const result = { fileUuid: uuid(row.fileUuid), name: name(row.name), size: String(integer(row.size, U32, true)),
                    formatCode: Number(integer(row.formatCode, 27n, true)), fileIndex: Number(integer(row.fileIndex, 8n, true)) };
                if (result.fileIndex !== index + 1 || seen.has(result.fileUuid)) fail('INVALID_PARAMS', 'Flash commit file order is inconsistent'); seen.add(result.fileUuid); return result;
            });
            body = C([N(1, 1), S(2, data.filesetId), S(3, data.filesetId), ...data.entries.map(row => B(4, C([S(1, data.filesetId), S(2, row.fileUuid), N(3, 0), E(4), N(5, 1), N(6, row.fileIndex), N(7, row.formatCode), S(8, row.name), S(9, row.name), N(10, 0), N(11, row.size), N(12, 0), E(24)]))), N(5, 1), N(6, 1)]);
        } else if (operation === 'send') {
            command = 0x93d7;
            if ((input.targetUid === undefined) === (input.groupId === undefined)) fail('INVALID_PARAMS', 'Exactly one flash target is required');
            if (input.targetUid !== undefined) { data.targetUid = uid(input.targetUid); body = B(1, C([N(1, 1), B(2, S(1, data.targetUid))])); }
            else { data.groupId = String(integer(input.groupId, U32, true)); body = B(1, C([N(1, 2), B(3, N(1, data.groupId))])); }
            body = C([body, S(2, data.filesetId)]);
        } else {
            command = 0x12a9; sub = 200; mode = 1;
            Object.assign(data, { fileUuid: uuid(input.fileUuid), fileId: fileId(input.fileId), name: name(input.name), seq: sequence++ >>> 0 });
            body = C([mediaHead(sub, data.seq), B(3, C([
                B(1, C([B(1, C([S(4, data.name), B(5, C([N(1, 0), N(2, 0), N(3, 0), N(4, 0)]))])), S(2, data.fileId)])),
                B(2, C([B(2, C([N(1, 4294967294), N(3, 4294967295), N(5, 111), B(6, N(1, 3403722988))])), E(4),
                    B(10, C([S(1, data.filesetId), S(2, data.fileUuid), N(3, 26), S(4, data.fileUuid)]))]))]))]);
        }
    }
    return { operation, command, sub, mode, data, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: C([N(1, command), ...(sub ? [N(2, sub)] : []), B(4, body), ...(mode ? [N(12, mode)] : [])]) };
}
function fields(bytes, budget = { remaining: 20000 }) {
    // Scan before allocating; shared budget includes every nested message.
    let offset = 0;
    while (offset < bytes.length) {
        if (--budget.remaining < 0) fail('INVALID_RESPONSE', 'Flash field budget exceeded');
        const tag = p.readVarint(bytes, offset); offset = tag.offset; const wire = Number(tag.value & 7n);
        if (wire === 0) offset = p.readVarint(bytes, offset).offset;
        else if (wire === 2) { const len = p.readVarint(bytes, offset); offset = len.offset; if (len.value > BigInt(bytes.length - offset)) fail('INVALID_RESPONSE', 'Truncated flash response'); offset += Number(len.value); }
        else if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; if (offset > bytes.length) fail('INVALID_RESPONSE', 'Truncated flash scalar'); }
        else fail('INVALID_RESPONSE', 'Unsupported flash wire type');
    }
    const value = p.fields(bytes); value.budget = budget; return value;
}
function one(map, tag, wire, required = false) {
    const values = map.get(tag); if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'Invalid flash response field'); return values[0].value;
}
function uint(map, tag, max = U32, required = false) { const value = one(map, tag, 0, required); if (value !== undefined && value > max) fail('INVALID_RESPONSE', 'Flash integer overflow'); return value; }
function str(map, tag, max = 4096, required = false) {
    const bytes = one(map, tag, 2, required); if (bytes === undefined) return undefined;
    if (bytes.length > max) fail('INVALID_RESPONSE', 'Flash text exceeds its byte limit');
    try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (value.includes('\0')) throw new Error(); return value; }
    catch { fail('INVALID_RESPONSE', 'Invalid flash UTF-8'); }
}
function nested(map, tag, required = false) { const raw = one(map, tag, 2, required); return raw === undefined ? undefined : fields(raw, map.budget); }
function repeated(map, tag, max, decode) {
    const rows = map.get(tag) || []; if (rows.length > max || rows.some(row => row.wire !== 2)) fail('INVALID_RESPONSE', 'Flash list exceeds its entry limit');
    return rows.map(row => decode(fields(row.value, map.budget)));
}
function responseUuid(map, tag) { try { return uuid(str(map, tag, 36, true)); } catch { fail('INVALID_RESPONSE', 'QQ omitted a canonical flash UUID'); } }
function acknowledgementShape(map) {
    return [...map.entries()].sort(([left], [right]) => left - right).slice(0, 24).map(([tag, rows]) => {
        const types = [...new Set(rows.map(row => row.wire))].sort().join('/');
        return tag + ':' + types + 'x' + rows.length;
    }).join(',') + (map.size > 24 ? ',more' : '');
}
function acknowledgementDiagnostic(map, filesetId) {
    // Only schema and canonical-UUID equality flags may leave this diagnostic.
    // Bound depth, parsed bytes, field count and output separately from decoding.
    const budget = { remaining: 512 }; let remaining = 24;
    function describe(current, depth) {
        const children = [];
        for (const [tag, rows] of [...current.entries()].sort(([left], [right]) => left - right)) {
            for (let index = 0; index < rows.length; index++) {
                const row = rows[index]; if (row.wire !== 2) continue;
                if (--remaining < 0) { children.push('more'); return children.join(','); }
                const label = tag + '[' + index + ']';
                if (row.value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.value.toString('utf8'))) {
                    children.push(label + '{uuid_match=' + row.value.equals(Buffer.from(filesetId)) + '}');
                } else if (!row.value.length) children.push(label + '{empty}');
                else if (depth >= 3 || row.value.length > 8192 || budget.remaining <= 0) children.push(label + '{bounded}');
                else {
                    let child; try { child = fields(row.value, budget); } catch { children.push(label + '{opaque}'); continue; }
                    const nested = describe(child, depth + 1);
                    children.push(label + '{schema=' + acknowledgementShape(child) + (nested ? ';nested=' + nested : '') + '}');
                }
            }
        }
        return children.join(',');
    }
    return describe(map, 0).slice(0, 2048);
}
function deleteResultDiagnostic(map) {
    // Observed delete replies contain repeated f1 messages shaped as
    // {f1?:varint, f2:varint, f3:bytes}. These are diagnostic codes only:
    // neither the meaning of f1/f2 nor success semantics are yet proven.
    const rows = map.get(1);
    if (map.size !== 1 || !rows?.length || rows.length > 8 || rows.some(row => row.wire !== 2 || row.value.length > 8192)) return '';
    const values = [], budget = { remaining: 128 };
    for (let index = 0; index < rows.length; index++) {
        let item; try { item = fields(rows[index].value, budget); } catch { return ''; }
        if ([...item.keys()].some(tag => ![1, 2, 3].includes(tag)) || !item.has(2) || !item.has(3) ||
            [...item.entries()].some(([tag, fields]) => fields.length !== 1 || fields[0].wire !== (tag === 3 ? 2 : 0))) return '';
        const small = tag => !item.has(tag) ? 'omitted' : item.get(tag)[0].value <= 65535n ? String(item.get(tag)[0].value) : 'large';
        const message = item.get(3)[0].value;
        const status = message.equals(Buffer.from('success')) ? 'success' : message.equals(Buffer.from('error')) ? 'error' : 'opaque';
        let metadata = '';
        if (status === 'opaque') {
            let utf8 = true; try { new TextDecoder('utf-8', { fatal: true }).decode(message); } catch { utf8 = false; }
            metadata = '(bytes=' + message.length + ',utf8=' + utf8 + ',sha256=' + createHash('sha256').update(message).digest('hex') + ')';
        }
        values.push(index + '{f1=' + small(1) + ';f2=' + small(2) + ';f3=' + status + metadata + '}');
    }
    return values.join(',');
}
function officialDownload(value, expectedFileId) {
    let url; try { url = new URL(value); } catch { fail('INVALID_RESPONSE', 'Invalid flash main download URL'); }
    try { fileId(expectedFileId); } catch { fail('INVALID_RESPONSE', 'Invalid expected flash main file ID'); }
    if (value.length > 16384 || /[\x00-\x20\x7f]/.test(value) || url.protocol !== 'https:' || url.host !== 'multimedia.qfile.qq.com' || url.username || url.password || url.hash || url.pathname !== '/download' ||
        url.searchParams.getAll('appid').length !== 1 || url.searchParams.get('appid') !== '14901' || url.searchParams.getAll('fileid').length !== 1 || url.searchParams.get('fileid') !== expectedFileId || url.searchParams.getAll('rkey').length !== 1 || !/^[A-Za-z0-9_-]{1,8192}$/.test(url.searchParams.get('rkey'))) fail('INVALID_RESPONSE', 'QQ did not return a scoped main file download URL');
    return value;
}
function downloadBody(raw, expected, budget) {
    const strings = [], stack = [{ map: fields(raw, budget), size: raw.length, depth: 0 }]; let bytesSeen = 0;
    while (stack.length) {
        const { map, size, depth } = stack.pop(); bytesSeen += size;
        if (depth > 8 || bytesSeen > MAX_FRAME * 8) fail('INVALID_RESPONSE', 'Flash download nesting exceeds its limit');
        for (const rows of map.values()) for (const row of rows) if (row.wire === 2 && row.value.length) {
            if (row.value.length <= 16384 && row.value.every(byte => byte >= 0x20 && byte <= 0x7e)) strings.push(row.value.toString('ascii'));
            else if (depth < 8) { // Unknown nested bytes are parsed only as well-formed protobuf messages.
                try { const child = fields(row.value, budget); stack.push({ map: child, size: row.value.length, depth: depth + 1 }); }
                catch (error) { if (budget.remaining < 0) throw error; /* opaque binary */ }
            }
        }
    }
    const hosts = strings.filter(value => value === 'multimedia.qfile.qq.com');
    const paths = strings.filter(value => value.startsWith('/download?appid=14901'));
    const keys = strings.filter(value => /^&?rkey=[A-Za-z0-9_-]{1,8192}$/.test(value));
    const full = strings.filter(value => value.startsWith('https://multimedia.qfile.qq.com/download?appid=14901'));
    if (full.length === 1 && !paths.length && !hosts.length && !keys.length) return officialDownload(full[0], expected);
    if (hosts.length !== 1 || paths.length !== 1 || full.length || keys.length > 1) fail('INVALID_RESPONSE', 'QQ omitted an unambiguous main download URL');
    const base = 'https://' + hosts[0] + paths[0];
    const url = new URL(base);
    if (keys.length && url.searchParams.has('rkey')) fail('INVALID_RESPONSE', 'QQ repeated the flash download credential');
    return officialDownload(base + (keys.length ? '&' + keys[0].replace(/^&/, '') : ''), expected);
}
function decode(bytes, prepared) {
    if (!prepared || !Object.hasOwn(KEYS, prepared.operation) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FRAME) fail('INVALID_RESPONSE', 'No bounded flash response');
    const top = fields(bytes);
    if (uint(top, 1, U32, true) !== BigInt(prepared.command) || (uint(top, 2) ?? 0n) !== BigInt(prepared.sub) || top.has(12) && uint(top, 12) !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'QQ returned another flash command');
    if ((uint(top, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the flash operation; it was not retried');
    const raw = one(top, 4, 2), op = prepared.operation, request = prepared.data;
    // SnowLuma's fixed complete/status contracts acknowledge only the matched
    // OIDB envelope. An opaque stage ACK is not proof that files are uploaded:
    // create still requires every slice ACK and exact main metadata readback.
    if (op === 'complete' || op === 'ready') return { confirmed: true, confirmation: 'server_ack', filesetId: request.filesetId };
    if (op === 'delete' || op === 'rename') {
        if (raw?.length) {
            const ack = fields(raw, top.budget);
            const nested = acknowledgementDiagnostic(ack, request.filesetId);
            const codes = op === 'delete' ? deleteResultDiagnostic(ack) : '';
            fail('INVALID_RESPONSE', 'Unrecognized flash acknowledgement [op=' + op + ';schema=' + acknowledgementShape(ack) + (nested ? ';nested=' + nested : '') + (codes ? ';results=' + codes : '') + ']');
        }
        return { confirmed: true, confirmation: 'server_ack', filesetId: request.filesetId };
    }
    if (raw === undefined) fail('INVALID_RESPONSE', 'QQ omitted the flash response body');
    const body = fields(raw, top.budget);
    if (op === 'list' || op === 'detail') {
        const seen = new Set(); const items = repeated(body, 1, 1000, row => {
            const filesetId = responseUuid(row, 1); if (seen.has(filesetId) || op === 'detail' && filesetId !== request.filesetId) fail('INVALID_RESPONSE', 'QQ returned a different or duplicate fileset'); seen.add(filesetId);
            const item = { filesetId };
            if (row.has(2)) item.name = str(row, 2, 512);
            if (row.has(3)) item.origName = str(row, 3, 512);
            if (row.has(4)) item.type = Number(uint(row, 4));
            if (row.has(5)) item.size = String(uint(row, 5, U64));
            const share = nested(row, 8);
            if (share?.has(1)) { const link = str(share, 1, 2048); try { item.shareUrl = shareUrl(link); if (item.shareUrl !== link.replace(/\/$/, '')) throw new Error(); } catch { fail('INVALID_RESPONSE', 'QQ returned a nonofficial share link'); } }
            // f9 is a thumbnail. It is deliberately not exposed as download_url.
            return item;
        });
        return { items, complete: false, ...(op === 'detail' ? { filesetId: request.filesetId } : {}) };
    }
    if (op === 'metadata') {
        const entry = nested(body, 1, true), seen = new Set();
        const items = repeated(entry, 3, 18, row => {
            const filesetId = responseUuid(row, 1), fileUuid = responseUuid(row, 2), fileIndex = Number(uint(row, 6, U32, true));
            if (filesetId !== request.filesetId || !fileIndex || seen.has(fileIndex) || seen.has(fileUuid)) fail('INVALID_RESPONSE', 'QQ returned inconsistent flash main metadata'); seen.add(fileIndex); seen.add(fileUuid);
            const main = nested(row, 14), id = main ? str(main, 1, 4096) : undefined;
            if (id) { try { fileId(id); } catch { fail('INVALID_RESPONSE', 'Invalid main file ID'); } }
            return { filesetId, fileUuid, fileIndex, name: str(row, 8, 512, true), size: String(uint(row, 11, U64, true)), ...(id ? { fileId: id } : {}) };
        });
        return { items, filesetId: request.filesetId, complete: false };
    }
    if (op === 'create') {
        const filesetId = responseUuid(body, 1);
        const uploadKey = str(body, 2, 4096); if (uploadKey !== undefined && uploadKey !== filesetId) fail('INVALID_RESPONSE', 'QQ returned another flash upload session');
        return { filesetId };
    }
    if (op === 'commit') {
        const filesetId = responseUuid(body, 2), key = str(body, 3, 4096);
        if (filesetId !== request.filesetId || key !== undefined && key !== filesetId) fail('INVALID_RESPONSE', 'QQ committed another flash fileset');
        return { confirmed: true, filesetId };
    }
    if (op === 'send') {
        const target = nested(nested(body, 1, true), 3, true), type = uint(target, 1, U32, true);
        if (request.targetUid ? type !== 1n || str(nested(target, 2, true), 1, 128, true) !== request.targetUid || target.has(3) : type !== 2n || String(uint(nested(target, 3, true), 1, U32, true)) !== request.groupId || target.has(2)) fail('INVALID_RESPONSE', 'QQ acknowledged another flash recipient');
        return { confirmed: true, confirmation: 'target_ack', filesetId: request.filesetId, ...(request.targetUid ? { targetUid: request.targetUid } : { groupId: request.groupId }) };
    }
    const head = nested(body, 1, true), correlation = nested(head, 1, true);
    if (uint(correlation, 1, U32, true) !== BigInt(request.seq) || uint(correlation, 2, U32, true) !== BigInt(prepared.sub) || str(head, 3, 128, true) !== 'success') fail('INVALID_RESPONSE', 'QQ did not confirm the exact flash transfer step');
    if (op === 'prepare') {
        const wrap = nested(body, 2, true), key = str(wrap, 1, 8192);
        if (key !== undefined && !/^[A-Za-z0-9_-]{1,8192}$/.test(key)) fail('INVALID_RESPONSE', 'Invalid scoped flash upload credential');
        // LLBot 0308b628: FlashFileUploadResp.body.fastUploadInfo.summary.fileSummary.
        // No synthetic fallback: an ACK/uKey alone cannot supply a commit token.
        const summary = nested(nested(nested(wrap, 6, true), 1, true), 1, true);
        const grant = uploadGrant({ token: str(summary, 2, 4096, true), time: Number(uint(summary, 4, U32, true)), ttl: Number(uint(summary, 5, U32, true)) });
        return { uploadKey: key ?? null, ...grant, filesetId: request.filesetId, fileUuid: request.fileUuid };
    }
    if (op === 'apply') return { confirmed: true, filesetId: request.filesetId, fileUuid: request.fileUuid };
    return { url: downloadBody(one(body, 3, 2, true), request.fileId, body.budget), filesetId: request.filesetId, fileUuid: request.fileUuid };
}
function sliceBody(bytes, uploadKey, appid = 14901) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024 || ![14901, 14902, 14903].includes(appid) || !/^[A-Za-z0-9_-]{1,8192}$/.test(uploadKey)) fail('INVALID_PARAMS', 'Invalid bounded flash slice');
    const sha1 = require('node:crypto').createHash('sha1').update(bytes).digest();
    return C([N(1, 0), N(2, appid), N(3, 2), B(107, C([E(1), S(2, uploadKey), N(3, 0), N(4, bytes.length - 1), B(5, sha1), B(6, B(1, sha1)), B(7, bytes)]))]);
}
function decodeSlice(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536 || str(fields(bytes), 5, 128, true) !== 'success') fail('QUERY_FAILED', 'QQ did not confirm flash slice storage');
    return true;
}
module.exports = { prepare, decode, name, uuid, uid, integer, object, shareUrl, officialDownload, uploadGrant, sliceBody, decodeSlice, MAX_FRAME };
