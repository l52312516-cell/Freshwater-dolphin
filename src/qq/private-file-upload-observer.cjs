'use strict';

// Capture's private single-file send path supplies real native callbacks and
// binds only an independently pinned native file record. This module never
// dispatches QQ calls, installs listeners, sends a file or writes a report. Unmatched
// callbacks establish shape only; their error codes never become send proof.
const MAX_EVENTS = 64, MAX_ARGS = 4;
const CALLBACKS = ['onRichMediaProgerssUpdate', 'onRichMediaUploadComplete', 'onSendMsgError'];
const NUMBER_FIELDS = ['fileErrCode', 'fileSrvErrCode', 'trasferStatus', 'transferStatus', 'step', 'businessId', 'chatType'];
const SHAPE_FIELDS = [...NUMBER_FIELDS, 'msgId', 'msgElementId', 'elementId', 'peerUid', 'fileModelId', 'fileId',
    'fileProgress', 'fileSpeed', 'fileDownType', 'thumbSize', 'filePath', 'fileName', 'totalSize', 'commonFileInfo',
    'fileErrMsg', 'clientMsg', 'userTotalSpacePerDay', 'userUsedSpacePerDay'];
const ALLOWED_SHAPE = new Set(SHAPE_FIELDS);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nativeId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
function integer(value) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^-?(?:0|[1-9]\d{0,9})$/.test(String(value))) return undefined;
    const result = Number(value);
    return result >= -0xffffffff && result <= 0xffffffff ? result : undefined;
}
function data(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function shape(value) {
    if (!plain(value)) return { null: value === null, array: Array.isArray(value), object: false,
        string: typeof value === 'string', number: typeof value === 'number', boolean: typeof value === 'boolean',
        undefined: value === undefined };
    const keys = Reflect.ownKeys(value), known = keys.filter(key => typeof key === 'string' && ALLOWED_SHAPE.has(key));
    return { object: true, keyCount: keys.length, exceedsKeyBound: keys.length > 64,
        keys: known.sort(), unknownKeyCount: keys.length - known.length,
        fields: Object.fromEntries(known.map(key => { const item = data(value, key); return [key, {
            null: item === null, array: Array.isArray(item), object: item !== null && typeof item === 'object',
            string: typeof item === 'string', number: typeof item === 'number', boolean: typeof item === 'boolean',
            undefined: item === undefined }]; })) };
}
function createFileUploadObserver({ isActive, selfUin, selfUid, peer }) {
    if (typeof isActive !== 'function' || typeof selfUin !== 'string' || !/^[1-9]\d{0,9}$/.test(selfUin) ||
        BigInt(selfUin) > 0xffffffffn || typeof selfUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(selfUid) ||
        !plain(peer) || peer.chatType !== 1 || typeof peer.peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(peer.peerUid)) {
        throw Object.assign(Error('Invalid private file observation scope'), { code: 'INVALID_PARAMS' });
    }
    const target = { chatType: 1, peerUid: peer.peerUid }, events = [], counts = Object.fromEntries(CALLBACKS.map(name => [name, 0]));
    let binding, closed = false, overflow = false, stale = false;
    function active() {
        if (closed || stale) return false;
        try { if (isActive() !== true) stale = true; } catch { stale = true; }
        return !stale;
    }
    function bind(record, independentlyPinnedMsgId) {
        if (!active()) return false;
        if (!nativeId(independentlyPinnedMsgId) || record?.msgId !== independentlyPinnedMsgId || record.chatType !== target.chatType ||
            record.peerUid !== target.peerUid || String(record.senderUin) !== selfUin || record.senderUid !== selfUid ||
            ![0, 1, 2].includes(record.sendStatus) || !Array.isArray(record.elements) || record.elements.length !== 1 ||
            record.elements[0]?.elementType !== 3 || !nativeId(record.elements[0].elementId)) return false;
        const next = { msgId: record.msgId, msgElementId: record.elements[0].elementId };
        if (binding && (binding.msgId !== next.msgId || binding.msgElementId !== next.msgElementId)) return false;
        binding = next; return true;
    }
    function observe(name, args) {
        if (!CALLBACKS.includes(name) || !Array.isArray(args) || args.length > MAX_ARGS || !active()) return false;
        counts[name] = Math.min(1000000, counts[name] + 1);
        if (events.length >= MAX_EVENTS) { overflow = true; return false; }
        const event = { name, args: args.map(shape) };
        // Upload callback types remain unknown in the reference source. Only
        // the exact directly observed msgId/msgElementId pair can correlate;
        // no aliases, positional onSendMsgError interpretation or recursion.
        if (name !== 'onSendMsgError' && args.length === 1 && plain(args[0]) && Reflect.ownKeys(args[0]).length <= 64) {
            const object = args[0];
            const msgId = data(object, 'msgId'), msgElementId = data(object, 'msgElementId');
            if (nativeId(msgId) && nativeId(msgElementId)) {
                event.match = { msgId, msgElementId, peerMatches:
                    (!Object.hasOwn(object, 'chatType') || data(object, 'chatType') === target.chatType) &&
                    (!Object.hasOwn(object, 'peerUid') || data(object, 'peerUid') === target.peerUid) };
                event.codes = {};
                for (const key of NUMBER_FIELDS) {
                    const value = integer(data(object, key));
                    if (value !== undefined) event.codes[key] = value;
                }
                event.progressPresent = Object.hasOwn(object, 'fileProgress');
                event.speedPresent = Object.hasOwn(object, 'fileSpeed');
            }
        }
        events.push(event); return true;
    }
    function snapshot() {
        active();
        const report = { readOnlyObserver: true, bound: Boolean(binding), closed, stale, overflow,
            eventLimit: MAX_EVENTS, callbacks: { ...counts }, events: [],
            correlatedProgress: 0, correlatedUploadComplete: 0, nativeErrorSemanticsKnown: false, sendErrorArgumentsInterpreted: false };
        for (const event of events) {
            const matched = Boolean(!stale && binding && event.match?.msgId === binding.msgId && event.match.msgElementId === binding.msgElementId &&
                event.match.peerMatches);
            const value = { callback: event.name, argumentCount: event.args.length, args: event.args, correlated: matched };
            if (matched) {
                value.numericFields = { ...event.codes }; value.progressFieldPresent = event.progressPresent; value.speedFieldPresent = event.speedPresent;
                if (event.name === 'onRichMediaProgerssUpdate') report.correlatedProgress++;
                if (event.name === 'onRichMediaUploadComplete') report.correlatedUploadComplete++;
            }
            report.events.push(value);
        }
        return report;
    }
    return { bind, observe, snapshot, close() { active(); closed = true; } };
}
module.exports = { createFileUploadObserver, shape, integer, MAX_EVENTS };

if (require.main === module) {
    // Direct execution is deliberately inert. Import this helper in a
    // separately reviewed native-listener probe; it cannot attach through RPC.
    console.log(JSON.stringify({ readOnlyObserver: true, dispatchesNativeCalls: false, attachesListeners: false,
        sendsFiles: false, requiresExplicitNativeCallbackWiring: true }));
}
