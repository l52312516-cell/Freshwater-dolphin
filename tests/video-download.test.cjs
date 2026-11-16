'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { downloadVideo } = require('../src/qq/video-download.cjs');
const { MAX_VIDEO_BYTES } = require('../src/qq/media.cjs');

function box(type, payload) {
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length + 8);
    return Buffer.concat([size, Buffer.from(type), payload]);
}
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isommp42')),
    box('moov', Buffer.from([0])), box('mdat', Buffer.from([1, 2, 3]))]);
const hash = (kind, value) => crypto.createHash(kind).update(value).digest('hex');
const source = 'https://multimedia.nt.qq.com.cn/download?fileid=QQFILE&rkey=PRIVATE';
function options(overrides = {}) {
    return { urls: [{ url: source, isHttps: true, httpsDomain: 'multimedia.nt.qq.com.cn' }],
        expectedSize: mp4.length, expectedMd5: hash('md5', mp4), expiresAt: Date.now() + 1000,
        fetchImpl: async () => new Response(mp4), ...overrides };
}
function streaming(chunks, headers) {
    return new Response(new ReadableStream({ start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
    } }), { headers });
}

test('downloads exact video bytes with derived metadata and preserves the actual signed URL', async () => {
    let calls = 0;
    const result = await downloadVideo(options({ expectedSize: String(mp4.length), expectedMd5: hash('md5', mp4).toUpperCase(),
        urls: [{ url: source, isHttps: false, httpsDomain: 'untrusted.example' }], fetchImpl: async (url, init) => {
            calls++; assert.equal(url, source); assert.equal(init.redirect, 'error');
            assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
            assert.equal(init.signal.aborted, false);
            return streaming([mp4.subarray(0, 17), mp4.subarray(17)], { 'content-length': String(mp4.length) });
        } }));
    assert.equal(calls, 1); assert.deepEqual(result.bytes, mp4);
    assert.deepEqual({ ...result, bytes: undefined }, { bytes: undefined, type: 'video', size: mp4.length,
        md5: hash('md5', mp4), sha256: hash('sha256', mp4), extension: 'mp4', mime: 'video/mp4' });
});

test('selects the first trusted actual URL and never rewrites an untrusted host from advisory metadata', async () => {
    const seen = [], trusted = 'http://video.store.qq.com/movie.mp4?token=KEEP';
    await downloadVideo(options({ urls: [{ url: 'https://evil.example/video', isHttps: true, httpsDomain: 'video.store.qq.com' },
        { url: trusted, httpsDomain: 'evil.example' }, { url: source }], fetchImpl: async url => { seen.push(url); return new Response(mp4); } }));
    assert.deepEqual(seen, [trusted]);
    for (const host of ['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com', 'gslbsv.mp.qq.com', 'video.store.qq.com']) {
        await downloadVideo(options({ urls: [{ url: 'https://' + host + '/video' }] }));
    }
});

test('rejects unofficial hosts, credentials, ports, fragments and parser-repaired URLs before fetching', async () => {
    const invalid = ['https://multimedia.nt.qq.com.evil.example/v', 'https://evil.multimedia.nt.qq.com/v',
        'https://multimedia.nt.qq.com./v', 'https://user@multimedia.nt.qq.com/v',
        'https://user:password@multimedia.nt.qq.com/v', 'https://multimedia.nt.qq.com:444/v',
        'http://multimedia.nt.qq.com:443/v', source + '#fragment', source + '#', 'https://@multimedia.nt.qq.com/v', 'file:///video.mp4',
        'ftp://multimedia.nt.qq.com/v', '//multimedia.nt.qq.com/v', ' ' + source,
        'https://multimedia.nt.qq.com\\@evil.example/v', 'https://multi\nmedia.nt.qq.com/v',
        'https://127.0.0.1/v', 'https://[::1]/v', 'https://multimedia%2ent.qq.com:8443/v', '', null];
    for (const url of invalid) {
        await assert.rejects(downloadVideo(options({ urls: [{ url, isHttps: true, httpsDomain: 'multimedia.nt.qq.com' }],
            fetchImpl: () => { assert.fail('Untrusted URL must never be fetched'); } })), { code: 'INVALID_RESPONSE' });
    }
    for (const urls of [undefined, null, {}, [], [{ httpsDomain: 'video.store.qq.com' }]]) {
        await assert.rejects(downloadVideo(options({ urls })), { code: 'INVALID_RESPONSE' });
    }
});

test('requires bounded exact size, MD5 and deadline before starting the request', async () => {
    const denied = () => { assert.fail('Invalid metadata must not be fetched'); };
    for (const expectedSize of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER, MAX_VIDEO_BYTES + 1,
        undefined, null, true, '0', '01', '1e2', ' 1', '1.0', '+1', '9007199254740993']) {
        await assert.rejects(downloadVideo(options({ expectedSize, fetchImpl: denied })), { code: 'INVALID_PARAMS' });
    }
    for (const expectedMd5 of ['', 'a'.repeat(31), 'g'.repeat(32), null, undefined]) {
        await assert.rejects(downloadVideo(options({ expectedMd5, fetchImpl: denied })), { code: 'INVALID_PARAMS' });
    }
    for (const expiresAt of [null, undefined, Infinity, 1.5]) {
        if (expiresAt === undefined) continue;
        await assert.rejects(downloadVideo(options({ expiresAt, fetchImpl: denied })), { code: 'INVALID_PARAMS' });
    }
    await assert.rejects(downloadVideo(options({ signal: {}, fetchImpl: denied })), { code: 'INVALID_PARAMS' });
    await assert.rejects(downloadVideo(options({ expiresAt: Date.now() - 1, fetchImpl: denied })), { code: 'TIMEOUT' });
});

test('requires any Content-Length to be canonical and exactly match QQ metadata', async () => {
    for (const length of ['0', String(mp4.length - 1), String(mp4.length + 1), '0' + mp4.length, '1e2', '50, 50', '9007199254740993']) {
        await assert.rejects(downloadVideo(options({ fetchImpl: async () => new Response(mp4, { headers: { 'content-length': length } }) })),
            { code: 'INVALID_RESPONSE' });
    }
    let cancelled = false;
    await assert.rejects(downloadVideo(options({ fetchImpl: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; }
    }), { headers: { 'content-length': String(mp4.length + 1) } }) })), { code: 'INVALID_RESPONSE' });
    assert.equal(cancelled, true);
});

test('accepts a complete 200 response whose Content-Range describes the full file (QQ video CDN)', async () => {
    const result = await downloadVideo(options({ fetchImpl: async () => streaming([mp4], {
        'content-length': String(mp4.length), 'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}` }) }));
    assert.deepEqual(result.bytes, mp4); assert.equal(result.size, mp4.length);
});

test('rejects redirects, partial responses and changed response URLs without a second attempt', async () => {
    for (const value of [new Response(mp4, { status: 302, headers: { location: source } }),
        new Response(mp4, { status: 206 }), new Response(mp4, { status: 500 }),
        new Response(mp4, { headers: { 'content-range': 'bytes 0-49/50' } }),
        { status: 200, redirected: true }, { status: 200, url: source + '&new=1' }]) {
        let calls = 0;
        await assert.rejects(downloadVideo(options({ urls: [{ url: source }, { url: 'https://video.store.qq.com/second' }],
            fetchImpl: async () => { calls++; return value; } })), error => ['QUERY_FAILED', 'INVALID_RESPONSE'].includes(error.code));
        assert.equal(calls, 1);
    }
});

test('streaming overflow aborts and cancels the source without accepting a valid prefix', async () => {
    let cancelled = false, requestSignal;
    await assert.rejects(downloadVideo(options({ fetchImpl: async (_url, init) => {
        requestSignal = init.signal;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.concat([mp4, Buffer.from([0])])); },
            cancel() { cancelled = true; } }));
    } })), { code: 'INVALID_RESPONSE' });
    assert.equal(cancelled, true); assert.equal(requestSignal.aborted, true);
});

test('truncation, digest mismatch and invalid containers fail with no retry', async () => {
    const malformed = [mp4.subarray(0, mp4.length - 1), Buffer.from('<html>not a video</html>')];
    for (const bytes of malformed) {
        let calls = 0;
        await assert.rejects(downloadVideo(options({ expectedSize: bytes.length, expectedMd5: hash('md5', bytes),
            fetchImpl: async () => { calls++; return new Response(bytes); } })), { code: 'UNSUPPORTED' });
        assert.equal(calls, 1);
    }
    await assert.rejects(downloadVideo(options({ fetchImpl: async () => new Response(mp4.subarray(0, mp4.length - 1)) })), { code: 'INVALID_RESPONSE' });
    await assert.rejects(downloadVideo(options({ expectedMd5: '0'.repeat(32) })), { code: 'INVALID_RESPONSE' });
});

test('cancellation is bounded even when fetch ignores AbortSignal and never settles', async () => {
    const before = new AbortController(); before.abort(new Error(source));
    await assert.rejects(downloadVideo(options({ signal: before.signal, fetchImpl: () => assert.fail('Already cancelled') })), { code: 'EXPIRED' });
    const during = new AbortController();
    const waiting = downloadVideo(options({ signal: during.signal, fetchImpl: () => new Promise(() => {}) }));
    during.abort(new Error(source));
    await assert.rejects(waiting, error => error.code === 'EXPIRED' && !String(error).includes('PRIVATE'));
    await assert.rejects(downloadVideo(options({ expiresAt: Date.now() + 15, fetchImpl: () => new Promise(() => {}) })), { code: 'TIMEOUT' });
});

test('deadline bounds a stalled stream, cancels its reader and never exposes signed URLs', async t => {
    // Advance the deadline only after read() has entered the stalled source.
    // A wall-clock 15 ms limit can expire before fetch under suite contention,
    // which tests an unfetched request instead of reader cancellation.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    try {
        let cancelled = false, requestSignal, enterStream;
        const entered = new Promise(resolve => { enterStream = resolve; });
        const rejected = assert.rejects(downloadVideo(options({ expiresAt: Date.now() + 15, fetchImpl: async (_url, init) => {
            requestSignal = init.signal;
            return new Response(new ReadableStream({
                pull() { enterStream(); return new Promise(() => {}); }, cancel() { cancelled = true; }
            }, { highWaterMark: 0 }));
        } })), error => error.code === 'TIMEOUT' && !String(error).includes('PRIVATE'));
        await entered;
        assert.equal(cancelled, false); assert.equal(requestSignal.aborted, false);
        t.mock.timers.tick(15);
        await rejected;
        assert.equal(cancelled, true); assert.equal(requestSignal.aborted, true);
    } finally { t.mock.timers.reset(); }
    await assert.rejects(downloadVideo(options({ fetchImpl: () => { throw Object.assign(new Error(source), { code: 'INVALID_RESPONSE' }); } })),
        error => error.code === 'QUERY_FAILED' && !String(error).includes('PRIVATE') && !error.cause);
    await assert.rejects(downloadVideo(options({ fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new Error(source)); }
    })) })), error => error.code === 'QUERY_FAILED' && !String(error).includes('PRIVATE'));
});

test('a late fetch response is cancelled after the operation has already timed out', async () => {
    let resolveFetch, cancelled = false;
    await assert.rejects(downloadVideo(options({ expiresAt: Date.now() + 15,
        fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) })), { code: 'TIMEOUT' });
    resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
});
