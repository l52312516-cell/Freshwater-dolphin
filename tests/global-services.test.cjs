'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GlobalServices, externalSettings, publicSettings, validateGlobalSettingsPatch } = require('../src/global-services.cjs');
const { atomic } = require('../src/manager/files.cjs');

function fixture(t, settings = {}, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'global-services-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'work/control/settings.json');
    atomic(file, { version: 1, maxAccounts: 2, ...settings });
    return { root, file, client: new GlobalServices({ root, ...options }) };
}
const image = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=one';
const card = { app: 'com.tencent.structmsg', view: 'music', meta: { music: { title: 'Test song', musicUrl: 'https://media.example/song', jumpUrl: 'https://media.example/song-info' } } };
const luaCard = { ...card, app: 'com.tencent.music.lua', extra: {}, config: { ctime: 1000000, forward: 1, token: 'mock-provider-signature', type: 'normal' },
    meta: { music: { ...card.meta.music, app_type: 1, appid: 100495085, ctime: 1000000, uin: 123 } } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('global settings patches are partial and reject unknown or malformed fields without changing current settings', () => {
    const current = { version: 1, maxAccounts: 2, port: 4090, host: '0.0.0.0' }, original = structuredClone(current);
    const patched = validateGlobalSettingsPatch({ rkey: { fallbackServers: [' https://rkey.example/api?key=one ', 'https://rkey.example/api?key=one'] }, musicSignUrl: '' }, current);
    assert.deepEqual(patched.rkey, { fallbackServers: ['https://rkey.example/api?key=one'] });
    assert.equal(patched.maxAccounts, 2); assert.equal(patched.port, 4090);
    assert.deepEqual(current, original);
    for (const patch of [null, [], { arbitrary: 1 }, { maxAccounts: 0 }, { port: 4091 }, { rkey: null },
        { rkey: { fallbackServers: [], arbitrary: 1 } }, { rkey: { fallbackServers: Array(9).fill('https://r.example/') } },
        { musicSignUrl: 1 }, { musicSignUrl: 'file:///x' }, { musicSignUrl: 'https://user:secret@music.example/' },
        { musicSignUrl: 'https://music.example/#' }, { musicSignUrl: 'https://music.example/\n' },
        { musicSignUrl: 'https://music.example/' + 'a'.repeat(2048) }, { publicBaseUrl: 'https://manager.example/path' }]) {
        assert.throws(() => validateGlobalSettingsPatch(patch, current), { code: 'INVALID_CONFIG' });
        assert.deepEqual(current, original);
    }
    assert.deepEqual(externalSettings({}), { rkey: { fallbackServers: [] }, musicSignUrl: '', musicSignKey: '' });
    assert.equal(validateGlobalSettingsPatch({ publicBaseUrl: 'https://manager.example/' }, current).publicBaseUrl, 'https://manager.example');
});

test('music signing keys are private, explicit to clear and can migrate from the selected endpoint query', () => {
    const current = { version: 1, maxAccounts: 2 };
    const first = validateGlobalSettingsPatch({ musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark?key=embedded-secret' }, current);
    assert.equal(first.musicSignKey, 'embedded-secret'); assert.equal(first.musicSignUrl, 'https://apii.xianyuw.cn/api/v1/qq-musicark');
    assert.equal(publicSettings(first).hasMusicSignKey, true); assert.equal(JSON.stringify(publicSettings(first)).includes('embedded-secret'), false);
    assert.equal(Object.hasOwn(publicSettings(first), 'musicSignKey'), false);
    const kept = validateGlobalSettingsPatch({ musicSignKey: '' }, first);
    assert.equal(kept.musicSignKey, 'embedded-secret');
    const replaced = validateGlobalSettingsPatch({ musicSignKey: 'new-secret' }, kept);
    assert.equal(replaced.musicSignKey, 'new-secret');
    assert.throws(() => validateGlobalSettingsPatch({ musicSignKey: 'replacement', clearMusicSignKey: true }, replaced), { code: 'INVALID_CONFIG' });
    assert.throws(() => validateGlobalSettingsPatch({ musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark?key=replacement', clearMusicSignKey: true }, replaced), { code: 'INVALID_CONFIG' });
    assert.throws(() => validateGlobalSettingsPatch({ musicSignKey: 'invalid\nkey' }, replaced), { code: 'INVALID_CONFIG' });
    const cleared = validateGlobalSettingsPatch({ clearMusicSignKey: true }, replaced);
    assert.equal(cleared.musicSignKey, ''); assert.equal(publicSettings(cleared).hasMusicSignKey, false);
    assert.equal(Object.hasOwn(cleared, 'clearMusicSignKey'), false);
    assert.throws(() => validateGlobalSettingsPatch({ musicSignUrl: 'https://other.example/sign' }, replaced), { code: 'INVALID_CONFIG' });
    assert.equal(validateGlobalSettingsPatch({ musicSignUrl: 'https://other.example/sign', musicSignKey: 'confirmed-new-key' }, replaced).musicSignKey, 'confirmed-new-key');
    assert.equal(validateGlobalSettingsPatch({ musicSignUrl: 'https://other.example/sign', clearMusicSignKey: true }, replaced).musicSignKey, '');
    assert.equal(validateGlobalSettingsPatch({ musicSignUrl: 'https://other.example/sign?key=query-replacement' }, replaced).musicSignKey, 'query-replacement');
});

test('a selected keyed service uses the documented GET fields and clearing the key returns to raw POST', async t => {
    let request;
    const f = fixture(t, { musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark', musicSignKey: 'test-api-secret' }, {
        fetchImpl: async (url, options) => { request = { url, options }; return json({ code: 200, msg: 'success', data: luaCard }); }
    });
    const data = { type: 'custom', url: 'https://music.163.com/#/song?id=123', audio: 'https://audio.example/song',
        title: 'A & B', content: 'Singer', image: 'https://cover.example/song' };
    assert.equal((await f.client.signMusic(data)).format, 'ark-json');
    const url = new URL(request.url);
    assert.equal(url.origin + url.pathname, 'https://apii.xianyuw.cn/api/v1/qq-musicark');
    assert.equal(url.searchParams.get('key'), 'test-api-secret'); assert.equal(url.searchParams.get('url'), data.audio);
    assert.equal(url.searchParams.get('song'), data.title); assert.equal(url.searchParams.get('singer'), data.content);
    assert.equal(url.searchParams.get('cover'), data.image); assert.equal(url.searchParams.get('jump'), data.url);
    assert.equal(url.searchParams.get('format'), 'qq'); assert.equal(request.options.method, undefined); assert.equal(request.options.redirect, 'error');
    atomic(f.file, { musicSignUrl: 'https://sign.example/card', musicSignKey: '' });
    f.client.fetch = async (url, options) => {
        assert.equal(url.includes('test-api-secret'), false); assert.equal(options.body.includes('test-api-secret'), false);
        assert.equal(options.method, 'POST');
        return json(card);
    };
    await f.client.signMusic({ type: 'qq', id: '123' });
});

test('a configured key selects GET for the administrator-selected endpoint while no key selects POST even on the documented host', async t => {
    const f = fixture(t, { musicSignUrl: 'https://selected.example/sign', musicSignKey: 'selected-api-secret' }, {
        fetchImpl: async (url, options) => {
            assert.equal(new URL(url).origin, 'https://selected.example'); assert.equal(new URL(url).searchParams.get('key'), 'selected-api-secret');
            assert.equal(options.method, undefined); return json({ code: 200, data: luaCard });
        }
    });
    const data = { type: 'custom', url: 'https://song.example/info', audio: 'https://song.example/audio', title: 'Song' };
    await f.client.signMusic(data);
    atomic(f.file, { musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark' });
    f.client.fetch = async (url, options) => {
        assert.equal(new URL(url).searchParams.has('key'), false); assert.equal(options.method, 'POST');
        assert.equal(JSON.parse(options.body).type, 'custom'); return json(card);
    };
    await f.client.signMusic(data);
});

test('keyed platform shares resolve real public metadata before GET signing without leaking the signing key to official APIs', async t => {
    for (const type of ['163', 'qq']) {
        const seen = [], id = type === '163' ? '29005614' : '740247871', mid = '0029REsA06tOwE';
        const f = fixture(t, { musicSignUrl: 'https://selected.example/sign', musicSignKey: 'sign-only-api-secret' }, {
            fetchImpl: async (input, options) => {
                const url = new URL(input); seen.push(url.hostname);
                if (url.hostname !== 'selected.example') {
                    assert.equal(input.includes('sign-only-api-secret'), false);
                    assert.equal(JSON.stringify(options.headers).includes('sign-only-api-secret'), false);
                }
                if (url.hostname === 'music.163.com') {
                    if (url.pathname === '/api/song/detail/') return json({ code: 200, songs: [{ id: Number(id), name: 'Cielo', artists: [{ name: 'Sky' }], album: { picUrl: 'https://p1.music.126.net/cover.jpg' } }] });
                    return json({ code: 200, data: [{ id: Number(id), code: 200, url: 'https://m801.music.126.net/audio.mp3', freeTrialInfo: null }] });
                }
                if (url.hostname === 'u.y.qq.com') {
                    const query = JSON.parse(url.searchParams.get('data'));
                    if (query.req_0.module === 'music.pf_song_detail_svr') return json({ code: 0, req_0: { code: 0, data: { track_info: {
                        id: Number(id), mid, name: 'Reno My Color', singer: [{ name: '宋雨琦' }], album: { mid: '000MkMni19ClKG' }
                    } } } });
                    return json({ code: 0, req_0: { code: 0, data: { retcode: 0, sip: ['https://aqqmusic.tc.qq.com/'], midurlinfo: [{ songmid: mid, result: 0, purl: 'track.m4a?vkey=official-public-token' }] } } });
                }
                assert.equal(url.hostname, 'selected.example'); assert.equal(url.searchParams.get('key'), 'sign-only-api-secret');
                assert.equal(url.searchParams.get('format'), type === '163' ? 'netease' : 'qq');
                assert.equal(url.searchParams.get('song'), type === '163' ? 'Cielo' : 'Reno My Color');
                assert.equal(url.searchParams.get('url'), type === '163' ? 'https://m801.music.126.net/audio.mp3' : 'https://aqqmusic.tc.qq.com/track.m4a?vkey=official-public-token');
                return json({ code: 200, data: luaCard });
            }
        });
        assert.equal((await f.client.signMusic({ type, id }, { timeoutMs: 5000 })).format, 'ark-json');
        assert.deepEqual(seen, type === '163' ? ['music.163.com', 'music.163.com', 'selected.example'] : ['u.y.qq.com', 'u.y.qq.com', 'selected.example']);
    }
});

test('configured music availability checks only a nonempty endpoint and never probes a service', t => {
    const f = fixture(t, { musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark' }, { fetchImpl: () => { throw new Error('Unexpected availability probe'); } });
    assert.equal(f.client.musicEnabled(), true);
    atomic(f.file, { musicSignUrl: 'https://apii.xianyuw.cn/api/v1/qq-musicark', musicSignKey: 'test-only-key' });
    assert.equal(f.client.musicEnabled(), true);
    atomic(f.file, { musicSignUrl: 'https://sign.example/card' }); assert.equal(f.client.musicEnabled(), true);
    atomic(f.file, {}); assert.equal(f.client.musicEnabled(), false);
});

test('rkey fallback is explicit and leaves existing keys and unrelated image URLs unchanged', async t => {
    const f = fixture(t, {}, { fetchImpl: () => { throw new Error('Unexpected network request'); } });
    assert.equal(await f.client.resolveImageUrl(image + '&rkey=existing', true), image + '&rkey=existing');
    assert.equal(await f.client.resolveImageUrl('https://gchat.qpic.cn/test', true), 'https://gchat.qpic.cn/test');
    assert.equal(await f.client.resolveImageUrl('https://multimedia.nt.qq.com.cn.evil.example/download?fileid=one', true), 'https://multimedia.nt.qq.com.cn.evil.example/download?fileid=one');
    await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'RKEY_UNAVAILABLE' });
    await assert.rejects(f.client.resolveImageUrl('https://user:pass@multimedia.nt.qq.com.cn/download', true), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.client.resolveImageUrl(image, 'group'), { code: 'INVALID_PARAMS' });
});

test('rkey responses accept bare and successful OneBot shapes, cache per account and chat scope, and expire', async t => {
    let calls = 0, now = 1000000;
    const options = { now: () => now, fetchImpl: async (_url, options) => {
        calls++; assert.equal(options.redirect, 'error');
        return json(calls % 2 ? { group_rkey: '&rkey=group-' + calls, expired_time: 1005 } :
            { retcode: 0, data: { private_rkey: '?rkey=private-' + calls, expired_time: 1005 } });
    } };
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, options);
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'group-1');
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 1);
    assert.equal(new URL(await f.client.resolveImageUrl(image.replace('1407', '1406'), false)).searchParams.get('rkey'), 'private-2');
    const other = new GlobalServices({ root: f.root, ...options });
    assert.equal(new URL(await other.resolveImageUrl(image, true)).searchParams.get('rkey'), 'group-3');
    now = 1006000;
    await assert.rejects(f.client.resolveImageUrl(image.replace('1407', '1406'), false), { code: 'RKEY_UNAVAILABLE' });
    assert.equal(calls, 4);
});

test('rkey reads only configured fallbacks and rejects failure wrappers, expired or malformed keys', async t => {
    const seen = [];
    const f = fixture(t, { rkey: { fallbackServers: ['https://one.example/', 'https://two.example/'] } }, {
        now: () => 1000000,
        fetchImpl: async url => { seen.push(url); return json(url.includes('one') ? { retcode: 1, data: { group_rkey: 'bad' } } : { group_rkey: 'valid' }); }
    });
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'valid');
    assert.deepEqual(seen, ['https://one.example/', 'https://two.example/']);
    for (const value of [{ group_rkey: 'bad&other=value' }, { group_rkey: 'old', expired_time: 999 }, { group_rkey: 'old', expired_time: '99999' }, { private_rkey: 'wrong-scope' }]) {
        const bad = new GlobalServices({ root: f.root, now: () => 1000000, fetchImpl: async () => json(value) });
        await assert.rejects(bad.resolveImageUrl(image, true), { code: 'RKEY_UNAVAILABLE' });
    }
});

test('concurrent rkey queries share only their current account request and a hot settings update invalidates in-flight results', async t => {
    let release, calls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://one.example/'] } }, { fetchImpl: async () => {
        calls++; await new Promise(resolve => { release = resolve; }); return json({ group_rkey: 'old' });
    } });
    const first = f.client.resolveImageUrl(image, true), second = f.client.resolveImageUrl(image, true);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
    atomic(f.file, { rkey: { fallbackServers: [] }, musicSignUrl: '' });
    release();
    await assert.rejects(first, { code: 'GLOBAL_SETTINGS_CHANGED' });
    await assert.rejects(second, { code: 'GLOBAL_SETTINGS_CHANGED' });
    await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'RKEY_UNAVAILABLE' });
});

test('music signing sends music metadata once without disclosing account context and returns only a validated card', async t => {
    const requests = [];
    const f = fixture(t, { musicSignUrl: 'https://sign.example/card?token=secret' }, { fetchImpl: async (url, options) => {
        requests.push({ url, ...options }); return json(card);
    } });
    const signed = await f.client.signMusic({ type: 'qq', id: 123 }, { peer: { chatType: 2, peerUid: 'group' }, selfId: 'account' });
    assert.deepEqual(signed, { format: 'ark-json', text: JSON.stringify(card) });
    assert.deepEqual(JSON.parse(requests[0].body), { type: 'qq', id: '123' });
    assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].redirect, 'error');
    await f.client.signMusic({ type: 'custom', url: 'https://song.example/info', audio: 'https://song.example/audio', title: 'Song', content: 'Singer' }, {});
    assert.deepEqual(JSON.parse(requests[1].body), { type: 'custom', url: 'https://song.example/info', audio: 'https://song.example/audio', title: 'Song', image: '', singer: 'Singer' });
    assert.equal(requests.length, 2);
    atomic(f.file, { musicSignUrl: '' });
    await assert.rejects(f.client.signMusic({ type: 'qq', id: '123' }), { code: 'UNSUPPORTED' });
    assert.equal(requests.length, 2);
});

test('music signing refuses invalid inputs and provider errors without local cards or retries', async t => {
    let calls = 0;
    const f = fixture(t, { musicSignUrl: 'https://sign.example/card' }, { fetchImpl: async () => { calls++; return json({ error: 'failed' }); } });
    await assert.rejects(f.client.signMusic({ type: 'qq' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.client.signMusic({ type: 'custom', title: 'Song', url: 'file:///secret', audio: 'https://song.example/audio' }), { code: 'INVALID_PARAMS' });
    assert.equal(calls, 0);
    await assert.rejects(f.client.signMusic({ type: 'qq', id: '123' }), { code: 'INVALID_RESPONSE' });
    assert.equal(calls, 1);
});

test('external responses have a byte limit, reject redirects, and enforce timeout without retrying signatures', async t => {
    const f = fixture(t, { musicSignUrl: 'https://sign.example/card' });
    for (const fetchImpl of [
        async () => new Response('x'.repeat(128 * 1024 + 1)),
        async () => new Response('{}', { headers: { 'content-length': String(128 * 1024 + 1) } }),
        async () => ({ ok: true, redirected: true }),
        async () => new Response('null'),
        async () => new Response('not json')
    ]) {
        const client = new GlobalServices({ root: f.root, fetchImpl });
        await assert.rejects(client.signMusic({ type: 'qq', id: '123' }));
    }
    let calls = 0;
    const client = new GlobalServices({ root: f.root, timeoutMs: 10, fetchImpl: () => { calls++; return new Promise(() => {}); } });
    await assert.rejects(client.signMusic({ type: 'qq', id: '123' }), { code: 'TIMEOUT' });
    assert.equal(calls, 1);
});

test('unreadable or invalid hot configuration fails closed instead of reusing a previously enabled service', async t => {
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, { fetchImpl: async () => json({ group_rkey: 'old' }) });
    await f.client.resolveImageUrl(image, true);
    fs.writeFileSync(f.file, '{broken');
    await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'INVALID_CONFIG' });
});

test('all rkey fallback attempts share one total deadline instead of multiplying the per-server timeout', async t => {
    let calls = 0;
    const f = fixture(t, { rkey: { fallbackServers: Array.from({ length: 8 }, (_, index) => 'https://rkey' + index + '.example/') } },
        { timeoutMs: 10, fetchImpl: () => { calls++; return new Promise(() => {}); } });
    await assert.rejects(f.client.resolveImageUrl(image, true, { timeoutMs: 15 }), { code: 'TIMEOUT' });
    assert.ok(calls < 8);
});

test('each concurrent rkey waiter observes its own deadline while the longer request can still succeed', async t => {
    let release, calls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, { fetchImpl: async () => {
        calls++; await new Promise(resolve => { release = resolve; }); return json({ group_rkey: 'eventual' });
    } });
    const longer = f.client.resolveImageUrl(image, true, { timeoutMs: 1000 });
    await assert.rejects(f.client.resolveImageUrl(image, true, { timeoutMs: 10 }), { code: 'TIMEOUT' });
    release();
    assert.equal(new URL(await longer).searchParams.get('rkey'), 'eventual'); assert.equal(calls, 1);
});

test('changing the confirmed QQ session clears cached keys and rejects an old session signing result', async t => {
    let release;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] }, musicSignUrl: 'https://sign.example/card' }, { fetchImpl: async url => {
        if (url.includes('rkey')) return json({ group_rkey: 'first-session' });
        await new Promise(resolve => { release = resolve; }); return json(card);
    } });
    f.client.resetSession('first', '123'); await f.client.resolveImageUrl(image, true);
    assert.equal(f.client.keys.size, 1);
    const signed = f.client.signMusic({ type: 'qq', id: '123' });
    await new Promise(resolve => setImmediate(resolve));
    f.client.resetSession('second', '123'); assert.equal(f.client.keys.size, 0);
    release(); await assert.rejects(signed, { code: 'SESSION_CHANGED' });
});
