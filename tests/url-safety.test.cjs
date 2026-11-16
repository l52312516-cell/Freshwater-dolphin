'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs'), protocol = require('../src/qq/url-safety-protocol.cjs');
const { createUrlSafety } = require('../src/qq/url-safety.cjs');
const { runUrlSafety } = require('../src/onebot/url-safety-actions.cjs');
const { Capture } = require('../src/qq/capture.cjs');
const target = 'https://example.com/path?q=123', n = p.varintField, b = p.bytesField, s = (f, v) => b(f, Buffer.from(v));
function response(entry = [s(1, target), n(7, 2)], extra = []) {
    return Buffer.concat([n(1, 0xbcb), n(2, 0), n(3, 0), b(4, b(10, b(1, Buffer.concat(entry)))), ...extra]);
}
test('URL safety uses only the fixed reputation command and genuine self account identity', () => {
    const value = protocol.prepare('url.check', { url: target, uin: '11111' }); assert.equal(value.name, 'OidbSvcTrpcTcp.0xbcb_0');
    const top = p.fields(value.body), request = p.fields(p.fields(top.get(4)[0].value).get(10)[0].value);
    assert.equal(request.get(4)[0].value.toString(), 'mqq.group'); assert.equal(request.get(9)[0].value, 11111n);
    assert.equal(request.get(1)[0].value.toString(), target); assert.equal(request.get(11)[0].value.toString(), target);
    assert.equal(request.get(10)[0].value.toString(), 'webview');
});
test('URL levels follow verified jump URL and UMR semantics without guessing result enums', () => {
    const value = protocol.prepare('url.check', { url: target, uin: '11111' });
    assert.equal(protocol.decode(response(), value).level, 1);
    assert.equal(protocol.decode(response([s(1, target), n(7, 1), n(2, 0)]), value).level, 2);
    assert.equal(protocol.decode(response([s(1, target), n(7, 2), s(4, 'https://c.pc.qq.com/warning')]), value).level, 3);
    assert.equal(protocol.decode(response([s(1, target), n(7, 2), s(4, '')]), value).level, 3);
    assert.equal(protocol.decode(response([s(1, target), n(2, 999)]), value).level, 2);
});
test('missing, unrelated, ambiguous or malformed URL responses cannot become a safe verdict', () => {
    const value = protocol.prepare('url.check', { url: target, uin: '11111' });
    for (const bytes of [Buffer.alloc(0), n(1, 0xbcb), response([s(1, 'https://other.example/'), n(7, 2)]), response([n(7, 2)]),
        response([s(1, target), n(7, 2), n(7, 3)]), response([s(1, target), n(7, 0x100000000n)]), response([s(1, target), b(4, Buffer.from([0xff]))]),
        response(undefined, [n(3, 0)]), Buffer.alloc(protocol.MAX_RESPONSE_BYTES + 1)]) assert.throws(() => protocol.decode(bytes, value), { code: 'INVALID_RESPONSE' });
    const denied = Buffer.concat([n(1, 0xbcb), n(2, 0), n(3, 5), s(5, 'private diagnostic')]);
    assert.throws(() => protocol.decode(denied, value), error => error.code === 'KERNEL_ERROR' && !error.message.includes('private'));
});
function fixture() {
    const calls = [], capture = { epoch: 'e1', session: {}, self: { uin: '11111', uid: 'u_self' }, pending: new Set(),
        ensureReady() {}, hasMethods: () => true, deadline: Capture.prototype.deadline };
    let reply = () => protocol.decode(response(), protocol.prepare('url.check', { url: target, uin: '11111' }));
    const native = { available: () => true, run: async (_capture, data) => { calls.push(data); return reply(); } };
    capture.invoke = async (service, method, args) => { calls.push({ service, method, args }); return { result: 0, errMsg: '', checkUrlsResult: [{ url: target, result: 0, jumpResult: 0, jumpUrl: '' }] }; };
    const api = createUrlSafety(capture, { native }), state = { self: capture.self, epoch: 'e1', capabilities: { urlSafety: true } };
    const service = { sessionCall: (_state, method, params) => { assert.equal(method, 'urlSafetyQuery'); return api.query({ ...params, expectedEpoch: state.epoch }); }, assertSession: async () => {} };
    return { api, state, service, capture, calls, native, reply(value) { reply = value; }, query: (context = {}) => api.query({ expectedEpoch: capture.epoch, url: target }, context),
        action: (params = { url: target }) => runUrlSafety(service, state, 'check_url_safely', params) };
}
test('URL action publishes only a correctly scoped fixed lookup and native diagnostics retain raw status', async () => {
    const f = fixture(); assert.deepEqual(await f.action(), { level: 1 });
    assert.equal(f.calls[0].op, 'fixedUrlSafety'); assert.deepEqual(f.calls[0].request, { url: target, uin: '11111' });
    const native = await f.api.nativeQuery({ expectedEpoch: 'e1', url: target });
    assert.deepEqual(native.native.checkUrlsResult, [{ url: target, result: 0, jumpResult: 0, jumpUrl: '' }]); assert.equal(native.level, undefined);
    assert.deepEqual(f.calls[1], { service: 'msg', method: 'checkMsgWithUrl', args: [{ urls: [target], qqPfTo: 'mqq.group' }] });
});
test('URL inputs, capability, deadlines, identity and bridge echoes are independently enforced', async () => {
    const f = fixture();
    for (const value of [{}, { url: 'file:///tmp/a' }, { url: 'https://user:pw@example.com/' }, { url: '\ud800' }, { url: target, extra: true }, { url: target, self_id: '22222' }]) await assert.rejects(f.action(value), { code: 'INVALID_PARAMS' });
    assert.equal(f.calls.length, 0); f.state.capabilities.urlSafety = false; await assert.rejects(f.action(), { code: 'UNSUPPORTED' });
    const g = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(g.query({ signal: controller.signal }), { code: 'EXPIRED' }); assert.equal(g.calls.length, 0);
    let finish; g.reply(() => new Promise(resolve => { finish = resolve; })); const pending = g.query(), rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' }); await new Promise(resolve => setImmediate(resolve));
    g.capture.epoch = 'e2'; finish({ operation: 'url.check', uin: '11111', url: target, level: 1 }); await rejected;
    const h = fixture(); h.reply(() => ({ operation: 'url.check', uin: '22222', url: target, level: 1 })); await assert.rejects(h.action(), { code: 'INVALID_RESPONSE' });
});
test('all unresolved URL work keeps physical slots occupied after cancellation and clear', async () => {
    const f = fixture(), finish = []; f.reply(() => new Promise(resolve => finish.push(resolve)));
    for (let i = 0; i < 4; i++) { const controller = new AbortController(), pending = f.query({ signal: controller.signal }), rejected = assert.rejects(pending, { code: 'EXPIRED' }); await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected; }
    f.api.clear(); await assert.rejects(f.query(), { code: 'BUSY' }); assert.equal(f.calls.length, 4);
    for (const resolve of finish) resolve({ operation: 'url.check', uin: '11111', url: target, level: 1 }); await new Promise(resolve => setImmediate(resolve));
    f.reply(() => ({ operation: 'url.check', uin: '11111', url: target, level: 2 })); assert.equal((await f.query()).level, 2);
});
