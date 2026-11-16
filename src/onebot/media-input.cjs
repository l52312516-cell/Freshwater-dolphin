'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const media = require('../qq/media.cjs');
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const INPUT_NAME = /^fwd-input-[a-f0-9]{32}\.(mp3|wav|silk|mp4|bin)$/;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function decodeInlineMedia(input, type) {
    if (typeof input !== 'string' || !input.startsWith('base64://')) throw problem('INVALID_REQUEST', 'Expected canonical base64:// media');
    const length = input.length - 9;
    if (!length || length % 4 || length > 4 * Math.ceil(MAX_INLINE_BYTES / 3)) throw problem('INVALID_REQUEST', 'Inline media exceeds 10 MiB or has invalid encoding');
    const encoded = input.slice(9);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw problem('INVALID_REQUEST', 'Inline media must use canonical base64 without whitespace');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_INLINE_BYTES || bytes.toString('base64') !== encoded) throw problem('INVALID_REQUEST', 'Inline media has invalid padding or exceeds 10 MiB');
    let extension = 'bin';
    if (type === 'record') {
        extension = require('../qq/audio.cjs').inputFormat(bytes);
        if (extension === 'silk') media.recordInfo(bytes);
    } else if (type === 'video') {
        // Reuse the actual supported H.264 MP4 parser, never trust a suffix or
        // a claimed MIME type. The formal QQ preparer repeats its own checks.
        require('../qq/video-send.cjs').mp4Metadata(bytes); extension = 'mp4';
    } else if (type !== 'file') throw problem('UNSUPPORTED', 'Unknown inline media type');
    return { bytes, extension };
}
function stageInlineMedia(root, type, input) {
    const source = decodeInlineMedia(input, type), directory = media.privateRoot(root);
    let count = 0, total = 0;
    for (const name of fs.readdirSync(directory)) if (INPUT_NAME.test(name)) {
        const info = fs.lstatSync(path.join(directory, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== 'win32' && info.uid !== process.getuid()) throw problem('INVALID_CONFIG', 'Account media staging contains an unsafe file');
        count++; total += info.size;
    }
    if (count >= 32 || total + source.bytes.length > 100 * 1024 * 1024) throw problem('BUSY', 'Account inline media staging quota reached');
    const target = path.join(directory, 'fwd-input-' + crypto.randomBytes(16).toString('hex') + '.' + source.extension);
    fs.writeFileSync(target, source.bytes, { flag: 'wx', mode: 0o600 });
    return target;
}
module.exports = { MAX_INLINE_BYTES, decodeInlineMedia, stageInlineMedia };
