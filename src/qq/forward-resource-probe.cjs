'use strict';

// Classification is intentionally wider than the strict custom reader. Native
// resources retain their existing 1000-node/8 MiB path without decoding rich
// bodies or authors here. A recognized custom node makes the WHOLE resource a
// strict candidate, including malformed or mixed siblings.
const p = require('./proto.cjs');
const { gunzipSync } = require('node:zlib');
const { resource } = require('./forward-upload-protocol.cjs');
const MAX_BYTES = 8 * 1024 * 1024;

function* entries(raw) {
    let offset = 0;
    while (offset < raw.length) {
        const tag = p.readVarint(raw, offset); offset = tag.offset;
        const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
        if (field < 1 || field > 0x1fffffff) throw Error('Invalid probe field');
        let value;
        if (wire === 0) {
            const parsed = p.readVarint(raw, offset); offset = parsed.offset; value = parsed.value;
        } else if (wire === 2) {
            const length = p.readVarint(raw, offset); offset = length.offset;
            if (length.value > BigInt(raw.length - offset)) throw Error('Truncated probe bytes');
            const end = offset + Number(length.value); value = raw.subarray(offset, end); offset = end;
        } else if (wire === 1 || wire === 5) {
            const end = offset + (wire === 1 ? 8 : 4);
            if (end > raw.length) throw Error('Truncated probe value');
            value = raw.subarray(offset, end); offset = end;
        } else throw Error('Invalid probe wire');
        yield { field, wire, value };
    }
}
function scan(raw, visit) {
    // Preserve positive evidence preceding a malformed field. In particular a
    // custom node followed by malformed bytes must never downgrade to native.
    const iterator = entries(raw);
    for (;;) {
        let next;
        try { next = iterator.next(); } catch { return; }
        if (next.done) return;
        visit(next.value);
    }
}
function customCandidate(raw) {
    let candidate = false;
    scan(raw, root => {
        if (root.field !== 2 || root.wire !== 2) return;
        let multiMsg = false;
        scan(root.value, action => {
            if (action.field === 1 && action.wire === 2 && action.value.equals(Buffer.from('MultiMsg'))) multiMsg = true;
        });
        if (!multiMsg) return;
        scan(root.value, action => {
            if (action.field !== 2 || action.wire !== 2) return;
            scan(action.value, item => {
                if (item.field !== 1 || item.wire !== 2) return;
                scan(item.value, node => {
                    if (node.field !== 2 || node.wire !== 2) return;
                    let type9 = false, subtype = false, subtype4 = false, malformedSubtype = false;
                    let command = false, command0 = false, malformedCommand = false;
                    scan(node.value, metadata => {
                        if (metadata.field === 1 && metadata.wire === 0 && metadata.value === 9n) type9 = true;
                        if (metadata.field === 2) {
                            subtype = true;
                            if (metadata.wire !== 0) malformedSubtype = true;
                            else if (metadata.value === 4n) subtype4 = true;
                        }
                        if (metadata.field === 3) {
                            command = true;
                            if (metadata.wire !== 0) malformedCommand = true;
                            else if (metadata.value === 0n) command0 = true;
                        }
                    });
                    // The server may omit default subtype/command fields.
                    // An explicit different command without subtype evidence
                    // belongs to an unclassified/native variant, not to 9/4.
                    if (type9 && (subtype4 || malformedSubtype || !subtype && (!command || command0 || malformedCommand))) candidate = true;
                });
            });
        });
    });
    return candidate;
}
function extractCustomPayload(raw, prepared) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) return null;
    let candidate = null;
    scan(raw, root => {
        if (root.field !== 1 || root.wire !== 2) return;
        // Bind any explicit echo before considering optional packet contents.
        scan(root.value, result => {
            if (result.field !== 3) return;
            let identity;
            try {
                if (result.wire !== 2) throw Error('Invalid echo wire');
                identity = new TextDecoder('utf-8', { fatal: true }).decode(result.value);
            } catch { throw Object.assign(new Error('Invalid resource probe identity'), { code: 'INVALID_RESPONSE' }); }
            if (resource(identity, 'INVALID_RESPONSE') !== prepared.data.resId) {
                throw Object.assign(new Error('Different resource probe identity'), { code: 'INVALID_RESPONSE' });
            }
        });
        scan(root.value, result => {
            if (result.field !== 4 || result.wire !== 2 || !result.value.length || result.value.length > MAX_BYTES) return;
            let payload;
            try { payload = gunzipSync(result.value, { maxOutputLength: MAX_BYTES }); }
            catch { return; }
            if (customCandidate(payload)) candidate = payload;
        });
    });
    return candidate;
}

module.exports = { extractCustomPayload, MAX_BYTES };
