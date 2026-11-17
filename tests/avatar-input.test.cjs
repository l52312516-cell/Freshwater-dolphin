'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const media = require('../src/qq/media.cjs');
const safe = require('../src/onebot/safe-download.cjs');
const { importAccountImage } = require('../src/onebot/image-import.cjs');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { OneBotService } = require('../src/onebot/service.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const inline = 'base64://' + png.toString('base64');
const scratch = path.resolve(__dirname, '../work/temp');
fs.mkdirSync(scratch, { recursive: true });

function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(scratch, 'avatar-input-')), directory = path.join(root, 'media');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'avatar.png'), png, { mode: 0o600 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = { ready: true, online: true, epoch: 'avatar-epoch', self: { uin: '12345', uid: 'u_self' },
        capabilities: { selfAvatar: true, groupAvatar: true } };
    const calls = [], overrides = {};
    const service = new OneBotService({ store: {}, mediaDirectory: directory, ...options, backend: {
        async call(method, params, callOptions) {
            calls.push({ method, params, options: callOptions });
            if (overrides[method]) return overrides[method](params);
            if (method === 'status') return structuredClone(state);
            assert.equal(method, 'extendedAction');
            assert.match(params.file, media.IMAGE_RESOURCE);
            const image = media.resourceInfo(directory, params.file);
            assert.deepEqual(fs.readFileSync(image.path), png);
            return { ...params, confirmed: true, confirmation: 'kernel_ack' };
        }
    } });
    const invoke = (action, params, options) => service.action({ action, params }, undefined, options);
    const resources = () => fs.readdirSync(directory).filter(name => media.IMAGE_RESOURCE.test(name));
    return { root, directory, state, service, calls, overrides, invoke, resources };
}

for (const action of ['set_qq_avatar', 'set_group_portrait']) {
    for (const kind of ['local', 'file URL', 'base64', 'data URL']) test(action + ' imports a valid ' + kind + ' image through an account handle', async t => {
        const f = fixture(t), sources = { local: 'avatar.png', 'file URL': pathToFileURL(path.join(f.directory, 'avatar.png')).href,
            base64: inline, 'data URL': 'data:image/png;base64,' + png.toString('base64') };
        const result = await f.invoke(action, { file: sources[kind], ...(action === 'set_group_portrait' ? { group_id: 67890 } : {}) });
        assert.equal(result.retcode, 0, JSON.stringify(result));
        assert.equal(f.resources().length, 1);
        const request = f.calls.find(call => call.method === 'extendedAction').params;
        assert.equal(request.operation, action === 'set_qq_avatar' ? 'self.avatar' : 'group.avatar');
        if (action === 'set_group_portrait') assert.equal(request.groupId, '67890');
    });
}

test('avatar actions preserve existing handles and use the media deadline', async t => {
    const f = fixture(t, { actionTimeoutMs: 1000, mediaActionTimeoutMs: 60000 }), original = media.exportImage(f.directory, png);
    const result = await f.invoke('set_qq_avatar', { file: original.file });
    assert.equal(result.retcode, 0); assert.deepEqual(f.resources(), [original.file]);
    assert.equal(f.calls.find(call => call.method === 'extendedAction').params.file, original.file);
    assert.ok(f.calls[0].options.timeoutMs > 50000);
});

for (const action of ['set_qq_avatar', 'set_group_portrait']) test(action + ' imports bounded HTTP bytes without forwarding the URL to QQ', async t => {
    const f = fixture(t); let downloads = 0, aborted = 0;
    t.mock.method(safe, 'openDownload', async (url, options) => {
        downloads++; assert.equal(url, 'https://public.example/avatar.png'); assert.equal(options.maximum, media.MAX_IMAGE_BYTES);
        assert.equal(options.signal.aborted, false);
        return { iterable: [png.subarray(0, 21), png.subarray(21)], size: png.length, abort() { aborted++; } };
    });
    assert.equal((await f.invoke(action, { file: 'https://public.example/avatar.png', ...(action === 'set_group_portrait' ? { group_id: 67890 } : {}) })).retcode, 0);
    assert.equal(downloads, 1); assert.equal(aborted, 1); assert.equal(f.resources().length, 1);
    const request = f.calls.find(call => call.method === 'extendedAction').params;
    assert.match(request.file, media.IMAGE_RESOURCE); assert.equal(JSON.stringify(request).includes('https://'), false);
});

test('group, capability, extra-field and account validation happen before downloading or staging', async t => {
    const f = fixture(t); let downloads = 0;
    t.mock.method(safe, 'openDownload', async () => { downloads++; throw new Error('must not download'); });
    for (const params of [{ file: inline }, { file: inline, group_id: 0 }, { file: inline, group_id: '067890' },
        { file: 'https://public.example/a', group_id: 67890, unexpected: true }, { file: inline, group_id: 67890, self_id: 99999 }]) {
        assert.equal((await f.invoke('set_group_portrait', params)).retcode, 1400);
    }
    f.state.capabilities.selfAvatar = false;
    assert.equal((await f.invoke('set_qq_avatar', { file: 'https://public.example/a' })).retcode, 1404);
    assert.equal(downloads, 0); assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

test('inline images reject wrong data MIME types, invalid encodings and non-image bodies before QQ', async t => {
    const f = fixture(t);
    for (const file of ['data:image/jpeg;base64,' + png.toString('base64'), 'data:text/html;base64,' + png.toString('base64'),
        'data:image/png;charset=utf-8;base64,' + png.toString('base64'), 'data:image/png,' + png.toString('base64'),
        'data:image/png;base64,AAAA\n', 'base64://Zh==', 'base64://AA-_', 'base64://',
        'base64://' + Buffer.from('<svg/>').toString('base64'), 'data:image/gif;base64,' + Buffer.from('<html/>').toString('base64')]) {
        assert.notEqual((await f.invoke('set_qq_avatar', { file })).retcode, 0, file.slice(0, 70));
    }
    assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

test('local image import rejects other-account paths, traversal, symlinks and hard links', async t => {
    const f = fixture(t), other = path.join(f.root, 'other'); fs.mkdirSync(other, { mode: 0o700 });
    const outside = path.join(other, 'avatar.png'); fs.writeFileSync(outside, png, { mode: 0o600 });
    for (const file of [outside, pathToFileURL(outside).href, '../other/avatar.png']) assert.equal((await f.invoke('set_qq_avatar', { file })).retcode, 1400);
    const linked = path.join(f.directory, 'hard.png'); fs.linkSync(outside, linked);
    assert.equal((await f.invoke('set_qq_avatar', { file: linked })).retcode, 1400);
    try {
        const symbolic = path.join(f.directory, 'symbol.png'); fs.symlinkSync(outside, symbolic);
        assert.equal((await f.invoke('set_qq_avatar', { file: symbolic })).retcode, 1400);
    } catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; }
    assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

test('HTTP import rejects streamed overflows, declared-length mismatch and disguised image bodies', async t => {
    const f = fixture(t); let source, aborted = 0;
    t.mock.method(safe, 'openDownload', async () => ({ ...source, abort() { aborted++; } }));
    for (const candidate of [
        { iterable: [Buffer.alloc(media.MAX_IMAGE_BYTES), Buffer.from([1])], size: null },
        { iterable: [png], size: png.length + 1 }, { iterable: [Buffer.from('<html/>')], size: null }, { iterable: [], size: 0 }
    ]) {
        source = candidate; assert.notEqual((await f.invoke('set_qq_avatar', { file: 'https://public.example/a.png' })).retcode, 0);
    }
    assert.equal(aborted, 4); assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

function httpRequest(bytes, { statusCode = 200, headers = {}, onConnect } = {}) {
    return (url, options, callback) => {
        const request = new EventEmitter(); request.setTimeout = () => {};
        request.destroy = () => {}; request.end = () => {
            assert.equal(options.agent, false);
            options.lookup(url.hostname, {}, (error, address) => {
                assert.equal(error, null); assert.equal(address, '8.8.8.8'); onConnect?.();
                const response = new PassThrough(); response.statusCode = statusCode; response.headers = headers;
                callback(response); response.end(bytes);
            });
        };
        return request;
    };
}

test('safe HTTP import preserves DNS pinning and rejects private/mixed DNS, redirects and encoded responses', async t => {
    const f = fixture(t), state = structuredClone(f.state), publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const file = await importAccountImage(f.service, state, 'https://public.example/avatar.png', {
        lookup: publicLookup, request: httpRequest(png, { headers: { 'content-length': String(png.length) } }) });
    assert.match(file, media.IMAGE_RESOURCE);
    const count = f.resources().length;
    for (const input of ['http://127.1/a', 'http://2130706433/a', 'https://user:pass@example.com/a', 'https://example.com:8443/a']) {
        await assert.rejects(importAccountImage(f.service, state, input), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(importAccountImage(f.service, state, 'https://public.example/a', {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request() { assert.fail('private DNS must not connect'); }
    }), { code: 'INVALID_PARAMS' });
    for (const settings of [{ statusCode: 302 }, { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': String(media.MAX_IMAGE_BYTES + 1) } }]) {
        await assert.rejects(importAccountImage(f.service, state, 'https://public.example/a', { lookup: publicLookup, request: httpRequest(png, settings) }), { code: 'QUERY_FAILED' });
    }
    assert.equal(f.resources().length, count);
});

test('overall import deadline includes DNS and prevents a late connection', async t => {
    const f = fixture(t), state = structuredClone(f.state); f.service.remaining = () => 25;
    let resolveDns, connected = 0;
    const task = importAccountImage(f.service, state, 'https://public.example/a', {
        lookup: () => new Promise(resolve => { resolveDns = resolve; }), request() { connected++; assert.fail('expired DNS must not connect'); }
    });
    await assert.rejects(task, { code: 'EXPIRED' });
    assert.equal(typeof resolveDns, 'function'); resolveDns([{ address: '8.8.8.8', family: 4 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connected, 0); assert.deepEqual(f.resources(), []);
});

test('cancelled DNS work retains physical concurrency slots until it actually finishes', async t => {
    const f = fixture(t), state = structuredClone(f.state), release = [];
    for (let index = 0; index < 4; index++) {
        const control = new AbortController(), task = importAccountImage(f.service, state, 'https://public.example/a', {
            signal: control.signal, lookup: () => new Promise(resolve => release.push(resolve)), request() { assert.fail('cancelled DNS must not connect'); }
        });
        await new Promise(resolve => setImmediate(resolve)); control.abort(); await assert.rejects(task, { code: 'EXPIRED' });
    }
    await assert.rejects(importAccountImage(f.service, state, inline), { code: 'BUSY' });
    for (const resolve of release) resolve([{ address: '8.8.8.8', family: 4 }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(await importAccountImage(f.service, state, inline), media.IMAGE_RESOURCE);
});

test('caller cancellation terminates a stalled stream and cannot dispatch QQ', async t => {
    const f = fixture(t), control = new AbortController(), body = new PassThrough(); let opened, aborted = 0;
    const ready = new Promise(resolve => { opened = resolve; });
    t.mock.method(safe, 'openDownload', async () => { opened(); return { iterable: body, size: null, abort() { aborted++; body.destroy(); } }; });
    const task = f.invoke('set_qq_avatar', { file: 'https://public.example/a' }, { signal: control.signal });
    await ready; await new Promise(resolve => setImmediate(resolve)); control.abort();
    assert.equal((await task).retcode, 1504);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(aborted >= 1); assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

test('session changes during image download cannot stage or dispatch another account image', async t => {
    const f = fixture(t);
    t.mock.method(safe, 'openDownload', async () => ({ size: png.length, abort() {}, iterable: (async function* () {
        yield png.subarray(0, 21); f.state.epoch = 'changed'; yield png.subarray(21);
    })() }));
    assert.equal((await f.invoke('set_qq_avatar', { file: 'https://public.example/a' })).retcode, 1503);
    assert.deepEqual(f.resources(), []); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

test('successful, rejected and unknown native results retain imported bytes and preserve original resources', async t => {
    const f = fixture(t), original = media.exportImage(f.directory, png);
    f.overrides.extendedAction = params => { assert.match(params.file, media.IMAGE_RESOURCE); throw Object.assign(new Error('lost response'), { code: 'TIMEOUT' }); };
    assert.equal((await f.invoke('set_qq_avatar', { file: inline })).retcode, 1504);
    assert.equal(f.resources().length, 2); assert.deepEqual(fs.readFileSync(original.path), png);
    f.overrides.extendedAction = params => ({ ...params, file: original.file, confirmed: true, confirmation: 'kernel_ack' });
    assert.equal((await f.invoke('set_group_portrait', { file: inline, group_id: 67890 })).retcode, 1500);
    assert.equal(f.resources().length, 3); assert.deepEqual(fs.readFileSync(original.path), png);
});

test('a session failure after export removes only the handle that was never issued', async t => {
    const f = fixture(t), original = media.exportImage(f.directory, png), state = structuredClone(f.state);
    const check = f.service.assertSession.bind(f.service);
    f.service.assertSession = async value => {
        if (f.resources().length > 1) throw Object.assign(new Error('session changed after staging'), { code: 'SESSION_CHANGED' });
        await check(value);
    };
    await assert.rejects(importAccountImage(f.service, state, inline), { code: 'SESSION_CHANGED' });
    assert.deepEqual(f.resources(), [original.file]); assert.deepEqual(fs.readFileSync(original.path), png);
});

test('existing account resource quota bounds repeated avatar imports before native submission', async t => {
    const f = fixture(t);
    for (let index = 0; index < media.MAX_RESOURCES; index++) fs.writeFileSync(path.join(f.directory, 'fwd-image-' + index.toString(16).padStart(32, '0')), png, { mode: 0o600 });
    assert.equal((await f.invoke('set_qq_avatar', { file: inline })).retcode, 1503);
    assert.equal(f.resources().length, media.MAX_RESOURCES); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
});

for (const source of ['existing handle', 'imported image']) for (const waitAt of ['authorization', 'status']) {
    test(source + ' cancellation during final ' + waitAt + ' check never dispatches native', async t => {
        const f = fixture(t), control = new AbortController();
        const file = source === 'existing handle' ? media.exportImage(f.directory, png).file : inline;
        let release, ready, armed = false, blocked = false, presentChecks = 0;
        const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { ready = resolve; });
        const check = f.service.assertSession.bind(f.service);
        f.service.assertSession = async value => {
            if (f.resources().length && ++presentChecks === (source === 'existing handle' ? 1 : 2)) armed = true;
            return check(value);
        };
        const pause = async () => { if (armed && !blocked) { blocked = true; ready(); await gate; } };
        if (waitAt === 'authorization') f.service.authorizeSession = async () => { await pause(); return true; };
        else f.overrides.status = async () => { await pause(); return structuredClone(f.state); };
        const task = f.invoke('set_qq_avatar', { file }, { signal: control.signal });
        await waiting; control.abort(); release();
        assert.equal((await task).retcode, 1504);
        assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
        assert.equal(f.resources().length, 1);
    });
}

test('cancellation after native dispatch preserves imported bytes and never retries the mutation', async t => {
    const f = fixture(t), control = new AbortController(); let ready, release;
    const waiting = new Promise(resolve => { ready = resolve; });
    f.overrides.extendedAction = params => { ready(); return new Promise(resolve => { release = () => resolve({ ...params, confirmed: true, confirmation: 'kernel_ack' }); }); };
    const task = f.invoke('set_group_portrait', { file: inline, group_id: 67890 }, { signal: control.signal });
    await waiting; control.abort(); release();
    assert.equal((await task).retcode, 1504);
    assert.equal(f.calls.filter(call => call.method === 'extendedAction').length, 1);
    assert.equal(f.resources().length, 1);
});

test('the action deadline expires during final authorization without a late native dispatch', async t => {
    const f = fixture(t, { mediaActionTimeoutMs: 40 }), original = media.exportImage(f.directory, png);
    let ready, release, blocked = false;
    const waiting = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.service.authorizeSession = async () => { if (!blocked) { blocked = true; ready(); await gate; } return true; };
    const task = f.invoke('set_qq_avatar', { file: original.file });
    await waiting; assert.equal((await task).retcode, 1504); release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
    assert.deepEqual(f.resources(), [original.file]);
});

test('a native response arriving after the deadline is unknown and does not remove its image', async t => {
    const f = fixture(t, { mediaActionTimeoutMs: 200 }); let ready, release;
    const waiting = new Promise(resolve => { ready = resolve; });
    f.overrides.extendedAction = params => { ready(); return new Promise(resolve => { release = () => resolve({ ...params, confirmed: true, confirmation: 'kernel_ack' }); }); };
    const task = f.invoke('set_qq_avatar', { file: inline });
    await waiting; assert.equal((await task).retcode, 1504); release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(call => call.method === 'extendedAction').length, 1);
    assert.equal(f.resources().length, 1);
});

test('cancelled final authorization work retains avatar operation slots until it settles', async t => {
    const f = fixture(t), original = media.exportImage(f.directory, png), release = []; let checks = 0;
    f.service.authorizeSession = () => { checks++; return new Promise(resolve => release.push(resolve)); };
    for (let index = 0; index < 4; index++) {
        const control = new AbortController(), task = f.invoke('set_qq_avatar', { file: original.file }, { signal: control.signal });
        await new Promise(resolve => setImmediate(resolve)); control.abort();
        assert.equal((await task).retcode, 1504);
    }
    assert.equal((await f.invoke('set_qq_avatar', { file: original.file })).retcode, 1503);
    assert.equal(checks, 4); assert.equal(f.calls.some(call => call.method === 'extendedAction'), false);
    f.service.authorizeSession = async () => true;
    for (const resolve of release) resolve(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.invoke('set_qq_avatar', { file: original.file })).retcode, 0);
    assert.deepEqual(f.resources(), [original.file]);
});
