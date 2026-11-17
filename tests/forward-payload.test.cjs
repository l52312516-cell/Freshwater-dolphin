'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/qq/proto.cjs');
const protocol = require('../src/qq/forward-upload-protocol.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
const join = (...parts) => Buffer.concat(parts);
const body = texts => b(1, join(...texts.map(value => b(2, b(1, s(1, value))))));
const authorUids = () => new Map([['11111', 'u_self'], ['22222', 'u_other']]);
const descriptors = () => [
    { authorUin: '22222', authorUid: 'u_other', nickname: '  原发送者😀  ', texts: ['  第一段\n\n', 'second'], time: '1700000001', sequence: '123', random: '456' },
    { authorUin: '11111', authorUid: 'u_self', nickname: '自己', texts: ['same words', 'same words'], time: '1700000002', sequence: '124', random: '457' }
];
function submitted(nodes = descriptors()) {
    return protocol.prepare('forward.upload', { selfUin: '11111', selfUid: 'u_self', nodes }).rawPayload;
}
function reserve() { return join(n(3, 2), b(4, Buffer.alloc(44, 1)), b(5, Buffer.alloc(154, 2))); }
function serverNode(node, options = {}) {
    const head = join(n(1, node.authorUin), s(2, node.authorUid), b(7, join(s(6, node.nickname), n(11, 1))));
    const metadata = join(n(1, 9), n(4, node.random), n(5, node.sequence), n(6, node.time), b(15, reserve()));
    return join(b(1, head), b(2, metadata), b(3, options.body ?? body(node.texts)));
}
function payload(nodes) { return b(2, join(s(1, 'MultiMsg'), b(2, join(...nodes.map(value => b(1, value)))))); }
function returned(nodes = descriptors()) { return payload(nodes.map(node => serverNode(node))); }
function encodeFields(map) {
    return join(...[...map].flatMap(([field, values]) => values.map(value => value.wire === 0 ? n(field, value.value) :
        value.wire === 2 ? b(field, value.value) : join(p.varint(BigInt(field * 8 + value.wire)), value.value))));
}
function edit(raw, path, callback) {
    const fields = p.fields(raw);
    if (!path.length) return callback(fields) ?? encodeFields(fields);
    const field = path[0], cell = fields.get(field)[0];
    cell.value = edit(cell.value, path.slice(1), callback);
    return encodeFields(fields);
}
function replace(raw, path, field, encoded) {
    return edit(raw, path, map => {
        map.delete(field);
        return join(encodeFields(map), encoded);
    });
}
const HEAD = [2, 2, 1, 1], FORWARD = [...HEAD, 7], META = [2, 2, 1, 2], RESERVE = [...META, 15];
const rejected = (expected, actual, options = { authorUids: authorUids() }) =>
    assert.throws(() => protocol.verifyPayload(expected, actual, options), { code: 'INVALID_RESPONSE' });

test('exact submitted payload remains valid and decoded metadata and buffers retain every original value', () => {
    const expected = submitted(), decoded = protocol.decodePayload(expected);
    assert.deepEqual(protocol.verifyPayload(expected, expected), { verified: true, nodeCount: 2, exactBytes: true });
    assert.equal(decoded.nodes[0].authorUin, '22222');
    assert.equal(decoded.nodes[0].authorUid, 'u_other');
    assert.equal(decoded.nodes[0].toUid, 'u_self');
    assert.equal(decoded.nodes[0].nickname, '  原发送者😀  ');
    assert.equal(decoded.nodes[0].time, '1700000001');
    assert.equal(decoded.nodes[0].subType, '4');
    assert.equal(decoded.nodes[0].c2cCommand, '0');
    assert(decoded.nodes[0].body.equals(body(descriptors()[0].texts)));
    decoded.nodes[0].body.fill(0);
    assert(protocol.decodePayload(expected).nodes[0].body.equals(body(descriptors()[0].texts)), 'decoded body must not alias the request bytes');
});

test('the observed server identity, forward flag and reserve additions preserve both author identities and custom times', () => {
    const expected = submitted(), actual = returned();
    assert.equal(expected.equals(actual), false);
    assert.deepEqual(protocol.verifyPayload(expected, actual, { authorUids: authorUids() }),
        { verified: true, nodeCount: 2, exactBytes: false });
    const decoded = protocol.decodePayload(actual).nodes;
    assert.equal(decoded[0].authorUid, 'u_other');
    assert.equal(decoded[0].toUid, undefined);
    assert.equal(decoded[0].subType, undefined);
    assert.equal(decoded[1].time, '1700000002');
    const summary = JSON.stringify(protocol.verifyPayload(expected, actual, { authorUids: authorUids() }));
    assert.doesNotMatch(summary, /u_self|u_other|11111|22222|原发送者|170000000/);
});

test('field ordering and bounded server-owned signatures may change without changing node content', () => {
    const expected = submitted(), actual = returned();
    const reordered = edit(actual, HEAD, map => encodeFields(new Map([...map].reverse())));
    assert(protocol.verifyPayload(expected, reordered, { authorUids: authorUids() }).verified);
    const resigned = edit(actual, RESERVE, () => join(b(5, Buffer.alloc(4096, 6)), b(4, Buffer.alloc(1, 7)), n(3, 2)));
    assert(protocol.verifyPayload(expected, resigned, { authorUids: authorUids() }).verified);
    const retainedDefaults = edit(actual, META, map => join(n(3, 0), encodeFields(map), n(2, 4)));
    assert(protocol.verifyPayload(expected, retainedDefaults, { authorUids: authorUids() }).verified);
});

test('a recipient UID never substitutes for a verified author UID when the server transforms the head', () => {
    const input = descriptors().map(node => { const result = { ...node }; delete result.authorUid; return result; });
    const expected = submitted(input), actual = returned();
    rejected(expected, actual, {});
    rejected(expected, actual, { authorUids: new Map([['11111', 'u_self']]) });
    rejected(expected, actual, { authorUids: new Map([['22222', 'u_self'], ['11111', 'u_self']]) });
    assert(protocol.verifyPayload(expected, actual, { authorUids: authorUids() }).verified);
    const mixedHead = replace(actual, HEAD, 6, s(6, 'u_other_recipient'));
    rejected(expected, mixedHead);
    const noIdentities = edit(actual, HEAD, map => { map.delete(2); map.delete(6); });
    rejected(expected, noIdentities);
    const removedAuthor = edit(actual, HEAD, map => { map.delete(2); return join(encodeFields(map), s(6, 'u_self')); });
    rejected(submitted(), removedAuthor);
});

test('node order, count, authors, display names, custom timestamps, identities and complete body must all match', () => {
    const expected = submitted(), base = returned();
    for (const raw of [
        returned(descriptors().reverse()), returned(descriptors().slice(0, 1)), returned([...descriptors(), descriptors()[0]]),
        replace(base, HEAD, 1, n(1, 33333)), replace(base, HEAD, 2, s(2, 'u_wrong')),
        replace(base, FORWARD, 6, s(6, 'changed name')), replace(base, META, 6, n(6, 1700000003)),
        replace(base, META, 4, n(4, 458)), replace(base, META, 5, n(5, 125)),
        replace(base, [2, 2, 1], 3, b(3, body(['第一段\n\n', 'second']))),
        replace(base, [2, 2, 1], 3, b(3, body(['second', '  第一段\n\n'])))
    ]) rejected(expected, raw);
});

test('opaque native rich media is compared in full instead of being flattened or partially parsed', () => {
    const nativeBody = b(1, join(b(2, b(1, s(1, 'caption'))), b(2, b(8, join(b(1, Buffer.from([0, 255, 12])), n(2, 7))))));
    const node = descriptors()[0];
    const expected = payload([serverNode(node, { body: nativeBody })]);
    assert(protocol.verifyPayload(expected, expected).verified);
    assert(protocol.decodePayload(expected).nodes[0].body.equals(nativeBody));
    const changed = Buffer.from(nativeBody); changed[changed.length - 1] ^= 1;
    rejected(expected, payload([serverNode(node, { body: changed })]));
    rejected(expected, payload([serverNode(node, { body: body(['caption']) })]));
});

test('unknown and duplicate structural fields at every envelope are rejected even when both payloads share them', () => {
    const source = returned();
    for (const path of [[], [2], [2, 2], [2, 2, 1], HEAD, FORWARD, META, RESERVE, [2, 2, 1, 3]]) {
        const unknown = edit(source, path, map => join(encodeFields(map), n(99, 1)));
        rejected(unknown, unknown);
        if (path.length === 2) continue; // LongMsgContent field 1 is the bounded repeated node list.
        const duplicate = edit(source, path, map => {
            const [field, entries] = [...map][0];
            return join(encodeFields(map), entries[0].wire === 0 ? n(field, entries[0].value) : b(field, entries[0].value));
        });
        rejected(duplicate, duplicate);
    }
});

test('unobserved flags, malformed reserves and metadata wire or integer variants never pass normalization', () => {
    const source = returned();
    const mutations = [
        replace(source, FORWARD, 11, n(11, 0)), replace(source, FORWARD, 11, n(11, 2)),
        replace(source, FORWARD, 11, b(11, Buffer.from([1]))),
        replace(source, META, 1, n(1, 82)), replace(source, META, 2, n(2, 0)),
        replace(source, META, 3, n(3, 1)), replace(source, META, 4, n(4, 0)),
        replace(source, META, 5, n(5, 0x100000000n)), replace(source, META, 6, n(6, 0)),
        replace(source, RESERVE, 3, n(3, 1)), replace(source, RESERVE, 3, n(3, 0x100000000n)),
        replace(source, RESERVE, 3, b(3, Buffer.from([2]))),
        replace(source, RESERVE, 4, b(4, Buffer.alloc(0))), replace(source, RESERVE, 5, b(5, Buffer.alloc(4097))),
        edit(source, RESERVE, map => { map.delete(5); }),
        replace(source, HEAD, 2, s(2, 'not-a-native-uid')), replace(source, HEAD, 1, n(1, 0)),
        replace(source, FORWARD, 6, b(6, Buffer.from([0xff])))
    ];
    for (const malformed of mutations) rejected(malformed, malformed);
});

test('payload bounds, exact single MultiMsg roots and verified author-map shape are enforced', () => {
    const source = returned();
    for (const malformed of [Buffer.alloc(0), Buffer.alloc(protocol.MAX_BYTES + 1), Buffer.from([0xff]),
        Buffer.from(source.subarray(0, source.length - 1)),
        replace(source, [2], 1, s(1, 'OtherMsg')), payload([]), payload(Array(101).fill(serverNode(descriptors()[0]))),
        replace(source, [2, 2, 1], 3, b(3, b(1, Buffer.alloc(0))))]) rejected(malformed, malformed);
    for (const options of [{ authorUids: {} }, { authorUids: new Map([['0', 'u_self']]) },
        { authorUids: new Map([['11111', 'bad']]) }, { authorUids: new Map([['11111', 'u_self'], [11111, 'u_self']]) },
        { authorUids: new Map(Array.from({ length: 101 }, (_, index) => [String(index + 1), 'u_self'])) }, { unexpected: true }]) {
        assert.throws(() => protocol.verifyPayload(source, source, options), { code: 'INVALID_PARAMS' });
    }
});

test('optional author and display time metadata normalize exactly before upload without altering old text budgets', () => {
    const input = [{ nickname: 'author', texts: ['  x\n'], authorUin: 22222, authorUid: 'u_other', time: 1700000000 }];
    assert.deepEqual(protocol.normalizeNodes(input), [{ ...input[0], authorUin: '22222', time: '1700000000' }]);
    assert.equal(protocol.normalizeNodes([{ ...input[0], time: 0 }])[0].time, '0');
    assert.throws(() => protocol.normalizeNodes([{ ...input[0], time: 0, sequence: '1', random: '2' }], true), { code: 'INVALID_PARAMS' });
    assert.equal(input[0].authorUin, 22222);
    for (const patch of [{ authorUin: '0' }, { authorUin: 2 ** 53 }, { authorUid: '' }, { time: -1 }, { time: '1e9' },
        { texts: ['x'.repeat(65537)] }, { unknown: true }]) {
        assert.throws(() => protocol.normalizeNodes([{ ...input[0], ...patch }]), { code: 'INVALID_PARAMS' });
    }
});
