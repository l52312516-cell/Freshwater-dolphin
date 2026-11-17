'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const codec = require('../src/onebot/codec.cjs');

const shareData = { url: 'https://example.invalid/story?x=1,2#位置', title: '分享测试 [甲]&乙', content: '说明\n 第二行', image: '' };
const musicCard = JSON.stringify({ app: 'com.tencent.structmsg', view: 'music', meta: { music: {
    title: 'Music', musicUrl: 'https://example.invalid/audio.mp3', jumpUrl: 'https://example.invalid/song' } } });
function fixture(t, selfUin = '123', options = {}) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'send-chain-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'media'), cache = path.join(root, 'native-cache');
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(cache, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, '文档.txt'), 'Freshwater 文件发送测试\n', { mode: 0o600 });
    let listener, serial = 900, mode = 'success', announce = () => {}, transform = null;
    const native = [], calls = [];
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getRichMediaFilePathForGuild(params) { return path.join(cache, params.fileName); },
        generateMsgUniqueId() { return String(++serial); },
        async sendMsg(zero, peer, elements) {
            assert.equal(zero, '0');
            native.push({ peer: structuredClone(peer), elements: structuredClone(elements) });
            const record = { ...peer, elements, msgId: String(serial), msgSeq: '10', clientSeq: '20',
                msgTime: String(Math.floor(Date.now() / 1000)), senderUin: selfUin, senderUid: 'u_' + selfUin,
                sendStatus: mode === 'failure' ? 0 : 2 };
            if (mode !== 'silent') listener.onMsgInfoListUpdate(transform ? transform(record) : [record]);
            announce();
            return { result: 0 };
        }
    };
    const session = { getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: directory, mediaTargetRoots: [cache], ...options });
    t.after(() => capture.close());
    function reset(uin = selfUin) {
        capture.resetSession(session, { selfUin: uin, selfUid: 'u_' + uin, clientVer: TARGET_VERSION });
        capture.ready = true; capture.attach();
    }
    reset();
    const store = new MessageStore({ directory: path.join(root, 'store') });
    let resolve = params => ({ uid: params.uid || 'u_' + params.uin, uin: params.uin || params.uid.slice(2) });
    const backend = { async call(method, params, context) {
        calls.push({ method, params });
        if (method === 'resolve') return resolve(params);
        return capture.call(method, params, context);
    } };
    const service = new OneBotService({ backend, store, mediaDirectory: directory, actionTimeoutMs: 2000, mediaActionTimeoutMs: 2000 });
    const send = (type, data, privateTarget = false, extra = {}) => service.action({ action: privateTarget ? 'send_private_msg' : 'send_group_msg',
        params: { ...(privateTarget ? { user_id: 456 } : { group_id: 200 }), message: [{ type, data }], ...extra }, echo: { audit: type } });
    return { root, directory, cache, capture, service, store, native, calls, session, backend, send, reset,
        resolveWith: value => { resolve = value; }, mode: value => { mode = value; },
        transform: value => { transform = value; }, nextDispatch: () => new Promise(done => { announce = done; }) };
}

test('file segments use the real prepared native cache, preserve names and return a confirmed persistent ID', async t => {
    const f = fixture(t);
    const response = await f.send('file', { file: '文档.txt', name: '发给群的文件.txt' });
    assert.equal(response.retcode, 0, response.message); assert.deepEqual(response.echo, { audit: 'file' });
    assert.equal(f.native.length, 1); assert.equal(f.native[0].peer.chatType, 2); assert.equal(f.native[0].peer.peerUid, '200');
    const element = f.native[0].elements[0];
    assert.equal(element.elementType, 3); assert.equal(element.fileElement.fileName, '发给群的文件.txt');
    assert.equal(element.fileElement.fileSize, String(fs.statSync(path.join(f.directory, '文档.txt')).size));
    assert.equal(path.dirname(element.fileElement.filePath), f.cache);
    assert.equal(f.store.get('123', response.data.message_id).record.msgId, '901');
    assert.equal(f.calls.find(call => call.method === 'prepareMedia').params.expectedEpoch, f.capture.epoch);
});

test('private file messages resolve QQ numbers to the exact kernel UID before native submission', async t => {
    const f = fixture(t);
    const response = await f.send('file', { file: '文档.txt' }, true);
    assert.equal(response.retcode, 0, response.message); assert.equal(f.native[0].peer.chatType, 1); assert.equal(f.native[0].peer.peerUid, 'u_456');
    assert.deepEqual(f.calls.find(call => call.method === 'resolve').params, { uin: '456', expectedEpoch: f.capture.epoch });
    assert.equal(f.native[0].elements[0].fileElement.fileName, '文档.txt');
});

test('private file sends stop on inconsistent UID mappings and unavailable input files', async t => {
    const f = fixture(t);
    f.resolveWith(() => ({ uin: '999', uid: 'u_456' }));
    assert.equal((await f.send('file', { file: '文档.txt' }, true)).retcode, 1404);
    assert.equal(f.native.length, 0);
    assert.equal(f.calls.some(call => call.method === 'prepareMedia'), false);
    const missing = await f.send('file', { file: '../outside.txt' });
    assert.notEqual(missing.retcode, 0); assert.equal(f.native.length, 0);
});

// Direct bridge calls below exercise the retained offline experiment. They do
// not enable the failed news template in the production OneBot action path.
async function experimentalShare(f, privateTarget = false) {
    const peer = { chatType: privateTarget ? 1 : 2, peerUid: privateTarget ? 'u_456' : '200' };
    const elements = await codec.toKernel([{ type: 'share', data: shareData }], {
        prepareShare: data => f.capture.call('prepareShare', { peer, data, expectedEpoch: f.capture.epoch })
    });
    return f.capture.call('sendMessage', { peer, elements, expectedEpoch: f.capture.epoch, timeoutMs: 100 });
}

test('offline experimental news shares preserve text and remove credentials before a simulated native send', async t => {
    const f = fixture(t);
    assert.equal(f.capture.state().capabilities.share, false);
    const response = await experimentalShare(f);
    assert.equal(response.sendStatus, 2);
    const element = f.native[0].elements[0], card = JSON.parse(element.arkElement.bytesData);
    assert.equal(element.elementType, 10); assert.equal(element.shareToken, undefined); assert.equal(element.musicToken, undefined);
    assert.equal(card.app, 'com.tencent.structmsg'); assert.equal(card.view, 'news');
    assert.deepEqual(card, { app: 'com.tencent.structmsg', view: 'news', prompt: shareData.title,
        meta: { news: { title: shareData.title, desc: shareData.content, jumpUrl: shareData.url, preview: '' } } });
    const privateResponse = await experimentalShare(f, true);
    assert.equal(privateResponse.sendStatus, 2); assert.equal(f.native[1].peer.peerUid, 'u_456');
});

test('production native sessions reject all share sends even when a backend falsely advertises support', async t => {
    const f = fixture(t);
    assert.equal(f.capture.state().capabilities.text, true);
    assert.equal(f.capture.state().capabilities.share, false);
    const original = f.backend.call.bind(f.backend);
    f.backend.call = async (method, ...args) => {
        const result = await original(method, ...args);
        return method === 'status' ? { ...result, capabilities: { ...result.capabilities, share: true } } : result;
    };
    const catalogue = await f.service.action({ action: 'get_capabilities' });
    const share = catalogue.data.segments.find(row => row.name === 'share');
    assert.equal(share.send, false); assert.equal(share.verification, 'unverified');
    for (const [action, target] of [['send_group_msg', { group_id: 200 }], ['send_private_msg', { user_id: 456 }],
        ['send_msg', { message_type: 'group', group_id: 200 }]]) {
        for (const message of [[{ type: 'share', data: shareData }],
            [{ type: 'text', data: { text: 'must not split' } }, { type: 'share', data: shareData }],
            codec.stringify([{ type: 'share', data: shareData }])]) {
            const response = await f.service.action({ action, params: { ...target, message }, echo: { disabled: true } });
            assert.equal(response.retcode, 1404); assert.deepEqual(response.echo, { disabled: true });
            assert.match(response.message, /could not render/);
        }
    }
    assert.equal(f.native.length, 0);
    assert.equal(f.calls.some(call => ['prepareShare', 'prepareMusic', 'sendMessage'].includes(call.method)), false);
    assert.equal(f.store.state('123').nextId, 1);
});

test('wrong correlation, peer and sender callbacks cannot replace the correct file confirmation', async t => {
    const f = fixture(t);
    f.transform(record => [{ ...record, guildId: 'other', msgId: 'wrong-correlation' },
        { ...record, peerUid: '201', msgId: 'wrong-peer' }, { ...record, senderUin: '999', msgId: 'wrong-sender' }, record]);
    const response = await f.send('file', { file: '文档.txt' });
    assert.equal(response.retcode, 0, response.message);
    assert.equal(f.store.get('123', response.data.message_id).record.msgId, '901');
    assert.equal(f.native.length, 1);
});

test('accepted but unconfirmed file actions time out without resending', async t => {
    for (const [type, data] of [['file', { file: '文档.txt' }]]) {
        const f = fixture(t); f.mode('silent'); f.service.actionTimeoutMs = 100; f.service.mediaActionTimeoutMs = 100;
        const dispatched = f.nextDispatch();
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
        try {
            const pending = f.send(type, data);
            await Promise.race([dispatched, pending.then(response => assert.fail('Send finished before native dispatch: ' + JSON.stringify(response)))]);
            assert.equal(f.native.length, 1);
            t.mock.timers.tick(101);
            const response = await pending;
            assert.equal(response.retcode, 1504); assert.deepEqual(response.echo, { audit: type });
            assert.equal(f.native.length, 1); assert.equal(f.capture.bus.listenerCount('sent'), 0);
            assert.equal(f.store.state('123').nextId, 1);
        } finally { t.mock.timers.reset(); }
    }
});

test('explicit QQ file send failure never allocates a successful message ID or repeats submission', async t => {
    for (const [type, data] of [['file', { file: '文档.txt' }]]) {
        const f = fixture(t); f.mode('failure');
        const response = await f.send(type, data);
        assert.notEqual(response.retcode, 0); assert.equal(f.native.length, 1);
        assert.equal(f.store.state('123').nextId, 1);
    }
});

test('mixed file and video chains and malformed share fields are rejected before any preparation', async t => {
    const f = fixture(t);
    for (const message of [
        [{ type: 'text', data: { text: 'must not split' } }, { type: 'file', data: { file: '文档.txt' } }],
        [{ type: 'video', data: { file: 'clip.mp4' } }, { type: 'text', data: { text: 'must not split' } }],
        [{ type: 'file', data: { file: '文档.txt' } }, { type: 'video', data: { file: 'clip.mp4' } }],
        [{ type: 'share', data: shareData }, { type: 'share', data: { ...shareData, url: 'javascript:alert(1)' } }],
        [{ type: 'share', data: { ...shareData, musicToken: 'forged' } }],
        [{ type: 'json', data: { data: musicCard } }]
    ]) {
        const response = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message } });
        assert.notEqual(response.retcode, 0);
    }
    assert.equal(f.native.length, 0);
    assert.equal(f.calls.some(call => ['prepareMedia', 'prepareMusic', 'prepareShare', 'sendMessage'].includes(call.method)), false);
});

test('share credentials are account, peer, content and epoch bound and consumed once', async t => {
    const f = fixture(t), other = fixture(t, '789'), peer = { chatType: 2, peerUid: '200' };
    const prepare = () => f.capture.call('prepareShare', { peer, data: shareData, expectedEpoch: f.capture.epoch });
    const send = (element, params = {}) => f.capture.call('sendMessage', { peer, expectedEpoch: f.capture.epoch, elements: [element], ...params });
    const element = await prepare();
    await assert.rejects(send(element, { peer: { chatType: 2, peerUid: '201' } }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send({ ...element, shareToken: 'forged' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send({ ...element, musicToken: 'music-token' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send({ ...element, arkElement: { ...element.arkElement, bytesData: element.arkElement.bytesData + ' ' } }), { code: 'INVALID_PARAMS' });
    await assert.rejects(send(element, { elements: [element, element] }), { code: 'INVALID_PARAMS' });
    await assert.rejects(other.capture.call('sendMessage', { peer, expectedEpoch: other.capture.epoch, elements: [element] }), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 0); assert.equal(other.native.length, 0);
    await send(element); assert.equal(f.native.length, 1);
    await assert.rejects(send(element), { code: 'INVALID_PARAMS' });
    const previous = await prepare(); f.reset();
    await assert.rejects(send(previous), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 1);
});

test('share credentials cannot authorize music bytes, and music credentials cannot authorize news cards', async t => {
    const f = fixture(t), peer = { chatType: 2, peerUid: '200' };
    const share = await f.capture.call('prepareShare', { peer, data: shareData, expectedEpoch: f.capture.epoch });
    const music = await f.capture.call('prepareMusic', { peer, card: musicCard, expectedEpoch: f.capture.epoch });
    for (const element of [{ ...share, arkElement: { ...share.arkElement, bytesData: musicCard } },
        { ...music, arkElement: { ...music.arkElement, bytesData: share.arkElement.bytesData } },
        { ...share, shareToken: undefined, musicToken: music.musicToken }]) {
        await assert.rejects(f.capture.call('sendMessage', { peer, elements: [element], expectedEpoch: f.capture.epoch }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.native.length, 0);
});

test('files modified after preparation are rejected before native submission', async t => {
    const f = fixture(t), peer = { chatType: 2, peerUid: '200' };
    const element = await f.capture.call('prepareMedia', { type: 'file', file: '文档.txt', expectedEpoch: f.capture.epoch });
    fs.writeFileSync(element.fileElement.filePath, 'tampered after preparation');
    await assert.rejects(f.capture.call('sendMessage', { peer, elements: [element], expectedEpoch: f.capture.epoch }), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 0);
});

test('file basename restrictions agree for message sends, upload actions, native preparation and final dispatch', async t => {
    const f = fixture(t), peer = { chatType: 2, peerUid: '200' };
    const names = ['.', '..', 'bad\n.txt', 'bad\x7f.txt', 'bad\x85.txt', 'bad\x9f.txt'];
    for (const name of names) {
        for (const privateTarget of [false, true]) {
            assert.equal((await f.send('file', { file: '文档.txt', name }, privateTarget)).retcode, 1400);
            const response = await f.service.action({ action: privateTarget ? 'upload_private_file' : 'upload_group_file',
                params: { ...(privateTarget ? { user_id: 456 } : { group_id: 200 }), file: '文档.txt', name } });
            assert.equal(response.retcode, 1400);
        }
        await assert.rejects(f.capture.call('prepareMedia', { type: 'file', file: '文档.txt', name, expectedEpoch: f.capture.epoch }),
            { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.calls.some(call => ['prepareMedia', 'sendMessage'].includes(call.method)), false);
    const element = await f.capture.call('prepareMedia', { type: 'file', file: '文档.txt', expectedEpoch: f.capture.epoch });
    for (const fileName of names) {
        await assert.rejects(f.capture.call('sendMessage', { peer, expectedEpoch: f.capture.epoch,
            elements: [{ ...element, fileElement: { ...element.fileElement, fileName } }] }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.native.length, 0);
});

function videoFixture(t) {
    // Processor output is injected here; the production MP4 decoder and
    // thumbnail extractor have separate parser and process-boundary tests.
    const bytes = Buffer.from('fixed-test-video-processor-output'), thumb = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    const md5 = input => crypto.createHash('md5').update(input).digest('hex');
    const prepared = { bytes, filename: 'clip.mp4', md5: md5(bytes), width: 320, height: 180, durationSeconds: 2.5,
        fileFormat: 2, thumbnail: { bytes: thumb, md5: md5(thumb), width: 1, height: 1, extension: 'png' } };
    const options = { videoProcessor: { available: () => true, async prepare(file) {
        assert.equal(file, 'clip.mp4'); return { ...prepared, bytes: Buffer.from(bytes), thumbnail: { ...prepared.thumbnail, bytes: Buffer.from(thumb) } };
    } } };
    const f = fixture(t, '123', options);
    f.session.getMsgService().getRichMediaFilePathForGuild = params => {
        const directory = path.join(f.cache, 'Ori'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        return path.join(directory, params.fileName);
    };
    fs.writeFileSync(path.join(f.directory, 'clip.mp4'), bytes, { mode: 0o600 });
    return { ...f, bytes, thumbnail: thumb, prepared };
}

test('video segments prepare an account-local video and thumbnail and reconstruct the native thumbnail Map', async t => {
    const f = videoFixture(t);
    const group = await f.send('video', { file: 'clip.mp4' });
    assert.equal(group.retcode, 0, group.message); assert.deepEqual(group.echo, { audit: 'video' });
    const element = f.native[0].elements[0];
    assert.equal(element.elementType, 5);
    assert.equal(element.videoElement.videoMd5, f.prepared.md5);
    assert.equal(element.videoElement.fileTime, 2.5);
    for (const key of ['fileFormat', 'fileWidth', 'fileHeight']) assert.equal(key in element.videoElement, false);
    assert.equal(element.videoElement.fileSize, String(f.bytes.length));
    assert.equal(element.videoElement.thumbMd5, f.prepared.thumbnail.md5);
    assert.ok(element.videoElement.thumbPath instanceof Map);
    assert.equal(path.dirname(element.videoElement.filePath), path.join(f.cache, 'Ori'));
    assert.equal(path.dirname(element.videoElement.thumbPath.get(0)), path.join(f.cache, 'Thumb'));
    assert.equal(path.extname(element.videoElement.thumbPath.get(0)), '.png');
    assert.equal(element.videoElement.thumbWidth, 1); assert.equal(element.videoElement.thumbHeight, 1);
    assert.deepEqual(f.capture.preparedMedia.get(element.videoElement.filePath).metadata,
        { width: 320, height: 180, durationSeconds: 2.5, fileFormat: 2 });
    assert.deepEqual(fs.readFileSync(element.videoElement.filePath), f.bytes);
    assert.deepEqual(fs.readFileSync(element.videoElement.thumbPath.get(0)), f.thumbnail);
    const privateResult = await f.send('video', { file: 'clip.mp4' }, true);
    assert.equal(privateResult.retcode, 0, privateResult.message); assert.equal(f.native[1].peer.peerUid, 'u_456');
    assert.equal(f.calls.find(call => call.method === 'prepareMedia' && call.params.type === 'video').params.expectedEpoch, f.capture.epoch);
});

test('video preparation refuses unverified native layouts and linked thumbnail directories without dispatch', async t => {
    const f = videoFixture(t), service = f.session.getMsgService();
    const prepare = () => f.capture.call('prepareMedia', { type: 'video', file: 'clip.mp4', expectedEpoch: f.capture.epoch });
    service.getRichMediaFilePathForGuild = params => path.join(f.cache, params.fileName);
    await assert.rejects(prepare(), { code: 'UNSUPPORTED' });
    service.getRichMediaFilePathForGuild = params => {
        fs.mkdirSync(path.join(f.cache, 'Ori'), { mode: 0o700 }); return path.join(f.cache, 'Ori', params.fileName);
    };
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
    try { fs.symlinkSync(outside, path.join(f.cache, 'Thumb'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
    await assert.rejects(prepare(), { code: 'INVALID_RESPONSE' });
    assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.native.length, 0);
});

test('video upload rejects changed metadata, source bytes and thumbnail bytes before dispatch', async t => {
    const f = videoFixture(t), peer = { chatType: 2, peerUid: '200' };
    const prepare = () => f.capture.call('prepareMedia', { type: 'video', file: 'clip.mp4', expectedEpoch: f.capture.epoch });
    const send = element => f.capture.call('sendMessage', { peer, elements: [element], expectedEpoch: f.capture.epoch });
    const element = await prepare();
    for (const change of [{ fileTime: 99 }, { fileWidth: 999 }, { videoMd5: '0'.repeat(32) },
        { thumbPath: { 0: path.join(f.root, 'outside.jpg') } }, { fileSize: '1' }]) {
        await assert.rejects(send({ ...element, videoElement: { ...element.videoElement, ...change } }), { code: 'INVALID_PARAMS' });
    }
    fs.writeFileSync(element.videoElement.thumbPath[0], 'changed-thumbnail');
    await assert.rejects(send(element), { code: 'INVALID_PARAMS' });
    const again = await prepare(); fs.writeFileSync(again.videoElement.filePath, 'changed-video');
    await assert.rejects(send(again), { code: 'INVALID_PARAMS' });
    assert.equal(f.native.length, 0);
});

test('a submitted video with no confirmation times out exactly once without allocating a successful ID', async t => {
    const f = videoFixture(t); f.mode('silent'); f.service.mediaActionTimeoutMs = 100;
    const dispatched = f.nextDispatch();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const pending = f.send('video', { file: 'clip.mp4' });
        await Promise.race([dispatched, pending.then(response => assert.fail('Send finished before native dispatch: ' + JSON.stringify(response)))]);
        t.mock.timers.tick(101);
        assert.equal((await pending).retcode, 1504); assert.equal(f.native.length, 1);
        assert.equal(f.capture.bus.listenerCount('sent'), 0); assert.equal(f.store.state('123').nextId, 1);
    } finally { t.mock.timers.reset(); }
});
