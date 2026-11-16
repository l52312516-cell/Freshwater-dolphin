'use strict';

const { validateEmojiUsers } = require('./account-queries.cjs');
const MAX_CATEGORIES = 64, MAX_USERS_PER_EMOJI = 1024, MAX_TOTAL_USERS = 4096, MAX_PAGES = 300;
const SOURCE = 'qq_native_message_record_and_user_pages';
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function fields(value, allowed, code = 'INVALID_PARAMS') {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(code, 'Unexpected message reaction summary fields');
}
function uint(value, maximum = 0xffffffffffffffffn, minimum = 0n, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) < minimum || BigInt(value) > maximum) fail(code, 'Invalid exact reaction summary integer');
    return value;
}
function request(data) {
    fields(data, ['expectedEpoch', 'peer', 'nativeId', 'sequence']); fields(data.peer, ['chatType', 'peerUid']);
    if (data.peer.chatType !== 2) fail('UNSUPPORTED', 'Complete native reaction summaries currently support group messages');
    return { peer: { chatType: 2, peerUid: uint(data.peer.peerUid, 0xffffffffn, 1n) },
        nativeId: uint(data.nativeId, 0xffffffffffffffffn, 1n), sequence: uint(data.sequence, 0xffffffffffffffffn, 1n) };
}
function directory(record, expected) {
    if (!plain(record) || record.chatType !== expected.peer.chatType || record.peerUid !== expected.peer.peerUid ||
        record.msgId !== expected.nativeId || record.msgSeq !== expected.sequence || !Array.isArray(record.emojiLikesList) ||
        record.emojiLikesList.length > MAX_CATEGORIES) fail('INVALID_RESPONSE', 'QQ omitted the exact bounded reaction message directory');
    const output = [], seen = new Set(); let total = 0;
    for (let index = 0; index < record.emojiLikesList.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(record.emojiLikesList, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_RESPONSE', 'QQ returned a sparse reaction directory');
        const item = descriptor.value; fields(item, ['emojiId', 'emojiType', 'likesCnt', 'isClicked'], 'INVALID_RESPONSE');
        const emojiId = uint(item.emojiId, 0xffffffffffffffffn, 0n, 'INVALID_RESPONSE'),
            count = Number(uint(item.likesCnt, BigInt(MAX_USERS_PER_EMOJI), 0n, 'INVALID_RESPONSE'));
        if (!['1', '2'].includes(item.emojiType) || typeof item.isClicked !== 'boolean' || item.isClicked && count === 0) fail('INVALID_RESPONSE', 'QQ returned an invalid native reaction category');
        const key = item.emojiType + ':' + emojiId;
        if (seen.has(key) || (total += count) > MAX_TOTAL_USERS) fail('INVALID_RESPONSE', 'QQ reaction directory is duplicate or exceeds the complete-summary budget');
        seen.add(key); output.push({ emojiId, emojiType: item.emojiType, count, isClicked: item.isClicked });
    }
    output.sort((left, right) => left.emojiType.localeCompare(right.emojiType) || (BigInt(left.emojiId) < BigInt(right.emojiId) ? -1 : BigInt(left.emojiId) > BigInt(right.emojiId) ? 1 : 0));
    return output;
}
function successful(value) {
    if (!plain(value) || typeof value.result !== 'number' || !Number.isInteger(value.result) || Object.is(value.result, -0) ||
        value.result < -0x80000000 || value.result > 0x7fffffff) fail('INVALID_RESPONSE', 'QQ omitted the reaction user-page business status');
    if (value.result !== 0) fail('KERNEL_ERROR', 'QQ rejected reaction user pagination (result=' + value.result + '); it was not retried');
    for (const key of ['errCode', 'errorCode']) if (Object.hasOwn(value, key) && value[key] !== 0) fail('KERNEL_ERROR', 'QQ returned conflicting reaction page statuses');
}
function summary(entries) {
    return { source: SOURCE, complete: true, completeness_scope: 'qq_message_record',
        snapshot_consistency: 'matching_before_after_counts', last_reaction_time_available: false, emoji_likes: entries };
}
function validateSummary(value) {
    fields(value, ['source', 'complete', 'completeness_scope', 'snapshot_consistency', 'last_reaction_time_available', 'emoji_likes'], 'INVALID_RESPONSE');
    if (value.source !== SOURCE || value.complete !== true || value.completeness_scope !== 'qq_message_record' ||
        value.snapshot_consistency !== 'matching_before_after_counts' || value.last_reaction_time_available !== false ||
        !Array.isArray(value.emoji_likes) || value.emoji_likes.length > MAX_CATEGORIES) fail('INVALID_RESPONSE', 'QQ supplied no complete scoped reaction summary');
    const seen = new Set(); let total = 0;
    const entries = [];
    for (let index = 0; index < value.emoji_likes.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value.emoji_likes, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_RESPONSE', 'QQ supplied a sparse reaction summary');
        const row = descriptor.value;
        fields(row, ['emoji_id', 'emoji_type', 'count', 'last_reaction_time', 'last_reaction_time_available', 'users'], 'INVALID_RESPONSE');
        const emojiId = uint(row.emoji_id, 0xffffffffffffffffn, 0n, 'INVALID_RESPONSE'), key = row.emoji_type + ':' + emojiId;
        if (![1, 2].includes(row.emoji_type) || !Number.isInteger(row.count) || row.count < 0 || row.count > MAX_USERS_PER_EMOJI ||
            row.last_reaction_time !== null || row.last_reaction_time_available !== false || !Array.isArray(row.users) || row.users.length !== row.count ||
            seen.has(key) || (total += row.count) > MAX_TOTAL_USERS) fail('INVALID_RESPONSE', 'QQ supplied incomplete or duplicate reaction categories');
        seen.add(key); const users = [], ids = new Set();
        for (const user of row.users) {
            fields(user, ['user_id'], 'INVALID_RESPONSE');
            if (!Number.isSafeInteger(user.user_id) || user.user_id < 1 || user.user_id > 0xffffffff || ids.has(user.user_id)) fail('INVALID_RESPONSE', 'QQ supplied an invalid or duplicate reaction QQ account');
            ids.add(user.user_id); users.push({ user_id: user.user_id });
        }
        entries.push({ emoji_id: emojiId, emoji_type: row.emoji_type, count: row.count, last_reaction_time: null, last_reaction_time_available: false, users });
    }
    return summary(entries);
}
function createEmojiSummary(capture) {
    const pending = new Set(); let generation = 0;
    const capabilities = () => ({ messageEmojiSummary: capture.hasMethods('msg', ['getMsgsByMsgId', 'getMsgEmojiLikesList']) });
    async function query(data, context = {}) {
        const input = request(data); capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid, generation };
        if (data.expectedEpoch !== saved.epoch) fail('SESSION_CHANGED', 'Reaction summary must bind the current QQ session');
        if (!capabilities().messageEmojiSummary) fail('UNSUPPORTED', 'This QQ session has no real reaction directory and user-page methods');
        if (pending.size >= 2) fail('BUSY', 'Two reaction summaries still await physical completion');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 20000, context.expiresAt ?? Infinity) };
        const active = () => { capture.ensureReady(); if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session ||
            capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the reaction summary');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) fail('EXPIRED', 'Reaction summary exceeded its complete-query deadline'); };
        const invoke = async (service, method, args) => { active(); let value; try { value = await capture.invoke(service, method, args); }
            catch { active(); fail('QUERY_FAILED', 'Reaction summary native lookup failed without retry'); } active(); return value; };
        const record = async () => { active(); let value; try { value = await capture.getMessage({ peer: input.peer, nativeId: input.nativeId }); }
            catch (error) { active(); if (error.code === 'NOT_FOUND') throw error; fail('QUERY_FAILED', 'QQ reaction message refresh failed without retry'); } active(); return directory(value, input); };
        active(); const token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            const before = await record(), output = []; let pages = 0;
            for (const category of before) {
                const users = [], seenUsers = new Set(), seenCookies = new Set(); let cookie = '', ended = false;
                while (!ended) {
                    active(); if (++pages > MAX_PAGES) fail('QUERY_FAILED', 'Reaction summary exceeded its complete pagination budget');
                    const reply = await invoke('msg', 'getMsgEmojiLikesList', [{ ...input.peer, guildId: '' }, input.sequence,
                        category.emojiId, category.emojiType, cookie, false, 15]);
                    successful(reply); const received = validateEmojiUsers(reply.emojiLikesList);
                    if (typeof reply.cookie !== 'string' || Buffer.byteLength(reply.cookie) > 4096 || /[\x00-\x1f\x7f]/.test(reply.cookie) ||
                        Buffer.from(reply.cookie).toString('utf8') !== reply.cookie || typeof reply.isLastPage !== 'boolean' ||
                        typeof reply.isFirstPage !== 'boolean' || reply.isFirstPage !== (cookie === '')) fail('INVALID_RESPONSE', 'QQ omitted exact reaction page continuation flags');
                    for (const user of received) {
                        const id = uint(user.tinyId, 0xffffffffn, 1n, 'INVALID_RESPONSE');
                        if (seenUsers.has(id) || users.length >= category.count) fail('INVALID_RESPONSE', 'QQ reaction user pages repeat users or exceed the confirmed count');
                        seenUsers.add(id); users.push({ user_id: Number(id) });
                    }
                    ended = reply.isLastPage;
                    if (!ended && (!reply.cookie || reply.cookie === cookie || seenCookies.has(reply.cookie) || !received.length || users.length >= category.count)) fail('INVALID_RESPONSE', 'QQ reaction user pages did not advance toward the confirmed total');
                    seenCookies.add(reply.cookie); cookie = reply.cookie;
                }
                if (users.length !== category.count) fail('INVALID_RESPONSE', 'QQ reaction users do not match the message-record count');
                output.push({ emoji_id: category.emojiId, emoji_type: Number(category.emojiType), count: category.count,
                    last_reaction_time: null, last_reaction_time_available: false, users });
            }
            const after = await record();
            if (JSON.stringify(before) !== JSON.stringify(after)) fail('QUERY_FAILED', 'QQ reaction categories or counts changed during pagination; no complete summary was published');
            return { uin: saved.uin, ...input, summary: validateSummary(summary(output)) };
        });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 20000); active(); return result;
    }
    return { capabilities, query, clear() { generation++; } };
}
module.exports = { createEmojiSummary, request, directory, validateSummary, summary, SOURCE, MAX_CATEGORIES, MAX_USERS_PER_EMOJI, MAX_TOTAL_USERS, MAX_PAGES };
