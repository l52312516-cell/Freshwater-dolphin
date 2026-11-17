'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const native = require('../src/qq/native-forward-body.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const join = (...parts) => Buffer.concat(parts);
const U32_MAX = 0xffffffffn, U64_MAX = 0xffffffffffffffffn;
const textBody = text => b(1, b(2, b(1, s(1, text))));
const record = (options = {}) => ({ authorUin: '22222', authorUid: 'u_other', nickname: '  原始节点😀  ',
    random: '3456789012', sequence: '4000000001', time: '1700000001', opaqueUid: '18446744073709551615',
    body: textBody('  完整内容\n\n'), ...options });
function encodeNode(value = record()) {
    const head = join(n(1, value.authorUin), s(2, value.authorUid), b(7, join(s(6, value.nickname), n(11, 1))));
    const reserve = join(n(1, 0), n(2, 0), n(3, 2), b(4, Buffer.alloc(44, 1)), b(5, Buffer.alloc(158, 2)));
    const meta = join(n(1, 9), n(2, 175), n(3, 175), n(4, value.random), n(5, value.sequence), n(6, value.time),
        n(7, 1), n(11, value.opaqueUid), b(15, reserve));
    return join(b(1, head), b(2, meta), b(3, value.body));
}
const payload = nodes => b(2, join(s(1, 'MultiMsg'), b(2, join(...nodes.map(node => b(1, node))))));
const sample = (...records) => payload((records.length ? records : [record()]).map(encodeNode));
function encodeFields(map) {
    return join(...[...map].flatMap(([field, values]) => values.map(value => value.wire === 0 ? n(field, value.value) :
        value.wire === 2 ? b(field, value.value) : join(p.varint(BigInt(field * 8 + value.wire)), value.value))));
}
function edit(raw, at, callback) {
    const map = p.fields(raw);
    if (!at.length) return callback(map) ?? encodeFields(map);
    const cell = map.get(at[0])[0];
    cell.value = edit(cell.value, at.slice(1), callback);
    return encodeFields(map);
}
function replace(raw, at, field, bytes) {
    return edit(raw, at, map => { map.delete(field); return join(encodeFields(map), bytes); });
}
const NODE = [2, 2, 1], HEAD = [...NODE, 1], FORWARD = [...HEAD, 7], META = [...NODE, 2], RESERVE = [...META, 15], BODY = [...NODE, 3];
const STRUCTURES = [[], [2], [2, 2], NODE, HEAD, FORWARD, META, RESERVE, BODY];
const rejected = bytes => assert.throws(() => native.decodePayload(bytes), { code: 'INVALID_RESPONSE' });

test('the observed native 9/175/175 resource retains ordered authors, exact uint32 metadata and complete body', () => {
    const first = record(), second = record({ authorUin: '11111', authorUid: 'u_self', nickname: 'second',
        random: '123', sequence: '456', time: '1700000002', body: textBody('different') });
    const result = native.decodePayload(sample(first, second));
    assert.deepEqual(result.nodes, [first, second].map(({ authorUin, authorUid, nickname, random, sequence, time, body }) =>
        ({ authorUin, authorUid, nickname, random, sequence, time, body })));
    assert.deepEqual(Object.keys(result.nodes[0]), ['authorUin', 'authorUid', 'nickname', 'random', 'sequence', 'time', 'body']);
    assert.equal(result.nodes[0].sequence, '4000000001', 'wire sequence is returned without a records.msgSeq conversion');
    assert.equal(result.nodes[0].opaqueUid, undefined, 'opaque msgUid is validated, not reinterpreted or exported');
});

test('decoded bodies are independent copies of the input, other nodes and subsequent results', () => {
    const input = sample(record(), record()), original = Buffer.from(input), result = native.decodePayload(input);
    result.nodes[0].body.fill(0);
    assert(input.equals(original));
    assert(result.nodes[1].body.equals(record().body));
    assert(native.decodePayload(input).nodes[0].body.equals(record().body));
    input.fill(0);
    assert(result.nodes[1].body.equals(record().body));
});

test('opaque native image-rich bytes are retained in full without rebuilding inner media protocols', () => {
    const rich = join(b(2, b(1, s(1, 'caption'))), b(2, b(8, join(b(1, Buffer.from([0, 255, 12])), n(2, 7)))));
    const body = b(1, rich), input = sample(record({ body }));
    assert(native.decodePayload(input).nodes[0].body.equals(body));
    const other = Buffer.from(body); other[other.length - 1] ^= 1;
    assert(native.decodePayload(sample(record({ body: other }))).nodes[0].body.equals(other));
});

test('legal field ordering and bounded server-owned signature changes do not alter returned node values', () => {
    const source = sample(), expected = native.decodePayload(source);
    for (const at of STRUCTURES) {
        const reordered = edit(source, at, map => encodeFields(new Map([...map].reverse())));
        assert.deepEqual(native.decodePayload(reordered), expected);
    }
    for (const length of [1, 158, 159, 4096]) {
        const resigned = replace(source, RESERVE, 5, b(5, Buffer.alloc(length, 0xff)));
        assert.deepEqual(native.decodePayload(resigned), expected);
    }
});

test('unknown, duplicate and missing fields are rejected at every known structural envelope', () => {
    const source = sample();
    for (const at of STRUCTURES) {
        rejected(edit(source, at, map => join(encodeFields(map), n(99, 1))));
        for (const field of p.fields(at.reduce((bytes, field) => p.fields(bytes).get(field)[0].value, source)).keys()) {
            rejected(edit(source, at, map => { map.delete(field); }));
            if (at.length === 2) continue; // Content field 1 is the bounded repeated node list.
            rejected(edit(source, at, map => {
                const cell = map.get(field)[0];
                return join(encodeFields(map), cell.wire === 0 ? n(field, cell.value) : b(field, cell.value));
            }));
        }
    }
});

test('all known fields require their exact observed protobuf wire type', () => {
    const source = sample();
    for (const at of STRUCTURES) {
        const map = p.fields(at.reduce((bytes, field) => p.fields(bytes).get(field)[0].value, source));
        for (const [field, values] of map) rejected(replace(source, at, field, values[0].wire === 0 ? b(field, Buffer.from([1])) : n(field, 1)));
    }
    for (const wire of [1, 5]) rejected(join(p.varint(BigInt(2 * 8 + wire)), Buffer.alloc(wire === 1 ? 8 : 4)));
});

test('only native 9/175/175 flags and the exact observed reserve constants are accepted', () => {
    const source = sample();
    for (const [at, field, values] of [[FORWARD, 11, [0, 2]], [META, 1, [0, 8, 82]],
        [META, 2, [0, 4, 174, 176]], [META, 3, [0, 4, 174, 176]], [META, 7, [0, 2]],
        [RESERVE, 1, [1, 2]], [RESERVE, 2, [1, 2]], [RESERVE, 3, [0, 1, 3]]]) {
        for (const value of values) rejected(replace(source, at, field, n(field, value)));
    }
    for (const length of [0, 1, 43, 45, 4096]) rejected(replace(source, RESERVE, 4, b(4, Buffer.alloc(length))));
    for (const length of [0, 4097]) rejected(replace(source, RESERVE, 5, b(5, Buffer.alloc(length))));
});

test('author/time ranges, uint32 random and wire sequence, and opaque complete uint64 values are exact', () => {
    for (const value of ['1', U32_MAX.toString()]) {
        const decoded = native.decodePayload(sample(record({ authorUin: value, random: value, sequence: value, time: value }))).nodes[0];
        assert.equal(decoded.authorUin, value); assert.equal(decoded.random, value); assert.equal(decoded.sequence, value); assert.equal(decoded.time, value);
    }
    const zero = native.decodePayload(sample(record({ random: '0', sequence: '0', opaqueUid: '0' }))).nodes[0];
    assert.equal(zero.random, '0'); assert.equal(zero.sequence, '0');
    for (const value of ['9007199254740993', U64_MAX.toString()]) assert.doesNotThrow(() => native.decodePayload(sample(record({ opaqueUid: value }))));
    const source = sample();
    for (const [at, field] of [[HEAD, 1], [META, 4], [META, 5], [META, 6]]) rejected(replace(source, at, field, n(field, U32_MAX + 1n)));
    for (const [at, field] of [[HEAD, 1], [META, 6]]) rejected(replace(source, at, field, n(field, 0)));
    const overflowingU64 = join(p.varint(11 * 8), Buffer.from([...Array(9).fill(0xff), 2]));
    rejected(replace(source, META, 11, overflowingU64));
});

test('author UID and nickname enforce UTF-8, byte bounds and nonempty exact strings', () => {
    const source = sample();
    for (const bytes of [Buffer.alloc(0), Buffer.from('not-a-uid'), Buffer.from('u_'), Buffer.from('u_has space'),
        Buffer.from('u_' + 'x'.repeat(127)), Buffer.from([0xff]), Buffer.from('\ufeffu_other')]) rejected(replace(source, HEAD, 2, b(2, bytes)));
    assert.doesNotThrow(() => native.decodePayload(replace(source, HEAD, 2, s(2, 'u_' + 'x'.repeat(126)))));
    for (const bytes of [Buffer.alloc(0), Buffer.from(' \t '), Buffer.from('newline\n'), Buffer.from('null\0'),
        Buffer.from('delete\x7f'), Buffer.from('x'.repeat(513)), Buffer.from('鱼'.repeat(171)), Buffer.from([0xff])]) {
        rejected(replace(source, FORWARD, 6, b(6, bytes)));
    }
    assert.equal(native.decodePayload(replace(source, FORWARD, 6, s(6, 'x'.repeat(512)))).nodes[0].nickname.length, 512);
    assert.equal(native.decodePayload(source).nodes[0].nickname, '  原始节点😀  ');
});

test('a resource contains exactly one correctly named MultiMsg and one through 100 nodes', () => {
    const source = sample();
    for (const value of ['', 'multimsg', 'MultiMsg\0', 'OtherMsg']) rejected(replace(source, [2], 1, s(1, value)));
    rejected(payload([])); rejected(payload(Array(101).fill(encodeNode())));
    assert.equal(native.decodePayload(payload(Array(100).fill(encodeNode()))).nodes.length, 100);
    const root = p.fields(source).get(2)[0].value;
    rejected(join(source, b(2, root)));
});

test('body wrappers cannot contain extra fields and nonempty rich bytes must have valid protobuf syntax', () => {
    for (const body of [Buffer.alloc(0), b(1, Buffer.alloc(0)), b(1, Buffer.from([0])), b(1, Buffer.from([0xff])),
        b(1, Buffer.from([0x0a, 3, 1])), join(textBody('x'), n(2, 1)), join(textBody('x'), textBody('y'))]) {
        rejected(sample(record({ body })));
    }
});

test('non-Buffers, malformed packets and the aggregate 256 KiB budget fail before returning any node', () => {
    for (const input of [undefined, null, '', [], new Uint8Array([1]), new ArrayBuffer(1), Buffer.alloc(0),
        Buffer.alloc(native.MAX_BYTES + 1), Buffer.from([0xff]), Buffer.from([0]), sample().subarray(0, sample().length - 1)]) rejected(input);
    let size = native.MAX_BYTES - sample().length, boundary;
    for (let attempt = 0; attempt < 5; attempt++) {
        boundary = sample(record({ body: b(1, b(77, Buffer.alloc(size, 42))) }));
        if (boundary.length === native.MAX_BYTES) break;
        size += native.MAX_BYTES - boundary.length;
    }
    assert.equal(boundary.length, native.MAX_BYTES);
    assert.equal(native.decodePayload(boundary).nodes.length, 1);
    rejected(sample(record({ body: b(1, b(77, Buffer.alloc(size + 1, 42))) })));
    assert.equal(native.MAX_BYTES, 256 * 1024); assert.equal(native.MAX_NODES, 100);
});

test('the fixed upload decoder remains separate and does not accept native type 175 resources', () => {
    const protocol = require('../src/qq/forward-upload-protocol.cjs');
    assert.throws(() => protocol.decodePayload(sample()), { code: 'INVALID_RESPONSE' });
    const fixed = protocol.prepare('forward.upload', { selfUin: '11111', selfUid: 'u_self', nodes: [
        { nickname: 'fixed shape', texts: ['x'], authorUin: '11111', authorUid: 'u_self', random: 1, sequence: 2, time: 3 }
    ] }).rawPayload;
    rejected(fixed);
});
