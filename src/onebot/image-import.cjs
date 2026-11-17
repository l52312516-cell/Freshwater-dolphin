'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const media = require('../qq/media.cjs');
const network = require('./safe-download.cjs');
const pending = new WeakMap();
const dispatchPending = new WeakMap();
const DATA_TYPES = Object.freeze({ 'data:image/png;base64': 'png', 'data:image/jpeg;base64': 'jpg', 'data:image/gif;base64': 'gif' });
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function expired() { return problem('EXPIRED', 'Image import cancelled or expired'); }
function validateSource(root, input) {
    if (/^https?:\/\//i.test(input)) { network.parseUrl(input); return; }
    if (input.startsWith('base64://') || input.startsWith('data:')) return;
    if (input.length > 4096 || /[\x00-\x1f]/.test(input)) throw problem('INVALID_PARAMS', 'Invalid image filename');
    let filename = input;
    if (input.startsWith('file:')) {
        try { filename = fileURLToPath(input); } catch { throw problem('INVALID_PARAMS', 'Invalid image file URL'); }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) throw problem('INVALID_PARAMS', 'Unsupported image source');
    // Reject an obvious escape before touching the account directory. The
    // actual reader still repeats canonical path, ownership and link checks.
    if (typeof root === 'string' && path.isAbsolute(root) && !media.inside(path.resolve(root), path.resolve(root, filename))) {
        throw problem('INVALID_PARAMS', 'Image must remain inside this account media directory');
    }
}
function inlineImage(input) {
    // Bound the encoded payload before slicing it or creating a second string.
    if (input.length > 32 + 4 * Math.ceil(media.MAX_IMAGE_BYTES / 3)) throw problem('INVALID_PARAMS', 'Inline image exceeds 10 MiB');
    const comma = input.indexOf(','), metadata = comma < 0 ? '' : input.slice(0, comma);
    if (!Object.hasOwn(DATA_TYPES, metadata)) throw problem('INVALID_PARAMS', 'Image data URLs require an exact PNG, JPEG or GIF MIME type and base64 encoding');
    const image = media.decodeBase64Image('base64://' + input.slice(comma + 1));
    if (image.extension !== DATA_TYPES[metadata]) throw problem('INVALID_PARAMS', 'Image data URL MIME type differs from its bytes');
    return image;
}

async function importAccountImage(service, state, input, options = {}) {
    if (typeof input !== 'string' || !input) throw problem('INVALID_PARAMS', 'Image input must be a nonempty account handle, local file, base64 image or public HTTP(S) URL');
    const external = options.signal || service.streamOptions?.getStore?.()?.signal;
    if (external?.aborted) throw expired();
    // Existing handles stay opaque and unchanged. The QQ bridge resolves them
    // against its own account directory immediately before the native call.
    if (media.IMAGE_RESOURCE.test(input)) return input;
    validateSource(service.mediaDirectory, input);
    let active = pending.get(service);
    if (!active) { active = new Set(); pending.set(service, active); }
    if (active.size >= 4) throw problem('BUSY', 'Too many image imports still await completion');
    const total = Math.min(60000, service.remaining()), expiresAt = Date.now() + total;
    const control = new AbortController(), signal = external ? AbortSignal.any([external, control.signal]) : control.signal;
    const timer = setTimeout(() => control.abort(), total);
    const guard = async () => {
        if (signal.aborted || Date.now() >= expiresAt) throw expired();
        await service.assertSession(state);
        if (signal.aborted || Date.now() >= expiresAt) throw expired();
    };
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(expired()); signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    const task = Promise.resolve().then(async () => {
        let imported, returned = false;
        try {
            await guard(); media.privateRoot(service.mediaDirectory);
            let image;
            if (/^https?:\/\//i.test(input)) {
                // Use the existing public-network/DNS-pinning restrictions.
                // Only internal callers/tests can supply transport dependencies.
                const source = await network.openDownload(input, { signal, maximum: media.MAX_IMAGE_BYTES,
                    ...(options.lookup ? { lookup: options.lookup } : {}), ...(options.request ? { request: options.request } : {}) });
                const stop = () => source.abort?.();
                signal.addEventListener('abort', stop, { once: true });
                try {
                    const chunks = []; let size = 0;
                    await guard();
                    for await (const part of source.iterable) {
                        await guard();
                        const bytes = Buffer.from(part);
                        if (bytes.length > media.MAX_IMAGE_BYTES - size) throw problem('INVALID_PARAMS', 'Downloaded image exceeds 10 MiB');
                        size += bytes.length; chunks.push(bytes);
                    }
                    if (source.size !== null && source.size !== size) throw problem('INVALID_RESPONSE', 'Image download content length differs');
                    image = { bytes: Buffer.concat(chunks, size) };
                    media.mediaInfo('image', image.bytes);
                } finally { signal.removeEventListener('abort', stop); stop(); }
            } else image = input.startsWith('data:') ? inlineImage(input) : media.readImage(service.mediaDirectory, input);
            await guard();
            imported = media.exportImage(service.mediaDirectory, image);
            await guard(); returned = true;
            // Keep issued resources in the bounded account media cache, even
            // after a kernel ACK: it does not prove native has stopped reading.
            return imported.file;
        } finally {
            // This handle has not reached a native caller when import fails.
            // Never remove an input handle or an issued/possibly in-use image.
            if (imported && !returned) try { fs.unlinkSync(imported.path); }
            catch (error) { if (error.code !== 'ENOENT') service.log?.('image_import_cleanup_failed', { code: 'MEDIA_CLEANUP' }); }
        }
    });
    active.add(task);
    // A cancelled caller may finish before DNS or an authorization check does.
    // Keep its physical slot until that underlying work actually settles.
    task.finally(() => active.delete(task)).catch(() => {});
    try { return await Promise.race([task, aborted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

async function callAvatarAction(service, state, request) {
    if (!['self.avatar', 'group.avatar'].includes(request?.operation)) throw problem('UNSUPPORTED', 'Expected an avatar operation');
    let active = dispatchPending.get(service);
    if (!active) { active = new Set(); dispatchPending.set(service, active); }
    if (active.size >= 4) throw problem('BUSY', 'Too many avatar operations still await completion');
    const external = service.streamOptions?.getStore?.()?.signal;
    const total = Math.min(60000, service.remaining()), expiresAt = Date.now() + total;
    const control = new AbortController(), signal = external ? AbortSignal.any([external, control.signal]) : control.signal;
    const timer = setTimeout(() => control.abort(), total);
    const check = () => {
        if (signal.aborted || Date.now() >= expiresAt) throw expired();
        service.remaining();
    };
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(expired()); signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
    const task = Promise.resolve().then(async () => {
        const operation = service.operation?.getStore?.();
        if (operation) operation.stage = 'extendedAction';
        check(); await service.assertSession(state); check();
        // Avatar-only equivalent of sessionCall: its asynchronous authorization
        // checks must finish before this final cancellation/deadline guard.
        // No await may occur between that guard and the actual native dispatch.
        const result = await service.call('extendedAction', { ...request, expectedEpoch: state.epoch });
        check(); await service.assertSession(state); check();
        return result;
    });
    active.add(task);
    task.finally(() => active.delete(task)).catch(() => {});
    // Cancellation after dispatch leaves the mutation outcome unknown. The
    // caller gets an error, the issued resource remains, and nothing is retried.
    try { return await Promise.race([task, aborted]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
}

module.exports = { importAccountImage, callAvatarAction };
