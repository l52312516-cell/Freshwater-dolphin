'use strict';

const protocol = require('./share-oidb.cjs');
const MAX_PENDING = 8;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function request(params) {
    if (!plain(params) || Reflect.ownKeys(params).some(key => typeof key !== 'string' ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(params, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected Ark query data properties');
    if (!protocol.OPERATIONS.has(params.operation)) throw problem('INVALID_PARAMS', 'Unknown Ark query operation');
    const allowed = params.operation === 'group.ark' ? ['operation', 'expectedEpoch', 'groupId'] : ['operation', 'expectedEpoch', 'userId', 'phoneNumber'];
    if (Reflect.ownKeys(params).some(key => typeof key !== 'string' || !allowed.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(params, key), 'value'))) throw problem('INVALID_PARAMS', 'Unexpected Ark query fields');
    const value = params.operation === 'group.ark' ? { groupId: params.groupId } : { userId: params.userId, phoneNumber: params.phoneNumber };
    return protocol.prepare(params.operation, value);
}
function createShareQueries(capture, { native = require('./msf-native.cjs') } = {}) {
    // Caller cancellation and epoch changes never release unresolved physical
    // native requests; their slots survive until those promises really settle.
    const pending = new Set();
    function capabilities() {
        const available = native.available();
        return { groupArkShare: available, peerArkShare: available, arkShare: available };
    }
    async function query(params, context = {}) {
        const prepared = request(params);
        capture.ensureReady();
        if (typeof params.expectedEpoch !== 'string' || params.expectedEpoch !== capture.epoch) throw problem('SESSION_CHANGED', 'Ark query must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        protocol.id(saved.uin);
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) throw problem('NOT_READY', 'Ark query requires the current real QQ identity');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) throw problem('INVALID_PARAMS', 'Invalid Ark query deadline');
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) throw problem('SESSION_CHANGED', 'QQ changed during the Ark query');
            if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) throw problem('EXPIRED', 'Ark query expired or was cancelled');
        };
        active();
        if (capabilities()[prepared.operation === 'group.ark' ? 'groupArkShare' : 'peerArkShare'] !== true) throw problem('UNSUPPORTED', 'This QQ session cannot request server-generated Ark cards');
        if (pending.size >= MAX_PENDING) throw problem('BUSY', 'Too many Ark queries remain physically pending');
        const token = {}; pending.add(token);
        const operation = Promise.resolve().then(async () => {
            active();
            const result = await native.run(capture, { op: 'fixedShare', operation: prepared.operation, request: prepared.data,
                expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: context.signal,
                timeoutMs: Math.max(1, Math.min(10000, (context.expiresAt ?? Date.now() + 10000) - Date.now())) });
            active();
            if (!plain(result) || result.operation !== prepared.operation || Object.keys(prepared.data).some(key => result[key] !== prepared.data[key])) throw problem('INVALID_RESPONSE', 'QQ returned an unrelated Ark query result');
            return { operation: prepared.operation, ...prepared.data, arkMsg: protocol.validateArk(result.arkMsg) };
        });
        operation.finally(() => pending.delete(token)).catch(() => {});
        const result = await capture.deadline(() => operation, context);
        active(); return result;
    }
    return { capabilities, query };
}

module.exports = { createShareQueries, request, MAX_PENDING };
