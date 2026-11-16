'use strict';

// QQ download-rkey protocol. The verified native MSF route uses a complete
// OidbBase envelope and the TrpcTcp command. The older JS SSO route uses the
// bare request and can return an empty stub on this QQ build; both responses
// must pass the same envelope and business-result checks.

const COMMAND = 0x9067;
const SUBCOMMAND = 202;
const CMD = `OidbSvc.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
// Native MSF channel uses the TrpcTcp prefix and a full OidbBase envelope body
// (verbatim real-device capture, LLBot build9067202). Verified errorCode 0.
const NATIVE_CMD = `OidbSvcTrpcTcp.0x${COMMAND.toString(16)}_${SUBCOMMAND}`;
// NTV2 download-rkey types: 10 private (appid 1406), 20 group (appid 1407), 2 misc.
const REQUEST_TYPES = [10, 20, 2];
const MAX_ENTRIES = 128;
const MAX_RKEY_BYTES = 8192;

function problem(code, message) { return Object.assign(new Error(message), { code }); }

function varint(value) {
    const out = [];
    let rest = BigInt(value);
    do {
        const byte = Number(rest & 0x7fn);
        rest >>= 7n;
        out.push(rest > 0n ? byte | 0x80 : byte);
    } while (rest > 0n);
    return Buffer.from(out);
}
function varintField(field, value) { return Buffer.concat([varint(field << 3), varint(value)]); }
function bytesField(field, payload) { return Buffer.concat([varint((field << 3) | 2), varint(payload.length), payload]); }
function messageField(field, parts) { return bytesField(field, Buffer.concat(parts)); }
function latin1(buffer) {
    let text = '';
    for (const byte of buffer) text += String.fromCharCode(byte);
    return text;
}
function toBuffer(raw) {
    if (Buffer.isBuffer(raw)) return raw;
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (typeof raw === 'string') return Buffer.from(raw, 'latin1');
    return null;
}

function readVarint(buffer, offset) {
    let shift = 0n, value = 0n, byte;
    do {
        if (offset >= buffer.length) throw problem('INVALID_RESPONSE', 'Truncated rkey response');
        byte = buffer[offset++];
        if (shift === 63n && byte > 1) throw problem('INVALID_RESPONSE', 'Oversized rkey varint');
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if (shift > 70n) throw problem('INVALID_RESPONSE', 'Oversized rkey varint');
    } while (byte & 0x80);
    return { value, offset };
}
function fields(buffer) {
    const out = new Map();
    let i = 0;
    while (i < buffer.length) {
        const tag = readVarint(buffer, i); i = tag.offset;
        const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
        if (field === 0 || field > 0x1fffffff) throw problem('INVALID_RESPONSE', 'Invalid rkey field number');
        let entry;
        if (wire === 0) { const v = readVarint(buffer, i); i = v.offset; entry = { wire, value: v.value }; }
        else if (wire === 2) {
            const len = readVarint(buffer, i); i = len.offset;
            if (len.value > BigInt(buffer.length - i)) throw problem('INVALID_RESPONSE', 'Truncated rkey bytes');
            const end = i + Number(len.value);
            entry = { wire, value: buffer.subarray(i, end) }; i = end;
        } else if (wire === 5 || wire === 1) {
            const size = wire === 5 ? 4 : 8;
            if (i + size > buffer.length) throw problem('INVALID_RESPONSE', 'Truncated rkey fixed-width field');
            entry = { wire, value: buffer.subarray(i, i + size) }; i += size;
        }
        else throw problem('INVALID_RESPONSE', `Unsupported rkey wire ${wire}`);
        out.set(field, [...(out.get(field) || []), entry]);
    }
    return out;
}
const one = (map, field) => (map.get(field) || [])[0];
function unsigned(entry, maximum) {
    if (!entry || entry.wire !== 0) return null;
    return entry.value <= maximum ? entry.value : null;
}

// Bare NTV2RichMediaReq{1:head, 4:downloadRkey{1:repeated type}}.
function encodeRequest() {
    const head = messageField(1, [
        messageField(1, [varintField(1, 1), varintField(2, SUBCOMMAND)]),
        messageField(2, [varintField(101, 2), varintField(102, 1), varintField(200, 0)]),
        messageField(3, [varintField(1, 2)])
    ]);
    const downloadRkey = messageField(4, REQUEST_TYPES.map(type => varintField(1, type)));
    return Buffer.concat([head, downloadRkey]);
}

// Full OidbBase envelope for the native MSF channel (TrpcTcp). Matches the
// verbatim real-device capture (LLBot build9067202) that returns errorCode 0:
// head.1.1={1:6,2:202}, scene={101:2,102:1,103:0,200:0},
// downloadRkey={1:10,1:20,2:0}, OidbBase field12(isReserved)=1.
function encodeNativeRequest() {
    const head = messageField(1, [
        messageField(1, [varintField(1, 6), varintField(2, SUBCOMMAND)]),
        messageField(2, [varintField(101, 2), varintField(102, 1), varintField(103, 0), varintField(200, 0)]),
        messageField(3, [varintField(1, 2)])
    ]);
    const downloadRkey = messageField(4, [varintField(1, 10), varintField(1, 20), varintField(2, 0)]);
    const inner = Buffer.concat([head, downloadRkey]);
    return Buffer.concat([
        varintField(1, COMMAND), varintField(2, SUBCOMMAND),
        bytesField(4, inner), varintField(12, 1)
    ]);
}

function decodeEntry(buffer) {
    const info = fields(buffer);
    const rk = one(info, 1);
    if (!rk || rk.wire !== 2 || rk.value.length === 0 || rk.value.length > MAX_RKEY_BYTES) {
        throw problem('INVALID_RESPONSE', 'QQ returned an invalid download-rkey value');
    }
    let rkey;
    try { rkey = new TextDecoder('utf-8', { fatal: true }).decode(rk.value); }
    catch { throw problem('INVALID_RESPONSE', 'QQ returned non-UTF-8 download-rkey'); }
    if (/[\x00-\x20\x7f]/.test(rkey)) throw problem('INVALID_RESPONSE', 'QQ returned a control-character download-rkey');
    const type = unsigned(one(info, 5), 0xffffffffn);
    if (type === null || type === 0n) throw problem('INVALID_RESPONSE', 'QQ returned an invalid download-rkey type');
    const entry = { rkey, type: Number(type) };
    for (const [name, field, maximum] of [['rkeyTtlSec', 2, 0xffffffffffffffffn], ['storeId', 3, 0xffffffffn], ['rkeyCreateTime', 4, 0xffffffffn]]) {
        const value = unsigned(one(info, field), maximum);
        if (value === null) continue;
        entry[name] = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }
    return entry;
}

// OidbBase{1:command,2:subCommand,3:errorCode,4:body}; body=NTV2RichMediaResp{4:downloadRkey{1:repeated info}}.
function decodeResponse(buffer) {
    const envelope = fields(buffer);
    const command = unsigned(one(envelope, 1), 0xffffffffn);
    const subCommand = unsigned(one(envelope, 2), 0xffffffffn);
    if (command !== BigInt(COMMAND) || subCommand !== BigInt(SUBCOMMAND)) {
        throw problem('QUERY_FAILED', 'QQ download-rkey command mismatch (kernel returned a stub)');
    }
    const error = one(envelope, 3);
    if (error && unsigned(error, 0xffffffffn) === null) throw problem('INVALID_RESPONSE', 'Invalid download-rkey envelope result');
    const errorCode = unsigned(error, 0xffffffffn) ?? 0n;
    if (errorCode !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the download-rkey query');
    const body = one(envelope, 4);
    if (!body || body.wire !== 2 || body.value.length === 0) throw problem('QUERY_FAILED', 'QQ returned no download-rkey body');
    const contents = fields(body.value), header = one(contents, 1);
    if (header) {
        if (header.wire !== 2) throw problem('INVALID_RESPONSE', 'Invalid download-rkey business header');
        // NTV2RichMediaResp.head (field 1).retCode (field 2), per the
        // current QQApi and NTV2RichMediaResp protocol definitions.
        const result = one(fields(header.value), 2);
        if (result && (result.wire !== 0 || result.value > 0xffffffffn)) {
            throw problem('INVALID_RESPONSE', 'Invalid download-rkey business result');
        }
        if (result && result.value !== 0n) throw problem('QUERY_FAILED', 'QQ rejected the download-rkey business query');
    }
    const download = one(contents, 4);
    if (!download || download.wire !== 2) throw problem('QUERY_FAILED', 'QQ returned no download-rkey payload');
    const entries = fields(download.value).get(1) || [];
    if (!entries.length || entries.length > MAX_ENTRIES || entries.some(item => item.wire !== 2)) {
        throw problem('INVALID_RESPONSE', 'QQ returned no bounded download-rkey entries');
    }
    return entries.map(item => decodeEntry(item.value));
}

async function fetchRkeys(capture, params = {}) {
    if (!capture.session) throw problem('NOT_READY', 'QQ session is not ready');
    const service = capture.service('msg');
    if (typeof service.sendSsoCmdReqByContend !== 'function') throw problem('UNSUPPORTED', 'QQ lacks the SSO download-rkey channel');
    const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 6000, 1), 8000);
    let resolved, timer;
    try {
        resolved = await Promise.race([
            Promise.resolve(service.sendSsoCmdReqByContend(CMD, latin1(encodeRequest()))),
            new Promise((_, reject) => { timer = setTimeout(() => reject(problem('TIMEOUT', 'QQ download-rkey query timed out')), timeoutMs); })
        ]);
    } catch (error) {
        if (error.code) throw error;
        throw problem('QUERY_FAILED', 'QQ download-rkey query failed');
    } finally { clearTimeout(timer); }
    if (!resolved || typeof resolved !== 'object') throw problem('INVALID_RESPONSE', 'QQ download-rkey response is absent');
    if (resolved.result !== 0) throw problem('QUERY_FAILED', 'QQ download-rkey transport failed');
    const buffer = toBuffer(resolved.rspbuffer ?? resolved.rsp ?? resolved.data);
    if (!buffer || buffer.length === 0) throw problem('QUERY_FAILED', 'QQ returned an empty download-rkey response');
    return { rkeys: decodeResponse(buffer) };
}

module.exports = { COMMAND, SUBCOMMAND, CMD, NATIVE_CMD, REQUEST_TYPES, encodeRequest, encodeNativeRequest, decodeResponse, fetchRkeys, latin1 };
