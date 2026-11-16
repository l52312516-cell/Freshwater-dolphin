'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeb } = require('../src/qq/qzone-web.cjs');
const scope = () => ({ saved: { uin: '12345' }, context: { expiresAt: Date.now() + 1000 }, active() {} });
function capture() { return { async invoke() { return { result: 0, clientKey: 'PRIVATE_CLIENT_KEY', keyIndex: '19' }; }, diagnostic() { throw new Error('Production diagnostics must not be called'); } }; }

test('QQ web authentication failures expose only fixed phase and HTTP status', async () => {
    for (const [phase, responses, status] of [
        ['initial-jump', [new Response('PRIVATE_BODY', { status: 200 })], 200],
        ['check-sign', [new Response('', { status: 302, headers: { location: 'https://ptlogin2.qzone.qq.com/check_sig?uin=12345&secret=PRIVATE_QUERY' } }), new Response('', { status: 403 })], 403],
        ['business-destination', [new Response('', { status: 302, headers: { location: 'https://user.qzone.qq.com/12345/infocenter' } }), new Response('', { status: 401 })], 401],
        ['business-destination', [new Response('', { status: 302, headers: { location: 'https://user.qzone.qq.com/12345/infocenter' } }), new Response('', { status: 404 })], 404]
    ]) {
        const records = [], web = createWeb(capture(), async () => responses.shift(), 'qzone', { onDiagnostic: value => records.push(value) });
        await assert.rejects(web.authenticate(scope()), error => error.code === 'AUTH_FAILED' && error.message.endsWith('(phase=' + phase + ', status=' + status + ')') && !/12345|PRIVATE|https:|infocenter|check_sig/.test(error.message));
        assert.deepEqual(records.map(value => Object.keys(value).sort()), records.map(() => ['cookieDomains', 'phase', 'purpose', 'status']));
        assert.equal(/12345|PRIVATE|https:|infocenter|check_sig/.test(JSON.stringify(records)), false);
    }
});

test('QQ web optional diagnostics classify cookie domain counts without logging values or identifiers', async () => {
    const records = [], headers = new Headers({ location: 'https://user.qzone.qq.com/12345/infocenter' });
    headers.append('set-cookie', 'uin=o12345; Domain=.qq.com; Path=/'); headers.append('set-cookie', 'skey=PRIVATE_SKEY; Domain=.qq.com; Path=/');
    const responses = [new Response('', { status: 302, headers }), new Response('', { headers: { 'set-cookie': 'p_skey=PRIVATE_PSKEY; Domain=.qzone.qq.com; Path=/' } })];
    const web = createWeb(capture(), async () => responses.shift(), 'qzone', { onDiagnostic: value => records.push(value) });
    const auth = await web.authenticate(scope()); assert.match(auth.cookie('https://h5.qzone.qq.com/a'), /PRIVATE_PSKEY/);
    assert.deepEqual(records[1], { purpose: 'qzone', phase: 'business-destination', status: 200, cookieDomains: { parent: 2, purpose: 1, login: 0, business: 0 } });
    assert.equal(/12345|PRIVATE|qq\.com|cookieNames|path|query/.test(JSON.stringify(records)), false);
});

test('Qzone jump uses only its account-specific user landing page and rejects legacy or arbitrary destinations', async () => {
    for (const destination of ['https://qzone.qq.com/12345/infocenter', 'https://user.qzone.qq.com/99999/infocenter', 'https://user.qzone.qq.com/12345/infocenter?extra=1', 'https://user.qzone.qq.com/12345/other']) {
        let calls = 0;
        const web = createWeb(capture(), async target => { calls++; assert.equal(new URL(target).searchParams.get('u1'), 'https://user.qzone.qq.com/12345/infocenter'); return new Response('', { status: 302, headers: { location: destination } }); });
        await assert.rejects(web.authenticate(scope()), { code: 'INVALID_RESPONSE' }); assert.equal(calls, 1);
    }
});

test('VIP authentication accepts only its fixed root landing and still requires current account cookies', async () => {
    for (const destination of ['https://vip.qq.com/12345/infocenter', 'https://vip.qq.com/index.html', 'https://vip.qq.com/?extra=1', 'https://user.qzone.qq.com/12345/infocenter', 'https://zb.vip.qq.com/']) {
        let calls = 0;
        const web = createWeb(capture(), async target => {
            calls++; assert.equal(new URL(target).searchParams.get('u1'), 'https://vip.qq.com/');
            return new Response('', { status: 302, headers: { location: destination } });
        }, 'friendDress');
        await assert.rejects(web.authenticate(scope()), { code: 'INVALID_RESPONSE' }); assert.equal(calls, 1);
    }
    const responses = [new Response('', { status: 302, headers: { location: 'https://vip.qq.com/' } }), new Response('<html>public VIP home</html>')];
    const web = createWeb(capture(), async () => responses.shift(), 'friendDress');
    await assert.rejects(web.authenticate(scope()), error => error.code === 'AUTH_FAILED' && error.message.includes('credentials do not match'));
});
