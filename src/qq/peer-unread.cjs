'use strict';

const { performance } = require('node:perf_hooks');
// A native query acknowledges a request; only the standard listener supplies
// raw counts. Neither the counter enums nor query-to-push causality are assumed.
const FIELDS = Object.freeze(['show_unread_cnt', 'all_unread_cnt', 'atme_unread_cnt', 'atall_unread_cnt']);
const int32 = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const nativeFailure = error => Object.assign(new Error('QQ unread query failed'), {
    code: ['NOT_READY', 'UNSUPPORTED', 'SESSION_CHANGED', 'EXPIRED', 'TIMEOUT'].includes(error?.code) ? error.code : 'KERNEL_ERROR'
});
function ownValue(object, key) {
    if (!object || typeof object !== 'object') fail('INVALID_RESPONSE', 'QQ omitted an unread field');
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (!property || !Object.hasOwn(property, 'value')) fail('INVALID_RESPONSE', 'QQ omitted an unread field');
    return property.value;
}
function copyPeer(object) {
    const peer = { chatType: ownValue(object, 'chatType'), peerUid: ownValue(object, 'peerUid'), guildId: ownValue(object, 'guildId') };
    if (!int32(peer.chatType) || typeof peer.peerUid !== 'string' || typeof peer.guildId !== 'string') {
        fail('INVALID_RESPONSE', 'QQ returned an invalid unread peer');
    }
    return Object.freeze(peer);
}
const samePeer = (a, b) => a.chatType === b.chatType && a.peerUid === b.peerUid && a.guildId === b.guildId;
function copyCounters(object) {
    return Object.freeze(Object.fromEntries(FIELDS.map(field => {
        const value = ownValue(object, field), type = ownValue(value, 'type'), cnt = ownValue(value, 'cnt');
        if (!int32(type) || !int32(cnt)) fail('INVALID_RESPONSE', 'QQ returned an invalid unread counter');
        return [field, Object.freeze({ type, cnt })];
    })));
}
function decodeContactUnreadFrame(payload, targetPeer, maxRecords = 10000) {
    const target = copyPeer(targetPeer);
    let matched = 0, scanned = 0, buckets = 0, counters;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) fail('INVALID_PARAMS', 'Invalid unread inspection limit');
    try {
        for (const [outerKey, inner] of Map.prototype.entries.call(payload)) {
            if (!int32(outerKey) || ++buckets > maxRecords) fail('INVALID_RESPONSE', 'Invalid unread map');
            for (const [innerKey, value] of Map.prototype.entries.call(inner)) {
                if (typeof innerKey !== 'string' || ++scanned > maxRecords) fail('INVALID_RESPONSE', 'Invalid unread map');
                const peer = copyPeer(ownValue(value, 'peer')), next = copyCounters(value);
                if (samePeer(peer, target)) { matched++; counters = next; }
            }
        }
    } catch { return Object.freeze({ status: 'invalid' }); }
    if (matched === 0) return Object.freeze({ status: 'missing' });
    if (matched !== 1) return Object.freeze({ status: 'ambiguous' });
    return Object.freeze({ status: 'raw-observed', counters });
}

function inputPeer(value) {
    let peer;
    try {
        if (!value || Object.keys(value).some(key => !['chatType', 'peerUid', 'guildId'].includes(key))) throw new Error();
        peer = copyPeer(value);
    } catch { fail('INVALID_PARAMS', 'Expected a complete unread peer'); }
    if (![1, 2].includes(peer.chatType) || peer.peerUid.length > 128 || peer.guildId.length > 512 ||
        Buffer.from(peer.guildId).toString('utf8') !== peer.guildId ||
        /[\u0000-\u001f\u007f]/u.test(peer.guildId) || (peer.chatType === 1 ? !/^u_[A-Za-z0-9_-]+$/.test(peer.peerUid) :
            !/^[1-9]\d*$/.test(peer.peerUid) || !Number.isSafeInteger(Number(peer.peerUid)))) {
        fail('INVALID_PARAMS', 'Invalid unread conversation');
    }
    return peer;
}
function expectedSelf(value) {
    let self;
    try {
        if (!value || Object.keys(value).some(key => !['uin', 'uid'].includes(key))) throw new Error();
        self = { uin: ownValue(value, 'uin'), uid: ownValue(value, 'uid') };
    } catch { fail('INVALID_PARAMS', 'Expected the complete current unread account'); }
    if (typeof self.uin !== 'string' || !/^[1-9]\d*$/.test(self.uin) || !Number.isSafeInteger(Number(self.uin)) ||
        typeof self.uid !== 'string' || self.uid.length > 128 || !/^u_[A-Za-z0-9_-]+$/.test(self.uid)) fail('INVALID_PARAMS', 'Invalid unread account');
    return self;
}

function createPeerUnread(capture) {
    // A caller timeout retires observation, not the native Promise. Keep the
    // physical slot across clears/session changes until that Promise settles.
    let physical, observation, sequence = 0;
    function clear(error = Object.assign(new Error('QQ unread observation stopped'), { code: 'SESSION_CHANGED' })) {
        observation?.finish(error);
    }
    function observe(payload) {
        const current = observation;
        if (!current) return;
        try {
            current.active();
            const now = Date.now(), nextSequence = ++sequence;
            if (!Number.isSafeInteger(nextSequence) || now < current.armedAt || now < current.lastTime || performance.now() >= current.endsAtMonotonic ||
                nextSequence <= current.lastSequence) fail('INVALID_RESPONSE', 'QQ unread observation is outside its window');
            current.lastTime = now; current.lastSequence = nextSequence;
            const decoded = decodeContactUnreadFrame(payload, current.peer);
            if (decoded.status === 'invalid' || decoded.status === 'ambiguous') fail('INVALID_RESPONSE', 'QQ returned an invalid or ambiguous unread frame');
            if (decoded.status !== 'raw-observed') return;
            if (current.counters && JSON.stringify(current.counters) !== JSON.stringify(decoded.counters)) {
                fail('INVALID_RESPONSE', 'QQ unread counters changed during the snapshot window');
            }
            current.counters = decoded.counters; current.observedAt = now; current.matchingFrames++;
        } catch (error) { current.finish(error); }
    }
    async function snapshot(data, context = {}) {
        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            Object.keys(data).some(key => !['operation', 'expectedEpoch', 'expectedSelf', 'peer', 'observationMs'].includes(key)) ||
            data.operation !== 'unread.snapshot') fail('INVALID_PARAMS', 'Invalid unread snapshot fields');
        const peer = inputPeer(data.peer), self = expectedSelf(data.expectedSelf), observationMs = data.observationMs ?? 250;
        if (!Number.isInteger(observationMs) || observationMs < 20 || observationMs > 2000) fail('INVALID_PARAMS', 'observationMs must be 20..2000');
        capture.ensureReady();
        if (typeof data.expectedEpoch !== 'string' || data.expectedEpoch !== capture.epoch ||
            self.uin !== capture.self?.uin || self.uid !== capture.self?.uid) fail('SESSION_CHANGED', 'Unread snapshot belongs to another QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: self.uin, uid: self.uid, generation: capture.observerGeneration };
        if (!Number.isSafeInteger(saved.generation) || saved.generation < 0) fail('NOT_READY', 'QQ unread observer generation is unavailable');
        const armedAt = Date.now(), endsAt = armedAt + observationMs;
        const endsAtMonotonic = performance.now() + observationMs;
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin ||
                capture.self?.uid !== saved.uid || capture.observerGeneration !== saved.generation) fail('SESSION_CHANGED', 'QQ changed during the unread snapshot');
            if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) fail('EXPIRED', 'Unread snapshot expired or was cancelled');
        };
        active();
        if (endsAt >= (context.expiresAt ?? Infinity)) fail('EXPIRED', 'Unread snapshot window exceeds its deadline');
        if (!capture.hasMethods('msg', ['getContactUnreadCnt']) || capture.registrations?.some(item => item.name === 'msg') !== true) {
            fail('UNSUPPORTED', 'QQ unread observation is unavailable');
        }
        if (physical) fail('BUSY', 'An unread query still owns its native observation slot');
        const token = { nativeSettled: false, observationClosed: false }; physical = token;
        const release = () => { if (physical === token && token.nativeSettled && token.observationClosed) physical = undefined; };
        let current, timer, resolve, reject;
        const response = new Promise((accept, decline) => { resolve = accept; reject = decline; });
        response.catch(() => {});
        const cancel = () => current.finish(Object.assign(new Error('Unread snapshot was cancelled'), { code: 'EXPIRED' }));
        current = { peer, active, armedAt, endsAtMonotonic, lastTime: armedAt, lastSequence: sequence, matchingFrames: 0,
            finish(error) {
                if (token.observationClosed) return;
                token.observationClosed = true; clearTimeout(timer); context.signal?.removeEventListener('abort', cancel);
                if (observation === current) observation = undefined;
                release();
                if (error) reject(error);
                else resolve(Object.freeze({ source: 'kernel_push', semanticVerified: false, queryCorrelated: false, businessVerified: false,
                    requestAck: Object.freeze({ result: 0 }), snapshot: Object.freeze({ status: 'raw-observed',
                        matchingFrames: current.matchingFrames, observedAtMs: current.observedAt, counters: current.counters }) }));
            } };
        observation = current;
        const closeWindow = () => {
            try {
                active();
                if (Date.now() < current.lastTime) fail('INVALID_RESPONSE', 'QQ unread observation time moved backwards');
                const remaining = endsAtMonotonic - performance.now();
                if (remaining > 0) { timer = setTimeout(closeWindow, remaining); return; }
                if (!current.acknowledged || !current.counters) fail('TIMEOUT', 'QQ did not supply an accepted raw unread snapshot within its window');
                current.finish();
            } catch (error) { current.finish(error); }
        };
        timer = setTimeout(closeWindow, observationMs);
        context.signal?.addEventListener('abort', cancel, { once: true });
        // Install the observer before dispatch, including synchronous native
        // callbacks. There is one invocation, with no refresh or retry path.
        let native;
        try {
            active();
            if (performance.now() >= endsAtMonotonic) fail('TIMEOUT', 'Unread snapshot expired before dispatch');
            native = capture.invoke('msg', 'getContactUnreadCnt', [[{ ...peer }]]);
        }
        catch (error) { token.nativeSettled = true; current.finish(nativeFailure(error)); release(); }
        if (!token.nativeSettled) Promise.resolve(native).then(value => {
            token.nativeSettled = true; release();
            if (token.observationClosed) return;
            try {
                active();
                if (performance.now() >= endsAtMonotonic) fail('TIMEOUT', 'QQ unread query acknowledgment arrived after its window');
                const code = ownValue(value, 'result'), message = ownValue(value, 'errMsg');
                if (!int32(code) || typeof message !== 'string' || message.length > 8192) fail('INVALID_RESPONSE', 'QQ returned an invalid unread query acknowledgment');
                if (code !== 0) fail('KERNEL_ERROR', 'QQ rejected the unread query');
                current.acknowledged = true;
            } catch (error) { current.finish(error); }
        }, error => { token.nativeSettled = true; current.finish(nativeFailure(error)); release(); });
        try { return await capture.deadline(() => response, context); }
        finally { current.finish(Object.assign(new Error('Unread snapshot observation closed'), { code: 'EXPIRED' })); }
    }
    return { snapshot, clear, listenerMethods: { msg: { onContactUnreadCntUpdate: observe } } };
}

module.exports = { FIELDS, decodeContactUnreadFrame, createPeerUnread };
