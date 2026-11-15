'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vu = require('../src/qq/video-url.cjs');
const { varintField, bytesField, messageField, fields, one, unsigned } = require('../src/qq/proto.cjs');

function response({ command = 0x11ea, sub = 200, errorCode = 0, domain = 'multimedia.nt.qq.com.cn',
    urlPath = '/download?appid=1415', rKeyParam = '&rkey=ABC', omitInfo = false } = {}) {
    const info = messageField(3, [
        ...(domain === null ? [] : [bytesField(1, Buffer.from(domain, 'utf8'))]),
        ...(urlPath === null ? [] : [bytesField(2, Buffer.from(urlPath, 'utf8'))])
    ]);
    const download = messageField(3, [
        bytesField(1, Buffer.from(rKeyParam, 'utf8')), varintField(2, 3600),
        ...(omitInfo ? [] : [info])
    ]);
    return Buffer.concat([varintField(1, command), varintField(2, sub), varintField(3, errorCode), bytesField(4, download)]);
}

test('encodeNativeRequest builds the group NTV2RichMedia download request', () => {
    const top = fields(vu.encodeNativeRequest('video-uuid', true));
    assert.equal(Number(unsigned(one(top, 1), 0xffffffffn)), 0x11ea);
    assert.equal(Number(unsigned(one(top, 2), 0xffffffffn)), 200);
    const req = fields(one(top, 4).value);
    const scene = fields(one(fields(one(req, 1).value), 2).value);
    assert.equal(Number(unsigned(one(scene, 101), 0xffffffffn)), 2);
    assert.equal(Number(unsigned(one(scene, 102), 0xffffffffn)), 2);
    assert.equal(Number(unsigned(one(scene, 200), 0xffffffffn)), 2, 'group sceneType');
    assert.ok(one(scene, 202), 'group scene present');
    const node = fields(one(fields(one(req, 3).value), 1).value);
    assert.equal(one(node, 2).value.toString('utf8'), 'video-uuid');
    assert.equal(Number(unsigned(one(node, 3), 0xffffffffn)), 1, 'storeID');
});

test('encodeNativeRequest builds the private request with the self UID c2c scene', () => {
    const top = fields(vu.encodeNativeRequest('video-uuid', false, 'u_self'));
    assert.equal(Number(unsigned(one(top, 1), 0xffffffffn)), 0x11e9);
    const req = fields(one(top, 4).value);
    const scene = fields(one(fields(one(req, 1).value), 2).value);
    assert.equal(Number(unsigned(one(scene, 200), 0xffffffffn)), 1, 'private sceneType');
    const c2c = fields(one(scene, 201).value);
    assert.equal(one(c2c, 2).value.toString('utf8'), 'u_self');
    assert.throws(() => vu.encodeNativeRequest('uuid', false, ''), { code: 'INVALID_PARAMS' });
    assert.throws(() => vu.encodeNativeRequest('', true), { code: 'INVALID_PARAMS' });
});

test('decodeResponse assembles the official video URL from domain, path and rkey', () => {
    const result = vu.decodeResponse(response(), true);
    assert.equal(result.url, 'https://multimedia.nt.qq.com.cn/download?appid=1415&rkey=ABC');
    assert.equal(result.domain, 'multimedia.nt.qq.com.cn');
    assert.equal(result.rKeyTtlSecond, 3600);
});

test('decodeResponse rejects command mismatch, errors and untrusted sources', () => {
    assert.throws(() => vu.decodeResponse(response({ command: 0x11e9 }), true), { code: 'QUERY_FAILED' });
    assert.throws(() => vu.decodeResponse(response(), false), { code: 'QUERY_FAILED' });
    assert.throws(() => vu.decodeResponse(response({ errorCode: 253 }), true), { code: 'QUERY_FAILED' });
    assert.throws(() => vu.decodeResponse(response({ omitInfo: true }), true), { code: 'INVALID_RESPONSE' });
    assert.throws(() => vu.decodeResponse(response({ domain: 'evil.example.com' }), true), { code: 'INVALID_RESPONSE' });
    assert.throws(() => vu.decodeResponse(response({ urlPath: 'no-leading-slash' }), true), { code: 'INVALID_RESPONSE' });
});
