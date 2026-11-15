'use strict';

const { performance } = require('node:perf_hooks');
const { normalizeMusicData } = require('./qq/music.cjs');

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function numericId(value) {
    const input = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    return typeof input === 'string' && /^[1-9]\d*$/.test(input) && Number.isSafeInteger(Number(input)) ? input : null;
}
function name(value, field, maximum = 1024) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
        throw problem('INVALID_RESPONSE', 'Music metadata has an invalid ' + field);
    }
    return value;
}
function singers(values) {
    if (!Array.isArray(values) || values.length === 0 || values.length > 64) throw problem('INVALID_RESPONSE', 'Music metadata has no valid artist list');
    return name(values.map(value => name(value?.name, 'artist name')).join('/'), 'artists', 2048);
}
function webUrl(input, field) {
    let url;
    try { url = new URL(input); } catch { throw problem('INVALID_RESPONSE', 'Music metadata has an invalid ' + field); }
    if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\x7f]/.test(input) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname) {
        throw problem('INVALID_RESPONSE', 'Music metadata has an invalid ' + field);
    }
    return url.href;
}
function playbackUrl(input, platform) {
    const url = new URL(webUrl(input, 'playback URL'));
    const allowed = platform === 'netease' ? ['music.126.net', 'music.163.com'] : ['qqmusic.qq.com', 'tc.qq.com'];
    if (url.port || !allowed.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) {
        throw problem('INVALID_RESPONSE', 'Music service returned an unexpected playback host');
    }
    return url.href;
}
function select(values, key, id, label) {
    if (!Array.isArray(values) || values.length > 16 || values.some(value => !record(value))) throw problem('INVALID_RESPONSE', 'Music service returned invalid ' + label);
    if (values.length === 0) throw problem('NOT_FOUND', 'Music service did not find the requested song');
    const matches = values.filter(value => String(value[key]) === id);
    if (matches.length !== 1) throw problem('INVALID_RESPONSE', 'Music service returned a different or ambiguous song');
    return matches[0];
}
function qqUrl(module, method, param) {
    const payload = { comm: { ct: 24, cv: 0, uin: '0' }, req_0: { module, method, param } };
    return 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(payload));
}
function qqData(response) {
    if (!record(response) || response.code !== 0 || response.req_0?.code !== 0 || !record(response.req_0.data)) {
        throw problem('INVALID_RESPONSE', 'QQ Music did not return a successful metadata response');
    }
    return response.req_0.data;
}

// Only public metadata and anonymous playback endpoints are queried. QQ login
// credentials, signing keys and test-file URLs never enter this resolver.
async function resolveMusic(data, { requestJson, timeoutMs = 15000 } = {}) {
    const normalized = normalizeMusicData(data);
    if (!['qq', '163'].includes(normalized.type)) throw problem('INVALID_PARAMS', 'Music resolution requires a QQ Music or NetEase song ID');
    if (typeof requestJson !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
        throw new TypeError('Invalid music resolver request client or time budget');
    }
    const id = normalized.id, numeric = numericId(id);
    if (normalized.type === '163' && !numeric || normalized.type === 'qq' && !numeric && !/^[A-Za-z0-9]{14}$/.test(id)) {
        throw problem('INVALID_PARAMS', 'Invalid platform song ID');
    }
    const deadline = performance.now() + timeoutMs;
    async function read(url, referer) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw problem('TIMEOUT', 'Music metadata resolution exceeded its total time budget');
        let timer;
        try {
            return await Promise.race([
                Promise.resolve().then(() => requestJson(url, { method: 'GET', headers: {
                    Referer: referer, 'User-Agent': 'Mozilla/5.0 (compatible; Freshwater-dolphin)' } }, remaining)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(problem('TIMEOUT', 'Music metadata resolution exceeded its total time budget')), remaining); })
            ]);
        } finally { clearTimeout(timer); }
    }
    let metadata;
    if (normalized.type === '163') {
        const ids = encodeURIComponent(JSON.stringify([Number(numeric)]));
        const detail = await read('https://music.163.com/api/song/detail/?id=' + id + '&ids=' + ids, 'https://music.163.com/');
        if (detail?.code !== 200) throw problem('INVALID_RESPONSE', 'NetEase Music did not return song metadata');
        const song = select(detail.songs, 'id', id, 'song metadata');
        const title = name(song.name, 'song title'), content = singers(song.artists);
        const image = song.album?.picUrl ? webUrl(song.album.picUrl, 'album image') : '';
        const player = await read('https://music.163.com/api/song/enhance/player/url?ids=' + ids + '&br=128000', 'https://music.163.com/');
        if (player?.code !== 200) throw problem('INVALID_RESPONSE', 'NetEase Music did not return playback information');
        const track = select(player.data, 'id', id, 'playback information');
        if (track.code !== 200 || !track.url || track.freeTrialInfo != null) {
            throw problem('UNSUPPORTED', 'NetEase Music does not permit anonymous full playback of this song; it may be paid, region-restricted or unavailable');
        }
        metadata = { type: 'custom', title, content, image, url: 'https://music.163.com/song?id=' + id,
            audio: playbackUrl(track.url, 'netease') };
    } else {
        const detail = qqData(await read(qqUrl('music.pf_song_detail_svr', 'get_song_detail',
            numeric ? { song_id: Number(numeric) } : { song_mid: id }), 'https://y.qq.com/'));
        const song = detail.track_info;
        if (!record(song) || !numericId(song.id) || !/^[A-Za-z0-9]{14}$/.test(song.mid || '') ||
            (numeric ? String(song.id) !== id : song.mid !== id)) throw problem('INVALID_RESPONSE', 'QQ Music returned a different song');
        const title = name(song.name, 'song title'), content = singers(song.singer), albumMid = song.album?.mid;
        if (albumMid !== undefined && albumMid !== '' && (typeof albumMid !== 'string' || !/^[A-Za-z0-9]{14}$/.test(albumMid))) {
            throw problem('INVALID_RESPONSE', 'QQ Music returned an invalid album identity');
        }
        const player = qqData(await read(qqUrl('vkey.GetVkeyServer', 'CgiGetVkey', {
            guid: String(Date.now()), songmid: [song.mid], songtype: [0], uin: '0', loginflag: 1, platform: '20'
        }), 'https://y.qq.com/'));
        if (player.retcode !== 0) throw problem('INVALID_RESPONSE', 'QQ Music did not return playback information');
        const track = select(player.midurlinfo, 'songmid', song.mid, 'playback information');
        if (track.result !== 0 || typeof track.purl !== 'string' || !track.purl) {
            throw problem('UNSUPPORTED', 'QQ Music does not permit anonymous playback of this song; it may require membership, payment or regional access');
        }
        if (!Array.isArray(player.sip) || !player.sip.length || player.sip.length > 16) throw problem('INVALID_RESPONSE', 'QQ Music did not return a playback server');
        const base = playbackUrl(player.sip[0], 'qq');
        let audio;
        try { audio = new URL(track.purl, base).href; } catch { throw problem('INVALID_RESPONSE', 'QQ Music returned an invalid playback path'); }
        metadata = { type: 'custom', title, content,
            image: albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : '',
            url: 'https://y.qq.com/n/ryqq/songDetail/' + song.mid, audio: playbackUrl(audio, 'qq') };
    }
    if (performance.now() >= deadline) throw problem('TIMEOUT', 'Music metadata resolution exceeded its total time budget');
    try { metadata = normalizeMusicData(metadata); } catch { throw problem('INVALID_RESPONSE', 'Music service returned invalid song metadata'); }
    return { ...metadata, platform: normalized.type === '163' ? 'netease' : 'qq' };
}

module.exports = { resolveMusic };
