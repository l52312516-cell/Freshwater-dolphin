'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gfs = require('../src/qq/group-file-space.cjs');
const { varintField, bytesField, messageField, fields, one, unsigned } = require('../src/qq/proto.cjs');

function response({ command = 0x6d8, sub = 3, errorCode = 0, total = 10737418240, used = 184, omitBody = false } = {}) {
    const spaceResp = messageField(4, [
        ...(total === null ? [] : [varintField(4, total)]),
        ...(used === null ? [] : [varintField(5, used)])
    ]);
    const body = omitBody ? Buffer.alloc(0) : spaceResp;
    return Buffer.concat([varintField(1, command), varintField(2, sub), varintField(3, errorCode), bytesField(4, body)]);
}

test('encodeNativeRequest is the OidbBase envelope with the verified group-file space fields', () => {
    const top = fields(gfs.encodeNativeRequest(1103828635));
    assert.equal(Number(unsigned(one(top, 1), 0xffffffffn)), 0x6d8);
    assert.equal(Number(unsigned(one(top, 2), 0xffffffffn)), 3);
    assert.equal(Number(unsigned(one(top, 12), 0xffffffffn)), 1);
    const info = fields(one(fields(one(top, 4).value), 4).value);
    assert.equal(Number(unsigned(one(info, 1), 0xffffffffn)), 1103828635);
    assert.equal(Number(unsigned(one(info, 2), 0xffffffffn)), 7, 'appId constant');
    assert.equal(gfs.NATIVE_CMD, 'OidbSvcTrpcTcp.0x6d8_3');
});

test('encodeNativeRequest rejects malformed group identities', () => {
    assert.throws(() => gfs.encodeNativeRequest('abc'), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfs.encodeNativeRequest(0), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfs.encodeNativeRequest(0x100000000), { code: 'INVALID_PARAMS' });
});

test('decodeResponse extracts total and used space from a successful response', () => {
    assert.deepEqual(gfs.decodeResponse(response()), { totalSpace: 10737418240, usedSpace: 184 });
});

test('decodeResponse keeps out-of-safe-range uint64 space as a decimal string', () => {
    const big = 9007199254740993n;
    const result = gfs.decodeResponse(response({ total: big, used: 0n }));
    assert.equal(result.totalSpace, '9007199254740993');
    assert.equal(result.usedSpace, 0);
});

test('decodeResponse rejects command mismatch, transport errors and invalid space', () => {
    assert.throws(() => gfs.decodeResponse(response({ command: 0x6d6 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfs.decodeResponse(response({ sub: 2 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfs.decodeResponse(response({ errorCode: 69 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfs.decodeResponse(response({ omitBody: true })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfs.decodeResponse(response({ total: null })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfs.decodeResponse(response({ used: null })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfs.decodeResponse(response({ total: 10, used: 20 })), { code: 'INVALID_RESPONSE' });
});
