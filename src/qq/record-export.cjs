'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const media = require('./media.cjs');

const RECORD_ID = /^fwd-record-[a-f0-9]{32}$/;
const WORKER_KIND = 'freshwater-record-export-v1';
const SAMPLE_RATE = 24000, MAX_PCM_BYTES = 32 * 1024 * 1024, MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_EXPORTS = 256, MAX_EXPORT_BYTES = 200 * 1024 * 1024;
const FORMATS = Object.freeze({ mp3: ['libmp3lame', 'mp3'], flac: ['flac', 'flac'], ogg: ['libvorbis', 'ogg'] });
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function active(context) {
    if (context.signal?.aborted || Date.now() >= context.expiresAt) throw problem('EXPIRED', 'Voice export was cancelled or exceeded its deadline');
}
function wave(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
function pcmFromSilk(bytes, context) {
    active(context);
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { kind: WORKER_KIND, bytes },
            resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
        let settled = false, timer;
        const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort); void worker.terminate();
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(problem('EXPIRED', 'Voice export was cancelled'));
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) { abort(); return; }
        timer = setTimeout(() => finish(problem('EXPIRED', 'Voice decode exceeded its deadline')), Math.max(1, context.expiresAt - Date.now()));
        worker.once('message', value => {
            try {
                active(context);
                if (!value?.ok) throw problem(value?.code || 'INVALID_RESPONSE', 'SILK decoding failed');
                const pcm = Buffer.from(value.bytes);
                if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES) throw problem('INVALID_RESPONSE', 'Decoded voice exceeds its bounded PCM format');
                finish(null, pcm);
            } catch (error) { finish(error); }
        });
        worker.once('error', () => finish(problem('INVALID_RESPONSE', 'Voice decode worker failed')));
        worker.once('exit', () => { if (!settled) finish(problem('INVALID_RESPONSE', 'Voice decode worker exited without audio')); });
    });
}
function signature(bytes, format) {
    if (format === 'wav') return bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
    if (format === 'flac') return bytes.toString('ascii', 0, 4) === 'fLaC';
    if (format === 'ogg') return bytes.toString('ascii', 0, 4) === 'OggS';
    if (format === 'mp3') return bytes.toString('ascii', 0, 3) === 'ID3' || bytes.length > 1 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0;
    try { media.recordInfo(bytes); return format === 'silk'; } catch { return false; }
}

function createRecordExporter({ root, mediaDirectory, ffmpegPath = process.env.FWD_FFMPEG_PATH } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw problem('INVALID_CONFIG', 'Voice export requires an absolute project root');
    root = fs.realpathSync(root);
    const executable = ffmpegPath || path.join(root, 'work/tools/ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const pending = new Set();
    function tool() {
        if (typeof executable !== 'string' || !path.isAbsolute(executable) || !media.inside(root, executable)) throw problem('INVALID_CONFIG', 'Voice FFmpeg must be inside the project');
        const info = fs.lstatSync(executable);
        if (!info.isFile() || info.nlink !== 1 || fs.realpathSync(executable) !== executable) throw problem('INVALID_CONFIG', 'Voice FFmpeg must be a regular project executable');
        return executable;
    }
    function directory() {
        const account = media.privateRoot(mediaDirectory), target = path.join(account, 'voice-exports');
        if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
        return media.privateRoot(target);
    }
    function read(target, format) {
        if (!fs.existsSync(target)) return null;
        const info = fs.lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > MAX_OUTPUT_BYTES ||
            process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) throw problem('INVALID_RESPONSE', 'Voice export is not a private bounded regular file');
        const bytes = fs.readFileSync(target);
        if (bytes.length !== info.size || !signature(bytes, format)) throw problem('INVALID_RESPONSE', 'Voice export has no matching audio format');
        return bytes;
    }
    async function compress(pcm, format, area, context) {
        const input = path.join(area, 'source.pcm'); fs.writeFileSync(input, pcm, { flag: 'wx', mode: 0o600 });
        const [codec, container] = FORMATS[format];
        return new Promise((resolve, reject) => {
            active(context);
            let child, stopped;
            const stop = () => { stopped = true; child?.kill('SIGKILL'); };
            const timer = setTimeout(stop, Math.max(1, context.expiresAt - Date.now()));
            context.signal?.addEventListener('abort', stop, { once: true });
            try {
                if (context.signal?.aborted) throw problem('EXPIRED', 'Voice export was cancelled');
                child = execFile(tool(), ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
                    '-i', input, '-map', '0:a:0', '-vn', '-acodec', codec, '-f', container, 'pipe:1'],
                { shell: false, windowsHide: true, encoding: 'buffer', maxBuffer: MAX_OUTPUT_BYTES, cwd: root,
                    env: { ...process.env, TEMP: area, TMP: area, TMPDIR: area, XDG_CACHE_HOME: area } }, (error, stdout) => {
                    clearTimeout(timer); context.signal?.removeEventListener('abort', stop);
                    try {
                        active(context);
                        if (stopped) throw problem('EXPIRED', 'Voice export exceeded its deadline');
                        if (error) throw problem('INVALID_RESPONSE', 'FFmpeg could not export the complete voice');
                        if (!stdout.length || stdout.length > MAX_OUTPUT_BYTES || !signature(stdout, format)) throw problem('INVALID_RESPONSE', 'FFmpeg returned no complete matching audio');
                        resolve(stdout);
                    } catch (failure) { reject(failure); }
                });
                if (stopped) child.kill('SIGKILL');
            } catch (error) { clearTimeout(timer); context.signal?.removeEventListener('abort', stop); reject(error.code === 'ENOENT' ? problem('UNSUPPORTED', 'Project FFmpeg is unavailable') : error); }
        });
    }
    return {
        available() { try { media.privateRoot(mediaDirectory); require.resolve('silk-wasm'); return true; } catch { return false; } },
        formats() { let compressed = []; try { tool(); compressed = Object.keys(FORMATS); } catch {} return ['silk', 'wav', ...compressed]; },
        async export(params, { signal, expiresAt = Date.now() + 60000 } = {}) {
            if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['file', 'outFormat', 'expectedEpoch'].includes(key)) ||
                typeof params.file !== 'string' || !RECORD_ID.test(params.file) || !['silk', 'wav', ...Object.keys(FORMATS)].includes(params.outFormat)) {
                throw problem('INVALID_PARAMS', 'Voice export needs an account record handle and supported output format');
            }
            if (!Number.isSafeInteger(expiresAt)) throw problem('INVALID_PARAMS', 'Voice export deadline must be a millisecond timestamp');
            const context = { signal, expiresAt }; active(context);
            if (FORMATS[params.outFormat]) { try { tool(); } catch (error) { if (error.code === 'ENOENT') throw problem('UNSUPPORTED', 'Project FFmpeg is unavailable'); throw error; } }
            let sourceInfo;
            try { sourceInfo = media.resourceInfo(mediaDirectory, params.file); }
            catch (error) {
                if (error.code === 'ENOENT') throw problem('NOT_FOUND', 'This account has no matching observed voice resource');
                throw error;
            }
            if (sourceInfo.type !== 'record') throw problem('INVALID_PARAMS', 'Voice export only accepts account voice resources');
            const source = media.readNativeMedia('record', sourceInfo.path, [mediaDirectory]);
            const outputDirectory = directory(), name = crypto.createHash('sha256').update(source.bytes).digest('hex') + '.' + params.outFormat;
            const target = path.join(outputDirectory, name), cached = read(target, params.outFormat);
            const result = bytes => ({ file: params.file, outFormat: params.outFormat, format: params.outFormat, path: target, size: bytes.length });
            if (cached) { active(context); return result(cached); }
            if (pending.has(name) || pending.size >= 2) throw problem('BUSY', 'Account voice export is busy');
            pending.add(name);
            let area;
            try {
                let total = 0, count = 0;
                for (const filename of fs.readdirSync(outputDirectory)) if (/^[a-f0-9]{64}\.(mp3|wav|flac|ogg|silk)$/.test(filename)) {
                    const bytes = read(path.join(outputDirectory, filename), path.extname(filename).slice(1)); total += bytes.length; count++;
                }
                if (count >= MAX_EXPORTS || total + MAX_OUTPUT_BYTES > MAX_EXPORT_BYTES) throw problem('BUSY', 'Account voice export cache quota reached');
                area = fs.mkdtempSync(path.join(outputDirectory, '.pending-'));
                if (process.platform !== 'win32') fs.chmodSync(area, 0o700);
                const bytes = params.outFormat === 'silk' ? source.bytes : await pcmFromSilk(source.bytes, context).then(pcm => params.outFormat === 'wav' ? wave(pcm) : compress(pcm, params.outFormat, area, context));
                active(context);
                if (bytes.length > MAX_OUTPUT_BYTES || !signature(bytes, params.outFormat)) throw problem('INVALID_RESPONSE', 'Voice export has an invalid output container');
                const temporary = path.join(area, 'result'); fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
                active(context); fs.renameSync(temporary, target);
                return result(bytes);
            } finally { pending.delete(name); if (area) fs.rmSync(area, { recursive: true, force: true }); }
        }
    };
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
    void (async () => {
        try {
            const input = Buffer.from(workerData.bytes); media.recordInfo(input);
            const decoded = await require('silk-wasm').decode(input, SAMPLE_RATE), pcm = Buffer.from(decoded.data);
            if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES || pcm.length / (SAMPLE_RATE * 2) > 600) throw problem('UNSUPPORTED', 'Voice exceeds the ten-minute export limit');
            parentPort.postMessage({ ok: true, bytes: pcm });
        } catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'INVALID_RESPONSE' }); }
    })();
}

module.exports = { createRecordExporter, RECORD_ID, SAMPLE_RATE };
