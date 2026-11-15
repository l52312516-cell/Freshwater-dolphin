'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMusic } = require('../src/music-resolver.cjs');

const netease = { code: 200, songs: [{ id: 29005614, name: 'Cielo', artists: [{ name: 'Sky' }],
    album: { picUrl: 'https://p1.music.126.net/album.jpg' }, fee: 0 }] };
const neteasePlayer = { code: 200, data: [{ id: 29005614, code: 200, url: 'http://m701.music.126.net/music/song.mp3?expiry=test', freeTrialInfo: null }] };
const qqSong = { id: 740247871, mid: '0029REsA06tOwE', name: 'Reno My Color', singer: [{ name: 'Artist One' }, { name: 'Artist Two' }],
    album: { mid: '000MkMni19ClKG' }, pay: { pay_play: 0 } };
function qqDetail(song = qqSong) { return { code: 0, req_0: { code: 0, data: { track_info: song } } }; }
const qqPlayer = { code: 0, req_0: { code: 0, data: { retcode: 0, sip: ['http://aqqmusic.tc.qq.com/'],
    testfilewifi: 'different-song.m4a', midurlinfo: [{ songmid: qqSong.mid, result: 0, purl: 'C400real.m4a?vkey=temporary' }] } } };
function client(responses) {
    const requests = [];
    return { requests, requestJson: async (url, options, timeoutMs) => {
        requests.push({ url, options, timeoutMs });
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return structuredClone(response);
    } };
}

test('NetEase IDs resolve genuine metadata and matching anonymous playback without changing signed URL bytes', async () => {
    const c = client([netease, neteasePlayer]);
    const result = await resolveMusic({ type: '163', id: '29005614' }, c);
    assert.deepEqual(result, { type: 'custom', title: 'Cielo', content: 'Sky', image: netease.songs[0].album.picUrl,
        url: 'https://music.163.com/song?id=29005614', audio: neteasePlayer.data[0].url, platform: 'netease' });
    assert.equal(c.requests.length, 2);
    assert.equal(new URL(c.requests[0].url).hostname, 'music.163.com');
    assert.equal(c.requests[0].options.headers.Referer, 'https://music.163.com/');
    assert.equal(c.requests[0].options.headers.Cookie, undefined);
    assert.ok(c.requests[1].timeoutMs <= c.requests[0].timeoutMs);
});

test('QQ numeric IDs use numeric song_id, resolve the canonical mid and select that exact playback entry', async () => {
    const player = structuredClone(qqPlayer);
    player.req_0.data.midurlinfo.unshift({ songmid: '0039MnYb0qxYhV', purl: 'wrong.m4a', result: 0 });
    const c = client([qqDetail(), player]);
    const result = await resolveMusic({ type: 'qq', id: '740247871' }, c);
    assert.equal(result.title, 'Reno My Color'); assert.equal(result.content, 'Artist One/Artist Two');
    assert.equal(result.platform, 'qq'); assert.equal(result.audio, 'http://aqqmusic.tc.qq.com/C400real.m4a?vkey=temporary');
    assert.equal(result.image, 'https://y.gtimg.cn/music/photo_new/T002R300x300M000000MkMni19ClKG.jpg');
    assert.equal(result.url, 'https://y.qq.com/n/ryqq/songDetail/' + qqSong.mid);
    const request = JSON.parse(new URL(c.requests[0].url).searchParams.get('data'));
    assert.deepEqual(request.req_0.param, { song_id: 740247871 });
    const playback = JSON.parse(new URL(c.requests[1].url).searchParams.get('data'));
    assert.deepEqual(playback.req_0.param.songmid, [qqSong.mid]); assert.equal(playback.req_0.param.uin, '0');
});

test('QQ song mids are passed unchanged to the official detail module', async () => {
    const c = client([qqDetail(), qqPlayer]);
    await resolveMusic({ type: 'qq', id: qqSong.mid }, c);
    assert.deepEqual(JSON.parse(new URL(c.requests[0].url).searchParams.get('data')).req_0.param, { song_mid: qqSong.mid });
});

test('unavailable, paid and trial NetEase tracks fail instead of inventing an outer playback URL', async () => {
    for (const change of [{ url: null, code: 404 }, { url: null, code: -110 }, { freeTrialInfo: { start: 0, end: 30 } }]) {
        const player = structuredClone(neteasePlayer); Object.assign(player.data[0], change);
        await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([netease, player])), { code: 'UNSUPPORTED' });
    }
    const detail = structuredClone(netease); detail.songs[0].fee = 8;
    const result = await resolveMusic({ type: '163', id: '29005614' }, client([detail, neteasePlayer]));
    assert.equal(result.title, 'Cielo');
});

test('QQ membership denial cannot fall back to unrelated server test files', async () => {
    const player = structuredClone(qqPlayer); Object.assign(player.req_0.data.midurlinfo[0], { purl: '', result: 104003 });
    await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, client([qqDetail(), player])), { code: 'UNSUPPORTED' });
    delete player.req_0.data.midurlinfo;
    await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, client([qqDetail(), player])), { code: 'INVALID_RESPONSE' });
});

test('metadata and playback identity mismatches, duplicate matches and lossy integers are rejected', async () => {
    const wrongSong = structuredClone(netease); wrongSong.songs[0].id++;
    await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([wrongSong])), { code: 'INVALID_RESPONSE' });
    const wrongPlayer = structuredClone(neteasePlayer); wrongPlayer.data[0].id++;
    await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([netease, wrongPlayer])), { code: 'INVALID_RESPONSE' });
    const ambiguous = structuredClone(neteasePlayer); ambiguous.data.push(ambiguous.data[0]);
    await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([netease, ambiguous])), { code: 'INVALID_RESPONSE' });
    const wrongQQ = structuredClone(qqSong); wrongQQ.mid = '0039MnYb0qxYhV';
    await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, client([qqDetail(wrongQQ)])), { code: 'INVALID_RESPONSE' });
    wrongQQ.id = Number.MAX_SAFE_INTEGER + 1;
    await assert.rejects(resolveMusic({ type: 'qq', id: wrongQQ.mid }, client([qqDetail(wrongQQ)])), { code: 'INVALID_RESPONSE' });
});

test('metadata cannot inject local, unrelated or credential-bearing playback URLs', async () => {
    for (const url of ['file:///private', 'http://127.0.0.1/song', 'https://evil.example/song', 'https://x:y@m701.music.126.net/song',
        'http://m701.music.126.net:8080/song', 'https://m701.music.126.net/song#secret']) {
        const player = structuredClone(neteasePlayer); player.data[0].url = url;
        await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([netease, player])), { code: 'INVALID_RESPONSE' });
    }
    const player = structuredClone(qqPlayer); player.req_0.data.midurlinfo[0].purl = 'https://other.example/not-the-song';
    await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, client([qqDetail(), player])), { code: 'INVALID_RESPONSE' });
});

test('missing songs and upstream error envelopes fail before requesting playback', async () => {
    const empty = client([{ code: 200, songs: [] }]);
    await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, empty), { code: 'NOT_FOUND' });
    assert.equal(empty.requests.length, 1);
    for (const response of [null, { code: 500 }, { code: 0, req_0: { code: 1, data: {} } }]) {
        await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, client([response])), { code: 'INVALID_RESPONSE' });
    }
});

test('empty or control-character song names and artists are not substituted with placeholders', async () => {
    for (const change of [{ name: '' }, { name: 'bad\nname' }, { artists: [] }, { artists: [{ name: '' }] }, { album: { picUrl: 'file:///cover' } }]) {
        const detail = structuredClone(netease); Object.assign(detail.songs[0], change);
        await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, client([detail])), { code: 'INVALID_RESPONSE' });
    }
});

test('invalid platform IDs fail before any external request', async () => {
    const c = client([]);
    for (const data of [{ type: '163', id: '9007199254740993' }, { type: 'qq', id: '123-invalid' },
        { type: 'qq', id: '0' }, { type: 'qq', id: '9007199254740993' }, { type: '163', id: 'not-a-number' },
        { type: 'custom', title: 'Song', url: 'https://song.example', audio: 'https://audio.example/song' }]) {
        await assert.rejects(resolveMusic(data, c), { code: 'INVALID_PARAMS' });
    }
    assert.equal(c.requests.length, 0);
});

test('one deadline bounds both official requests even if a JSON client ignores its timeout', async () => {
    const requests = [];
    const started = performance.now();
    await assert.rejects(resolveMusic({ type: '163', id: '29005614' }, { timeoutMs: 70, requestJson: async (url, _options, timeout) => {
        requests.push({ url, timeout });
        if (requests.length === 1) { await new Promise(resolve => setTimeout(resolve, 25)); return netease; }
        return new Promise(() => {});
    } }), { code: 'TIMEOUT' });
    assert.equal(requests.length, 2); assert.ok(requests[1].timeout < requests[0].timeout);
    assert.ok(performance.now() - started < 500);
    const c = { timeoutMs: 20, requestJson: () => new Promise(() => {}) };
    await assert.rejects(resolveMusic({ type: 'qq', id: qqSong.mid }, c), { code: 'TIMEOUT' });
});
