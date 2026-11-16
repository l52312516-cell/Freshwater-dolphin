'use strict';

const p = require('./qzone-protocol.cjs');
const { createWeb } = require('./qzone-web.cjs');
const ENDPOINT = 'https://proxy.vip.qq.com/cgi-bin/srfentry.fcgi';
function text(value, empty = true, code = 'INVALID_PARAMS') { return p.string(value, 512, empty, code); }
function prepare(operation, request, self, timestamp, token) {
    if (!['get', 'set'].includes(operation) || !p.object(request) || Object.keys(request).some(key => !['model', 'modelShow'].includes(key))) p.fail('INVALID_PARAMS', 'Invalid fixed model display request');
    const model = text(request.model ?? ''), show = operation === 'set' ? text(request.modelShow, true) : '';
    const method = operation === 'get' ? '13030' : '13031';
    const req = { lUin: Number(p.uin(self)), sModel: encodeURIComponent(model), iAppType: 0,
        // Desktop QQ has no Android IMEI. Do not manufacture a mobile identity.
        sIMei: '', bShowInfo: true, sModelShow: encodeURIComponent(show), bRecoverDefault: operation === 'set' && show === '' };
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({ ts: String(timestamp), daid: '18', g_tk: String(token), pt4_token: '', data: JSON.stringify({ [method]: { req } }) }).toString();
    return { method, url: url.href };
}
function parse(source, operation) {
    let result;
    try { p.parse(source); result = JSON.parse(source); } catch { p.fail('INVALID_RESPONSE', 'QQ model display returned no exact JSON result'); }
    const method = operation === 'get' ? '13030' : '13031', leaf = result?.[method];
    if (!p.object(result) || !p.object(leaf)) p.fail('INVALID_RESPONSE', 'QQ omitted the fixed model display result');
    for (const [object, keys] of [[result, ['ret', 'ecode']], [leaf, ['ret']]]) for (const key of keys) if (Object.hasOwn(object,key)) {
        if (!Number.isSafeInteger(object[key])) p.fail('INVALID_RESPONSE', 'Invalid QQ model display status');
        if (object[key] !== 0) p.fail('KERNEL_ERROR', 'QQ rejected the model display request');
    }
    if (leaf.ret !== 0) p.fail('INVALID_RESPONSE', 'QQ omitted an explicit model display acknowledgement');
    const response = leaf.data?.rsp;
    if (!p.object(leaf.data) || !p.object(response)) p.fail('INVALID_RESPONSE', 'QQ omitted the model display business response');
    for (const key of ['iRet', 'ret']) if (Object.hasOwn(response, key)) {
        if (!Number.isSafeInteger(response[key])) p.fail('INVALID_RESPONSE', 'Invalid QQ model display business status');
        if (response[key] !== 0) p.fail('KERNEL_ERROR', 'QQ rejected the model display request');
    }
    if (operation === 'set') {
        // Legacy implementations ignore this body. Require a separate explicit
        // business ACK as well; a method/gateway success alone is insufficient.
        if (!['iRet', 'ret'].some(key => Object.hasOwn(response, key))) p.fail('INVALID_RESPONSE', 'QQ omitted a model display change business acknowledgement');
        return { confirmed: true, confirmation: 'server_ack' };
    }
    const items = response.vItemList;
    if (!Array.isArray(items) || items.length > 256) p.fail('INVALID_RESPONSE', 'QQ omitted its complete model display catalog');
    return items.map(item => {
        if (!p.object(item) || typeof item.bNeedPay !== 'boolean') p.fail('INVALID_RESPONSE', 'QQ returned an invalid model display variant');
        return { variants: { model_show: text(item.sModelShow, false, 'INVALID_RESPONSE'), need_pay: item.bNeedPay } };
    });
}
function createModelShow(capture, { fetchImpl = globalThis.fetch, web = createWeb(capture, fetchImpl, 'modelShow') } = {}) {
    let generation = 0; const pending = new Set();
    const capabilities = () => ({ modelShowRead: typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']),
        modelShowSet: typeof fetchImpl === 'function' && capture.hasMethods('ticket', ['forceFetchClientKey']) });
    async function execute(data, context = {}) {
        if (!p.object(data) || Object.keys(data).some(key => !['operation', 'model', 'modelShow', 'expectedEpoch'].includes(key))) p.fail('INVALID_PARAMS', 'Unexpected model display fields');
        capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: p.uin(capture.self?.uin), uid: capture.self?.uid, generation };
        if (data.expectedEpoch !== saved.epoch) p.fail('SESSION_CHANGED', 'Model display must bind the current account session');
        prepare(data.operation, { model: data.model, ...(data.operation === 'set' ? { modelShow: data.modelShow } : {}) }, saved.uin, 1, 0);
        if (!capabilities()[data.operation === 'get' ? 'modelShowRead' : 'modelShowSet']) p.fail('UNSUPPORTED', 'QQ model display authentication is unavailable');
        if (pending.size >= 4) p.fail('BUSY', 'Model display requests await physical completion');
        const bounded = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + 15000) };
        const active = () => {
            capture.ensureReady();
            if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session || String(capture.self?.uin) !== saved.uin || capture.self?.uid !== saved.uid) p.fail('SESSION_CHANGED', 'QQ changed during model display request');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) p.fail('EXPIRED', 'Model display request expired; a submitted change may be unknown');
        };
        const scope = { saved, context: bounded, active }, token = {}; pending.add(token);
        const task = Promise.resolve().then(async () => {
            active(); const auth = await web.authenticate(scope); active();
            if (typeof auth.p_skey !== 'string' || !auth.p_skey) p.fail('AUTH_FAILED', 'QQ supplied no VIP domain key');
            const prepared = prepare(data.operation, { model: data.model, ...(data.operation === 'set' ? { modelShow: data.modelShow } : {}) }, saved.uin, Date.now(), auth.key);
            const response = await web.request(prepared.url, { headers: { Cookie: auth.cookie(prepared.url), Referer: 'https://vip.qq.com/', 'User-Agent': 'Freshwater/0.2' } }, scope);
            active(); if (response.status !== 200) p.fail('QUERY_FAILED', 'QQ model display endpoint did not return HTTP 200');
            return { operation: data.operation, uin: saved.uin, result: parse(response.text, data.operation) };
        }).catch(error => { p.fail(['INVALID_RESPONSE','INVALID_PARAMS','SESSION_CHANGED','EXPIRED','TIMEOUT','AUTH_FAILED','KERNEL_ERROR','UNSUPPORTED'].includes(error?.code) ? error.code : 'QUERY_FAILED', 'QQ model display request did not complete'); });
        task.then(() => pending.delete(token), () => pending.delete(token));
        const result = await capture.deadline(() => task, bounded, 15000); active(); return result;
    }
    return { execute, capabilities, clear() { generation++; } };
}
module.exports = { createModelShow, prepare, parse, ENDPOINT };
