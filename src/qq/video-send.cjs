'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { execFile } = require('node:child_process');
const { readLocal, inside, videoInfo, MAX_VIDEO_BYTES } = require('./media.cjs');

const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 600000;
const MAX_DIMENSION = 4096;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, initial) => {
    let value = initial;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
});
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function unsupported() { return failure('UNSUPPORTED', 'Video requires a complete bounded H.264 MP4 with exact track metadata'); }
function pngMetadata(bytes) {
    const invalid = () => failure('INVALID_RESPONSE', 'Video decoder returned no complete bounded RGB PNG thumbnail');
    if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_THUMB_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw invalid();
    let cursor = 8, width, height, ended = false, dataEnded = false;
    const compressed = [];
    while (cursor < bytes.length) {
        if (cursor + 12 > bytes.length) throw invalid();
        const length = bytes.readUInt32BE(cursor), end = cursor + 12 + length;
        if (end > bytes.length) throw invalid();
        const type = bytes.toString('ascii', cursor + 4, cursor + 8);
        if (!/^[A-Za-z]{4}$/.test(type) || /^(acTL|fcTL|fdAT)$/.test(type)) throw invalid();
        let crc = 0xffffffff;
        for (let index = cursor + 4; index < end - 4; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
        if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) throw invalid();
        if (type === 'IHDR') {
            if (cursor !== 8 || length !== 13) throw invalid();
            width = bytes.readUInt32BE(cursor + 8); height = bytes.readUInt32BE(cursor + 12);
            if (width < 1 || height < 1 || width > 640 || height > 640 ||
                !bytes.subarray(cursor + 16, cursor + 21).equals(Buffer.from([8, 2, 0, 0, 0]))) throw invalid();
        } else if (!width) throw invalid();
        else if (type === 'IDAT') {
            if (dataEnded || length === 0) throw invalid();
            compressed.push(bytes.subarray(cursor + 8, end - 4));
        } else if (type === 'IEND') {
            if (length !== 0 || !compressed.length || end !== bytes.length) throw invalid();
            ended = true;
        } else {
            if (compressed.length) dataEnded = true;
            if (type[0] === type[0].toUpperCase()) throw invalid();
        }
        cursor = end;
    }
    if (!ended) throw invalid();
    const expected = (width * 3 + 1) * height, input = Buffer.concat(compressed);
    let decoded;
    try { decoded = inflateSync(input, { maxOutputLength: expected, info: true }); } catch { throw invalid(); }
    if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== input.length) throw invalid();
    for (let row = 0; row < height; row++) if (decoded.buffer[row * (width * 3 + 1)] > 4) throw invalid();
    return { width, height, extension: 'png' };
}
function boxes(bytes, start, end, budget) {
    const rows = [];
    while (start < end) {
        if (++budget.count > 10000 || start + 8 > end) throw unsupported();
        let size = bytes.readUInt32BE(start), header = 8;
        if (size === 1) {
            if (start + 16 > end) throw unsupported();
            const wide = bytes.readBigUInt64BE(start + 8);
            if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported();
            size = Number(wide); header = 16;
        } else if (size === 0) size = end - start;
        if (size < header || size > end - start) throw unsupported();
        rows.push({ type: bytes.toString('ascii', start + 4, start + 8), start: start + header, end: start + size });
        start += size;
    }
    if (start !== end) throw unsupported();
    return rows;
}
function only(rows, type) {
    const matches = rows.filter(row => row.type === type);
    if (matches.length !== 1) throw unsupported();
    return matches[0];
}
function full(bytes, row, minimum = 4) {
    if (row.end - row.start < minimum) throw unsupported();
    return bytes[row.start];
}
function duration(bytes, row, kind) {
    const version = full(bytes, row);
    if (![0, 1].includes(version)) throw unsupported();
    let scale, value;
    if (kind === 'track') {
        if (row.end - row.start < (version ? 96 : 84)) throw unsupported();
        value = version ? bytes.readBigUInt64BE(row.start + 28) : BigInt(bytes.readUInt32BE(row.start + 20));
    } else {
        if (row.end - row.start < (version ? 32 : 20)) throw unsupported();
        scale = bytes.readUInt32BE(row.start + (version ? 20 : 12));
        value = version ? bytes.readBigUInt64BE(row.start + 24) : BigInt(bytes.readUInt32BE(row.start + 16));
        if (!scale) throw unsupported();
    }
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER) || value === 0xffffffffn) throw unsupported();
    return { value: Number(value), scale };
}

// Read a single self-contained video track. Track time is measured in the
// movie timescale; sample-entry dimensions are the encoded frame dimensions.
// A decoder still has to produce a real frame before the source is accepted.
function mp4Metadata(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_VIDEO_BYTES || videoInfo(bytes).extension !== 'mp4') throw unsupported();
    const budget = { count: 0 }, children = row => boxes(bytes, row.start, row.end, budget);
    const top = boxes(bytes, 0, bytes.length, budget);
    if (top.some(row => ['moof', 'sidx'].includes(row.type))) throw unsupported();
    const movie = children(only(top, 'moov'));
    const movieTime = duration(bytes, only(movie, 'mvhd'), 'movie');
    const tracks = [];
    for (const track of movie.filter(row => row.type === 'trak')) {
        const parts = children(track), mdia = children(only(parts, 'mdia'));
        const handler = only(mdia, 'hdlr');
        if (full(bytes, handler, 12) !== 0) throw unsupported();
        if (bytes.toString('ascii', handler.start + 8, handler.start + 12) !== 'vide') continue;
        const header = only(parts, 'tkhd'), trackTime = duration(bytes, header, 'track');
        const mediaTime = duration(bytes, only(mdia, 'mdhd'), 'media');
        const minf = children(only(mdia, 'minf'));
        const references = children(only(minf, 'dinf')), dref = only(references, 'dref');
        if (full(bytes, dref, 8) !== 0 || bytes.readUInt32BE(dref.start + 4) !== 1) throw unsupported();
        const refs = boxes(bytes, dref.start + 8, dref.end, budget);
        if (refs.length !== 1 || refs[0].type !== 'url ' || refs[0].end - refs[0].start !== 4 ||
            bytes.readUInt32BE(refs[0].start) !== 1) throw unsupported();
        const sample = only(children(only(minf, 'stbl')), 'stsd');
        if (full(bytes, sample, 8) !== 0 || bytes.readUInt32BE(sample.start + 4) !== 1) throw unsupported();
        const entries = boxes(bytes, sample.start + 8, sample.end, budget);
        if (entries.length !== 1 || !['avc1', 'avc3'].includes(entries[0].type) || entries[0].end - entries[0].start < 78) throw unsupported();
        const entry = entries[0];
        if (bytes.readUInt16BE(entry.start + 6) !== 1) throw unsupported();
        const width = bytes.readUInt16BE(entry.start + 24), height = bytes.readUInt16BE(entry.start + 26);
        if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw unsupported();
        const codecBoxes = boxes(bytes, entry.start + 78, entry.end, budget), avcc = only(codecBoxes, 'avcC');
        if (avcc.end - avcc.start < 7 || bytes[avcc.start] !== 1) throw unsupported();
        const durationSeconds = trackTime.value / movieTime.scale;
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds * 1000 > MAX_DURATION_MS ||
            mediaTime.value / mediaTime.scale < durationSeconds - 1) throw unsupported();
        tracks.push({ width, height, durationSeconds, durationMs: durationSeconds * 1000, fileFormat: 2, extension: 'mp4' });
    }
    if (tracks.length !== 1) throw unsupported();
    return tracks[0];
}
function active(context) {
    if (context.signal?.aborted || Date.now() >= context.expiresAt) throw failure('EXPIRED', 'Video preparation was cancelled or its deadline elapsed');
}
function createVideoProcessor({ root, mediaDirectory, ffmpegPath = process.env.FWD_FFMPEG_PATH } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw failure('INVALID_CONFIG', 'Video preparation needs an absolute workspace');
    root = fs.realpathSync(root);
    const executable = ffmpegPath || path.join(root, 'work/tools/ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    let preparing = false;
    function tool() {
        if (typeof executable !== 'string' || !path.isAbsolute(executable) || !inside(root, path.resolve(executable))) {
            throw failure('INVALID_CONFIG', 'FFmpeg must stay inside this workspace');
        }
        let stat;
        try { stat = fs.lstatSync(executable); } catch { throw failure('UNSUPPORTED', 'The workspace FFmpeg executable is unavailable'); }
        if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(executable) !== path.resolve(executable)) {
            throw failure('INVALID_CONFIG', 'FFmpeg must be a regular workspace file without links');
        }
        try { fs.accessSync(executable, fs.constants.X_OK); } catch { throw failure('UNSUPPORTED', 'The workspace FFmpeg tool is not executable'); }
        return executable;
    }
    function directory(target) {
        if (!inside(root, target)) throw failure('INVALID_CONFIG', 'Video staging escapes this workspace');
        let current = root;
        for (const part of path.relative(root, target).split(path.sep)) {
            current = path.join(current, part);
            if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
            if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current) throw failure('INVALID_CONFIG', 'Video staging cannot contain links');
        }
        return target;
    }
    async function thumbnail(bytes, context) {
        const ffmpeg = tool(), temporary = directory(path.join(root, 'work/temp')), cache = directory(path.join(root, 'work/cache/ffmpeg'));
        const area = fs.mkdtempSync(path.join(temporary, 'video-'));
        if (process.platform !== 'win32') fs.chmodSync(area, 0o700);
        const input = path.join(area, 'input.mp4');
        fs.writeFileSync(input, bytes, { flag: 'wx', mode: 0o600 });
        try {
            return await new Promise((resolve, reject) => {
                active(context);
                let child, timer, grace, stopped, settled = false;
                const finish = (error, result) => {
                    if (settled) return;
                    settled = true; clearTimeout(timer); clearTimeout(grace);
                    context.signal?.removeEventListener('abort', abort);
                    if (error) reject(error); else resolve(result);
                };
                const stop = error => {
                    if (settled || stopped) return;
                    stopped = error;
                    try { if (child) child.kill('SIGKILL'); } catch { /* The bounded grace timer still rejects the operation. */ }
                    grace = setTimeout(() => finish(stopped), 1000);
                };
                const abort = () => stop(failure('EXPIRED', 'Video thumbnail decoding was cancelled'));
                context.signal?.addEventListener('abort', abort, { once: true });
                if (context.signal?.aborted) return finish(failure('EXPIRED', 'Video thumbnail decoding was cancelled'));
                timer = setTimeout(() => stop(failure('EXPIRED', 'Video thumbnail decoding deadline elapsed')), Math.max(1, context.expiresAt - Date.now()));
                const args = ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-filter_threads', '1', '-max_alloc', '67108864',
                    '-protocol_whitelist', 'file,pipe', '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov', '-i', input,
                    '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
                    '-threads', '1', '-pix_fmt', 'rgb24', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'];
                try {
                    child = execFile(ffmpeg, args, { shell: false, windowsHide: true, cwd: root, encoding: 'buffer',
                        maxBuffer: MAX_THUMB_BYTES, killSignal: 'SIGKILL', env: { ...process.env,
                            TEMP: temporary, TMP: temporary, TMPDIR: temporary, XDG_CACHE_HOME: cache } }, (error, stdout) => {
                        try { active(context); } catch (expired) { stopped = expired; }
                        if (stopped) return finish(stopped);
                        if (error) return finish(failure(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'UNSUPPORTED' : 'INVALID_RESPONSE',
                            'FFmpeg could not produce a bounded real video thumbnail'));
                        let info;
                        try { info = pngMetadata(stdout); active(context); } catch (error) { return finish(error); }
                        finish(null, { bytes: stdout, size: stdout.length, md5: crypto.createHash('md5').update(stdout).digest('hex'),
                            width: info.width, height: info.height, extension: 'png' });
                    });
                    if (stopped) try { child.kill('SIGKILL'); } catch { /* The abort/deadline result takes precedence. */ }
                } catch { finish(failure('INVALID_RESPONSE', 'The video decoder could not start')); }
            });
        } finally { fs.rmSync(area, { recursive: true, force: true }); }
    }
    return {
        available() { try { tool(); return true; } catch { return false; } },
        async prepare(file, { signal, expiresAt = Date.now() + 60000 } = {}) {
            if (!Number.isSafeInteger(expiresAt)) throw failure('INVALID_PARAMS', 'Video deadline must be a millisecond timestamp');
            const context = { signal, expiresAt }; active(context);
            if (preparing) throw failure('BUSY', 'A video is already being prepared for this account');
            preparing = true;
            try {
                const source = readLocal(mediaDirectory, file, MAX_VIDEO_BYTES), metadata = mp4Metadata(source.bytes);
                const thumb = await thumbnail(source.bytes, context);
                active(context);
                return { ...source, ...metadata, size: source.bytes.length, thumbnail: thumb };
            } finally { preparing = false; }
        }
    };
}

module.exports = { createVideoProcessor, mp4Metadata, MAX_THUMB_BYTES, MAX_DURATION_MS, MAX_DIMENSION };
