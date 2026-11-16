'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthExtra, csrf, databaseSalt } = require('../src/qq/auth-extra.cjs');
const { runAuthExtra } = require('../src/onebot/auth-extra-actions.cjs');
const protocol = require('../src/qq/db-key-protocol.cjs');
const p = require('../src/qq/proto.cjs');
const { createPacketStatistics } = require('../src/qq/packet-statistics.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
    const calls = [], http = [], overrides = {};
    const capture = { epoch: 'auth-epoch', session: {}, self: { uin: '11111', uid: 'u_self' }, ensureReady() {}, hasMethods: () => true, deadline: operation => operation(),
        async invoke(service, method, args) { calls.push({ service, method, args }); if (overrides.invoke) return overrides.invoke(service, method, args);
            return { result: 0, clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' }; } };
    const native = { available: () => true, async run(bound, params) { calls.push({ bound, params }); return overrides.run ? overrides.run(params) : { key: 'DB-KEY-FIXTURE' }; } };
    async function fetchImpl(target, request) {
        const url = new URL(target); http.push({ url, request }); if (overrides.fetch) return overrides.fetch(url, request);
        if (url.hostname === 'ssl.ptlogin2.qq.com') {
            const headers = new Headers({ location: url.searchParams.get('u1') });
            headers.append('set-cookie', 'uin=o11111; Domain=.qq.com; Path=/'); headers.append('set-cookie', 'skey=SKEY-FIXTURE; Domain=.qq.com; Path=/');
            return new Response('', { status: 302, headers });
        }
        const domain = url.hostname === 'user.qzone.qq.com' ? 'qzone.qq.com' : url.hostname;
        return new Response('', { headers: { 'set-cookie': 'p_skey=PSKEY-FIXTURE; Domain=.' + domain + '; Path=/' } });
    }
    const api = createAuthExtra(capture, { native, fetchImpl, ...options });
    return { api, capture, calls, http, overrides, query: (operation, extra = {}, context = {}) => api.query({ operation, expectedEpoch: capture.epoch, ...extra }, context) };
}
test('client tickets preserve real native expiry and index and never invent missing metadata', async () => {
    const f = fixture();
    assert.deepEqual(await f.query('auth.clientKey'), { operation: 'auth.clientKey', uin: '11111', result: { clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' } });
    assert.deepEqual(f.calls[0], { service: 'ticket', method: 'forceFetchClientKey', args: [''] }); assert.equal(f.http.length, 0);
    for (const value of [{ result: 0, clientKey: 'CLIENT-FIXTURE', keyIndex: '19' }, { result: 1, clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' }]) {
        f.overrides.invoke = async () => value; await assert.rejects(f.query('auth.clientKey'), error => error.code === 'INVALID_RESPONSE' && !/CLIENT-FIXTURE|1800/.test(error.message));
    }
});
test('fixed domain cookies and credentials use authenticated account jars; standalone CSRF uses skey, not p_skey', async () => {
    for (const domain of ['qun.qq.com', 'web.qun.qq.com', 'qzone.qq.com', 'vip.qq.com']) {
        const f = fixture(), response = await f.query('auth.credentials', { domain });
        assert.match(response.result.cookies, /uin=o11111/); assert.match(response.result.cookies, /p_skey=PSKEY-FIXTURE/);
        assert.equal(response.result.token, csrf('PSKEY-FIXTURE')); assert.equal(response.result.csrf_token, response.result.token);
        assert.equal(f.http.length, 2); assert.equal(f.http[0].request.redirect, 'manual');
        assert.deepEqual((await f.query('auth.cookies', { domain })).result, { cookies: response.result.cookies });
    }
    const f = fixture(); assert.deepEqual((await f.query('auth.csrf')).result, { token: csrf('SKEY-FIXTURE') });
    assert.deepEqual((await f.query('auth.credentials', { domain: '' })).result, (await f.query('auth.credentials')).result);
    assert.notEqual(csrf('SKEY-FIXTURE'), csrf('PSKEY-FIXTURE'));
});
test('auth query rejects arbitrary domains, URL fields, foreign self and stale epochs before credential acquisition', async () => {
    for (const extra of [{ domain: 'qq.com' }, { domain: 'qun.qq.com.evil.invalid' }, { domain: 'https://qun.qq.com/' }, { domain: 'qun.qq.com', url: 'https://example.invalid/' }, { expectedEpoch: 'old' }]) {
        const f = fixture(); await assert.rejects(f.query('auth.cookies', extra)); assert.equal(f.calls.length, 0); assert.equal(f.http.length, 0);
    }
    const f = fixture(), state = { self: f.capture.self, capabilities: f.api.capabilities() };
    await assert.rejects(runAuthExtra({ sessionCall() { throw new Error('must not call'); } }, state, 'get_clientkey', { self_id: '22222' }), { code: 'INVALID_PARAMS' });
});
test('native and HTTP errors are sanitized and changed sessions cannot return credentials', async () => {
    for (const kind of ['native-error', 'epoch', 'uid', 'session', 'clear']) {
        const f = fixture(); f.overrides.invoke = async () => {
            if (kind === 'native-error') throw new Error('PRIVATE-NATIVE-TICKET-AND-PATH');
            if (kind === 'epoch') f.capture.epoch = 'new'; if (kind === 'uid') f.capture.self.uid = 'u_other';
            if (kind === 'session') f.capture.session = {}; if (kind === 'clear') f.api.clear();
            return { result: 0, clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' };
        };
        await assert.rejects(f.query('auth.clientKey'), error => !/PRIVATE|CLIENT-FIXTURE|11111/.test(error.message));
    }
    const f = fixture(); f.overrides.fetch = async () => { throw new Error('PRIVATE-COOKIE-URL'); };
    await assert.rejects(f.query('auth.cookies'), error => !/PRIVATE|CLIENT-FIXTURE|11111/.test(error.message));
});
test('caller timeouts retain bounded physical credential slots until native calls actually finish', async () => {
    const f = fixture(), releases = []; f.overrides.invoke = () => new Promise(resolve => releases.push(resolve));
    f.capture.deadline = operation => { operation().catch(() => {}); return Promise.reject(Object.assign(new Error('caller expired'), { code: 'TIMEOUT' })); };
    for (let i = 0; i < 4; i++) await assert.rejects(f.query('auth.clientKey'), { code: 'TIMEOUT' });
    await turn(); await assert.rejects(f.query('auth.clientKey'), { code: 'BUSY' }); assert.equal(f.calls.length, 4);
    for (const release of releases) release({ result: 0, clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' }); await turn();
    f.capture.deadline = operation => operation(); f.overrides.invoke = null; assert.equal((await f.query('auth.clientKey')).result.keyIndex, '19');
});
function databaseFixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'auth-db-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); const databaseRoot = path.join(root, 'managed-account'); fs.mkdirSync(databaseRoot);
    const filename = path.join(databaseRoot, 'nt_msg.db'), salt = 'Ab'.repeat(64), header = Buffer.alloc(0xaf); header.write(salt, 0x2f, 'ascii'); fs.writeFileSync(filename, Buffer.concat([header, Buffer.alloc(10000)]));
    return { root, databaseRoot, filename, salt, header };
}
test('database keys read only the exact local salt header inside trusted account roots and use one fixed bound request', async t => {
    const d = databaseFixture(t), f = fixture({ databaseRoots: [d.databaseRoot] });
    assert.deepEqual((await f.query('auth.decryptKey', { dbPath: d.filename })).result, { db_key: 'DB-KEY-FIXTURE' });
    const call = f.calls[0]; assert.equal(call.bound, f.capture); assert.deepEqual(call.params.request, { salt: d.salt.toLowerCase() });
    assert.equal(call.params.op, 'fixedDbKey'); assert.equal(call.params.operation, 'db.key'); assert.equal(call.params.expectedUin, '11111'); assert.equal(call.params.expectedEpoch, 'auth-epoch'); assert.equal(f.http.length, 0);
    for (const name of [path.join(d.root, 'foreign.db'), path.join(d.databaseRoot, '..', 'foreign.db')]) {
        fs.writeFileSync(name, d.header); await assert.rejects(f.query('auth.decryptKey', { dbPath: name }));
    }
    assert.equal(f.calls.length, 1);
    const invalid = Buffer.from(d.header); invalid[0x2f] = 0xc1; fs.writeFileSync(d.filename, invalid);
    assert.throws(() => databaseSalt(d.filename, [d.databaseRoot]), { code: 'INVALID_PARAMS' });
    fs.writeFileSync(d.filename, Buffer.alloc(0xae)); assert.throws(() => databaseSalt(d.filename, [d.databaseRoot]), { code: 'INVALID_PARAMS' });
});
test('database symlink paths cannot select another account header', t => {
    const d = databaseFixture(t), link = path.join(d.databaseRoot, 'link.db');
    try { fs.symlinkSync(d.filename, link); } catch (error) { if (error.code === 'EPERM') { t.skip('Symbolic links unavailable'); return; } throw error; }
    assert.throws(() => databaseSalt(link, [d.databaseRoot]), { code: 'INVALID_PARAMS' });
});
test('fixed database protocol validates command echoes, exact salt, duplicate fields, bounded key and nonzero result', () => {
    const prepared = protocol.prepare('db.key', { salt: 'Ab'.repeat(64) }), one = (map, field) => map.get(field)[0].value;
    const request = p.fields(prepared.body), body = p.fields(one(request, 4));
    assert.equal(one(request, 1), 0xcden); assert.equal(one(request, 2), 2n); assert.equal(one(request, 12), 0n);
    assert.equal(one(p.fields(one(body, 2)), 1).toString(), 'ab'.repeat(64));
    const response = (key, result = 0, command = 0xcde) => Buffer.concat([p.varintField(1, command), p.varintField(2, 2), p.varintField(3, result), p.bytesField(4, p.messageField(2, [p.bytesField(1, key)]))]);
    assert.deepEqual(protocol.decode(response(Buffer.from('DB-KEY-FIXTURE')), prepared), { key: 'DB-KEY-FIXTURE' });
    for (const bytes of [response(Buffer.alloc(0)), response(Buffer.alloc(4097, 65)), response(Buffer.from([0xff])), response(Buffer.from('x'), 1006), response(Buffer.from('x'), 0, 0x102a), Buffer.concat([response(Buffer.from('x')), p.varintField(2, 2)])]) assert.throws(() => protocol.decode(bytes, prepared));
    for (const input of [{ salt: 'a'.repeat(127) }, { salt: 'z'.repeat(128) }, { salt: 'a'.repeat(128), command: 'Other' }]) assert.throws(() => protocol.prepare('db.key', input), { code: 'INVALID_PARAMS' });
});
test('public auth actions retain exact reference shapes and reject mismatched account or token responses', async () => {
    const f = fixture(), state = { self: f.capture.self, capabilities: f.api.capabilities() };
    const service = { async sessionCall(bound, method, params) { assert.equal(bound, state); assert.equal(method, 'authQuery'); return f.query(params.operation, Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'operation'))); }, async assertSession() {} };
    assert.deepEqual(await runAuthExtra(service, state, 'get_clientkey', {}), { clientKey: 'CLIENT-FIXTURE', expireTime: '1800', keyIndex: '19' });
    assert.deepEqual(await runAuthExtra(service, state, 'get_csrf_token', {}), { token: csrf('SKEY-FIXTURE') });
    const credentials = await runAuthExtra(service, state, 'get_credentials', {}); assert.equal(credentials.token, credentials.csrf_token); assert.match(credentials.cookies, /PSKEY-FIXTURE/);
    for (const mutation of [value => { value.uin = '22222'; }, value => { value.operation = 'auth.cookies'; }, value => { value.result.csrf_token++; }]) {
        const bad = { ...service, async sessionCall() { const value = await f.query('auth.credentials'); mutation(value); return value; } };
        await assert.rejects(runAuthExtra(bad, state, 'get_credentials', {}), { code: 'INVALID_RESPONSE' });
    }
});
test('packet statistics contain only exact aggregate counters, byte counts and explicit limited scope', () => {
    const collector = createPacketStatistics(); collector.record('queued'); collector.record('submitted', 7); collector.record('response', 11); collector.record('succeeded'); collector.record('timed_out');
    assert.deepEqual(collector.snapshot(), { scope: 'adapter-native-sso', resetScope: 'worker-process', includesAllQQTraffic: false, includesUnawaitedResponses: false,
        counters: { queued: 1, submitted: 1, response: 1, succeeded: 1, failed: 0, cancelled: 0, timed_out: 1 }, requestBytes: 7, responseBytes: 11 });
    const snapshot = collector.snapshot(); snapshot.counters.queued = 999; assert.equal(collector.snapshot().counters.queued, 1);
    for (const args of [['PRIVATE-COMMAND'], ['queued', 1], ['submitted', -1], ['response', 1.2], ['response', Buffer.from('PRIVATE-PACKET')]]) assert.throws(() => collector.record(...args), { code: 'INVALID_PARAMS' });
    assert.equal(JSON.stringify(collector.snapshot()).includes('PRIVATE'), false);
});
