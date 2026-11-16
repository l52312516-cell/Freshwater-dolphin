'use strict';

const crypto = require('node:crypto');
const protocol = require('./forward-upload-protocol.cjs');
const { uint } = require('./admin-oidb.cjs');
const MAX_ATTEMPTS = 128;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function serverTimeShape(value) {
    const type = value === null ? 'null' : typeof value;
    const kind = ['bigint', 'number', 'string'].includes(type) ? 'primitive-' + type : ['object', 'undefined'].includes(type) ? type : 'other';
    let integer;
    if (type === 'bigint') integer = value;
    else if (type === 'number' && Number.isSafeInteger(value)) integer = BigInt(value);
    else if (type === 'string' && /^[1-9]\d{0,19}$/.test(value)) integer = BigInt(value);
    const range = integer === undefined ? 'not-exact-integer' : integer > 0n && integer <= 0xffffffffn ? 'uint32' :
        integer >= 1000000000000n && integer <= 0xffffffffn * 1000n + 999n ? 'milliseconds-range' : 'other-integer-range';
    return kind + ':' + range;
}
function serverTimeSeconds(value) {
    // QQ 3.2.35-54395 was observed returning a decimal millisecond string.
    // Parse that exact integer before truncating only its millisecond remainder;
    // never derive display timestamps from the worker's local wall clock.
    if (typeof value === 'string' && /^[1-9]\d{12}$/.test(value)) {
        const milliseconds = BigInt(value);
        if (milliseconds >= 1000000000000n && milliseconds <= 0xffffffffn * 1000n + 999n) {
            return uint((milliseconds / 1000n).toString(), 'QQ server time', 0xffffffffn, 1n);
        }
    }
    return uint(value, 'QQ server time', 0xffffffffn, 1n);
}
function createForwardUpload(capture, { native = require('./msf-native.cjs') } = {}) {
    // Physical work outlives the calling RPC deadline and account epoch.
    let pending;
    const attempted = new Set(); let owner;
    function capabilities() {
        // This build returns a resource but its full server readback differs
        // from the submitted bytes. Keep the exact proof and stop new uploads.
        return { forwardUpload: capture.qqVersion !== '3.2.35-54395' && native.available() && capture.hasMethods('msf', ['getServerTime']) };
    }
    async function upload(data, context = {}) {
        protocol.fields(data, ['nodes', 'groupId', 'expectedEpoch']);
        const nodes = protocol.normalizeNodes(data.nodes), groupId = data.groupId === undefined ? undefined : uint(data.groupId, 'forward resource group', 0xffffffffn, 1n);
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Forward upload must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        uint(saved.uin, 'authenticated forward author', 0xffffffffn, 1n);
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) fail('NOT_READY', 'Forward upload needs the authenticated QQ UID');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid forward upload deadline');
        context = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + 60000) };
        function active() {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during forward resource upload');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Forward upload expired; an entered upload is never retried automatically');
        }
        active();
        if (!capabilities().forwardUpload) fail('UNSUPPORTED', 'QQ fixed long-message resource upload is unavailable');
        if (pending) fail('BUSY', 'Another physical forward upload remains pending');
        if (!owner || owner.epoch !== saved.epoch || owner.session !== saved.session || owner.uin !== saved.uin || owner.uid !== saved.uid) { owner = saved; attempted.clear(); }
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([groupId ?? null, nodes])).digest('hex');
        if (attempted.has(fingerprint)) fail('BUSY', 'This resource content was already submitted in the current account session; automatic upload retry is refused');
        if (attempted.size >= MAX_ATTEMPTS) fail('BUSY', 'The session forward resource attempt limit was reached');
        const token = {}; pending = token;
        async function fixed(operation, request) {
            active();
            const value = await native.run(capture, { op: 'fixedForwardUpload', operation, request, expectedEpoch: saved.epoch,
                expectedUin: saved.uin, signal: context.signal, timeoutMs: Math.max(1, Math.min(10000, context.expiresAt - Date.now())) });
            active();
            if (!value || typeof value !== 'object' || value.operation !== operation) fail('INVALID_RESPONSE', 'QQ returned an unrelated forward resource operation');
            return value;
        }
        let phase = 'server-time', timeShape;
        const task = Promise.resolve().then(async () => {
            active();
            const serverTime = await capture.invoke('msf', 'getServerTime', []); active();
            phase = 'server-time-normalize'; timeShape = serverTimeShape(serverTime);
            let time;
            try { time = serverTimeSeconds(serverTime); }
            catch { fail('INVALID_RESPONSE', 'QQ did not return an exact server time for the forward resource'); }
            phase = 'prepare';
            const sequences = new Set(), randoms = new Set();
            const unique = seen => { let value; do { value = String(crypto.randomInt(1, 0x80000000)); } while (seen.has(value)); seen.add(value); return value; };
            const prepared = protocol.prepare('forward.upload', { selfUin: saved.uin, selfUid: saved.uid, ...(groupId ? { groupId } : {}),
                nodes: nodes.map(node => ({ ...node, time, sequence: unique(sequences), random: unique(randoms) })) });
            active(); attempted.add(fingerprint);
            phase = 'upload';
            const result = await fixed('forward.upload', prepared.data), resId = protocol.resource(result.resId, 'INVALID_RESPONSE');
            phase = 'readback';
            const readback = await fixed('forward.readUploaded', { selfUid: saved.uid, resId });
            phase = 'verify-content';
            if (readback.resId !== resId || typeof readback.payloadBase64 !== 'string' || readback.payloadBase64 !== prepared.rawPayload.toString('base64')) fail('INVALID_RESPONSE', 'QQ uploaded forward content did not exactly match the complete submitted resource');
            active();
            return { uploaded: true, sent: false, confirmation: 'fixed-longmsg-resource-and-exact-readback', resId,
                nodeCount: nodes.length, ...(groupId ? { groupId } : {}) };
        }).catch(error => {
            const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'INVALID_RESPONSE';
            // Only closed stage/type/range enums cross this error boundary.
            // Native values, resource IDs and packet bytes are never attached.
            fail(code, 'QQ forward resource operation failed; phase=' + phase +
                (phase === 'server-time-normalize' ? '; server_time=' + timeShape : ''));
        });
        task.finally(() => { if (pending === token) pending = undefined; }).catch(() => {});
        return capture.deadline(() => task, context, 60000);
    }
    return { capabilities, upload };
}
module.exports = { createForwardUpload, MAX_ATTEMPTS };
