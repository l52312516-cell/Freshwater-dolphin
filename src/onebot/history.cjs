'use strict';

const crypto = require('node:crypto');
const { locator } = require('./store.cjs');
const { parseGrayTip } = require('../qq/gray-tip.cjs');

const keys = new WeakMap();
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_MAX_IDS = 1024;
const CURSOR_MAX_LENGTH = 65536;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function integer(value) {
    return ['string', 'number'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) &&
        (typeof value !== 'number' || Number.isSafeInteger(value));
}
function sequence(value, allowZero = false) { return allowZero && [0, '0'].includes(value) || integer(value); }
function secret(service) {
    if (!keys.has(service)) keys.set(service, crypto.randomBytes(32));
    return keys.get(service);
}
function binding(service, state, peer) {
    return [2, service.profileId, String(state.self.uin), state.epoch, peer.chatType, peer.peerUid, 'older'];
}
function encodeCursor(service, state, peer, record, consumed) {
    if (consumed.size > CURSOR_MAX_IDS) throw problem('UNSUPPORTED', 'History cursor reached its 1024-record limit; resume with a known message_id');
    const payload = Buffer.from(JSON.stringify([...binding(service, state, peer),
        String(record.msgId), String(record.msgSeq), Date.now() + CURSOR_TTL_MS, [...consumed],
        systemRecord(record) || failedSelfRecord(record, state)])).toString('base64url');
    const cursor = payload + '.' + crypto.createHmac('sha256', secret(service)).update(payload).digest('base64url');
    if (cursor.length > CURSOR_MAX_LENGTH) throw problem('UNSUPPORTED', 'History cursor exceeded its size limit; resume with a known message_id');
    return cursor;
}
function decodeCursor(service, state, peer, value) {
    const invalid = () => problem('NOT_FOUND', 'History cursor is invalid, expired or belongs to another account session');
    if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw invalid();
    const [payload, signature] = value.split('.');
    const expected = crypto.createHmac('sha256', secret(service)).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
    let fields;
    try { fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
    const bound = binding(service, state, peer);
    if (!Array.isArray(fields) || fields.length !== 12 || bound.some((item, index) => fields[index] !== item) ||
        !integer(fields[7]) || !sequence(fields[8], fields[11] === true) || !Number.isSafeInteger(fields[9]) ||
        fields[9] <= Date.now() || fields[9] > Date.now() + CURSOR_TTL_MS || typeof fields[11] !== 'boolean' ||
        !Array.isArray(fields[10]) || !fields[10].length || fields[10].length > CURSOR_MAX_IDS ||
        fields[10].some(id => typeof id !== 'string' || id.length > 128 || !integer(id)) ||
        new Set(fields[10]).size !== fields[10].length || !fields[10].includes(fields[7])) throw invalid();
    return { nativeId: fields[7], sequence: BigInt(fields[8]), consumed: fields[10], skipped: fields[11] };
}

const GRAY_OBJECT_FIELDS = new Set(['groupElement', 'jsonGrayTipElement', 'xmlElement']);
const GRAY_NULL_FIELDS = new Set(['revokeElement', 'proclamationElement', 'emojiReplyElement', 'buddyElement',
    'feedMsgElement', 'essenceElement', 'fileReceiptElement', 'localGrayTipElement', 'blockGrayTipElement',
    'aioOpGrayTipElement', 'walletGrayTipElement']);
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function knownGrayPayload(gray) {
    if (!plain(gray)) return false;
    if (!Object.keys(gray).length) return true;
    if (!Number.isSafeInteger(gray.subElementType) || gray.subElementType < 0) return false;
    return Object.entries(gray).every(([key, value]) => key === 'subElementType' ||
        (GRAY_NULL_FIELDS.has(key) && value === null) || (GRAY_OBJECT_FIELDS.has(key) && (value === null || plain(value)))) &&
        [...GRAY_OBJECT_FIELDS].filter(key => plain(gray[key])).length === 1;
}
function failedSelfRecord(record, state) {
    return record.sendStatus === 0 && integer(record.senderUin) &&
        String(record.senderUin) === String(state.self.uin) &&
        typeof state.self.uid === 'string' && state.self.uid.startsWith('u_') &&
        record.senderUid === state.self.uid;
}
function privateGrayPayload(record, gray) {
    if (!plain(gray)) return false;
    const payloads = Object.entries(gray).filter(([key, value]) => key !== 'subElementType' && value !== null);
    if (payloads.length !== 1 || !Object.keys(gray).every(key => key === 'subElementType' ||
        GRAY_OBJECT_FIELDS.has(key) || GRAY_NULL_FIELDS.has(key))) return false;
    const [key, value] = payloads[0];
    if (!plain(value)) return false;
    if (record.subMsgType === 15 && gray.subElementType === 15 && key === 'aioOpGrayTipElement') {
        return Object.keys(value).length === 3 && value.operateType === 2 && value.peerUid === record.peerUid &&
            ['', '0'].includes(value.fromGrpCodeOfTmpChat);
    }
    if (record.subMsgType !== 12 || gray.subElementType !== 17 || key !== 'jsonGrayTipElement') return false;
    if ([1061, '1061'].includes(value.busiId)) return parseGrayTip(record)?.kind === 'poke';
    if (value.busiId !== '19324' || typeof value.jsonStr !== 'string' ||
        Buffer.byteLength(value.jsonStr, 'utf8') > 65536) return false;
    let body;
    try { body = JSON.parse(value.jsonStr); } catch { return false; }
    return plain(body) && Object.keys(body).length === 2 && typeof body.align === 'string' &&
        Array.isArray(body.items) && body.items.length === 1 && plain(body.items[0]) &&
        Object.keys(body.items[0]).length === 2 && body.items[0].type === 'nor' && typeof body.items[0].txt === 'string';
}
function systemRecord(record) {
    if (recalledRecord(record)) return true;
    if (![1, 2].includes(record.chatType) || ![0, '0'].includes(record.senderUin) || record.senderUid !== '' ||
        record.msgType !== 5 || !Array.isArray(record.elements) || record.elements.length !== 1) return false;
    const element = record.elements[0], gray = element?.grayTipElement;
    // Native group/json/xml gray-tip envelopes were observed through read-only
    // QQ queries. They are never parsed into user text or business events.
    return element?.elementType === 8 &&
        Object.entries(element).every(([key, value]) => !key.endsWith('Element') || key === 'grayTipElement' || value === null) &&
        (record.chatType === 1 ? privateGrayPayload(record, gray) : [8, 12].includes(record.subMsgType) && knownGrayPayload(gray));
}

// QQ keeps a recalled message's original sender and locator while replacing
// its content with one native revoke stub. It is a history gap, never text.
function recalledRecord(record) {
    if (![1, 2].includes(record.chatType) || record.msgType !== 5 || record.subMsgType !== 4 ||
        !integer(record.senderUin) || typeof record.senderUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(record.senderUid) ||
        !Array.isArray(record.elements) || record.elements.length !== 1 || !integer(record.recallTime) ||
        !Number.isSafeInteger(Number(record.recallTime))) return false;
    const element = record.elements[0], gray = element?.grayTipElement, revoke = gray?.revokeElement;
    if (!plain(element) || element.elementType !== 8 || !plain(gray) || gray.subElementType !== 1 || !plain(revoke) ||
        Object.entries(element).some(([key, value]) => key.endsWith('Element') && key !== 'grayTipElement' && value != null) ||
        Object.entries(gray).some(([key, value]) => key !== 'subElementType' && key !== 'revokeElement' && value != null) ||
        typeof revoke.operatorUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(revoke.operatorUid) ||
        revoke.origMsgSenderUid != null && revoke.origMsgSenderUid !== record.senderUid) return false;
    const time = Number(record.recallTime);
    return (time > 10000000000 ? time : time * 1000) <= Date.now() + 30000;
}

async function runHistory(service, state, params, action, { numberId, shortId }) {
    const chatType = action === 'get_group_msg_history' ? 2 : 1;
    const target = String(numberId(chatType === 2 ? params.group_id : params.user_id));
    const resolved = chatType === 1 ? await service.sessionCall(state, 'resolve', { uin: target }) : null;
    if (chatType === 1 && (resolved?.uin !== target || !/^u_/.test(resolved.uid || ''))) {
        throw problem('NOT_FOUND', 'History target has no verified kernel UID');
    }
    const peer = { chatType, peerUid: chatType === 2 ? target : resolved.uid };
    const count = params.count ?? 20;
    if (!Number.isInteger(count) || count < 1 || count > 100 || params.reverse_order === true || params.message_seq !== undefined) {
        throw problem('INVALID_REQUEST', 'History supports count 1..100 and a message_id or history_cursor in the older direction');
    }
    let nativeId = '0', beforeSequence = null, skippedAnchor = false;
    const consumed = new Set();
    const hasMessageId = params.message_id !== undefined && params.message_id !== 0 && params.message_id !== '0';
    if (params.history_cursor !== undefined) {
        if (hasMessageId) throw problem('INVALID_REQUEST', 'Use either message_id or history_cursor');
        const cursor = decodeCursor(service, state, peer, params.history_cursor);
        nativeId = cursor.nativeId; beforeSequence = cursor.sequence; skippedAnchor = cursor.skipped;
        for (const id of cursor.consumed) consumed.add(id);
    } else if (hasMessageId) {
        const entry = service.store.get(state.self.uin, shortId(params.message_id));
        if (!entry || entry.locator.peer.chatType !== chatType || entry.locator.peer.peerUid !== peer.peerUid) {
            throw problem('NOT_FOUND', 'History cursor belongs to another account or conversation');
        }
        nativeId = entry.locator.nativeId;
        if (!integer(entry.locator.seq)) throw problem('NOT_FOUND', 'History cursor has no reliable sequence');
        beforeSequence = BigInt(entry.locator.seq);
        consumed.add(nativeId);
    }
    const requestCount = count + (nativeId === '0' ? 0 : 1);
    // QQ 3.2.35-54395 uses reverse=true for records preceding an inclusive
    // native anchor; false returns newer records despite the OneBot direction.
    const result = await service.sessionCall(state, 'history', { peer, nativeId, count: requestCount, reverse: true });
    if (!Array.isArray(result?.records) || result.records.length > requestCount) throw problem('INVALID_RESPONSE', 'Invalid QQ history page');
    const ids = new Set(), sequences = new Set();
    for (const record of result.records) {
        const where = locator(record);
        const skipped = systemRecord(record) || failedSelfRecord(record, state);
        if (where.peer.chatType !== chatType || where.peer.peerUid !== peer.peerUid) throw problem('INVALID_RESPONSE', 'History crossed a conversation boundary');
        if (!integer(record.msgId) || String(record.msgId).length > 128 || !sequence(record.msgSeq, skipped) || !integer(record.msgTime) ||
            !Number.isSafeInteger(Number(record.msgTime)) || ids.has(where.nativeId) ||
            (!skipped && sequences.has(String(record.msgSeq)))) {
            throw problem('INVALID_RESPONSE', 'QQ history has an invalid or duplicate message locator');
        }
        ids.add(where.nativeId);
        if (!skipped) sequences.add(String(record.msgSeq));
        const currentSequence = BigInt(record.msgSeq);
        if (beforeSequence !== null && (where.nativeId === nativeId ? currentSequence !== beforeSequence :
            (beforeSequence !== 0n && currentSequence !== 0n && (currentSequence > beforeSequence ||
                (currentSequence === beforeSequence && !skipped && !skippedAnchor))))) {
            throw problem('INVALID_RESPONSE', 'History page does not precede its sequence cursor');
        }
    }
    const records = result.records.filter(record => String(record.msgId) !== nativeId && !consumed.has(String(record.msgId)));
    if (!records.length && result.records.some(record => String(record.msgId) !== nativeId)) {
        throw problem('INVALID_RESPONSE', 'QQ history page repeated consumed native identities without advancing');
    }
    records.sort((a, b) => BigInt(a.msgSeq) < BigInt(b.msgSeq) ? -1 : BigInt(a.msgSeq) > BigInt(b.msgSeq) ? 1 : 0);
    if (records.length > count) records.splice(0, records.length - count);
    for (const record of records) consumed.add(String(record.msgId));
    const nextCursor = records.length ? encodeCursor(service, state, peer, records[0], consumed) : null;
    const transaction = service.store.stage(state.self.uin);
    const conversion = Object.create(service);
    conversion.store = transaction.store;
    const messages = [];
    let skippedSystem = 0, skippedFailed = 0, skippedRecalled = 0;
    let next = null;
    for (const record of records) {
        if (recalledRecord(record)) { skippedRecalled++; continue; }
        if (systemRecord(record)) { skippedSystem++; continue; }
        // Failed local sends may have zero or reused sequence numbers. Retain
        // their raw page identity, but never publish them as delivered messages.
        if (failedSelfRecord(record, state)) { skippedFailed++; continue; }
        const entry = transaction.store.remember(state.self.uin, record);
        const event = await conversion.convert(state, record, entry.id, { queryFiles: true });
        transaction.store.setEvent(state.self.uin, entry.id, event);
        messages.push(service.queryResult(event, record));
        if (record === records[0]) next = entry.id;
    }
    await service.assertSession(state);
    if (messages.length) transaction.commit();
    return { messages, next_message_id: next,
        next_history_cursor: nextCursor,
        skipped_system_count: skippedSystem, skipped_failed_count: skippedFailed, skipped_recalled_count: skippedRecalled,
        has_more: null, direction: 'older' };
}

module.exports = { runHistory };
