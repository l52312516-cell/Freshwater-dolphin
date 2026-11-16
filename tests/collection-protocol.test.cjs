'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const protocol = require('../src/qq/collection-protocol.cjs');
const wire = require('./helpers/collection-wire.cjs');
const { n, b, s } = wire;
const join = values => Buffer.concat(values);
const scope = { uin: '11111', sequence: 1, count: 50, timeStamp: '0' };
const head = () => join([n(1, 11111), n(2, 1), n(3, 2), n(4, 20000), n(101, 0)]);
const operation = list => b(2, b(20000, list));
const rawItem = (summary = [], extras = []) => join([s(1, 'synthetic-cid'), b(4, Buffer.alloc(0)), n(11, 900), b(15, join(summary)), ...extras]);
const decode = (bytes, expected = {}) => protocol.decodeResponse(bytes, { ...scope, ...expected });
const invalid = bytes => assert.throws(() => decode(bytes), { code: 'INVALID_RESPONSE' });

test('collector request matches a synthetic reference fixture and preserves exact uint64 pagination', () => {
    // Captured from the independent reference encoder using synthetic inputs;
    // the test does not import or evaluate another project at runtime.
    const reference = '2013032900010000005400000017000008914e1001180120a09c0128cfacf8fa85c2013004381b5a1073796e7468657469632d7469636b6574700878090a1582e2091120ffffffffffffffffff01280238324001';
    assert.equal(protocol.encodeRequest({ uin: '10001', pskey: 'synthetic-ticket', count: 50 }).toString('hex'), reference);
    const request = wire.request(protocol.encodeRequest({ uin: '10001', pskey: 'synthetic-ticket', count: 1,
        timeStamp: '18446744073709551614', sequence: 7 }));
    assert.equal(request.timestamp, '18446744073709551614'); assert.equal(request.sequence, 7); assert.equal(request.count, 1);
    for (const value of [0, -1, '01', '18446744073709551616', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => protocol.encodeRequest({ uin: value, pskey: 'synthetic-ticket' }), { code: 'INVALID_PARAMS' });
    }
    for (const value of ['', 'invalid;ticket', 'invalid\rticket', 'invalid\nticket', 'x'.repeat(4097)]) {
        assert.throws(() => protocol.encodeRequest({ uin: '10001', pskey: value }), { code: 'AUTH_FAILED' });
    }
    for (const value of [0, 51, 1.5]) assert.throws(() => protocol.encodeRequest({ uin: '10001', pskey: 'synthetic-ticket', count: value }), { code: 'INVALID_PARAMS' });
});

test('collector validates the full envelope before interpreting a page', () => {
    const good = wire.page();
    for (const value of [null, 'text', Buffer.alloc(0), good.subarray(0, 16), Buffer.alloc(protocol.MAX_RESPONSE_BYTES + 1)]) invalid(value);
    for (const position of [0, 4, 9, 13, 15]) { const value = Buffer.from(good); value[position] ^= 1; invalid(value); }
    for (const length of [0, good.length - 16, good.length + 1]) { const value = Buffer.from(good); value.writeUInt32BE(length, 10); invalid(value); }
    invalid(wire.envelope(head(), b(1, b(20000, n(3, 1)))));
    invalid(wire.envelope(head(), b(2, b(20001, n(3, 1)))));
});

test('response scope and business status cannot be confused with an empty successful page', () => {
    assert.deepEqual(decode(wire.page([])), { items: [], hasMore: false, bottomTimeStamp: '0' });
    invalid(wire.page([], { uin: '22222' })); invalid(wire.page([], { sequence: 2 }));
    invalid(wire.page([], { headExtra: [n(1, 11111)] }));
    invalid(wire.page([], { headExtra: [b(101, Buffer.alloc(0))] }));
    invalid(wire.page([], { headExtra: [n(3, 1)] }));
    for (const retCode of [17, -17]) assert.throws(() => decode(wire.page([], { retCode,
        headExtra: [s(102, 'private-service-detail'), s(103, 'private-service-detail')] })), error =>
        error.code === 'KERNEL_ERROR' && error.message.includes('retCode=' + retCode) && !error.message.includes('private-service-detail'));
    invalid(wire.page([], { reachedBottom: 0 }));
    // Both real test accounts were independently confirmed to have no
    // collections. The service returned this uint32 terminal marker, not 1.
    assert.deepEqual(decode(wire.page([], { reachedBottom: 215000, listExtra: [n(2, 0)] })),
        { items: [], hasMore: false, bottomTimeStamp: '0' });
    assert.deepEqual(decode(wire.page([], { reachedBottom: 4294967295 })), { items: [], hasMore: false, bottomTimeStamp: '0' });
    invalid(wire.envelope(head(), operation(n(2, 0))));
    invalid(wire.page([], { reachedBottom: 4294967296n }));
    invalid(wire.page([], { listExtra: [n(2, 4294967296n)] }));
});

test('all eight summary variants retain strings, byte data, uint64s and coordinates', () => {
    const double = (field, value) => { const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); return join([Buffer.from([field * 8 + 1]), bytes]); };
    const picture = join([s(1, 'https://example.invalid/image'), b(2, Buffer.from([0, 255])), n(6, 123), b(10, n(2, 18446744073709551614n))]);
    const file = join([n(1, 2), n(2, 18446744073709551614n), s(4, 'synthetic-file'), b(7, Buffer.from([1, 2]))]);
    const summaries = [b(1, join([s(1, ' A\n中文 '), n(2, 1)])),
        b(2, join([s(1, 'https://example.invalid/'), s(2, 'Link'), b(5, picture), n(6, 3)])),
        b(3, join([b(1, picture), s(2, 'Gallery')])), b(4, join([n(1, 4), s(2, 'Audio'), s(3, 'metadata')])),
        b(5, join([s(1, 'Video'), n(20, 20), b(21, picture), b(31, file)])), b(6, join([b(1, file), b(2, file)])),
        b(7, join([s(1, 'Location'), double(2, 31.25), double(3, -97.5), double(4, 3.5)])),
        b(8, join([s(1, 'Rich title'), s(3, 'Rich\nbrief'), b(4, picture), n(8, 9)]))];
    const result = decode(wire.page([rawItem(summaries, [n(12, 18446744073709551614n)])])).items[0];
    assert.equal(result.sequence, '18446744073709551614');
    const summary = result.summary;
    assert.deepEqual(summary.textSummary, { text: ' A\n中文 ', truncated: true });
    assert.equal(summary.linkSummary.title, 'Link'); assert.equal(summary.linkSummary.picList[0].field2, 'AP8=');
    assert.equal(summary.gallerySummary.picList[0].author.numId, '18446744073709551614');
    assert.equal(summary.audioSummary.field2, 'Audio'); assert.equal(summary.videoSummary.file.field2, '18446744073709551614');
    assert.equal(summary.fileSummary.second.field7, 'AQI=');
    assert.equal(summary.locationSummary.latitude, 31.25); assert.equal(summary.locationSummary.longitude, -97.5);
    assert.equal(summary.richMediaSummary.brief, 'Rich\nbrief'); assert.equal(summary.richMediaSummary.richMediaVersion, 9);
});

test('malformed fields, duplicate identities and stalled timestamps fail before publication', () => {
    invalid(wire.page([{}, {}]));
    assert.throws(() => decode(wire.page([{ cid: 'a' }, { cid: 'b' }]), { count: 1 }), { code: 'INVALID_RESPONSE' });
    invalid(wire.page([rawItem([], [n(11, 1)])])); invalid(wire.page([rawItem([], [n(2, 4294967296n)])]));
    invalid(wire.page([rawItem([b(1, b(1, Buffer.from([0xc3, 0x28])))])]));
    invalid(wire.page([rawItem([b(1, s(1, 'invalid\0text'))])]));
    invalid(wire.page([rawItem([b(1, s(1, 'x'.repeat(65537)))])]));
    for (const item of [Buffer.alloc(0), join([s(1, 'id'), n(11, 900)]), join([s(1, 'id'), b(4, Buffer.alloc(0)), n(11, 0)])]) invalid(wire.page([item]));
    assert.throws(() => decode(wire.page([{ modifyTime: '1000' }], { reachedBottom: 0 }), { timeStamp: '1000' }), { code: 'INVALID_RESPONSE' });
    assert.throws(() => decode(wire.page([{ modifyTime: '1001' }]), { timeStamp: '1000' }), { code: 'INVALID_RESPONSE' });
    invalid(wire.envelope(head(), operation(join([Buffer.from([0]), n(3, 1)]))));
    invalid(wire.envelope(head(), operation(Buffer.from([0x0a, 0x05, 0x01]))));
    const nan = Buffer.alloc(8); nan.writeDoubleLE(NaN);
    invalid(wire.page([rawItem([b(7, join([Buffer.from([17]), nan]))])]));
});

test('response field count and escaped JSON bytes are bounded independently of transport bytes', () => {
    const many = wire.envelope(join([head(), ...Array.from({ length: 50000 }, () => n(999, 0))]), operation(n(3, 1)));
    assert.ok(many.length < protocol.MAX_RESPONSE_BYTES); invalid(many);
    const values = Array.from({ length: 10 }, (_, index) => wire.item({ cid: 'cid-' + index, text: '\\'.repeat(60000) }));
    const expanded = wire.page(values);
    assert.ok(expanded.length < protocol.MAX_RESPONSE_BYTES); invalid(expanded);
});
