'use strict';
// Independent test wire oracle using the reference's fixed field numbers.
const p = require('../../src/qq/proto.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value));
function item(value = {}) {
    return Buffer.concat([s(1, value.cid || 'cid-1'), n(2, 8), n(3, 1),
        b(4, Buffer.concat([n(1, 1), n(2, 11111), s(3, 'Author'), s(6, 'u_author')])),
        n(5, 1), n(8, value.category ?? 2), n(9, 1800000000000n), n(10, 1800000000000n),
        n(11, value.modifyTime || '1800000000000'), n(12, 18446744073709551614n),
        b(15, b(1, Buffer.concat([s(1, value.text ?? 'Real\ntext'), n(2, 0)])))]);
}
function envelope(head, body) {
    const prefix = Buffer.alloc(16); Buffer.from([0x20, 0x13, 0x03, 0x29, 0, 1]).copy(prefix);
    prefix.writeUInt32BE(16 + head.length + body.length, 6); prefix.writeUInt32BE(body.length, 10);
    return Buffer.concat([prefix, head, body]);
}
function page(values = [{}], { reachedBottom = 1, retCode = 0, listExtra = [], headExtra = [], uin = '11111', sequence = 1 } = {}) {
    const head = Buffer.concat([n(1, uin), n(2, sequence), n(3, 2), n(4, 20000), n(101, BigInt.asUintN(64, BigInt(retCode))), ...headExtra]);
    const list = Buffer.concat([...values.map(value => b(1, Buffer.isBuffer(value) ? value : item(value))), n(3, reachedBottom), ...listExtra]);
    return envelope(head, b(2, b(20000, list)));
}
function request(bytes) {
    const split = bytes.length - bytes.readUInt32BE(10), head = p.fields(bytes.subarray(16, split)), body = p.fields(bytes.subarray(split));
    const list = p.fields(p.one(p.fields(p.one(body, 1).value), 20000).value);
    return { head, list, timestamp: p.one(list, 4).value.toString(), count: Number(p.one(list, 7).value), sequence: Number(p.one(head, 2).value) };
}
module.exports = { item, envelope, page, request, n, b, s };
