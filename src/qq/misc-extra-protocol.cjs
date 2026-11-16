'use strict';
const p = require('./proto.cjs');
const { validateArk } = require('./share-oidb.cjs');
const n = p.varintField, b = p.bytesField, s = (tag, value) => b(tag, Buffer.from(value)), m = (tag, values) => b(tag, Buffer.concat(values));
const OPERATIONS = new Set(['miniapp.ark', 'card.send', 'group.sign', 'self.diy', 'button.click']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function integer(value, positive = false, maximum = 0xffffffffn) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) || !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) > maximum || positive && BigInt(value) === 0n) fail('INVALID_PARAMS', 'Expected an exact bounded misc integer');
    return String(value);
}
function text(value, maximum = 4096, empty = true, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !empty && !value.length || Buffer.byteLength(value) > maximum || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail(code, 'Invalid bounded misc text'); return value;
}
function url(value, empty = false) {
    text(value, 4096, empty); if (empty && !value) return value;
    if (/\s|\\|[\x00-\x1f\x7f]/.test(value)) fail('INVALID_PARAMS', 'Invalid card URL');
    let parsed; try { parsed = new URL(value); } catch { fail('INVALID_PARAMS', 'Invalid card URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) fail('INVALID_PARAMS', 'Expected an HTTP card URL'); return value;
}
function prepare(operation, input = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed misc operation');
    const allowed = { 'miniapp.ark': ['type', 'title', 'desc', 'picUrl', 'jumpUrl'], 'card.send': ['targetId', 'peerType', 'title', 'desc', 'summary', 'previewUrl', 'jumpUrl'],
        'group.sign': ['selfUin', 'groupId'], 'self.diy': ['faceId', 'wording', 'faceType'], 'button.click': ['groupId', 'botAppid', 'msgSeq', 'buttonId', 'callbackData'] }[operation];
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key))) fail('INVALID_PARAMS', 'Unexpected fixed misc fields');
    const data = {}; let command, sub = 1, body, name;
    if (operation === 'miniapp.ark') {
        if (!['bili', 'weibo'].includes(input.type)) fail('INVALID_PARAMS', 'Miniapp type must be bili or weibo');
        Object.assign(data, { type: input.type, title: text(input.title), desc: text(input.desc), picUrl: url(input.picUrl, true), jumpUrl: url(input.jumpUrl, true) });
        const bili = data.type === 'bili';
        name = 'LightAppSvc.mini_app_share.AdaptShareInfo';
        body = Buffer.concat([s(2, 'V1_PC_MINISDK_99.99.99_1_APP_A'), m(4, [s(2, bili ? '1109937557' : '1109224783'), s(3, data.title), s(4, data.desc), s(9, data.picUrl), s(11, data.jumpUrl),
            s(12, 'http://miniapp.gtimg.cn/public/appicon/' + (bili ? '51f90239b78a2e4994c11215f4c4ba15' : '35bbb44dc68e65194cfacfb206b8f1f7') + '_200.jpg')])]);
    } else if (operation === 'self.diy') {
        Object.assign(data, { faceId: integer(input.faceId), wording: text(input.wording, 1024), faceType: integer(input.faceType) });
        name = 'trpc.qq_new_tech.status_svc.StatusService.SetStatus';
        body = Buffer.concat([n(1, 10), n(2, 2000), n(3, 0), m(4, [n(1, data.faceId), s(2, data.wording), n(3, data.faceType)])]);
    } else if (operation === 'group.sign') {
        Object.assign(data, { selfUin: integer(input.selfUin, true), groupId: integer(input.groupId, true) }); command = 0xeb7;
        body = m(2, [s(1, data.selfUin), s(2, data.groupId), s(3, '9.0.90')]);
        name = 'OidbSvcTrpcTcp.0xEB7_1';
    } else if (operation === 'button.click') {
        Object.assign(data, { groupId: integer(input.groupId, true), botAppid: integer(input.botAppid, true), msgSeq: integer(input.msgSeq, true, 0xffffffffffffffffn),
            buttonId: text(input.buttonId, 1024, false), callbackData: text(input.callbackData) }); command = 0x112e;
        body = Buffer.concat([n(3, data.botAppid), n(4, data.msgSeq), s(5, data.buttonId), s(6, data.callbackData), n(7, 0), n(8, data.groupId), n(9, 1)]);
    } else {
        if (![0, 1].includes(input.peerType)) fail('INVALID_PARAMS', 'Card peerType must be 0 or 1');
        Object.assign(data, { targetId: integer(input.targetId, true), peerType: input.peerType, title: text(input.title), desc: text(input.desc), summary: text(input.summary, 1024),
            previewUrl: url(input.previewUrl, true), jumpUrl: url(input.jumpUrl) }); command = 0xdc2; sub = 34;
        body = Buffer.concat([m(1, [n(1, 100446242), n(2, 1), n(3, 0), m(5, [n(1, 1)]), n(11, data.targetId),
            m(12, [n(1, 1), s(10, data.title), s(11, data.desc), s(12, data.summary), s(13, data.jumpUrl), s(14, data.previewUrl)])]), m(2, [n(1, data.peerType), n(2, data.targetId)])]);
    }
    if (command !== undefined) { name ||= 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub; body = Buffer.concat([n(1, command), n(2, sub), n(3, 0), b(4, body), n(12, 0)]); }
    return { operation, data, command, sub, name, body, allowEmptyResponse: operation === 'self.diy' };
}
function one(map, field, wire, required = false) {
    const entries = map.get(field); if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed or duplicate misc response field'); return entries[0].value;
}
function uint(map, field, required = false) { const value = one(map, field, 0, required); if (value !== undefined && value > 0xffffffffn) fail('INVALID_RESPONSE', 'Misc response integer exceeds uint32'); return value; }
function str(map, field, required = false, maximum = 4096) {
    const value = one(map, field, 2, required); if (value === undefined) return undefined;
    try { return text(new TextDecoder('utf-8', { fatal: true }).decode(value), maximum, true, 'INVALID_RESPONSE'); } catch { fail('INVALID_RESPONSE', 'Invalid bounded misc response UTF-8'); }
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024 || !OPERATIONS.has(prepared?.operation) || !bytes.length && !prepared.allowEmptyResponse) fail('INVALID_RESPONSE', 'No bounded fixed misc response');
    let body = p.fields(bytes); const operation = prepared.operation, data = prepared.data;
    if (prepared.command !== undefined) {
        if (uint(body, 1, true) !== BigInt(prepared.command) || (uint(body, 2) ?? 0n) !== BigInt(prepared.sub) || body.has(12) && uint(body, 12) !== 0n) fail('INVALID_RESPONSE', 'QQ returned another fixed misc command');
        if ((uint(body, 3) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected the fixed misc operation');
        const raw = one(body, 4, 2); if (raw === undefined && operation !== 'group.sign') fail('INVALID_RESPONSE', 'QQ omitted the misc business response');
        body = p.fields(raw || Buffer.alloc(0));
    }
    const binding = { operation, ...data };
    if (operation === 'miniapp.ark') {
        if ((uint(body, 2) ?? 0n) !== 0n) fail('KERNEL_ERROR', 'QQ rejected miniapp sharing');
        const raw = str(p.fields(one(body, 4, 2, true)), 2, true, 262144); let parsed;
        try { parsed = JSON.parse(raw); } catch { fail('INVALID_RESPONSE', 'QQ returned malformed miniapp Ark'); }
        if (!object(parsed) || !['ver', 'prompt', 'config', 'appName', 'appView', 'metaData'].every(key => Object.hasOwn(parsed, key))) fail('INVALID_RESPONSE', 'QQ omitted miniapp Ark fields');
        const ark = { ver: parsed.ver, prompt: parsed.prompt, config: parsed.config, app: parsed.appName, view: parsed.appView, meta: parsed.metaData, miniappShareOrigin: 3, miniappOpenRefer: '10002' };
        validateArk(JSON.stringify(ark)); return { ...binding, result: { data: ark } };
    }
    if (operation === 'self.diy') {
        if ((uint(body, 1) ?? 0n) !== 0n || !['', 'set status success'].includes(str(body, 2) ?? '')) fail('KERNEL_ERROR', 'QQ rejected the custom online status');
    } else if (operation === 'card.send') {
        const entries = body.get(1);
        if (!entries || entries.length !== 1 || entries[0].wire !== 2) fail('INVALID_RESPONSE', 'QQ supplied no unique card delivery result');
        const deliveryCode = uint(p.fields(entries[0].value), 4) ?? 0n;
        if (deliveryCode !== 0n) fail('KERNEL_ERROR', 'QQ rejected the card delivery (code=' + deliveryCode + ')');
    } else if (operation === 'button.click') {
        const code = uint(body, 3) ?? 0n;
        if (code !== 0n) fail('KERNEL_ERROR', 'QQ rejected the inline button operation (code=' + code + ')');
        return { ...binding, result: { result: 0, errMsg: str(body, 5) ?? '', status: 0, promptText: str(body, 4) ?? '', promptType: 0, promptIcon: 0 } };
    } else if (body.size) fail('INVALID_RESPONSE', 'Unrecognized group sign acknowledgement');
    return { ...binding, confirmed: true, confirmation: 'server_ack' };
}
module.exports = { OPERATIONS, prepare, decode, integer, text, url, object };
