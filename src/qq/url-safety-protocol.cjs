'use strict';

// Fixed 0xBCB_0 URL reputation request from LagrangeGo/MiraiGo. QQ checks the
// supplied URL; this process never visits it or follows a returned jump URL.
const p = require('./proto.cjs');
const MAX_URL_BYTES = 8192, MAX_RESPONSE_BYTES = 131072;
const QUA = 'AQQ_2013 4.6/2013 8.4.184945&NA_0/000000&ADR&null18&linux&2017&C2293D02BEE31158&7.1.2&V3';
const OPERATIONS = new Set(['url.check']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function fields(value, allowed, code = 'INVALID_PARAMS') {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
        Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key) ||
            !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(code, 'Unexpected URL safety fields');
}
function url(value, code = 'INVALID_PARAMS') {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_URL_BYTES || /[\x00-\x20\x7f]/.test(value) ||
        Buffer.from(value).toString('utf8') !== value) fail(code, 'Expected a bounded HTTP or HTTPS URL');
    let parsed; try { parsed = new URL(value); } catch { fail(code, 'Expected an absolute HTTP or HTTPS URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || !/^https?:\/\//i.test(value)) fail(code, 'Expected an absolute HTTP or HTTPS URL without credentials');
    return value;
}
function uin(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 0xffffffffn) fail('INVALID_PARAMS', 'URL safety must use the current exact QQ account');
    return value;
}
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
function prepare(operation, value) {
    if (!OPERATIONS.has(operation)) fail('UNSUPPORTED', 'Unknown fixed URL safety operation');
    fields(value, ['url', 'uin']);
    const data = { url: url(value.url), uin: uin(value.uin) };
    const request = b(10, Buffer.concat([s(1, data.url), s(4, 'mqq.group'), n(5, 2), n(9, data.uin), s(10, 'webview'),
        s(11, data.url), n(12, 0), n(14, 0), s(15, data.url), n(16, 1), s(17, QUA)]));
    return { operation, command: 0xbcb, sub: 0, data, name: 'OidbSvcTrpcTcp.0xbcb_0',
        body: Buffer.concat([n(1, 0xbcb), n(2, 0), n(3, 0), b(4, request), n(12, 0)]) };
}
function one(map, field, wire, required = false) {
    const entries = map.get(field);
    if (!entries && !required) return undefined;
    if (!entries || entries.length !== 1 || entries[0].wire !== wire) fail('INVALID_RESPONSE', 'Malformed URL safety response field');
    return entries[0].value;
}
function string(map, field, maximum, required = false) {
    const value = one(map, field, 2, required);
    if (value === undefined) return undefined;
    if (value.length > maximum) fail('INVALID_RESPONSE', 'QQ returned oversized URL safety text');
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(value); if (text.includes('\0')) throw new Error(); return text; }
    catch { fail('INVALID_RESPONSE', 'QQ returned invalid URL safety text'); }
}
function uint(map, field) {
    const value = one(map, field, 0);
    if (value !== undefined && value > 0xffffffffn) fail('INVALID_RESPONSE', 'QQ returned an oversized URL safety integer');
    return value === undefined ? undefined : Number(value);
}
function decode(bytes, prepared) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'QQ returned no bounded URL safety response');
    const envelope = p.fields(bytes);
    if (one(envelope, 1, 0, true) !== 0xbcbn || (one(envelope, 2, 0) ?? 0n) !== 0n ||
        (one(envelope, 12, 0) ?? 0n) !== 0n) fail('INVALID_RESPONSE', 'QQ returned a different URL safety operation');
    const code = uint(envelope, 3) ?? 0;
    if (code !== 0) fail('KERNEL_ERROR', 'QQ rejected URL safety lookup (code=' + code + '); it was not retried');
    const body = p.fields(one(envelope, 4, 2, true)), response = p.fields(one(body, 10, 2, true));
    const entries = response.get(1);
    if (!entries || entries.length !== 1 || entries[0].wire !== 2) fail('INVALID_RESPONSE', 'QQ omitted the exact single URL safety result');
    const entry = p.fields(entries[0].value), returned = string(entry, 1, MAX_URL_BYTES, true);
    if (returned !== prepared.data.url) fail('INVALID_RESPONSE', 'QQ checked a different URL');
    const result = uint(entry, 2), jumpResult = uint(entry, 3), jumpUrl = string(entry, 4, 32768), umrType = uint(entry, 7);
    // Mirror the documented legacy protocol: a jump field denotes danger;
    // UMR type 2 means safe. No inferred mapping from result/jumpResult.
    const level = jumpUrl !== undefined ? 3 : umrType === 2 ? 1 : 2;
    return { operation: prepared.operation, ...prepared.data, level, ...(result === undefined ? {} : { result }),
        ...(jumpResult === undefined ? {} : { jumpResult }), ...(jumpUrl === undefined ? {} : { jumpUrl }),
        ...(umrType === undefined ? {} : { umrType }) };
}
function validateNative(value, expectedUrl) {
    fields(value, ['result', 'errMsg', 'checkUrlsResult'], 'INVALID_RESPONSE');
    if (!Number.isInteger(value.result) || value.result < -0x80000000 || value.result > 0x7fffffff || Object.is(value.result, -0) ||
        typeof value.errMsg !== 'string' || Buffer.byteLength(value.errMsg) > 16384 || Buffer.from(value.errMsg).toString('utf8') !== value.errMsg) fail('INVALID_RESPONSE', 'QQ omitted its native URL safety status');
    if (value.result !== 0) fail('KERNEL_ERROR', 'QQ rejected native URL safety lookup (result=' + value.result + ')');
    if (!Array.isArray(value.checkUrlsResult) || value.checkUrlsResult.length !== 1) fail('INVALID_RESPONSE', 'QQ omitted its exact native URL result');
    const entry = value.checkUrlsResult[0]; fields(entry, ['url', 'result', 'jumpResult', 'jumpUrl'], 'INVALID_RESPONSE');
    if (entry.url !== expectedUrl || !['result', 'jumpResult'].every(key => Number.isInteger(entry[key]) && entry[key] >= -0x80000000 && entry[key] <= 0x7fffffff && !Object.is(entry[key], -0)) ||
        typeof entry.jumpUrl !== 'string' || Buffer.byteLength(entry.jumpUrl) > 32768 || Buffer.from(entry.jumpUrl).toString('utf8') !== entry.jumpUrl || entry.jumpUrl.includes('\0')) fail('INVALID_RESPONSE', 'QQ returned an invalid or unrelated native URL check');
    return { result: value.result, errMsg: value.errMsg, checkUrlsResult: [{ url: entry.url, result: entry.result, jumpResult: entry.jumpResult, jumpUrl: entry.jumpUrl }] };
}
module.exports = { OPERATIONS, prepare, decode, fields, url, uin, validateNative, MAX_URL_BYTES, MAX_RESPONSE_BYTES };
