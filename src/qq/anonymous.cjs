'use strict';

const p = require('./anonymous-protocol.cjs');
const { createWeb } = require('./qzone-web.cjs');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function createAnonymous(capture, { native = require('./msf-native.cjs'), fetchImpl = globalThis.fetch,
    web = createWeb(capture, fetchImpl, 'anonymousBan') } = {}) {
    const pending = new Set(); let generation = 0;
    function capabilities() { return { groupAnonymous: native.available(),
        groupAnonymousBan: typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']) }; }
    async function execute(data, context = {}) {
        const setting = data?.operation === 'group.anonymous';
        if (!setting && data?.operation !== 'group.anonymousBan') fail('UNSUPPORTED', 'Unknown fixed anonymous operation');
        p.fields(data, ['operation', 'expectedEpoch', 'groupId', ...(setting ? ['enable'] : ['flag', 'duration'])]);
        const request = { groupId: p.group(data.groupId), ...(setting ? { enable: data.enable } : { flag: data.flag, duration: p.duration(data.duration) }) };
        if (setting) p.prepare(data.operation, request); else p.flag(request.flag);
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid anonymous operation deadline');
        capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: p.group(capture.self?.uin), uid: capture.self?.uid, generation };
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) fail('NOT_READY', 'Anonymous operation requires the complete current account');
        if (data.expectedEpoch !== saved.epoch) fail('SESSION_CHANGED', 'Anonymous operation must bind the current QQ session');
        if (!capabilities()[setting ? 'groupAnonymous' : 'groupAnonymousBan']) fail('UNSUPPORTED', 'QQ lacks the requested anonymous operation transport');
        if (pending.size >= 4) fail('BUSY', 'Anonymous operations await physical completion');
        const bounded = { ...context, expiresAt: Math.min(Date.now() + 15000, context.expiresAt ?? Infinity) };
        const active = () => {
            capture.ensureReady();
            if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session || String(capture.self?.uin) !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during anonymous operation');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) fail('EXPIRED', 'Anonymous operation expired; a submitted change may be unknown');
        };
        active(); const scope = { saved, context: bounded, active }, token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active(); let result;
            if (setting) {
                const value = await native.run(capture, { op: 'fixedAnonymous', operation: data.operation, request,
                    expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: bounded.signal, timeoutMs: Math.max(1, Math.min(10000, bounded.expiresAt - Date.now())) });
                active();
                if (!value || value.operation !== data.operation || value.groupId !== request.groupId || value.enable !== request.enable || value.confirmed !== true || value.confirmation !== 'server_ack') fail('INVALID_RESPONSE', 'QQ returned no matching anonymous setting acknowledgement');
                result = { groupId: request.groupId, enable: request.enable, confirmed: true, confirmation: 'server_ack' };
            } else {
                const auth = await web.authenticate(scope); active();
                const prepared = p.banRequest(request, auth.skey);
                const response = await web.request(prepared.url, { method: 'POST', headers: { Cookie: auth.cookie(prepared.url),
                    'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://qqweb.qq.com/', 'User-Agent': 'Freshwater/0.2' }, body: prepared.body }, scope, 65536);
                active(); if (response.status !== 200) fail('QUERY_FAILED', 'Anonymous ban endpoint did not return HTTP 200; redirects are refused');
                result = { groupId: request.groupId, duration: request.duration, ...p.banAck(response.text) };
            }
            active(); return { operation: data.operation, uin: saved.uin, result };
        }).catch(error => { fail(['INVALID_PARAMS', 'INVALID_RESPONSE', 'SESSION_CHANGED', 'EXPIRED', 'TIMEOUT', 'AUTH_FAILED', 'UNSUPPORTED', 'KERNEL_ERROR', 'BUSY'].includes(error?.code) ? error.code : 'QUERY_FAILED', 'QQ anonymous operation did not complete; a submitted change may be unknown'); });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 15000); active(); return result;
    }
    return { capabilities, execute, clear() { generation++; } };
}
module.exports = { createAnonymous };
