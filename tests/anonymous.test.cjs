'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/anonymous-protocol.cjs');
const wire = require('../src/qq/proto.cjs');
const { createAnonymous } = require('../src/qq/anonymous.cjs');
const { runAnonymous } = require('../src/onebot/anonymous-actions.cjs');
const { createWeb } = require('../src/qq/qzone-web.cjs');
const FLAG = '匿名 & + 中@AQIDBA==';
const ack = (parts = []) => Buffer.concat([wire.varintField(1, 0x568), wire.varintField(2, 22), wire.varintField(3, 0), ...parts]);
const prepared = () => p.prepare('group.anonymous', { groupId: '123456', enable: true });

test('anonymous group setting uses the evidenced legacy service and exact big-endian body', () => {
    for (const enable of [true, false]) {
        const value = p.prepare('group.anonymous', { groupId: '4294967295', enable }), fields = wire.fields(value.body);
        assert.equal(value.name, 'OidbSvc.0x568_22'); assert.equal(fields.get(1)[0].value, 0x568n);
        assert.equal(fields.get(2)[0].value, 22n); assert.equal(fields.has(12), false); assert.equal(fields.has(6), false);
        assert.equal(fields.get(4)[0].value.toString('hex'), enable ? 'ffffffff01' : 'ffffffff00');
    }
    for (const groupId of ['0', '4294967296', '01', -1]) assert.throws(() => p.prepare('group.anonymous', { groupId, enable: true }), { code: 'INVALID_PARAMS' });
    for (const enable of [undefined, 'true', 1]) assert.throws(() => p.prepare('group.anonymous', { groupId: 1, enable }), { code: 'INVALID_PARAMS' });
});

test('anonymous setting acknowledgement must name the operation and explicitly confirm success', () => {
    assert.deepEqual(p.decode(ack(), prepared()), { operation: 'group.anonymous', groupId: '123456', enable: true, confirmed: true, confirmation: 'server_ack' });
    for (const bytes of [Buffer.alloc(0), Buffer.concat([wire.varintField(1, 0x568), wire.varintField(2, 22)]),
        Buffer.concat([wire.varintField(1, 0x569), wire.varintField(2, 22), wire.varintField(3, 0)]),
        ack([wire.varintField(3, 0)]), ack([wire.bytesField(4, Buffer.from([1]))]), ack([wire.varintField(12, 0)])]) assert.throws(() => p.decode(bytes, prepared()), { code: 'INVALID_RESPONSE' });
    assert.throws(() => p.decode(Buffer.concat([wire.varintField(1, 0x568), wire.varintField(2, 22), wire.varintField(3, 1)]), prepared()), { code: 'KERNEL_ERROR' });
});

test('anonymous ban requires a canonical binary anonymous ID and never interprets an event number as the ID', () => {
    assert.deepEqual(p.flag(FLAG), { name: '匿名 & + 中', id: 'AQIDBA==' });
    for (const flag of ['name@12345', 'name@AQIDBA', 'name@AR==', 'name@', '@AQ==', 'name\n@AQ==', 'name@https://other/']) assert.throws(() => p.flag(flag), { code: 'INVALID_PARAMS' });
    for (const value of [0, -1, 2592001, '01']) assert.throws(() => p.duration(value), { code: 'INVALID_PARAMS' });
    assert.equal(p.duration(), 1800);
});

test('anonymous ban form URL-encodes the real identity and uses skey for bkn', () => {
    const value = p.banRequest({ groupId: '123456', flag: FLAG, duration: 600 }, 'fixture-skey');
    const body = new URLSearchParams(value.body);
    assert.equal(value.url, 'https://qqweb.qq.com/c/anonymoustalk/blacklist');
    assert.equal(body.get('anony_id'), 'AQIDBA=='); assert.equal(body.get('anony_nick'), '匿名 & + 中');
    assert.equal(body.get('group_code'), '123456'); assert.equal(body.get('seconds'), '600');
    let expected = 5381; for (const byte of Buffer.from('fixture-skey')) expected = (Math.imul(expected, 33) + byte) | 0;
    assert.equal(body.get('bkn'), String(expected & 0x7fffffff));
});

test('anonymous ban only accepts explicit retcode and cgicode zero from exact JSON', () => {
    assert.deepEqual(p.banAck('{"retcode":0,"cgicode":0}'), { confirmed: true, confirmation: 'server_ack' });
    for (const value of ['{}', '{"retcode":0}', '{"retcode":"0","cgicode":0}', '{"retcode":0,"retcode":1,"cgicode":0}', 'callback({"retcode":0,"cgicode":0})', '<html>ok</html>']) assert.throws(() => p.banAck(value), { code: 'INVALID_RESPONSE' });
    for (const value of ['{"retcode":1,"cgicode":0}', '{"retcode":0,"cgicode":1}']) assert.throws(() => p.banAck(value), { code: 'KERNEL_ERROR' });
});

function fixture() {
    const capture = { epoch: 'e', session: {}, self: { uin: '12345', uid: 'u_self' }, ensureReady() {}, hasMethods: () => true, deadline: task => task() };
    const requests = [], native = { available: () => true, async run(_capture, data) { requests.push(data); return { ...p.decode(ack(), p.prepare(data.operation, data.request)), via: 'native-msf' }; } };
    const web = { async authenticate() { return { skey: 'fixture-skey', p_skey: 'different-pskey', cookie(url) { assert.equal(url, p.ENDPOINT); return 'fixture-cookie'; } }; },
        async request(url, options) { requests.push({ url, options }); return { status: 200, text: '{"retcode":0,"cgicode":0}' }; } };
    const api = createAnonymous(capture, { native, web });
    return { capture, native, web, requests, api };
}
const settingData = { operation: 'group.anonymous', groupId: '123456', enable: true, expectedEpoch: 'e' };
const banData = { operation: 'group.anonymousBan', groupId: '123456', flag: FLAG, duration: 600, expectedEpoch: 'e' };

test('anonymous helper binds the fixed native operation to the current session and validates its ACK', async () => {
    const f = fixture();
    assert.deepEqual(await f.api.execute(settingData), { operation: 'group.anonymous', uin: '12345', result: { groupId: '123456', enable: true, confirmed: true, confirmation: 'server_ack' } });
    assert.equal(f.requests[0].op, 'fixedAnonymous'); assert.equal(f.requests[0].expectedEpoch, 'e'); assert.equal(f.requests[0].expectedUin, '12345');
    for (const field of ['operation', 'groupId', 'enable', 'confirmed']) {
        f.native.run = async (_capture, data) => ({ operation: data.operation, ...data.request, confirmed: true, confirmation: 'server_ack', [field]: 'wrong' });
        await assert.rejects(f.api.execute(settingData), { code: 'INVALID_RESPONSE' });
    }
});

test('anonymous ban helper returns only confirmed metadata and does not expose anonymous identity or credentials', async () => {
    const f = fixture(), result = await f.api.execute(banData);
    assert.deepEqual(result, { operation: 'group.anonymousBan', uin: '12345', result: { groupId: '123456', duration: 600, confirmed: true, confirmation: 'server_ack' } });
    const request = f.requests[0]; assert.equal(request.options.method, 'POST'); assert.equal(request.url, p.ENDPOINT);
    assert.equal(new URLSearchParams(request.options.body).get('bkn'), p.csrf('fixture-skey'));
    assert.equal(JSON.stringify(result).includes('AQIDBA'), false); assert.equal(JSON.stringify(result).includes('skey'), false);
});

test('anonymous helper rejects redirects, missing auth, raw errors, stale sessions and invalid deadlines', async () => {
    const f = fixture();
    f.web.request = async () => ({ status: 302, text: '{"retcode":0,"cgicode":0}' });
    await assert.rejects(f.api.execute(banData), { code: 'QUERY_FAILED' });
    f.web.authenticate = async () => ({ skey: '' }); await assert.rejects(f.api.execute(banData), { code: 'AUTH_FAILED' });
    f.web.authenticate = async () => { throw new Error('cookie=PRIVATE'); };
    await assert.rejects(f.api.execute(banData), error => { assert.equal(error.message.includes('PRIVATE'), false); return true; });
    await assert.rejects(f.api.execute({ ...settingData, expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.api.execute(settingData, { expiresAt: NaN }), { code: 'INVALID_PARAMS' });
    f.native.run = async () => { f.capture.session = {}; return { operation: 'group.anonymous', groupId: '123456', enable: true, confirmed: true, confirmation: 'server_ack' }; };
    await assert.rejects(f.api.execute(settingData), { code: 'SESSION_CHANGED' });
});

test('anonymous physical slots stay occupied after caller timeout and clear invalidates late results', async () => {
    const f = fixture(), releases = [];
    f.native.run = () => new Promise(resolve => releases.push(resolve));
    f.capture.deadline = async task => { const pending = task(); pending.catch(() => {}); throw Object.assign(new Error('fixture timeout'), { code: 'TIMEOUT' }); };
    for (let i = 0; i < 4; i++) await assert.rejects(f.api.execute(settingData), { code: 'TIMEOUT' });
    await assert.rejects(f.api.execute(settingData), { code: 'BUSY' }); assert.equal(releases.length, 4);
    f.api.clear(); for (const release of releases) release({});
    await new Promise(resolve => setImmediate(resolve));
    f.capture.deadline = task => task(); f.native.run = async (_capture, data) => p.decode(ack(), p.prepare(data.operation, data.request));
    assert.equal((await f.api.execute(settingData)).result.confirmed, true);
});

test('anonymous OneBot actions accept a real event flag or anonymous_flag and require exact server metadata', async () => {
    const state = { self: { uin: '12345' }, capabilities: { groupAnonymous: true, groupAnonymousBan: true } }, calls = [];
    const service = { async sessionCall(_state, method, data) { calls.push({ method, data }); return { operation: data.operation, uin: '12345', result: { groupId: data.groupId,
        ...(data.operation === 'group.anonymous' ? { enable: data.enable } : { duration: data.duration }), confirmed: true, confirmation: 'server_ack' } }; }, async assertSession() {} };
    assert.equal(await runAnonymous(service, state, 'set_group_anonymous', { group_id: 123456 }), null);
    assert.equal(await runAnonymous(service, state, 'set_group_anonymous_ban', { group_id: 123456, anonymous: { id: 3, name: '匿名 & + 中', flag: FLAG } }), null);
    assert.equal(await runAnonymous(service, state, 'set_group_anonymous_ban', { group_id: 123456, anonymous_flag: FLAG, duration: 600 }), null);
    assert.equal(calls.every(value => value.method === 'anonymousAction'), true); assert.equal(calls[0].data.enable, true); assert.equal(calls[1].data.duration, 1800);
    for (const params of [{ anonymous: { id: 3, name: '匿名' } }, { anonymous: { flag: FLAG, name: 'wrong' } }, { anonymous: { flag: FLAG }, anonymous_flag: 'other@AQ==' }]) await assert.rejects(runAnonymous(service, state, 'set_group_anonymous_ban', { group_id: 123456, ...params }), { code: 'INVALID_PARAMS' });
    await assert.rejects(runAnonymous(service, state, 'set_group_anonymous', { self_id: 99999, group_id: 123456 }), { code: 'INVALID_PARAMS' });
    service.sessionCall = async () => ({ operation: 'group.anonymous', uin: '12345', result: { groupId: '123456', enable: true, confirmed: false, confirmation: 'submitted' } });
    await assert.rejects(runAnonymous(service, state, 'set_group_anonymous', { group_id: 123456 }), { code: 'INVALID_RESPONSE' });
});

test('anonymous action checks the current session again after its response', async () => {
    const state = { self: { uin: '12345' }, capabilities: { groupAnonymous: true } };
    const service = { async sessionCall() { return { operation: 'group.anonymous', uin: '12345', result: { groupId: '123456', enable: true, confirmed: true, confirmation: 'server_ack' } }; },
        async assertSession() { throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); } };
    await assert.rejects(runAnonymous(service, state, 'set_group_anonymous', { group_id: 123456 }), { code: 'SESSION_CHANGED' });
});

test('anonymous fixed login purpose restricts redirects and scopes cookies to qqweb only', async () => {
    const scope = { saved: { uin: '12345' }, context: { expiresAt: Date.now() + 1000 }, active() {} };
    const capture = { invoke: async () => ({ result: 0, clientKey: 'fixture-client', keyIndex: '1' }), hasMethods: () => false };
    const headers = new Headers({ location: 'https://qqweb.qq.com/' });
    headers.append('set-cookie', 'uin=o12345; Domain=.qq.com; Path=/'); headers.append('set-cookie', 'skey=fixture-skey; Domain=.qq.com; Path=/');
    const responses = [new Response('', { status: 302, headers }), new Response('', { status: 404, headers: { 'set-cookie': 'p_skey=fixture-pskey; Domain=.qqweb.qq.com; Path=/' } })];
    const web = createWeb(capture, async target => { if (responses.length === 2) assert.equal(new URL(target).searchParams.get('u1'), 'https://qqweb.qq.com/'); return responses.shift(); }, 'anonymousBan');
    const auth = await web.authenticate(scope); assert.equal(auth.skey, 'fixture-skey'); assert.match(auth.cookie(p.ENDPOINT), /p_skey=fixture-pskey/);
    assert.throws(() => auth.cookie('https://qun.qq.com/'), { code: 'INVALID_PARAMS' });
    const noCookies = [new Response('', { status: 302, headers: { location: 'https://qqweb.qq.com/' } }), new Response('', { status: 404 })];
    await assert.rejects(createWeb(capture, async () => noCookies.shift(), 'anonymousBan').authenticate(scope), { code: 'AUTH_FAILED' });
    for (const target of ['https://vip.qq.com/', 'https://qqweb.qq.com/?extra=1', 'https://qqweb.qq.com/c/anonymoustalk/blacklist', 'https://qqweb.qq.com.attacker.invalid/']) {
        const rejected = createWeb(capture, async () => new Response('', { status: 302, headers: { location: target } }), 'anonymousBan');
        await assert.rejects(rejected.authenticate(scope), { code: 'INVALID_RESPONSE' });
    }
});
