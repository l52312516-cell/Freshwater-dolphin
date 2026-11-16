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
const groupKey = (n, extra = {}) => ({ rkeys: [{ rkey: 'NATIVE-GROUP-' + n, type: 20,
    rkeyCreateTime: 1000, rkeyTtlSec: 60, ...extra }] });

test('forwarded image appid selects its original native scope independently of chat and response order', async t => {
    const seen = [];
    const f = fixture(t, {}, { now: () => 1000000, nativeRkey: async kind => {
        seen.push(kind);
        return { rkeys: [
            { rkey: 'GROUP', type: 20, rkeyCreateTime: 1000, rkeyTtlSec: 60 },
            { rkey: 'PRIVATE', type: 10, rkeyCreateTime: 1000, rkeyTtlSec: 60 }
        ] };
    } });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image.replace('1407', '1406'), true)).searchParams.get('rkey'), 'PRIVATE');
    assert.equal(new URL(await f.client.resolveImageUrl(image, false)).searchParams.get('rkey'), 'GROUP');
    assert.deepEqual(seen, ['private', 'group']);
});

test('forwarded image scope also selects the matching fallback key and rejects duplicate appids before querying', async t => {
    let calls = 0;
    const f = fixture(t, { rkey: { fallbackServers: ['https://rkey.example/'] } }, {
        now: () => 1000000, fetchImpl: async () => {
            calls++; return json({ group_rkey: 'GROUP', private_rkey: 'PRIVATE' });
        }
    });
    for (const suffix of ['&appid=1406', '&appid=1407']) {
        await assert.rejects(f.client.resolveImageUrl(image + suffix, true), { code: 'INVALID_PARAMS' });
    }
    assert.equal(calls, 0);
    assert.equal(new URL(await f.client.resolveImageUrl(image.replace('1407', '1406'), true)).searchParams.get('rkey'), 'PRIVATE');
    assert.equal(new URL(await f.client.resolveImageUrl(image, false)).searchParams.get('rkey'), 'GROUP');
    const unscoped = image.replace('appid=1407&', '');
    assert.equal(new URL(await f.client.resolveImageUrl(unscoped, true)).searchParams.get('rkey'), 'GROUP');
    assert.equal(new URL(await f.client.resolveImageUrl(unscoped, false)).searchParams.get('rkey'), 'PRIVATE');
    assert.equal(calls, 2);
});

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

test('official URLs carrying an old rkey renew with the account cache and force-refresh rejected keys once', async t => {
    let calls = 0;
    const f = fixture(t, {}, { now: () => 1000000, nativeRkey: async () => groupKey(++calls) });
    f.client.resetSession('e1', '123');
    const old = image + '&rkey=EXPIRED';
    const first = await f.client.resolveImageUrl(old, true);
    assert.equal(new URL(first).searchParams.get('rkey'), 'NATIVE-GROUP-1');
    const refreshed = await f.client.resolveImageUrl(first, true, { forceRefresh: true });
    assert.equal(new URL(refreshed).searchParams.get('rkey'), 'NATIVE-GROUP-2');
    assert.equal(new URL(await f.client.resolveImageUrl(first, true, { forceRefresh: true })).searchParams.get('rkey'), 'NATIVE-GROUP-2');
    assert.equal(calls, 2, 'a concurrent rejection of an old key preserves its already refreshed replacement');
    await assert.rejects(f.client.resolveImageUrl(image + '&rkey=a&rkey=b', true), { code: 'INVALID_PARAMS' });
});

test('existing official keys remain usable without a refresh source but an explicit rejected-key refresh fails', async t => {
    const f = fixture(t);
    const existing = image + '&rkey=FROM-QQ';
    assert.equal(await f.client.resolveImageUrl(existing, true), existing);
    await assert.rejects(f.client.resolveImageUrl(existing, true, { forceRefresh: true }), { code: 'RKEY_UNAVAILABLE' });
});

test('native rkey caches per chat scope and refreshes after its TTL expires', async t => {
    let now = 1000000, calls = 0;
    const f = fixture(t, {}, {
        now: () => now,
        nativeRkey: async kind => { calls++; const create = Math.floor(now / 1000); return kind === 'group'
            ? { rkeys: [{ rkey: 'G' + calls, type: 20, rkeyTtlSec: 10, rkeyCreateTime: create }] }
            : { rkeys: [{ rkey: 'P' + calls, type: 10, rkeyTtlSec: 10, rkeyCreateTime: create }] }; },
        fetchImpl: () => { throw new Error('no fallback configured'); }
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'G1');
    await f.client.resolveImageUrl(image, true); assert.equal(calls, 1, 'group cached');
    assert.equal(new URL(await f.client.resolveImageUrl(image.replace('1407', '1406'), false)).searchParams.get('rkey'), 'P2', 'private uses type 10');
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
        nativeRkey: async () => ({ rkeys: [{ rkey: 'bad&inject=1', type: 20 }, { rkey: 'PRIVATE-only', type: 10 }] }),
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
        nativeRkey: async () => ({ rkeys: [{ rkey: 'STALE', type: 20, rkeyTtlSec: 10, rkeyCreateTime: 1000 }] }),
        fetchImpl: async () => json({ group_rkey: 'FALLBACK' })
    });
    f.client.resetSession('e1', '123');
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'FALLBACK');
    assert.equal(f.client.nativeKeys.size, 0);
});

test('native rkey coalesces concurrent readers without inheriting the first caller deadline', async t => {
    let calls = 0, finish;
    const f = fixture(t, {}, { now: () => 1000000, nativeRkey: async (_kind, options) => {
        calls++;
        assert.equal(options.timeoutMs, 10000, 'shared query has a bounded independent budget');
        return new Promise(resolve => { finish = resolve; });
    } });
    f.client.resetSession('e1', '123');
    const short = f.client.resolveImageUrl(image, true, { timeoutMs: 10 });
    const longer = f.client.resolveImageUrl(image + 'x', true, { timeoutMs: 1000 });
    await assert.rejects(short, { code: 'TIMEOUT' });
    assert.equal(calls, 1);
    assert.equal(f.client.nativeNegative.size, 0, 'one reader timing out is not a query failure');
    finish(groupKey(1));
    assert.equal(new URL(await longer).searchParams.get('rkey'), 'NATIVE-GROUP-1');
    assert.equal(f.client.nativePending.size, 0);
});

test('late success and late rejection cannot populate the replacement session cache', async t => {
    for (const fails of [false, true]) {
        let settle, calls = 0;
        const f = fixture(t, {}, { now: () => 1000000, nativeRkey: () => {
            calls++;
            if (calls === 1) return new Promise((resolve, reject) => { settle = fails ? reject : resolve; });
            return groupKey(2);
        } });
        f.client.resetSession('old', '123');
        const old = f.client.resolveImageUrl(image, true);
        f.client.resetSession('new', '456');
        assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'NATIVE-GROUP-2');
        const rejected = assert.rejects(old, { code: 'SESSION_CHANGED' });
        settle(fails ? Object.assign(new Error('late'), { code: 'QUERY_FAILED' }) : groupKey(1));
        await rejected;
        assert.equal(f.client.nativeKeys.get('group').key, 'NATIVE-GROUP-2');
        assert.equal(f.client.nativeNegative.size, 0);
    }
});

test('settings changes discard late native failures and permit a replacement query', async t => {
    let rejectOld, calls = 0;
    const f = fixture(t, {}, { now: () => 1000000, nativeRkey: () => {
        calls++;
        return calls === 1 ? new Promise((_resolve, reject) => { rejectOld = reject; }) : groupKey(2);
    } });
    f.client.resetSession('e1', '123');
    const old = f.client.resolveImageUrl(image, true);
    atomic(f.file, { version: 1, maxAccounts: 2, musicSignUrl: 'https://sign.example/' });
    const rejected = assert.rejects(old, { code: 'GLOBAL_SETTINGS_CHANGED' });
    assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'NATIVE-GROUP-2');
    rejectOld(Object.assign(new Error('old config failed'), { code: 'QUERY_FAILED' }));
    await rejected;
    assert.equal(f.client.nativeNegative.size, 0);
    assert.equal(f.client.nativeKeys.get('group').key, 'NATIVE-GROUP-2');
});

test('changing settings away and back still invalidates a previous native query generation', async t => {
    let finish;
    const f = fixture(t, {}, { now: () => 1000000, nativeRkey: () => new Promise(resolve => { finish = resolve; }) });
    f.client.resetSession('e1', '123');
    const old = f.client.resolveImageUrl(image, true);
    atomic(f.file, { version: 1, maxAccounts: 2, musicSignUrl: 'https://sign.example/' });
    f.client.settings();
    atomic(f.file, { version: 1, maxAccounts: 2 });
    f.client.settings();
    const rejected = assert.rejects(old, { code: 'GLOBAL_SETTINGS_CHANGED' });
    finish(groupKey(1));
    await rejected;
    assert.equal(f.client.nativeKeys.size, 0);
    assert.equal(f.client.nativeNegative.size, 0);
});

test('missing, malformed or unsafe native lifetimes never receive an invented expiry', async t => {
    const lifetimes = [
        { rkeyTtlSec: undefined }, { rkeyCreateTime: undefined }, { rkeyTtlSec: 0 },
        { rkeyTtlSec: Number.MAX_SAFE_INTEGER + 1 }, { rkeyTtlSec: '1.5' },
        { rkeyCreateTime: -1 }, { rkeyCreateTime: 0x100000000 },
        { rkeyTtlSec: 0x10000000000000000n }
    ];
    for (const lifetime of lifetimes) {
        const f = fixture(t, {}, { now: () => 1000000, nativeRkey: () => groupKey(1, lifetime) });
        f.client.resetSession('e1', '123');
        await assert.rejects(f.client.resolveImageUrl(image, true), { code: 'RKEY_UNAVAILABLE' });
        assert.equal(f.client.nativeKeys.size, 0);
    }
});

test('uint64 native lifetimes remain exact before the local one-hour cache bound', async t => {
    for (const ttl of [0xffffffffffffffffn, '18446744073709551615']) {
        const f = fixture(t, {}, { now: () => 1000000, nativeRkey: () => groupKey(1, { rkeyTtlSec: ttl }) });
        f.client.resetSession('e1', '123');
        assert.equal(new URL(await f.client.resolveImageUrl(image, true)).searchParams.get('rkey'), 'NATIVE-GROUP-1');
        assert.equal(f.client.nativeKeys.get('group').expiresAt, 4600000);
    }
});
