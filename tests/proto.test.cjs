'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const U64_MAX = 0xffffffffffffffffn;

test('protobuf varints preserve the complete uint64 range including ten-byte values', () => {
    for (const value of [0n, 127n, 128n, 9007199254740993n, 1n << 63n, U64_MAX]) {
        const encoded = p.varint(value);
        assert.deepEqual(p.readVarint(encoded, 0), { value, offset: encoded.length });
        const message = p.fields(p.varintField(1, value));
        assert.equal(p.unsigned(p.one(message, 1), U64_MAX), value);
    }
    assert.equal(p.varint(U64_MAX).length, 10);
    assert.deepEqual(p.varint(U64_MAX.toString()), p.varint(U64_MAX));
});

test('protobuf encoders reject rounded numbers, coercible objects and invalid unsigned values', () => {
    for (const value of [-1, -1n, U64_MAX + 1n, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 0.5,
        null, true, {}, { valueOf: () => 1 }, '', '01', '-1', '1e3', '18446744073709551616']) {
        assert.throws(() => p.varint(value), { code: 'INVALID_PARAMS' });
    }
    assert.throws(() => p.bytesField(1, 'text'), { code: 'INVALID_PARAMS' });
    assert.throws(() => p.messageField(1, [Buffer.alloc(0), 'text']), { code: 'INVALID_PARAMS' });
});

test('protobuf tags use exact arithmetic up to the maximum valid field number', () => {
    const maximum = 0x1fffffff;
    const top = p.fields(Buffer.concat([p.varintField(maximum, 7), p.bytesField(maximum - 1, Buffer.from('x'))]));
    assert.equal(p.one(top, maximum).value, 7n);
    assert.equal(p.one(top, maximum - 1).value.toString(), 'x');
    for (const field of [0, -1, maximum + 1, 1.5, '1', NaN]) {
        assert.throws(() => p.varintField(field, 0), { code: 'INVALID_PARAMS' });
        assert.throws(() => p.bytesField(field, Buffer.alloc(0)), { code: 'INVALID_PARAMS' });
    }
    for (const tag of [0n, BigInt(maximum + 1) * 8n]) {
        assert.throws(() => p.fields(Buffer.concat([p.varint(tag), Buffer.from([0])])), { code: 'INVALID_RESPONSE' });
    }
});

test('protobuf parsing rejects truncated and overflowing varints without rejecting uint64 max', () => {
    for (const input of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.alloc(10, 0x80),
        Buffer.from([...Array(9).fill(0xff), 0x02]), Buffer.alloc(11, 0xff)]) {
        assert.throws(() => p.readVarint(input, 0), { code: 'INVALID_RESPONSE' });
    }
    for (const offset of [-1, 0.5, NaN, 2]) assert.throws(() => p.readVarint(Buffer.from([0]), offset), { code: 'INVALID_RESPONSE' });
    assert.throws(() => p.fields('not bytes'), { code: 'INVALID_RESPONSE' });
    const prefixed = Buffer.concat([Buffer.from([0xff]), p.varint(U64_MAX)]);
    assert.deepEqual(p.readVarint(prefixed, 1), { value: U64_MAX, offset: 11 });
});

test('protobuf lengths are checked against the actual buffer before any Number conversion', () => {
    for (const length of [1n, 9007199254740993n, U64_MAX]) {
        assert.throws(() => p.fields(Buffer.concat([Buffer.from([0x0a]), p.varint(length)])), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(p.one(p.fields(Buffer.from([0x0a, 0])), 1).value.length, 0);
    assert.throws(() => p.fields(Buffer.from([0x0a, 3, 1, 2])), { code: 'INVALID_RESPONSE' });
});

test('fixed32 and fixed64 fields cannot silently consume truncated payloads', () => {
    for (const [wire, width] of [[1, 8], [5, 4]]) {
        for (let length = 0; length < width; length++) {
            assert.throws(() => p.fields(Buffer.concat([Buffer.from([8 | wire]), Buffer.alloc(length)])), { code: 'INVALID_RESPONSE' });
        }
        const payload = Buffer.alloc(width, 0xaa);
        const top = p.fields(Buffer.concat([Buffer.from([8 | wire]), payload, p.varintField(2, 3)]));
        assert.deepEqual(p.one(top, 1), { wire, value: payload });
        assert.equal(p.one(top, 2).value, 3n);
    }
    for (const wire of [3, 4, 6, 7]) assert.throws(() => p.fields(Buffer.from([8 | wire])), { code: 'INVALID_RESPONSE' });
});

test('repeated protobuf fields preserve ordered values and text keeps strict UTF-8 byte limits', () => {
    const top = p.fields(Buffer.concat([p.varintField(1, 1), p.varintField(1, 2), p.bytesField(2, Buffer.from('鱼'))]));
    assert.deepEqual(top.get(1).map(item => item.value), [1n, 2n]);
    assert.equal(p.text(p.one(top, 2), 3), '鱼');
    assert.equal(p.text(p.one(top, 2), 2), null);
    assert.equal(p.text({ wire: 2, value: Buffer.from([0xff]) }, 3), null);
    assert.equal(p.unsigned(undefined, U64_MAX), null);
    assert.equal(p.unsigned(null, U64_MAX), null);
    for (const entry of [{ wire: 0, value: -1n }, { wire: 0, value: 1 }, { wire: 0, value: U64_MAX },
        { wire: 2, value: Buffer.alloc(0) }]) {
        assert.throws(() => p.unsigned(entry, 0xffffffffn), { code: 'INVALID_RESPONSE' });
    }
    for (const maximum of [-1n, U64_MAX + 1n, 7, undefined]) {
        assert.throws(() => p.unsigned({ wire: 0, value: 0n }, maximum), { code: 'INVALID_RESPONSE' });
    }
});

test('the group-space consumer receives complete uint64 capacities as decimal strings', () => {
    const gfs = require('../src/qq/group-file-space.cjs');
    const packet = Buffer.concat([p.varintField(1, 0x6d8), p.varintField(2, 3), p.varintField(3, 0),
        p.messageField(4, [p.messageField(4, [p.varintField(4, U64_MAX), p.varintField(5, U64_MAX - 1n)])])]);
    assert.deepEqual(gfs.decodeResponse(packet), { totalSpace: U64_MAX.toString(), usedSpace: (U64_MAX - 1n).toString() });
});

test('download decoders cannot default malformed present error fields to successful zero', () => {
    const gfs = require('../src/qq/group-file-space.cjs');
    const gfu = require('../src/qq/group-file-url.cjs');
    const video = require('../src/qq/video-url.cjs');
    const encode = (command, sub, body, error) => Buffer.concat([
        p.varintField(1, command), p.varintField(2, sub), error, p.bytesField(4, body)]);
    const cases = [
        { command: 0x6d8, sub: 3, decode: gfs.decodeResponse,
            body: p.messageField(4, [p.varintField(4, 100), p.varintField(5, 10)]) },
        { command: 0x6d6, sub: 2, decode: gfu.decodeResponse,
            body: p.messageField(3, [p.varintField(1, 0), p.bytesField(5, Buffer.from('download.qq.com')), p.bytesField(6, Buffer.from([1]))]) },
        { command: 0x11ea, sub: 200, decode: packet => video.decodeResponse(packet, true),
            body: p.messageField(3, [p.bytesField(1, Buffer.from('&rkey=fixture')), p.messageField(3, [
                p.bytesField(1, Buffer.from('multimedia.nt.qq.com.cn')), p.bytesField(2, Buffer.from('/download?file=fixture'))])]) }
    ];
    for (const item of cases) {
        assert.doesNotThrow(() => item.decode(encode(item.command, item.sub, item.body, p.varintField(3, 0))));
        for (const error of [p.bytesField(3, Buffer.from('0')), p.varintField(3, 0x100000000n), p.varintField(3, U64_MAX)]) {
            assert.throws(() => item.decode(encode(item.command, item.sub, item.body, error)), { code: 'INVALID_RESPONSE' });
        }
    }
    for (const retCode of [p.bytesField(1, Buffer.from('0')), p.varintField(1, U64_MAX)]) {
        const body = p.messageField(3, [retCode, p.bytesField(5, Buffer.from('download.qq.com')), p.bytesField(6, Buffer.from([1]))]);
        assert.throws(() => gfu.decodeResponse(encode(0x6d6, 2, body, p.varintField(3, 0))), { code: 'INVALID_RESPONSE' });
    }
});
