'use strict';

// Read-only decoding of the separately observed native 9/175/175 MultiMsg
// envelope. This is not the fixed upload protocol and does not relax its schema.
// Rich media remains opaque. Callers must bind the decoded authors and metadata
// to independently observed native records before reusing a complete body.
const p = require('./proto.cjs');
const MAX_BYTES = 256 * 1024, MAX_NODES = 100;
const U32_MAX = 0xffffffffn, U64_MAX = 0xffffffffffffffffn;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function fail(message) { throw Object.assign(new Error(message), { code: 'INVALID_RESPONSE' }); }
function structure(raw, schema, repeated = []) {
    const map = p.fields(raw), required = Object.keys(schema).map(Number);
    if (map.size !== required.length || required.some(field => !map.has(field))) fail('Native forward envelope has missing or unknown fields');
    for (const [field, values] of map) {
        if ((!repeated.includes(field) && values.length !== 1) || values.some(value => value.wire !== schema[field])) {
            fail('Native forward envelope has duplicate fields or invalid wire types');
        }
    }
    return map;
}
const one = (map, field) => map.get(field)[0].value;
function integer(map, field, { minimum = 0n, maximum = U32_MAX, exact } = {}) {
    const value = one(map, field);
    if (value < minimum || value > maximum || exact !== undefined && value !== exact) fail('Native forward metadata integer is outside its observed bounds');
    return value.toString();
}
function text(map, field, maximum, nativeUid = false) {
    const bytes = one(map, field);
    if (!bytes.length || bytes.length > maximum) fail('Native forward identity or nickname exceeds its byte bounds');
    let value;
    try { value = decoder.decode(bytes); }
    catch { fail('Native forward identity or nickname has invalid UTF-8'); }
    if (!Buffer.from(value, 'utf8').equals(bytes) || (nativeUid ? !/^u_[A-Za-z0-9_-]{1,126}$/.test(value) : !value.trim() || /[\x00-\x1f\x7f]/.test(value))) {
        fail('Native forward identity or nickname is malformed');
    }
    return value;
}

function decodePayload(raw) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) fail('Native forward payload is absent or exceeds 256 KiB');
    const root = structure(raw, { 2: 2 });
    const action = structure(one(root, 2), { 1: 2, 2: 2 });
    if (!one(action, 1).equals(Buffer.from('MultiMsg'))) fail('Native forward payload must contain exactly one MultiMsg action');
    const content = structure(one(action, 2), { 1: 2 }, [1]), entries = content.get(1);
    if (!entries.length || entries.length > MAX_NODES) fail('Native forward node count is outside 1..100');
    const nodes = entries.map(entry => {
        const node = structure(entry.value, { 1: 2, 2: 2, 3: 2 });
        const head = structure(one(node, 1), { 1: 0, 2: 2, 7: 2 });
        const authorUin = integer(head, 1, { minimum: 1n });
        const authorUid = text(head, 2, 128, true);
        const forward = structure(one(head, 7), { 6: 2, 11: 0 });
        const nickname = text(forward, 6, 512);
        integer(forward, 11, { exact: 1n });
        const metadata = structure(one(node, 2), { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 11: 0, 15: 2 });
        integer(metadata, 1, { exact: 9n });
        integer(metadata, 2, { exact: 175n });
        integer(metadata, 3, { exact: 175n });
        const random = integer(metadata, 4);
        // This is the uint32 sequence actually present on the wire. It is not
        // getMultiMsg.records.msgSeq or a low32 derivation of that other value.
        const sequence = integer(metadata, 5);
        const time = integer(metadata, 6, { minimum: 1n });
        integer(metadata, 7, { exact: 1n });
        // Native msgUid is an opaque uint64: validate it without deriving a
        // random/sequence identity or exposing it as another returned property.
        integer(metadata, 11, { maximum: U64_MAX });
        const reserve = structure(one(metadata, 15), { 1: 0, 2: 0, 3: 0, 4: 2, 5: 2 });
        integer(reserve, 1, { exact: 0n });
        integer(reserve, 2, { exact: 0n });
        integer(reserve, 3, { exact: 2n });
        if (one(reserve, 4).length !== 44 || one(reserve, 5).length < 1 || one(reserve, 5).length > 4096) {
            fail('Native forward reserve does not match its observed signature bounds');
        }
        const body = one(node, 3), rich = one(structure(body, { 1: 2 }), 1);
        if (!rich.length) fail('Native forward node has no rich message body');
        // Check the rich envelope's wire syntax, retaining its complete native
        // sub-protocol bytes instead of interpreting or flattening image fields.
        p.fields(rich);
        return { authorUin, authorUid, nickname, random, sequence, time, body: Buffer.from(body) };
    });
    return { nodes };
}

module.exports = { decodePayload, MAX_BYTES, MAX_NODES };
