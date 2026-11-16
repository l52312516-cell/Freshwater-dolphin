'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs'), fixed = require('../src/qq/contact-extra-protocol.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value)), join = values => Buffer.concat(values);
const value = (map, field) => p.one(map, field)?.value;
const envelope = (prepared, body = Buffer.alloc(0), extra = []) => join([n(1, prepared.command), n(2, prepared.sub), n(3, 0), b(4, body), n(12, prepared.mode), ...extra]);
const decode = (operation, request, body, extra) => { const prepared = fixed.prepare(operation, request); return fixed.decode(envelope(prepared, body, extra), prepared); };
const reject = fn => assert.throws(fn, error => ['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));

test('fixed operation serialization locks service names, command modes and payloads', () => {
    const translate = fixed.prepare('translate', { words: [' hello ', 'A\nB'] }), env = p.fields(translate.body), body = p.fields(value(env, 4)), translation = p.fields(value(body, 2));
    assert.equal(translate.name, 'OidbSvcTrpcTcp.0x990_2'); assert.equal(translate.mode, 0);
    assert.deepEqual(translation.get(3).map(entry => entry.value.toString()), [' hello ', 'A\nB']);
    assert.equal(value(body, 10), 1n); assert.equal(value(body, 12), 1n);
    const list = fixed.prepare('doubt.list', { count: 50 }), listBody = p.fields(value(p.fields(list.body), 4));
    assert.equal(list.name, 'OidbSvcTrpcTcp.0xd69_0'); assert.equal(list.mode, 1); assert.equal(value(listBody, 1), 1n);
    assert.equal(value(p.fields(value(listBody, 2)), 1), 50n);
    const approve = fixed.prepare('doubt.approve', { selfUid: 'u_self', targetUid: 'u_person' }), approveBody = p.fields(value(p.fields(approve.body), 4));
    assert.equal(approve.name, 'OidbSvcTrpcTcp.0xd72_0'); assert.equal(approve.mode, 0); assert.equal(value(approveBody, 3), 0n); assert.equal(value(approveBody, 4).length, 0);
    const decline = fixed.prepare('doubt.reject', { targetUid: 'u_person' });
    assert.equal(decline.name, list.name); assert.equal(decline.mode, 1); assert.equal(value(p.fields(value(p.fields(decline.body), 4)), 1), 3n);
    const filtered = fixed.prepare('group.filtered', { count: 100, cursor: '18446744073709551614' });
    assert.equal(filtered.name, 'OidbSvcTrpcTcp.0x10c0_2'); assert.equal(filtered.mode, 1);
    assert.equal(value(p.fields(value(p.fields(filtered.body), 4)), 2), 18446744073709551614n);
    const input = fixed.prepare('input.status', { targetUid: 'u_person', eventType: 0 });
    assert.equal(input.name, 'OidbSvcTrpcTcp.0xcd4_1');
    assert.equal(value(p.fields(value(p.fields(value(p.fields(input.body), 4)), 1)), 3), undefined);
    const oneWay = fixed.prepare('unidirectional', { selfUin: '11111' });
    assert.equal(oneWay.name, 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0');
    assert.deepEqual(JSON.parse(value(p.fields(oneWay.body), 3).toString()), { uint64_uin: '11111', uint64_top: 0, uint32_req_num: 99, bytes_cookies: '' });
    assert.equal(value(p.fields(oneWay.body), 2), 0n);
});

test('invalid words, identifiers, command injection and unknown fields fail before dispatch', () => {
    for (const words of [[], [''], [null], ['\ud800'], ['x'.repeat(4097)], Array(51).fill('a'), Array(5).fill('x'.repeat(4096))]) assert.throws(() => fixed.prepare('translate', { words }), { code: 'INVALID_PARAMS' });
    for (const request of [{ count: 0 }, { count: 101 }, { count: '01' }, { count: 50, cookie: 'arbitrary' }]) assert.throws(() => fixed.prepare('doubt.list', request), { code: 'INVALID_PARAMS' });
    assert.throws(() => fixed.prepare('raw', {}), { code: 'UNSUPPORTED' });
    assert.throws(() => fixed.prepare('doubt.approve', { targetUid: '12345', selfUid: 'u_self' }), { code: 'INVALID_PARAMS' });
    assert.throws(() => fixed.prepare('group.filtered', { count: 100, cursor: '18446744073709551616' }), { code: 'INVALID_PARAMS' });
});

test('translation verifies source words, language, exact result count and business status', () => {
    const request = { words: ['hello', 'world'] }, good = join([s(3, 'en'), s(4, 'zh'), s(5, 'hello'), s(5, 'world'), s(6, '你好'), s(6, '世界')]);
    assert.deepEqual(decode('translate', request, b(2, good)), { sourceWords: ['hello', 'world'], words: ['你好', '世界'] });
    for (const body of [Buffer.alloc(0), b(2, s(6, 'only one')), b(2, join([s(5, 'wrong'), s(6, 'one'), s(6, 'two')])),
        b(2, join([s(3, 'xx'), s(6, 'one'), s(6, 'two')])), b(2, join([n(1, 5), s(2, 'private-service-detail')]))]) reject(() => decode('translate', request, body));
});

test('doubt list reads numeric tag1 independently from request time and preserves UID variants', () => {
    const item = join([n(1, 54321), s(2, 'Nick'), s(5, 'Hi'), n(8, 18446744073709551614n), n(9, 33333)]);
    const result = decode('doubt.list', { count: 50 }, join([n(1, 1), b(2, b(1, item))]));
    assert.deepEqual(result.items, [{ uin: '54321', nick: 'Nick', msg: 'Hi', reqTime: '18446744073709551614', groupCode: '33333' }]);
    assert.equal(decode('doubt.list', { count: 1 }, join([n(1, 1), b(2, b(1, join([s(1, 'u_person'), n(8, 100)])))])).items[0].uid, 'u_person');
    assert.deepEqual(decode('doubt.list', { count: 50 }, n(1, 1)).items, []);
    for (const body of [Buffer.alloc(0), n(1, 3), join([n(1, 1), b(2, b(1, n(8, 54321)))]), join([n(1, 1), b(2, join([b(1, item), b(1, item)]))])]) reject(() => decode('doubt.list', { count: 50 }, body));
});

test('filtered group decoding uses real participants and exact uint64 cursor', () => {
    const item = join([n(1, 18446744073709551614n), n(2, 1), n(3, 1), b(4, join([n(1, 33333), s(2, 'Group')])),
        b(5, join([n(1, 54321), s(2, 'Target')])), b(6, join([s(1, 'u_invitor'), s(2, 'Invitor')])), s(10, 'Hi\nthere')]);
    const result = decode('group.filtered', { count: 100, cursor: '0' }, join([b(1, item), n(2, 18446744073709551613n)]));
    assert.equal(result.filtered, true); assert.equal(result.cursor, '18446744073709551613');
    assert.deepEqual(result.items[0], { sequence: '18446744073709551614', eventType: 1, state: 1, groupId: '33333', groupName: 'Group', comment: 'Hi\nthere', target: { uin: '54321', name: 'Target' }, invitor: { uid: 'u_invitor', name: 'Invitor' } });
    reject(() => decode('group.filtered', { count: 100, cursor: '0' }, n(2, 5)));
    reject(() => decode('group.filtered', { count: 100, cursor: '5' }, join([b(1, item), n(2, 5)])));
    reject(() => decode('group.filtered', { count: 100, cursor: '0' }, join([b(1, item), b(1, item)])));
});

test('one-way friend JSON status and base64 text are checked without inventing missing profile fields', () => {
    const prepared = fixed.prepare('unidirectional', { selfUin: '11111' });
    const response = value => join([n(3, 0), s(4, JSON.stringify(value))]);
    const good = { ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: [{ uint64_uin: '54321', str_uid: 'u_person', bytes_nick: Buffer.from('昵称').toString('base64') }] };
    assert.equal(fixed.decode(join([n(1, 0), n(2, 0), response(good)]), prepared).items.length, 1, 'custom schema tags 1/2 are not OIDB command discriminators');
    assert.deepEqual(fixed.decode(response(good), prepared), { items: [{ uin: '54321', uid: 'u_person', nick_name: '昵称' }], limit: 99, complete: false });
    for (const value of [{ ActionStatus: 'FAIL', ErrorCode: 5, ErrorInfo: 'private' }, {}, { ActionStatus: 'OK', ErrorCode: 0 },
        { ...good, rpt_block_list: [{ uint64_uin: Number.MAX_SAFE_INTEGER + 1 }] }, { ...good, rpt_block_list: [{ uint64_uin: '54321', bytes_nick: '%%%=' }] },
        { ...good, rpt_block_list: [good.rpt_block_list[0], good.rpt_block_list[0]] }]) reject(() => fixed.decode(response(value), prepared));
    assert.equal(fixed.decode(join([n(1, 999), response(good)]), prepared).items.length, 1);
    reject(() => fixed.decode(join([n(3, 5), response(good)]), prepared));
});

test('fixed envelopes reject wrong scope, unsafe ACK bodies and scalar floods', () => {
    const prepared = fixed.prepare('doubt.approve', { selfUid: 'u_self', targetUid: 'u_person' });
    assert.equal(fixed.decode(envelope(prepared), prepared).confirmed, true);
    reject(() => fixed.decode(envelope(prepared, n(1, 1)), prepared));
    reject(() => fixed.decode(envelope(prepared, Buffer.alloc(0), [n(1, prepared.command)]), prepared));
    reject(() => fixed.decode(join([n(1, prepared.command + 1), n(3, 0)]), prepared));
    reject(() => fixed.decode(envelope(prepared, Buffer.alloc(0), [n(3, 5)]), prepared));
    reject(() => fixed.decode(join(Array.from({ length: 20001 }, () => n(1000, 0))), prepared));
    reject(() => fixed.decode(Buffer.alloc(1024 * 1024 + 1), prepared));
});
