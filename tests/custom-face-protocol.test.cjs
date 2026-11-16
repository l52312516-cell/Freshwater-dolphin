'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/custom-face-protocol.cjs');
const crypto = require('node:crypto');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const m = (field, parts) => b(field, Buffer.concat(parts));
const A = '12345_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0', B = '12345_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
function envelope(prepared, body, error = 0) { return Buffer.concat([n(1, prepared.command), n(2, 1), n(3, error), b(4, body), n(12, prepared.mode)]); }
function list(ids, total = ids.length) { return Buffer.concat([n(1, 0), m(4, [...ids.map(id => s(1, id)), n(4, total)])]); }
function entry(id, text = '', legacy = false) { return m(4, [m(1, [s(1, id)]), s(legacy ? 2 : 3, text)]); }
function frame(head, body = Buffer.alloc(0)) { const header = Buffer.alloc(9); header[0] = 0x28; header.writeUInt32BE(head.length, 1); header.writeUInt32BE(body.length, 5); return Buffer.concat([header, head, body, Buffer.from([0x29])]); }

test('custom face list/delete and OIDB operations have fixed service names, account identity and modes', () => {
    const fetched = protocol.prepare('face.list', { uin: '12345' });
    assert.equal(fetched.name, 'Faceroam.OpReq');
    const body = p.fields(fetched.body), environment = p.fields(p.one(body, 1).value);
    assert.equal(p.one(body, 2).value, 12345n); assert.equal(p.one(body, 3).value, 1n); assert.equal(p.one(body, 6).value, 1n);
    assert.equal(p.one(environment, 3).value.toString(), '9.9.28-46928');
    const deleted = p.fields(protocol.prepare('face.delete', { uin: '12345', emojiId: A }).body);
    assert.equal(p.one(deleted, 3).value, 2n); assert.equal(p.fields(p.one(deleted, 1).value).has(3), false);
    assert.equal(p.one(p.fields(p.one(deleted, 5).value), 1).value.toString(), A);
    const detail = protocol.prepare('face.detail', { uin: '12345', ids: [A, B] });
    assert.equal(detail.name, 'OidbSvcTrpcTcp.0x902e_1'); assert.equal(detail.mode, 1);
    assert.equal(p.one(p.fields(p.one(p.fields(detail.body), 4).value), 3).value, 2n);
    const modified = protocol.prepare('face.modify', { uin: '12345', emojiId: A, desc: '新备注' });
    assert.equal(modified.mode, 0); assert.equal(p.one(p.fields(p.one(p.fields(modified.body), 4).value), 3).value, 3n);
    const order = protocol.prepare('face.order', { uin: '12345', emojiId: A }); assert.equal(order.command, 0x902f); assert.equal(order.mode, 1);
    for (const [operation, data] of [['face.list', { uin: '001' }], ['face.delete', { uin: '999', emojiId: A }], ['face.detail', { uin: '12345', ids: [A, A] }],
        ['face.modify', { uin: '12345', emojiId: A, desc: 'x'.repeat(1025) }], ['face.order', { uin: '12345', emojiId: A, position: 2 }], ['arbitrary', {}]]) assert.throws(() => protocol.prepare(operation, data));
});

test('custom face lists require an account-bound container and treat tag4 as quota, not returned count', () => {
    const prepared = protocol.prepare('face.list', { uin: '12345' });
    assert.deepEqual(protocol.decode(list([A, B]), prepared), { uin: '12345', ids: [A, B], complete: true });
    assert.deepEqual(protocol.decode(list([]), prepared).ids, []);
    assert.deepEqual(protocol.decode(list([], 500), prepared).ids, []);
    assert.deepEqual(protocol.decode(list([A], 500), prepared).ids, [A]);
    assert.deepEqual(protocol.decode(m(4, [s(1, A), n(4, 500)]), prepared).ids, [A], 'protobuf success zero may be omitted');
    for (const bytes of [n(1, 0), list([A, A]), list([A.replace('12345_', '999_')]), Buffer.concat([n(1, 1), m(4, [])]), Buffer.concat([n(1, 0), n(1, 0), m(4, [])]),
        Buffer.concat([n(1, 0), m(4, [n(4, 500), n(4, 500)])]), Buffer.concat([n(1, 0), m(4, [s(4, '500')])])]) assert.throws(() => protocol.decode(bytes, prepared));
});

test('details preserve current and legacy descriptions and constrain responses to requested IDs and MD5', () => {
    const prepared = protocol.prepare('face.detail', { uin: '12345', ids: [A, B] });
    assert.deepEqual(protocol.decode(envelope(prepared, Buffer.concat([n(1, 0), entry(A, '旧备注', true), entry(B, '新备注')])), prepared),
        { uin: '12345', entries: [{ emojiId: A, desc: '旧备注' }, { emojiId: B, desc: '新备注' }] });
    for (const body of [Buffer.concat([n(1, 0), entry(A), entry(A)]), Buffer.concat([n(1, 0), entry(A.replace('12345_', '999_'))]),
        Buffer.concat([n(1, 0), m(4, [m(1, [s(1, A), s(2, 'B'.repeat(32))])])]), Buffer.concat([n(1, 5), entry(A)])]) assert.throws(() => protocol.decode(envelope(prepared, body), prepared));
    assert.throws(() => protocol.decode(envelope(prepared, n(1, 0), 1), prepared), { code: 'KERNEL_ERROR' });
});

test('upload nodes and ticket derive only from fixed authenticated server responses', () => {
    const session = protocol.prepare('face.uploadSession');
    assert.equal(session.name, 'HttpConn.0x6ff_501');
    const connection = host => m(0x501, [m(3, [n(1, 1), m(2, [Buffer.from([0x15, ...host]), n(3, 80)])])]);
    assert.deepEqual(protocol.decode(connection([42, 81, 1, 9]), session), { servers: [{ host: '42.81.1.9', port: 80 }] });
    for (const host of [[127, 0, 0, 1], [10, 1, 2, 3], [172, 16, 0, 1], [192, 168, 0, 1], [169, 254, 1, 1]]) assert.throws(() => protocol.decode(connection(host), session), { code: 'INVALID_RESPONSE' });
    const ticket = protocol.prepare('face.uploadTicket', { uin: '12345', md5: 'A'.repeat(32), size: 68 });
    assert.equal(ticket.name, 'ImgStore.BDHExpressionRoam');
    assert.deepEqual(protocol.decode(m(3, [b(8, Buffer.alloc(128, 1))]), ticket).token, Buffer.alloc(128, 1));
    assert.throws(() => protocol.decode(m(3, [b(8, Buffer.alloc(1))]), ticket), { code: 'INVALID_RESPONSE' });
});

test('known empty custom-face write ACKs remain candidates and query containers are still required', () => {
    const deleted = protocol.prepare('face.delete', { uin: '12345', emojiId: A });
    assert.equal(protocol.decode(Buffer.alloc(0), deleted).acknowledged, true);
    for (const operation of ['face.modify', 'face.order', 'face.reorder']) {
        const data = operation === 'face.reorder' ? { uin: '12345', ids: [A] } : { uin: '12345', emojiId: A, ...(operation === 'face.modify' ? { desc: 'Actual' } : {}) };
        const prepared = protocol.prepare(operation, data);
        assert.equal(protocol.decode(envelope(prepared, Buffer.alloc(0)), prepared).acknowledged, true);
        assert.equal(protocol.decode(Buffer.concat([n(1, prepared.command), n(2, 1)]), prepared).acknowledged, true);
        assert.throws(() => protocol.decode(Buffer.alloc(0), prepared));
        assert.throws(() => protocol.decode(envelope(prepared, Buffer.alloc(0), 5), prepared));
    }
    for (const operation of ['face.list', 'face.detail']) {
        const prepared = protocol.prepare(operation, operation === 'face.list' ? { uin: '12345' } : { uin: '12345', ids: [A] });
        assert.throws(() => protocol.decode(Buffer.alloc(0), prepared));
    }
});

test('Highway custom-face frame retains ticket, command9, exact digest/bytes and requires full ACK', () => {
    const bytes = Buffer.from('real-image-fixture'), md5 = crypto.createHash('md5').update(bytes).digest('hex'), emojiId = '12345_0_0_0_' + md5.toUpperCase() + '_0_0';
    const upload = protocol.uploadFrame({ uin: '12345', emojiId, md5, bytes, token: Buffer.alloc(128, 7) });
    assert.equal(upload[0], 0x28); assert.equal(upload.at(-1), 0x29); assert.equal(upload.readUInt32BE(5), bytes.length);
    const head = p.fields(upload.subarray(9, 9 + upload.readUInt32BE(1))), segment = p.fields(p.one(head, 2).value);
    assert.equal(p.one(p.fields(p.one(head, 1).value), 8).value, 9n); assert.deepEqual(p.one(segment, 6).value, Buffer.alloc(128, 7));
    assert.deepEqual(upload.subarray(9 + upload.readUInt32BE(1), -1), bytes);
    const ack = size => frame(Buffer.concat([m(2, [n(2, size), n(3, 0), n(4, size), n(5, 0)]), n(3, 0)]));
    assert.equal(protocol.uploadAck(ack(bytes.length), bytes.length), true);
    for (const invalid of [Buffer.from('HTTP OK'), ack(bytes.length - 1), ack(bytes.length).subarray(0, -1), frame(n(3, 1))]) assert.throws(() => protocol.uploadAck(invalid, bytes.length));
});
