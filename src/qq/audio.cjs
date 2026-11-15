'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { readLocal, inside } = require('./media.cjs');

const SAMPLE_RATE = 24000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_PCM_BYTES = 32 * 1024 * 1024;
const MAX_ENCODED_BYTES = 20 * 1024 * 1024;
const MAX_DURATION_MS = 600000;
const CODEC_WORKER = 'freshwater-audio-v1';
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function pcmInfo(bytes, maxDurationMs = MAX_DURATION_MS, maxPcmBytes = MAX_PCM_BYTES) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length % 2 || bytes.length > maxPcmBytes) throw failure('INVALID_RESPONSE', 'Decoded audio is empty, malformed or exceeds its PCM limit');
    const samples = bytes.length / 2, durationMs = samples * 1000 / SAMPLE_RATE;
    if (durationMs < 20 || durationMs > maxDurationMs) throw failure('UNSUPPORTED', 'Audio duration is outside the supported 20ms to 600s range');
    const waveAmplitudes = [];
    for (let part = 0; part < 32; part++) {
        const start = Math.floor(part * samples / 32), end = Math.floor((part + 1) * samples / 32);
        let sum = 0;
        for (let index = start; index < end; index++) { const value = bytes.readInt16LE(index * 2); sum += value * value; }
        waveAmplitudes.push(end > start ? Math.max(0, Math.min(100, Math.round(Math.sqrt(sum / (end - start)) / 32768 * 100))) : 0);
    }
    return { sampleRate: SAMPLE_RATE, samples, durationMs, durationSeconds: durationMs / 1000, waveAmplitudes };
}
function silkFraming(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 13 || bytes.length > MAX_ENCODED_BYTES || !bytes.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) {
        throw failure('INVALID_RESPONSE', 'Audio must use the QQ SILK V3 container');
    }
    let cursor = 10, frames = 0;
    while (cursor < bytes.length) {
        if (cursor + 2 > bytes.length) throw failure('INVALID_RESPONSE', 'SILK frame length is truncated');
        const size = bytes.readUInt16LE(cursor); cursor += 2;
        if (!size || size === 65535 || cursor + size > bytes.length) throw failure('INVALID_RESPONSE', 'SILK frame payload is malformed');
        cursor += size; frames++;
        if (frames > 30000) throw failure('UNSUPPORTED', 'SILK frame count exceeds the audio limit');
    }
    if (!frames) throw failure('INVALID_RESPONSE', 'SILK audio contains no frames');
    return frames;
}
function inputFormat(bytes) {
    if (bytes.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) return 'silk';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    if (bytes.length >= 3 && bytes.toString('ascii', 0, 3) === 'ID3' || bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
    throw failure('UNSUPPORTED', 'Only MP3, WAV and QQ SILK audio inputs are supported');
}
function active(context) {
    if (context.signal?.aborted) throw failure('EXPIRED', 'Audio processing was cancelled');
    if (Date.now() >= context.expiresAt) throw failure('EXPIRED', 'Audio processing deadline expired');
}
function codec(bytes, format, context, limits) {
    active(context);
    return new Promise((resolve, reject) => {
        let settled = false, timer;
        const worker = new Worker(__filename, { workerData: { kind: CODEC_WORKER, bytes, format, ...limits },
            resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
            void worker.terminate();
            if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(failure('EXPIRED', 'Audio processing was cancelled'));
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) return abort();
        timer = setTimeout(() => finish(failure('EXPIRED', 'Audio codec deadline expired')), Math.max(1, context.expiresAt - Date.now()));
        worker.once('message', result => {
            try { active(context); } catch (error) { finish(error); return; }
            if (!result?.ok) return finish(failure(result?.code || 'INVALID_RESPONSE', result?.message || 'Audio codec could not complete'));
            finish(null, { ...result.info, bytes: Buffer.from(result.bytes) });
        });
        worker.once('error', () => finish(failure('INVALID_RESPONSE', 'Audio codec worker failed')));
        worker.once('exit', () => { if (!settled) finish(failure('INVALID_RESPONSE', 'Audio codec exited without a result')); });
    });
}

function createAudioProcessor({ root, mediaDirectory, ffmpegPath = process.env.FWD_FFMPEG_PATH,
    maxDurationMs = MAX_DURATION_MS, maxInputBytes = MAX_INPUT_BYTES, maxPcmBytes = MAX_PCM_BYTES } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw failure('INVALID_CONFIG', 'Audio processing requires an absolute workspace');
    root = fs.realpathSync(root);
    for (const [value, maximum] of [[maxDurationMs, MAX_DURATION_MS], [maxInputBytes, MAX_INPUT_BYTES], [maxPcmBytes, MAX_PCM_BYTES]]) {
        if (!Number.isInteger(value) || value < 1 || value > maximum) throw failure('INVALID_CONFIG', 'Invalid bounded audio limit');
    }
    const executable = ffmpegPath || path.join(root, 'work/tools/ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    function tool() {
        if (typeof executable !== 'string' || !path.isAbsolute(executable) || !inside(root, path.resolve(executable))) throw failure('INVALID_CONFIG', 'FFmpeg must be configured inside this workspace');
        let info;
        try { info = fs.lstatSync(executable); } catch { throw failure('UNSUPPORTED', 'The workspace FFmpeg executable is unavailable'); }
        if (!info.isFile() || info.nlink !== 1 || fs.realpathSync(executable) !== path.resolve(executable)) throw failure('INVALID_CONFIG', 'FFmpeg must be a regular workspace executable without links');
        return executable;
    }
    function directory(target) {
        if (!inside(root, target)) throw failure('INVALID_CONFIG', 'Audio staging escapes the workspace');
        let current = root;
        for (const part of path.relative(root, target).split(path.sep)) {
            current = path.join(current, part);
            if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
            if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== current) throw failure('INVALID_CONFIG', 'Audio staging directories cannot contain links');
        }
        return target;
    }
    async function decode(bytes, format, context) {
        const ffmpeg = tool(), temporary = directory(path.join(root, 'work/temp'));
        const cache = directory(path.join(root, 'work/cache/ffmpeg'));
        const area = fs.mkdtempSync(path.join(temporary, 'audio-'));
        if (process.platform !== 'win32') fs.chmodSync(area, 0o700);
        const input = path.join(area, 'input.' + format);
        fs.writeFileSync(input, bytes, { flag: 'wx', mode: 0o600 });
        try {
            return await new Promise((resolve, reject) => {
                active(context);
                let child, timer, stopped;
                const stop = error => { stopped = error; if (child) child.kill('SIGKILL'); };
                const abort = () => stop(failure('EXPIRED', 'Audio decoding was cancelled'));
                context.signal?.addEventListener('abort', abort, { once: true });
                if (context.signal?.aborted) { context.signal.removeEventListener('abort', abort); reject(failure('EXPIRED', 'Audio decoding was cancelled')); return; }
                timer = setTimeout(() => stop(failure('EXPIRED', 'Audio decoding deadline expired')), Math.max(1, context.expiresAt - Date.now()));
                child = execFile(ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input,
                    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
                { shell: false, windowsHide: true, cwd: root, encoding: 'buffer', maxBuffer: maxPcmBytes, killSignal: 'SIGKILL',
                    env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, XDG_CACHE_HOME: cache } },
                (error, stdout) => {
                    clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
                    try { active(context); } catch (expired) { stopped = expired; }
                    if (stopped) reject(stopped);
                    else if (error) reject(failure(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'UNSUPPORTED' : 'INVALID_RESPONSE', 'FFmpeg could not decode the full bounded audio input'));
                    else resolve(stdout);
                });
                if (stopped) child.kill('SIGKILL');
            });
        } finally { fs.rmSync(area, { recursive: true, force: true }); }
    }
    return {
        available() { try { tool(); require.resolve('silk-wasm'); return true; } catch { return false; } },
        async prepare(file, { signal, expiresAt = Date.now() + 60000 } = {}) {
            if (!Number.isSafeInteger(expiresAt)) throw failure('INVALID_PARAMS', 'Audio deadline must be a millisecond timestamp');
            const context = { signal, expiresAt }; active(context);
            const source = readLocal(mediaDirectory, file, maxInputBytes), format = inputFormat(source.bytes);
            let bytes = source.bytes;
            if (format === 'silk') silkFraming(bytes);
            else { bytes = await decode(bytes, format, context); pcmInfo(bytes, maxDurationMs, maxPcmBytes); }
            const result = await codec(bytes, format === 'silk' ? 'silk' : 'pcm', context, { maxDurationMs, maxPcmBytes });
            active(context); silkFraming(result.bytes);
            return { ...result, md5: crypto.createHash('md5').update(result.bytes).digest('hex'), size: result.bytes.length };
        }
    };
}

if (!isMainThread && workerData?.kind === CODEC_WORKER) {
    void (async () => {
        try {
            const silk = require('silk-wasm');
            const source = Buffer.from(workerData.bytes);
            let bytes, pcm;
            if (workerData.format === 'silk') {
                silkFraming(source); bytes = source;
                pcm = Buffer.from((await silk.decode(bytes, SAMPLE_RATE)).data);
            } else {
                pcmInfo(source, workerData.maxDurationMs, workerData.maxPcmBytes);
                bytes = Buffer.from((await silk.encode(source, SAMPLE_RATE)).data);
                silkFraming(bytes);
                // A successful encode is not enough: verify it actually decodes.
                pcm = Buffer.from((await silk.decode(bytes, SAMPLE_RATE)).data);
                if (Math.abs(pcm.length - source.length) > SAMPLE_RATE * 2 / 50) throw failure('INVALID_RESPONSE', 'Encoded audio duration differs from its source');
            }
            const info = pcmInfo(pcm, workerData.maxDurationMs, workerData.maxPcmBytes);
            parentPort.postMessage({ ok: true, bytes, info });
        } catch (error) { parentPort.postMessage({ ok: false, code: error.code || 'INVALID_RESPONSE', message: error.code ? error.message : 'SILK codec rejected this audio' }); }
    })();
}

module.exports = { createAudioProcessor, pcmInfo, silkFraming, inputFormat, SAMPLE_RATE, MAX_DURATION_MS };
