'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const fixed = require('../src/qq/query2-oidb.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const m = (field, parts) => b(field, Buffer.concat(parts));
function response(prepared, body, extra = []) { return Buffer.concat([n(1, prepared.command), n(2, prepared.sub), n(3, 0), b(4, body), ...extra]); }
function statusBody(entries, identities = [n(1, 12345)]) { return m(1, [...identities, m(2, entries.map(([key, value]) => m(1, [n(1, key), ...(value === undefined ? [] : [n(2, value)])]))) ]); }
function banner({ source = '77_-123', jump = { seq: 77, random: -123 }, text = '待办正文', timestamps = true, disappear = false } = {}) {
    return m(1, [s(3, source), n(4, disappear ? 1 : 0), m(20, [m(1, [s(3, text)]), ...(jump === undefined ? [] : [m(2, [s(3, JSON.stringify(jump))])]), ...(timestamps ? [n(3, 1700000000), n(4, 1700000010)] : [])])]);
}

test('status and todo serializers fix their command, property, identity mode and banner flag', () => {
    const status = fixed.prepare('user.status', { uin: '12345' });
    assert.equal(status.name, 'OidbSvcTrpcTcp.0xfe1_2');
    const top = p.fields(status.body), body = p.fields(p.one(top, 4).value);
    assert.equal(p.one(top, 12).value, 1n);
    assert.equal(p.one(body, 1).value, 12345n);
    assert.equal(p.one(p.fields(p.one(body, 3).value), 1).value, 27372n);
    const todo = fixed.prepare('group.todos', { groupId: '20001' }), request = p.fields(p.one(p.fields(todo.body), 4).value);
    assert.equal(todo.command, 0x9474); assert.equal(todo.sub, 0); assert.equal(todo.mode, 0);
    assert.equal(p.one(request, 1).value, 20001n); assert.equal(p.one(request, 2).value, 1n);
    for (const data of [{ uin: 0 }, { uin: 1.1 }, { uin: '001' }, { uin: '4294967296' }, { uin: '12345', raw: 'a' }]) assert.throws(() => fixed.prepare('user.status', data));
    assert.throws(() => fixed.prepare('OidbSvcTrpcTcp.arbitrary', {}));
});

test('status matches property key and exact echoed account, preserving observed zero and extended words', () => {
    const prepared = fixed.prepare('user.status', { uin: '12345' });
    for (const [raw, expected] of [[0n, { status: 0, extStatus: 0 }], [2n, { status: 20, extStatus: 0 }], [0x121234n, { status: 10, extStatus: 0x1212 }]]) {
        assert.deepEqual(fixed.decode(response(prepared, statusBody([[1, 99], [27372, raw]])), prepared), { uin: '12345', ...expected });
    }
    for (const body of [statusBody([[27372, 0]], []), statusBody([[27372, 0]], [n(1, 999)]), statusBody([[27372, 0]], [n(1, 12345), n(3, 999)]),
        statusBody([[999, 0]]), statusBody([[27372, undefined]]), statusBody([[27372, 0], [27372, 2]])]) assert.throws(() => fixed.decode(response(prepared, body), prepared), { code: 'INVALID_RESPONSE' });
});

test('todo identities cross-check native source and jump data; absent timestamps stay absent', () => {
    const prepared = fixed.prepare('group.todos', { groupId: '20001' });
    const result = fixed.decode(response(prepared, Buffer.concat([banner(), banner({ source: 'malformed', disappear: true }), n(3, 9)])), prepared);
    assert.deepEqual(result, { groupId: '20001', todos: [{ sourceId: '77_-123', sequence: 77, random: -123, text: '待办正文', createdAt: 1700000000, updatedAt: 1700000010 }], newSequence: '9' });
    const missing = fixed.decode(response(prepared, banner({ timestamps: false })), prepared).todos[0];
    assert.equal(Object.hasOwn(missing, 'createdAt'), false); assert.equal(Object.hasOwn(missing, 'updatedAt'), false);
    assert.deepEqual(fixed.decode(response(prepared, Buffer.alloc(0)), prepared), { groupId: '20001', todos: [] });
    for (const body of [banner({ jump: { seq: 78, random: -123 } }), banner({ source: '77_-0' }), Buffer.concat([banner(), banner()]), m(1, [s(3, '77_1')]),
        m(1, [b(3, Buffer.from([0xff])), n(4, 0)]), m(1, [s(3, '77_1'), n(4, 2)]), banner({ text: 'x'.repeat(16385) })]) assert.throws(() => fixed.decode(response(prepared, body), prepared), { code: 'INVALID_RESPONSE' });
});

test('fixed query decoders reject wrong envelopes, duplicate fields, absent bodies and kernel errors', () => {
    const prepared = fixed.prepare('group.todos', { groupId: '20001' });
    for (const bytes of [Buffer.concat([n(1, 1), n(3, 0), b(4, Buffer.alloc(0))]), Buffer.concat([n(1, prepared.command), n(3, 1), b(4, Buffer.alloc(0))]),
        Buffer.concat([n(1, prepared.command), n(3, 0)]), response(prepared, Buffer.alloc(0), [n(12, 1)]), response(prepared, Buffer.alloc(0), [n(3, 0)]), Buffer.alloc(1024 * 1024 + 1)]) assert.throws(() => fixed.decode(bytes, prepared));
});
