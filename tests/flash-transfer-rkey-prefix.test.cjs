'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fixed = require('../src/qq/flash-transfer-protocol.cjs'), p = require('../src/qq/proto.cjs');
const N = p.varintField, B = p.bytesField, S = (tag, value) => B(tag, Buffer.from(value)), C = Buffer.concat;
const prepared = () => fixed.prepare('download', { filesetId: '11111111-2222-3333-4444-555555555555',
    fileUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', fileId: 'real_main', name: 'A.txt' });
const PATH = '/download?appid=14901&fileid=real_main&fldc=scope', KEY = 'synthetic_scoped_key-1';
function response(request, keys, pathname = PATH) {
    const head = B(1, C([B(1, C([N(1, request.data.seq), N(2, request.sub)])), S(3, 'success')]));
    const raw = B(1, C([...keys.map(value => S(1, value)), B(2, C([S(1, 'multimedia.qfile.qq.com'), S(2, pathname)]))]));
    return C([N(1, request.command), N(2, request.sub), N(3, 0), B(4, C([head, B(3, raw)])), N(12, request.mode)]);
}
const reject = fn => assert.throws(fn, { code: 'INVALID_RESPONSE' });
test('download accepts both complete independent rkey prefixes and yields the same strictly scoped URL', () => {
    const request = prepared(), expected = 'https://multimedia.qfile.qq.com' + PATH + '&rkey=' + KEY;
    assert.equal(fixed.decode(response(request, ['rkey=' + KEY]), request).url, expected);
    assert.equal(fixed.decode(response(request, ['&rkey=' + KEY]), request).url, expected);
    assert.equal(fixed.officialDownload(expected, 'real_main'), expected);
});
test('missing and malformed complete independent key fields remain rejected', () => {
    const request = prepared();
    for (const keys of [[], ['rkey='], ['&rkey='], ['&&rkey=' + KEY], ['rkey=' + KEY + '='], ['&rkey=' + KEY + '+'],
        ['&rkey=' + KEY + '/'], ['&rkey=%61'], ['prefix&rkey=' + KEY], ['&rkey=' + KEY + '&other=x']])
        reject(() => fixed.decode(response(request, keys), request));
});
test('duplicate independent keys reject both identical and mixed prefix forms', () => {
    const request = prepared();
    for (const keys of [['rkey=' + KEY, 'rkey=' + KEY], ['&rkey=' + KEY, '&rkey=' + KEY], ['rkey=' + KEY, '&rkey=' + KEY]])
        reject(() => fixed.decode(response(request, keys), request));
});
test('a key already present in the path cannot coexist with either independent prefix', () => {
    const request = prepared();
    for (const prefix of ['rkey=', '&rkey=']) reject(() => fixed.decode(response(request, [prefix + KEY], PATH + '&rkey=' + KEY), request));
    reject(() => fixed.decode(response(request, [], PATH + '&rkey=' + KEY + '&rkey=' + KEY), request));
});
