'use strict';

const crypto = require('node:crypto');
const { mediaInfo, MAX_VIDEO_BYTES } = require('./media.cjs');

const OFFICIAL_HOSTS = new Set([
    'multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com',
    'gslbsv.mp.qq.com', 'video.store.qq.com'
]);
const LOCAL_ERROR = Symbol('video-download-error');
function problem(code, message) { return Object.assign(new Error(message), { code, [LOCAL_ERROR]: true }); }
function sizeValue(value) {
    if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) value = Number(value);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VIDEO_BYTES) {
        throw problem('INVALID_PARAMS', 'Video size must be an exact positive integer within 50 MiB');
    }
    return value;
}
function trustedUrl(value) {
    // Validate the actual URL. Advisory native fields cannot replace its host,
    // scheme or port, and URL-parser whitespace/backslash repairs are forbidden.
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\#\x00-\x1f\x7f]/.test(value) ||
        /^https?:\/\/[^/?#]*@/i.test(value)) return null;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && OFFICIAL_HOSTS.has(url.hostname) &&
            !url.username && !url.password && !url.port && !url.hash ? url.href : null;
    } catch { return null; }
}

async function downloadVideo({ urls, expectedSize, expectedMd5, signal, expiresAt = Date.now() + 60000,
    fetchImpl = globalThis.fetch } = {}) {
    const size = sizeValue(expectedSize);
    if (typeof expectedMd5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(expectedMd5)) {
        throw problem('INVALID_PARAMS', 'Video download requires an exact MD5 digest');
    }
    if (!Number.isSafeInteger(expiresAt) || typeof fetchImpl !== 'function' || (signal !== undefined &&
        (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
            typeof signal.removeEventListener !== 'function'))) {
        throw problem('INVALID_PARAMS', 'Invalid video download deadline, signal or transport');
    }
    if (!Array.isArray(urls)) throw problem('INVALID_RESPONSE', 'QQ returned no trusted video source');
    let url;
    for (const item of urls) {
        url = trustedUrl(item?.url);
        if (url) break;
    }
    if (!url) throw problem('INVALID_RESPONSE', 'QQ returned no trusted video source');

    const controller = new AbortController();
    let timer, reader, response, finished = false;
    const abort = () => controller.abort(problem('EXPIRED', 'Video download was cancelled'));
    const check = () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (signal?.aborted) { abort(); throw controller.signal.reason; }
        if (Date.now() >= expiresAt) {
            controller.abort(problem('TIMEOUT', 'Video download deadline expired'));
            throw controller.signal.reason;
        }
    };
    let onAbort;
    const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    // The rejection also remains observed if input was already cancelled.
    cancelled.catch(() => {});
    const schedule = () => {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) controller.abort(problem('TIMEOUT', 'Video download deadline expired'));
        else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        check(); schedule();
        const pending = Promise.resolve().then(() => {
            check();
            return fetchImpl(url, {
                redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
                headers: { Accept: 'video/mp4,video/webm,application/octet-stream' }
            });
        });
        // A custom transport may ignore cancellation and resolve late. Dispose
        // its body without waiting for an uncooperative source to finish.
        pending.then(response => {
            if (controller.signal.aborted) Promise.resolve(response?.body?.cancel?.()).catch(() => {});
        }, () => {}).catch(() => {});
        response = await Promise.race([pending, cancelled]);
        check();
        if (!response || response.status !== 200 || response.redirected ||
            (response.url && response.url !== url) || typeof response.headers?.get !== 'function') {
            throw problem('QUERY_FAILED', 'Official video source did not return a complete response');
        }
        const length = response.headers.get('content-length');
        if (length !== null && (typeof length !== 'string' || !/^[1-9]\d{0,15}$/.test(length) || Number(length) !== size)) {
            throw problem('INVALID_RESPONSE', 'Video response length disagrees with QQ metadata');
        }
        if (response.headers.get('content-range') !== null || typeof response.body?.getReader !== 'function') {
            throw problem('INVALID_RESPONSE', 'Video source returned a partial or missing stream');
        }
        reader = response.body.getReader();
        const bytes = Buffer.allocUnsafe(size), md5 = crypto.createHash('md5'), sha256 = crypto.createHash('sha256');
        let received = 0;
        for (;;) {
            check();
            const chunk = await Promise.race([reader.read(), cancelled]);
            check();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > size - received ||
                chunk.value.byteLength > MAX_VIDEO_BYTES - received) {
                throw problem('INVALID_RESPONSE', 'Video stream exceeded its declared size or byte limit');
            }
            const part = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
            part.copy(bytes, received); md5.update(part); sha256.update(part); received += part.length;
        }
        if (received !== size) throw problem('INVALID_RESPONSE', 'Video stream ended before its declared size');
        const digest = md5.digest('hex');
        if (digest !== expectedMd5.toLowerCase()) throw problem('INVALID_RESPONSE', 'Video digest disagrees with QQ metadata');
        let info;
        try { info = mediaInfo('video', bytes); }
        catch { throw problem('UNSUPPORTED', 'Video source contains no complete supported video container'); }
        check(); finished = true;
        return { bytes, type: 'video', ...info, size: bytes.length, md5: digest, sha256: sha256.digest('hex') };
    } catch (error) {
        // Fetch exceptions and cancellation reasons may include signed URLs.
        // Only errors constructed locally may leave this boundary.
        if (error?.[LOCAL_ERROR]) throw error;
        check();
        throw problem('QUERY_FAILED', 'Official video download failed');
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', onAbort);
        if (!finished && !controller.signal.aborted) controller.abort(problem('EXPIRED', 'Video download ended'));
        if (reader) {
            if (finished) { try { reader.releaseLock(); } catch {} }
            else {
                try { Promise.resolve(reader.cancel()).then(() => { try { reader.releaseLock(); } catch {} }, () => {}).catch(() => {}); }
                catch {}
            }
        } else if (!finished) {
            try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
        }
    }
}

module.exports = { downloadVideo };
