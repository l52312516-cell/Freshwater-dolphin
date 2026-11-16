'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const wire = require('../src/qq/proto.cjs'), protocol = require('../src/qq/voice-extra-protocol.cjs');
const n = wire.varintField, b = wire.bytesField, m = wire.messageField, s = (tag, value) => b(tag, Buffer.from(value));
const read = (map, tag) => wire.one(map, tag)?.value, child = (map, tag) => wire.fields(read(map, tag));
const request = { groupId: '33333', character: 'voice-real-id', text: ' exact 中文 \n', chatType: 1, sessionId: 0xcafebabe };
const node = { fileUuid: 'real_media_uuid', info: { fileSize: 16, fileHash: 'a'.repeat(32), fileName: 'voice.silk', type: { type: 3, voiceFormat: 1 }, time: 1 }, storeId: 1, ttl: 100 };
const envelope = (prepared, body, extra = []) => Buffer.concat([n(1, prepared.command), n(2, prepared.sub), b(4, body), ...extra]);
const index = (overrides = {}) => m(1, [m(1, [n(1, overrides.fileSize ?? 16), s(2, overrides.fileHash ?? 'a'.repeat(32)), s(4, 'voice.silk'), m(5, [n(1, overrides.type ?? 3), n(4, 1)]), n(8, 1)]), s(2, overrides.uuid ?? 'real_media_uuid'), n(3, 1), n(5, 100)]);

test('AI synthesis fixes 0x929B and preserves group, character, text, chat type and deduplication session', () => {
    const prepared = protocol.prepare('voice.synthesize', request), outer = wire.fields(prepared.body), body = child(outer, 4);
    assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x929b_0'); assert.equal(prepared.mode, 1); assert.equal(read(outer, 12), 1n);
    assert.equal(read(body, 1), 33333n); assert.equal(read(body, 2).toString(), request.character); assert.equal(read(body, 3).toString(), request.text);
    assert.equal(read(body, 4), 1n); assert.equal(read(child(body, 5), 1), 0xcafebaben);
    for (const data of [{ ...request, sessionId: 0 }, { ...request, sessionId: Number.MAX_SAFE_INTEGER }, { ...request, groupId: '033333' }, { ...request, chatType: 3 },
        { ...request, text: '' }, { ...request, url: 'https://evil.example' }]) assert.throws(() => protocol.prepare('voice.synthesize', data), { code: 'INVALID_PARAMS' });
    assert.throws(() => protocol.prepare('arbitrary', request), { code: 'UNSUPPORTED' });
});

test('AI synthesis distinguishes known pending replies from complete exact media indexes and errors', () => {
    const prepared = protocol.prepare('voice.synthesize', request);
    assert.equal(protocol.decode(n(1, 0x929b), prepared).pending, true, 'known protobuf zero fields and empty pending body may be omitted');
    assert.equal(protocol.decode(envelope(prepared, m(4, [])), prepared).pending, true);
    const result = protocol.decode(envelope(prepared, m(4, [m(1, [index()])])), prepared);
    assert.deepEqual(result, { ...request, pending: false, node });
    for (const overrides of [{ fileSize: 0 }, { fileHash: 'invalid' }, { type: 2 }, { uuid: 'wrong uuid' }]) assert.throws(() => protocol.decode(envelope(prepared, m(4, [m(1, [index(overrides)])])), prepared), { code: 'INVALID_RESPONSE' });
    for (const bytes of [Buffer.alloc(0), envelope(prepared, n(1, 5)), envelope(prepared, Buffer.alloc(0), [n(3, 1)]), envelope(prepared, Buffer.alloc(0), [n(12, 0)]),
        envelope(prepared, Buffer.alloc(0), [n(2, 0)]), envelope(prepared, m(4, [m(1, [index()]), m(1, [index()])])), envelope(prepared, m(4, [m(1, [index(), index()])]))]) assert.throws(() => protocol.decode(bytes, prepared));
});

test('voice rejections expose only a fixed envelope or business stage and an exact uint32 code', () => {
    const synth = protocol.prepare('voice.synthesize', request), download = protocol.prepare('voice.url', { groupId: '33333', node });
    for (const code of [1, 0xffffffff]) {
        for (const [prepared, body, extra, phase] of [[synth, Buffer.alloc(0), [n(3, code)], 'oidb-envelope'],
            [synth, Buffer.concat([n(1, code), s(99, 'private-server-text')]), [], 'synthesis-body'],
            [download, m(1, [n(2, code)]), [], 'download-head']]) {
            assert.throws(() => protocol.decode(envelope(prepared, body, extra), prepared), error => {
                assert.equal(error.code, 'KERNEL_ERROR'); assert.match(error.message, new RegExp('phase=' + phase + '; business_code=' + code + '$'));
                assert.doesNotMatch(error.message, /private-server-text|33333|real_media_uuid/); return true;
            });
        }
    }
    assert.equal(protocol.decode(envelope(synth, m(4, [m(1, [index()])]), [n(12, 1)]), synth).pending, false);
    assert.throws(() => protocol.decode(envelope(synth, n(1, 0x100000000)), synth), { code: 'INVALID_RESPONSE' });
});

test('generated voice URL request retains actual media index and fixed group voice scene', () => {
    const prepared = protocol.prepare('voice.url', { groupId: '33333', node }), body = child(wire.fields(prepared.body), 4), head = child(body, 1), scene = child(head, 2);
    assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x126e_200'); assert.equal(prepared.mode, 1);
    assert.equal(read(scene, 102), 3n); assert.equal(read(scene, 200), 2n); assert.equal(read(child(scene, 202), 1), 33333n);
    assert.equal(read(child(child(body, 3), 1), 2).toString(), node.fileUuid);
    const response = (domain, path = '/download?token=', key = 'official') => envelope(prepared, Buffer.concat([m(1, [n(2, 0)]), m(3, [s(1, key), m(3, [s(1, domain), s(2, path)])])]), [n(12, 1)]);
    assert.deepEqual(protocol.decode(response('multimedia.nt.qq.com'), prepared), { groupId: '33333', fileUuid: node.fileUuid, url: 'https://multimedia.nt.qq.com/download?token=official' });
    for (const [domain, path, key] of [['evil.example', '/a', ''], ['127.0.0.1', '/a', ''], ['good.qq.com', '//evil.example', ''], ['good.qq.com', '/a', '#fragment'], ['good.qq.com:443', '/a', '']]) assert.throws(() => protocol.decode(response(domain, path, key), prepared));
    assert.throws(() => protocol.decode(envelope(prepared, m(1, [n(2, 1)])), prepared), { code: 'KERNEL_ERROR' });
    assert.throws(() => protocol.decode(n(1, 0x126e), prepared), { code: 'INVALID_RESPONSE' });
});
