'use strict';

const { randomBytes } = require('node:crypto');
const fixed = require('./contact-extra-protocol.cjs');
const OPERATIONS = Object.freeze({ translate: ['words'], unidirectional: [], 'input.status': ['uin', 'eventType'],
    'read.all': [], 'doubt.list': ['count'], 'doubt.handle': ['flag', 'approve'], 'group.filtered': [] });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function exact(value, maximum = 0xffffffffn, positive = false) {
    if (!['number', 'string'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) > maximum || positive && BigInt(value) === 0n) fail('INVALID_PARAMS', 'Invalid exact contact integer');
    return String(value);
}
function request(value) {
    const keys = OPERATIONS[value?.operation];
    if (!keys) fail('UNSUPPORTED', 'Unknown contact operation');
    if (!fixed.object(value) || Object.keys(value).some(key => !['operation', 'expectedEpoch', ...keys].includes(key))) fail('INVALID_PARAMS', 'Unexpected contact operation fields');
    const operation = value.operation;
    if (operation === 'translate') return { operation, words: fixed.words(value.words) };
    if (operation === 'input.status') return { operation, uin: exact(value.uin, 0xffffffffn, true), eventType: Number(exact(value.eventType === undefined ? 0 : value.eventType)) };
    if (operation === 'doubt.list') return { operation, count: Number(exact(value.count === undefined ? 50 : value.count, 100n, true)) };
    if (operation === 'doubt.handle') {
        if (typeof value.flag !== 'string' || !/^fwd_doubt_[a-f0-9]{48}$/.test(value.flag) || typeof value.approve !== 'boolean') fail('INVALID_PARAMS', 'An observed request flag and explicit approval are required');
        return { operation, flag: value.flag, approve: value.approve };
    }
    return { operation };
}
function createContactExtra(capture, options = {}) {
    const native = options.native || require('./msf-native.cjs');
    const pending = new Set(), handles = new Map(), identities = new Map(); let scopeKey;
    function synchronize() {
        const key = JSON.stringify([capture.epoch, capture.self?.uin, capture.self?.uid]);
        if (scopeKey !== key) { scopeKey = key; handles.clear(); identities.clear(); }
    }
    function clear() { scopeKey = undefined; handles.clear(); identities.clear(); }
    function capabilities() {
        const available = native.available();
        return { translateEn2zh: available, unidirectionalFriends: available,
            inputStatus: capture.hasMethods('msg', ['sendShowInputStatusReq']) || available,
            markAllRead: capture.hasMethods('msg', ['setAllC2CAndGroupMsgRead']), doubtFriendRequests: available,
            doubtFriendApproval: available, filteredGroupRequests: available };
    }
    async function execute(params, callerContext = {}) {
        const input = request(params);
        capture.ensureReady(); synchronize();
        if (params.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Contact operations must bind the current session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        const context = { ...callerContext, expiresAt: Math.min(callerContext.expiresAt ?? Infinity, Date.now() + 10000) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the contact operation');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Contact operation expired; a dispatched result may be unknown');
        };
        active();
        // Choose before dispatch. A rejected or unknown native write must never
        // fall through to a second write via the fixed OIDB transport.
        const nativeInput = input.operation === 'input.status' && input.eventType <= 0x7fffffff &&
            capture.hasMethods('msg', ['sendShowInputStatusReq']);
        active();
        if (input.operation === 'read.all' ? !capabilities().markAllRead : !nativeInput && !native.available()) fail('UNSUPPORTED', 'This session lacks the fixed contact operation');
        if (pending.size >= 8) fail('BUSY', 'Too many contact operations still await completion');
        const token = {}; pending.add(token);
        const call = async (operation, data) => {
            active(); fixed.prepare(operation, data);
            const result = await native.run(capture, { op: 'fixedContactExtra', operation, request: data,
                expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: context.signal,
                timeoutMs: Math.max(1, Math.min(10000, context.expiresAt - Date.now())) });
            active(); return result;
        };
        async function resolveWho(item) {
            if (!item.uid || !item.uin) {
                const who = await capture.resolve(item.uid ? { uid: item.uid } : { uin: item.uin }); active();
                if (item.uid && item.uid !== who.uid || item.uin && item.uin !== who.uin) fail('INVALID_RESPONSE', 'Filtered friend identity is inconsistent');
                return { ...item, uid: who.uid, uin: who.uin };
            }
            return item;
        }
        function remember(item) {
            const key = JSON.stringify([item.uid, item.reqTime]);
            const existing = handles.get(identities.get(key));
            if (existing) return existing.flag;
            if (!item.uid || item.reqTime === '0') return null;
            if (handles.size >= 1000) fail('BUSY', 'Filtered friend request handle limit reached');
            const flag = 'fwd_doubt_' + randomBytes(24).toString('hex');
            handles.set(flag, { flag, key, uid: item.uid, uin: item.uin, reqTime: item.reqTime, expiresAt: Date.now() + 600000, dispatched: false });
            identities.set(key, flag); return flag;
        }
        const task = Promise.resolve().then(async () => {
            active(); let result;
            if (input.operation === 'translate') result = await call('translate', { words: input.words });
            else if (input.operation === 'unidirectional') result = await call('unidirectional', { selfUin: saved.uin });
            else if (input.operation === 'input.status') {
                const who = await capture.resolve({ uin: input.uin }); active();
                if (who.uin !== input.uin) fail('INVALID_RESPONSE', 'QQ resolved another input-status target');
                const targetUid = who.uid;
                fixed.prepare('input.status', { targetUid, eventType: input.eventType }); active();
                if (nativeInput) {
                    const value = await capture.invoke('msg', 'sendShowInputStatusReq', [1, input.eventType, targetUid]); active();
                    if (!fixed.object(value) || !Object.hasOwn(value, 'result') || value.result !== 0 ||
                        ['errCode', 'errorCode'].some(key => Object.hasOwn(value, key) && value[key] !== 0)) fail('KERNEL_ERROR', 'QQ did not explicitly confirm the input-status notification');
                    result = { confirmed: true, confirmation: 'kernel_ack', targetUid, eventType: input.eventType };
                } else result = await call('input.status', { targetUid, eventType: input.eventType });
                result = { ...result, uin: input.uin };
            } else if (input.operation === 'read.all') {
                const value = await capture.invoke('msg', 'setAllC2CAndGroupMsgRead', []); active();
                if (!fixed.object(value) || !Object.hasOwn(value, 'result') || value.result !== 0 ||
                    ['errCode', 'errorCode'].some(key => value[key] !== undefined && value[key] !== 0)) fail('KERNEL_ERROR', 'QQ did not explicitly confirm marking all chats read');
                result = { confirmed: true, confirmation: 'kernel_ack' };
            } else if (input.operation === 'doubt.list') {
                const page = await call('doubt.list', { count: input.count }), items = [];
                for (const record of page.items) {
                    const who = await resolveWho(record); active();
                    items.push({ ...who, flag: remember(who) });
                }
                result = { items, limit: input.count };
            } else if (input.operation === 'doubt.handle') {
                const handle = handles.get(input.flag);
                if (!handle || handle.expiresAt <= Date.now()) fail('NOT_FOUND', 'Unknown or expired filtered friend request flag');
                if (handle.dispatched) fail('BUSY', 'This filtered friend request was already dispatched; do not retry an uncertain result');
                const page = await call('doubt.list', { count: 100 });
                const candidates = page.items.filter(item => item.reqTime === handle.reqTime && (item.uid === handle.uid || item.uin === handle.uin));
                if (candidates.length !== 1) fail('NOT_FOUND', 'The exact filtered friend request is no longer present in the verified screen');
                const current = await resolveWho(candidates[0]); active();
                if (current.uid !== handle.uid || current.uin !== handle.uin) fail('INVALID_RESPONSE', 'Filtered friend request identity changed');
                if (handle.dispatched) fail('BUSY', 'This filtered friend request was already dispatched');
                handle.dispatched = true;
                const operation = input.approve ? 'doubt.approve' : 'doubt.reject';
                result = await call(operation, { targetUid: handle.uid, ...(input.approve ? { selfUid: saved.uid } : {}) });
                result = { ...result, flag: handle.flag, approve: input.approve };
            } else {
                const items = [], seen = new Set(), cursors = new Set(); let cursor = '0';
                for (let page = 0; ; page++) {
                    if (page >= 10) fail('QUERY_FAILED', 'Filtered group inbox exceeded ten pages; no partial inventory was returned');
                    const result = await call('group.filtered', { count: 100, cursor });
                    for (const item of result.items) {
                        const key = item.groupId + ':' + item.sequence;
                        if (seen.has(key)) fail('INVALID_RESPONSE', 'Filtered group inbox repeated a request'); seen.add(key);
                        if (![1, 2].includes(item.eventType)) continue;
                        // Resolve real UID-only participants instead of assigning
                        // zero accounts or dropping fields without explanation.
                        for (const name of ['target', 'invitor', 'operator']) if (item[name]?.uid && !item[name].uin) {
                            const who = await capture.resolve({ uid: item[name].uid }); active(); item[name] = { ...item[name], uin: who.uin };
                        }
                        items.push(item);
                    }
                    if (result.cursor === '0') break;
                    if (cursors.has(result.cursor)) fail('INVALID_RESPONSE', 'Filtered group inbox repeated a cursor');
                    cursors.add(result.cursor); cursor = result.cursor;
                }
                result = { items, filtered: true, complete: true };
            }
            active();
            const output = { operation: input.operation, selfUin: saved.uin, result };
            if (Buffer.byteLength(JSON.stringify(output)) > 1024 * 1024) fail('INVALID_RESPONSE', 'Contact result exceeds the RPC byte budget');
            return output;
        });
        task.finally(() => pending.delete(token)).catch(() => {});
        const result = await capture.deadline(() => task, context); active(); return result;
    }
    return { execute, capabilities, clear };
}
module.exports = { createContactExtra, OPERATIONS, request };
