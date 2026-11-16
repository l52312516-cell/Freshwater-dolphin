'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gfu = require('../src/qq/group-file-url.cjs');
const { varintField, bytesField, messageField, fields, one, unsigned } = require('../src/qq/proto.cjs');

function response({ command = 0x6d6, sub = 2, errorCode = 0, retCode = 0, wording = 'ok',
    dns = 'njc-download.ftn.qq.com', token = Buffer.from('0102030405', 'hex'), omitBody = false, omitToken = false } = {}) {
    const download = messageField(3, [
        varintField(1, retCode),
        ...(wording === null ? [] : [bytesField(3, Buffer.from(wording, 'utf8'))]),
        ...(dns === null ? [] : [bytesField(5, Buffer.from(dns, 'utf8'))]),
        ...(omitToken ? [] : [bytesField(6, token)])
    ]);
    const body = omitBody ? Buffer.alloc(0) : download;
    return Buffer.concat([varintField(1, command), varintField(2, sub), varintField(3, errorCode), bytesField(4, body)]);
}

test('encodeNativeRequest is the OidbBase envelope with the verified group-file download fields', () => {
    const request = gfu.encodeNativeRequest(2000000001, '/d1e95931-02ce-4b6a-9dc8-4e39058bb4b6', 102);
    const top = fields(request);
    assert.equal(Number(unsigned(one(top, 1), 0xffffffffn)), 0x6d6, 'command');
    assert.equal(Number(unsigned(one(top, 2), 0xffffffffn)), 2, 'subCommand');
    assert.equal(Number(unsigned(one(top, 12), 0xffffffffn)), 1, 'isReserved');
    const download = fields(one(top, 4).value);
    const info = fields(one(download, 3).value);
    assert.equal(Number(unsigned(one(info, 1), 0xffffffffn)), 2000000001, 'groupCode');
    assert.equal(Number(unsigned(one(info, 2), 0xffffffffn)), 7, 'appId constant');
    assert.equal(Number(unsigned(one(info, 3), 0xffffffffn)), 102, 'busId');
    assert.equal(one(info, 4).value.toString('utf8'), '/d1e95931-02ce-4b6a-9dc8-4e39058bb4b6', 'fileId');
    assert.equal(gfu.NATIVE_CMD, 'OidbSvcTrpcTcp.0x6d6_2');
    assert.equal(gfu.CMD, 'OidbSvc.0x6d6_2');
});

test('encodeNativeRequest defaults the group-file bus ID to 102', () => {
    const request = gfu.encodeNativeRequest(12345, '/file');
    const info = fields(one(fields(one(fields(request), 4).value), 3).value);
    assert.equal(Number(unsigned(one(info, 3), 0xffffffffn)), 102);
});

test('encodeNativeRequest rejects malformed group, file and bus identities', () => {
    assert.throws(() => gfu.encodeNativeRequest('abc', '/file'), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfu.encodeNativeRequest(0, '/file'), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfu.encodeNativeRequest(123, ''), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfu.encodeNativeRequest(123, '/file', -1), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfu.encodeNativeRequest(123, '/file', 0x100000000), { code: 'INVALID_PARAMS' });
    assert.throws(() => gfu.encodeNativeRequest(123, '/bad\x00id'), { code: 'INVALID_PARAMS' });
});

test('decodeResponse builds the official ftn_handler URL from a successful response', () => {
    const result = gfu.decodeResponse(response({ token: Buffer.from('deadbeef', 'hex') }));
    assert.equal(result.retCode, 0);
    assert.equal(result.downloadDns, 'njc-download.ftn.qq.com');
    assert.equal(result.downloadUrlHex, 'deadbeef');
    assert.equal(result.url, 'https://njc-download.ftn.qq.com/ftn_handler/deadbeef/?fname=');
});

test('withFileName appends the URL-encoded real file name', () => {
    const result = gfu.decodeResponse(response());
    assert.equal(gfu.withFileName(result, '测试 文件.zip'),
        'https://njc-download.ftn.qq.com/ftn_handler/0102030405/?fname=' + encodeURIComponent('测试 文件.zip'));
    assert.equal(gfu.withFileName(result, ''), result.url);
});

test('decodeResponse rejects command mismatch, transport and business errors', () => {
    assert.throws(() => gfu.decodeResponse(response({ command: 0x9067 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfu.decodeResponse(response({ sub: 9 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfu.decodeResponse(response({ errorCode: 253 })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfu.decodeResponse(response({ retCode: 190, wording: 'file expired' })), { code: 'QUERY_FAILED' });
    assert.throws(() => gfu.decodeResponse(response({ omitBody: true })), { code: 'QUERY_FAILED' });
});

test('decodeResponse rejects untrusted hosts and malformed download tokens', () => {
    assert.throws(() => gfu.decodeResponse(response({ dns: 'evil.example.com' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfu.decodeResponse(response({ dns: 'bad host.qq.com' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfu.decodeResponse(response({ dns: 'a..qq.com' })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfu.decodeResponse(response({ token: Buffer.alloc(0) })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfu.decodeResponse(response({ token: Buffer.alloc(4097) })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => gfu.decodeResponse(response({ omitToken: true })), { code: 'INVALID_RESPONSE' });
});
