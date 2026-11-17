'use strict';

const MAX_CONTENT_BYTES = 65536;
const ID = /^[1-9]\d{0,15}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const { safeDiagnostic } = require('./diagnostics.cjs');

function bounded(value, bytes) {
    if (typeof value !== 'string') return '';
    const encoded = Buffer.from(value);
    if (encoded.length <= bytes) return value;
    let end = bytes;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    return encoded.subarray(0, end).toString('utf8');
}
function account(value) {
    if (!['string', 'number'].includes(typeof value)) return null;
    const text = String(value ?? '');
    return ID.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}
function name(value) { return bounded(typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '') : '', 256); }
function decimal(value, pattern) { return ['string', 'number'].includes(typeof value) && pattern.test(String(value)); }

// Only text contains user-provided message content. Media metadata is never
// formatted, so signed download URLs, local paths and transfer tokens stay out.
function messageContent(segments) {
    if (!Array.isArray(segments)) return { content: '', truncated: false };
    let content = '', bytes = 0, truncated = false;
    for (const segment of segments.slice(0, 1000)) {
        const data = segment?.data;
        let part;
        switch (segment?.type) {
        case 'text': part = typeof data?.text === 'string' ? data.text : '[无效文字]'; break;
        case 'at': part = data?.qq === 'all' ? '[@全体成员]' : account(data?.qq) ? '[@' + String(data.qq) + ']' : '[@]'; break;
        case 'reply': part = decimal(data?.id, /^-?[1-9]\d{0,9}$/) ? '[引用 ' + String(data.id) + ']' : '[引用]'; break;
        case 'face': part = decimal(data?.id, /^\d{1,5}$/) ? '[表情 ' + String(data.id) + ']' : '[表情]'; break;
        case 'image': part = '[图片]'; break;
        case 'file': part = '[文件]'; break;
        case 'share': part = '[分享]'; break;
        case 'json': part = '[JSON卡片]'; break;
        case 'record': part = '[语音]'; break;
        case 'video': part = '[视频]'; break;
        case 'music': part = '[音乐]'; break;
        default: part = '[未支持消息段]';
        }
        const remaining = MAX_CONTENT_BYTES - bytes;
        const size = Buffer.byteLength(part);
        const actual = size > remaining ? bounded(part, remaining) : part;
        content += actual; bytes += Buffer.byteLength(actual);
        if (size > remaining) { truncated = true; break; }
    }
    if (segments.length > 1000) truncated = true;
    return { content, truncated };
}

function sanitizeMessageRecord(value, { includeContent = true } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'message' ||
        !['message_received', 'message_sent'].includes(value.event) || typeof value.profileId !== 'string' || !PROFILE.test(value.profileId) ||
        !account(value.selfId) || !['private', 'group'].includes(value.messageType) ||
        !Number.isInteger(value.messageId) || !value.messageId || value.messageId < -0x80000000 || value.messageId > 0x7fffffff) return null;
    const output = { kind: 'message', event: value.event, level: 'SUCCESS', component: 'message',
        profileId: value.profileId, selfId: account(value.selfId), messageId: value.messageId,
        messageType: value.messageType };
    if (value.partial === true) {
        output.partial = true; output.level = 'WARN';
        if (Number.isInteger(value.partialCount) && value.partialCount > 0 && value.partialCount <= 1000) output.partialCount = value.partialCount;
    }
    const { traceId } = safeDiagnostic(value);
    if (traceId) output.traceId = traceId;
    if (typeof value.id === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(value.id)) output.id = value.id;
    if (typeof value.time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.time) && Number.isFinite(Date.parse(value.time))) output.time = value.time;
    for (const key of ['userId', 'peerId', 'groupId']) if (account(value[key])) output[key] = account(value[key]);
    if (includeContent) {
        if (typeof value.content !== 'string') return null;
        output.content = bounded(value.content, MAX_CONTENT_BYTES);
        output.truncated = value.truncated === true || Buffer.byteLength(value.content) > MAX_CONTENT_BYTES;
        for (const key of ['senderName', 'card', 'groupName']) if (name(value[key])) output[key] = name(value[key]);
    }
    return output;
}

function messageDetails({ direction, profileId, selfId, messageId, messageType, userId, peerId, groupId, senderName, card, groupName, segments, partial, partialCount, traceId }) {
    return { kind: 'message', event: direction === 'sent' ? 'message_sent' : 'message_received', profileId, selfId, messageId,
        messageType, userId, peerId, groupId, senderName, card, groupName, ...(partial === true ? { partial, partialCount } : {}),
        ...(traceId ? { traceId } : {}), ...messageContent(segments) };
}

module.exports = { MAX_CONTENT_BYTES, messageContent, messageDetails, sanitizeMessageRecord };
