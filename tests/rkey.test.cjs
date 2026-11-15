'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rkey = require('../src/qq/rkey.cjs');

function varint(value) {
    const out = []; let rest = BigInt(value);
    do { const byte = Number(rest & 0x7fn); rest >>= 7n; out.push(rest > 0n ? byte | 0x80 : byte); } while (rest > 0n);
    return Buffer.from(out);
}
const vfield = (field, value) => Buffer.concat([varint(field << 3), varint(value)]);
const bfield = (field, payload) => Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]);
const mfield = (field, parts) => bfield(field, Buffer.concat(parts));

function readVarint(buffer, offset) {
    let shift = 0n, value = 0n, byte;
    do { byte = buffer[offset++]; value |= BigInt(byte & 0x7f) << shift; shift += 7n; } while (byte & 0x80);
    return { value, offset };
}
function fields(buffer) {
    const out = new Map(); let i = 0;
    while (i < buffer.length) {
        const t = readVarint(buffer, i); i = t.offset;
        const field = Number(t.value >> 3n), wire = Number(t.value & 7n);
        if (wire === 0) { const v = readVarint(buffer, i); i = v.offset; out.set(field, [...(out.get(field) || []), { wire, value: v.value }]); }
        else { const len = readVarint(buffer, i); i = len.offset; const end = i + Number(len.value); out.set(field, [...(out.get(field) || []), { wire, value: buffer.subarray(i, end) }]); i = end; }
    }
    return out;
}
const one = (map, field) => (map.get(field) || [])[0];

function infoEntry({ rkey, type, ttl, storeId, createTime }) {
    const parts = [bfield(1, Buffer.from(rkey, 'utf8'))];
    if (ttl !== undefined) parts.push(vfield(2, ttl));
    if (storeId !== undefined) parts.push(vfield(3, storeId));
    if (createTime !== undefined) parts.push(vfield(4, createTime));
    parts.push(vfield(5, type));
    return bfield(1, Buffer.concat(parts));
}
function response({ command = 0x9067, sub = 202, errorCode = 0, entries } = {}) {
    const body = entries === undefined ? Buffer.alloc(0) : bfield(4, Buffer.concat(entries.map(infoEntry)));
    return Buffer.concat([vfield(1, command), vfield(2, sub), vfield(3, errorCode), bfield(4, body)]);
}

test('encodeRequest is the bare NTV2RichMediaReq with the verified head scene and rkey types', () => {
    const request = rkey.encodeRequest();
    const top = fields(request);
    assert.ok(one(top, 1), 'head present');
    assert.equal(one(top, 1).wire, 2);
    assert.ok(one(top, 4), 'downloadRkey present');
    assert.equal(one(top, 2), undefined, 'no envelope command field (bare proto)');
    const head = fields(one(top, 1).value);
    const common = fields(one(head, 1).value);
    assert.equal(Number(one(common, 1).value), 1, 'requestId');
    assert.equal(Number(one(common, 2).value), 202, 'command');
    const scene = fields(one(head, 2).value);
    assert.equal(Number(one(scene, 101).value), 2);
    assert.equal(Number(one(scene, 102).value), 1);
    assert.equal(Number(one(scene, 200).value), 0);
    const client = fields(one(head, 3).value);
    assert.equal(Number(one(client, 1).value), 2, 'agentType');
    const types = fields(one(top, 4).value).get(1).map(item => Number(item.value));
    assert.deepEqual(types, [10, 20, 2]);
    assert.equal(rkey.CMD, 'OidbSvc.0x9067_202');
});

test('decodeResponse extracts bounded rkey entries from a successful OidbBase response', () => {
    const buffer = response({ entries: [
        { rkey: '&rkey=GROUP', type: 10, ttl: 3600, storeId: 1, createTime: 1700000000 },
        { rkey: '&rkey=PRIVATE', type: 20, ttl: 7200 }
    ] });
    const entries = rkey.decodeResponse(buffer);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { rkey: '&rkey=GROUP', type: 10, rkeyTtlSec: 3600, storeId: 1, rkeyCreateTime: 1700000000 });
    assert.deepEqual(entries[1], { rkey: '&rkey=PRIVATE', type: 20, rkeyTtlSec: 7200 });
});

test('decodeResponse rejects the empty kernel stub observed on QQ 3.2.35', () => {
    // command echo 0, errorCode 253, empty body — the live stub must never yield a key.
    const stub = Buffer.concat([vfield(1, 0), vfield(2, 0), vfield(3, 253), bfield(4, Buffer.alloc(0))]);
    assert.throws(() => rkey.decodeResponse(stub), { code: 'QUERY_FAILED' });
    const stub2 = Buffer.concat([vfield(1, 2), vfield(2, 202), vfield(3, 253), bfield(4, Buffer.alloc(0))]);
    assert.throws(() => rkey.decodeResponse(stub2), { code: 'QUERY_FAILED' });
});

test('decodeResponse rejects command mismatch, nonzero errorCode, empty or malformed bodies', () => {
    assert.throws(() => rkey.decodeResponse(response({ command: 0xfe1 })), { code: 'QUERY_FAILED' });
    assert.throws(() => rkey.decodeResponse(response({ sub: 1 })), { code: 'QUERY_FAILED' });
    assert.throws(() => rkey.decodeResponse(response({ errorCode: 253, entries: [{ rkey: 'x', type: 10 }] })), { code: 'QUERY_FAILED' });
    assert.throws(() => rkey.decodeResponse(response({ entries: [] })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => rkey.decodeResponse(response()), { code: 'QUERY_FAILED' });
});

test('decodeResponse rejects invalid rkey values, types and oversized entries', () => {
    assert.throws(() => rkey.decodeResponse(response({ entries: [{ rkey: 'bad\x01key', type: 10 }] })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => rkey.decodeResponse(response({ entries: [{ rkey: 'ok', type: 0 }] })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => rkey.decodeResponse(response({ entries: [{ rkey: '', type: 10 }] })), { code: 'INVALID_RESPONSE' });
    assert.throws(() => rkey.decodeResponse(response({ entries: [{ rkey: 'x'.repeat(8193), type: 10 }] })), { code: 'INVALID_RESPONSE' });
    const tooMany = response({ entries: Array.from({ length: 129 }, () => ({ rkey: 'x', type: 10 })) });
    assert.throws(() => rkey.decodeResponse(tooMany), { code: 'INVALID_RESPONSE' });
});

function fakeCapture({ rsp, result = 0, method = true, hang = false } = {}) {
    return {
        session: {},
        service: () => ({
            sendSsoCmdReqByContend: method ? (cmd, body) => {
                assert.equal(cmd, 'OidbSvc.0x9067_202');
                assert.equal(typeof body, 'string');
                if (hang) return new Promise(() => {});
                return Promise.resolve({ result, errMsg: 'success', rsp: rsp ? rkey.latin1(rsp) : '' });
            } : undefined
        })
    };
}

test('fetchRkeys returns decoded entries from the kernel SSO channel', async () => {
    const rsp = response({ entries: [{ rkey: '&rkey=G', type: 10, ttl: 60, createTime: 1700000000 }] });
    const result = await rkey.fetchRkeys(fakeCapture({ rsp }), { timeoutMs: 1000 });
    assert.equal(result.rkeys.length, 1);
    assert.equal(result.rkeys[0].rkey, '&rkey=G');
});

test('fetchRkeys reports unsupported channel, transport failure, empty response and timeout', async () => {
    await assert.rejects(rkey.fetchRkeys(fakeCapture({ method: false })), { code: 'UNSUPPORTED' });
    await assert.rejects(rkey.fetchRkeys(fakeCapture({ result: 236 })), { code: 'QUERY_FAILED' });
    await assert.rejects(rkey.fetchRkeys(fakeCapture({ rsp: null })), { code: 'QUERY_FAILED' });
    await assert.rejects(rkey.fetchRkeys(fakeCapture({ hang: true }), { timeoutMs: 20 }), { code: 'TIMEOUT' });
    await assert.rejects(rkey.fetchRkeys({ session: null }), { code: 'NOT_READY' });
});