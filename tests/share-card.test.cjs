'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeShareData, buildShareCard, createShareCards } = require('../src/qq/share-card.cjs');
const data = { url: 'https://github.com/l52312516-cell/Freshwater-dolphin#readme', title: 'Freshwater 分享测试', content: 'A\n B', image: 'https://q1.qlogo.cn/g?b=qq&nk=1000000001&s=100' };
function fixture() {
    const capture = { epoch: 'session-1', self: { uin: '123', uid: 'u_123' }, ready: true,
        ensureReady() { if (!this.ready) throw Object.assign(new Error('not ready'), { code: 'NOT_READY' }); } };
    const cards = createShareCards(capture), peer = { chatType: 2, peerUid: '456' };
    const params = () => ({ expectedEpoch: capture.epoch, peer, data });
    return { capture, cards, peer, params };
}
test('fixed news card preserves safe content and never contains caller music/native fields', () => {
    const card = JSON.parse(buildShareCard(data));
    assert.deepEqual(card, { app: 'com.tencent.structmsg', view: 'news', prompt: data.title,
        meta: { news: { title: data.title, desc: data.content, jumpUrl: data.url, preview: data.image } } });
    assert.equal(Object.hasOwn(card.meta, 'music'), false);
    assert.deepEqual(normalizeShareData({ url: data.url, title: data.title }), { url: data.url, title: data.title, content: '', image: '' });
});
test('share rejects executable URLs, credentials, malformed input and unknown template fields', () => {
    for (const invalid of [{ ...data, url: 'javascript:alert(1)' }, { ...data, url: 'file:///private' },
        { ...data, url: 'https://user:password@example.com' }, { ...data, url: 'https://example.com\r\nx' },
        { ...data, image: 'data:image/png,abc' }, { ...data, title: '' }, { ...data, music: {} },
        { ...data, app: 'com.tencent.music.lua' }, { ...data, ver: '99.0.0' }, { ...data, config: { type: 'normal' } },
        { ...data, prompt: 'other' }, { ...data, content: 'x'.repeat(4097) }, [], null]) {
        assert.throws(() => buildShareCard(invalid), { code: 'INVALID_PARAMS' });
    }
});
test('share preparation is bound to a real ready account, epoch and exact target', () => {
    const f = fixture(), element = f.cards.prepare(f.params());
    assert.equal(f.cards.verify(element, f.peer), element.shareToken);
    assert.throws(() => f.cards.verify(element, { ...f.peer, peerUid: '999' }), { code: 'INVALID_PARAMS' });
    assert.throws(() => f.cards.verify(element, { chatType: 1, peerUid: 'u_456' }), { code: 'INVALID_PARAMS' });
    assert.throws(() => f.cards.prepare({ ...f.params(), expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    f.capture.ready = false;
    assert.throws(() => f.cards.verify(element, f.peer), { code: 'NOT_READY' });
});
test('tampered Ark and music credentials cannot use the separate share capability', () => {
    const f = fixture(), element = f.cards.prepare(f.params());
    for (const invalid of [{ ...element, musicToken: 'other' }, { ...element, shareToken: 'forged' },
        { ...element, arkElement: { ...element.arkElement, bytesData: element.arkElement.bytesData.replace('news', 'music') } },
        { ...element, arkElement: { ...element.arkElement, command: 'arbitrary' } }]) {
        assert.throws(() => f.cards.verify(invalid, f.peer), { code: 'INVALID_PARAMS' });
    }
    assert.ok(f.cards.verify(element, f.peer));
});
test('consumed shares are one use and an account or session switch invalidates pending shares', () => {
    for (const change of [f => { f.capture.epoch = 'new'; }, f => { f.capture.self.uin = '999'; }, f => { f.capture.self.uid = 'u_new'; }]) {
        const f = fixture(), element = f.cards.prepare(f.params());
        change(f);
        assert.throws(() => f.cards.verify(element, f.peer), { code: 'INVALID_PARAMS' });
    }
    const f = fixture(), element = f.cards.prepare(f.params());
    assert.equal(f.cards.consume(element.shareToken), true);
    assert.throws(() => f.cards.verify(element, f.peer), { code: 'INVALID_PARAMS' });
});
test('share queue has a hard bound and a separate processor cannot reuse its credentials', () => {
    const f = fixture(), element = f.cards.prepare(f.params());
    for (let index = 1; index < 100; index++) f.cards.prepare(f.params());
    assert.throws(() => f.cards.prepare(f.params()), { code: 'BUSY' });
    assert.throws(() => fixture().cards.verify(element, f.peer), { code: 'INVALID_PARAMS' });
    f.cards.clear();
    assert.ok(f.cards.prepare(f.params()));
});
