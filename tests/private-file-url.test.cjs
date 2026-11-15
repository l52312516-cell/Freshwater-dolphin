'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pfu = require('../src/qq/private-file-url.cjs');
const { varintField, bytesField, messageField, fields, one, unsigned } = require('../src/qq/proto.cjs');

function response({ command = 0xe37, sub = 1200, errorCode = 0, retCode = 0, state = 'ok',
    dns = 'njc-download.ftn.qq.com', token = Buffer.from('abcdef01', 'hex'), fileName = '私聊文件.txt', omitDownload = false } = {}) {
    const download = messageField(102, [
        ...(token === null ? [] : [bytesField(8, token)]),
        ...(dns === null ? [] : [bytesField(11, Buffer.from(dns, 'utf8'))])
    ]);
    const extra = messageField(120, [varintField(100, 0), download]);
    const result = messageField(30, [extra]);
    const metadata = messageField(40, [bytesField(7, Buffer.from(fileName, 'utf8'))]);
    const inner = messageField(14, [
        varintField(10, retCode), bytesField(20, Buffer.from(state, 'utf8')),
        ...(omitDownload ? [] : [result]), metadata
    ]);
    return Buffer.concat([varintField(1, command), varintField(2, sub), varintField(3, errorCode), bytesField(4, inner)]);
}

test('encodeNativeRequest carries the verified c2c file constants and identities', () => {
    const top = fields(pfu.encodeNativeRequest('u_receiver', 'md5_uuid-file'));
    assert.equal(Number(unsigned(one(top, 1), 0xffffffffn)), 0xe37);
    assert.equal(Number(unsigned(one(top, 2), 0xffffffffn)), 1200);
    assert.equal(Number(unsigned(one(top, 12), 0xffffffffn)), 1);
    const inner = fields(one(top, 4).value);
    assert.equal(Number(unsigned(one(inner, 1), 0xffffffffn)), 1200);
    assert.equal(Number(unsigned(one(inner, 2), 0xffffffffn)), 1);
    assert.equal(Number(unsigned(one(inner, 101), 0xffffffffn)), 3);
    assert.equal(Number(unsigned(one(inner, 102), 0xffffffffn)), 1);
    assert.equal(Number(unsigned(one(inner, 200), 0xffffffffn)), 1);
    assert.equal(one(inner, 99999).value.toString('hex'), 'c0852c01');
    const body = fields(one(inner, 14).value);
    assert.equal(one(body, 10).value.toString('utf8'), 'u_receiver');
    assert.equal(one(body, 20).value.toString('utf8'), 'md5_uuid-file');
    assert.equal(Number(unsigned(one(body, 30), 0xffffffffn)), 2);
    assert.equal(Number(unsigned(one(body, 601), 0xffffffffn)), 0);
    assert.equal(pfu.NATIVE_CMD, 'OidbSvcTrpcTcp.0xe37_1200');
});

test('encodeNativeRequest rejects malformed receiver UID and file UUID', () => {
    assert.throws(() => pfu.encodeNativeRequest('', 'uuid'), { code: 'INVALID_PARAMS' });
    assert.throws(() => pfu.encodeNativeRequest('u_ok', ''), { code: 'INVALID_PARAMS' });
    assert.throws(() => pfu.encodeNativeRequest('u_ok', 'bad\x00uuid'), { code: 'INVALID_PARAMS' });
});

test('decodeResponse extracts the nested ftn_handler URL and file name', () => {
    const result = pfu.decodeResponse(response());
    assert.equal(result.retCode, 0);
    assert.equal(result.downloadDns, 'njc-download.ftn.qq.com');
    assert.equal(result.downloadUrlHex, 'abcdef01');
    assert.equal(result.fileName, '私聊文件.txt');
    assert.equal(result.url, 'https://njc-download.ftn.qq.com/ftn_handler/abcdef01/?fname=');
    assert.equal(pfu.withFileName(result), 'https://njc-download.ftn.qq.com/ftn_handler/abcdef01/?fname=' + encodeURIComponent('私聊文件.txt'));
});

test('decodeResponse rejects command mismatch, transport and business errors', () => {
    assert.throws(() => pfu.decodeResponse(response({ command: 0x6d6 })), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeResponse(response({ sub: 1700 })), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeResponse(response({ errorCode: 253 })), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeResponse(response({ retCode: 190, state: 'expired' })), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeResponse(response({ omitDownload: true })), { code: 'INVALID_RESPONSE' });
});

test('decodeResponse rejects untrusted hosts and malformed tokens', () => {
    assert.throws(() => pfu.decodeResponse(response({ dns: 'evil.example.com' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(response({ dns: 'a..qq.com' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(response({ token: Buffer.alloc(0) })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(response({ token: Buffer.alloc(4097) })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(response({ token: null })), { code: 'INVALID_RESPONSE' });
});
