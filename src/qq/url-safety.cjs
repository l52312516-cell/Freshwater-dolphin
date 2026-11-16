'use strict';

const protocol = require('./url-safety-protocol.cjs');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function createUrlSafety(capture, { native = require('./msf-native.cjs') } = {}) {
    const pending = new Set(); let generation = 0;
    const capabilities = () => ({ urlSafety: native.available(), nativeUrlSafety: capture.hasMethods('msg', ['checkMsgWithUrl']) });
    async function run(data, context, nativeQuery) {
        protocol.fields(data, ['url', 'expectedEpoch']); const target = protocol.url(data.url); capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: protocol.uin(capture.self?.uin), uid: capture.self?.uid, generation };
        if (data.expectedEpoch !== saved.epoch) fail('SESSION_CHANGED', 'URL safety lookup must bind the current QQ session');
        if (!capabilities()[nativeQuery ? 'nativeUrlSafety' : 'urlSafety']) fail('UNSUPPORTED', 'This QQ session has no requested URL safety transport');
        if (pending.size >= 4) fail('BUSY', 'Too many URL safety lookups await physical completion');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 10000, context.expiresAt ?? Infinity) };
        const active = () => { capture.ensureReady(); if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session ||
            capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during URL safety lookup');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) fail('EXPIRED', 'URL safety lookup exceeded its deadline'); };
        active(); const token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active();
            if (nativeQuery) {
                let reply; try { reply = await capture.invoke('msg', 'checkMsgWithUrl', [{ urls: [target], qqPfTo: 'mqq.group' }]); }
                catch { active(); fail('QUERY_FAILED', 'Native URL safety lookup failed without retry'); }
                active(); return { uin: saved.uin, url: target, native: protocol.validateNative(reply, target) };
            }
            const result = await native.run(capture, { op: 'fixedUrlSafety', operation: 'url.check', request: { url: target, uin: saved.uin },
                expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: bounded.signal, timeoutMs: Math.max(1, Math.min(10000, bounded.expiresAt - Date.now())) });
            active();
            if (!result || result.operation !== 'url.check' || result.uin !== saved.uin || result.url !== target || ![1, 2, 3].includes(result.level)) fail('INVALID_RESPONSE', 'QQ returned an unrelated URL reputation result');
            return result;
        });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 10000); active(); return result;
    }
    return { capabilities, query(data, context = {}) { return run(data, context, false); },
        nativeQuery(data, context = {}) { return run(data, context, true); }, clear() { generation++; } };
}
module.exports = { createUrlSafety };
