'use strict';

// QQ NT AlbumService fixed codecs. The common envelope is TRPC protobuf,
// not an OIDB envelope; callers cannot select a service or arbitrary packet.
const p = require('./proto.cjs');
const crypto = require('node:crypto');
const { uint, text, plain } = require('./admin-oidb.cjs');
const MAX_BYTES = 1024 * 1024, MAX_ITEMS = 1000;
const COMMANDS = Object.freeze({ 'album.list': 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList',
    'album.media': 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
    'album.feed': 'QunAlbum.trpc.qzone.webapp_qun_feeds.FeedsReader.GetQunFeedDetail',
    'album.like': 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike',
    'album.comment': 'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment',
    'album.delete': 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias' });
const PARAMETERS = Object.freeze({ 'album.list': ['groupId', 'attachInfo'], 'album.media': ['groupId', 'albumId', 'attachInfo'],
    'album.feed': ['groupId', 'albumId', 'batchId', 'lloc'],
    'album.like': ['groupId', 'albumId', 'batchId', 'lloc', 'isLike', 'uin', 'clientKey', 'timestamp'],
    'album.comment': ['groupId', 'albumId', 'batchId', 'lloc', 'uin', 'content', 'clientKey', 'rawHeader', 'rawUser', 'rawMedia'],
    'album.delete': ['groupId', 'albumId', 'batchId', 'mediaId'] });
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value)), join = (...parts) => Buffer.concat(parts);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('INVALID_PARAMS', 'Unexpected fixed group album parameters');
}
function identifier(value, label = 'album ID') { return text(value, label, 1024, false); }
function cursor(value = '') { return text(value, 'album pagination cursor', 8192); }
function trace() { return '_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex'); }
function cellId(data) {
    const head = '421_1_0_' + data.groupId + '|' + data.albumId + '|' + data.batchId;
    return data.lloc ? head + '^||^421_1_0_' + data.groupId + '|' + data.albumId + '|' + data.lloc + '^||^0' : head;
}
function rawCell(value, required = true) {
    if (value === undefined && !required) return undefined;
    if (!Buffer.isBuffer(value) || !value.length || value.length > 262144) fail('INVALID_PARAMS', 'A verified bounded feed protobuf cell is required');
    map(value); return Buffer.from(value);
}
function prepare(operation, request = {}) {
    if (!Object.hasOwn(COMMANDS, operation)) fail('UNSUPPORTED', 'Unknown fixed group album operation');
    fields(request, PARAMETERS[operation]);
    const data = { groupId: uint(request.groupId, 'group ID', 0xffffffffn, 1n) };
    if (['album.list', 'album.media'].includes(operation)) data.attachInfo = cursor(request.attachInfo);
    if (operation !== 'album.list') data.albumId = identifier(request.albumId);
    if (!['album.list', 'album.media'].includes(operation)) data.batchId = uint(request.batchId, 'album media batch ID', 0xffffffffffffffffn, 1n);
    const ext = b(10, join(s(1, 'fc-appid'), s(2, '100')));
    if (operation === 'album.feed') {
        data.lloc = identifier(request.lloc, 'album media location');
        return { operation, name: COMMANDS[operation], data, body: join(b(2, Buffer.alloc(0)), b(3, Buffer.alloc(0)),
            b(4, join(s(2, data.groupId), n(4, 20), s(6, data.albumId), s(7, data.batchId), s(8, data.lloc))), s(5, trace()), ext) };
    }
    if (operation === 'album.like') {
        data.lloc = request.lloc === undefined ? '' : text(request.lloc, 'album media location', 1024);
        if (typeof request.isLike !== 'boolean') fail('INVALID_PARAMS', 'Album like needs an explicit boolean');
        data.isLike = request.isLike; data.uin = uint(request.uin, 'authenticated album user', 0xffffffffn, 1n);
        data.clientKey = text(request.clientKey, 'album client key', 128, false); data.timestamp = uint(request.timestamp, 'album client time', 0xffffffffffffffffn, 1n);
        const id = cellId(data), publish = join(b(1, join(n(3, data.timestamp), s(4, '422_0_' + data.batchId))), b(2, b(1, s(13, data.uin))),
            b(5, join(s(3, data.albumId), n(5, data.batchId))), b(12, s(1, data.groupId)));
        const body = join(n(1, 5495), s(2, 'h5_test'), s(3, 'h5_test'), b(4, join(n(2, data.isLike ? 2 : 1),
            b(3, join(s(1, id), ...(data.isLike ? [] : [n(3, 1)]))), b(4, publish), s(5, data.clientKey))), ext);
        return { operation, name: COMMANDS[operation], data, body };
    }
    if (operation === 'album.delete') {
        data.mediaId = identifier(request.mediaId, 'album deletion location');
        return { operation, name: COMMANDS[operation], data, body: join(n(1, 8694), s(2, 'h5_test'), s(3, 'h5_test'),
            b(4, join(s(1, data.groupId), s(2, data.albumId), s(3, data.mediaId), s(4, data.batchId))), s(5, trace()), ext) };
    }
    if (operation === 'album.comment') {
        data.lloc = identifier(request.lloc, 'album comment location'); data.uin = uint(request.uin, 'authenticated album user', 0xffffffffn, 1n);
        data.content = text(request.content, 'album comment', 4096, false); data.clientKey = text(request.clientKey, 'album client key', 128, false);
        data.rawHeader = rawCell(request.rawHeader); data.rawUser = rawCell(request.rawUser, false); data.rawMedia = rawCell(request.rawMedia);
        const content = join(b(2, join(s(13, data.uin), n(14, data.uin))), b(3, join(n(1, 0), s(2, data.content))), s(7, data.clientKey));
        return { operation, name: COMMANDS[operation], data, body: join(n(1, 8527), b(2, Buffer.alloc(0)), b(3, Buffer.alloc(0)),
            b(4, join(s(2, data.groupId), n(3, 2), b(4, join(b(1, data.rawHeader), ...(data.rawUser ? [b(2, data.rawUser)] : []), b(5, data.rawMedia))), b(5, content))), s(5, trace()), ext) };
    }
    const content = operation === 'album.list' ? join(s(1, data.groupId), s(2, data.attachInfo)) :
        join(s(1, data.groupId), s(2, data.albumId), ...(data.attachInfo ? [s(5, data.attachInfo)] : []));
    const body = join(...(operation === 'album.list' ? [n(1, 3331), b(2, Buffer.alloc(0)), b(3, Buffer.alloc(0))] : []),
        b(4, content), s(5, trace()), ext);
    return { operation, name: COMMANDS[operation], body, data };
}
function one(map, field, wire, required = false) {
    const values = map.get(field);
    if (!values && !required) return undefined;
    if (!values || values.length !== 1 || values[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed or duplicate group album response field');
    return values[0].value;
}
function map(bytes) { const value = p.fields(bytes); if (value.size > 128 || [...value.values()].reduce((sum, rows) => sum + rows.length, 0) > 4096) fail('INVALID_RESPONSE', 'Group album response has too many fields'); return value; }
function string(bytes, maximum = 8192) {
    try { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (Buffer.byteLength(value) > maximum || value.includes('\0')) throw new Error(); return value; }
    catch { fail('INVALID_RESPONSE', 'Group album response has invalid or oversized UTF-8 text'); }
}
const URL_INFO = { 1: ['url', 'text'], 2: ['width', 'uint'], 3: ['height', 'uint'] };
const PHOTO_URL = { 1: ['spec', 'uint'], 2: ['url', URL_INFO] };
const IMAGE = { 1: ['name', 'text'], 2: ['sloc', 'text'], 3: ['lloc', 'text'], 4: ['photoUrls', PHOTO_URL, true], 5: ['defaultUrl', URL_INFO], 6: ['isGif', 'bool'], 7: ['hasRaw', 'bool'] };
const VIDEO = { 1: ['id', 'text'], 2: ['url', 'text'], 3: ['cover', IMAGE], 4: ['width', 'uint'], 5: ['height', 'uint'], 6: ['videoTime', 'u64'], 7: ['videoUrl', PHOTO_URL, true] };
const MEDIA = { 1: ['type', 'uint'], 2: ['image', IMAGE], 3: ['video', VIDEO], 6: ['uploader', 'text'], 7: ['batchId', 'u64'], 8: ['uploadTime', 'u64'] };
const CREATOR = { 1: ['uid', 'text'], 2: ['nick', 'text'], 5: ['isSweet', 'bool'], 6: ['isSpecial', 'bool'], 7: ['isSuperLike', 'bool'], 8: ['customId', 'text'], 9: ['polyId', 'text'],
    10: ['portrait', 'text'], 11: ['canFollow', 'int'], 12: ['isFollowed', 'int'], 13: ['uin', 'text'], 14: ['dittoUin', 'text'] };
const ALBUM = { 1: ['albumId', 'text'], 2: ['owner', 'text'], 3: ['name', 'text'], 4: ['description', 'text'], 5: ['createTime', 'u64'], 6: ['modifyTime', 'u64'],
    7: ['lastUploadTime', 'u64'], 8: ['uploadNumber', 'u64'], 9: ['cover', MEDIA], 10: ['creator', CREATOR], 11: ['topFlag', 'u64'], 12: ['busiType', 'int'], 13: ['status', 'int'],
    15: ['allowShare', 'bool'], 16: ['isSubscribe', 'bool'], 17: ['bitmap', 'text'], 18: ['isShareAlbum', 'bool'], 20: ['qzAlbumType', 'int'], 23: ['coverType', 'int'], 26: ['defaultDesc', 'text'], 30: ['sortType', 'int'] };
function structured(bytes, schema, depth = 0) {
    if (depth > 8) fail('INVALID_RESPONSE', 'Group album response nesting is too deep');
    const value = map(bytes), output = {};
    for (const [tag, [name, type, repeated]] of Object.entries(schema)) {
        const entries = value.get(Number(tag)); if (!entries) continue;
        if (entries.length > (repeated ? MAX_ITEMS : 1)) fail('INVALID_RESPONSE', 'Group album response contains duplicate or oversized data');
        const parsed = entries.map(entry => {
            const wire = typeof type === 'object' || type === 'text' ? 2 : 0;
            if (entry.wire !== wire) fail('INVALID_RESPONSE', 'Group album response has the wrong protobuf wire type');
            if (typeof type === 'object') return structured(entry.value, type, depth + 1);
            if (type === 'text') return string(entry.value);
            const number = entry.value;
            if (type === 'bool') { if (number > 1n) fail('INVALID_RESPONSE', 'Group album boolean is not canonical'); return number === 1n; }
            if (type === 'u64') return number.toString();
            if (type === 'int') {
                if (number > 0xffffffffn && number < 0xffffffff80000000n) fail('INVALID_RESPONSE', 'Group album signed integer is out of range');
                return Number(BigInt.asIntN(32, number));
            }
            if (number > 0xffffffffn) fail('INVALID_RESPONSE', 'Group album integer is out of range'); return Number(number);
        });
        output[name] = repeated ? parsed : parsed[0];
    }
    return output;
}
function budget(value) { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('INVALID_RESPONSE', 'Group album JSON response exceeds its byte budget'); return value; }
function repeated(value, field, schema) {
    const entries = value.get(field) || [];
    if (entries.length > MAX_ITEMS || entries.some(entry => entry.wire !== 2)) fail('INVALID_RESPONSE', 'Group album list is malformed or exceeds its item limit');
    return entries.map(entry => structured(entry.value, schema));
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('INVALID_RESPONSE', 'QQ supplied no bounded group album response');
    const operation = prepared.operation, root = map(bytes), resultCode = operation === 'album.like' ? 0n : one(root, operation === 'album.media' ? 1 : 2, 0) ?? 0n;
    if (resultCode !== 0n) fail('KERNEL_ERROR', 'QQ rejected the group album query; it was not retried');
    const input = prepared.data, result = { operation, ...Object.fromEntries(Object.entries(input).filter(([key]) => !['rawHeader', 'rawUser', 'rawMedia'].includes(key))) };
    if (operation === 'album.delete') {
        if (one(root, 1, 0, true) !== 8694n) fail('INVALID_RESPONSE', 'Album deletion response has an unrelated sequence');
        return { ...result, confirmed: true, confirmation: 'server_ack' };
    }
    if (operation === 'album.like') {
        if (one(root, 1, 0, true) !== 5495n) fail('INVALID_RESPONSE', 'Album like response has an unrelated sequence');
        const data = map(one(root, 4, 2, true)), like = map(one(data, 2, 2, true));
        const id = string(one(like, 1, 2, true)), status = one(like, 3, 0) ?? 0n;
        if (id !== cellId(input) || status !== (input.isLike ? 0n : 1n)) fail('INVALID_RESPONSE', 'QQ acknowledged another album like target or state');
        return { ...result, like: { id, status: Number(status) }, confirmed: true, confirmation: 'target_ack' };
    }
    if (operation === 'album.feed') {
        const data = map(one(root, 4, 2, true)), client = map(one(data, 2, 2, true)), feed = map(one(client, 1, 2, true));
        const rawHeader = one(feed, 1, 2, true), rawUser = one(feed, 2, 2), rawMedia = one(feed, 5, 2);
        const header = structured(rawHeader, { 1: ['type', 'uint'], 3: ['time', 'u64'], 4: ['feedId', 'text'], 5: ['cellId', 'text'], 6: ['field6', 'uint'] });
        if (!header.feedId || header.cellId && header.cellId !== cellId(input)) fail('INVALID_RESPONSE', 'QQ returned no matching album feed locator');
        let ownerUin = '';
        if (rawUser) { const user = map(one(map(rawUser), 1, 2, true)); ownerUin = string(one(user, 13, 2, true)); if (!/^[1-9]\d{0,9}$/.test(ownerUin) || BigInt(ownerUin) > 0xffffffffn) fail('INVALID_RESPONSE', 'QQ album feed has an invalid owner'); }
        if (rawMedia) {
            const media = structured(rawMedia, { 1: ['medias', MEDIA, true], 3: ['albumId', 'text'], 5: ['batchId', 'u64'] });
            if (media.albumId !== undefined && media.albumId !== input.albumId || media.batchId !== undefined && media.batchId !== input.batchId) fail('INVALID_RESPONSE', 'QQ feed media belongs to another album or batch');
        }
        if (feed.has(12)) { const qun = map(one(feed, 12, 2)); if (string(one(qun, 1, 2, true)) !== input.groupId) fail('INVALID_RESPONSE', 'QQ feed belongs to another group'); }
        return budget({ ...result, header, ownerUin, rawHeader: Buffer.from(rawHeader), ...(rawUser ? { rawUser: Buffer.from(rawUser) } : {}), ...(rawMedia ? { rawMedia: Buffer.from(rawMedia) } : {}) });
    }
    if (operation === 'album.comment') {
        if (one(root, 1, 0, true) !== 8527n) fail('INVALID_RESPONSE', 'Album comment response has an unrelated sequence');
        const wrapped = map(one(root, 4, 2, true)), rawData = one(wrapped, 2, 2), data = rawData === undefined ? wrapped : map(rawData);
        // Current and older QQ builds place these cells either inside data or
        // alongside the wrapper ID. Every field still comes from the server.
        const id = string(one(data, 1, 2) ?? one(wrapped, 1, 2, true)), user = rawData === undefined ? null : map(one(data, 2, 2, true));
        const content = repeated(data.has(3) ? data : wrapped, 3, { 1: ['type', 'uint'], 2: ['content', 'text'] });
        const uin = user ? string(one(user, 13, 2, true)) : '', time = one(data, 4, 0) ?? one(wrapped, 4, 0, true),
            clientKey = string(one(data, 7, 2) ?? one(wrapped, 7, 2, true));
        if (!id || !time || uin !== input.uin || clientKey !== input.clientKey || content.length !== 1 || (content[0].type ?? 0) !== 0 || content[0].content !== input.content) fail('INVALID_RESPONSE', 'QQ did not return the exact authored album comment');
        return budget({ ...result, comment: { id, user: { uin }, content: [{ type: 0, content: content[0].content }], time: time.toString(), clientKey }, confirmed: true, confirmation: 'authored_comment_ack' });
    }
    if (operation === 'album.list' && root.has(1) && one(root, 1, 0) !== 3331n) fail('INVALID_RESPONSE', 'Group album response has an unrelated sequence');
    const data = map(one(root, 4, 2, true));
    if (prepared.operation === 'album.list') {
        result.albums = repeated(data, 1, ALBUM); result.attachInfo = string(one(data, 2, 2) ?? Buffer.alloc(0));
        const more = one(data, 3, 0) ?? 0n; if (more > 1n) fail('INVALID_RESPONSE', 'Group album pagination flag is invalid'); result.hasMore = more === 1n;
        const ids = result.albums.map(album => album.albumId);
        if (ids.some(id => typeof id !== 'string' || !id.length || Buffer.byteLength(id) > 1024) || new Set(ids).size !== ids.length) fail('INVALID_RESPONSE', 'QQ returned duplicate or unidentified group albums');
        if (result.hasMore && (!result.attachInfo || result.attachInfo === prepared.data.attachInfo)) fail('INVALID_RESPONSE', 'Group album pagination did not advance');
    } else {
        if (data.has(1)) {
            const info = structured(one(data, 1, 2), { 1: ['albumId', 'text'], 2: ['owner', 'text'], 3: ['name', 'text'] });
            if (info.albumId !== undefined && info.albumId !== prepared.data.albumId) fail('INVALID_RESPONSE', 'Album media response belongs to another album');
        }
        result.mediaList = repeated(data, 3, MEDIA); result.nextAttachInfo = string(one(data, 5, 2) ?? Buffer.alloc(0));
        if (result.nextAttachInfo && result.nextAttachInfo === prepared.data.attachInfo) fail('INVALID_RESPONSE', 'Album media pagination did not advance');
        const identities = result.mediaList.map(item => item.video?.id || item.image?.lloc);
        if (identities.some(id => typeof id !== 'string' || !id.length) || new Set(identities).size !== identities.length) fail('INVALID_RESPONSE', 'QQ returned duplicate or unidentified album media');
    }
    return budget(result);
}
module.exports = { COMMANDS, PARAMETERS, prepare, decode, fields, identifier, cursor, uint, text, plain, budget, fail, structured, one, map,
    MAX_BYTES, MAX_ITEMS, ALBUM, CREATOR, MEDIA, IMAGE, VIDEO, n, b, s, join, cellId };
