'use strict';

// Fixed group settings, category tags, share URLs and todo commands. Settings
// GET tags and modification tags are intentionally different wire domains.
const p = require('./proto.cjs');
const U32 = 0xffffffffn, U64 = 0xffffffffffffffffn;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OPERATIONS = new Set(['group.settingsDetail', 'group.robotDetail', 'group.tags', 'group.shareLink',
    'group.addOption', 'group.search', 'group.robotOption', 'group.invitePolicy', 'group.historyVisibility', 'group.memberPermission',
    'group.tagAdd', 'group.tagDelete', 'todo.set', 'todo.complete', 'todo.cancel']);
const INVITE_MASK = 0x06100000, INVITE_BITS = Object.freeze({ disabled: 0x04000000, require_approval: 0, no_approval: 0x00100000, no_approval_under_100: 0x02000000 });
const PERMISSION_MASKS = Object.freeze({ upload_album: 1, temporary_session: 0x10000, create_group: 0x8000 });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function fields(value, allowed) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected fixed group settings parameters');
}
function uint(value, label, max = U32, min = 0n) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) < min || BigInt(value) > max) fail('INVALID_PARAMS', 'Invalid exact ' + label);
    return String(value);
}
function text(value, label, max = 4096, empty = true) {
    if (typeof value !== 'string' || !empty && !value.length || value.includes('\0') || Buffer.byteLength(value) > max || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid bounded ' + label);
    return value;
}
function bool(value) { if (typeof value !== 'boolean') fail('INVALID_PARAMS', 'Expected an explicit group setting boolean'); return value; }
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8')), join = (...parts) => Buffer.concat(parts);
function mergeInvite(current, policy) {
    if (!Object.hasOwn(INVITE_BITS, policy)) fail('INVALID_PARAMS', 'Unknown group member invitation policy');
    return Number(BigInt(uint(current, 'current privilege flag')) & ~BigInt(INVITE_MASK) | BigInt(INVITE_BITS[policy]));
}
function mergePermission(current, permission, allow) {
    if (!Object.hasOwn(PERMISSION_MASKS, permission)) fail('INVALID_PARAMS', 'Unknown group member permission');
    const flag = BigInt(uint(current, 'current privilege flag')), mask = BigInt(PERMISSION_MASKS[permission]);
    return Number(bool(allow) ? flag & ~mask : flag | mask);
}
function invitePolicy(flag) {
    const value = BigInt(flag);
    return value & 0x4000000n ? 'disabled' : value & 0x2000000n ? 'no_approval_under_100' : value & 0x100000n ? 'no_approval' : 'require_approval';
}
function historyVisible(flag) { return flag === 1 || (BigInt(flag) & 4n) !== 0n; }
const PARAMETERS = Object.freeze({
    'group.settingsDetail': ['groupId'], 'group.robotDetail': ['groupId'], 'group.tags': ['groupClass'],
    'group.shareLink': ['groupId', 'needShortUrl', 'srcId', 'additionalParam'],
    'group.addOption': ['groupId', 'addType', 'groupQuestion', 'groupAnswer'], 'group.search': ['groupId', 'noFingerOpen', 'noCodeFingerOpen'],
    'group.robotOption': ['groupId', 'robotMemberSwitch', 'robotMemberExamine'],
    'group.invitePolicy': ['groupId', 'currentPrivilegeFlag', 'policy'], 'group.historyVisibility': ['groupId', 'visible'],
    'group.memberPermission': ['groupId', 'currentPrivilegeFlag', 'permission', 'allow'],
    'group.tagAdd': ['groupClass', 'name'], 'group.tagDelete': ['groupClass', 'name'],
    'todo.set': ['groupId', 'sequence'], 'todo.complete': ['groupId', 'sequence'], 'todo.cancel': ['groupId', 'sequence']
});
function prepare(operation, value = {}) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed group administration operation');
    fields(value, PARAMETERS[operation]);
    let command, sub = 0, mode = 0, body;
    const data = {};
    if (PARAMETERS[operation].includes('groupId')) data.groupId = uint(value.groupId, 'group ID', U32, 1n);
    if (PARAMETERS[operation].includes('groupClass')) data.groupClass = Number(uint(value.groupClass, 'group category'));
    if (operation === 'group.settingsDetail') {
        command = 0x88d;
        const flags = join(...[1, 7, 21, 56, 101, 82, 83].map(field => n(field, 1)), s(24, ''), s(25, ''));
        body = join(n(1, 537099973), b(2, join(n(1, data.groupId), b(2, flags))));
    } else if (operation === 'group.robotDetail') {
        command = 0xef0; sub = 1; mode = 1;
        body = join(n(1, data.groupId), b(2, join(n(29, 1), n(30, 1))));
    } else if (['group.tags', 'group.tagAdd', 'group.tagDelete'].includes(operation)) {
        command = operation === 'group.tags' ? 0x967c : operation === 'group.tagAdd' ? 0x967d : 0x967e;
        body = n(1, data.groupClass);
        if (operation !== 'group.tags') { data.name = text(value.name, 'group category tag', 1024, false); body = join(body, s(2, data.name)); }
    } else if (operation === 'group.shareLink') {
        command = 0x9060; sub = 3; mode = 1;
        data.needShortUrl = bool(value.needShortUrl); data.srcId = Number(uint(value.srcId, 'share source ID')); data.additionalParam = text(value.additionalParam, 'share additional parameter');
        // srcId is a validated compatibility parameter; the real wire omits it.
        body = join(n(1, 2), b(12, join(n(1, data.groupId), s(3, data.additionalParam), n(4, data.needShortUrl ? 1 : 0))));
    } else if (operation.startsWith('todo.')) {
        command = 0xf90; sub = { 'todo.set': 1, 'todo.complete': 2, 'todo.cancel': 3 }[operation];
        data.sequence = uint(value.sequence, 'todo message sequence', U64, 1n); body = join(n(1, data.groupId), n(2, data.sequence));
    } else if (operation === 'group.robotOption') {
        command = 0xf00; sub = 3; mode = 1;
        const settings = [];
        for (const [key, field] of [['robotMemberSwitch', 29], ['robotMemberExamine', 30]]) if (value[key] !== undefined) {
            data[key] = Number(uint(value[key], 'robot option')); settings.push(n(field, data[key]));
        }
        if (!settings.length) fail('INVALID_PARAMS', 'At least one robot setting is required');
        body = join(n(1, data.groupId), b(2, join(n(1, data.groupId), b(2, join(...settings)))));
    } else {
        command = 0x89a; const settings = [];
        if (operation === 'group.addOption') {
            data.addType = Number(uint(value.addType, 'join option')); const type = data.addType === 55 ? 5 : data.addType;
            settings.push(n(16, type));
            for (const key of ['groupQuestion', 'groupAnswer']) if (value[key] !== undefined) data[key] = text(value[key], 'group join question or answer');
            if ([4, 5].includes(type)) settings.push(s(30, data.groupQuestion ?? ''), s(31, type === 4 ? data.groupAnswer ?? '' : ''));
        } else if (operation === 'group.search') {
            for (const [key, field] of [['noFingerOpen', 35], ['noCodeFingerOpen', 36]]) if (value[key] !== undefined) { data[key] = Number(uint(value[key], 'group search option')); settings.push(n(field, data[key])); }
            if (!settings.length) fail('INVALID_PARAMS', 'At least one search option is required');
        } else if (operation === 'group.invitePolicy') {
            data.currentPrivilegeFlag = Number(uint(value.currentPrivilegeFlag, 'current privilege flag')); data.policy = value.policy;
            settings.push(n(23, mergeInvite(data.currentPrivilegeFlag, data.policy)), n(24, INVITE_MASK), n(29, data.policy === 'disabled' ? 0 : 1));
        } else if (operation === 'group.historyVisibility') {
            data.visible = bool(value.visible); settings.push(n(42, data.visible ? 4 : 0), n(43, 4));
        } else {
            data.currentPrivilegeFlag = Number(uint(value.currentPrivilegeFlag, 'current privilege flag')); data.permission = value.permission; data.allow = bool(value.allow);
            settings.push(n(23, mergePermission(data.currentPrivilegeFlag, data.permission, data.allow)), n(24, PERMISSION_MASKS[data.permission]));
        }
        body = join(n(1, data.groupId), b(2, join(...settings)));
    }
    return { operation, command, sub, mode, data, name: 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub,
        body: join(n(1, command), n(2, sub), n(3, 0), b(4, body), n(12, mode)) };
}
function one(map, field, wire, required = false) {
    const values = map.get(field);
    if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed fixed group administration field');
    return values[0].value;
}
function number(map, field, max = U32, required = false) {
    const value = one(map, field, 0, required) ?? 0n;
    if (value > max) fail('INVALID_RESPONSE', 'Group administration result integer is out of range');
    return Number(value);
}
function string(map, field, max = 4096, fallback = '') {
    const value = one(map, field, 2);
    if (value === undefined) return fallback;
    if (value.length > max) fail('INVALID_RESPONSE', 'Group administration response text exceeds its bound');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { fail('INVALID_RESPONSE', 'Group administration response has invalid UTF-8'); }
}
function nested(map, field, required = false) { const bytes = one(map, field, 2, required); return bytes === undefined ? null : p.fields(bytes); }
function list(map, field, max = 1000) {
    const values = map.get(field) || [];
    if (values.length > max || values.some(value => value.wire !== 2)) fail('INVALID_RESPONSE', 'Group administration result list exceeds its bound');
    return values.map(value => p.fields(value.value));
}
function status(map, field, signed = false) {
    const value = one(map, field, 0) ?? 0n;
    if (value > U32 && !(signed && value >= U64 - 0x7fffffffn)) fail('INVALID_RESPONSE', 'Group administration business status is malformed');
    if (value !== 0n) fail('KERNEL_ERROR', 'QQ rejected the group administration operation (code=' + (signed ? BigInt.asIntN(32, value) : value) + '); it was not retried');
}
function validateUrl(value) {
    let url;
    try { url = new URL(value); } catch { fail('INVALID_RESPONSE', 'QQ returned no absolute group share URL'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /[\x00-\x20\x7f]/.test(value)) fail('INVALID_RESPONSE', 'QQ returned an invalid group share URL');
    return value;
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'No bounded group administration response');
    const top = p.fields(bytes), mode = one(top, 12, 0);
    if (one(top, 1, 0, true) !== BigInt(prepared.command) || (one(top, 2, 0) ?? 0n) !== BigInt(prepared.sub) ||
        mode !== undefined && mode !== BigInt(prepared.mode)) fail('INVALID_RESPONSE', 'Group administration response belongs to another operation');
    status(top, 3);
    const raw = one(top, 4, 2), body = p.fields(raw ?? Buffer.alloc(0)), result = { operation: prepared.operation, ...prepared.data };
    if (prepared.operation === 'group.settingsDetail') {
        const group = nested(body, 1, true), detail = nested(group, 3, true);
        if (number(group, 1, U32, true) !== Number(prepared.data.groupId) || detail.has(21) && number(detail, 21, U32) !== Number(prepared.data.groupId)) fail('INVALID_RESPONSE', 'Group settings belong to another group');
        result.detail = { addType: number(detail, 7), question: string(detail, 24), answer: string(detail, 25), privilegeFlag: number(detail, 56),
            groupFlagExt4: number(detail, 101), noFingerOpen: number(detail, 82), noCodeFingerOpen: number(detail, 83), ownerUid: string(detail, 1, 128) };
        if (!detail.size || result.detail.ownerUid && !/^u_[A-Za-z0-9_-]{1,126}$/.test(result.detail.ownerUid)) fail('INVALID_RESPONSE', 'QQ returned incomplete group administration settings');
    } else if (prepared.operation === 'group.robotDetail') {
        const items = list(body, 1, 32), item = items.find(value => number(value, 1, U32, true) === Number(prepared.data.groupId));
        if (!item || items.filter(value => number(value, 1, U32, true) === Number(prepared.data.groupId)).length !== 1) fail('INVALID_RESPONSE', 'QQ omitted the exact group robot settings');
        status(item, 2); const ext = nested(item, 3, true);
        result.robot = { robotMemberSwitch: number(ext, 29), robotMemberExamine: number(ext, 30) };
    } else if (prepared.operation === 'group.tags') {
        if (raw === undefined) fail('INVALID_RESPONSE', 'QQ omitted the group category tag response');
        const seen = new Set();
        result.tags = list(body, 1, 1000).map(tag => {
            const entry = { id: number(tag, 1), name: string(tag, 2, 1024), type: number(tag, 3) }, key = JSON.stringify([entry.id, entry.name, entry.type]);
            if (seen.has(key)) fail('INVALID_RESPONSE', 'QQ repeated a group category tag'); seen.add(key); return entry;
        });
    } else if (prepared.operation === 'group.shareLink') {
        const group = nested(body, 12, true); result.url = validateUrl(string(group, 1, 8192));
    } else {
        if (prepared.operation === 'group.robotOption') {
            if (body.has(1) && number(body, 1, U32) !== Number(prepared.data.groupId)) fail('INVALID_RESPONSE', 'Robot settings ACK belongs to another group');
            status(body, 2, true);
            if ([...body.keys()].some(field => ![1, 2].includes(field))) fail('INVALID_RESPONSE', 'Unrecognized group robot settings acknowledgement');
        } else if (body.size) fail('INVALID_RESPONSE', 'Unrecognized group administration acknowledgement');
        result.confirmed = true; result.confirmation = 'server_ack';
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'Group administration JSON response exceeds its byte budget');
    return result;
}

module.exports = { OPERATIONS, PARAMETERS, prepare, decode, uint, text, bool, plain, mergeInvite, mergePermission, invitePolicy, historyVisible,
    INVITE_MASK, INVITE_BITS, PERMISSION_MASKS, MAX_RESPONSE_BYTES, validateUrl };
