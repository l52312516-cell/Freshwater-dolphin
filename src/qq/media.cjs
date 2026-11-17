'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_RESOURCES = 1000;
const BASE64_PREFIX = 'base64://';

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function inside(root, target) {
    const relative = path.relative(root, target);
    return Boolean(relative) && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function noLinks(filename, code = 'INVALID_RESPONSE') {
    const absolute = path.resolve(filename), parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw problem(code, 'Media paths cannot contain symbolic links');
    }
    return absolute;
}
function privateRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw problem('UNSUPPORTED', 'A private per-account media directory must be configured');
    noLinks(root, 'INVALID_CONFIG');
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' &&
        (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) throw problem('INVALID_CONFIG', 'Media directory must be private and owned by this account process');
    return fs.realpathSync(root);
}
function imageInfo(bytes) {
    let width, height, extension, picType = 1000;
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.toString('ascii', 12, 16) === 'IHDR') {
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); extension = 'png'; picType = 1001;
    } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
        width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); extension = 'gif'; picType = 2000;
    } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
        let cursor = 2;
        while (cursor + 4 <= bytes.length) {
            if (bytes[cursor++] !== 255) break;
            while (bytes[cursor] === 255) cursor++;
            const marker = bytes[cursor++];
            if (marker === 217 || marker === 218) break;
            if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
            if (cursor + 2 > bytes.length) break;
            const length = bytes.readUInt16BE(cursor);
            if (length < 2 || cursor + length > bytes.length) break;
            if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
                height = bytes.readUInt16BE(cursor + 3); width = bytes.readUInt16BE(cursor + 5); extension = 'jpg'; break;
            }
            cursor += length;
        }
    }
    if (!extension || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width > 65535 || height > 65535 || width * height > 100000000) throw problem('UNSUPPORTED', 'Only bounded PNG, JPEG and GIF images are supported');
    return { width, height, extension, picType };
}
function decodeBase64Image(input) {
    if (typeof input !== 'string' || !input.startsWith(BASE64_PREFIX)) throw problem('INVALID_PARAMS', 'Expected a base64:// image');
    const length = input.length - BASE64_PREFIX.length;
    // Check the encoded bound before slicing or decoding user-controlled data.
    if (!length || length % 4 || length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) {
        throw problem('INVALID_PARAMS', 'Base64 image is empty, malformed or exceeds 10 MiB');
    }
    const encoded = input.slice(BASE64_PREFIX.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw problem('INVALID_PARAMS', 'Base64 image must use the canonical standard alphabet without whitespace');
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const expected = length / 4 * 3 - padding;
    if (expected < 1 || expected > MAX_IMAGE_BYTES) throw problem('INVALID_PARAMS', 'Base64 image exceeds 10 MiB');
    const bytes = Buffer.from(encoded, 'base64');
    // Buffer.from accepts invalid padding bits; a canonical round-trip rejects them.
    if (bytes.length !== expected || bytes.toString('base64') !== encoded) throw problem('INVALID_PARAMS', 'Base64 image has invalid padding or encoding');
    const image = imageInfo(bytes);
    return { bytes, filename: 'image.' + image.extension, md5: crypto.createHash('md5').update(bytes).digest('hex'), ...image };
}
function readLocal(root, input, maximum = 50 * 1024 * 1024) {
    const directory = privateRoot(root);
    if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f]/.test(input)) throw problem('INVALID_PARAMS', 'Invalid media filename');
    let filename = input;
    if (input.startsWith('file:')) {
        try { filename = fileURLToPath(input); } catch { throw problem('INVALID_PARAMS', 'Invalid local media URL'); }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith('base64://')) {
        throw problem('UNSUPPORTED', 'Remote and base64 media inputs are unavailable');
    }
    const requested = path.resolve(directory, filename);
    if (!inside(directory, requested)) throw problem('INVALID_PARAMS', 'Media must remain inside this account media directory');
    noLinks(requested, 'INVALID_PARAMS');
    const actual = fs.realpathSync(requested);
    if (!inside(directory, actual)) throw problem('INVALID_PARAMS', 'Media resolves outside this account directory');
    const fd = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && info.uid !== process.getuid()) ||
            info.size < 1 || info.size > maximum) throw problem('INVALID_PARAMS', 'Media must be a nonempty owned regular file within the configured size limit');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== info.size) throw problem('INVALID_PARAMS', 'Media changed while being read');
        return { bytes, filename: path.basename(actual), md5: crypto.createHash('md5').update(bytes).digest('hex') };
    } finally { fs.closeSync(fd); }
}
function readImage(root, input) {
    if (typeof input === 'string' && input.startsWith(BASE64_PREFIX)) {
        privateRoot(root);
        return decodeBase64Image(input);
    }
    const file = readLocal(root, input, MAX_IMAGE_BYTES);
    return { ...file, ...imageInfo(file.bytes) };
}
function copyToNative(filename, roots, bytes) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !Array.isArray(roots)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid media cache path');
    const allowed = roots.filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => fs.realpathSync(noLinks(root)));
    const target = path.resolve(filename);
    const parent = path.dirname(target);
    if (!allowed.some(root => inside(root, target))) throw problem('INVALID_RESPONSE', 'QQ media cache path is outside this account data directories');
    // QQ's needCreate=true is responsible for producing its own parent tree.
    const actualParent = fs.realpathSync(parent);
    noLinks(parent);
    const actual = path.join(actualParent, path.basename(target));
    if (!allowed.some(root => inside(root, actual))) throw problem('INVALID_RESPONSE', 'QQ media cache parent escapes this account directories');
    try { if (fs.lstatSync(actual).isSymbolicLink()) throw problem('INVALID_RESPONSE', 'QQ media cache file is a symbolic link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const fd = fs.openSync(actual, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && info.uid !== process.getuid())) {
            throw problem('INVALID_RESPONSE', 'QQ media cache target is not an owned regular file');
        }
        fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return actual;
}

function verifyPrepared(filename, roots, expected) {
    const actual = fs.realpathSync(noLinks(filename, 'INVALID_PARAMS'));
    const allowed = roots.filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => fs.realpathSync(noLinks(root, 'INVALID_PARAMS')));
    if (!allowed.some(root => inside(root, actual))) throw problem('INVALID_PARAMS', 'Prepared media escapes this account cache');
    const fd = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && info.uid !== process.getuid()) ||
            info.size !== expected.size || info.size > (['file', 'video'].includes(expected.type) ? 50 : 10) * 1024 * 1024) {
            throw problem('INVALID_PARAMS', 'Prepared media changed before native upload');
        }
        const hash = crypto.createHash('md5').update(fs.readFileSync(fd)).digest('hex');
        if (hash !== expected.md5) throw problem('INVALID_PARAMS', 'Prepared media contents changed before native upload');
    } finally { fs.closeSync(fd); }
}

const IMAGE_RESOURCE = /^fwd-image-[a-f0-9]{32}$/;
const RESOURCE = /^fwd-(image|video|record)-[a-f0-9]{32}$/;
function maximum(type) {
    if (!['image', 'video', 'record'].includes(type)) throw problem('UNSUPPORTED', 'This media resource type is unsupported');
    return type === 'video' ? MAX_VIDEO_BYTES : type === 'record' ? MAX_RECORD_BYTES : MAX_IMAGE_BYTES;
}
function videoInfo(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_VIDEO_BYTES) throw problem('UNSUPPORTED', 'Video requires bounded actual container bytes');
    // Identify complete top-level ISO BMFF boxes without inventing codec,
    // dimensions or duration. A decoder remains responsible for playback.
    if (bytes.length >= 24 && bytes.toString('ascii', 4, 8) === 'ftyp') {
        const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash']);
        let cursor = 0, boxes = 0, format = false, movie = false, data = false;
        while (cursor < bytes.length && ++boxes <= 10000) {
            if (cursor + 8 > bytes.length) throw problem('UNSUPPORTED', 'Video contains an incomplete container box');
            let length = bytes.readUInt32BE(cursor), header = 8;
            const type = bytes.toString('ascii', cursor + 4, cursor + 8);
            if (length === 1) {
                if (cursor + 16 > bytes.length) throw problem('UNSUPPORTED', 'Video has an incomplete large box');
                const wide = bytes.readBigUInt64BE(cursor + 8);
                if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw problem('UNSUPPORTED', 'Video box exceeds the supported size');
                length = Number(wide); header = 16;
            } else if (length === 0) length = bytes.length - cursor;
            if (length < header || cursor + length > bytes.length) throw problem('UNSUPPORTED', 'Video has an invalid container box length');
            if (type === 'ftyp') {
                if (cursor !== 0 || length < header + 8 || (length - header) % 4) throw problem('UNSUPPORTED', 'Video has an invalid MP4 format box');
                const found = [bytes.toString('ascii', cursor + header, cursor + header + 4)];
                for (let offset = cursor + header + 8; offset + 4 <= cursor + length; offset += 4) found.push(bytes.toString('ascii', offset, offset + 4));
                format = found.some(brand => brands.has(brand));
            }
            if (type === 'moov' && length > header) movie = true;
            if (type === 'mdat' && length > header) data = true;
            cursor += length;
        }
        if (cursor !== bytes.length || !format || !movie || !data) throw problem('UNSUPPORTED', 'Video has no complete supported MP4 container');
        return { extension: 'mp4', mime: 'video/mp4' };
    }
    // WebM must advertise its DocType in the EBML header. A text occurrence
    // elsewhere in a file is not a format signature.
    if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
        const vint = (offset, id = false) => {
            if (offset >= bytes.length || bytes[offset] === 0) throw problem('UNSUPPORTED', 'Video has an invalid EBML integer');
            let width = 1, marker = 0x80;
            while (!(bytes[offset] & marker)) { width++; marker >>= 1; }
            if (width > (id ? 4 : 8) || offset + width > bytes.length) throw problem('UNSUPPORTED', 'Video has an incomplete EBML integer');
            let value = BigInt(id ? bytes[offset] : bytes[offset] & (marker - 1));
            for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
            const unknown = !id && value === (1n << BigInt(width * 7)) - 1n;
            return { width, value, unknown };
        };
        const header = vint(4), start = 4 + header.width;
        if (header.unknown || header.value > BigInt(bytes.length - start)) throw problem('UNSUPPORTED', 'Video has an incomplete EBML header');
        const end = start + Number(header.value);
        let cursor = start, docType = false, count = 0;
        while (cursor < end && ++count <= 100) {
            const id = vint(cursor, true); cursor += id.width;
            const size = vint(cursor); cursor += size.width;
            if (size.unknown || size.value > BigInt(end - cursor)) throw problem('UNSUPPORTED', 'Video has an invalid EBML header field');
            const next = cursor + Number(size.value);
            if (id.value === 0x4282n) docType = bytes.toString('ascii', cursor, next) === 'webm';
            cursor = next;
        }
        if (cursor !== end || !docType || end + 5 > bytes.length || bytes.readUInt32BE(end) !== 0x18538067) throw problem('UNSUPPORTED', 'Video is not a supported WebM container');
        const segment = vint(end + 4), content = end + 4 + segment.width;
        if (content >= bytes.length || !segment.unknown && segment.value !== BigInt(bytes.length - content)) throw problem('UNSUPPORTED', 'Video has an incomplete WebM segment');
        return { extension: 'webm', mime: 'video/webm' };
    }
    throw problem('UNSUPPORTED', 'Only bounded MP4 and WebM video containers are supported');
}
function recordInfo(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RECORD_BYTES) throw problem('UNSUPPORTED', 'Voice requires bounded actual SILK bytes');
    // QQ voice resources use either 0x02 or 0x03 before the SILK header.
    let cursor = bytes[0] === 2 || bytes[0] === 3 ? 1 : 0;
    if (bytes.toString('ascii', cursor, cursor + 9) !== '#!SILK_V3') throw problem('UNSUPPORTED', 'Only SILK V3 voice resources are supported');
    cursor += 9;
    const complete = start => {
        let position = start, packets = 0;
        while (position < bytes.length) {
            if (position + 2 > bytes.length) return false;
            const length = bytes.readInt16LE(position); position += 2;
            if (length === -1 && position === bytes.length) break;
            if (length < 1 || position + length > bytes.length) return false;
            position += length; packets++;
        }
        return packets > 0;
    };
    // Standard SDK headers may carry a newline; Tencent files may instead
    // begin with a packet whose low length byte happens to be 0x0a.
    if (!complete(cursor) && !(bytes[cursor] === 10 && complete(cursor + 1))) throw problem('UNSUPPORTED', 'Voice contains no complete bounded SILK packet stream');
    // Packet count is not a reliable duration and is deliberately not exposed.
    return { extension: 'silk', mime: 'audio/silk' };
}
function mediaInfo(type, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maximum(type)) throw problem('INVALID_RESPONSE', 'Media is empty or exceeds its resource limit');
    if (type === 'image') {
        const image = imageInfo(bytes);
        return { ...image, mime: image.extension === 'jpg' ? 'image/jpeg' : 'image/' + image.extension };
    }
    if (type !== 'video') return recordInfo(bytes);
    const container = videoInfo(bytes);
    if (container.extension === 'mp4') {
        try {
            // Optional track metadata comes only from these exact bytes. Load
            // lazily: the parser uses videoInfo, never mediaInfo, so neither
            // module initialization nor this lookup recursively parses media.
            const metadata = require('./video-send.cjs').mp4Metadata(bytes);
            return { ...container, width: metadata.width, height: metadata.height, duration: metadata.durationSeconds };
        } catch (error) {
            // Existing downloadable containers remain supported even when the
            // narrower H.264 track parser cannot establish optional metadata.
            if (error.code !== 'UNSUPPORTED') throw error;
        }
    }
    return container;
}
function readNativeMedia(type, filename, roots) {
    const limit = maximum(type);
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw problem('NOT_FOUND', 'QQ media has no downloaded local file');
    if (!Array.isArray(roots)) throw problem('INVALID_CONFIG', 'Native media roots are not configured');
    const allowed = roots.filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => fs.realpathSync(noLinks(root)));
    const requested = path.resolve(filename);
    if (!allowed.some(root => inside(root, requested))) throw problem('INVALID_RESPONSE', 'QQ downloaded media escapes its account directories');
    const actual = fs.realpathSync(noLinks(requested));
    if (!allowed.some(root => inside(root, actual))) throw problem('INVALID_RESPONSE', 'QQ downloaded media escapes its account directories');
    const fd = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && info.uid !== process.getuid()) ||
            info.size < 1 || info.size > limit) throw problem('INVALID_RESPONSE', 'QQ downloaded media must be an owned bounded regular file');
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== info.size) throw problem('INVALID_RESPONSE', 'QQ downloaded media changed while being read');
        return { bytes, type, ...mediaInfo(type, bytes), size: bytes.length,
            md5: crypto.createHash('md5').update(bytes).digest('hex'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { fs.closeSync(fd); }
}
function readNativeImage(filename, roots) { return readNativeMedia('image', filename, roots); }
function exportMedia(root, type, value) {
    const bytes = Buffer.isBuffer(value) ? value : value?.bytes;
    // Metadata supplied by the caller cannot override byte-derived type/size.
    mediaInfo(type, bytes);
    const directory = privateRoot(root);
    let files = 0, total = 0;
    for (const name of fs.readdirSync(directory)) if (RESOURCE.test(name)) {
        const info = fs.lstatSync(path.join(directory, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
            (process.platform !== 'win32' && info.uid !== process.getuid())) throw problem('INVALID_CONFIG', 'Account resource directory contains an unsafe resource');
        files++; total += info.size;
    }
    if (files >= MAX_RESOURCES || total + bytes.length > MAX_RESOURCE_BYTES) throw problem('BUSY', 'Account media cache quota reached; remove unused cached resources before importing more');
    const file = 'fwd-' + type + '-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(directory, file), bytes, { flag: 'wx', mode: 0o600 });
    return resourceInfo(directory, file);
}
function exportImage(root, image) { return exportMedia(root, 'image', image); }
function resourceInfo(root, file) {
    if (typeof file !== 'string' || !RESOURCE.test(file)) throw problem('INVALID_PARAMS', 'Expected an opaque media resource ID');
    const type = RESOURCE.exec(file)[1];
    const directory = privateRoot(root);
    const resource = readNativeMedia(type, path.join(directory, file), [directory]);
    const { bytes, ...info } = resource;
    return { ...info, file, path: path.join(directory, file), filename: file };
}

function signedImageUrl({ mediaBaseUrl, mediaSigningKeyFile, profileId }, file, now = Date.now()) {
    if (!mediaBaseUrl || !mediaSigningKeyFile || !profileId) throw problem('UNSUPPORTED', 'A signed public media URL is not configured');
    if (!RESOURCE.test(file) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileId)) throw problem('INVALID_PARAMS', 'Invalid media resource identity');
    let base;
    try { base = new URL(mediaBaseUrl); } catch { throw problem('INVALID_CONFIG', 'Invalid media base URL'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw problem('INVALID_CONFIG', 'Invalid media base URL');
    noLinks(mediaSigningKeyFile, 'INVALID_CONFIG');
    const fd = fs.openSync(mediaSigningKeyFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let secret;
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size > 128 || (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
            throw problem('INVALID_CONFIG', 'Media signing key must be a private owned file');
        }
        const text = fs.readFileSync(fd, 'utf8').trim();
        if (!/^[a-fA-F0-9]{64}$/.test(text)) throw problem('INVALID_CONFIG', 'Invalid media signing key');
        secret = Buffer.from(text, 'hex');
    } finally { fs.closeSync(fd); }
    const expires = String(Math.floor(now / 1000) + 300);
    const signature = crypto.createHmac('sha256', secret).update(profileId + '\n' + file + '\n' + expires).digest('hex');
    return mediaBaseUrl.replace(/\/$/, '') + '/' + file + '?expires=' + expires + '&signature=' + signature;
}

module.exports = { readImage, readLocal, copyToNative, verifyPrepared, imageInfo, privateRoot, inside,
    readNativeImage, readNativeMedia, exportImage, exportMedia, resourceInfo, signedImageUrl,
    signedMediaUrl: signedImageUrl, RESOURCE, IMAGE_RESOURCE, decodeBase64Image, mediaInfo, videoInfo, recordInfo,
    MAX_IMAGE_BYTES, MAX_RECORD_BYTES, MAX_VIDEO_BYTES, MAX_RESOURCE_BYTES, MAX_RESOURCES };
