'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs'), fixed = require('../src/qq/flash-transfer-protocol.cjs');
const N = p.varintField, B = p.bytesField, S = (tag, value) => B(tag, Buffer.from(value)), C = rows => Buffer.concat(rows);
const ID = '11111111-2222-3333-4444-555555555555', FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const value = (map, tag) => p.one(map, tag)?.value;
const payload = prepared => p.fields(value(p.fields(prepared.body), 4));
const envelope = (prepared, body = Buffer.alloc(0), extra = []) => C([N(1, prepared.command), N(2, prepared.sub), N(3, 0), B(4, body), N(12, prepared.mode), ...extra]);
const reject = fn => assert.throws(fn, error => ['INVALID_RESPONSE', 'KERNEL_ERROR', 'QUERY_FAILED'].includes(error.code));
const head = prepared => B(1, C([B(1, C([N(1, prepared.data.seq), N(2, prepared.sub)])), S(3, 'success')]));
const upload = { filesetId: ID, fileUuid: FILE, name: 'example.mp4', size: 100, sha1: 'a'.repeat(40), fileIndex: 1, formatCode: 2 };
const grant = { time: 1700000000, ttl: 3600 };
const uploadSummary = (token = 'server+/opaque=token&literal', time = grant.time, ttl = grant.ttl) => C([S(2, token), N(4, time), N(5, ttl)]);
const uploadResponse = (prepared, summary, key = 'scoped_key') => C([head(prepared), B(2, C([...(key === null ? [] : [S(1, key)]), B(6, B(1, B(1, summary)))]))]);

test('all fixed flash commands encode their proven subcommand and envelope mode', () => {
    const cases = [['list', {}, 0x93d2, 1, 0], ['detail', { filesetId: ID }, 0x93d3, 1, 0], ['metadata', { filesetId: ID }, 0x93d4, 1, 0],
        ['delete', { filesetId: ID }, 0x9407, 1, 0], ['rename', { filesetId: ID, name: 'New' }, 0x9427, 0, 1],
        ['complete', { filesetId: ID }, 0x93db, 1, 0], ['ready', { filesetId: ID }, 0x93d1, 1, 0],
        ['prepare', upload, 0x12a9, 100, 1], ['apply', { ...upload, ...grant, md5: 'b'.repeat(32), fileId: 'scoped_main' }, 0x12a9, 103, 1],
        ['download', { filesetId: ID, fileUuid: FILE, fileId: 'scoped_main', name: 'Main' }, 0x12a9, 200, 1]];
    for (const [op, input, command, sub, mode] of cases) {
        const prepared = fixed.prepare(op, input); assert.equal(prepared.command, command); assert.equal(prepared.sub, sub); assert.equal(prepared.mode, mode);
        assert.equal(prepared.name, 'OidbSvcTrpcTcp.0x' + command.toString(16) + '_' + sub);
    }
    const rename = payload(fixed.prepare('rename', { filesetId: ID, name: 'New' })); assert.equal(value(rename, 3).length, 0);
    const metadata = payload(fixed.prepare('metadata', { filesetId: ID })), inner = p.fields(value(metadata, 2));
    assert.equal(value(inner, 3), 18n); assert.equal(value(inner, 5).length, 0); assert.equal(value(inner, 6).length, 0);
});

test('prepare preserves mandatory zero fields and matches the reference synthetic encoder oracle', () => {
    const prepared = fixed.prepare('prepare', upload), body = payload(prepared), data = p.fields(value(body, 2));
    const actual = value(p.fields(value(data, 1)), 1), info = p.fields(actual);
    assert.equal(value(info, 2).length, 0); assert.equal(value(info, 6), 0n); assert.equal(value(info, 9), 1n);
    assert.equal(value(p.fields(value(info, 5)), 4), 0n);
    const wrap = p.fields(value(data, 9)); assert.equal(value(wrap, 4), 1n); assert.equal(value(wrap, 6), 0n); assert.equal(value(wrap, 7), 2n); assert.equal(value(wrap, 14), 0n);
    assert.equal(value(p.fields(value(data, 1)), 2), 0n, 'sub100 wrapper f2 is varint, not fileId');
    const apply = payload(fixed.prepare('apply', { ...upload, ...grant, md5: 'b'.repeat(32), fileId: 'scoped_main' }));
    assert.equal(apply.has(2), false); assert.equal(apply.has(12), true); assert.equal(p.fields(value(p.fields(value(apply, 12)), 1)).get(2)[0].wire, 2);
    const jpg = payload(fixed.prepare('prepare', { ...upload, thumbType: 'jpg' }));
    const jpgPayload = p.fields(value(jpg, 2)); assert.equal(value(p.fields(value(jpgPayload, 9)), 6), 1n);
    const jpgInfo = p.fields(value(p.fields(value(jpgPayload, 1)), 1)); assert.equal(value(jpgInfo, 6), 526n); assert.equal(value(jpgInfo, 7), 360n);
});

test('commit carries all entries once with unique ordered indexes and explicit zero/default tags', () => {
    const input = { filesetId: ID, entries: [{ fileUuid: FILE, name: 'A.txt', size: 3, formatCode: 10, fileIndex: 1 },
        { fileUuid: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', name: 'B.txt', size: 4, formatCode: 10, fileIndex: 2 }] };
    const body = payload(fixed.prepare('commit', input)); assert.equal(body.get(4).length, 2);
    for (const [index, row] of body.get(4).entries()) {
        const item = p.fields(row.value); assert.equal(value(item, 6), BigInt(index + 1)); assert.equal(value(item, 3), 0n); assert.equal(value(item, 5), 1n);
        assert.equal(value(item, 10), 0n); assert.equal(value(item, 12), 0n); assert.equal(value(item, 24).length, 0);
    }
    assert.throws(() => fixed.prepare('commit', { ...input, entries: input.entries.slice().reverse() }), { code: 'INVALID_PARAMS' });
    const create = fixed.prepare('create', { name: 'Files', size: 7, typeCode: 7, selfUin: '12345', selfUid: 'u_self', nickname: 'Self' });
    assert.equal(create.command, 0x93cf); assert.equal(value(p.fields(value(payload(create), 2)), 5), 7n);
});

test('unknown commands, invalid identities, unsafe share origins and parameter injection are rejected', () => {
    for (const input of [{ filesetId: ID, arbitrary: true }, { filesetId: 'not-a-uuid' }, { filesetId: FILE.toUpperCase() }]) assert.throws(() => fixed.prepare('detail', input), { code: 'INVALID_PARAMS' });
    assert.throws(() => fixed.prepare('arbitrary', {}), { code: 'UNSUPPORTED' });
    for (const code of ['https://evil.invalid/q/a', 'http://qfile.qq.com/q/a', 'https://qfile.qq.com:444/q/a', 'https://u:p@qfile.qq.com/q/a', 'https://qfile.qq.com/q/a?b=c', 'https://qfile.qq.com/q/a#x', 'https://qfile.qq.com/q/a%2Fb', 'https://qfile.qq.com/q/%2e%2e', '..', 'a b', 'a\\b', 'a/b', 'a\0b']) assert.throws(() => fixed.shareUrl(code), { code: 'INVALID_PARAMS' });
    assert.equal(fixed.shareUrl('SomeCode'), 'https://qfile.qq.com/q/SomeCode');
    assert.equal(fixed.shareUrl('https://qfile.qq.com/q/SomeCode/'), 'https://qfile.qq.com/q/SomeCode');
    assert.throws(() => fixed.prepare('send', { filesetId: ID, targetUid: 'u_person', groupId: 12345 }), { code: 'INVALID_PARAMS' });
    assert.throws(() => fixed.prepare('download', { filesetId: ID, fileUuid: FILE, fileId: 'file\nescape', name: 'A' }), { code: 'INVALID_PARAMS' });
});

test('flash list/detail preserves exact sizes and never returns a thumbnail as the main download URL', () => {
    const detail = fixed.prepare('detail', { filesetId: ID });
    const row = C([S(1, ID), S(2, 'A'), S(3, 'Original'), N(5, 18446744073709551614n), B(8, S(1, 'https://qfile.qq.com/q/Code')),
        B(9, C([S(1, 'thumbnail_id'), B(2, S(2, 'https://multimedia.qfile.qq.com/download?appid=14903'))]))]);
    const result = fixed.decode(envelope(detail, B(1, row)), detail);
    assert.deepEqual(result.items, [{ filesetId: ID, name: 'A', origName: 'Original', size: '18446744073709551614', shareUrl: 'https://qfile.qq.com/q/Code' }]);
    assert.equal(result.complete, false); assert.equal(result.items[0].downloadUrl, undefined);
    reject(() => fixed.decode(envelope(detail, C([B(1, row), B(1, row)])), detail));
    reject(() => fixed.decode(envelope(detail, B(1, S(1, FILE))), detail));
    reject(() => fixed.decode(envelope(detail, B(1, C([S(1, ID), B(8, S(1, 'https://evil.invalid/q/x'))]))), detail));
});

test('main metadata reads f14, validates index/UUID scope and never falls back to array order or thumbnail', () => {
    const prepared = fixed.prepare('metadata', { filesetId: ID });
    const row = C([S(1, ID), S(2, FILE), N(6, 2), S(8, 'B.txt'), N(11, 100), B(13, S(1, 'thumbnail')), B(14, S(1, 'real_main'))]);
    assert.deepEqual(fixed.decode(envelope(prepared, B(1, B(3, row))), prepared).items,
        [{ filesetId: ID, fileUuid: FILE, fileIndex: 2, name: 'B.txt', size: '100', fileId: 'real_main' }]);
    const noIndex = C([S(1, ID), S(2, FILE), S(8, 'B.txt'), N(11, 100)]);
    reject(() => fixed.decode(envelope(prepared, B(1, B(3, noIndex))), prepared));
    reject(() => fixed.decode(envelope(prepared, B(1, C([B(3, row), B(3, row)]))), prepared));
});

test('main download validates exact media seq/sub, official host, appid, fileid and a single scoped key', () => {
    const prepared = fixed.prepare('download', { filesetId: ID, fileUuid: FILE, fileId: 'real_main', name: 'A.txt' });
    const path = '/download?appid=14901&fileid=real_main&fldc=scope';
    const raw = C([B(1, C([S(1, 'rkey=scoped_test_key'), B(2, C([S(1, 'multimedia.qfile.qq.com'), S(2, path)]))]))]);
    const good = C([head(prepared), B(3, raw)]);
    assert.equal(fixed.decode(envelope(prepared, good), prepared).url, 'https://multimedia.qfile.qq.com' + path + '&rkey=scoped_test_key');
    for (const wrong of [path.replace('14901', '14902'), path.replace('real_main', 'other_main'), path + '&rkey=duplicate']) {
        const body = C([head(prepared), B(3, C([S(1, 'rkey=scoped_test_key'), S(2, 'multimedia.qfile.qq.com'), S(3, wrong)]))]);
        reject(() => fixed.decode(envelope(prepared, body), prepared));
    }
    reject(() => fixed.decode(envelope(prepared, C([head({ ...prepared, data: { ...prepared.data, seq: prepared.data.seq + 1 } }), B(3, raw)])), prepared));
    reject(() => fixed.decode(envelope(prepared, C([head(prepared), B(3, C([S(1, 'rkey=scoped_test_key'), S(2, 'evil.invalid'), S(3, path)]))])), prepared));
});

test('acknowledgements require exact OIDB operation and send verifies the actual recipient echo', () => {
    const prepared = fixed.prepare('send', { filesetId: ID, targetUid: 'u_person' });
    const body = B(1, B(3, C([N(1, 1), B(2, S(1, 'u_person'))])));
    assert.equal(fixed.decode(envelope(prepared, body), prepared).confirmation, 'target_ack');
    reject(() => fixed.decode(envelope(prepared, B(1, B(3, C([N(1, 1), B(2, S(1, 'u_other'))])))), prepared));
    reject(() => fixed.decode(envelope(prepared, Buffer.alloc(0)), prepared));
    const deletion = fixed.prepare('delete', { filesetId: ID });
    assert.equal(fixed.decode(envelope(deletion), deletion).confirmed, true);
    assert.equal(fixed.decode(C([N(1, deletion.command), N(2, deletion.sub)]), deletion).confirmed, true, 'protobuf-omitted success status/body still requires exact command correlation');
    reject(() => fixed.decode(envelope(deletion, N(1, 4)), deletion));
    assert.throws(() => fixed.decode(envelope(deletion, C([S(1, 'private-identity-do-not-echo'), N(2, 17), N(2, 18)])), deletion), error =>
        error.code === 'INVALID_RESPONSE' && error.message.includes('op=delete;schema=1:2x1,2:0x2') && !error.message.includes('private-identity') && !error.message.includes('17'));
    reject(() => fixed.decode(envelope(deletion, Buffer.alloc(0), [N(3, 5)]), deletion));
    reject(() => fixed.decode(envelope({ ...deletion, command: 0x93d3 }), deletion));
});

test('complete and ready accept bounded opaque stage ACKs only inside the exact successful envelope', () => {
    for (const op of ['complete', 'ready']) {
        const prepared = fixed.prepare(op, { filesetId: ID });
        for (const body of [Buffer.alloc(0), Buffer.from([0xff]), S(7, 'opaque-stage-body')]) {
            assert.deepEqual(fixed.decode(envelope(prepared, body), prepared), { confirmed: true, confirmation: 'server_ack', filesetId: ID });
        }
        assert.equal(fixed.decode(C([N(1, prepared.command), N(2, prepared.sub)]), prepared).confirmation, 'server_ack');
        reject(() => fixed.decode(envelope({ ...prepared, command: prepared.command + 1 }, Buffer.from([0xff])), prepared));
        reject(() => fixed.decode(envelope({ ...prepared, sub: 2 }, Buffer.from([0xff])), prepared));
        reject(() => fixed.decode(envelope(prepared, Buffer.from([0xff]), [N(12, 1)]), prepared));
        assert.throws(() => fixed.decode(C([N(1, prepared.command), N(2, prepared.sub), N(3, 5), B(4, Buffer.from([0xff]))]), prepared), { code: 'KERNEL_ERROR' });
        reject(() => fixed.decode(envelope(prepared, Buffer.alloc(fixed.MAX_FRAME)), prepared));
        reject(() => fixed.decode(C([N(1, prepared.command), N(2, prepared.sub), B(4, Buffer.alloc(0)), B(4, Buffer.from([0xff]))]), prepared));
    }
    for (const prepared of [fixed.prepare('rename', { filesetId: ID, name: 'Other' }), fixed.prepare('delete', { filesetId: ID })]) {
        reject(() => fixed.decode(envelope(prepared, N(1, 1)), prepared));
    }
});

test('prepare reads the exact server-issued token/time/ttl independently of an optional upload key', () => {
    const prepared = fixed.prepare('prepare', upload), token = 'server+/opaque=token&literal';
    for (const key of ['scoped_key', null]) {
        assert.deepEqual(fixed.decode(envelope(prepared, uploadResponse(prepared, uploadSummary(token), key)), prepared),
            { uploadKey: key, token, ...grant, filesetId: ID, fileUuid: FILE });
    }
    const zero = fixed.decode(envelope(prepared, uploadResponse(prepared, uploadSummary(token, 0, 0), null)), prepared);
    assert.equal(zero.time, 0); assert.equal(zero.ttl, 0, 'explicit server zeroes are retained rather than replaced with local defaults');
    reject(() => fixed.decode(envelope(prepared, head(prepared)), prepared));
    reject(() => fixed.decode(envelope(prepared, uploadResponse(prepared, uploadSummary(), 'bad key')), prepared));
    reject(() => fixed.decode(envelope(prepared, B(2, S(1, 'key_without_head'))), prepared));
    const commit = fixed.prepare('commit', { filesetId: ID, entries: [{ fileUuid: FILE, name: 'A', size: 1, formatCode: 11, fileIndex: 1 }] });
    reject(() => fixed.decode(envelope(commit, S(2, FILE)), commit));
});

test('unknown acknowledgement diagnostics expose only bounded nested schemas and UUID equality', () => {
    const deletion = fixed.prepare('delete', { filesetId: ID });
    const body = C([B(1, C([S(1, ID), N(2, 987654321), S(3, 'private-marker-secret')])), B(1, S(1, FILE))]);
    assert.throws(() => fixed.decode(envelope(deletion, body), deletion), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.match(error.message, /schema=1:2x2/);
        assert.match(error.message, /1\[0\]\{schema=1:2x1,2:0x1,3:2x1/);
        assert.match(error.message, /uuid_match=true/); assert.match(error.message, /uuid_match=false/);
        for (const secret of [ID, FILE, '987654321', 'private-marker-secret']) assert.equal(error.message.includes(secret), false);
        return true;
    });
    const many = C(Array.from({ length: 1000 }, () => B(1, B(1, S(1, ID)))));
    assert.throws(() => fixed.decode(envelope(deletion, many), deletion), error => {
        assert.equal(error.code, 'INVALID_RESPONSE'); assert.ok(error.message.length < 2300);
        assert.equal(error.message.includes(ID), false); assert.match(error.message, /more|bounded/); return true;
    });
});

test('observed delete result diagnostics reveal only scoped small codes and fixed message enums', () => {
    const deletion = fixed.prepare('delete', { filesetId: ID });
    const body = C([B(1, C([N(2, 1002), S(3, 'private-filename-and-error-detail')])),
        B(1, C([N(1, 7), N(2, 0), S(3, 'error')]))]);
    assert.throws(() => fixed.decode(envelope(deletion, body), deletion), error => {
        assert.equal(error.code, 'INVALID_RESPONSE');
        assert.match(error.message, /results=0\{f1=omitted;f2=1002;f3=opaque\(bytes=33,utf8=true,sha256=[a-f0-9]{64}\)\},1\{f1=7;f2=0;f3=error\}/);
        assert.equal(error.message.includes('private-filename'), false); return true;
    });
    const large = B(1, C([N(1, 1234567890123n), N(2, 65536), S(3, 'success')]));
    assert.throws(() => fixed.decode(envelope(deletion, large), deletion), error => {
        assert.match(error.message, /f1=large;f2=large;f3=success/);
        assert.equal(error.message.includes('1234567890123'), false); assert.equal(error.message.includes('65536'), false);
        return error.code === 'INVALID_RESPONSE';
    });
    for (const other of [fixed.prepare('rename', { filesetId: ID, name: 'Other' })]) {
        assert.throws(() => fixed.decode(envelope(other, body), other), error => {
            assert.equal(error.message.includes('results='), false); assert.equal(error.message.includes('1002'), false);
            return error.code === 'INVALID_RESPONSE';
        });
    }
    const unknownShape = C([body, N(9, 1002)]);
    assert.throws(() => fixed.decode(envelope(deletion, unknownShape), deletion), error => !error.message.includes('results=') && error.code === 'INVALID_RESPONSE');
});

test('bounded single slices use final whole-file SHA1 and validate the actual business acknowledgement', () => {
    const bytes = Buffer.from('immutable content'), key = 'offline_test_key', body = p.fields(fixed.sliceBody(bytes, key));
    assert.equal(value(body, 1), 0n); assert.equal(value(body, 2), 14901n);
    const item = p.fields(value(body, 107)), sha1 = require('node:crypto').createHash('sha1').update(bytes).digest();
    assert.equal(value(item, 3), 0n); assert.equal(value(item, 4), BigInt(bytes.length - 1)); assert.deepEqual(value(item, 5), sha1);
    assert.deepEqual(value(p.fields(value(item, 6)), 1), sha1); assert.deepEqual(value(item, 7), bytes);
    assert.equal(fixed.decodeSlice(S(5, 'success')), true);
    for (const response of [Buffer.alloc(0), S(5, 'error'), S(1, 'success'), C([S(5, 'success'), S(5, 'success')])]) reject(() => fixed.decodeSlice(response));
    assert.throws(() => fixed.sliceBody(Buffer.alloc(1024 * 1024 + 1), key), { code: 'INVALID_PARAMS' });
    for (const appid of [14901, 14902, 14903]) assert.equal(value(p.fields(fixed.sliceBody(bytes, key, appid)), 2), BigInt(appid));
});

test('missing, ambiguous, wrong-type or oversized server grants never fall back to an ACK or another token path', () => {
    const prepared = fixed.prepare('prepare', upload), token = 'private_opaque_token';
    const malformed = [Buffer.alloc(0), C([N(4, 1), N(5, 2)]), C([S(2, token), N(5, 2)]), C([S(2, token), N(4, 1)]),
        C([S(2, token), S(2, token), N(4, 1), N(5, 2)]), C([N(2, 7), N(4, 1), N(5, 2)]),
        C([S(2, token), S(4, '1'), N(5, 2)]), C([S(2, token), N(4, 1), N(4, 1), N(5, 2)]),
        C([S(2, token), N(4, 0x100000000n), N(5, 2)]), C([S(2, token), N(4, 1), N(5, 0x100000000n)]),
        uploadSummary(''), uploadSummary('x'.repeat(4097)), uploadSummary(token+'\n'), uploadSummary(token+'\u0085'), uploadSummary(token+'\u2028')];
    for (const summary of malformed) assert.throws(()=>fixed.decode(envelope(prepared,uploadResponse(prepared,summary)),prepared),error=>{
        assert.equal(error.code,'INVALID_RESPONSE');assert.equal(error.message.includes(token),false);return true;
    });
    for (const body of [C([head(prepared),B(2,S(1,'scoped_key'))]),
        C([head(prepared),B(12,B(1,uploadSummary(token)))]),
        C([head(prepared),B(2,B(6,C([B(1,B(1,uploadSummary(token))),B(1,B(1,uploadSummary(token)))])))])]) reject(()=>fixed.decode(envelope(prepared,body),prepared));
});

test('apply reuses opaque server credentials and time/ttl without generating or normalizing them', () => {
    const token='opaque+/= &?#%token-不是base64', prepared=fixed.prepare('prepare',upload);
    const accepted=fixed.decode(envelope(prepared,uploadResponse(prepared,uploadSummary(token))),prepared);
    const apply=payload(fixed.prepare('apply',{...upload,md5:'b'.repeat(32),fileId:accepted.token,time:accepted.time,ttl:accepted.ttl}));
    const summary=p.fields(value(p.fields(value(apply,12)),1));assert.equal(value(summary,2).toString('utf8'),token);
    assert.equal(value(summary,4),BigInt(grant.time));assert.equal(value(summary,5),BigInt(grant.ttl));
    for(const field of ['time','ttl']){const input={...upload,...grant,md5:'b'.repeat(32),fileId:token};delete input[field];assert.throws(()=>fixed.prepare('apply',input),{code:'INVALID_PARAMS'});}
});

test('official URLs compare decoded opaque file tokens exactly and reject query ambiguity without rewriting them', () => {
    const token='opaque+/= &?#%token-不是base64', path='/download?appid=14901&fileid='+encodeURIComponent(token)+'&fldc=scope';
    const url='https://multimedia.qfile.qq.com'+path+'&rkey=offline_key';assert.equal(fixed.officialDownload(url,token),url);
    const download=fixed.prepare('download',{filesetId:ID,fileUuid:FILE,fileId:token,name:'A'});
    const raw=C([S(1,'&rkey=offline_key'),N(2,3600),B(3,C([S(1,'multimedia.qfile.qq.com'),S(2,path),N(3,443)]))]);
    assert.equal(fixed.decode(envelope(download,C([head(download),B(3,raw)])),download).url,url);
    for(const wrong of [url+'&fileid='+encodeURIComponent(token),url+'&%66ileid='+encodeURIComponent(token),url.replace(encodeURIComponent(token),'opaque+token'),
        url.replace('14901','14902'),url+'&rkey=other',url.replace('multimedia.qfile.qq.com','evil.invalid')])reject(()=>fixed.officialDownload(wrong,token));
    reject(()=>fixed.officialDownload('https://multimedia.qfile.qq.com/download?appid=14901&fileid=server+token&rkey=key','server+token'));
});

test('frame, scalar flood, invalid UTF8 and duplicate singular fields fail closed', () => {
    const prepared = fixed.prepare('detail', { filesetId: ID });
    reject(() => fixed.decode(Buffer.alloc(1024 * 1024 + 1), prepared));
    reject(() => fixed.decode(envelope(prepared, C(Array(20001).fill(N(9, 0)))), prepared));
    reject(() => fixed.decode(envelope(prepared, B(1, C([S(1, ID), B(2, Buffer.from([255]))]))), prepared));
    reject(() => fixed.decode(envelope(prepared, B(1, C([S(1, ID), N(5, 1), N(5, 2)]))), prepared));
});
