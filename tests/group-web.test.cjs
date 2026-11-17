'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroupWeb } = require('../src/qq/group-web.cjs');
function fixture(options = {}) {
    const calls = [], state = { epoch: 'e1', uin: '12345', uid: 'u_self' };
    const capture = { epoch: state.epoch, self: { uin: state.uin, uid: state.uid }, ensureReady() {}, hasMethods: (_service, methods) => !methods.includes('getPskey'),
        async invoke() { return { result: 0, clientKey: 'PRIVATE-CLIENT-TICKET', keyIndex: '1' }; } };
    const client = createGroupWeb(capture, { fetchImpl: async (input, request) => {
        const url = new URL(input); calls.push({ url, request });
        if (url.hostname === 'ssl.ptlogin2.qq.com') return new Response('', { status: 302, headers: [
            ['Location', options.redirect || 'https://qun.qq.com/'],
            ['Set-Cookie', 'uin=o' + (options.wrongAccount ? '54321' : '12345') + '; Domain=qq.com; Path=/; Secure'],
            ['Set-Cookie', 'skey=SECRET-SKEY; Domain=qq.com; Path=/; Secure']
        ] });
        if (url.pathname === '/') return new Response('official landing');
        if (options.changeSession) capture.epoch = 'e2';
        return new Response(JSON.stringify(options.result || { ec: 0, feeds: [{ fid: 'notice-1', msg: { text: '公告原文\n换行' } }] }));
    } });
    return { client, capture, state, calls, run: (operation = 'group.noticeList', params = {}) => client.execute(operation, { groupId: '2000000001', ...params }, { expiresAt: Date.now() + 5000 }, state) };
}

test('group notices use real account-scoped tickets and fixed official CGI requests', async () => {
    const f = fixture(), result = await f.run();
    assert.equal(result.notices[0].msg.text, '公告原文\n换行');
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].url.hostname, 'web.qun.qq.com');
    assert.equal(f.calls[2].request.redirect, 'manual');
    assert.match(f.calls[2].request.headers.Cookie, /uin=o12345/);
    assert.equal(new URLSearchParams(f.calls[2].request.body).get('qid'), '2000000001');
    assert.equal(JSON.stringify(result).includes('SECRET-SKEY'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-CLIENT-TICKET'), false);
});

test('notice CGI encoded text roundtrips spaces and entities exactly once as plain text', async () => {
    const f = fixture({ result: { ec: 0, feeds: [{ fid: 'own-notice', msg: {
        text: 'Freshwater&nbsp;可回滚公告验收&nbsp;A&amp;B &lt;b&gt;文本&lt;/b&gt;\n&amp;nbsp; &#128044; &#x1F42C; &#0; &#55296; &unknown;'
    } }] } });
    const result = await f.run();
    assert.equal(result.notices[0].msg.text, 'Freshwater 可回滚公告验收 A&B <b>文本</b>\n&nbsp; 🐬 🐬 &#0; &#55296; &unknown;');
});

test('credential redirects cannot leave QQ and wrong-account cookies cannot authorize a request', async () => {
    const redirect = fixture({ redirect: 'https://attacker.example/steal' });
    await assert.rejects(redirect.run(), { code: 'INVALID_RESPONSE' });
    assert.equal(redirect.calls.length, 1);
    const wrong = fixture({ wrongAccount: true });
    await assert.rejects(wrong.run(), { code: 'AUTH_FAILED' });
    assert.equal(wrong.calls.length, 2);
});

test('missing collections and login-like responses never become a successful empty notice list', async () => {
    for (const result of [{}, { ec: 0 }, { ec: 0, feeds: 'bad' }, { ec: 1, feeds: [] }]) {
        const f = fixture({ result });
        await assert.rejects(f.run());
    }
    const empty = fixture({ result: { ec: 0, srv_code: 0, read_only: 0, role: 3, sta: 1, gln: 0, next_index: null, group: { group_id: '2000000001' } } });
    assert.deepEqual((await empty.run()).notices, []);
});

test('notice publishing happens once and an account change rejects even a successful CGI acknowledgement', async () => {
    const f = fixture({ result: { ec: 0 } });
    const result = await f.run('group.noticePublish', { content: '独立测试公告' });
    assert.equal(result.confirmed, true); assert.equal(result.confirmation, 'server_ack');
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/add_qun_notice')).length, 1);
    const changed = fixture({ changeSession: true, result: { ec: 0 } });
    await assert.rejects(changed.run('group.noticePublish', { content: '测试' }), { code: 'SESSION_CHANGED' });
});

test('ordinary notice publishing preserves content and uses the reference member-confirmation default', async () => {
    const f = fixture({ result: { ec: 0 } }), content = '普通公告 A&B\n<原文> + 100% 🐬';
    await f.run('group.noticePublish', { content });
    const posts = f.calls.filter(call => call.url.pathname.endsWith('/add_qun_notice'));
    assert.equal(posts.length, 1);
    const { url, request } = posts[0], form = new URLSearchParams(request.body);
    assert.equal(url.origin, 'https://web.qun.qq.com');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.deepEqual([...form.keys()].sort(), ['bkn', 'pinned', 'qid', 'settings', 'text', 'type']);
    assert.equal(form.get('qid'), '2000000001');
    assert.equal(form.get('text'), content);
    assert.equal(form.get('pinned'), '0');
    assert.equal(form.get('type'), '1');
    assert.deepEqual(JSON.parse(form.get('settings')), { is_show_edit_card: 1, tip_window_type: 1, confirm_required: 1 });
});

test('essence and honor queries require real page flags and exact message/account identities', async () => {
    const essence = fixture({ result: { retcode: 0, data: { is_end: true, msg_list: [{ group_code: 2000000001, msg_seq: 77, msg_random: 0, msg_content: [] }] } } });
    assert.equal((await essence.run('group.essenceList', { count: 1 })).messages[0].msg_random, 0);
    const absent = fixture({ result: { retcode: 0, data: {} } });
    await assert.rejects(absent.run('group.essenceList'), { code: 'INVALID_RESPONSE' });
    const honor = fixture({ result: { retcode: 0, data: { talkative_list: [{ uin: 54321, nick: '真实昵称', day_count: 3 }] } } });
    assert.equal((await honor.run('group.honor', { type: 'talkative' })).members[0].uin, '54321');
});

test('unknown notice terminal pages expose only bounded status flags and identity equality', async () => {
    const f = fixture({ result: { ec: 0, srv_code: 0, read_only: 1, role: 2, sta: 1, gln: 0, next_index: null,
        group: { group_id: '2000000001', group_name: 'SECRET-GROUP-NAME' }, clientKey: 'SECRET-TICKET' } });
    await assert.rejects(f.run(), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.match(error.message, /"read_only":1/);
        assert.match(error.message, /"role":2/);
        assert.match(error.message, /"groupMatches":true/);
        assert.equal(error.message.includes('SECRET'), false);
        assert.equal(error.message.includes('2000000001'), false);
        return true;
    });
});

test('verified ordinary-member and admin empty notice pages require every terminal and identity flag', async () => {
    const verified = { ec: 0, srv_code: 0, read_only: 0, role: 1, sta: 1, gln: 0, next_index: null,
        group: { group_id: '2000000001' } };
    for (const role of [1, 3]) assert.deepEqual(await fixture({ result: { ...verified, role } }).run(),
        { groupId: '2000000001', notices: [], hasMore: false });
    for (const change of [{ role: 2 }, { role: '1' }, { read_only: 1 }, { srv_code: 1 }, { sta: 0 }, { gln: 1 },
        { next_index: 0 }, { group: { group_id: '99999' } }]) {
        await assert.rejects(fixture({ result: { ...verified, ...change } }).run(), { code: 'INVALID_RESPONSE' });
    }
    const missing = { ...verified }; delete missing.next_index;
    await assert.rejects(fixture({ result: missing }).run(), { code: 'INVALID_RESPONSE' });
});
