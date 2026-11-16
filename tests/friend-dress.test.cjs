'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFriendDress, dressUrl, parseDress } = require('../src/qq/friend-dress.cjs');
const { runFriendDress } = require('../src/onebot/friend-dress-actions.cjs');
const html = value => '<html><script>window.__INITIAL_ASYNCDATA__=' + JSON.stringify(value) + ';(function(){})();</script></html>';
test('friend dress URL fixes both nested/outer target and original trace encoding', () => {
    const url = new URL(dressUrl('22222')), inner = new URL(url.searchParams.get('url'));
    assert.equal(url.origin + url.pathname, 'https://zb.vip.qq.com/v2/pages/aioDressPage'); assert.equal(url.searchParams.get('targetUin'), '22222'); assert.equal(inner.searchParams.get('targetUin'), '22222');
    assert.match(url.href, /traceDetail=base64-[^&]+%0A/); assert.throws(() => dressUrl('22222&targetUin=1'), { code: 'INVALID_PARAMS' });
});
test('friend dress maps known business types and material, excluding source-unresolvable categories', () => {
    const result = parseDress(html({ targetUin: '22222', isSvip: true, avatarImage: 'https://qpic.cn/avatar', rawUsingList: [
        { appId: 2 }, { appId: 5 }, { appId: 23 }, { appId: 4, itemId: 1, name: 'widget', image: 'https://qpic.cn/widget', extrainfo: { price: 12.5 } },
        { appId: 15, itemId: 2, extraappinfo: { extraInfo: { immersiveMaterial: JSON.stringify({ videoUrl: 'https://qpic.cn/card.mp4' }) } } },
        { appId: 17, itemId: 3, image: 'https://qpic.cn/funCall/item/3/web_image.jpg' }, { appId: 999, itemId: 0 },
    ] }), '22222');
    assert.equal(result.items.length, 4); assert.equal(result.items[0].price, 12.5); assert.equal(result.items[1].video_url, 'https://qpic.cn/card.mp4'); assert.equal(result.items[2].video_url, 'https://qpic.cn/funCall/item/3/media.mp4'); assert.equal(result.items[3].kind, 'appId=999');
});
test('friend dress never interprets login/risk pages, wrong identities or missing collections as empty success', () => {
    assert.deepEqual(parseDress(html({ targetUin: '22222', isSvip: false, rawUsingList: [] }), '22222').items, []);
    for (const source of ['<html>login</html>', html({ targetUin: '99999', isSvip: false, rawUsingList: [] }), html({ targetUin: '22222', isSvip: false }), html({ targetUin: '22222', rawUsingList: [] }),
        html({ targetUin: '22222', isSvip: false, rawUsingList: [{ appId: 4, image: 'javascript:alert(1)' }] }), html({ targetUin: '22222', isSvip: false, rawUsingList: [{ appId: 15, extraappinfo: { extraInfo: { immersiveMaterial: '{}' } } }] })]) assert.throws(() => parseDress(source, '22222'), { code: 'INVALID_RESPONSE' });
    assert.throws(() => parseDress('window.__INITIAL_ASYNCDATA__={"targetUin":"22222","targetUin":"99999"};(function(){})()', '22222'), { code: 'INVALID_RESPONSE' });
});
test('friend dress uses a separate vip cookie jar and exact target/account envelope', async () => {
    const calls = [], native = [];
    const capture = { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, ensureReady() {}, hasMethods: () => true, deadline: operation => operation(),
        async invoke(service, method, args) { native.push({ service, method, args }); return method === 'forceFetchClientKey' ? { result: 0, clientKey: 'CLIENT', keyIndex: '1' } : { result: 0, domainPskeyMap: new Map([['vip.qq.com', 'VIP_KEY']]) }; } };
    const api = createFriendDress(capture, { fetchImpl: async (url, request) => {
        calls.push({ url, request }); const parsed = new URL(url);
        if (parsed.hostname === 'ssl.ptlogin2.qq.com') { assert.equal(parsed.searchParams.get('u1'), 'https://vip.qq.com/'); const headers = new Headers({ location: 'https://vip.qq.com/' }); headers.append('Set-Cookie', 'uin=o12345; Domain=.qq.com; Path=/'); headers.append('Set-Cookie', 'skey=SKEY; Domain=.qq.com; Path=/'); return new Response('', { status: 302, headers }); }
        if (parsed.hostname === 'vip.qq.com') { assert.equal(parsed.pathname, '/'); return new Response(''); }
        return new Response(html({ targetUin: parsed.searchParams.get('targetUin'), isSvip: false, rawUsingList: [] }));
    } });
    const state = { self: capture.self, capabilities: api.capabilities() }, service = { sessionCall: (_state, method, data) => { assert.equal(method, 'friendDressQuery'); return api.query({ ...data, expectedEpoch: 'e1' }); } };
    const result = await runFriendDress(service, state, '_get_friend_dress', { user_id: 22222 }); assert.equal(result.target_uin, '22222');
    assert.deepEqual(native.find(item => item.method === 'getPskey').args, [['vip.qq.com'], true]);
    assert.match(calls.at(-1).request.headers.Cookie, /p_skey=VIP_KEY/); assert.equal(calls.at(-1).request.redirect, 'manual'); assert.equal(calls.some(item => item.url.includes('qzone')), false);
    await assert.rejects(api.query({ targetUin: '22222', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
});
