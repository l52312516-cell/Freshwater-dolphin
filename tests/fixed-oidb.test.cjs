'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixed = require('../src/qq/fixed-oidb.cjs');
const p = require('../src/qq/proto.cjs');
const join = (...parts) => Buffer.concat(parts);
const ack = (prepared, body = Buffer.alloc(0)) => join(p.varintField(1, prepared.command), p.varintField(2, prepared.sub), p.varintField(3, 0), p.bytesField(4, body));
const body = prepared => p.fields(p.one(p.fields(prepared.body), 4).value);

test('fixed poke and permanent-title encoders retain exact identities and explicit clearing fields', () => {
    const poke = fixed.prepare('message.poke', { chatType: 1, peerUin: '12345', targetUin: '12345' });
    assert.equal(poke.name, 'OidbSvcTrpcTcp.0xed3_1');
    assert.equal(p.one(body(poke), 1).value, 12345n);
    assert.equal(p.one(body(poke), 2).value, 0n);
    assert.equal(p.one(body(poke), 5).value, 12345n);
    assert.throws(() => fixed.prepare('message.poke', { chatType: 1, peerUin: '12345', targetUin: '54321' }), { code: 'INVALID_PARAMS' });
    const title = fixed.prepare('group.title', { groupId: '2000000001', uid: 'u_member', title: '' });
    const item = p.fields(p.one(body(title), 3).value);
    assert.equal(p.one(item, 5).value.length, 0);
    assert.equal(p.one(item, 7).value.length, 0);
    assert.equal(p.one(item, 6).value, 0xffffffffffffffffn);
    assert.equal(fixed.decode(ack(title), title).confirmation, 'server_ack');
});

test('reactions and essence reject guessed values and encode a real zero random explicitly', () => {
    const reaction = fixed.prepare('message.emoji', { groupId: '123', sequence: '4294967295', emojiId: '128512', set: false });
    assert.equal(reaction.name, 'OidbSvcTrpcTcp.0x9082_2');
    assert.equal(p.one(body(reaction), 5).value, 2n);
    const essence = fixed.prepare('group.essence', { groupId: '123', sequence: '7', random: '0', set: true });
    assert.equal(p.one(body(essence), 3).value, 0n);
    for (const change of [{ sequence: '4294967296' }, { emojiId: '1114112' }, { set: 'true' }, { cmd: 'Anything' }]) {
        assert.throws(() => fixed.prepare('message.emoji', { groupId: '123', sequence: '7', emojiId: '66', set: true, ...change }));
    }
    assert.throws(() => fixed.prepare('send', { command: 'Anything', bodyHex: '00' }), { code: 'UNSUPPORTED' });
});

test('an ACK requires the correct command and explicit success without unknown business bodies', () => {
    const prepared = fixed.prepare('friend.category', { uid: 'u_friend', categoryId: 0 });
    assert.equal(p.one(p.fields(prepared.body), 12).value, 1n);
    for (const bytes of [Buffer.alloc(0), p.varintField(3, 0), join(p.varintField(1, prepared.command), p.varintField(2, prepared.sub)),
        join(ack(prepared), p.varintField(3, 0)), ack({ ...prepared, command: 1 }), ack(prepared, p.varintField(1, 5))]) {
        assert.throws(() => fixed.decode(bytes, prepared), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(fixed.decode(ack(prepared), prepared).categoryId, 0);
});

test('OCR preserves text and coordinates from the fixed bounded result, not an arbitrary response', () => {
    const prepared = fixed.prepare('image.ocr', { imageUrl: 'https://example.org/image.png' });
    const point = join(p.varintField(1, 10), p.varintField(2, 20));
    const detected = join(p.bytesField(1, Buffer.from('保留\n换行')), p.varintField(2, 95), p.messageField(3, [p.bytesField(1, point)]));
    const result = p.messageField(10, [p.bytesField(1, detected), p.bytesField(2, Buffer.from('zh'))]);
    assert.deepEqual(fixed.decode(ack(prepared, result), prepared).texts, [{ text: '保留\n换行', confidence: 95, coordinates: [{ x: 10, y: 20 }] }]);
    for (const imageUrl of ['file:///etc/passwd', 'https://user:secret@example.org/image', 'https://example.org/image#fragment']) {
        assert.throws(() => fixed.prepare('image.ocr', { imageUrl }), { code: 'INVALID_PARAMS' });
    }
});

test('system face and voice catalogs retain their hierarchy and requested identity', () => {
    const voice = fixed.prepare('voice.characters', { groupId: '123', chatType: 2 });
    const voiceBody = p.messageField(1, [p.bytesField(1, Buffer.from('测试')), p.messageField(2, [p.bytesField(1, Buffer.from('voice-id')), p.bytesField(2, Buffer.from('音色'))])]);
    assert.equal(fixed.decode(ack(voice, voiceBody), voice).categories[0].voices[0].voiceId, 'voice-id');
    const face = fixed.prepare('face.get', { faceId: '66' });
    const response = p.messageField(1, [p.bytesField(1, Buffer.from('66')), p.bytesField(2, Buffer.from('爱心'))]);
    assert.equal(fixed.decode(ack(face, response), face).face.qSid, '66');
    assert.throws(() => fixed.decode(ack(face, p.messageField(1, [p.bytesField(1, Buffer.from('67'))])), face), { code: 'INVALID_RESPONSE' });
});

test('unrecognized ACK diagnostics retain structure without raw content or opaque identifiers', () => {
    const prepared = fixed.prepare('group.essence', { groupId: '123', sequence: '7', random: '0', set: true });
    const secret = Buffer.from('SECRET-URL-AND-IDENTIFIER');
    assert.throws(() => fixed.decode(ack(prepared, join(p.varintField(1, 0), p.bytesField(2, secret), p.varintField(3, 123456789))), prepared), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.match(error.message, /1\/0\/count=1\/flag=0/);
        assert.match(error.message, /2\/2\/count=1\/bytes=25/);
        assert.equal(error.message.includes('SECRET'), false);
        assert.equal(error.message.includes('123456789'), false);
        return true;
    });
});

test('reaction counter acknowledgements are candidates only and reject unknown or error-bearing bodies', () => {
    for (const set of [true, false]) {
        const prepared = fixed.prepare('message.emoji', { groupId: '123', sequence: '7', emojiId: '76', set });
        const reply = (...extra) => join(p.bytesField(1, Buffer.alloc(0)), p.varintField(2, 11), p.varintField(3, 3), ...extra);
        const candidate = fixed.decode(ack(prepared, reply()), prepared);
        assert.equal(candidate.confirmed, false);
        assert.equal(candidate.confirmation, 'requires_message_readback');
        assert.equal(fixed.decode(ack(prepared), prepared).confirmed, false, 'even an empty body cannot bypass the readback');
        for (const malformed of [reply(p.varintField(4, 0)), reply(p.varintField(2, 11)),
            join(p.bytesField(1, Buffer.from('business refusal')), p.varintField(2, 11), p.varintField(3, 3)),
            join(p.bytesField(1, Buffer.alloc(0)), p.varintField(2, 0), p.varintField(3, 3)),
            join(p.bytesField(1, Buffer.alloc(0)), p.varintField(2, 11), p.varintField(3, 0x100000000n)),
            p.bytesField(1, Buffer.alloc(0))]) {
            assert.throws(() => fixed.decode(ack(prepared, malformed), prepared), { code: 'INVALID_RESPONSE' });
        }
    }
});

test('only the full face catalog accepts a bounded reply larger than 64 KiB', () => {
    const catalog = fixed.prepare('face.list');
    const faces = Array.from({ length: 1000 }, (_, index) => p.messageField(2, [
        p.bytesField(1, Buffer.from(String(index))), p.bytesField(2, Buffer.from('目录说明'.repeat(7)))
    ]));
    const payload = p.messageField(2, [p.messageField(1, [p.bytesField(1, Buffer.from('测试目录')), ...faces])]);
    const response = ack(catalog, payload);
    assert.ok(response.length > 65536 && response.length < 262144);
    assert.equal(fixed.decode(response, catalog).packs[0].emojis.length, 1000);
    assert.throws(() => fixed.decode(response, fixed.prepare('face.get', { faceId: '0' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => fixed.decode(Buffer.alloc(262145), catalog), { code: 'INVALID_RESPONSE' });
});
