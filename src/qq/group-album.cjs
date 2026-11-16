'use strict';

const protocol = require('./group-album-protocol.cjs');
const { setTimeout: pause } = require('node:timers/promises');
const crypto = require('node:crypto');
const { createAlbumUpload } = require('./group-album-upload.cjs');
const { plain, uint, text, fields, budget, fail, MAX_ITEMS } = protocol;
const MAX_PENDING = 8, MAX_PAGES = 32;
const QUERY_PARAMETERS = Object.freeze({ 'album.list': ['groupId', 'attachInfo'], 'album.listAll': ['groupId'], 'album.media': ['groupId', 'albumId', 'attachInfo'] });
const ACTION_PARAMETERS = Object.freeze({ 'album.like': ['groupId', 'albumId', 'batchId', 'lloc', 'isLike'],
    'album.comment': ['groupId', 'albumId', 'lloc', 'content'], 'album.delete': ['groupId', 'albumId', 'lloc'],
    'album.uploadImage': ['groupId', 'albumId', 'albumName', 'file'], 'album.uploadVideo': ['groupId', 'albumId', 'albumName', 'file'] });
function normalizeCover(value) {
    if (!value) return null;
    const url = data => data ? { url: data.url ?? '', width: data.width ?? 0, height: data.height ?? 0 } : null;
    const image = value.image;
    return { type: value.type ?? 0, image: image ? { name: image.name ?? '', sloc: image.sloc ?? '', lloc: image.lloc ?? '',
        photoUrls: (image.photoUrls ?? []).map(item => ({ spec: item.spec ?? 0, url: url(item.url) })), defaultUrl: url(image.defaultUrl), isGif: image.isGif ?? false, hasRaw: image.hasRaw ?? false } : null };
}
function creator(value) {
    return Object.fromEntries([['uid', 'uid', ''], ['nick', 'nick', ''], ['is_sweet', 'isSweet', false], ['is_special', 'isSpecial', false], ['is_super_like', 'isSuperLike', false],
        ['custom_id', 'customId', ''], ['poly_id', 'polyId', ''], ['portrait', 'portrait', ''], ['can_follow', 'canFollow', 0], ['isfollowed', 'isFollowed', 0], ['uin', 'uin', ''], ['ditto_uin', 'dittoUin', '']]
        .map(([key, source, fallback]) => [key, value[source] ?? fallback]));
}
function normalizeAlbum(value) {
    const output = { album_id: value.albumId, owner: value.owner ?? '', name: value.name ?? '', desc: value.description ?? '',
        create_time: value.createTime ?? '0', modify_time: value.modifyTime ?? '0', last_upload_time: value.lastUploadTime ?? '0', upload_number: value.uploadNumber ?? '0', cover: normalizeCover(value.cover),
        top_flag: value.topFlag ?? '0', busi_type: value.busiType ?? 0, status: value.status ?? 0, allow_share: value.allowShare ?? false, is_subscribe: value.isSubscribe ?? false,
        bitmap: value.bitmap ?? '', is_share_album: value.isShareAlbum ?? false, qz_album_type: value.qzAlbumType ?? 0, cover_type: value.coverType ?? 0, default_desc: value.defaultDesc ?? '', sort_type: value.sortType ?? 0 };
    if (value.creator) output.creator = creator(value.creator); return output;
}
function legacyAlbum(value) {
    const number = item => { if (BigInt(item ?? 0) > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_RESPONSE', 'Legacy album integer exceeds the exact JSON number range'); return Number(item ?? 0); };
    return { id: value.albumId, name: value.name ?? '', picNum: number(value.uploadNumber), createTime: number(value.createTime), desc: value.description ?? '', owner: value.owner ?? '',
        createuin: value.creator?.uin || value.owner || value.creator?.uid || '', createnickname: value.creator?.nick ?? '', last_upload_time: number(value.lastUploadTime), cover: normalizeCover(value.cover) };
}
function createGroupAlbum(capture, { native = require('./msf-native.cjs'), pollMs = 150, uploadApi, fetchImpl = globalThis.fetch } = {}) {
    if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new TypeError('Invalid album confirmation interval');
    const pending = new Set(), mutations = new Map(), uploader = uploadApi ?? createAlbumUpload(capture, { fetchImpl });
    function capabilities() { const available = native.available(); return { groupAlbumList: available, groupAlbumMediaList: available,
        groupAlbumLike: available, groupAlbumComment: available, groupAlbumDelete: available,
        groupAlbumUploadImage: available && uploader.supported('image'), groupAlbumUploadVideo: available && uploader.supported('video') }; }
    function scope(params, context, maximum = 10000) {
        capture.ensureReady();
        if (typeof params.expectedEpoch !== 'string' || params.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Album requests must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        uint(saved.uin, 'authenticated account', 0xffffffffn, 1n);
        if (typeof saved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(saved.uid)) fail('NOT_READY', 'Group albums require the real QQ identity');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid album deadline');
        const bound = { saved, context: { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + maximum) } };
        bound.check = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the album operation');
            if (bound.context.signal?.aborted || Date.now() >= bound.context.expiresAt) fail('EXPIRED', 'Album operation expired; a write result may be unknown');
        };
        bound.check(); return bound;
    }
    async function fixed(operation, request, bound) {
        bound.check(); const prepared = protocol.prepare(operation, request);
        if (pending.size >= MAX_PENDING) fail('BUSY', 'Too many physical album requests remain pending');
        const token = {}; pending.add(token);
        const task = Promise.resolve().then(() => { bound.check(); return native.run(capture, { op: 'fixedGroupAlbum', operation, request: prepared.data,
            expectedEpoch: bound.saved.epoch, expectedUin: bound.saved.uin, signal: bound.context.signal, timeoutMs: Math.max(1, Math.min(10000, bound.context.expiresAt - Date.now())) }); });
        task.finally(() => pending.delete(token)).catch(() => {});
        const value = await task; bound.check();
        if (!plain(value) || value.operation !== operation || value.groupId !== prepared.data.groupId || operation === 'album.media' && value.albumId !== prepared.data.albumId) fail('INVALID_RESPONSE', 'QQ returned unrelated album data');
        return budget(value);
    }
    async function listAll(groupId, bound) {
        const albums = [], seen = new Set(), cursors = new Set(); let attachInfo = '';
        for (let page = 0; page < MAX_PAGES; page++) {
            const result = await fixed('album.list', { groupId, attachInfo }, bound);
            if (!Array.isArray(result.albums) || typeof result.hasMore !== 'boolean') fail('INVALID_RESPONSE', 'QQ omitted album page data');
            for (const item of result.albums) {
                if (!plain(item) || typeof item.albumId !== 'string' || !item.albumId || seen.has(item.albumId) || albums.length >= MAX_ITEMS) fail('INVALID_RESPONSE', 'QQ returned repeated or excessive group albums');
                seen.add(item.albumId); albums.push(item);
            }
            budget(albums);
            if (!result.hasMore) return albums;
            const next = protocol.cursor(result.attachInfo);
            if (!next || next === attachInfo || cursors.has(next)) fail('INVALID_RESPONSE', 'QQ album pagination did not advance');
            cursors.add(next); attachInfo = next;
        }
        fail('INVALID_RESPONSE', 'Complete album list exceeds its page budget');
    }
    function mediaKey(item) { return item.video?.id || item.image?.lloc; }
    function mediaMatches(item, key) { return item.image?.lloc === key || item.video?.id === key || item.video?.cover?.lloc === key; }
    async function collectMedia(groupId, albumId, bound) {
        const values = [], identities = new Set(), cursors = new Set(); let attachInfo = '';
        for (let page = 0; page < MAX_PAGES; page++) {
            const result = await fixed('album.media', { groupId, albumId, attachInfo }, bound);
            if (!Array.isArray(result.mediaList) || typeof result.nextAttachInfo !== 'string') fail('INVALID_RESPONSE', 'QQ omitted actual album media page metadata');
            for (const item of result.mediaList) {
                const key = plain(item) ? mediaKey(item) : undefined;
                if (typeof key !== 'string' || !key || identities.has(key) || values.length >= MAX_ITEMS) fail('INVALID_RESPONSE', 'QQ returned duplicate or excessive album media');
                identities.add(key); values.push(item);
            }
            budget(values); const next = protocol.cursor(result.nextAttachInfo);
            if (!next) return values;
            if (next === attachInfo || cursors.has(next)) fail('INVALID_RESPONSE', 'Album media pagination did not advance');
            cursors.add(next); attachInfo = next;
        }
        fail('INVALID_RESPONSE', 'Album media confirmation exceeds its page budget');
    }
    function uniqueMedia(values, key) {
        const matches = values.filter(item => mediaMatches(item, key));
        if (!matches.length) fail('NOT_FOUND', 'Album media was not found in the requested group and album');
        if (matches.length !== 1) fail('INVALID_RESPONSE', 'Album media locator is ambiguous'); return matches[0];
    }
    async function query(params, context = {}) {
        if (!plain(params) || !Object.hasOwn(QUERY_PARAMETERS, Object.getOwnPropertyDescriptor(params, 'operation')?.value)) fail('INVALID_PARAMS', 'Unknown group album query');
        const operation = params.operation; fields(params, ['operation', 'expectedEpoch', ...QUERY_PARAMETERS[operation]]);
        const groupId = uint(params.groupId, 'group ID', 0xffffffffn, 1n), bound = scope(params, context);
        if (!native.available()) fail('UNSUPPORTED', 'QQ lacks the fixed native album transport');
        const task = Promise.resolve().then(async () => {
            if (operation === 'album.listAll') return { operation, groupId, albums: (await listAll(groupId, bound)).map(legacyAlbum), complete: true };
            const request = { groupId, attachInfo: protocol.cursor(params.attachInfo), ...(operation === 'album.media' ? { albumId: protocol.identifier(params.albumId) } : {}) };
            const value = await fixed(operation, request, bound);
            if (operation === 'album.list') return { operation, groupId, albums: value.albums.map(normalizeAlbum), attachInfo: value.attachInfo, hasMore: value.hasMore };
            return { operation, groupId, albumId: request.albumId, mediaList: value.mediaList, nextAttachInfo: value.nextAttachInfo };
        });
        const value = await capture.deadline(() => task, bound.context); bound.check(); return budget(value);
    }
    async function action(params, context = {}) {
        if (!plain(params) || !Object.hasOwn(ACTION_PARAMETERS, Object.getOwnPropertyDescriptor(params, 'operation')?.value)) fail('INVALID_PARAMS', 'Unknown group album mutation');
        const operation = params.operation; fields(params, ['operation', 'expectedEpoch', ...ACTION_PARAMETERS[operation]]);
        const input = { groupId: uint(params.groupId, 'group ID', 0xffffffffn, 1n), albumId: protocol.identifier(params.albumId) };
        const uploading = ['album.uploadImage', 'album.uploadVideo'].includes(operation), type = operation === 'album.uploadVideo' ? 'video' : 'image';
        if (uploading) {
            input.albumName = text(params.albumName, 'album name', 1024, false);
            if (typeof params.file !== 'string' || !params.file.startsWith('base64://') && !require('./media.cjs').RESOURCE.test(params.file)) fail('INVALID_PARAMS', 'Album uploads require account media handles or canonical base64 bytes');
            input.file = params.file;
        } else if (operation === 'album.like') {
            input.batchId = uint(params.batchId, 'album batch ID', 0xffffffffffffffffn, 1n);
            input.lloc = params.lloc === undefined ? '' : text(params.lloc, 'album media location', 1024);
            if (typeof params.isLike !== 'boolean') fail('INVALID_PARAMS', 'Album like requires an explicit boolean'); input.isLike = params.isLike;
        } else {
            input.lloc = protocol.identifier(params.lloc, 'album media location');
            if (operation === 'album.comment') input.content = text(params.content, 'album comment', 4096, false);
        }
        const bound = scope(params, context, uploading ? 60000 : 10000);
        if (!native.available()) fail('UNSUPPORTED', 'QQ lacks the fixed native group album transport');
        if (uploading && !uploader.supported(type)) fail('UNSUPPORTED', 'QQ lacks the required album upload credentials or workspace video decoder');
        const key = JSON.stringify([bound.saved.epoch, bound.saved.uin, input.groupId, input.albumId]);
        if (mutations.has(key) || mutations.size >= 32) fail('BUSY', 'An album mutation still awaits its actual outcome');
        const token = {}; mutations.set(key, token);
        const task = Promise.resolve().then(async () => {
            if (uploading) {
                const albums = await listAll(input.groupId, bound), album = albums.find(value => value.albumId === input.albumId);
                if (!album) fail('NOT_FOUND', 'The requested album does not exist in this group');
                if (album.name !== input.albumName) fail('INVALID_PARAMS', 'album_name differs from the actual target album');
                await collectMedia(input.groupId, input.albumId, bound);
                const uploaded = await uploader.upload(type, input, bound); bound.check();
                if (!plain(uploaded) || uploaded.type !== type || typeof uploaded.mediaId !== 'string' || !uploaded.mediaId || !/^[a-f0-9]{32}$/.test(uploaded.md5 || '') ||
                    !Number.isSafeInteger(uploaded.size) || uploaded.size < 1) fail('INVALID_RESPONSE', 'QQ supplied no complete account media upload acknowledgement');
                for (;;) {
                    const observed = await collectMedia(input.groupId, input.albumId, bound);
                    const matches = observed.filter(value => type === 'image' ? value.image && [value.image.lloc, value.image.sloc].includes(uploaded.mediaId) :
                        value.video?.id === uploaded.mediaId && [value.video.cover?.lloc, value.video.cover?.sloc].includes(uploaded.coverId));
                    if (matches.length > 1) fail('INVALID_RESPONSE', 'Uploaded album media identity is ambiguous');
                    if (matches.length === 1) {
                        if (matches[0].uploader !== bound.saved.uin) fail('INVALID_RESPONSE', 'Uploaded album media belongs to another account');
                        return { operation, groupId: input.groupId, albumId: input.albumId, albumName: input.albumName, mediaId: uploaded.mediaId, type,
                            md5: uploaded.md5, size: uploaded.size, confirmed: true, confirmation: 'media_readback' };
                    }
                    await pause(Math.max(1, Math.min(pollMs, bound.context.expiresAt - Date.now()))); bound.check();
                }
            }
            const values = await collectMedia(input.groupId, input.albumId, bound);
            const item = input.lloc ? uniqueMedia(values, input.lloc) : values.find(value => value.batchId === input.batchId);
            if (!item) fail('NOT_FOUND', 'Album batch was not found in the actual media list');
            const batchId = uint(item.batchId, 'actual album media batch ID', 0xffffffffffffffffn, 1n);
            if (input.batchId !== undefined && input.batchId !== batchId) fail('INVALID_PARAMS', 'Album media does not belong to the supplied batch');
            if (operation === 'album.like') {
                const request = { ...input, uin: bound.saved.uin, clientKey: bound.saved.uin + '_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'), timestamp: String(Date.now()) };
                const result = await fixed(operation, request, bound);
                if (result.confirmed !== true || result.confirmation !== 'target_ack' || result.like?.id !== protocol.cellId(input) || result.like.status !== (input.isLike ? 0 : 1)) fail('INVALID_RESPONSE', 'QQ did not acknowledge the exact album like target and state');
                return { operation, ...input, like: result.like, confirmed: true, confirmation: 'target_ack' };
            }
            const lloc = item.video ? protocol.identifier(item.video.cover?.lloc, 'video cover deletion/comment location') : protocol.identifier(item.image?.lloc, 'photo location');
            if (operation === 'album.delete') {
                const result = await fixed(operation, { groupId: input.groupId, albumId: input.albumId, batchId, mediaId: lloc }, bound);
                if (result.confirmed !== true || result.confirmation !== 'server_ack') fail('INVALID_RESPONSE', 'QQ did not acknowledge album media deletion');
                for (;;) {
                    const observed = await collectMedia(input.groupId, input.albumId, bound);
                    if (!observed.some(value => mediaMatches(value, input.lloc) || mediaMatches(value, lloc))) return { operation, ...input, success: true, confirmed: true, confirmation: 'media_absence' };
                    await pause(Math.max(1, Math.min(pollMs, bound.context.expiresAt - Date.now()))); bound.check();
                }
            }
            const feedRequest = { groupId: input.groupId, albumId: input.albumId, batchId, lloc }, feed = await fixed('album.feed', feedRequest, bound);
            if (!Buffer.isBuffer(feed.rawHeader) || !feed.header?.feedId) fail('INVALID_RESPONSE', 'QQ did not provide the original album feed header');
            const owner = feed.ownerUin || item.uploader;
            const rawUser = feed.rawUser ?? protocol.b(1, protocol.s(13, uint(owner, 'actual album media owner', 0xffffffffn, 1n)));
            const rawMedia = feed.rawMedia ?? protocol.join(protocol.b(1, protocol.join(protocol.n(7, batchId), item.video ? protocol.join(protocol.n(1, 1), protocol.b(3, protocol.b(3, protocol.s(3, lloc)))) : protocol.b(2, protocol.s(3, lloc)))),
                protocol.s(3, input.albumId), protocol.n(5, batchId));
            const request = { groupId: input.groupId, albumId: input.albumId, batchId, lloc, uin: bound.saved.uin, content: input.content, clientKey: String(Date.now()), rawHeader: feed.rawHeader, rawUser, rawMedia };
            const result = await fixed(operation, request, bound), comment = result.comment;
            if (result.confirmed !== true || result.confirmation !== 'authored_comment_ack' || !plain(comment) || typeof comment.id !== 'string' || !comment.id ||
                comment.user?.uin !== bound.saved.uin || comment.clientKey !== request.clientKey || comment.content?.length !== 1 || comment.content[0].type !== 0 || comment.content[0].content !== input.content ||
                typeof comment.time !== 'string' || !/^[1-9]\d{0,19}$/.test(comment.time)) fail('INVALID_RESPONSE', 'QQ returned no exact authored comment acknowledgement');
            return { operation, ...input, comment, confirmed: true, confirmation: 'authored_comment_ack' };
        });
        task.finally(() => { if (mutations.get(key) === token) mutations.delete(key); }).catch(() => {});
        const value = await capture.deadline(() => task, bound.context); bound.check(); return budget(value);
    }
    return { capabilities, query, action };
}
module.exports = { createGroupAlbum, QUERY_PARAMETERS, ACTION_PARAMETERS, normalizeAlbum, legacyAlbum, normalizeCover, MAX_PENDING, MAX_PAGES };
