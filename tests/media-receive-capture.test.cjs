'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const msfNative = require('../src/qq/msf-native.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const box = (kind, payload) => { const size = Buffer.alloc(4); size.writeUInt32BE(payload.length + 8); return Buffer.concat([size, Buffer.from(kind), payload]); };
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('mdat', Buffer.from([1, 2, 3])), box('moov', Buffer.from([0]))]);
const silk = Buffer.concat([Buffer.from('\x02#!SILK_V3'), Buffer.from([3, 0, 1, 2, 3])]);
const VIDEO_URL = 'https://multimedia.nt.qq.com/download?test=opaque';
function fixture(t, type = 'record', payload = silk, videoImpl) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'media-receive-')), directory = path.join(root, 'media'), cache = path.join(root, 'cache');
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(cache, { mode: 0o700 });
    const filename = path.join(cache, 'downloaded'), elementType = { image: 2, record: 4, video: 5 }[type];
    const details = { fileSize: String(payload.length), [type === 'video' ? 'videoMd5' : 'md5HexStr']: crypto.createHash('md5').update(payload).digest('hex'),
        ...(type === 'video' ? { fileUuid: 'video-uuid' } : {}) };
    let listener, downloads = 0, callback;
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getMsgsByMsgId(peer, ids) { return { result: 0, msgList: [{ ...peer, msgId: ids[0], elements: [
            { elementType, elementId: '234567890123456789', [{ image: 'picElement', record: 'pttElement', video: 'videoElement' }[type]]: details }
        ] }] }; },
        downloadRichMedia(params) {
            downloads++; assert.equal(capture.bus.listenerCount('mediaDownload'), 1, 'waiter must exist before native invocation');
            fs.writeFileSync(filename, payload, { mode: 0o600 });
            const value = { msgId: params.msgId, msgElementId: params.elementId, chatType: params.chatType, peerUid: params.peerUid,
                fileErrCode: '0', fileSrvErrCode: '0', filePath: filename, totalSize: String(payload.length) };
            if (callback) callback(value, listener); else listener.onRichMediaDownloadComplete(value);
            return { result: 0 };
        }
    };
    const session = { getMsgService: () => msg };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: directory, mediaTargetRoots: [cache] });
    const initialize = (uin = '123') => {
        capture.resetSession(session, { selfUin: uin, selfUid: 'u_' + uin, clientVer: TARGET_VERSION }); capture.ready = true; capture.attach();
    };
    initialize();
    // Video sources come from the native MSF NTV2RichMedia channel, not downloadRichMedia.
    if (type === 'video') {
        t.mock.method(msfNative, 'run', videoImpl || (async (cap, params) => {
            assert.equal(params.op, 'fetchVideoUrl');
            return { url: VIDEO_URL, domain: 'multimedia.nt.qq.com', via: 'native-msf' };
        }));
        t.mock.method(globalThis, 'fetch', async () => new Response(payload, { headers: { 'Content-Length': String(payload.length) } }));
    }
    t.after(() => { capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const params = { expectedEpoch: capture.epoch, peer: { chatType: 2, peerUid: '200' }, nativeId: '18446744073709551614', elementId: '234567890123456789' };
    return { capture, params, root, directory, cache, details, msg, session, initialize,
        callback(value) { callback = value; }, downloads: () => downloads, emit: value => listener.onRichMediaDownloadComplete(value) };
}

test('all typed downloads retain complete resource bytes and hashes', async t => {
    for (const [type, bytes, mime] of [['image', png, 'image/png'], ['record', silk, 'audio/silk'], ['video', mp4, 'video/mp4']]) {
        const f = fixture(t, type, bytes);
        const info = await f.capture.call('receiveMedia', f.params);
        assert.match(info.file, new RegExp('^fwd-' + type + '-[a-f0-9]{32}$'));
        assert.equal(info.mime, mime); assert.equal(info.size, bytes.length);
        assert.equal(info.md5, crypto.createHash('md5').update(bytes).digest('hex'));
        assert.deepEqual(fs.readFileSync(info.path), bytes);
        assert.equal((await f.capture.call('receiveMedia', f.params)).file, info.file);
        assert.equal(f.downloads(), type === 'video' ? 0 : 1);
        assert.equal(f.capture.bus.listenerCount('mediaDownload'), 0);
    }
});

test('media completion accepts numeric zero codes and rejects nonzero string acceptance results', async t => {
    const numeric = fixture(t);
    numeric.msg.downloadRichMedia = params => {
        const filename = path.join(numeric.cache, 'numeric-download');
        fs.writeFileSync(filename, silk, { mode: 0o600 });
        numeric.emit({ msgId: params.msgId, msgElementId: params.elementId, chatType: params.chatType,
            peerUid: params.peerUid, fileErrCode: 0, fileSrvErrCode: 0, filePath: filename, totalSize: silk.length });
        return { result: 0 };
    };
    assert.equal((await numeric.capture.call('receiveMedia', numeric.params)).type, 'record');

    const rejected = fixture(t);
    rejected.msg.downloadRichMedia = () => ({ result: '170013002' });
    await assert.rejects(rejected.capture.call('receiveMedia', rejected.params), { code: 'KERNEL_ERROR' });
    assert.equal(rejected.capture.bus.listenerCount('mediaDownload'), 0);
});

test('video receipt uses the native MSF URL and validates the full original bytes', async t => {
    let lookedUp = 0;
    const f = fixture(t, 'video', mp4, async (cap, params) => {
        lookedUp++; assert.equal(params.op, 'fetchVideoUrl'); assert.equal(params.fileUuid, 'video-uuid'); assert.equal(params.isGroup, true);
        return { url: VIDEO_URL, domain: 'multimedia.nt.qq.com', via: 'native-msf' };
    });
    const result = await f.capture.call('receiveMedia', f.params);
    assert.equal(result.type, 'video'); assert.deepEqual(fs.readFileSync(result.path), mp4);
    assert.equal(lookedUp, 1); assert.equal(f.downloads(), 0);
    assert.equal(f.capture.bus.listenerCount('mediaDownload'), 0);
});

test('native video URL failure stays bounded and never leaks a signed URL or fetches', async t => {
    const f = fixture(t, 'video', mp4, async () => {
        throw Object.assign(new Error('QQ rejected the video URL query (errorCode 253)'), { code: 'QUERY_FAILED' });
    });
    const diagnostics = []; f.capture.log = value => diagnostics.push(value);
    await assert.rejects(f.capture.call('receiveMedia', f.params), { code: 'QUERY_FAILED' });
    assert.equal(JSON.stringify(diagnostics).includes('rkey='), false);
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('a changed QQ session cannot fetch a video URL from the retired session', async t => {
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const f = fixture(t, 'video', mp4, async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = f.capture.call('receiveMedia', f.params);
    const rejected = assert.rejects(pending, { code: 'SESSION_CHANGED' });
    await entered; f.initialize('456'); release({ url: VIDEO_URL, domain: 'multimedia.nt.qq.com', via: 'native-msf' });
    await rejected; assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('download completion ignores wrong peer, message, element and chat before accepting its exact match', async t => {
    const f = fixture(t);
    f.callback((complete, listener) => {
        for (const override of [{ peerUid: '201' }, { msgId: '18446744073709551613' }, { msgElementId: 'other' }, { chatType: 1 }]) {
            listener.onRichMediaDownloadComplete({ ...complete, ...override, fileErrCode: '9' });
        }
        listener.onRichMediaDownloadComplete(complete);
    });
    assert.equal((await f.capture.call('receiveMedia', f.params)).type, 'record');
    assert.equal(f.downloads(), 1);
    const wrong = fixture(t);
    wrong.callback((complete, listener) => listener.onRichMediaDownloadComplete({ ...complete, peerUid: '201' }));
    await assert.rejects(wrong.capture.call('receiveMedia', wrong.params, { expiresAt: Date.now() + 100 }), { code: 'TIMEOUT' });
    assert.equal(fs.readdirSync(wrong.directory).length, 0); assert.equal(wrong.capture.bus.listenerCount('mediaDownload'), 0);
});

test('safe integer or decimal transfer sizes work and zero requires a matching declared complete size', async t => {
    for (const totalSize of [silk.length, String(silk.length), 0, '0']) {
        const f = fixture(t);
        f.callback((complete, listener) => listener.onRichMediaDownloadComplete({ ...complete, totalSize }));
        assert.equal((await f.capture.call('receiveMedia', f.params)).size, silk.length);
    }
    for (const size of [undefined, '0', String(silk.length + 1)]) {
        const f = fixture(t); f.details.fileSize = size;
        f.callback((complete, listener) => listener.onRichMediaDownloadComplete({ ...complete, totalSize: 0 }));
        await assert.rejects(f.capture.call('receiveMedia', f.params), { code: 'INVALID_RESPONSE' });
        assert.deepEqual(fs.readdirSync(f.directory), []);
    }
});

test('mismatched size, digest and native download errors cannot export a successful resource', async t => {
    for (const totalSize of [silk.length + 1, 'invalid', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const f = fixture(t);
        f.callback((complete, listener) => listener.onRichMediaDownloadComplete({ ...complete, totalSize }));
        await assert.rejects(f.capture.call('receiveMedia', f.params), { code: 'INVALID_RESPONSE' });
        assert.deepEqual(fs.readdirSync(f.directory), []);
    }
    const digest = fixture(t); digest.details.md5HexStr = 'a'.repeat(32);
    await assert.rejects(digest.capture.call('receiveMedia', digest.params), { code: 'INVALID_RESPONSE' });
    const declared = fixture(t); declared.details.fileSize = String(silk.length + 1);
    await assert.rejects(declared.capture.call('receiveMedia', declared.params), { code: 'INVALID_RESPONSE' });
    for (const key of ['fileErrCode', 'fileSrvErrCode']) {
        const f = fixture(t); f.callback((complete, listener) => listener.onRichMediaDownloadComplete({ ...complete, [key]: '5' }));
        await assert.rejects(f.capture.call('receiveMedia', f.params), { code: 'KERNEL_ERROR' });
    }
});

test('a partial MP4 fetched over the native video URL cannot become a complete video resource', async t => {
    const partial = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('mdat', Buffer.from([1, 2, 3]))]);
    const f = fixture(t, 'video', partial);
    await assert.rejects(f.capture.call('receiveMedia', f.params), { code: 'UNSUPPORTED' });
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('cancellation and account switches retire download waiters and ignore late media completions', async t => {
    for (const kind of ['cancel', 'session']) {
        const f = fixture(t); let started, complete, listener;
        const invoked = new Promise(resolve => { started = resolve; });
        f.callback((value, current) => { complete = value; listener = current; started(); });
        const controller = new AbortController();
        const pending = f.capture.call('receiveMedia', f.params, { signal: controller.signal });
        const rejected = assert.rejects(pending, { code: kind === 'cancel' ? 'EXPIRED' : 'SESSION_CHANGED' });
        await invoked;
        if (kind === 'cancel') controller.abort(); else f.initialize('456');
        await rejected;
        listener.onRichMediaDownloadComplete(complete);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(fs.readdirSync(f.directory), []);
        assert.equal(f.capture.bus.listenerCount('mediaDownload'), 0); assert.equal(f.capture.receivedMedia.size, 0);
    }
});
