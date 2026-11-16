'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/qzone-protocol.cjs');
const { parseFeedContent } = require('../src/qq/qzone-feed-content.cjs');

test('Qzone literal reader accepts bounded JSON/known JSONP and padded JS data without evaluating it', () => {
    assert.deepEqual(p.parse('_preloadCallback({code:0,data:{data:[undefined,,null],s:\'a\\x20b\\u4e2d\',ok:true}});'), { code: 0, data: { data: [null, null, null], s: 'a b中', ok: true } });
    assert.deepEqual(p.parse('<script>frameElement.callback({"subcode":0,"data":{"id":0}});</script>'), { subcode: 0, data: { id: 0 } });
    assert.deepEqual(p.parse('{"code":0}'), { code: 0 });
});

test('Qzone literal reader rejects expressions, polluted/duplicate fields, unsafe numbers and depth/size excess', () => {
    globalThis.__qzoneTest = 0;
    for (const body of ['callback({code:(globalThis.__qzoneTest=1)})', 'callback({get code(){return 0}})', 'evil({code:0})',
        'callback({code:0}); globalThis.__qzoneTest=1', '{"__proto__":{}}', '{"constructor":0}', '{code:0,code:1}',
        '{code:0,value:9007199254740993}', '{code:0,value:1e999}', '{code:0,value:`text`}', '{code:0,value:/x/}',
        '{a:' + '['.repeat(34) + '0' + ']'.repeat(34) + '}', '<html>{"code":0}</html>', '{a:"\\uD800"}']) assert.throws(() => p.parse(body), { code: 'INVALID_RESPONSE' });
    assert.equal(globalThis.__qzoneTest, 0); delete globalThis.__qzoneTest;
    assert.throws(() => p.parse('{a:"' + 'x'.repeat(2097152) + '"}'), { code: 'INVALID_RESPONSE' });
});

test('Qzone status requires a positive explicit success proof and never masks a nonzero sibling code', () => {
    for (const body of [{}, { code: null }, { code: false }, { code: '0' }, { subcode: '' }]) assert.throws(() => p.ack(body), { code: 'INVALID_RESPONSE' });
    for (const body of [{ code: -3, subcode: 0 }, { code: 0, subcode: 1 }]) assert.throws(() => p.ack(body), { code: 'KERNEL_ERROR' });
    assert.deepEqual(p.ack({ subcode: 0 }), { subcode: 0 });
});

test('Qzone operation validators close the field set and enforce visibility/reply/image boundaries', () => {
    assert.equal(p.validate({ operation: 'qzone.comment', tid: 'post', content: 'text', commentId: '0', commentUin: '12345' }, true).commentId, '0');
    assert.equal(p.validate({ operation: 'qzone.list' }, false).num, 20);
    for (const data of [
        { operation: 'qzone.list', url: 'https://evil.example/' }, { operation: 'qzone.list', targetUin: 9007199254740993 },
        { operation: 'qzone.feeds', pageNum: 21 }, { operation: 'qzone.detail', tid: 'bad?&tid=other' },
    ]) assert.throws(() => p.validate(data, false), { code: 'INVALID_PARAMS' });
    for (const data of [
        { operation: 'qzone.publish', content: 'x', ugcRight: 16 }, { operation: 'qzone.publish', content: 'x', ugcRight: 1, targetUins: ['12345'] },
        { operation: 'qzone.publish', content: 'x', ugcRight: 128, targetUins: ['12345', 12345] },
        { operation: 'qzone.comment', tid: 'p', content: 'x', commentId: '0' },
        { operation: 'qzone.comment', tid: 'p', content: 'x', replyUin: '12345', replyName: 'n' },
        { operation: 'qzone.publish', content: 'x', images: ['https://evil.example/image'] },
        { operation: 'qzone.ban', userId: '12345', enable: 'false' },
    ]) assert.throws(() => p.validate(data, true), { code: 'INVALID_PARAMS' });
});

test('Qzone list never substitutes missing collections/totals or corrupt post fields with empty defaults', () => {
    const row = { tid: 'p1', content: ' text \n', created_time: 123, cmtnum: 2, secret: 0, pic: [{ url1: 'https://a.example/small', url3: 'https://a.example/large' }] };
    const value = p.list({ code: 0, total: 2, msglist: [row] }, { pos: 0, num: 20 });
    assert.deepEqual(value.msglist[0], { tid: 'p1', content: ' text \n', time: 123, comment_num: 2, is_private: false, images: ['https://a.example/large'] });
    assert.deepEqual(p.list({ code: 0, total: 0, msglist: [] }, { pos: 0, num: 20 }), { total: 0, msglist: [] });
    for (const body of [{ code: 0 }, { code: 0, total: 0 }, { code: 0, msglist: [] }, { code: 0, total: 0, msglist: null },
        { code: 0, total: 2, msglist: [{ ...row, tid: undefined }] }, { code: 0, total: 2, msglist: [row, row] },
        { code: 0, total: 2, msglist: [{ ...row, created_time: undefined }] }]) assert.throws(() => p.list(body, { pos: 0, num: 20 }), { code: 'INVALID_RESPONSE' });
});

test('Qzone detail preserves comment zero IDs, exact parents and real nonempty/empty evidence', () => {
    const comment = { tid: 0, uin: '22222', name: 'a', create_time: 123, content: 'parent', list_3: [{ tid: 'r1', uin: 33333, name: 'b', create_time: 124, content: 'reply' }] };
    const result = p.detail({ code: 0, tid: 'p1', uin: 12345, content: 'post', cmtnum: 1, commentlist: [comment] }, { targetUin: '12345', tid: 'p1', pos: 0, num: 20 });
    assert.equal(result.comments[0].comment_id, '0'); assert.equal(result.comments[0].replies[0].parent_comment_id, '0'); assert.equal(result.comments[0].replies[0].parent_comment_uin, 22222);
    assert.deepEqual(p.detail({ code: 0, tid: 'p1', content: '', cmtnum: 0 }, { tid: 'p1', targetUin: '12345', pos: 0, num: 20 }).comments, []);
    for (const body of [{ code: 0, tid: 'other', content: '', cmtnum: 0 }, { code: 0, tid: 'p1', uin: 99999, content: '', cmtnum: 0 },
        { code: 0, tid: 'p1', content: '', cmtnum: 5 }, { code: 0, tid: 'p1', content: '', cmtnum: 1, commentlist: 'bad' }]) assert.throws(() => p.detail(body, { tid: 'p1', targetUin: '12345', pos: 0, num: 20 }), { code: 'INVALID_RESPONSE' });
});

test('feed markup extraction isolates own content/images from comments, avatars, summaries and video covers', () => {
    const html = '<div class="f-single"><div class="f-item" data-key="key1"><input name="feed_data" data-uin="12345" data-fkey="key1" data-tid="post1">' +
        '<div class="f-info">summary<a data-cmd="qz_toggle">更多</a></div><div class="f-info qz_info_complete">真实 &amp; 正文<br>next<img alt="[笑]" src="face"></div>' +
        '<div class="img-item" data-originurl="//qpic.cn/post.jpg"></div><div class="f-ct-video"><div class="img-item" data-originurl="https://qpic.cn/video.jpg"></div></div>' +
        '<div class="mod-comments"><div class="f-info">comment text</div><div class="img-item" data-originurl="https://qpic.cn/comment.jpg"></div></div></div><a class="qz_like_btn_v3" data-likecnt="5"></a></div>';
    const result = parseFeedContent({ html, key: 'key1', uin: 12345, appid: 311, like_count: null, comment_count: 7 });
    assert.equal(result.tid, 'post1'); assert.equal(result.content, '真实 & 正文\nnext[笑]'); assert.equal(result.content_complete, true);
    assert.deepEqual(result.images, ['https://qpic.cn/post.jpg']); assert.equal(result.like_count, 5); assert.equal(result.comment_count, 7);
    const unknown = parseFeedContent({ html: '<div>unknown</div>', key: 'key1', uin: 12345, appid: 311, like_count: null, comment_count: null });
    assert.deepEqual(unknown, { tid: null, content: null, content_complete: null, images: null, like_count: null, comment_count: null });
});

test('feed continuation requires real end markers and fixed exact state; server clock alone is no progress', () => {
    assert.deepEqual(p.feeds({ code: 0, data: { data: [null], main: { hasMoreFeeds: 0 } } }, 10), { feeds: [], has_more: false, next_cursor: null });
    for (const body of [{ code: 0, data: {} }, { code: 0, data: { data: [] } }, { code: 0, data: { data: [], main: { hasMoreFeeds: 0, error: 'failure' } } }]) assert.throws(() => p.feeds(body, 10));
    const initial = p.initialState(); assert.equal(p.position(initial), p.position(p.nextState({ icServerTime: 123 }, initial)));
    assert.notEqual(p.position(initial), p.position(p.nextState({ pagenum: 2, externparam: 'opaque' }, initial)));
    assert.throws(() => p.nextState({ pagenum: 0 }, initial), { code: 'INVALID_RESPONSE' });
});

test('feed integer diagnostics identify only fixed schema fields and retain strict values', () => {
    const row = { uin: '12345', key: 'PRIVATE_KEY', nickname: 'PRIVATE_NAME', abstime: 123, appid: 311, html: 'PRIVATE_BODY' };
    for (const field of ['uin', 'abstime', 'appid']) {
        for (const [invalid, reason] of [[undefined, 'missing'], [-1, 'noncanonical'], ['PRIVATE_VALUE', 'noncanonical'], [null, 'null'], [true, 'type'], [9007199254740993, 'unsafe']]) {
            assert.throws(() => p.feeds({ code: 0, data: { data: [{ ...row, [field]: invalid }], main: { hasMoreFeeds: false } } }, 2), error =>
                error.code === 'INVALID_RESPONSE' && error.message === 'Qzone requires an exact bounded integer [field=feed.' + field + ';reason=' + reason + ']' && !/PRIVATE|12345|9007199/.test(error.message));
        }
    }
    for (const field of Object.keys(p.initialState()).filter(key => !['externparam', 'daylist', 'uinlist'].includes(key))) {
        assert.throws(() => p.nextState({ [field]: 'PRIVATE_VALUE' }, p.initialState()), error =>
            error.code === 'INVALID_RESPONSE' && error.message === 'Qzone requires an exact bounded integer [field=continuation.' + field + ';reason=noncanonical]');
    }
});

test('feed zero author remains an explicit unattributed sentinel and never relaxes actual target identities', () => {
    const row = { uin: '0', key: 'system-feed', nickname: '', abstime: 123, appid: 311, html: '' };
    const parsed = p.feeds({ code: 0, data: { data: [row, { ...row, uin: 12345 }], main: { hasMoreFeeds: false } } }, 2);
    assert.equal(parsed.feeds[0].uin, 0); assert.equal(parsed.feeds[0].author_kind, 'system-or-unattributed');
    assert.equal(parsed.feeds[1].uin, 12345); assert.equal(parsed.feeds[1].author_kind, 'qq-user');
    assert.throws(() => p.uin(0), { code: 'INVALID_PARAMS' });
    assert.throws(() => p.validate({ operation: 'qzone.list', targetUin: 0 }, false), { code: 'INVALID_PARAMS' });
    assert.throws(() => p.validate({ operation: 'qzone.ban', userId: 0 }, true), { code: 'INVALID_PARAMS' });
    assert.throws(() => p.feeds({ code: 0, data: { data: [{ ...row, uin: undefined }], main: { hasMoreFeeds: false } } }, 2), { code: 'INVALID_RESPONSE' });
});

test('visibility payload preserves whitespace and complete image identity/encoding and rejects lossy updates', () => {
    const detail = { code: 0, tid: 'p1', uin: 12345, content: 'original', conlist: [{ con: ' a ' }, { con: '\nb ' }], richtype: 1,
        pic: [{ pic_id: ',album,location', pictype: 22, height: 20, width: 10, url3: 'https://qpic.cn/a?bo=abcd%2B' }] };
    const form = p.updatePayload(detail, '12345', 'p1'); assert.equal(form.con, ' a \nb '); assert.equal(form.richval, ',album,location,location,22,20,10,,0,0'); assert.equal(form.pic_bo, 'abcd+\tabcd+');
    for (const raw of [{ ...detail, uin: 99999 }, { ...detail, tid: 'other' }, { ...detail, pic: [] }, { ...detail, pic: [{ pic_id: ',album,location' }] }]) assert.throws(() => p.updatePayload(raw, '12345', 'p1'));
    assert.throws(() => p.updatePayload({ ...detail, richtype: 2 }, '12345', 'p1'), { code: 'UNSUPPORTED' });
});
