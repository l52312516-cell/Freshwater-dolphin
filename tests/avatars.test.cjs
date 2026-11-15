'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AvatarCache } = require('../src/manager/avatars.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCU0AAAAASUVORK5CYII=', 'base64');
function fixture(t, fetchImpl = async () => new Response(png)) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'avatars-'));
    const profiles = new Map([['one', { id: 'one', expectedUin: '999', boundUin: '123' }], ['two', { id: 'two', boundUin: '456' }], ['new', { id: 'new', expectedUin: '789' }]]);
    const accounts = { healths: new Map(), processes: new Map(), get(id) { if (!profiles.has(id)) throw Object.assign(new Error('Missing account'), { statusCode: 404 }); return profiles.get(id); } };
    const cache = new AvatarCache(root, accounts, { fetchImpl });
    t.after(() => { cache.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, profiles, accounts, cache };
}
test('avatar uses confirmed bound identity, fixed official URL, and deduplicates concurrent fetches', async t => {
    let calls = 0;
    const f = fixture(t, async (url, options) => { calls++; assert.equal(url, 'https://q1.qlogo.cn/g?b=qq&nk=123&s=100'); assert.equal(options.redirect, 'error'); return new Response(png); });
    const results = await Promise.all([f.cache.get('one'), f.cache.get('one')]);
    assert.equal(calls, 1); assert.equal(results[0].type, 'image/png'); assert.deepEqual(results[0].bytes, png);
    await f.cache.get('one'); assert.equal(calls, 1);
    await assert.rejects(f.cache.get('new'), { code: 'AVATAR_UNAVAILABLE' });
});
test('authorized actual identity takes precedence and late response cannot cross account generations', async t => {
    let resolve; const waiting = new Promise(done => { resolve = done; });
    const f = fixture(t, async url => { assert.ok(url.includes('nk=321')); await waiting; return new Response(png); });
    f.accounts.healths.set('one', { authorized: true, selfId: '321', sessionEpoch: 'first' });
    const pending = f.cache.get('one');
    f.accounts.healths.set('one', { authorized: true, selfId: '321', sessionEpoch: 'second' }); resolve();
    await assert.rejects(pending, { code: 'AVATAR_STALE' });
});
test('HTML, SVG, redirects and oversized bodies are rejected', async t => {
    const f = fixture(t); const sources = [new Response('<svg/>'), new Response('<html/>'), new Response(png, { status: 302 }), new Response(png, { headers: { 'content-length': String(512 * 1024 + 1) } }), new Response(Buffer.alloc(512 * 1024 + 1))];
    for (const response of sources) { f.cache.fetch = async () => response; await assert.rejects(f.cache.get('one')); }
});
test('deleted account cannot retrieve a cached avatar and one identity never falls back to another', async t => {
    let calls = 0; const f = fixture(t, async () => { calls++; if (calls > 1) throw new Error('Unavailable'); return new Response(png); });
    await f.cache.get('one'); await assert.rejects(f.cache.get('two'), { code: 'AVATAR_UNAVAILABLE' });
    f.profiles.delete('one'); await assert.rejects(f.cache.get('one'), { statusCode: 404 });
});
test('valid disk cache survives a cache-object restart without another download', async t => {
    const f = fixture(t); await f.cache.get('one'); f.cache.close();
    const restarted = new AvatarCache(f.root, f.accounts, { fetchImpl: async () => { throw new Error('Unexpected download'); } });
    t.after(() => restarted.close()); assert.deepEqual((await restarted.get('one')).bytes, png);
});
test('avatar outbound concurrency and waiting queue are bounded and closing rejects active and queued requests', async t => {
    let resolve; const waiting = new Promise(done => { resolve = done; });
    const f = fixture(t, async () => { await waiting; return new Response(png); });
    const pending = Array.from({ length: 68 }, (_, index) => f.cache.getContact('one', 'user', String(1000 + index)));
    const outcomes = Promise.all(pending.map(request => request.then(() => 'unexpected success', error => error.code)));
    await new Promise(done => setImmediate(done));
    assert.equal(f.cache.active, 4); assert.equal(f.cache.queue.length, 64);
    await assert.rejects(f.cache.getContact('one', 'user', '9999'), { code: 'AVATAR_BUSY' });
    f.cache.close();
    assert.deepEqual(await outcomes, Array(68).fill('AVATAR_UNAVAILABLE'));
    assert.equal(f.cache.queue.length, 0); assert.equal(f.cache.active, 0);
    resolve(); await new Promise(done => setImmediate(done));
    assert.equal(fs.readdirSync(f.cache.directory).length, 0); assert.equal(f.cache.memoryBytes, 0);
});

test('contact avatars use fixed user and group URLs, share user caches, and keep equal numeric group keys separate', async t => {
    const calls = [], groupImage = Buffer.concat([png, Buffer.from('group')]);
    const f = fixture(t, async (url, options) => {
        calls.push(url); assert.equal(options.redirect, 'error');
        if (url === 'https://q1.qlogo.cn/g?b=qq&nk=123&s=100') return new Response(png);
        assert.equal(url, 'https://p.qlogo.cn/gh/123/123/100'); return new Response(groupImage);
    });
    assert.deepEqual((await f.cache.getContact('one', 'user', '123')).bytes, png);
    assert.deepEqual((await f.cache.get('one')).bytes, png);
    const groups = await Promise.all([f.cache.getContact('one', 'group', '123'), f.cache.getContact('two', 'group', '123')]);
    assert.deepEqual(groups[0].bytes, groupImage); assert.deepEqual(groups[1].bytes, groupImage);
    assert.equal(calls.length, 2);
    assert.deepEqual(fs.readdirSync(f.cache.directory).sort(), ['123.img', 'group-123.img']);
    f.cache.close();
    const restarted = new AvatarCache(f.root, f.accounts, { fetchImpl: async () => { throw new Error('Unexpected download'); } });
    t.after(() => restarted.close());
    assert.deepEqual((await restarted.getContact('one', 'group', '123')).bytes, groupImage);
});

test('contact IDs and kinds cannot select arbitrary URLs or cache paths', async t => {
    let calls = 0; const f = fixture(t, async () => { calls++; return new Response(png); });
    for (const id of [null, undefined, '', '0', '-1', '01', '9007199254740992', '12345678901234567', '../123', 'https://example.com/123', '123?url=x', '123/456']) {
        await assert.rejects(f.cache.getContact('one', 'user', id), { code: 'INVALID_AVATAR' });
    }
    for (const kind of ['', 'USER', '../group', 'https://example.com']) await assert.rejects(f.cache.getContact('one', kind, '123'), { code: 'INVALID_AVATAR' });
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(f.cache.directory), []);
});

test('group avatar downloads refuse redirected hosts and non-image bodies', async t => {
    const f = fixture(t);
    const changedUrl = new Response(png); Object.defineProperty(changedUrl, 'url', { value: 'https://example.com/avatar' });
    for (const response of [new Response('<html/>'), new Response(png, { status: 302 }), changedUrl]) {
        f.cache.fetch = async () => response;
        await assert.rejects(f.cache.getContact('one', 'group', '123'), { code: response === changedUrl || response.status === 302 ? 'AVATAR_UNAVAILABLE' : 'AVATAR_INVALID' });
    }
    assert.deepEqual(fs.readdirSync(f.cache.directory), []);
});

test('contact avatar access requires a confirmed existing account and rejects a changed or deleted account after download', async t => {
    let resolve; const waiting = new Promise(done => { resolve = done; });
    const f = fixture(t, async () => { await waiting; return new Response(png); });
    await assert.rejects(f.cache.getContact('new', 'user', '123'), { code: 'AVATAR_UNAVAILABLE' });
    await assert.rejects(f.cache.getContact('missing', 'user', '123'), { statusCode: 404 });
    f.accounts.healths.set('one', { authorized: true, selfId: '123', sessionEpoch: 'first' });
    const stale = f.cache.getContact('one', 'group', '123');
    const deleted = f.cache.getContact('two', 'user', '456');
    f.accounts.healths.set('one', { authorized: true, selfId: '123', sessionEpoch: 'second' });
    f.profiles.delete('two'); resolve();
    await assert.rejects(stale, { code: 'AVATAR_STALE' });
    await assert.rejects(deleted, { statusCode: 404 });
});

test('contact image bursts wait for download slots without exceeding four outbound requests', async t => {
    let active = 0, peak = 0, calls = 0;
    const f = fixture(t, async () => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--; return new Response(png);
    });
    const values = await Promise.all(Array.from({ length: 16 }, (_, index) => f.cache.getContact('one', index % 2 ? 'user' : 'group', String(1000 + index))));
    assert.equal(calls, 16); assert.equal(peak, 4); assert.equal(f.cache.active, 0); assert.equal(f.cache.queue.length, 0);
    for (const value of values) assert.deepEqual(value.bytes, png);
});
