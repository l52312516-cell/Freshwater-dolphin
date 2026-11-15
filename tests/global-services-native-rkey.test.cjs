'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GlobalServices } = require('../src/global-services.cjs');
const { atomic } = require('../src/manager/files.cjs');

function fixture(t, settings = {}, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'gs-native-rkey-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'work/control/settings.json');
    atomic(file, { version: 1, maxAccounts: 2, ...settings });
    return { root, file, client: new GlobalServices({ root, ...options }) };
}
const image = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=one';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const groupKey = (n, extra = {}) => ({ rkeys: [{ rkey: 'NATIVE-GROUP-' + n, type: 10, ...extra }] });

test('native rkey is the primary source and a usable key bypasses fallback servers entirely', async t => {
    let nativeCalls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => 1000000,
        nativeRkey: async (kind, options) => { nativeCalls++; assert.equal(kind, 'group'); assert.equal(options.expectedEpoch, 'e1'); assert.equal(options.expectedUin, '123'); return groupKey(1); },
        fetchImpl: () => { throw new Error('Fallback must not be called when native succeeds'); }
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'NATIVE-GROUP-1');
    assert.equal(nativeCalls, 1);
});

test('native rkey caches per chat scope and refreshes after its TTL expires', async t => {
    let now = 1000000, calls = 0;
    const f = fixture(t, {}, {
        now: () => now,
        nativeRkey: async kind => { calls++; const create = Math.floor(now / 1000); return kind === 'group'
            ? { rkeys: [{ rkey: 'G' + calls, type: 10, rkeyTtlSec: 10, rkeyCreateTime: create }] }
            : { rkeys: [{ rkey: 'P' + calls, type: 20, rkeyTtlSec: 10, rkeyCreateTime: create }] }; },
        fetchImpl: () => { throw new Error('no fallback configured'); }
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'G1');
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 1, 'group cached');
    assert.equal(new URL(await f.client.resolveImageUrl(image, false)).searchParams.get('rkey'), 'P2', 'private uses type 20');
    assert.equal(calls, 2);
    now = 1011000; // past createTime(1000s)+ttl(10s)=1010000ms
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'G3', 'group refreshed');
    assert.equal(calls, 3);
});

test('an empty or absent native result falls back to configured servers without regression', async t => {
    let nativeCalls = 0, fallbackCalls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => 1000000,
        nativeRkey: async () => { nativeCalls++; return { rkeys: [] }; },
        fetchImpl: async () => { fallbackCalls++; return json({ group_rkey: 'FALLBACK' }); }
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'FALLBACK');
    assert.equal(nativeCalls, 1); assert.equal(fallbackCalls, 1);
});

test('a native query failure falls back and is negatively cached to avoid hammering the kernel', async t => {
    let now = 1000000, nativeCalls = 0, fallbackCalls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => now,
        nativeRkey: async () => { nativeCalls++; throw Object.assign(new Error('stub'), { code: 'QUERY_FAILED' }); },
        fetchImpl: async () => { fallbackCalls++; return json({ group_rkey: 'FALLBACK' }); }
    });
    f.client.resetSession('e1', '123');
    await f.client.resolveImageUrl(image, true);
    await f.client.resolveImageUrl(image, true);
    assert.equal(nativeCalls, 1, 'negative cache suppresses repeat native queries within 30s');
    assert.equal(fallbackCalls, 1, 'fallback key cached');
    now = 1031000; // negative cache expired; fallback key (default 60s) still valid
    await f.client.resolveImageUrl(image, true);
    assert.equal(nativeCalls, 2, 'native retried after negative cache expiry');
});

test('native SESSION_CHANGED propagates instead of silently falling back', async t => {
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        nativeRkey: async () => { throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); },
        fetchImpl: () => { throw new Error('Fallback must not run after SESSION_CHANGED'); }
    });
    f.client.resetSession('e1', '123');
    await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'SESSION_CHANGED' });
});

test('changing the confirmed QQ session clears the native rkey cache', async t => {
    let calls = 0;
    const f = fixture(t, {}, {
        now: () => 1000000,
        nativeRkey: async () => { calls++; return groupKey(calls); },
        fetchImpl: () => { throw new Error('no fallback'); }
    });
    f.client.resetSession('e1', '123');
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 1);
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 1, 'cached');
    f.client.resetSession('e2', '123');
    assert.equal(f.client.nativeKeys.size, 0);
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 2, 're-queried after session change');
});

test('a native entry with an invalid key value or wrong scope is rejected and falls back', async t => {
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => 1000000,
        nativeRkey: async () => ({ rkeys: [{ rkey: 'bad&inject=1', type: 10 }, { rkey: 'PRIVATE-only', type: 20 }] }),
        fetchImpl: async () => json({ group_rkey: 'FALLBACK' })
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'FALLBACK');
});

test('without a native adapter the existing fallback-only behavior is unchanged', async t => {
    const f = fixture(t, {}, { fetchImpl: () => { throw new Error('Unexpected network request'); } });
    await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'RKEY_UNAVAILABLE' });
    assert.equal(f.client.nativeKeys.size, 0);
});

test('a native key already past its expiry is rejected rather than cached', async t => {
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => 2000000,
        nativeRkey: async () => ({ rkeys: [{ rkey: 'STALE', type: 10, rkeyTtlSec: 10, rkeyCreateTime: 1000 }] }),
        fetchImpl: async () => json({ group_rkey: 'FALLBACK' })
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'FALLBACK');
    assert.equal(f.client.nativeKeys.size, 0);
});