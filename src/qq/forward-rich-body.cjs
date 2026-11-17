'use strict';

// Offline MessageBody decoder for the observed text / NT ordinary-picture
// protocol. No message IDs or download keys are invented here. In particular,
// legacy picture elements are not deduplicated by hash: a compatibility pair
// cannot yet be distinguished from two intentional copies of the same image.
const p = require('./proto.cjs');
const { annotate } = require('../diagnostics.cjs');
const MAX_BYTES = 256 * 1024, MAX_ELEMENTS = 1000, MAX_TEXT_BYTES = 65536;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024, U32_MAX = 0xffffffffn;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const NT_HOSTS = new Set(['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function structure(raw, schema, required = [], repeated = []) {
    const map = p.fields(raw);
    for (const [field, entries] of map) {
        if ((!repeated.includes(field) && entries.length !== 1) || Object.hasOwn(schema, field) && entries.some(entry => entry.wire !== schema[field])) {
            fail('INVALID_RESPONSE', 'Forward rich body contains duplicate fields or invalid wire types');
        }
    }
    if (required.some(field => !map.has(field))) fail('INVALID_RESPONSE', 'Forward rich body is missing required protocol data');
    if ([...map.keys()].some(field => !Object.hasOwn(schema, field))) throw annotate(Object.assign(new Error('Forward rich body contains an unsupported protocol field'), { code: 'UNSUPPORTED' }), { reason: 'unsupported_element', phase: 'forward_decode' });
    return map;
}
const value = (map, field) => map.get(field)?.[0].value;
function integer(map, field, { minimum = 0n, maximum = U32_MAX, exact } = {}) {
    const result = value(map, field);
    if (result === undefined) return undefined;
    if (result < minimum || result > maximum) fail('INVALID_RESPONSE', 'Forward image integer exceeds its bounds');
    if (exact !== undefined && result !== exact) throw annotate(Object.assign(new Error('Forward rich body has an unsupported media discriminator'), { code: 'UNSUPPORTED' }), { reason: 'unsupported_element', phase: 'forward_decode' });
    return Number(result);
}
function string(map, field, maximum, { empty = true, controls = false } = {}) {
    const bytes = value(map, field);
    if (bytes === undefined) return undefined;
    if (bytes.length > maximum || !empty && !bytes.length) fail('INVALID_RESPONSE', 'Forward rich body string exceeds its bounds');
    let result;
    try { result = decoder.decode(bytes); }
    catch { fail('INVALID_RESPONSE', 'Forward rich body contains invalid UTF-8'); }
    if (!Buffer.from(result, 'utf8').equals(bytes) || !controls && /[\x00-\x1f\x7f]/.test(result)) {
        fail('INVALID_RESPONSE', 'Forward rich body contains an invalid protocol string');
    }
    return result;
}
function zeros(map, integers = [], bytes = []) {
    for (const field of integers) integer(map, field, { exact: 0n });
    for (const field of bytes) if (value(map, field)?.length) throw annotate(Object.assign(new Error('Forward rich body contains unsupported auxiliary media data'), { code: 'UNSUPPORTED' }), { reason: 'unsupported_element', phase: 'forward_decode' });
}
function ordinaryText(raw) {
    const map = structure(raw, { 1: 2, 2: 2, 3: 2, 4: 2, 11: 2, 12: 2 }, [1]);
    // Link, mention attributes and reserve fields have their own semantics.
    // Only their explicit empty defaults are equivalent to ordinary text.
    zeros(map, [], [2, 3, 4, 11, 12]);
    const content = string(map, 1, MAX_TEXT_BYTES, { empty: false, controls: true });
    return { elementType: 1, textElement: { content, atType: 0 } };
}
function generalFlags(raw) {
    // This exact non-content flag envelope was observed on both test accounts.
    // Other GeneralFlags (notably long-text resource locators) are not ignored.
    const outer = structure(raw, { 19: 2 }, [19]);
    // QQ omits flag 85 for the observed plain-text nodes; picture nodes set
    // it to one. Both retain the same bounded sender flag envelope below.
    const reserve = structure(value(outer, 19), { 85: 0, 109: 2 }, [109]);
    integer(reserve, 85, { exact: 1n });
    const flags = structure(value(reserve, 109), { 1: 0, 4: 2 }, [1, 4]);
    integer(flags, 1, { exact: 1n });
    if (value(flags, 4).length !== 8) fail('UNSUPPORTED', 'Forward flags do not match the observed non-content envelope');
}
function pictureReserve(raw, troop = false, summary) {
    if (troop) {
        const map = structure(raw, { 1: 0, 3: 0 });
        zeros(map, [1, 3]);
        return;
    }
    const map = structure(raw, { 1: 0, 3: 0, 4: 0, 8: 2, 10: 0, 12: 2, 18: 2, 19: 2,
        20: 2, 30: 2, 31: 2, 34: 0 });
    // Nonzero subType or other special-picture flags must never become images.
    zeros(map, [1, 3, 4, 10, 34], [12, 18, 19, 31]);
    // Real private-image resources repeat the main picture summary here.
    // Accept that proved replica only; it cannot introduce another caption.
    const reservedSummary = string(map, 8, 1024, { controls: true });
    if (reservedSummary && (summary === undefined || reservedSummary !== summary)) {
        fail('UNSUPPORTED', 'Forward image compatibility summary conflicts with its main summary');
    }
    if (map.has(20)) {
        const nested = structure(value(map, 20), { 1: 0, 2: 2, 3: 0, 4: 0, 5: 0, 7: 2 });
        zeros(nested, [1, 3, 4, 5], [2, 7]);
    }
    // The observed compatibility locator is metadata; the actual resource
    // returned to callers comes exclusively from PictureInfo below.
    string(map, 30, 4096);
}
function extension(raw) {
    const ext = structure(raw, { 1: 2, 2: 2, 3: 2, 4: 2, 10: 0 }, [1]);
    integer(ext, 10, { exact: 0n });
    const defaults = { 2: [3], 3: [11, 12], 4: [1] };
    for (const [field, fields] of Object.entries(defaults)) if (ext.has(Number(field))) {
        const map = structure(value(ext, Number(field)), Object.fromEntries(fields.map(key => [key, 2])));
        zeros(map, [], fields);
    }
    const pic = structure(value(ext, 1), { 1: 0, 2: 2, 11: 2, 12: 2, 1001: 0, 1002: 0, 1003: 0 });
    const picSubType = integer(pic, 1, { exact: 0n });
    for (const field of [1001, 1002, 1003]) integer(pic, field);
    const summary = string(pic, 2, 1024, { controls: true });
    if (pic.has(11)) pictureReserve(value(pic, 11), false, summary);
    if (pic.has(12)) pictureReserve(value(pic, 12), true);
    return { ...(picSubType === undefined ? {} : { picSubType }), ...(summary === undefined ? {} : { summary }) };
}
function pictureUrl(raw) {
    const pic = structure(raw, { 1: 2, 2: 2, 3: 2 }, [1]);
    const path = string(pic, 1, 8192, { empty: false }), domain = string(pic, 3, 255, { empty: false });
    let original;
    if (pic.has(2)) {
        const ext = structure(value(pic, 2), { 1: 2, 2: 2, 3: 2 });
        original = string(ext, 1, 4096);
        for (const field of [2, 3]) string(ext, field, 4096);
        if (original && !original.startsWith('&')) fail('UNSUPPORTED', 'Forward image original parameters do not match the observed URL protocol');
    }
    const result = path + (original === undefined ? '' : original);
    if (/[\\\x00-\x20\x7f]/.test(result)) fail('INVALID_RESPONSE', 'Forward image locator is malformed');
    let url;
    try {
        if (path.startsWith('/download?')) {
            if (!NT_HOSTS.has(domain)) fail('UNSUPPORTED', 'Forward image domain is not an official resource host');
            url = new URL(result, 'https://' + domain);
        } else url = new URL(result);
    } catch (error) {
        if (error?.code === 'UNSUPPORTED') throw error;
        fail('INVALID_RESPONSE', 'Forward image locator is malformed');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !NT_HOSTS.has(url.hostname) ||
        domain !== undefined && domain !== url.hostname || url.pathname !== '/download') {
        fail('UNSUPPORTED', 'Forward image has an unsupported resource locator');
    }
    const keys = [...url.searchParams.keys()];
    if (keys.some(key => !['appid', 'fileid', 'spec', 'rkey'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
        !['1406', '1407'].includes(url.searchParams.get('appid')) || !url.searchParams.get('fileid') ||
        url.searchParams.get('fileid').length > 4096 || [...url.searchParams.values()].some(item => /[\x00-\x20\x7f]/.test(item))) {
        fail('UNSUPPORTED', 'Forward image resource identity is incomplete or ambiguous');
    }
    // Existing native-like consumers resolve relative locators against .cn.
    // Retain an explicitly different official wire domain in the URL itself.
    return path.startsWith('/download?') && domain !== 'multimedia.nt.qq.com.cn' ? 'https://' + domain + result : result;
}
function ordinaryImage(raw) {
    const common = structure(raw, { 1: 0, 2: 2, 3: 0 }, [1, 2, 3]);
    integer(common, 1, { exact: 48n });
    if (![10, 20].includes(integer(common, 3))) throw annotate(Object.assign(new Error('Forward common element is not an ordinary picture'), { code: 'UNSUPPORTED' }), { reason: 'unsupported_element', phase: 'forward_decode' });
    const info = structure(value(common, 2), { 1: 2, 2: 2 }, [1, 2], [1]);
    if (info.get(1).length !== 1) fail('UNSUPPORTED', 'Forward picture contains multiple media bodies');
    const body = structure(value(info, 1), { 1: 2, 2: 2, 5: 0, 6: 2 }, [1, 2]);
    integer(body, 5, { exact: 1n });
    if (body.has(6)) {
        const checksum = structure(value(body, 6), { 2: 2 });
        if (checksum.has(2) && value(checksum, 2).length !== 20) fail('INVALID_RESPONSE', 'Forward picture checksum exceeds its observed bounds');
    }
    const index = structure(value(body, 1), { 1: 2, 2: 2, 3: 0, 4: 0, 5: 0, 6: 0 }, [1]);
    integer(index, 3, { exact: 1n });
    for (const field of [4, 5]) integer(index, field);
    integer(index, 6, { exact: 0n });
    const fileUuid = string(index, 2, 1024, { empty: false });
    const file = structure(value(index, 1), { 1: 0, 2: 2, 3: 2, 4: 2, 5: 2, 6: 0, 7: 0, 8: 0, 9: 0 }, [1, 2, 5, 6, 7]);
    const size = integer(file, 1, { minimum: 1n, maximum: BigInt(MAX_IMAGE_BYTES) });
    const md5 = string(file, 2, 32, { empty: false });
    if (!/^[a-fA-F0-9]{32}$/.test(md5)) fail('INVALID_RESPONSE', 'Forward image has no actual MD5 digest');
    const sha1 = string(file, 3, 40);
    if (sha1 !== undefined && !/^[a-fA-F0-9]{40}$/.test(sha1)) fail('INVALID_RESPONSE', 'Forward image SHA-1 digest is malformed');
    const fileName = string(file, 4, 1024, { empty: false });
    if (fileName !== undefined && /[\\/]/.test(fileName)) fail('INVALID_RESPONSE', 'Forward image filename contains a path');
    const type = structure(value(file, 5), { 1: 0, 2: 0, 3: 0, 4: 0 }, [1]);
    integer(type, 1, { exact: 1n });
    zeros(type, [3, 4]);
    const picType = integer(type, 2);
    const width = integer(file, 6, { minimum: 1n, maximum: 65535n });
    const height = integer(file, 7, { minimum: 1n, maximum: 65535n });
    if (width * height > 100000000) fail('INVALID_RESPONSE', 'Forward image pixel count exceeds its bound');
    integer(file, 8, { exact: 0n });
    integer(file, 9, { maximum: 1n });
    return { elementType: 2, picElement: { md5HexStr: md5.toLowerCase(), fileSize: String(size), picWidth: width,
        picHeight: height, originImageUrl: pictureUrl(value(body, 2)),
        ...(fileName === undefined ? {} : { fileName }), ...(fileUuid === undefined ? {} : { fileUuid }),
        ...(picType === undefined ? {} : { picType }), ...extension(value(info, 2)) } };
}
function decodeRichBody(raw, { mode = 'strict' } = {}) {
    if (!Buffer.isBuffer(raw) || !raw.length || raw.length > MAX_BYTES) fail('INVALID_RESPONSE', 'Forward body is absent or exceeds 256 KiB');
    const outer = structure(raw, { 1: 2 }, [1]);
    const rich = structure(value(outer, 1), { 2: 2 }, [2], [2]), entries = rich.get(2);
    if (!entries.length || entries.length > MAX_ELEMENTS) fail('INVALID_RESPONSE', 'Forward body exceeds its element budget');
    let textBytes = 0, imageBytes = 0, flags = 0;
    const elements = [];
    for (const entry of entries) {
        const elem = p.fields(entry.value);
        if (elem.size !== 1 || [...elem.values()].some(items => items.length !== 1 || items[0].wire !== 2)) fail('INVALID_RESPONSE', 'Forward element contains missing or conflicting content');
        const field = elem.keys().next().value;
        const unknown = () => ({ elementType: 0, unsupportedElement: { wireType: field } });
        if (![1, 37, 53].includes(field)) {
            if (mode !== 'compatible') fail('UNSUPPORTED', 'Forward rich body contains an unsupported protocol field');
            elements.push(unknown());
            continue;
        }
        let result;
        try {
            if (elem.has(37)) {
                if (++flags > 1) fail('INVALID_RESPONSE', 'Forward body contains repeated non-content flag elements');
                generalFlags(value(elem, 37));
                continue;
            }
            result = elem.has(1) ? ordinaryText(value(elem, 1)) : ordinaryImage(value(elem, 53));
        } catch (error) {
            // Only explicitly classified content differences can be displayed
            // as a placeholder. Corrupt locators and protocol conflicts fail.
            if (mode !== 'compatible' || error.code !== 'UNSUPPORTED' || error.diagnostic?.reason !== 'unsupported_element') throw error;
            elements.push(unknown());
            continue;
        }
        if (result.elementType === 1) textBytes += Buffer.byteLength(result.textElement.content);
        else imageBytes += Number(result.picElement.fileSize);
        if (textBytes > MAX_TEXT_BYTES || imageBytes > MAX_IMAGE_BYTES) fail('INVALID_RESPONSE', 'Forward body exceeds its aggregate content budget');
        elements.push(result);
    }
    if (!elements.length) fail('UNSUPPORTED', 'Forward body contains no supported content');
    return elements;
}

module.exports = { decodeRichBody, MAX_BYTES, MAX_ELEMENTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES };
