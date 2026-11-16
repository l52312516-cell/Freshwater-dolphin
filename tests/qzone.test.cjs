'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createQzone, PATHS } = require('../src/qq/qzone.cjs');
const { runQzone, ACTIONS } = require('../src/onebot/qzone-actions.cjs');
const media = require('../src/qq/media.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const json = value => new Response(JSON.stringify(value));
function fixture(t, options = {}) {
    const temp = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temp, { recursive: true }); const directory = fs.mkdtempSync(path.join(temp, 'qzone-')); t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const state = { requests: [], native: [], pskey: true, cookieUin: '12345', handler: null };
    const capture = { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, mediaDirectory: directory, ensureReady() {}, hasMethods: () => true,
        deadline: operation => operation(), async invoke(service, method, args) { state.native.push({ service, method, args }); if (method === 'forceFetchClientKey') return { result: 0, clientKey: 'PRIVATE_CLIENT_KEY', keyIndex: '19' };
            return { result: 0, domainPskeyMap: new Map([['qzone.qq.com', 'DOMAIN_PRIVATE_KEY']]) }; } };
    const api = createQzone(capture, { ...options, fetchImpl: async (target, request) => {
        const url = new URL(target); state.requests.push({ url, request });
        if (url.hostname === 'ssl.ptlogin2.qq.com') {
            if (state.jump) return state.jump(url, request);
            assert.equal(url.searchParams.get('u1'), 'https://user.qzone.qq.com/12345/infocenter');
            const headers = new Headers({ location: 'https://user.qzone.qq.com/12345/infocenter' });
            headers.append('Set-Cookie', 'uin=o' + state.cookieUin + '; Domain=.qq.com; Path=/; Secure'); headers.append('Set-Cookie', 'skey=PRIVATE_SKEY; Domain=.qq.com; Path=/; Secure');
            return new Response('', { status: 302, headers });
        }
        if (url.hostname === 'user.qzone.qq.com' && url.pathname === '/12345/infocenter') {
            const headers = new Headers(); if (state.pskey) headers.append('Set-Cookie', 'p_skey=PRIVATE_PSKEY; Domain=.qzone.qq.com; Path=/; Secure');
            return new Response('', { headers });
        }
        if (state.handler) return state.handler(url, request);
        return json({ code: 0, total: 0, msglist: [] });
    } });
    const context = () => ({ expiresAt: Date.now() + 1500 });
    const query = data => api.query({ ...data, expectedEpoch: capture.epoch }, context());
    const action = data => api.action({ ...data, expectedEpoch: capture.epoch }, context());
    const obState = { self: capture.self, capabilities: api.capabilities() };
    const service = { mediaDirectory: directory, sessionCall: (_state, method, data) => (method === 'qzoneQuery' ? query : action)(data), log() {} };
    const business = () => state.requests.filter(item => !['ssl.ptlogin2.qq.com', 'ptlogin2.qzone.qq.com'].includes(item.url.hostname) && item.url.href !== 'https://user.qzone.qq.com/12345/infocenter');
    return { state, capture, api, query, action, service, obState, business };
}

test('Qzone authentication is worker-side, cookie/account/domain-bound and follows only closed official redirects', async t => {
    const f = fixture(t); const result = await f.query({ operation: 'qzone.list' });
    assert.deepEqual(result, { operation: 'qzone.list', uin: '12345', targetUin: '12345', result: { total: 0, msglist: [] } });
    const call = f.business()[0]; assert.equal(call.url.origin + call.url.pathname, PATHS.list); assert.equal(call.request.redirect, 'manual'); assert.equal(call.request.credentials, 'omit');
    assert.match(call.request.headers.Cookie, /p_skey=PRIVATE_PSKEY/); assert.match(call.request.headers.Cookie, /uin=o12345/);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    f.state.cookieUin = '99999'; await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'AUTH_FAILED' });
    const before = f.business().length;
    f.state.jump = () => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } });
    await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'INVALID_RESPONSE' }); assert.equal(f.business().length, before);
    f.state.jump = () => new Response('', { status: 302, headers: { location: 'https://ptlogin2.qzone.qq.com/check_sig?uin=99999' } });
    await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'AUTH_FAILED' });
});

test('Qzone domain key fallback requests only qzone.qq.com and never borrows qun cookies', async t => {
    const f = fixture(t); f.state.pskey = false;
    await f.query({ operation: 'qzone.list' });
    const native = f.state.native.find(item => item.method === 'getPskey'); assert.deepEqual(native.args, [['qzone.qq.com'], true]);
    assert.match(f.business()[0].request.headers.Cookie, /p_skey=DOMAIN_PRIVATE_KEY/);
    assert.equal(f.business()[0].request.headers.Cookie.includes('qun'), false);
});

test('Qzone auth cookie scope cannot leak host-only or wrong-path credentials to business hosts', async t => {
    const f = fixture(t);
    f.state.jump = () => { const headers = new Headers({ location: 'https://user.qzone.qq.com/12345/infocenter' }); headers.append('Set-Cookie', 'uin=o12345; Path=/'); headers.append('Set-Cookie', 'skey=PRIVATE_SKEY; Path=/'); return new Response('', { status: 302, headers }); };
    await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'AUTH_FAILED' }); assert.equal(f.business().length, 0);
});

test('Qzone list retries only the confirmed -10000 read-only alternate route and preserves real totals', async t => {
    const f = fixture(t);
    f.state.handler = url => url.hostname === 'h5.qzone.qq.com' ? json({ code: -10000 }) : json({ code: 0, total: 3, msglist: [{ tid: 'p1', content: 'post', created_time: 123, cmtnum: 0, secret: 0 }] });
    const result = await f.query({ operation: 'qzone.list', targetUin: '22222', pos: 2, num: 1 });
    assert.equal(result.targetUin, '22222'); assert.equal(result.result.total, 3); assert.equal(f.business().length, 2);
    assert.equal(f.business()[1].url.origin + f.business()[1].url.pathname, PATHS.alternateList);
    f.state.handler = () => json({ code: -3 }); const before = f.business().length;
    await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'KERNEL_ERROR' }); assert.equal(f.business().length, before + 1);
});

test('Qzone detail binds requested owner/tid, real paged comments and inline reply parents', async t => {
    const f = fixture(t);
    f.state.handler = () => json({ code: 0, tid: 'p1', uin: '22222', content: 'post', cmtnum: 1, commentlist: [{ tid: 0, uin: 33333, name: 'parent', create_time: 123, content: 'text', list_3: [] }] });
    const result = await runQzone(f.service, f.obState, 'get_qzone_msg_detail', { tid: 'p1', target_uin: 22222, num: 1 });
    assert.equal(result.comments[0].comment_id, '0'); assert.equal(f.business()[0].url.searchParams.get('uin'), '22222');
    assert.equal(f.business()[0].url.searchParams.get('num'), '1');
    await assert.rejects(f.query({ operation: 'qzone.detail', targetUin: '99999', tid: 'p1' }), { code: 'INVALID_RESPONSE' });
});

test('Qzone feed cursors bind account/session/count and progress; legacy pages walk actual continuation', async t => {
    const f = fixture(t); let pages = [];
    f.state.handler = url => { const page = Number(url.searchParams.get('pagenum')); pages.push(page); return json({ code: 0, data: { data: [], main: { hasMoreFeeds: page === 1 ? 1 : 0, pagenum: page + 1, externparam: 'page' + (page + 1) } } }); };
    const first = await f.query({ operation: 'qzone.feeds', count: 5 }); assert.equal(first.result.has_more, true); const cursor = first.result.next_cursor;
    const second = await f.query({ operation: 'qzone.feeds', cursor, count: 5 }); assert.equal(second.result.has_more, false); assert.equal(second.result.next_cursor, null); assert.deepEqual(pages, [1, 2]);
    await assert.rejects(f.query({ operation: 'qzone.feeds', cursor, count: 6 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.query({ operation: 'qzone.feeds', cursor: cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'), count: 5 }), { code: 'INVALID_PARAMS' });
    f.capture.epoch = 'e2'; await assert.rejects(f.query({ operation: 'qzone.feeds', cursor, count: 5 }), { code: 'INVALID_PARAMS' }); f.capture.epoch = 'e1';
    pages = []; await f.query({ operation: 'qzone.feeds', pageNum: 2, count: 5 }); assert.deepEqual(pages, [1, 2]);
    pages = []; const terminal = await f.query({ operation: 'qzone.feeds', pageNum: 3, count: 5 }); assert.deepEqual(terminal.result, { feeds: [], has_more: false, next_cursor: null }); assert.deepEqual(pages, [1, 2]);
    f.api.clear(); await assert.rejects(f.query({ operation: 'qzone.feeds', cursor, count: 5 }), { code: 'INVALID_PARAMS' });
});

test('Qzone feed pages never report a missing page or clock-only cursor change as successful empty data', async t => {
    const f = fixture(t);
    for (const body of [{ code: 0 }, { code: 0, data: { data: [] } }, { code: 0, data: { data: [], main: { hasMoreFeeds: 1, icServerTime: 99999 } } }]) {
        f.state.handler = () => json(body); await assert.rejects(f.query({ operation: 'qzone.feeds' }), { code: 'INVALID_RESPONSE' });
    }
    f.state.handler = () => new Response('_preloadCallback({code:0,data:{data:[undefined,,{uin:22222,nickname:\'n\',abstime:123,appid:311,key:\'k\',html:\'<div>unknown</div>\'}],main:{hasMoreFeeds:0}}});');
    const result = await f.query({ operation: 'qzone.feeds' }); assert.equal(result.result.feeds.length, 1); assert.equal(result.result.feeds[0].content, null); assert.equal(result.result.feeds[0].like_count, null);
});

test('Qzone preserves a source page that ignores count and drains every item through bounded opaque cursors', async t => {
    const f = fixture(t), feed = key => ({ uin: 22222, nickname: 'n', abstime: 123, appid: 311, key, html: '<div>PRIVATE_FEED_' + key + '</div>' });
    let sourceCalls = 0;
    f.state.handler = () => { sourceCalls++; return json({ code: 0, data: { data: ['a', 'b', 'c', 'd', 'e'].map(feed), main: { hasMoreFeeds: 0 } } }); };
    const first = await f.query({ operation: 'qzone.feeds', count: 2 });
    assert.deepEqual(first.result.feeds.map(row => row.key), ['a', 'b']); assert.equal(first.result.has_more, true);
    const cursorData = Buffer.from(first.result.next_cursor.split('.')[0], 'base64url').toString(); assert.equal(cursorData.includes('PRIVATE_FEED'), false); assert.equal(cursorData.includes('html'), false);
    const second = await f.query({ operation: 'qzone.feeds', count: 2, cursor: first.result.next_cursor });
    assert.deepEqual(second.result.feeds.map(row => row.key), ['c', 'd']); assert.equal(second.result.has_more, true);
    const replay = await f.query({ operation: 'qzone.feeds', count: 2, cursor: first.result.next_cursor }); assert.deepEqual(replay.result, second.result);
    const third = await f.query({ operation: 'qzone.feeds', count: 2, cursor: second.result.next_cursor });
    assert.deepEqual(third.result.feeds.map(row => row.key), ['e']); assert.equal(third.result.has_more, false); assert.equal(third.result.next_cursor, null); assert.equal(sourceCalls, 1);
    const legacy = await f.query({ operation: 'qzone.feeds', count: 2, pageNum: 2 }); assert.deepEqual(legacy.result.feeds.map(row => row.key), ['c', 'd']); assert.equal(sourceCalls, 2);
});

test('Qzone public feed preserves system author zero with verified kind across overflow and rejects forged kinds', async t => {
    const f = fixture(t), rows = [0, 22222, 0].map((uin, index) => ({ uin, nickname: '', abstime: 123, appid: 311, key: 'feed' + index, html: '' }));
    f.state.handler = () => json({ code: 0, data: { data: rows, main: { hasMoreFeeds: 0 } } });
    const first = await runQzone(f.service, f.obState, 'get_qzone_feeds', { count: 2 });
    assert.deepEqual(first.feeds.map(row => [row.uin, row.author_kind]), [[0, 'system-or-unattributed'], [22222, 'qq-user']]);
    const second = await runQzone(f.service, f.obState, 'get_qzone_feeds', { count: 2, cursor: first.next_cursor });
    assert.deepEqual(second.feeds.map(row => [row.uin, row.author_kind]), [[0, 'system-or-unattributed']]); assert.equal(second.has_more, false);
    const valid = await f.query({ operation: 'qzone.feeds', count: 2 });
    for (const changed of [{ uin: 0, author_kind: 'qq-user' }, { uin: '0', author_kind: 'qq-user' }, { uin: 22222, author_kind: 'system-or-unattributed' }, { uin: -1, author_kind: 'system-or-unattributed' }]) {
        const service = { ...f.service, async sessionCall() { return { ...valid, result: { ...valid.result, feeds: [{ ...valid.result.feeds[0], ...changed }] } }; } };
        await assert.rejects(runQzone(service, f.obState, 'get_qzone_feeds', { count: 2 }), { code: 'INVALID_RESPONSE' });
    }
    const before = f.state.requests.length;
    await assert.rejects(runQzone(f.service, f.obState, 'get_qzone_msg_list', { target_uin: 0 }), { code: 'INVALID_PARAMS' });
    assert.equal(f.state.requests.length, before, 'zero is never dispatched as a requested account');
});

test('Qzone advances the server cursor only after source overflow is consumed and keeps cross-request loop detection', async t => {
    const f = fixture(t), source = [], feed = key => ({ uin: 22222, nickname: 'n', abstime: 123, appid: 311, key, html: '' });
    f.state.handler = url => { const page = Number(url.searchParams.get('pagenum')); source.push(page); return json({ code: 0, data: {
        data: (page === 1 ? ['a', 'b', 'c'] : ['d', 'e']).map(feed), main: { hasMoreFeeds: page === 1 ? 1 : 0, pagenum: page + 1, externparam: 'page' + (page + 1) } } }); };
    const first = (await f.query({ operation: 'qzone.feeds', count: 2 })).result;
    const second = (await f.query({ operation: 'qzone.feeds', count: 2, cursor: first.next_cursor })).result; assert.deepEqual(second.feeds.map(row => row.key), ['c']); assert.deepEqual(source, [1]);
    const third = (await f.query({ operation: 'qzone.feeds', count: 2, cursor: second.next_cursor })).result; assert.deepEqual(third.feeds.map(row => row.key), ['d', 'e']); assert.deepEqual(source, [1, 2]);
    const replay = (await f.query({ operation: 'qzone.feeds', count: 2, cursor: second.next_cursor })).result; assert.deepEqual(replay, third); assert.deepEqual(source, [1, 2]);
    const g = fixture(t); let calls = 0;
    g.state.handler = () => json({ code: 0, data: { data: [feed('x' + ++calls)], main: { hasMoreFeeds: 1, pagenum: calls === 1 ? 2 : 1 } } });
    const start = (await g.query({ operation: 'qzone.feeds', count: 1 })).result;
    await assert.rejects(g.query({ operation: 'qzone.feeds', count: 1, cursor: start.next_cursor }), { code: 'INVALID_RESPONSE' });
});

test('Qzone bounded snapshot exhaustion refuses new pages while retained overflow remains usable and clear releases it', async t => {
    const f = fixture(t); f.state.handler = () => json({ code: 0, data: { data: ['a', 'b', 'c'].map(key => ({ uin: 22222, nickname: '', abstime: 1, appid: 311, key, html: '' })), main: { hasMoreFeeds: 0 } } });
    const first = (await f.query({ operation: 'qzone.feeds', count: 1 })).result;
    for (let i = 1; i < 32; i++) await f.query({ operation: 'qzone.feeds', count: 1 });
    await assert.rejects(f.query({ operation: 'qzone.feeds', count: 1 }), { code: 'BUSY' });
    assert.deepEqual((await f.query({ operation: 'qzone.feeds', count: 1, cursor: first.next_cursor })).result.feeds.map(row => row.key), ['b']);
    f.api.clear(); await assert.rejects(f.query({ operation: 'qzone.feeds', count: 1, cursor: first.next_cursor }), { code: 'INVALID_PARAMS' });
    assert.equal((await f.query({ operation: 'qzone.feeds', count: 1 })).result.feeds.length, 1);
});

test('Qzone publish requires an explicit ACK plus actual post identity/time and never retries lost writes', async t => {
    const f = fixture(t);
    f.state.handler = () => json({ code: 0, t1_tid: 'newpost', t1_time: '1760000000' });
    assert.deepEqual(await runQzone(f.service, f.obState, 'send_qzone_msg', { content: ' exact text \n', ugc_right: 16, target_uins: [22222] }), { tid: 'newpost', time: 1760000000 });
    const form = new URLSearchParams(f.business()[0].request.body); assert.equal(form.get('con'), ' exact text \n'); assert.equal(form.get('hostuin'), '12345'); assert.equal(form.get('allow_uins'), '22222');
    for (const body of [{}, { code: 0 }, { code: 0, tid: 'p' }, { code: 0, tid: 'p', now: 0 }, { code: 0, subcode: 1, tid: 'p', now: 123 }]) {
        f.state.handler = () => json(body); const before = f.business().length; await assert.rejects(f.action({ operation: 'qzone.publish', content: 'x' })); assert.equal(f.business().length, before + 1);
    }
    f.state.handler = () => { throw new Error('lost POST response'); }; const before = f.business().length;
    await assert.rejects(f.action({ operation: 'qzone.publish', content: 'x' }), { code: 'QUERY_FAILED' }); assert.equal(f.business().length, before + 1);
});

test('Qzone image publish imports bounded base64 to account handles and uploads real bytes to one fixed host', async t => {
    const f = fixture(t);
    f.state.handler = (url, request) => url.hostname === 'up.qzone.qq.com' ? new Response('<script>frameElement.callback({code:0,data:{albumid:"album",lloc:"location",url:"https://qpic.cn/image",type:22,height:1,width:1}});</script>') : json({ code: 0, tid: 'newpost', now: 123 });
    const result = await runQzone(f.service, f.obState, 'send_qzone_msg', { content: 'image', images: ['base64://' + PNG.toString('base64')] }); assert.equal(result.tid, 'newpost');
    const calls = f.business(); assert.equal(calls.length, 2); assert.equal(calls[0].url.origin + calls[0].url.pathname, PATHS.upload);
    const upload = new URLSearchParams(calls[0].request.body); assert.deepEqual(Buffer.from(upload.get('picfile'), 'base64'), PNG); assert.equal(upload.get('p_skey'), 'PRIVATE_PSKEY');
    const publish = new URLSearchParams(calls[1].request.body); assert.equal(publish.get('richval'), ',album,location,location,22,1,1,,1,1'); assert.equal(publish.get('richtype'), '1');
    assert.deepEqual(fs.readdirSync(f.capture.mediaDirectory), []);
    const before = f.state.requests.length;
    for (const input of ['https://evil.example/a', 'file:///tmp/a', 'C:/outside.png', 'base64://AAAA']) await assert.rejects(runQzone(f.service, f.obState, 'send_qzone_msg', { content: 'x', images: [input] }));
    assert.equal(f.state.requests.length, before);
});

test('Qzone comments/replies preserve owner/self distinction and require actual new ID, including zero', async t => {
    const f = fixture(t); f.state.handler = () => json({ code: 0, commentid: 0 });
    assert.deepEqual(await runQzone(f.service, f.obState, 'comment_qzone', { target_uin: 22222, tid: 'p1', content: 'comment' }), { comment_id: '0' });
    let form = new URLSearchParams(f.business().at(-1).request.body); assert.equal(form.get('hostUin'), '22222'); assert.equal(form.get('uin'), '12345'); assert.equal(form.get('topicId'), '22222_p1__1');
    f.state.handler = () => json({ code: 0, data: { id: 'r1' } });
    const reply = await runQzone(f.service, f.obState, 'comment_qzone', { target_uin: 22222, tid: 'p1', content: 'reply', comment_id: '0', comment_uin: 33333, reply_uin: 44444, reply_name: 'a%,}' });
    assert.deepEqual(reply, { comment_id: 'r1', parent_comment_id: '0', parent_comment_uin: 33333 }); form = new URLSearchParams(f.business().at(-1).request.body);
    assert.equal(form.get('topicId'), '22222_p1'); assert.equal(form.get('hostuin'), '12345'); assert.equal(form.get('content'), '@{uin:44444,nick:a%25%2C%7D,auto:1} reply');
    f.state.handler = () => json({ code: 0 }); await assert.rejects(f.action({ operation: 'qzone.comment', tid: 'p1', content: 'x' }), { code: 'INVALID_RESPONSE' });
});

test('Qzone delete prechecks ownership; right changes preserve the entire post and require visibility readback', async t => {
    const f = fixture(t); let right = 1, posts = 0;
    f.state.handler = (url, request) => {
        if (url.pathname.endsWith('emotion_cgi_msgdetail_v6')) return json({ code: 0, tid: 'p1', uin: '12345', content: ' exact body \n', cmtnum: 0, ugc_right: right });
        posts++; if (url.pathname.endsWith('emotion_cgi_update')) right = Number(new URLSearchParams(request.body).get('ugc_right'));
        return json({ subcode: 0 });
    };
    assert.equal(await runQzone(f.service, f.obState, 'delete_qzone_msg', { tid: 'p1' }), null); assert.equal(posts, 1);
    const result = await runQzone(f.service, f.obState, 'set_qzone_msg_right', { tid: 'p1', ugc_right: 64 }); assert.deepEqual(result, { ugc_right: 64 }); assert.equal(posts, 2);
    const write = f.business().find(item => item.url.pathname.endsWith('emotion_cgi_update')); assert.equal(new URLSearchParams(write.request.body).get('con'), ' exact body \n');
    f.state.handler = () => json({ code: 0, tid: 'p1', uin: '99999', content: 'foreign', cmtnum: 0 }); const before = f.business().filter(item => item.request.method === 'POST').length;
    await assert.rejects(f.action({ operation: 'qzone.delete', tid: 'p1' }), { code: 'INVALID_RESPONSE' }); assert.equal(f.business().filter(item => item.request.method === 'POST').length, before);
});

test('Qzone like/ban require real explicit ACK and unlike stays unavailable pending source verification', async t => {
    const f = fixture(t); f.state.handler = () => json({ code: 0 });
    assert.equal(await runQzone(f.service, f.obState, 'like_qzone', { tid: 'p1', target_uin: 22222, abstime: 123 }), null);
    const form = new URLSearchParams(f.business()[0].request.body); assert.equal(form.get('opuin'), '12345'); assert.equal(form.get('unikey'), 'http://user.qzone.qq.com/22222/mood/p1');
    assert.equal(await runQzone(f.service, f.obState, 'set_qzone_ban', { user_id: 22222, enable: false }), null);
    assert.equal(new URLSearchParams(f.business().at(-1).request.body).get('action'), '2');
    const before = f.state.requests.length; assert.equal(f.api.capabilities().qzoneUnlike, false);
    await assert.rejects(f.action({ operation: 'qzone.unlike', tid: 'p1' }), { code: 'UNSUPPORTED' }); assert.equal(f.state.requests.length, before);
    f.state.handler = () => json({}); await assert.rejects(f.action({ operation: 'qzone.like', tid: 'p1' }), { code: 'INVALID_RESPONSE' });
    assert.equal(ACTIONS.size, 10);
});

test('Qzone closed unlike route can only be exercised by explicit offline protocol opt-in', async t => {
    const f = fixture(t, { enableUnverifiedUnlike: true }); f.state.handler = () => json({ code: 0 });
    await f.action({ operation: 'qzone.unlike', tid: 'p1' }); assert.equal(f.business()[0].url.origin + f.business()[0].url.pathname, PATHS.unlike);
});

test('Qzone physical mutation lock survives caller timeout until the original request physically completes', async t => {
    const f = fixture(t); let release;
    f.state.handler = () => new Promise(resolve => { release = () => resolve(json({ code: 0, tid: 'p1', now: 123 })); });
    f.capture.deadline = operation => Promise.race([operation(), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('caller timeout'), { code: 'TIMEOUT' })), 10))]);
    await assert.rejects(f.action({ operation: 'qzone.publish', content: 'x' }), { code: 'TIMEOUT' });
    await assert.rejects(f.action({ operation: 'qzone.publish', content: 'x' }), { code: 'BUSY' }); assert.equal(f.business().length, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    f.capture.deadline = operation => operation(); f.state.handler = () => json({ code: 0, tid: 'p2', now: 124 });
    assert.equal((await f.action({ operation: 'qzone.publish', content: 'x' })).result.tid, 'p2');
});

test('Qzone account/epoch/session invalidation, response redirects and byte budgets abort without later writes', async t => {
    const f = fixture(t); const before = f.state.requests.length;
    await assert.rejects(f.api.query({ operation: 'qzone.list', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' }); assert.equal(f.state.requests.length, before);
    f.state.handler = () => { f.capture.session = {}; return json({ code: 0, tid: 'p1', uin: 12345, content: 'x' }); };
    await assert.rejects(f.action({ operation: 'qzone.right', tid: 'p1', ugcRight: 64 }), { code: 'SESSION_CHANGED' }); assert.equal(f.business().some(item => item.request.method === 'POST'), false);
    f.state.handler = () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }); await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'QUERY_FAILED' });
    f.state.handler = () => new Response('{}', { headers: { 'content-length': '3000000' } }); await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'INVALID_RESPONSE' });
    f.state.handler = () => new Response(Buffer.from([255])); await assert.rejects(f.query({ operation: 'qzone.list' }), { code: 'INVALID_RESPONSE' });
});

test('OneBot Qzone rejects forged response identities and public proxy/native parameter backdoors', async t => {
    const f = fixture(t); const original = f.service.sessionCall;
    f.service.sessionCall = async (_state, method, data) => ({ ...(await original(_state, method, data)), targetUin: '99999' });
    await assert.rejects(runQzone(f.service, f.obState, 'get_qzone_msg_list', {}), { code: 'INVALID_RESPONSE' });
    for (const params of [{ targetUin: '12345' }, { url: 'https://evil.example/' }, { headers: { Cookie: 'x' } }, { expectedEpoch: 'e1' }, { self_id: 99999 }]) await assert.rejects(runQzone(f.service, f.obState, 'get_qzone_msg_list', params), { code: 'INVALID_PARAMS' });
});
