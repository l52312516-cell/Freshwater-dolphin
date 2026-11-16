'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('../src/qq/media.cjs');
const { createAlbumUpload, source } = require('../src/qq/group-album-upload.cjs');
const { createGroupAlbum } = require('../src/qq/group-album.cjs');
const { runGroupAlbum } = require('../src/onebot/group-album-actions.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const protocol = require('../src/qq/group-album-protocol.cjs');
const { n, b, s, join } = protocol;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, reason => reason.code === code);
const turn = () => new Promise(resolve => setImmediate(resolve));
function box(type, value) { const head = Buffer.alloc(8); head.writeUInt32BE(value.length + 8); head.write(type, 4); return Buffer.concat([head, value]); }
const MP4 = Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isom')])), box('moov', Buffer.from('metadata')), box('mdat', Buffer.from('frames'))]);
function fixture(t) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporary, 'group-album-upload-')); if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const state = { requests: [], controls: [], slices: [], native: [], invocations: [], sessions: new Map(), items: [], overrides: {} };
    const capture = { epoch: 'upload-epoch', session: {}, self: { uin: '11111', uid: 'u_self' }, mediaDirectory: directory,
        ensureReady() {}, deadline: operation => operation(), hasMethods: (service, methods) => service === 'ticket' && methods.includes('forceFetchClientKey') || service === 'tipOff' && methods.includes('getPskey'),
        async invoke(service, method, args) {
            state.invocations.push({ service, method, args });
            return service === 'ticket' ? { result: 0, clientKey: 'PRIVATE-CLIENT-KEY', keyIndex: '1' } : { result: 0, domainPskeyMap: new Map([['qzone.qq.com', 'PRIVATE-PSKEY']]) };
        }, video: { available: () => true, async prepare(file) { const value = media.readLocal(directory, file); return { ...value, durationSeconds: 6.077, thumbnail: { bytes: PNG } }; } } };
    const native = { available: () => true, async run(bound, request) {
        assert.equal(bound, capture); state.native.push(request); const prepared = protocol.prepare(request.operation, request.request);
        const result = request.operation === 'album.list' ? b(4, b(1, join(s(1, 'album-1'), s(3, 'Album name')))) :
            b(4, join(b(1, s(1, 'album-1')), ...state.items.map(item => b(3, item))));
        const value = protocol.decode(result, prepared); return state.overrides.native ? state.overrides.native(request, value) : value;
    } };
    const fetchImpl = async (target, options) => {
        const url = new URL(target); state.requests.push({ url, options });
        if (state.overrides.fetch) { const result = await state.overrides.fetch(url, options); if (result !== undefined) return result; }
        if (url.hostname === 'ssl.ptlogin2.qq.com') {
            const headers = new Headers({ Location: 'https://qzone.qq.com/11111/infocenter' });
            for (const cookie of ['uin=o11111; Domain=.qq.com; Path=/', 'p_uin=o11111; Domain=.qq.com; Path=/', 'skey=PRIVATE-SKEY; Domain=.qq.com; Path=/',
                ...(state.overrides.noPskey ? [] : ['p_skey=PRIVATE-PSKEY; Domain=.qzone.qq.com; Path=/'])]) headers.append('Set-Cookie', cookie);
            return new Response('', { status: 302, headers });
        }
        if (url.hostname === 'qzone.qq.com') return new Response('');
        assert.equal(url.hostname, 'h5.qzone.qq.com'); assert.equal(url.protocol, 'https:'); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
        if (url.pathname.includes('FileBatchControl')) {
            const request = JSON.parse(options.body).control_req[0], session = 'session-' + (state.controls.length + 1);
            state.controls.push(request); state.sessions.set(session, { request, bytes: [], offset: 0, sequence: 0 });
            return Response.json({ ret: 0, data: { session, slice_size: state.overrides.sliceSize ?? 16384 } });
        }
        const form = options.body, session = state.sessions.get(form.get('session')), bytes = Buffer.from(await form.get('data').arrayBuffer());
        assert.ok(session); const offset = Number(form.get('offset')), end = Number(form.get('end')), sequence = Number(form.get('seq'));
        assert.equal(offset, session.offset); assert.equal(sequence, session.sequence); assert.equal(end, offset + bytes.length); assert.equal(Number(url.searchParams.get('offset')), offset);
        state.slices.push({ request: session.request, bytes, offset, end, sequence, form }); session.bytes.push(bytes); session.offset = end; session.sequence++;
        const complete = end === session.request.file_len; let biz;
        if (complete && session.request.appid === 'video_qun') biz = { sVid: 'real-video-id' };
        else if (complete && session.request.biz_req.iUploadType === 2) {
            biz = { sPhotoID: 'real-cover-id', sBURL: 'https://p.qpic.cn/real-cover' };
            state.items.push(join(n(1, 2), b(3, join(s(1, 'real-video-id'), b(3, s(3, 'real-cover-id')))), s(6, '11111'), n(7, 77)));
        } else if (complete) {
            biz = { sPhotoID: 'real-photo-id' };
            state.items.push(join(b(2, s(3, 'real-photo-id')), s(6, '11111'), n(7, 77)));
        }
        return Response.json({ ret: 0, data: { session: form.get('session'), offset, end, seq: sequence, ...(biz ? { biz } : {}) } });
    };
    const uploader = createAlbumUpload(capture, { fetchImpl }), api = createGroupAlbum(capture, { native, fetchImpl, pollMs: 2 });
    function bound() {
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self.uin, uid: capture.self.uid };
        const value = { saved, context: { expiresAt: Date.now() + 60000 }, check() {
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self.uin !== saved.uin || capture.self.uid !== saved.uid) throw Object.assign(new Error('Changed'), { code: 'SESSION_CHANGED' });
            if (value.context.signal?.aborted || Date.now() >= value.context.expiresAt) throw Object.assign(new Error('Expired'), { code: 'EXPIRED' });
        } }; return value;
    }
    return { state, directory, capture, uploader, api, bound, fetchImpl,
        input: file => ({ groupId: '12345', albumId: 'album-1', albumName: 'Album name', file }),
        upload: (type = 'image', file = 'base64://' + PNG.toString('base64'), context = {}) => api.action({ operation: type === 'video' ? 'album.uploadVideo' : 'album.uploadImage', groupId: '12345', albumId: 'album-1', albumName: 'Album name', file, expectedEpoch: capture.epoch }, context) };
}

test('image upload authenticates the same QQ account, sends exact controlled bytes and confirms native album readback', async t => {
    const f = fixture(t), result = await f.upload(); assert.equal(result.mediaId, 'real-photo-id'); assert.equal(result.confirmation, 'media_readback'); assert.equal(result.md5, md5(PNG)); assert.equal(result.size, PNG.length);
    assert.deepEqual(f.state.native.map(value => value.operation), ['album.list', 'album.media', 'album.media']); assert.equal(f.state.controls.length, 1); assert.equal(f.state.slices.length, 1);
    assert.deepEqual(f.state.slices[0].bytes, PNG); const control = f.state.controls[0]; assert.equal(control.token.data, 'PRIVATE-PSKEY'); assert.equal(control.checksum, md5(PNG));
    assert.equal(control.biz_req.sAlbumID, 'album-1'); assert.equal(control.biz_req.mapExt.userid, '12345'); assert.equal(f.state.slices[0].form.get('slice_size'), '16384');
    assert.equal(f.state.requests.every(item => ['ssl.ptlogin2.qq.com', 'qzone.qq.com', 'h5.qzone.qq.com'].includes(item.url.hostname)), true);
    const serialized = JSON.stringify(result); for (const secret of ['PRIVATE', 'skey', 'cookie', 'session-']) assert.equal(serialized.includes(secret), false);
});

test('image slices preserve 16KiB sequence/offset/end and final ACK; service-provided redirects or paths cannot select destinations', async t => {
    const f = fixture(t), image = Buffer.concat([PNG, Buffer.alloc(33000, 7)]); f.state.overrides.sliceSize = 1;
    assert.equal((await f.upload('image', 'base64://' + image.toString('base64'))).confirmed, true);
    assert.deepEqual(f.state.slices.map(value => value.offset), [0, 16384, 32768]); assert.equal(f.state.slices.at(-1).end, image.length);
    assert.deepEqual(Buffer.concat(f.state.slices.map(value => value.bytes)), image);
});

test('video uploads SHA1 source then a real generated cover bound to returned vid, and removes only temporary staging', async t => {
    const f = fixture(t), result = await f.upload('video', 'base64://' + MP4.toString('base64'));
    assert.equal(result.mediaId, 'real-video-id'); assert.equal(result.type, 'video'); assert.equal(f.state.controls.length, 2); assert.deepEqual(fs.readdirSync(f.directory), []);
    const [video, cover] = f.state.controls;
    assert.equal(video.checksum, crypto.createHash('sha1').update(MP4).digest('hex')); assert.equal(video.check_type, 1); assert.equal(video.cmd, 'FileUploadVideo'); assert.equal(video.biz_req.iPlayTime, 6077);
    assert.equal(video.biz_req.extend_info.qun_id, '12345'); assert.equal(cover.biz_req.stExtendInfo.mapParams.vid, 'real-video-id'); assert.equal(cover.checksum, md5(PNG)); assert.equal(cover.biz_req.iUploadType, 2);
    assert.deepEqual(f.state.slices[0].bytes, MP4); assert.deepEqual(f.state.slices[1].bytes, PNG);
});

test('account media handles preserve actual input resources and mismatched types or arbitrary sources never reach Web authentication', async t => {
    const f = fixture(t), image = media.exportImage(f.directory, PNG), video = media.exportMedia(f.directory, 'video', MP4);
    assert.equal((await f.upload('image', image.file)).confirmed, true); assert.equal(fs.existsSync(image.path), true);
    f.state.items = []; assert.equal((await f.upload('video', video.file)).confirmed, true); assert.equal(fs.existsSync(video.path), true);
    for (const file of ['C:\\outside.png', 'file:///outside.png', 'https://example.test/a.png', '../outside.png', 'base64://AAAA', 'base64://AA==\n']) {
        const before = f.state.requests.length; await assert.rejects(f.uploader.upload('image', f.input(file), f.bound())); assert.equal(f.state.requests.length, before);
    }
    assert.throws(() => source(video.file, f.directory, 'image'), { code: 'INVALID_PARAMS' }); assert.throws(() => source(image.file, f.directory, 'video'), { code: 'INVALID_PARAMS' });
});

test('missing Qzone pskey uses only the exact authenticated domain fallback and never exposes credentials', async t => {
    const f = fixture(t); f.state.overrides.noPskey = true;
    assert.equal((await f.upload()).confirmed, true); assert.deepEqual(f.state.invocations.find(value => value.service === 'tipOff').args, [['qzone.qq.com'], true]);
    assert.equal(f.state.controls[0].token.data, 'PRIVATE-PSKEY');
});

test('wrong-account, private redirect and redirect-loop login results are rejected before upload controls', async t => {
    for (const location of ['https://127.0.0.1/private', 'http://qzone.qq.com/', 'https://user:pass@qzone.qq.com/', 'https://ptlogin2.qzone.qq.com/check_sig?uin=22222', 'https://ssl.ptlogin2.qq.com/jump']) {
        const f = fixture(t); f.state.overrides.fetch = url => url.hostname === 'ssl.ptlogin2.qq.com' ? new Response('', { status: 302, headers: { Location: location } }) : undefined;
        await assert.rejects(f.upload()); assert.equal(f.state.controls.length, 0);
    }
    const f = fixture(t); f.state.overrides.fetch = url => {
        if (url.hostname !== 'ssl.ptlogin2.qq.com') return;
        const headers = new Headers({ Location: 'https://qzone.qq.com/11111/infocenter' });
        for (const cookie of ['uin=o22222; Domain=.qq.com; Path=/', 'skey=SECRET; Domain=.qq.com; Path=/', 'p_skey=SECRET; Domain=.qzone.qq.com; Path=/']) headers.append('Set-Cookie', cookie);
        return new Response('', { status: 302, headers });
    };
    await rejects(f.upload(), 'AUTH_FAILED'); assert.equal(f.state.controls.length, 0);
});

test('HTTP upload rejects unknown final ACK, nonzero business code, wrong slice session and redirects without retrying', async t => {
    for (const response of [() => Response.json({ ret: 0 }), () => Response.json({ ret: 4, msg: 'PRIVATE SERVER TEXT' }),
        () => Response.json({ ret: 0, data: { session: 'other-session', biz: { sPhotoID: 'real-photo-id' } } }),
        () => new Response('', { status: 302, headers: { Location: 'https://other.example/' } })]) {
        const f = fixture(t); let writes = 0; f.state.overrides.fetch = url => { if (url.pathname.endsWith('/FileUpload')) { writes++; return response(); } };
        await assert.rejects(f.upload(), reason => !reason.message.includes('PRIVATE')); assert.equal(writes, 1); assert.equal(f.state.controls.length, 1);
    }
});

test('HTTP upload JSON and slice configuration have strict byte, integer and request count budgets', async t => {
    for (const response of [() => new Response(JSON.stringify({ ret: 0, data: { session: 'x' }, filler: 'x'.repeat(65536) })),
        () => new Response('{"ret":0,"data":{"session":"x","slice_size":9007199254740993}}'),
        () => Response.json({ ret: 0, data: { session: 'x', slice_size: 1048577 } })]) {
        const f = fixture(t); f.state.overrides.fetch = url => url.pathname.includes('FileBatchControl') ? response() : undefined;
        await rejects(f.upload('video', 'base64://' + MP4.toString('base64')), 'INVALID_RESPONSE'); assert.equal(f.state.slices.length, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
    }
});

test('upload ACK alone never succeeds when native readback is missing, belongs to another account or loses the video cover', async t => {
    const absent = fixture(t); absent.state.overrides.native = (request, value) => request.operation === 'album.media' ? { ...value, mediaList: [] } : value;
    await rejects(absent.upload('image', undefined, { expiresAt: Date.now() + 60 }), 'EXPIRED'); assert.equal(absent.state.controls.length, 1); assert.equal(absent.state.slices.length, 1);
    const other = fixture(t); other.state.overrides.native = (request, value) => { if (request.operation === 'album.media') value.mediaList.forEach(item => { item.uploader = '22222'; }); return value; };
    await rejects(other.upload(), 'INVALID_RESPONSE'); assert.equal(other.state.slices.length, 1);
    const cover = fixture(t); cover.state.overrides.native = (request, value) => { if (request.operation === 'album.media') value.mediaList.forEach(item => { if (item.video) item.video.cover.lloc = 'other-cover'; }); return value; };
    await rejects(cover.upload('video', 'base64://' + MP4.toString('base64'), { expiresAt: Date.now() + 60 }), 'EXPIRED'); assert.equal(cover.state.controls.length, 2);
});

test('album target/name validation precedes uploads and cancellation/session changes never retry later slices', async t => {
    const f = fixture(t); await rejects(f.api.action({ operation: 'album.uploadImage', ...f.input('base64://' + PNG.toString('base64')), albumName: 'wrong', expectedEpoch: f.capture.epoch }), 'INVALID_PARAMS'); assert.equal(f.state.requests.length, 0);
    const expired = fixture(t); await rejects(expired.upload('image', undefined, { signal: AbortSignal.abort() }), 'EXPIRED'); assert.equal(expired.state.requests.length, 0);
    const stale = fixture(t); stale.state.overrides.fetch = url => { if (url.pathname.endsWith('/FileUpload')) { stale.capture.self.uid = 'u_other'; return Response.json({ ret: 0, data: { biz: { sPhotoID: 'real-photo-id' } } }); } };
    await rejects(stale.upload(), 'SESSION_CHANGED'); assert.equal(stale.state.controls.length, 1); assert.equal(stale.state.requests.filter(value => value.url.pathname.endsWith('/FileUpload')).length, 1);
});

test('physical HTTP upload lock survives caller changes until the live request settles', async t => {
    const f = fixture(t); let finish; f.state.overrides.fetch = url => url.pathname.endsWith('/FileUpload') ? new Promise(resolve => { finish = () => resolve(Response.json({ ret: 0, data: { biz: { sPhotoID: 'real-photo-id' } } })); }) : undefined;
    const scope = f.bound(), first = f.uploader.upload('image', f.input('base64://' + PNG.toString('base64')), scope); await turn();
    assert.equal(typeof finish, 'function'); scope.context.expiresAt = Date.now() - 1;
    await rejects(f.uploader.upload('image', f.input('base64://' + PNG.toString('base64')), f.bound()), 'BUSY'); finish(); await rejects(first, 'EXPIRED');
    f.state.overrides.fetch = undefined; assert.equal((await f.uploader.upload('image', f.input('base64://' + PNG.toString('base64')), f.bound())).mediaId, 'real-photo-id');
});

test('public album image/video uploads validate source digest/size and preserve null versus video-ID contracts', async t => {
    const f = fixture(t), state = { epoch: f.capture.epoch, self: f.capture.self, capabilities: f.api.capabilities() }, calls = [];
    const service = { mediaDirectory: f.directory, async assertSession(bound) { assert.equal(bound, state); }, async sessionCall(bound, method, params) {
        assert.equal(bound, state); assert.equal(method, 'groupAlbumAction'); calls.push(params); return f.api.action({ ...params, expectedEpoch: state.epoch });
    } };
    assert.equal(await runGroupAlbum(service, state, 'upload_image_to_qun_album', { group_id: 12345, album_id: 'album-1', album_name: 'Album name', file: 'base64://' + PNG.toString('base64') }), null);
    assert.deepEqual(await runGroupAlbum(service, state, 'upload_video_to_qun_album', { group_id: 12345, album_id: 'album-1', album_name: 'Album name', file: 'base64://' + MP4.toString('base64') }), { id: 'real-video-id' });
    assert.deepEqual(calls.map(value => value.operation), ['album.uploadImage', 'album.uploadVideo']);
    const before = calls.length; await rejects(runGroupAlbum(service, state, 'upload_image_to_qun_album', { group_id: 12345, album_id: 'album-1', album_name: 'Album name', file: 'https://example.test/a.png' }), 'INVALID_PARAMS'); assert.equal(calls.length, before);
});

test('real public upload actions share the media deadline and advertise only available account/decoder capabilities', async t => {
    const f = fixture(t), state = { ready: true, epoch: f.capture.epoch, self: f.capture.self, capabilities: f.api.capabilities() }, timeouts = [];
    const service = new OneBotService({ store: {}, mediaDirectory: f.directory, backend: { async call(method, request, options) {
        if (method === 'status') return state;
        assert.equal(method, 'groupAlbumAction'); assert.equal(request.expectedEpoch, state.epoch); timeouts.push(options.timeoutMs);
        return f.api.action(request, { expiresAt: Date.now() + options.timeoutMs });
    } } });
    for (const [action, bytes] of [['upload_image_to_qun_album', PNG], ['upload_video_to_qun_album', MP4]]) {
        const result = await service.action({ action, params: { group_id: 12345, album_id: 'album-1', album_name: 'Album name', file: 'base64://' + bytes.toString('base64') } });
        assert.equal(result.retcode, 0, JSON.stringify(result)); assert.deepEqual(result.data, action === 'upload_image_to_qun_album' ? null : { id: 'real-video-id' });
    }
    assert.equal(timeouts.every(value => value > 10000 && value <= 60000), true);
    const status = await service.action({ action: 'get_capabilities' });
    for (const name of ['upload_image_to_qun_album', 'upload_video_to_qun_album']) assert.equal(status.data.extensions.find(value => value.name === name)?.available, true);
    f.capture.video.available = () => false; assert.equal(f.api.capabilities().groupAlbumUploadImage, true); assert.equal(f.api.capabilities().groupAlbumUploadVideo, false);
    f.capture.hasMethods = () => false; assert.equal(f.api.capabilities().groupAlbumUploadImage, false);
});
