'use strict';

const wire = require('./proto.cjs');
const p = require('./qzone-protocol.cjs');
const { annotate } = require('../diagnostics.cjs');
function rejected(message, phase, businessCode) {
    throw annotate(Object.assign(new Error(message), { code: 'KERNEL_ERROR' }), { reason: 'business_rejected', phase, businessCode });
}
const n = wire.varintField, b = wire.bytesField, m = wire.messageField, s = (field, value) => b(field, Buffer.from(value));
function one(fields, field, type, required = false) { const entries = fields.get(field); if (!entries && !required) return undefined; if (!entries || entries.length !== 1 || entries[0].wire !== type) p.fail('INVALID_RESPONSE', 'Malformed voice protocol field'); return entries[0].value; }
function text(fields, field, maximum = 1024, required = false) { const bytes = one(fields, field, 2, required); if (bytes === undefined) return undefined; if (bytes.length > maximum) p.fail('INVALID_RESPONSE', 'Voice protocol text exceeded its byte budget'); try { const value = new TextDecoder('utf8', { fatal: true }).decode(bytes); p.string(value, maximum, !required, 'INVALID_RESPONSE'); return value; } catch { p.fail('INVALID_RESPONSE', 'Voice protocol text is invalid UTF-8'); } }
function small(fields, field, required = false) { const value = one(fields, field, 0, required); if (value === undefined) return undefined; if (value > 0xffffffffn) p.fail('INVALID_RESPONSE', 'Voice protocol integer is out of range'); return Number(value); }
function nested(fields, field, required = false) { const value = one(fields, field, 2, required); return value === undefined ? undefined : wire.fields(value); }
function uuid(value, code = 'INVALID_PARAMS') { p.string(value, 512, false, code); if (/[\x00-\x20\x7f]/.test(value)) p.fail(code, 'Invalid exact voice media UUID'); return value; }
function digest(value, code = 'INVALID_PARAMS') { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value)) p.fail(code, 'A voice requires an actual MD5 digest'); return value.toLowerCase(); }
function node(value, code = 'INVALID_PARAMS') {
    if (!p.object(value) || Object.keys(value).some(key => !['info', 'fileUuid', 'storeId', 'uploadTime', 'ttl', 'subType'].includes(key)) || !p.object(value.info) ||
        Object.keys(value.info).some(key => !['fileSize', 'fileHash', 'fileSha1', 'fileName', 'type', 'width', 'height', 'time', 'original'].includes(key))) p.fail(code, 'Invalid closed voice media index');
    const info = { fileSize: p.integer(value.info.fileSize, 10485760, 1, code), fileHash: digest(value.info.fileHash, code) };
    for (const field of ['fileName', 'fileSha1']) if (value.info[field] !== undefined) info[field] = p.string(value.info[field], 1024, true, code);
    for (const field of ['width', 'height', 'time', 'original']) if (value.info[field] !== undefined) info[field] = p.integer(value.info[field], 0xffffffff, 0, code);
    if (value.info.type !== undefined) {
        const type = value.info.type;
        if (!p.object(type) || Object.keys(type).some(key => !['type', 'picFormat', 'videoFormat', 'voiceFormat'].includes(key))) p.fail(code, 'Invalid closed voice file type');
        info.type = {}; for (const field of Object.keys(type)) info.type[field] = p.integer(type[field], 0xffffffff, 0, code);
        if (type.type !== undefined && type.type !== 3) p.fail(code, 'AI synthesis returned a different media kind');
    }
    const result = { fileUuid: uuid(value.fileUuid, code), info };
    for (const field of ['storeId', 'uploadTime', 'ttl', 'subType']) if (value[field] !== undefined) result[field] = p.integer(value[field], 0xffffffff, 0, code);
    return result;
}
const OPERATIONS = new Set(['voice.synthesize', 'voice.url']);
function prepare(operation, data = {}) {
    if (!OPERATIONS.has(operation)) p.fail('UNSUPPORTED', 'Unknown fixed AI voice protocol operation');
    const allowed = operation === 'voice.synthesize' ? ['groupId', 'character', 'text', 'chatType', 'sessionId'] : ['groupId', 'node'];
    if (!p.object(data) || Object.keys(data).some(key => !allowed.includes(key))) p.fail('INVALID_PARAMS', 'Unexpected fixed AI voice protocol field');
    const groupId = p.uin(data.groupId); let body, command, mode = 1, request = { ...data, groupId };
    if (operation === 'voice.synthesize') {
        const character = p.string(data.character, 128, false), content = p.string(data.text, 4096, false), chatType = p.integer(data.chatType ?? 1, 2, 0), sessionId = p.integer(data.sessionId, 0xffffffff, 1);
        command = 0x929b; request = { groupId, character, text: content, chatType, sessionId };
        body = Buffer.concat([n(1, groupId), s(2, character), s(3, content), n(4, chatType), m(5, [n(1, sessionId)])]);
    } else {
        command = 0x126e; mode = 1; const selected = node(data.node); request.node = selected;
        const info = selected.info, type = info.type || {};
        const typeBody = Object.entries({ type: 1, picFormat: 2, videoFormat: 3, voiceFormat: 4 }).filter(([key]) => type[key] !== undefined).map(([key, field]) => n(field, type[key]));
        const infoParts = [n(1, info.fileSize), s(2, info.fileHash), ...(info.fileSha1 !== undefined ? [s(3, info.fileSha1)] : []), ...(info.fileName !== undefined ? [s(4, info.fileName)] : []), ...(info.type !== undefined ? [m(5, typeBody)] : [])];
        for (const [field, key] of [[6, 'width'], [7, 'height'], [8, 'time'], [9, 'original']]) if (info[key] !== undefined) infoParts.push(n(field, info[key]));
        const index = [m(1, infoParts), s(2, selected.fileUuid)];
        for (const [field, key] of [[3, 'storeId'], [4, 'uploadTime'], [5, 'ttl'], [6, 'subType']]) if (selected[key] !== undefined) index.push(n(field, selected[key]));
        const head = m(1, [m(1, [n(1, 4), n(2, 200)]), m(2, [n(101, 1), n(102, 3), n(200, 2), m(202, [n(1, groupId)])]), m(3, [n(1, 2)])]);
        body = Buffer.concat([head, m(3, [m(1, index), m(2, [m(2, [n(1, 0), n(2, 0)])])])]);
    }
    const sub = operation === 'voice.synthesize' ? 0 : 200;
    return { operation, command, sub, mode, data: request, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: Buffer.concat([n(1, command), n(2, sub), n(3, 0), b(4, body), n(12, mode)]) };
}
function decode(buffer, prepared) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 1048576) p.fail('INVALID_RESPONSE', 'Invalid bounded AI voice response');
    const outer = wire.fields(buffer);
    if (small(outer, 1, true) !== prepared.command || (small(outer, 2) ?? 0) !== prepared.sub || small(outer, 12) !== undefined && small(outer, 12) !== prepared.mode) p.fail('INVALID_RESPONSE', 'AI voice OIDB command or mode mismatch');
    const envelopeCode = small(outer, 3) ?? 0;
    if (envelopeCode !== 0) rejected('QQ rejected the AI voice operation; phase=oidb-envelope; business_code=' + envelopeCode, 'dispatch', envelopeCode);
    const body = nested(outer, 4, prepared.operation !== 'voice.synthesize') || new Map();
    if (prepared.operation === 'voice.synthesize') {
        const synthesisCode = small(body, 1) ?? 0;
        // The target build returned status 1 with a complete msgInfo and an
        // independently confirmed new group PTT. The code alone is not success.
        if (synthesisCode !== 0 && synthesisCode !== 1) rejected('QQ rejected AI voice synthesis; phase=synthesis-body; business_code=' + synthesisCode, 'synthesize', synthesisCode);
        const info = nested(body, 4);
        if (!info) {
            if (synthesisCode === 1) p.fail('QUERY_FAILED', 'AI voice status 1 omitted its complete media index; no synthesis retry is permitted');
            return { ...prepared.data, pending: true };
        }
        const entries = info.get(1) || [];
        if (!entries.length) {
            if (synthesisCode === 1) p.fail('QUERY_FAILED', 'AI voice status 1 omitted its complete media index; no synthesis retry is permitted');
            return { ...prepared.data, pending: true };
        }
        if (entries.length !== 1 || entries[0].wire !== 2) p.fail('INVALID_RESPONSE', 'QQ returned ambiguous AI voice media nodes');
        const index = nested(wire.fields(entries[0].value), 1, true), file = nested(index, 1, true), type = nested(file, 5);
        if (synthesisCode === 1 && (!type || small(type, 1, true) !== 3)) p.fail('INVALID_RESPONSE', 'AI voice status 1 did not identify an exact voice media index');
        const decoded = { fileUuid: text(index, 2, 512, true), info: { fileSize: small(file, 1, true), fileHash: text(file, 2, 32, true) } };
        for (const [field, key] of [[3, 'fileSha1'], [4, 'fileName']]) { const value = text(file, field); if (value !== undefined) decoded.info[key] = value; }
        for (const [field, key] of [[6, 'width'], [7, 'height'], [8, 'time'], [9, 'original']]) { const value = small(file, field); if (value !== undefined) decoded.info[key] = value; }
        if (type) { decoded.info.type = {}; for (const [field, key] of [[1, 'type'], [2, 'picFormat'], [3, 'videoFormat'], [4, 'voiceFormat']]) { const value = small(type, field); if (value !== undefined) decoded.info.type[key] = value; } }
        for (const [field, key] of [[3, 'storeId'], [4, 'uploadTime'], [5, 'ttl'], [6, 'subType']]) { const value = small(index, field); if (value !== undefined) decoded[key] = value; }
        return { ...prepared.data, pending: false, node: node(decoded, 'INVALID_RESPONSE') };
    }
    const head = nested(body, 1, true), downloadCode = small(head, 2) ?? 0;
    if (downloadCode !== 0) rejected('QQ rejected the voice download query; phase=download-head; business_code=' + downloadCode, 'download', downloadCode);
    const download = nested(body, 3, true), source = nested(download, 3, true), domain = text(source, 1, 253, true), path = text(source, 2, 8192, true), key = text(download, 1, 8192) || '';
    if (!/^[a-z0-9.-]+\.qq\.com(?:\.cn)?$/i.test(domain) || !path.startsWith('/') || path.startsWith('//')) p.fail('INVALID_RESPONSE', 'QQ supplied no fixed official voice source');
    const url = new URL('https://' + domain + path + key);
    if (url.hostname !== domain || url.username || url.password || url.port || url.hash) p.fail('INVALID_RESPONSE', 'QQ voice download source identity is inconsistent');
    return { groupId: prepared.data.groupId, fileUuid: prepared.data.node.fileUuid, url: url.href };
}
module.exports = { OPERATIONS, prepare, decode, node, uuid, digest };
