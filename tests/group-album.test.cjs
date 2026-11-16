'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/qq/group-album-protocol.cjs');
const { createGroupAlbum, MAX_PENDING, MAX_PAGES } = require('../src/qq/group-album.cjs');
const { runGroupAlbum, ACTIONS, READ_ONLY_ACTIONS } = require('../src/onebot/group-album-actions.cjs');
const { createChannel } = require('../src/qq/msf-native.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { parameters } = require('../src/onebot/transports.cjs');
const { n, b, s, join, one, map } = protocol;
const turn = () => new Promise(resolve => setImmediate(resolve));
const error = code => Object.assign(new Error(code), { code });
const rejects = (promise, code) => assert.rejects(promise, reason => reason.code === code);
const album = (id = 'album-1', extra = Buffer.alloc(0)) => join(s(1, id), s(2, '22222'), s(3, '相册😀'), s(4, 'desc'), n(5, 1700000000), n(8, 5),
    b(10, join(s(1, 'u_creator'), s(2, '😂[em]e328514[/em]'), s(13, '22222'))), extra);
const image = (id = 'photo-1') => join(s(1, 'photo.png'), s(3, id), b(5, join(s(1, 'https://p.qpic.cn/real.png'), n(2, 1280), n(3, 720))));
const media = (id = 'photo-1', extra = Buffer.alloc(0)) => join(b(2, image(id)), s(6, '22222'), n(7, 0xffffffffffffffffn), n(8, 1700000000), extra);
function list(albums = [album()], attachInfo = '', hasMore = false) { return join(n(1, 3331), b(4, join(...albums.map(value => b(1, value)), s(2, attachInfo), n(3, hasMore ? 1 : 0)))); }
function mediaList(items = [media()], attachInfo = '', albumId = 'album-1') { return b(4, join(b(1, s(1, albumId)), ...items.map(value => b(3, value)), s(5, attachInfo))); }
function fixture() {
    const calls = [], overrides = {}, state = { media: [media()] }, capture = { epoch: 'album-epoch', self: { uin: '11111', uid: 'u_self' }, session: {}, ensureReady() {}, deadline: operation => operation() };
    const native = { available: () => true, async run(bound, params) {
        assert.equal(bound, capture); calls.push(params);
        const prepared = protocol.prepare(params.operation, params.request);
        const perform = () => {
            const data = prepared.data; let response;
            if (params.operation === 'album.list') response = list();
            else if (params.operation === 'album.media') response = mediaList(state.media);
            else if (params.operation === 'album.like') response = join(n(1, 5495), b(4, b(2, join(s(1, protocol.cellId(data)), n(3, data.isLike ? 0 : 1)))));
            else if (params.operation === 'album.delete') { state.media = []; response = n(1, 8694); }
            else if (params.operation === 'album.feed') response = b(4, b(2, b(1, join(b(1, join(n(1, 422), n(3, 1700000000), s(4, '422_0_' + data.batchId), s(5, protocol.cellId(data)), n(6, 3), n(99, 7))),
                b(2, b(1, s(13, '22222'))), b(5, join(...state.media.map(value => b(1, value)), s(3, data.albumId), n(5, data.batchId), n(99, 8)))))));
            else if (params.operation === 'album.comment') response = join(n(1, 8527), b(4, b(2, join(s(1, 'comment-real-id'), b(2, s(13, data.uin)),
                b(3, join(n(1, 0), s(2, data.content))), n(4, 1700000000), s(7, data.clientKey)))));
            else assert.fail('Unexpected operation ' + params.operation);
            return protocol.decode(response, prepared);
        };
        return overrides.run ? overrides.run(params, perform) : perform();
    } };
    const api = createGroupAlbum(capture, { native });
    return { capture, calls, overrides, state, api, native,
        query: (operation = 'album.list', params = {}, context = {}) => api.query({ operation, groupId: '12345', ...params, expectedEpoch: capture.epoch }, context),
        action: (operation, params = {}, context = {}) => api.action({ operation, groupId: '12345', albumId: 'album-1', ...params, expectedEpoch: capture.epoch }, context) };
}
function onebotFixture() {
    const f = fixture(), state = { ready: true, epoch: f.capture.epoch, self: f.capture.self, capabilities: f.api.capabilities() }, calls = [];
    const service = { async assertSession(bound) { assert.equal(bound, state); }, async sessionCall(bound, method, params) {
        assert.equal(bound, state); assert.ok(['groupAlbumQuery', 'groupAlbumAction'].includes(method)); calls.push(params);
        return f.api[method === 'groupAlbumQuery' ? 'query' : 'action']({ ...params, expectedEpoch: state.epoch });
    } };
    return { ...f, state, service, rpc: calls, invoke: (action, params) => runGroupAlbum(service, state, action, params) };
}

test('AlbumService uses the real fixed TRPC commands, explicit list envelope empties and opaque cursors', () => {
    const prepared = protocol.prepare('album.list', { groupId: 12345, attachInfo: '{"IndexType":"next"}' }), root = map(prepared.body), data = map(one(root, 4, 2));
    assert.equal(prepared.name, 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList');
    assert.equal(prepared.body.subarray(0, 7).toString('hex'), '08831a12001a00'); assert.equal(one(data, 1, 2).toString(), '12345'); assert.equal(one(data, 2, 2).toString(), '{"IndexType":"next"}');
    const app = map(one(root, 10, 2)); assert.equal(one(app, 1, 2).toString(), 'fc-appid'); assert.equal(one(app, 2, 2).toString(), '100');
    const mediaRequest = protocol.prepare('album.media', { groupId: 12345, albumId: 'album-1', attachInfo: 'opaque-next' }), info = map(one(map(mediaRequest.body), 4, 2));
    assert.equal(mediaRequest.name, 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList'); assert.equal(one(info, 2, 2).toString(), 'album-1'); assert.equal(one(info, 5, 2).toString(), 'opaque-next');
});

test('fixed requests reject raw services, invalid IDs, unsafe strings and accessors before transport', () => {
    for (const groupId of [0, true, null, '001', 1.5, '4294967296']) assert.throws(() => protocol.prepare('album.list', { groupId }), { code: 'INVALID_PARAMS' });
    for (const request of [{ groupId: 12345, command: 'raw' }, { groupId: 12345, attachInfo: null }, { groupId: 12345, attachInfo: 'x'.repeat(8193) }]) assert.throws(() => protocol.prepare('album.list', request), { code: 'INVALID_PARAMS' });
    const request = { groupId: 12345 }; Object.defineProperty(request, 'attachInfo', { enumerable: true, get() { assert.fail('getter must not run'); } });
    assert.throws(() => protocol.prepare('album.list', request), { code: 'INVALID_PARAMS' });
    assert.throws(() => protocol.prepare('raw.service', {}), { code: 'UNSUPPORTED' });
});

test('list decoder preserves all exact album fields, Unicode, false and uint64 strings', () => {
    const prepared = protocol.prepare('album.list', { groupId: 12345 });
    const value = protocol.decode(list([album('album-1', join(n(6, 0xffffffffffffffffn), n(15, 0), n(18, 1), n(30, 0), b(9, media())))]), prepared);
    assert.equal(value.albums[0].modifyTime, '18446744073709551615'); assert.equal(value.albums[0].allowShare, false); assert.equal(value.albums[0].isShareAlbum, true); assert.equal(value.albums[0].sortType, 0);
    assert.equal(value.albums[0].creator.nick, '😂[em]e328514[/em]'); assert.equal(value.albums[0].cover.image.defaultUrl.width, 1280); assert.equal(value.albums[0].name, '相册😀');
});

test('omitted protobuf zero status is accepted only with an actual page body, including authoritative empty pages', () => {
    const prepared = protocol.prepare('album.list', { groupId: 12345 });
    assert.deepEqual(protocol.decode(b(4, Buffer.alloc(0)), prepared).albums, []);
    for (const bytes of [n(2, 0), n(99, 1), Buffer.alloc(0), join(n(2, 7), b(4, Buffer.alloc(0)))]) assert.throws(() => protocol.decode(bytes, prepared));
    const request = protocol.prepare('album.media', { groupId: 12345, albumId: 'album-1' });
    assert.deepEqual(protocol.decode(b(4, Buffer.alloc(0)), request).mediaList, []);
});

test('list decoder rejects duplicate fields or identities, malformed text, oversized values and nonadvancing cursors', () => {
    const prepared = protocol.prepare('album.list', { groupId: 12345, attachInfo: 'same' });
    for (const bytes of [list([album(), album()]), list([s(3, 'no id')]), list([], '', true), list([], 'same', true),
        join(list(), b(4, Buffer.alloc(0))), join(n(1, 1234), b(4, Buffer.alloc(0))), b(4, b(1, join(s(1, 'id'), b(3, Buffer.from([255]))))),
        b(4, n(3, 2)), list([album('id', n(12, 0x100000000n))]), Buffer.alloc(protocol.MAX_BYTES + 1)]) assert.throws(() => protocol.decode(bytes, prepared), { code: 'INVALID_RESPONSE' });
    assert.throws(() => protocol.decode(join(n(2, 6), s(3, 'PRIVATE SERVER TEXT'), b(4, Buffer.alloc(0))), prepared), reason => reason.code === 'KERNEL_ERROR' && !reason.message.includes('PRIVATE'));
});

test('media decoder retains real image/video schemas and exact uint64 batch/time fields', () => {
    const prepared = protocol.prepare('album.media', { groupId: 12345, albumId: 'album-1' }), video = join(n(1, 1), b(3, join(s(1, 'video-1'), s(2, 'https://video.qq.com/real'), b(3, image('video-cover')), n(4, 1920), n(5, 1080), n(6, 0xffffffffffffffffn))), n(7, 9));
    const value = protocol.decode(mediaList([media(), video], 'next'), prepared);
    assert.equal(value.mediaList[0].batchId, '18446744073709551615'); assert.equal(value.mediaList[1].video.videoTime, '18446744073709551615'); assert.equal(value.mediaList[1].video.cover.lloc, 'video-cover');
    assert.equal(value.nextAttachInfo, 'next'); assert.equal(value.mediaList[0].type, undefined);
});

test('media decoder refuses wrong albums, duplicate or missing resource identity and repeated cursor', () => {
    const prepared = protocol.prepare('album.media', { groupId: 12345, albumId: 'album-1', attachInfo: 'same' });
    for (const bytes of [mediaList([media()], '', 'other-album'), mediaList([media(), media()]), mediaList([n(1, 0)]), mediaList([], 'same'), join(n(1, 1), mediaList())]) assert.throws(() => protocol.decode(bytes, prepared));
});

test('qun normalization fills only schema defaults and legacy lists preserve exact supported numeric values', async () => {
    const f = fixture(), page = await f.query();
    assert.equal(page.albums[0].album_id, 'album-1'); assert.equal(page.albums[0].create_time, '1700000000'); assert.equal(page.albums[0].allow_share, false);
    assert.equal(page.albums[0].creator.nick, '😂[em]e328514[/em]'); assert.equal(page.albums[0].creator.is_sweet, false); assert.equal(page.albums[0].cover, null);
    const legacy = await f.query('album.listAll'); assert.equal(legacy.complete, true); assert.equal(legacy.albums[0].id, 'album-1'); assert.equal(legacy.albums[0].picNum, 5); assert.equal(legacy.albums[0].createnickname, '😂[em]e328514[/em]');
    f.overrides.run = params => protocol.decode(list([album('id', n(8, 0xffffffffffffffffn))]), protocol.prepare(params.operation, params.request));
    await rejects(f.query('album.listAll'), 'INVALID_RESPONSE');
});

test('complete legacy list walks all pages and never returns a silently truncated prefix', async () => {
    const f = fixture(); f.overrides.run = params => protocol.decode(params.request.attachInfo ? list([album('album-2')]) : list([album()], 'next', true), protocol.prepare(params.operation, params.request));
    const result = await f.query('album.listAll'); assert.deepEqual(result.albums.map(value => value.id), ['album-1', 'album-2']); assert.deepEqual(f.calls.map(call => call.request.attachInfo), ['', 'next']);
    f.calls.length = 0; f.overrides.run = params => protocol.decode(list([album()], 'loop', true), protocol.prepare(params.operation, params.request));
    await rejects(f.query('album.listAll'), 'INVALID_RESPONSE'); assert.equal(f.calls.length, 2);
});

test('page count, duplicate album IDs and total JSON byte budgets are finite', async () => {
    const f = fixture(); f.overrides.run = params => ({ operation: params.operation, groupId: '12345', albums: [], attachInfo: 'next-' + f.calls.length, hasMore: true });
    await rejects(f.query('album.listAll'), 'INVALID_RESPONSE'); assert.equal(f.calls.length, MAX_PAGES);
    const duplicate = fixture(); duplicate.overrides.run = params => ({ operation: params.operation, groupId: '12345', albums: [{ albumId: 'id' }], attachInfo: 'next-' + duplicate.calls.length, hasMore: true });
    await rejects(duplicate.query('album.listAll'), 'INVALID_RESPONSE'); assert.equal(duplicate.calls.length, 2);
    const huge = fixture(); huge.overrides.run = params => ({ operation: params.operation, groupId: '12345', albums: [{ albumId: 'id', name: 'x'.repeat(protocol.MAX_BYTES) }], attachInfo: '', hasMore: false });
    await rejects(huge.query(), 'INVALID_RESPONSE');
});

test('album adapter rejects stale identity, invalid deadlines, abort and unsupported transport before native work', async () => {
    const f = fixture(); await rejects(f.api.query({ operation: 'album.list', groupId: 12345, expectedEpoch: 'old' }), 'SESSION_CHANGED');
    await rejects(f.query('album.list', {}, { expiresAt: NaN }), 'INVALID_PARAMS'); await rejects(f.query('album.list', {}, { expiresAt: Date.now() - 1 }), 'EXPIRED');
    await rejects(f.query('album.list', {}, { signal: AbortSignal.abort() }), 'EXPIRED'); await rejects(f.query('album.list', { arbitrary: 'raw' }), 'INVALID_PARAMS');
    f.native.available = () => false; await rejects(f.query(), 'UNSUPPORTED'); assert.equal(Object.values(f.api.capabilities()).every(value => value === false), true); assert.equal(f.calls.length, 0);
});

test('epoch, UID and session replacement suppress late results without issuing the next page', async () => {
    for (const change of [f => { f.capture.epoch = 'new'; }, f => { f.capture.self.uid = 'u_other'; }, f => { f.capture.session = {}; }]) {
        const f = fixture(); f.overrides.run = (params, perform) => { const value = perform(); change(f); return value; };
        await rejects(f.query('album.listAll'), 'SESSION_CHANGED'); assert.equal(f.calls.length, 1);
    }
    const f = fixture(); f.overrides.run = () => { throw error('KERNEL_ERROR'); }; await rejects(f.query(), 'KERNEL_ERROR'); assert.equal(f.calls.length, 1);
});

test('physical album pending budget survives caller timeout and epoch changes until native operations settle', async () => {
    const f = fixture(), completions = []; f.capture.deadline = operation => { operation().catch(() => {}); return Promise.reject(error('TIMEOUT')); };
    f.overrides.run = (_params, perform) => new Promise(resolve => completions.push(() => resolve(perform())));
    for (let index = 0; index < MAX_PENDING; index++) await rejects(f.query(), 'TIMEOUT');
    f.capture.epoch = 'new'; f.capture.session = {}; f.capture.deadline = operation => operation(); await rejects(f.query(), 'BUSY'); assert.equal(f.calls.length, MAX_PENDING);
    completions.forEach(complete => complete()); await turn(); f.overrides.run = undefined; assert.equal((await f.query()).albums.length, 1);
});

test('three public album actions preserve the distinct legacy, qun envelope and media response shapes', async () => {
    const f = onebotFixture(); assert.equal(['get_group_album_list', 'get_qun_album_list', 'get_group_album_media_list'].every(action => ACTIONS.has(action)), true); assert.equal(READ_ONLY_ACTIONS.size, 3);
    assert.equal((await f.invoke('get_group_album_list', { group_id: 12345 }))[0].id, 'album-1');
    const qun = await f.invoke('get_qun_album_list', { group_id: 12345, attach_info: '00123' }); assert.equal(qun.album_list[0].album_id, 'album-1'); assert.equal(qun.has_more, false); assert.equal(f.rpc.at(-1).attachInfo, '00123');
    const result = await f.invoke('get_group_album_media_list', { group_id: 12345, album_id: 'album-1' }); assert.equal(result.mediaList[0].batchId, '18446744073709551615'); assert.equal(result.nextAttachInfo, '');
});

test('public album actions validate account, target, query parameters and capability before RPC', async () => {
    for (const [action, params] of [['get_group_album_list', { group_id: 0 }], ['get_qun_album_list', { group_id: 12345, attach_info: null }],
        ['get_group_album_list', { group_id: 12345, self_id: 22222 }], ['get_group_album_list', { group_id: 12345, attach_info: '' }],
        ['get_group_album_media_list', { group_id: 12345, album_id: '' }]]) {
        const f = onebotFixture(); await rejects(f.invoke(action, params), 'INVALID_PARAMS'); assert.equal(f.rpc.length, 0);
    }
    const f = onebotFixture(); f.state.capabilities.groupAlbumList = false; await rejects(f.invoke('get_qun_album_list', { group_id: 12345 }), 'UNSUPPORTED'); assert.equal(f.rpc.length, 0);
});

test('actual native channel sends AlbumService fixed requests and decodes their correlated replies', async () => {
    const capture = { epoch: 'real-channel', self: { uin: '11111' } }, sent = [], released = [], replies = new Map();
    const native = { resetSession() {}, install: () => ({ ok: true }), readTemplate: () => ({ haveTemplate: true }),
        send(command, hex) {
            const requestId = String(sent.length + 1), data = map(one(map(Buffer.from(hex, 'hex')), 4, 2));
            assert.equal(one(data, 1, 2).toString(), '12345'); sent.push(command);
            replies.set(requestId, command.endsWith('.GetAlbumList') ? list() : mediaList()); return { ok: true, requestId };
        }, readResponse(requestId) { return { requestId, result: 0, count: 1, body: [...replies.get(requestId)] }; }, release(requestId) { released.push(requestId); } };
    const channel = createChannel({ loadNative: () => native });
    for (const operation of ['album.list', 'album.media']) {
        const result = await channel.run(capture, { op: 'fixedGroupAlbum', operation, request: { groupId: 12345, ...(operation === 'album.media' ? { albumId: 'album-1' } : {}) }, expectedEpoch: capture.epoch, expectedUin: '11111' });
        assert.equal(result.operation, operation);
    }
    assert.deepEqual(sent, [protocol.COMMANDS['album.list'], protocol.COMMANDS['album.media']]); assert.deepEqual(released, ['1', '2']);
});

test('like wire uses precise 421 batch/media cell IDs, account and fixed business sequence', () => {
    for (const isLike of [true, false]) {
        const input = { groupId: 12345, albumId: 'album-1', batchId: '18446744073709551615', lloc: 'photo-1', isLike, uin: '11111', clientKey: 'client-key', timestamp: '1700000000000' },
            prepared = protocol.prepare('album.like', input), root = map(prepared.body), data = map(one(root, 4, 2)), target = map(one(data, 3, 2)), publish = map(one(data, 4, 2));
        assert.equal(prepared.name, protocol.COMMANDS['album.like']); assert.equal(one(root, 1, 0), 5495n); assert.equal(one(data, 2, 0), isLike ? 2n : 1n);
        assert.equal(one(target, 1, 2).toString(), '421_1_0_12345|album-1|18446744073709551615^||^421_1_0_12345|album-1|photo-1^||^0');
        assert.equal(one(target, 3, 0) ?? 0n, isLike ? 0n : 1n); assert.equal(one(map(one(publish, 5, 2)), 5, 0), 0xffffffffffffffffn);
        const ack = join(n(1, 5495), b(4, b(2, join(s(1, protocol.cellId(prepared.data)), n(3, isLike ? 0 : 1)))));
        assert.equal(protocol.decode(ack, prepared).confirmed, true);
        assert.throws(() => protocol.decode(join(n(1, 5495), b(4, b(2, s(1, 'other target')))), prepared), { code: 'INVALID_RESPONSE' });
    }
});

test('like resolves the actual batch before one write and rejects wrong batch without side effects', async () => {
    const f = fixture(); const result = await f.action('album.like', { batchId: '18446744073709551615', isLike: true, lloc: 'photo-1' });
    assert.equal(result.like.status, 0); assert.deepEqual(f.calls.map(value => value.operation), ['album.media', 'album.like']);
    const batch = fixture(); assert.equal((await batch.action('album.like', { batchId: '18446744073709551615', isLike: false })).like.status, 1);
    const no = fixture(); await rejects(no.action('album.like', { batchId: '1', isLike: true, lloc: 'photo-1' }), 'INVALID_PARAMS'); assert.equal(no.calls.length, 1);
    await rejects(no.action('album.like', { batchId: '1', isLike: false }), 'NOT_FOUND'); assert.equal(no.calls.filter(value => value.operation === 'album.like').length, 0);
});

test('media deletion sends the real photo locator and batch then confirms absence from a complete fresh list', async () => {
    const f = fixture(), result = await f.action('album.delete', { lloc: 'photo-1' });
    assert.equal(result.success, true); assert.equal(result.confirmation, 'media_absence'); assert.deepEqual(f.calls.map(value => value.operation), ['album.media', 'album.delete', 'album.media']);
    assert.deepEqual(f.calls[1].request, { groupId: '12345', albumId: 'album-1', batchId: '18446744073709551615', mediaId: 'photo-1' });
    const body = map(one(map(protocol.prepare('album.delete', f.calls[1].request).body), 4, 2)); assert.equal(one(body, 4, 2).toString(), '18446744073709551615');
    await rejects(f.action('album.delete', { lloc: 'photo-1' }), 'NOT_FOUND'); assert.equal(f.calls.filter(value => value.operation === 'album.delete').length, 1);
});

test('video deletion resolves the cover location and never uses an unverified raw input as a fallback', async () => {
    const f = fixture(); f.state.media = [join(n(1, 2), b(3, join(s(1, 'video-id'), b(3, image('video-cover')))), n(7, 77))];
    assert.equal((await f.action('album.delete', { lloc: 'video-id' })).confirmed, true); assert.equal(f.calls[1].request.mediaId, 'video-cover'); assert.equal(f.calls[1].request.batchId, '77');
    const no = fixture(); await rejects(no.action('album.delete', { lloc: 'unresolved' }), 'NOT_FOUND'); assert.equal(no.calls.some(call => call.operation === 'album.delete'), false);
    no.overrides.run = () => { throw error('KERNEL_ERROR'); }; await rejects(no.action('album.delete', { lloc: 'photo-1' }), 'KERNEL_ERROR'); assert.equal(no.calls.filter(call => call.operation === 'album.delete').length, 0);
});

test('deletion ACK without absence expires after exactly one mutation and does not report synthetic success', async () => {
    const f = fixture(); f.overrides.run = (params, perform) => params.operation === 'album.delete' ? { operation: params.operation, ...params.request, confirmed: true, confirmation: 'server_ack' } : perform();
    await rejects(f.action('album.delete', { lloc: 'photo-1' }, { expiresAt: Date.now() + 25 }), 'EXPIRED'); assert.equal(f.calls.filter(call => call.operation === 'album.delete').length, 1);
});

test('comment copies authoritative raw feed cells including unknown fields and explicit type zero before exact authored ACK', async () => {
    const f = fixture(), result = await f.action('album.comment', { lloc: 'photo-1', content: '真实评论😀' });
    assert.equal(result.comment.id, 'comment-real-id'); assert.equal(result.comment.user.uin, '11111'); assert.deepEqual(result.comment.content, [{ type: 0, content: '真实评论😀' }]);
    assert.deepEqual(f.calls.map(value => value.operation), ['album.media', 'album.feed', 'album.comment']);
    const input = f.calls[2].request, prepared = protocol.prepare('album.comment', input), root = map(prepared.body), body = map(one(root, 4, 2)), cells = map(one(body, 4, 2)), content = map(one(body, 5, 2));
    assert.equal(one(root, 1, 0), 8527n); assert.deepEqual(one(cells, 1, 2), input.rawHeader); assert.deepEqual(one(cells, 5, 2), input.rawMedia);
    assert.equal(one(map(input.rawHeader), 99, 0), 7n); assert.equal(one(map(input.rawMedia), 99, 0), 8n);
    assert.equal(one(map(one(content, 3, 2)), 1, 0), 0n); assert.equal(one(map(one(content, 2, 2)), 14, 0), 11111n);
});

test('feed decoder binds group/album/batch/lloc and refuses an unrelated locator or copied media target', () => {
    const prepared = protocol.prepare('album.feed', { groupId: 12345, albumId: 'album-1', batchId: '77', lloc: 'photo-1' });
    const response = (location, albumId = 'album-1', batchId = 77) => b(4, b(2, b(1, join(b(1, join(s(4, '422_0_77'), s(5, location))), b(5, join(b(1, media()), s(3, albumId), n(5, batchId)))))));
    assert.equal(protocol.decode(response(protocol.cellId(prepared.data)), prepared).header.feedId, '422_0_77');
    for (const bytes of [response('421_1_0_54321|other|77'), response(protocol.cellId(prepared.data), 'other'), response(protocol.cellId(prepared.data), 'album-1', 88)]) assert.throws(() => protocol.decode(bytes, prepared), { code: 'INVALID_RESPONSE' });
});

test('comment rejects incomplete or mismatching returned author/content/client key instead of filling fields from the request', async () => {
    for (const change of [value => { value.comment.user.uin = '22222'; }, value => { value.comment.content[0].content = 'other'; }, value => { delete value.comment.clientKey; }, value => { delete value.comment.id; }]) {
        const f = fixture(); f.overrides.run = (params, perform) => { const value = perform(); if (params.operation === 'album.comment') change(value); return value; };
        await rejects(f.action('album.comment', { lloc: 'photo-1', content: 'hello' }), 'INVALID_RESPONSE'); assert.equal(f.calls.filter(value => value.operation === 'album.comment').length, 1);
    }
});

test('album writes retain a physical lock through caller timeout and reject stale-session completions', async () => {
    const f = fixture(); let finish; f.overrides.run = (params, perform) => params.operation === 'album.like' ? new Promise(resolve => { finish = () => resolve(perform()); }) : perform();
    f.capture.deadline = operation => { operation().catch(() => {}); return Promise.reject(error('TIMEOUT')); };
    await rejects(f.action('album.like', { batchId: '18446744073709551615', isLike: true }), 'TIMEOUT'); await turn();
    f.capture.deadline = operation => operation(); await rejects(f.action('album.delete', { lloc: 'photo-1' }), 'BUSY'); finish(); await turn();
    f.overrides.run = undefined; assert.equal((await f.action('album.like', { batchId: '18446744073709551615', isLike: false })).confirmed, true);
    const stale = fixture(); stale.overrides.run = (params, perform) => { const result = perform(); if (params.operation === 'album.delete') stale.capture.self.uid = 'u_other'; return result; };
    await rejects(stale.action('album.delete', { lloc: 'photo-1' }), 'SESSION_CHANGED'); assert.equal(stale.calls.filter(call => call.operation === 'album.media').length, 1);
});

test('public like/cancel/comment/delete preserve real result contracts and use only the worker action boundary', async () => {
    const f = onebotFixture(), input = { group_id: 12345, album_id: 'album-1', batch_id: '18446744073709551615', lloc: 'photo-1' };
    assert.equal((await f.invoke('set_group_album_media_like', input)).status, 0); assert.equal((await f.invoke('cancel_group_album_media_like', input)).status, 1);
    const comment = await f.invoke('do_group_album_comment', { group_id: 12345, album_id: 'album-1', lloc: 'photo-1', content: 'hello' }); assert.equal(comment.id, 'comment-real-id'); assert.equal(comment.user.uin, '11111');
    assert.deepEqual(await f.invoke('del_group_album_media', { group_id: 12345, album_id: 'album-1', lloc: 'photo-1' }), { success: true });
    assert.equal(f.rpc.every(request => ['album.like', 'album.comment', 'album.delete'].includes(request.operation)), true);
});

test('public album writes reject unsafe batch numbers, empty comments and caller raw protocol cells before RPC', async () => {
    for (const [action, params] of [['set_group_album_media_like', { batch_id: '01' }], ['set_group_album_media_like', { batch_id: Number.MAX_SAFE_INTEGER + 1 }],
        ['do_group_album_comment', { lloc: 'photo-1', content: '' }], ['del_group_album_media', { lloc: 'photo-1', rawHeader: Buffer.from('raw') }]]) {
        const f = onebotFixture(); await rejects(f.invoke(action, { group_id: 12345, album_id: 'album-1', ...params }), 'INVALID_PARAMS'); assert.equal(f.rpc.length, 0);
    }
});

test('comment decoder preserves current nested and legacy wrapper cells without inventing omitted server data', () => {
    const input = { groupId: 12345, albumId: 'album-1', batchId: '77', lloc: 'photo-1', uin: '11111', content: 'hello', clientKey: 'client-key', rawHeader: s(4, 'feed'), rawMedia: s(3, 'album-1') },
        prepared = protocol.prepare('album.comment', input), user = b(2, s(13, '11111')), contents = b(3, s(2, 'hello'));
    const legacy = join(n(1, 8527), b(4, join(s(1, 'legacy-id'), b(2, user), contents, n(4, 1700000000), s(7, 'client-key'))));
    assert.deepEqual(protocol.decode(legacy, prepared).comment, { id: 'legacy-id', user: { uin: '11111' }, content: [{ type: 0, content: 'hello' }], time: '1700000000', clientKey: 'client-key' });
    for (const response of [join(n(1, 8527), b(4, b(2, s(1, 'only-id')))), join(n(1, 8527), b(4, join(s(1, 'id'), contents, n(4, 1700000000), s(7, 'client-key'))))]) assert.throws(() => protocol.decode(response, prepared), { code: 'INVALID_RESPONSE' });
});

test('real public OneBot dispatcher and capability catalogue register all seven non-upload album contracts', async () => {
    const cases = { get_group_album_list: { group_id: 12345 }, get_qun_album_list: { group_id: 12345 }, get_group_album_media_list: { group_id: 12345, album_id: 'album-1' },
        set_group_album_media_like: { group_id: 12345, album_id: 'album-1', batch_id: '18446744073709551615' }, cancel_group_album_media_like: { group_id: 12345, album_id: 'album-1', batch_id: '18446744073709551615' },
        do_group_album_comment: { group_id: 12345, album_id: 'album-1', lloc: 'photo-1', content: 'hello' }, del_group_album_media: { group_id: 12345, album_id: 'album-1', lloc: 'photo-1' } };
    for (const [action, params] of Object.entries(cases)) {
        const f = onebotFixture(), service = new OneBotService({ store: {}, backend: { async call(method, request, options) {
            if (method === 'status') return f.state;
            const context = { expiresAt: Date.now() + options.timeoutMs };
            if (method === 'groupAlbumQuery') return f.api.query(request, context);
            if (method === 'groupAlbumAction') return f.api.action(request, context);
            assert.fail('Unexpected method ' + method);
        } } });
        const result = await service.action({ action, params, echo: 0 }); assert.equal(result.retcode, 0, action + ': ' + JSON.stringify(result)); assert.equal(result.echo, 0);
        const status = await service.action({ action: 'get_capabilities' });
        for (const name of Object.keys(cases)) assert.equal(status.data.extensions.find(value => value.name === name)?.available, true, name);
        for (const name of ['upload_image_to_qun_album', 'upload_video_to_qun_album']) assert.equal(status.data.extensions.find(value => value.name === name)?.available, false, name);
    }
    const parsed = parameters(new URLSearchParams({ batch_id: '18446744073709551615', attach_info: '00123', album_id: '00123', album_name: '00123', lloc: '00123', group_id: '12345' }), 'set_group_album_media_like');
    for (const name of ['batch_id', 'attach_info', 'album_id', 'album_name', 'lloc']) assert.equal(typeof parsed[name], 'string'); assert.equal(parsed.group_id, 12345);
});
