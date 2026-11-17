'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('../src/qq/media.cjs');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');

const temp = path.resolve(__dirname, '../work/temp');
fs.mkdirSync(temp, { recursive: true });
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(temp, 'media-'));
    const root = path.join(directory, 'media');
    const cache = path.join(directory, 'native-cache');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(cache, { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'pixel.png'), tinyPng, { mode: 0o600 });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, root, cache };
}

test('media input is bounded to the account directory and image bytes determine actual type', t => {
    const { directory, root } = fixture(t);
    const image = media.readImage(root, 'pixel.png');
    assert.equal(image.width, 1); assert.equal(image.height, 1); assert.equal(image.picType, 1001);
    fs.writeFileSync(path.join(root, 'text.png'), 'this is not an image');
    assert.throws(() => media.readImage(root, 'text.png'), { code: 'UNSUPPORTED' });
    fs.writeFileSync(path.join(directory, 'outside.png'), tinyPng);
    assert.throws(() => media.readImage(root, '../outside.png'), { code: 'INVALID_PARAMS' });
    assert.throws(() => media.readImage(root, 'https://example.test/image.png'), { code: 'UNSUPPORTED' });
    assert.throws(() => media.readImage(root, 'base64://AAAA'), { code: 'UNSUPPORTED' });
    assert.throws(() => media.imageInfo(Buffer.from('GIF89a\0\0\0\0')), { code: 'UNSUPPORTED' });
    if (process.platform !== 'win32') {
        fs.symlinkSync(path.join(directory, 'outside.png'), path.join(root, 'escape.png'));
        assert.throws(() => media.readImage(root, 'escape.png'), { code: 'INVALID_PARAMS' });
    }
});

test('canonical base64 images decode without filesystem writes and retain per-account root validation', t => {
    const { root, directory } = fixture(t);
    const input = 'base64://' + tinyPng.toString('base64');
    const before = fs.readdirSync(root);
    const image = media.readImage(root, input);
    assert.deepEqual(image.bytes, tinyPng);
    assert.equal(image.filename, 'image.png'); assert.equal(image.extension, 'png');
    assert.equal(image.width, 1); assert.equal(image.height, 1);
    assert.equal(image.md5, crypto.createHash('md5').update(tinyPng).digest('hex'));
    assert.deepEqual(fs.readdirSync(root), before);
    assert.throws(() => media.readImage(null, input), { code: 'UNSUPPORTED' });
    const nonDirectory = path.join(directory, 'not-a-directory'); fs.writeFileSync(nonDirectory, 'x');
    assert.throws(() => media.readImage(nonDirectory, input), { code: 'INVALID_CONFIG' });
    // File uploads still require an actual owned local file; image support does not broaden them.
    assert.throws(() => media.readLocal(root, input), { code: 'UNSUPPORTED' });
});

test('base64 images require canonical bounded encoding and a supported image payload', t => {
    const { root } = fixture(t);
    for (const input of ['base64://', 'base64://A', 'base64://AA=', 'base64://AA===', 'base64://AA==\n',
        'base64://A A=', 'base64://AA-_', 'base64://Zh==', 'base64://Zm9=', 'https://example.test/pixel.png']) {
        assert.throws(() => media.decodeBase64Image(input), { code: 'INVALID_PARAMS' });
    }
    for (const bytes of [Buffer.from('<svg/>'), Buffer.from('not an image')]) {
        assert.throws(() => media.readImage(root, 'base64://' + bytes.toString('base64')), { code: 'UNSUPPORTED' });
    }
    const oversized = 'base64://' + 'A'.repeat(4 * Math.ceil((media.MAX_IMAGE_BYTES + 3) / 3));
    assert.throws(() => media.decodeBase64Image(oversized), { code: 'INVALID_PARAMS' });
    const paddingBoundary = 'base64://' + 'A'.repeat(4 * Math.ceil(media.MAX_IMAGE_BYTES / 3));
    assert.throws(() => media.decodeBase64Image(paddingBoundary), { code: 'INVALID_PARAMS' });
    assert.deepEqual(fs.readdirSync(root), ['pixel.png']);
});

test('base64 image metadata supports PNG, JPEG and GIF without trusting a filename suffix', () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);
    for (const [bytes, extension] of [[tinyPng, 'png'], [jpeg, 'jpg'], [gif, 'gif']]) {
        const decoded = media.decodeBase64Image('base64://' + bytes.toString('base64'));
        assert.equal(decoded.extension, extension); assert.equal(decoded.width, 1); assert.equal(decoded.height, 1);
        assert.equal(decoded.filename, 'image.' + extension);
    }
});

test('native cache writes reject unrelated destinations and verify prepared contents', t => {
    const { directory, root, cache } = fixture(t);
    const image = media.readImage(root, 'pixel.png');
    const target = media.copyToNative(path.join(cache, 'pixel.png'), [cache], image.bytes);
    const expected = { size: image.bytes.length, md5: image.md5 };
    assert.doesNotThrow(() => media.verifyPrepared(target, [cache], expected));
    fs.writeFileSync(target, Buffer.alloc(image.bytes.length));
    assert.throws(() => media.verifyPrepared(target, [cache], expected), { code: 'INVALID_PARAMS' });
    assert.throws(() => media.copyToNative(path.join(directory, 'outside.png'), [cache], image.bytes), { code: 'INVALID_RESPONSE' });
    assert.equal(fs.existsSync(path.join(directory, 'outside.png')), false);
});

test('native media preparation never claims upload success and sending still needs status 2', async t => {
    const { root, cache } = fixture(t);
    let listener, sends = 0, confirms = true, onDispatch = () => {};
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getRichMediaFilePathForGuild(params) {
            assert.equal(params.elementType, 2); assert.equal(params.needCreate, true);
            return path.join(cache, params.fileName);
        },
        generateMsgUniqueId() { return '999'; },
        async sendMsg(_id, peer, elements) {
            sends++;
            listener.onMsgInfoListUpdate([{ ...peer, elements, msgId: '1000', senderUin: '123', sendStatus: confirms ? 2 : 3 }]);
            onDispatch();
            return { result: 0 };
        }
    };
    const session = { getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: root, mediaTargetRoots: [cache] });
    t.after(() => capture.close());
    capture.resetSession(session, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION }); capture.ready = true; capture.attach();
    const prepared = await capture.call('prepareMedia', { type: 'image', file: 'pixel.png', expectedEpoch: capture.epoch });
    assert.equal(sends, 0);
    assert.equal(prepared.picElement.picWidth, 1);
    const peer = { chatType: 2, peerUid: '200' };
    const sent = await capture.call('sendMessage', { peer, elements: [prepared], expectedEpoch: capture.epoch });
    assert.equal(sent.sendStatus, 2);
    confirms = false;
    const dispatched = new Promise(resolve => { onDispatch = resolve; });
    // Freeze the deadline while correlation and file validation execute, then
    // advance it only after the native send returned status 3 (pending).
    // CPU contention must not turn this confirmation-timeout case into an
    // unrelated expiry before submission.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const pending = capture.call('sendMessage', { peer, elements: [prepared], expectedEpoch: capture.epoch },
            { expiresAt: Date.now() + 25 });
        const rejected = assert.rejects(pending, { code: 'TIMEOUT' });
        await dispatched;
        assert.equal(sends, 2);
        t.mock.timers.tick(25);
        await rejected;
    } finally { t.mock.timers.reset(); }
    assert.equal(sends, 2);
    fs.writeFileSync(prepared.picElement.sourcePath, Buffer.alloc(tinyPng.length));
    await assert.rejects(capture.call('sendMessage', { peer, elements: [prepared], expectedEpoch: capture.epoch }), { code: 'INVALID_PARAMS' });
    assert.equal(sends, 2);
});

test('OneBot validates all image inputs before preparing or submitting a mixed message', async t => {
    const { root, directory } = fixture(t);
    const state = { ready: true, epoch: 'epoch', self: { uin: '123', uid: 'u_123' }, capabilities: { image: true } };
    const calls = [];
    const backend = { async call(method, params) {
        calls.push({ method, params });
        if (method === 'status') return state;
        if (method === 'prepareMedia') return { elementType: 2, picElement: { sourcePath: path.join(root, params.file) } };
        if (method === 'sendMessage') return { chatType: 2, peerUid: '200', msgId: '900', senderUin: '123', elements: params.elements };
        throw new Error('Unexpected method');
    } };
    const service = new OneBotService({ backend, mediaDirectory: root, store: new MessageStore({ directory: path.join(directory, 'store') }) });
    const invalid = await service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
        { type: 'image', data: { file: 'pixel.png' } }, { type: 'image', data: { file: '../outside.png' } }
    ] } });
    assert.equal(invalid.retcode, 1400);
    assert.equal(calls.some(item => item.method === 'prepareMedia' || item.method === 'sendMessage'), false);
    const accepted = await service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
        { type: 'text', data: { text: ' image\n' } }, { type: 'image', data: { file: 'pixel.png', summary: 'A pixel' } }
    ] } });
    assert.equal(accepted.retcode, 0);
    assert.equal(calls.filter(item => item.method === 'sendMessage').length, 1);
    assert.equal(calls.find(item => item.method === 'prepareMedia').params.expectedEpoch, 'epoch');
    assert.deepEqual(calls.find(item => item.method === 'sendMessage').params.elements.map(item => item.elementType), [1, 2]);
});

test('received resources use account-local opaque IDs and signatures bind account, ID and expiry', t => {
    const { root, directory } = fixture(t);
    const resource = media.exportImage(root, { bytes: tinyPng, ...media.imageInfo(tinyPng) });
    assert.match(resource.file, /^fwd-image-[a-f0-9]{32}$/);
    assert.equal(resource.mime, 'image/png');
    assert.equal(resource.size, tinyPng.length);
    assert.equal(media.resourceInfo(root, resource.file).width, 1);
    assert.throws(() => media.resourceInfo(root, '../pixel.png'), { code: 'INVALID_PARAMS' });
    const keyFile = path.join(directory, 'media-key');
    const secret = Buffer.alloc(32, 7);
    fs.writeFileSync(keyFile, secret.toString('hex') + '\n', { mode: 0o600 });
    const options = { mediaBaseUrl: 'https://example.test/media/account-a', mediaSigningKeyFile: keyFile, profileId: 'account-a' };
    const url = new URL(media.signedImageUrl(options, resource.file, 1000000));
    assert.equal(url.searchParams.get('expires'), '1300');
    const expected = crypto.createHmac('sha256', secret).update('account-a\n' + resource.file + '\n1300').digest('hex');
    assert.equal(url.searchParams.get('signature'), expected);
    assert.notEqual(media.signedImageUrl({ ...options, profileId: 'account-b' }, resource.file, 1000000), url.href);
    assert.throws(() => media.signedImageUrl({}, resource.file), { code: 'UNSUPPORTED' });
});

test('received image conversion preserves mixed segment order and uses a marked placeholder without a resource', async t => {
    const { root, directory } = fixture(t);
    const keyFile = path.join(directory, 'signing-key');
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const resource = media.exportImage(root, { bytes: tinyPng, ...media.imageInfo(tinyPng) });
    const state = { ready: true, epoch: 'epoch', self: { uin: '123', uid: 'u_123' }, capabilities: { imageReceive: true } };
    let found = true;
    const backend = { async call(method, params) {
        if (method === 'status') return state;
        if (method === 'receiveMedia') {
            assert.ok(['900', '901'].includes(params.nativeId)); assert.equal(params.elementId, 'element-2');
            if (!found) throw Object.assign(new Error('Not downloaded'), { code: 'NOT_FOUND' });
            return resource;
        }
        if (method === 'imageInfo') return media.resourceInfo(root, params.file);
        throw new Error('Unexpected method ' + method);
    } };
    const service = new OneBotService({ backend, mediaDirectory: root, mediaBaseUrl: 'https://example.test/media/profile-a',
        mediaSigningKeyFile: keyFile, profileId: 'profile-a', store: new MessageStore({ directory: path.join(directory, 'store') }) });
    const record = { chatType: 1, peerUid: 'u_456', senderUid: 'u_456', senderUin: '456', msgId: '900',
        msgTime: String(Math.floor(Date.now() / 1000)), elements: [
            { elementType: 1, textElement: { content: 'before\n', atType: 0 } },
            { elementType: 2, elementId: 'element-2', picElement: { summary: 'One pixel' } },
            { elementType: 1, textElement: { content: ' after', atType: 0 } }
        ] };
    const event = await service.event({ kind: 'message', epoch: 'epoch', selfUin: '123', record });
    assert.deepEqual(event.message.map(item => item.type), ['text', 'image', 'text']);
    assert.equal(event.message[0].data.text, 'before\n');
    assert.equal(event.message[1].data.file, resource.file);
    assert.match(event.message[1].data.url, /signature=/);
    const queried = await service.action({ action: 'get_image', params: { file: resource.file } });
    assert.equal(queried.retcode, 0); assert.equal(queried.data.size, tinyPng.length);
    assert.equal((await service.action({ action: 'get_image', params: { file: '../pixel.png' } })).retcode, 1400);
    found = false;
    const partial = await service.event({ kind: 'message', epoch: 'epoch', selfUin: '123', record: { ...record, msgId: '901' } });
    assert.deepEqual(partial.message, [{ type: 'text', data: { text: 'before\n' } },
        { type: 'text', data: { text: '[QQ媒体暂不可读取：类型2]' } }, { type: 'text', data: { text: ' after' } }]);
    assert.equal(partial._freshwater.content_status, 'partial');
    assert.deepEqual(partial._freshwater.issues, [{ element_index: 1, element_type: 2, media_type: 'image', reason: 'media_unavailable' }]);
});

test('QQ image receipt re-queries exact native identity and imports only this account downloaded bytes', async t => {
    const { root, cache, directory } = fixture(t);
    const downloaded = path.join(cache, 'downloaded.png');
    fs.writeFileSync(downloaded, tinyPng);
    let sourcePath = downloaded;
    const msg = { getMsgsByMsgId: async (peer, ids) => ({ result: 0, msgList: [{ ...peer, msgId: ids[0], elements: [
        { elementType: 2, elementId: 'image-element', picElement: { sourcePath } }
    ] }] }) };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: root, mediaTargetRoots: [cache] });
    t.after(() => capture.close());
    capture.resetSession({ getMsgService: () => msg }, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION }); capture.ready = true;
    const params = { peer: { chatType: 2, peerUid: '200' }, nativeId: '900', elementId: 'image-element', expectedEpoch: capture.epoch };
    const info = await capture.call('receiveMedia', params);
    assert.match(info.file, media.RESOURCE);
    assert.equal(info.width, 1);
    assert.equal((await capture.call('receiveMedia', params)).file, info.file);
    await assert.rejects(capture.call('receiveMedia', { ...params, elementId: 'another' }), { code: 'NOT_FOUND' });
    sourcePath = path.join(directory, 'outside.png'); fs.writeFileSync(sourcePath, tinyPng);
    await assert.rejects(capture.call('receiveMedia', { ...params, nativeId: '901' }), { code: 'INVALID_RESPONSE' });
    sourcePath = path.join(cache, 'not-downloaded.png');
    await assert.rejects(capture.call('receiveMedia', { ...params, nativeId: '902' }), { code: 'NOT_FOUND' });
});

test('native image downloads install their waiter before QQ callbacks and require a matching successful complete transfer', async t => {
    const { root, cache } = fixture(t);
    const filename = path.join(cache, 'downloaded.png');
    let listener, downloads = 0, fail = false, confirm = true;
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getMsgsByMsgId: async (peer, ids) => ({ result: 0, msgList: [{ ...peer, msgId: ids[0], elements: [
            { elementType: 2, elementId: 'element', picElement: { md5HexStr: crypto.createHash('md5').update(tinyPng).digest('hex') } }
        ] }] }),
        downloadRichMedia(params) {
            downloads++; assert.equal(params.filePath, ''); assert.equal(params.peerUid, '200');
            fs.writeFileSync(filename, tinyPng);
            const completed = { msgId: params.msgId, msgElementId: params.elementId, chatType: 2,
                fileErrCode: fail ? '1' : '0', fileSrvErrCode: '0', filePath: filename, totalSize: String(tinyPng.length) };
            listener.onRichMediaDownloadComplete({ ...completed, msgElementId: 'unrelated' });
            if (confirm) listener.onRichMediaDownloadComplete(completed);
        }
    };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: root, mediaTargetRoots: [cache] });
    t.after(() => capture.close());
    capture.resetSession({ getMsgService: () => msg }, { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION }); capture.ready = true; capture.attach();
    const params = { peer: { chatType: 2, peerUid: '200' }, nativeId: '900', elementId: 'element', expectedEpoch: capture.epoch };
    const info = await capture.call('receiveMedia', params);
    assert.equal(info.size, tinyPng.length); assert.equal(downloads, 1);
    fail = true;
    await assert.rejects(capture.call('receiveMedia', { ...params, nativeId: '901' }), { code: 'KERNEL_ERROR' });
    confirm = false;
    await assert.rejects(capture.call('receiveMedia', { ...params, nativeId: '902' }, { expiresAt: Date.now() + 25 }), { code: 'TIMEOUT' });
    assert.equal(downloads, 3); assert.equal(capture.bus.listenerCount('mediaDownload'), 0);
});

test('local file uploads remain within the account root and return only confirmed native message IDs', async t => {
    const { root, cache, directory } = fixture(t);
    fs.writeFileSync(path.join(root, 'document.txt'), 'File upload test\n');
    let listener, sends = 0, success = true;
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getRichMediaFilePathForGuild(params) { assert.equal(params.elementType, 3); return path.join(cache, params.fileName); },
        generateMsgUniqueId() { return '999'; },
        async sendMsg(_id, peer, elements) {
            sends++; assert.equal(elements[0].elementType, 3); assert.equal(elements[0].fileElement.fileName, 'report.txt');
            listener.onMsgInfoListUpdate([{ ...peer, msgId: String(1000 + sends), senderUin: '123', sendStatus: success ? 2 : 3,
                elements: elements.map(item => ({ ...item, fileElement: { ...item.fileElement, fileUuid: 'actual-file-id' } })) }]);
            return { result: 0 };
        }
    };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: root, mediaTargetRoots: [cache] });
    t.after(() => capture.close());
    capture.resetSession({ getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) },
        { selfUin: '123', selfUid: 'u_123', clientVer: TARGET_VERSION }); capture.ready = true; capture.attach();
    const service = new OneBotService({ backend: capture, mediaDirectory: root,
        actionTimeoutMs: 1500, store: new MessageStore({ directory: path.join(directory, 'store') }) });
    const request = { action: 'upload_group_file', params: { group_id: 200, file: 'document.txt', name: 'report.txt' } };
    const result = await service.action(request);
    assert.equal(result.retcode, 0); assert.equal(result.data.file_id, 'actual-file-id'); assert.ok(result.data.message_id > 0);
    assert.equal(sends, 1);
    const invalid = await service.action({ ...request, params: { ...request.params, name: '../escape' } });
    assert.equal(invalid.retcode, 1400); assert.equal(sends, 1);
    const escaped = await service.action({ ...request, params: { ...request.params, file: '../outside.txt' } });
    assert.equal(escaped.retcode, 1400); assert.equal(sends, 1);
    success = false;
    service.actionTimeoutMs = 100;
    service.mediaActionTimeoutMs = 1500;
    const unknown = await service.action(request);
    assert.equal(unknown.retcode, 1504); assert.equal(sends, 2);
});

test('file upload success requires a real resource ID and an incomplete confirmed receipt never returns null or retries', async t => {
    const { root } = fixture(t); fs.writeFileSync(path.join(root, 'actual.txt'), 'actual file bytes');
    const state = { ready: true, online: true, epoch: 'file-resource-epoch', self: { uin: '123', uid: 'u_self' }, capabilities: { file: true } };
    let resourceId, sends = 0, mappings = 0;
    const service = new OneBotService({ mediaDirectory: root, store: { remember: () => ({ id: ++mappings }) }, backend: { async call(method, params) {
        if (method === 'status') return state;
        if (method === 'resolve') return { uin: params.uin, uid: 'u_destination' };
        if (method === 'prepareMedia') return { elementType: 3, fileElement: { fileName: 'actual.txt' } };
        assert.equal(method, 'sendMessage'); sends++;
        return { ...params.peer, msgId: String(1000 + sends), senderUin: '123', senderUid: 'u_self', sendStatus: 2,
            elements: [{ elementType: 3, fileElement: { fileName: 'actual.txt', ...(resourceId === undefined ? {} : { fileUuid: resourceId }) } }] };
    } } });
    for (const action of ['upload_group_file', 'upload_private_file']) {
        const params = { [action === 'upload_group_file' ? 'group_id' : 'user_id']: 200, file: 'actual.txt' };
        for (resourceId of [undefined, null, '', '  ', 7, 'x\n', 'x'.repeat(1025)]) {
            const before = sends, result = await service.action({ action, params });
            assert.equal(result.retcode, 1500); assert.equal(result.data, null); assert.equal(sends, before + 1);
            assert.match(result.message, /no exact resource ID.*not retried/);
        }
        resourceId = 'actual-native-file-resource';
        const value = await service.action({ action, params }); assert.equal(value.retcode, 0);
        assert.equal(value.data.file_id, resourceId); assert.ok(value.data.message_id > 0);
    }
    assert.equal(mappings, sends);
});

test('media actions use one longer deadline and pass only its remaining budget to QQ', async t => {
    const { root } = fixture(t);
    const state = { ready: true, epoch: 'epoch', self: { uin: '123', uid: 'u_123' }, capabilities: { image: true, file: true } };
    const calls = [];
    const backend = { async call(method, params, options) {
        calls.push({ method, params, options });
        if (method === 'status') return state;
        if (method === 'prepareMedia') {
            await new Promise(resolve => setTimeout(resolve, 40));
            return { elementType: 2, picElement: { sourcePath: path.join(root, params.file) } };
        }
        if (method === 'sendMessage') return { chatType: 2, peerUid: '200', msgId: String(900 + calls.length), senderUin: '123', elements: params.elements };
        throw new Error('Unexpected method ' + method);
    } };
    const service = new OneBotService({ backend, mediaDirectory: root, actionTimeoutMs: 20, mediaActionTimeoutMs: 500,
        store: { remember: () => ({ id: 1 }) } });
    const image = await service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
        { type: 'image', data: { file: 'pixel.png' } }
    ] } });
    assert.equal(image.retcode, 0);
    const sent = calls.find(item => item.method === 'sendMessage');
    assert.ok(sent.params.timeoutMs > 20 && sent.params.timeoutMs < 500);
    assert.ok(sent.options.timeoutMs <= sent.params.timeoutMs);
    calls.length = 0;
    const text = await service.action({ action: 'send_group_msg', params: { group_id: 200, message: 'text' } });
    assert.equal(text.retcode, 0);
    assert.ok(calls.find(item => item.method === 'sendMessage').params.timeoutMs <= 20);
    assert.equal((await service.action({ action: 'send_group_msg', params: { group_id: 200, message: [
        { type: 'image', data: { file: 'pixel.png' } }, { type: 'video', data: { file: 'unknown' } }
    ] } })).retcode, 1404);
});

test('file preparation and verification apply the same 50 MiB bound while images remain limited to 10 MiB', t => {
    const { root, cache } = fixture(t);
    const filename = path.join(root, 'large.dat');
    const fd = fs.openSync(filename, 'w'); fs.ftruncateSync(fd, 50 * 1024 * 1024 + 1); fs.closeSync(fd);
    assert.throws(() => media.readLocal(root, 'large.dat'), { code: 'INVALID_PARAMS' });
    fs.truncateSync(filename, 11 * 1024 * 1024);
    const file = media.readLocal(root, 'large.dat');
    const native = media.copyToNative(path.join(cache, 'large.dat'), [cache], file.bytes);
    assert.doesNotThrow(() => media.verifyPrepared(native, [cache], { type: 'file', size: file.bytes.length, md5: file.md5 }));
    assert.throws(() => media.verifyPrepared(native, [cache], { type: 'image', size: file.bytes.length, md5: file.md5 }), { code: 'INVALID_PARAMS' });
});
