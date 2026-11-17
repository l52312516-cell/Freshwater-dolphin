'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pfu = require('../src/qq/private-file-url.cjs');
const { varintField: n, bytesField: b, messageField: m, fields, one } = require('../src/qq/proto.cjs');
const s = (tag, value) => b(tag, Buffer.from(value));
const expected = { fileId: 'actual-file-uuid', fileHash: 'opaque.hash+/=非MD5' };
function reply({ command = 0xe37, sub = 1200, reserved = 0, code = 0, status = 0,
    host = 'download.qq.com', port = 80, path = '/resource?sig=A%2fb+Z', metadata,
    result, omitResult = false, extra = Buffer.alloc(0) } = {}) {
    return Buffer.concat([n(1, command), n(2, sub), n(3, code), n(12, reserved),
        m(4, [m(14, [n(10, status), ...(omitResult ? [] : [b(30, result ?? Buffer.concat([
            s(20, host), n(40, port), s(50, path)]))]), ...(metadata === undefined ? [] : [b(40, metadata)])])]), extra]);
}

test('private file request carries the observed account UID, real file hash and UID-mode fields', () => {
    const top = fields(pfu.encodeNativeRequest('u_account', expected.fileId, expected.fileHash));
    assert.equal(one(top, 1).value, 0xe37n); assert.equal(one(top, 2).value, 1200n);
    assert.equal(one(top, 3).value, 0n); assert.equal(one(top, 12).value, 0n);
    const body = fields(one(top, 4).value), download = fields(one(body, 14).value);
    assert.equal(one(body, 102).value, 103n);
    assert.equal(one(download, 10).value.toString(), 'u_account');
    assert.equal(one(download, 20).value.toString(), expected.fileId);
    assert.equal(one(download, 60).value.toString(), expected.fileHash);
    assert.equal(pfu.NATIVE_CMD, 'OidbSvcTrpcTcp.0xe37_1200');
});

test('private file identity rejects missing hashes, malformed UTF-8 and foreign ID kinds', () => {
    for (const uid of ['', '1234567', 'u_', 'u_bad\n']) assert.throws(() => pfu.encodeNativeRequest(uid, 'file', 'hash'), { code: 'INVALID_PARAMS' });
    for (const hash of [undefined, '', '\ud800', 'x'.repeat(4097)]) assert.throws(() => pfu.encodeNativeRequest('u_account', 'file', hash), { code: 'INVALID_PARAMS' });
    assert.throws(() => pfu.encodeNativeRequest('u_account', 'x'.repeat(1025), 'hash'), { code: 'INVALID_PARAMS' });
    assert.throws(() => pfu.fromFileElement({ fileUuid: 'file', fileMd5: 'md5', fileSubId: 'sub' }), { code: 'INVALID_PARAMS' });
    assert.deepEqual(pfu.fromFileElement({ fileUuid: expected.fileId, file10MMd5: expected.fileHash }), expected);
});

test('private file response preserves the signed URL and matches optional resource metadata', () => {
    const metadata = Buffer.concat([s(6, expected.fileId), s(140, expected.fileHash), s(7, '私聊文件.txt')]);
    assert.deepEqual(pfu.decodeResponse(reply({ metadata }), expected), {
        fileId: expected.fileId, url: 'http://download.qq.com:80/resource?sig=A%2fb+Z&isthumb=0', fileName: '私聊文件.txt' });
    for (const path of ['/file', '/file?', '/file?token=x%2By']) {
        assert.equal(pfu.decodeResponse(reply({ path }), expected).url,
            'http://download.qq.com:80' + path + (path.includes('?') ? '&' : '?') + 'isthumb=0');
    }
});

test('private file response requires a complete result and rejects foreign resource metadata', () => {
    assert.throws(() => pfu.decodeResponse(reply({ omitResult: true }), expected), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(reply({ result: Buffer.alloc(0) }), expected), { code: 'INVALID_RESPONSE' });
    for (const metadata of [s(6, 'another-file'), s(140, 'another-hash')]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata }), expected), { code: 'INVALID_RESPONSE' });
    }
    for (const change of [{ command: 1 }, { sub: 1 }, { reserved: 1 }, { extra: n(1, 0xe37) }]) {
        assert.throws(() => pfu.decodeResponse(reply(change), expected), { code: 'INVALID_RESPONSE' });
    }
    assert.throws(() => pfu.decodeResponse(reply({ code: 145 }), expected), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeResponse(reply({ status: 1 }), expected), { code: 'UNSUPPORTED' });
});

test('private file response accepts verified original aliases and MD5 while refusing foreign or ambiguous metadata', () => {
    const hash = '0123456789abcdef0123456789abcdef', requested = { fileId: 'original-uuid', fileHash: hash };
    const metadata = Buffer.concat([s(6, 'canonical-uuid'), s(140, 'canonical-addon'), s(144, requested.fileId),
        s(145, 'original-addon'), b(100, Buffer.from(hash, 'hex'))]);
    assert.equal(pfu.decodeResponse(reply({ metadata }), requested).fileId, requested.fileId);
    assert.equal(pfu.decodeResponse(reply({ metadata }), { ...requested, fileHash: hash.toUpperCase() }).fileId, requested.fileId);
    for (const change of [{ fileId: 'foreign-uuid' }, { fileHash: 'fedcba9876543210fedcba9876543210' }, { fileHash: 'opaque-addon' }]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata }), { ...requested, ...change }), { code: 'INVALID_RESPONSE' });
    }
    for (const extra of [s(144, requested.fileId), b(100, Buffer.from(hash, 'hex')), s(145, 'other')]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata: Buffer.concat([metadata, extra]) }), requested), { code: 'INVALID_RESPONSE' });
    }
    for (const incomplete of [s(144, requested.fileId), Buffer.concat([s(6, 'canonical-uuid'), s(144, requested.fileId)]),
        Buffer.concat([s(6, 'canonical-uuid'), s(144, requested.fileId), b(100, Buffer.alloc(16))])]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata: incomplete }), requested), { code: 'INVALID_RESPONSE' });
    }
    for (const metadata of [s(6, ''), s(140, expected.fileHash.toUpperCase())]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata }), expected), error => {
            assert.equal(error.code, 'INVALID_RESPONSE');
            assert.equal(error.message.includes(expected.fileId), false);
            assert.equal(error.message.includes(expected.fileHash), false);
            assert.equal(error.message.includes('sig='), false);
            return true;
        });
    }
});

test('private file direct UUID and original checksum validate opaque canonical hash metadata without guessing identity', () => {
    const fileHash = '0123456789abcdef0123456789abcdef', input = { fileId: 'direct-original-uuid', fileHash };
    const checksum = b(100, Buffer.from(fileHash, 'hex')), canonicalHash = s(140, 'opaque-canonical-addon');
    const direct = Buffer.concat([s(6, input.fileId), canonicalHash, checksum]);
    assert.equal(pfu.decodeResponse(reply({ metadata: direct }), input).fileId, input.fileId);
    assert.equal(pfu.decodeResponse(reply({ metadata: direct }), { ...input, fileHash: fileHash.toUpperCase() }).fileId, input.fileId);
    assert.equal(pfu.decodeResponse(reply({ metadata: Buffer.concat([direct, s(144, 'foreign-alias')]) }), input).fileId, input.fileId);
    for (const metadata of [Buffer.concat([canonicalHash, checksum]), Buffer.concat([s(6, 'foreign'), canonicalHash, checksum]),
        Buffer.concat([s(6, 'foreign'), s(144, 'foreign-alias'), canonicalHash, checksum]),
        Buffer.concat([s(6, input.fileId), canonicalHash, b(100, Buffer.alloc(16))]),
        Buffer.concat([s(6, input.fileId), canonicalHash, b(100, Buffer.alloc(15))]),
        Buffer.concat([s(6, input.fileId), canonicalHash, checksum, checksum])]) {
        assert.throws(() => pfu.decodeResponse(reply({ metadata }), input), { code: 'INVALID_RESPONSE' });
    }
    assert.throws(() => pfu.decodeResponse(reply({ metadata: direct }), { ...input, fileHash: 'opaque-input-addon' }), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeResponse(reply({ metadata: Buffer.concat([s(144, input.fileId), s(140, fileHash)]) }), input), { code: 'INVALID_RESPONSE' });
});

test('private file URLs validate routing, ports and signed path semantics', () => {
    for (const change of [{ host: 'user@download.qq.com' }, { host: '127.1' }, { host: 'download.qq.com:80' },
        { port: 0 }, { port: 65536 }, { path: '//other.test/file' }, { path: '/x/../file' },
        { path: '/file#fragment' }, { path: '/bad%token' }, { path: '/bad\\file' }]) {
        assert.throws(() => pfu.decodeResponse(reply(change), expected), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(pfu.decodeResponse(reply({ host: '1.2.3.4', port: 8080, path: '/file' }), expected).url,
        'http://1.2.3.4:8080/file?isthumb=0');
    assert.equal(pfu.decodeResponse(reply({ host: '2001:db8::1', path: '/file' }), expected).url,
        'http://[2001:db8::1]:80/file?isthumb=0');
});

test('classic offline request uses the numeric UIN and bare protobuf rather than an OIDB envelope', () => {
    const top = fields(pfu.encodeOfflineRequest('3000000002', expected.fileId)), item = fields(one(top, 14).value);
    assert.equal(one(top, 1).value, 1200n); assert.equal(one(top, 102).value, 104n);
    assert.equal(one(top, 4), undefined); assert.equal(one(top, 12), undefined);
    assert.equal(one(item, 10).value, 3000000002n); assert.equal(one(item, 20).value.toString(), expected.fileId);
    assert.equal(one(fields(one(top, 99999).value), 1).value, 90200n);
    assert.equal(pfu.OFFLINE_CMD, 'OfflineFilleHandleSvr.pb_ftn_CMD_REQ_APPLY_DOWNLOAD-1200');
    for (const uin of ['u_uid', '', '4294967296']) assert.throws(() => pfu.encodeOfflineRequest(uin, expected.fileId), { code: 'INVALID_PARAMS' });
});

test('classic offline response preserves direct and relative signed URLs and verifies file identity', () => {
    const response = (result, code = 0, fileId = expected.fileId) => m(14, [n(10, code), b(30, result), m(40, [s(6, fileId), s(7, 'test.txt')])]);
    const result = Buffer.concat([s(30, 'download.qq.com'), n(40, 8080), s(50, '/file?sig=A%2fb+Z')]);
    assert.deepEqual(pfu.decodeOfflineResponse(response(result), expected), { fileId: expected.fileId,
        url: 'http://download.qq.com:8080/file?sig=A%2fb+Z', fileName: 'test.txt' });
    const direct = 'https://download.qq.com/file?sig=A%2fb+Z';
    assert.equal(pfu.decodeOfflineResponse(response(s(50, direct)), expected).url, direct);
    assert.throws(() => pfu.decodeOfflineResponse(response(result, 1), expected), { code: 'QUERY_FAILED' });
    assert.throws(() => pfu.decodeOfflineResponse(response(result, 0, 'another-file'), expected), { code: 'INVALID_RESPONSE' });
    assert.throws(() => pfu.decodeOfflineResponse(response(s(50, 'https://download.qq.com/x/../file')), expected), { code: 'INVALID_RESPONSE' });
});

function offlineReply({ command, status = n(10, 0), result = Buffer.concat([s(30, 'download.qq.com'), n(40, 80), s(50, '/file?sig=fixture%2Bvalue')]),
    metadata = s(6, expected.fileId), payloadExtra = Buffer.alloc(0), topExtra = Buffer.alloc(0) } = {}) {
    return Buffer.concat([...(command === undefined ? [] : [n(1, command)]), m(14, [status,
        ...(result === null ? [] : [b(30, result)]), ...(metadata === null ? [] : [b(40, metadata)]), payloadExtra]), topExtra]);
}

test('classic offline request validates exact uint32 UIN values and actual file UUIDs', () => {
    for (const value of [4294967295, '4294967295', 4294967295n]) {
        const request = fields(pfu.encodeOfflineRequest(value, expected.fileId));
        assert.equal(one(fields(one(request, 14).value), 10).value, 4294967295n);
    }
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, true,
        {}, { toString: () => '123' }, '00123', '4294967296']) {
        assert.throws(() => pfu.encodeOfflineRequest(value, expected.fileId), { code: 'INVALID_PARAMS' });
    }
    for (const fileId of ['', '\ud800', 'uuid\n', 'x'.repeat(1025)]) {
        assert.throws(() => pfu.encodeOfflineRequest('123', fileId), { code: 'INVALID_PARAMS' });
    }
});

test('classic offline response rejects malformed status, unknown failures and conflicting command identities', () => {
    assert.equal(pfu.decodeOfflineResponse(offlineReply({ command: 1200 }), expected).fileId, expected.fileId);
    for (const status of [n(10, 1), n(10, 145), n(10, 0xffffffff)]) {
        assert.throws(() => pfu.decodeOfflineResponse(offlineReply({ status }), expected), { code: 'QUERY_FAILED' });
    }
    for (const change of [{ command: 0xe37 }, { command: 1201 }, { command: 1200, topExtra: n(1, 1200) },
        { status: b(10, Buffer.from('0')) }, { status: n(10, 0x100000000n) },
        { status: Buffer.concat([n(10, 0), n(10, 1)]) }, { payloadExtra: b(30, Buffer.alloc(0)) },
        { topExtra: m(14, [n(10, 0)]) }, { result: null }]) {
        assert.throws(() => pfu.decodeOfflineResponse(offlineReply(change), expected), { code: 'INVALID_RESPONSE' });
    }
    // A protobuf zero value may be omitted; it still requires complete routing.
    assert.equal(pfu.decodeOfflineResponse(offlineReply({ status: Buffer.alloc(0) }), expected).fileId, expected.fileId);
});

test('classic offline URLs cannot override conflicting routing or normalize a signed resource path', () => {
    const direct = 'https://download.qq.com:8443/file?sig=fixture%2Bvalue';
    const packet = result => offlineReply({ result });
    const valid = Buffer.concat([s(30, 'download.qq.com'), n(40, 8443), s(50, direct)]);
    assert.equal(pfu.decodeOfflineResponse(packet(valid), expected).url, direct);
    for (const result of [Buffer.concat([s(30, 'other.qq.com'), n(40, 8443), s(50, direct)]),
        Buffer.concat([s(30, 'download.qq.com'), n(40, 443), s(50, direct)]),
        Buffer.concat([s(30, 'download.qq.com'), s(40, '8443'), s(50, direct)])]) {
        assert.throws(() => pfu.decodeOfflineResponse(packet(result), expected), { code: 'INVALID_RESPONSE' });
    }
    for (const target of ['https://evil.example/file', 'https://qq.com.evil.example/file', 'https://user@download.qq.com/file',
        'https://download.qq.com:0/file', 'https://download.qq.com:65536/file', 'https://127.1/file',
        'https://download.qq.com/x/%2e%2e/file', 'https://download.qq.com/file#secret',
        'https://download.qq.com/bad%token', '//download.qq.com/file', '/x/../file', '/bad\\file']) {
        const result = /^https?:/.test(target) ? s(50, target) : Buffer.concat([s(30, 'download.qq.com'), n(40, 80), s(50, target)]);
        assert.throws(() => pfu.decodeOfflineResponse(packet(result), expected), { code: 'INVALID_RESPONSE' });
    }
});

test('classic offline routing accepts canonical IP endpoints without altering signed queries', () => {
    for (const [host, target] of [['1.2.3.4', 'http://1.2.3.4:8080/file?sig=fixture%2Bvalue'],
        ['2001:db8::1', 'http://[2001:db8::1]:8080/file?sig=fixture%2Bvalue']]) {
        const result = Buffer.concat([s(30, host), n(40, 8080), s(50, '/file?sig=fixture%2Bvalue')]);
        assert.equal(pfu.decodeOfflineResponse(offlineReply({ result }), expected).url, target);
    }
    for (const port of [0, 65536, 0x100000000n]) {
        assert.throws(() => pfu.decodeOfflineResponse(offlineReply({ result: Buffer.concat([
            s(30, 'download.qq.com'), n(40, port), s(50, '/file')]) }), expected), { code: 'INVALID_RESPONSE' });
    }
});

test('classic offline metadata is not allowed to identify another resource or ambiguous field', () => {
    for (const metadata of [s(6, 'another-resource'), Buffer.concat([s(6, expected.fileId), s(6, 'another-resource')]),
        b(6, Buffer.from([0xff])), Buffer.concat([s(6, expected.fileId), n(7, 1)])]) {
        assert.throws(() => pfu.decodeOfflineResponse(offlineReply({ metadata }), expected), { code: 'INVALID_RESPONSE' });
    }
    const result = Buffer.concat([s(30, 'download.qq.com'), n(40, 80), s(50, '/file?sig=hidden-fixture')]);
    assert.throws(() => pfu.decodeOfflineResponse(offlineReply({ result, metadata: s(6, 'another') }), expected), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.equal(error.message.includes('hidden-fixture'), false);
        return true;
    });
});
