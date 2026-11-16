'use strict';

// The only Web destinations in this module are QQ's fixed login and album
// slice-upload services. Cookies and upload sessions never leave the worker.
const crypto = require('node:crypto');
const fs = require('node:fs');
const media = require('./media.cjs');
const { plain, text, uint, fail } = require('./group-album-protocol.cjs');
const MAX_JSON = 65536, DEFAULT_SLICE = 16384, MAX_SLICES = 4096;
const COOKIE_NAMES = new Set(['uin', 'p_uin', 'skey', 'p_skey', 'pt4_token', 'ptcz', 'pt2gguin', 'ptisp', 'RK']);
const credential = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x3a\x3c-\x7e]+$/.test(value);
const sameAccount = (value, uin) => typeof value === 'string' && /^o?\d{1,15}$/.test(value) && BigInt(value.replace(/^o/, '')) === BigInt(uin);
function hash(value) { let result = 5381; for (const char of value) result = (Math.imul(result, 33) + char.charCodeAt(0)) | 0; return String(result & 0x7fffffff); }
function digest(bytes, algorithm) { return crypto.createHash(algorithm).update(bytes).digest('hex'); }
function remoteText(value, label, maximum) { try { return text(value, label, maximum, false); } catch { fail('INVALID_RESPONSE', 'QQ supplied no valid ' + label); } }
function source(file, directory, type) {
    const maximum = type === 'image' ? media.MAX_IMAGE_BYTES : media.MAX_VIDEO_BYTES;
    if (typeof file !== 'string') fail('INVALID_PARAMS', 'Album upload requires an account media handle or canonical base64 bytes');
    if (media.RESOURCE.test(file)) {
        const info = media.resourceInfo(directory, file);
        if (info.type !== type) fail('INVALID_PARAMS', 'Album upload media handle has another type');
        return { ...media.readNativeMedia(type, info.path, [directory]), file: info.path, temporary: false };
    }
    if (!file.startsWith('base64://')) fail('INVALID_PARAMS', 'Album upload cannot read paths, URLs or external media');
    media.privateRoot(directory);
    if (file.length - 9 > 4 * Math.ceil(maximum / 3)) fail('INVALID_PARAMS', 'Album base64 input exceeds its encoded byte budget');
    const encoded = file.slice(9);
    if (!encoded.length || encoded.length % 4 || encoded.length > 4 * Math.ceil(maximum / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('INVALID_PARAMS', 'Invalid or oversized canonical album base64 bytes');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== encoded) fail('INVALID_PARAMS', 'Invalid album base64 padding or byte limit');
    const info = media.mediaInfo(type, bytes);
    return { bytes, ...info, md5: digest(bytes, 'md5'), temporary: false };
}
function createAlbumUpload(capture, { fetchImpl = globalThis.fetch } = {}) {
    let uploading = false;
    function supported(type = 'image') { return typeof fetchImpl === 'function' && typeof capture.mediaDirectory === 'string' && capture.hasMethods?.('ticket', ['forceFetchClientKey']) === true &&
        (type !== 'video' || capture.video?.available() === true); }
    async function request(target, options, bound, maximum = MAX_JSON) {
        bound.check();
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(10000, bound.context.expiresAt - Date.now()))),
            signal = bound.context.signal ? AbortSignal.any([bound.context.signal, timeout]) : timeout;
        let response;
        try {
            response = await fetchImpl(target, { ...options, redirect: 'manual', credentials: 'omit', signal }); bound.check();
            if (response.redirected || response.url && response.url !== target) fail('INVALID_RESPONSE', 'QQ album Web response left its fixed request destination');
            const chunks = []; let size = 0;
            if (response.body) for await (const chunk of response.body) {
                bound.check(); size += chunk.length;
                if (size > maximum) fail('INVALID_RESPONSE', 'QQ album Web response exceeded its byte budget'); chunks.push(Buffer.from(chunk));
            }
            bound.check(); return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks), redirected: response.redirected, url: response.url };
        } catch (error) {
            Promise.resolve(response?.body?.cancel?.()).catch(() => {}); bound.check();
            if (['INVALID_RESPONSE', 'SESSION_CHANGED', 'EXPIRED'].includes(error.code)) throw error;
            fail(signal.aborted ? 'TIMEOUT' : 'QUERY_FAILED', 'QQ album Web request failed; no upload was retried');
        }
    }
    async function authenticate(bound) {
        const uin = bound.saved.uin, ticket = await capture.invoke('ticket', 'forceFetchClientKey', ['']); bound.check();
        if (ticket?.result !== 0 || !credential(ticket.clientKey) || typeof ticket.keyIndex !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(ticket.keyIndex) || BigInt(ticket.keyIndex) > 0xffffffffn) fail('AUTH_FAILED', 'QQ supplied no valid album login ticket');
        let current = new URL('https://ssl.ptlogin2.qq.com/jump');
        current.search = new URLSearchParams({ ptlang: '1033', clientuin: uin, clientkey: ticket.clientKey, u1: 'https://qzone.qq.com/' + uin + '/infocenter', keyindex: ticket.keyIndex }).toString();
        const jar = new Map(), visited = new Set();
        const select = target => {
            const output = {};
            const selected = [...jar.values()].filter(item => item.expires > Date.now() && (item.hostOnly ? target.hostname === item.domain : target.hostname === item.domain || target.hostname.endsWith('.' + item.domain)) &&
                (target.pathname === item.path || target.pathname.startsWith(item.path) && (item.path.endsWith('/') || target.pathname[item.path.length] === '/')));
            selected.sort((a, b) => b.path.length - a.path.length || b.domain.length - a.domain.length);
            for (const item of selected) if (!Object.hasOwn(output, item.name)) output[item.name] = item.value;
            return output;
        };
        const cookie = values => Object.entries(values).map(([key, value]) => key + '=' + value).join('; ');
        for (let step = 0; ; step++) {
            if (visited.has(current.href)) fail('INVALID_RESPONSE', 'QQ album authentication redirect loop'); visited.add(current.href);
            const response = await request(current.href, { headers: { Cookie: cookie(select(current)), 'User-Agent': 'Freshwater/0.2' } }, bound);
            const cookies = response.headers.getSetCookie?.() || (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
            if (cookies.length > 100) fail('INVALID_RESPONSE', 'QQ supplied too many album login cookies');
            for (const raw of cookies) {
                if (raw.length > 8192 || /[\r\n]/.test(raw)) fail('INVALID_RESPONSE', 'Malformed QQ album login cookie');
                const [pair, ...attributes] = raw.split(';'), equal = pair.indexOf('='); if (equal < 1) continue;
                const name = pair.slice(0, equal).trim(), value = pair.slice(equal + 1).trim(); if (!COOKIE_NAMES.has(name)) continue;
                if (value && !credential(value)) fail('INVALID_RESPONSE', 'Malformed QQ album login credential');
                let domain = current.hostname, hostOnly = true, path = current.pathname.slice(0, current.pathname.lastIndexOf('/')) || '/', expires = Infinity, maxAge;
                for (const attribute of attributes) {
                    const index = attribute.indexOf('='), key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase(), data = index < 0 ? '' : attribute.slice(index + 1).trim();
                    if (key === 'domain') { domain = data.replace(/^\./, '').toLowerCase(); hostOnly = false; }
                    if (key === 'path' && data.startsWith('/')) path = data;
                    if (key === 'expires' && Number.isFinite(Date.parse(data))) expires = Date.parse(data);
                    if (key === 'max-age') { if (!/^-?\d{1,10}$/.test(data)) fail('INVALID_RESPONSE', 'Invalid QQ album cookie expiry'); maxAge = Number(data); }
                }
                if (!(domain === 'qq.com' || domain.endsWith('.qq.com')) || !(current.hostname === domain || current.hostname.endsWith('.' + domain))) continue;
                if (maxAge !== undefined) expires = Date.now() + maxAge * 1000;
                const key = [name, domain, path].join('\0');
                if (!value || expires <= Date.now()) jar.delete(key); else jar.set(key, { name, value, domain, path, expires, hostOnly });
                if (jar.size > 100) fail('INVALID_RESPONSE', 'QQ album login cookie budget exceeded');
            }
            if (![301, 302, 303, 307, 308].includes(response.status)) {
                if (response.status !== 200 || current.hostname !== 'qzone.qq.com') fail('AUTH_FAILED', 'QQ album login did not reach the fixed Qzone destination'); break;
            }
            const location = response.headers.get('location'); if (step >= 3 || !location || location.length > 8192) fail('INVALID_RESPONSE', 'QQ album login redirect budget exceeded');
            let next; try { next = new URL(location, current); } catch { fail('INVALID_RESPONSE', 'Malformed QQ album login redirect'); }
            const check = next.hostname === 'ptlogin2.qzone.qq.com' && next.pathname === '/check_sig' && ['ssl.ptlogin2.qq.com', 'ptlogin2.qzone.qq.com'].includes(current.hostname);
            if (next.protocol !== 'https:' || next.username || next.password || next.port && next.port !== '443' || !(['ssl.ptlogin2.qq.com', 'qzone.qq.com'].includes(next.hostname) || check)) fail('INVALID_RESPONSE', 'QQ album login left its fixed destinations');
            if (check && next.searchParams.has('uin') && (next.searchParams.getAll('uin').length !== 1 || !sameAccount(next.searchParams.get('uin'), uin))) fail('AUTH_FAILED', 'QQ album login redirect belongs to another account');
            current = next;
        }
        const values = select(new URL('https://qzone.qq.com/'));
        if (![values.uin, values.p_uin].some(value => sameAccount(value, uin)) || [values.uin, values.p_uin].some(value => value !== undefined && !sameAccount(value, uin)) || !credential(values.skey)) fail('AUTH_FAILED', 'QQ album credentials do not match the authenticated account');
        if (!values.p_skey && capture.hasMethods('tipOff', ['getPskey'])) {
            const result = await capture.invoke('tipOff', 'getPskey', [['qzone.qq.com'], true]); bound.check();
            if (result?.result !== 0 || !(result.domainPskeyMap instanceof Map)) fail('AUTH_FAILED', 'QQ supplied no Qzone domain key'); values.p_skey = result.domainPskeyMap.get('qzone.qq.com');
        }
        if (!credential(values.p_skey)) fail('AUTH_FAILED', 'QQ supplied no authenticated Qzone upload key');
        return { skey: values.skey, pskey: values.p_skey, cookie: 'p_uin=o' + uin + '; p_skey=' + values.p_skey + '; skey=' + values.skey + '; uin=o' + uin };
    }
    async function json(target, options, bound) {
        const response = await request(target, options, bound);
        if (response.status !== 200 || response.redirected || response.url && response.url !== target) fail('QUERY_FAILED', 'QQ album upload returned a redirect or non-success HTTP status');
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes), (_key, data) => { if (typeof data === 'number' && (!Number.isFinite(data) || Number.isInteger(data) && !Number.isSafeInteger(data))) throw new Error(); return data; }); }
        catch { fail('INVALID_RESPONSE', 'QQ album upload returned no exact JSON acknowledgement'); }
        if (!plain(value) || value.ret !== 0) fail('KERNEL_ERROR', 'QQ rejected the album upload; no slice was retried'); return value;
    }
    async function control(bytes, auth, bound, request) {
        const target = 'https://h5.qzone.qq.com/webapp/json/sliceUpload/FileBatchControl/' + request.checksum + '?g_tk=' + hash(request.appid === 'video_qun' || request.biz_req.iUploadType === 2 ? auth.pskey : auth.skey);
        const value = await json(target, { method: 'POST', headers: { Cookie: auth.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ control_req: [request] }) }, bound);
        const session = remoteText(value.data?.session, 'QQ album upload session', 8192), configured = value.data?.slice_size;
        const sliceSize = request.appid === 'qun' && request.biz_req.iUploadType === 0 ? DEFAULT_SLICE : configured === undefined ? DEFAULT_SLICE : configured;
        if (!Number.isInteger(sliceSize) || sliceSize < 1 || sliceSize > 1024 * 1024 || Math.ceil(bytes.length / sliceSize) > MAX_SLICES) fail('INVALID_RESPONSE', 'QQ album upload slice configuration exceeds its budget');
        return { session, sliceSize };
    }
    async function slices(bytes, session, auth, bound, appid, command, checkType, image = false) {
        let offset = 0, sequence = 0, finalBiz;
        const gtk = hash(image ? auth.skey : auth.pskey);
        while (offset < bytes.length) {
            bound.check(); const chunk = bytes.subarray(offset, Math.min(offset + session.sliceSize, bytes.length)), end = offset + chunk.length;
            const form = new FormData(), values = { uin: bound.saved.uin, appid, session: session.session, offset, checksum: '', check_type: checkType, retry: 0, seq: sequence, end, cmd: 'FileUpload', slice_size: image ? DEFAULT_SLICE : chunk.length };
            for (const [key, value] of Object.entries(values)) form.append(key, String(value));
            form.append('data', new Blob([chunk], { type: 'application/octet-stream' }), 'blob'); if (image) form.append('biz_req.iUploadType', '0');
            const target = 'https://h5.qzone.qq.com/webapp/json/sliceUpload/' + command + '?' + new URLSearchParams({ seq: String(sequence), retry: '0', offset: String(offset), end: String(end), total: String(bytes.length), type: 'form', g_tk: gtk });
            const ack = await json(target, { method: 'POST', headers: { Cookie: auth.cookie }, body: form }, bound);
            if (ack.data?.session !== undefined && ack.data.session !== session.session) fail('INVALID_RESPONSE', 'QQ acknowledged another album upload session');
            for (const [key, expected] of [['offset', offset], ['end', end], ['seq', sequence]]) if (ack.data?.[key] !== undefined && ack.data[key] !== expected) fail('INVALID_RESPONSE', 'QQ acknowledged another album upload slice');
            if (end === bytes.length) finalBiz = ack.data?.biz;
            offset = end; sequence++;
        }
        if (!bytes.length || offset !== bytes.length || !plain(finalBiz)) fail('INVALID_RESPONSE', 'QQ supplied no final complete album upload acknowledgement');
        return finalBiz;
    }
    function baseControl(input, auth, bound, bytes, appid, checksum, checkType, timestamp, type, name, refer = 'qzone') {
        return { uin: bound.saved.uin, token: { type: 4, data: auth.pskey, appid: 5 }, appid, checksum, check_type: checkType, file_len: bytes.length, env: { refer, deviceInfo: 'h5' }, model: 0,
            biz_req: { sPicTitle: name, sPicDesc: '', sAlbumName: input.albumName, sAlbumID: input.albumId, iAlbumTypeID: 0, iBitmap: 0, iUploadType: type, iUpPicType: 0,
                iBatchID: timestamp, sPicPath: '', iPicWidth: 0, iPicHight: 0, iWaterType: 0, iDistinctUse: 0, iNeedFeeds: 1, iUploadTime: timestamp,
                mapExt: { appid: 'qun', userid: input.groupId }, stExtendInfo: { mapParams: { photo_num: '1', video_num: '0', batch_num: '1' } } }, session: '', asy_upload: 0, cmd: 'FileUpload' };
    }
    async function upload(type, input, bound) {
        if (!supported(type)) fail('UNSUPPORTED', type === 'video' ? 'Album video upload requires the workspace video decoder and QQ Web ticket service' : 'Album image upload requires QQ Web tickets and an account media directory');
        if (!['image', 'video'].includes(type)) fail('INVALID_PARAMS', 'Unknown album upload media type');
        if (uploading) fail('BUSY', 'An album upload still awaits its actual outcome');
        uploading = true; let temporary;
        try {
            bound.check(); const image = source(input.file, capture.mediaDirectory, type);
            let video;
            if (type === 'video') {
                if (image.extension !== 'mp4') fail('UNSUPPORTED', 'Album video upload requires a supported complete MP4');
                let file = image.file;
                if (!file) { const staged = media.exportMedia(capture.mediaDirectory, 'video', image.bytes); file = staged.path; temporary = file; }
                video = await capture.video.prepare(file, bound.context); bound.check();
                if (!Buffer.isBuffer(video.bytes) || !video.bytes.equals(image.bytes) || !Buffer.isBuffer(video.thumbnail?.bytes) || !Number.isFinite(video.durationSeconds) || video.durationSeconds <= 0) fail('INVALID_RESPONSE', 'QQ album video preparation produced no exact source and real thumbnail');
                media.imageInfo(video.thumbnail.bytes);
            }
            const auth = await authenticate(bound), timestamp = Math.floor(Date.now() / 1000);
            if (type === 'image') {
                const request = baseControl(input, auth, bound, image.bytes, 'qun', image.md5, 0, timestamp, 0, 'image.' + image.extension);
                const session = await control(image.bytes, auth, bound, request), biz = await slices(image.bytes, session, auth, bound, 'qun', 'FileUpload', 0, true);
                return { type, mediaId: remoteText(biz.sPhotoID, 'QQ uploaded photo ID', 1024), md5: image.md5, size: image.bytes.length };
            }
            const sha1 = digest(image.bytes, 'sha1'), request = baseControl(input, auth, bound, image.bytes, 'video_qun', sha1, 1, timestamp, 3, 'video.mp4');
            Object.assign(request.biz_req, { sAlbumName: '', sAlbumID: '', iBatchID: 0, sTitle: 'video.mp4', sDesc: '', iFlag: 0, iPlayTime: video.durationSeconds * 1000, sCoverUrl: '', iIsNew: 111,
                iIsOriginalVideo: 0, iIsFormatF20: 0, extend_info: { video_type: '3', domainid: '5', photo_num: '0', video_num: '1', qun_id: input.groupId } });
            delete request.biz_req.iNeedFeeds; delete request.biz_req.mapExt; delete request.biz_req.stExtendInfo; request.cmd = 'FileUploadVideo';
            const videoSession = await control(image.bytes, auth, bound, request), videoBiz = await slices(image.bytes, videoSession, auth, bound, 'video_qun', 'FileUploadVideo', 1);
            const id = remoteText(videoBiz.sVid, 'QQ uploaded video ID', 1024), cover = video.thumbnail.bytes, coverMd5 = digest(cover, 'md5');
            const coverRequest = baseControl(input, auth, bound, cover, 'qun', coverMd5, 0, timestamp, 2, 'video.mp4', 'huodong');
            coverRequest.cmd = ''; Object.assign(coverRequest.biz_req, { mutliPicInfo: { iBatUploadNum: 1, iCurUpload: 0, iSuccNum: 0, iFailNum: 0 },
                stExtendInfo: { mapParams: { vid: id, photo_num: '0', video_num: '1' } }, stExternalMapExt: { is_client_upload_cover: '1', is_pic_video_mix_feeds: '1' },
                sExif_CameraMaker: '', sExif_CameraModel: '', sExif_Time: '', sExif_LatitudeRef: '', sExif_Latitude: '', sExif_LongitudeRef: '', sExif_Longitude: '' });
            const coverSession = await control(cover, auth, bound, coverRequest), coverBiz = await slices(cover, coverSession, auth, bound, 'qun', 'FileUpload', 0);
            const coverId = remoteText(coverBiz.sPhotoID, 'QQ uploaded video cover ID', 1024), coverUrl = remoteText(coverBiz.sBURL, 'QQ uploaded video cover URL', 8192);
            let url; try { url = new URL(coverUrl); } catch { fail('INVALID_RESPONSE', 'QQ returned no absolute video cover URL'); }
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f]/.test(coverUrl)) fail('INVALID_RESPONSE', 'QQ returned an invalid video cover URL');
            return { type, mediaId: id, coverId, md5: image.md5, sha1, size: image.bytes.length };
        } finally { uploading = false; if (temporary) try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') capture.diagnostic?.(Object.assign(new Error('Album video staging cleanup failed'), { code: 'MEDIA_CLEANUP' })); } }
    }
    return { supported, upload };
}
module.exports = { createAlbumUpload, source, DEFAULT_SLICE, MAX_SLICES, MAX_JSON };
