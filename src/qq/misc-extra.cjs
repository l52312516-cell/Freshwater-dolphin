'use strict';
const protocol = require('./misc-extra-protocol.cjs');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function createMiscExtra(capture, { native = require('./msf-native.cjs') } = {}) {
    const pending = new Set(), writes = new Set();
    // Both authorized target accounts rejected this Android card protocol with
    // business code 901501. Keep it unavailable on that verified Linux build.
    // New builds do not inherit support merely by differing from a rejected
    // build. Only an explicitly validated future profile may enable this.
    const tuwenAvailable = () => native.available() && capture.runtimeProfile?.().features?.tuwenArk === true;
    const capabilities = () => ({ ...Object.fromEntries(['miniappArk', 'groupSign', 'selfDiyStatus', 'inlineButton'].map(key => [key, native.available()])), tuwenArk: tuwenAvailable() });
    async function execute(input, context = {}) {
        if (!protocol.object(input) || !protocol.OPERATIONS.has(input.operation)) fail('INVALID_PARAMS', 'Unknown fixed misc operation');
        const { operation, expectedEpoch, ...request } = input, prepared = protocol.prepare(operation, request);
        if (operation === 'card.send' && !tuwenAvailable()) fail('UNSUPPORTED', 'The target QQ build rejected the fixed card delivery protocol (code=901501)');
        capture.ensureReady();
        if (expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Misc operations must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        if (operation === 'group.sign' && prepared.data.selfUin !== saved.uin) fail('INVALID_PARAMS', 'Group sign belongs to another account');
        context = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + 10000) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the misc operation');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Misc operation expired; dispatched writes are never retried');
        };
        active(); if (!native.available()) fail('UNSUPPORTED', 'QQ fixed misc channel is unavailable');
        const write = operation !== 'miniapp.ark', key = JSON.stringify([operation, prepared.data]);
        if (pending.size >= 4 || write && writes.has(key)) fail('BUSY', 'The fixed misc operation is already pending or at capacity');
        const token = {}; pending.add(token); if (write) writes.add(key);
        const task = Promise.resolve().then(async () => {
            active(); const value = await native.run(capture, { op: 'fixedMiscExtra', operation, request: prepared.data, expectedEpoch: saved.epoch, expectedUin: saved.uin,
                signal: context.signal, timeoutMs: Math.max(1, context.expiresAt - Date.now()) });
            active();
            if (!protocol.object(value) || value.operation !== operation || Object.keys(prepared.data).some(key => value[key] !== prepared.data[key]) ||
                write && operation !== 'button.click' && (value.confirmed !== true || value.confirmation !== 'server_ack')) fail('INVALID_RESPONSE', 'QQ returned another fixed misc result');
            return value;
        });
        task.finally(() => { pending.delete(token); writes.delete(key); }).catch(() => {});
        return capture.deadline(() => task, context);
    }
    return { capabilities, execute };
}
module.exports = { createMiscExtra };
