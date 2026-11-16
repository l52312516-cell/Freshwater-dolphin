'use strict';

const fs = require('node:fs'), fsp = fs.promises, path = require('node:path'), crypto = require('node:crypto');
const media = require('../qq/media.cjs'), network = require('./safe-download.cjs');
const { STREAMED_ACTIONS } = require('./streaming.cjs');
const ACTIONS = new Set([...STREAMED_ACTIONS, 'clean_stream_temp_file', 'download_file', 'get_file']);
const REQUIREMENTS = Object.freeze(Object.fromEntries([...ACTIONS].map(name => [name, 'streamFiles'])));
const MAX_FILE = 32 * 1024 * 1024, MAX_DISK = 128 * 1024 * 1024, MAX_CHUNK = 256 * 1024, MAX_CHUNKS = 4096;
const stores = new WeakMap();
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function integer(value, max, zero = true) {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > max || !zero && Number(value) === 0) fail('INVALID_PARAMS', 'Invalid exact stream integer'); return Number(value);
}
function text(value, maximum = 512) { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid stream text'); return value; }
function filename(value) { text(value); if (/[\\/:]/.test(value) || ['.', '..'].includes(value) || /[ .]$/.test(value)) fail('INVALID_PARAMS', 'Invalid stream display filename'); return value; }
function base64(value, max) {
    if (typeof value !== 'string' || !value.length || value.length % 4 || value.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('INVALID_PARAMS', 'Invalid bounded canonical base64');
    const bytes = Buffer.from(value, 'base64'); if (bytes.length > max || bytes.toString('base64') !== value) fail('INVALID_PARAMS', 'Invalid canonical base64'); return bytes;
}
function paramsFor(action, params) {
    const allowed = action === 'upload_file_stream' ? ['stream_id', 'chunk_data', 'chunk_index', 'total_chunks', 'file_size', 'expected_sha256', 'is_complete', 'filename', 'reset', 'verify_only', 'file_retention'] :
        action === 'download_file' ? ['url', 'base64', 'name', 'headers'] : action === 'clean_stream_temp_file' ? [] : action === 'test_download_stream' ? ['error'] :
        action === 'get_file' ? ['file', 'file_id'] : ['file', 'file_id', 'chunk_size'];
    if (!object(params) || Object.keys(params).some(key => !['self_id', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected stream/file parameters');
    const value = { ...params };
    if (action === 'upload_file_stream') {
        if (typeof value.stream_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.stream_id)) fail('INVALID_PARAMS', 'Invalid upload stream_id');
        for (const key of ['is_complete', 'reset', 'verify_only']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('INVALID_PARAMS', 'Stream flags must be booleans');
        for (const [key, max, zero] of [['chunk_index', MAX_CHUNKS - 1, true], ['total_chunks', MAX_CHUNKS, false], ['file_size', MAX_FILE, true], ['file_retention', 600000, false]]) if (value[key] !== undefined) value[key] = integer(value[key], max, zero);
        if (value.filename !== undefined) value.filename = filename(value.filename);
        if (value.expected_sha256 !== undefined && (typeof value.expected_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.expected_sha256))) fail('INVALID_PARAMS', 'Expected SHA256 must be lowercase hexadecimal');
        if ((value.chunk_data === undefined) !== (value.chunk_index === undefined)) fail('INVALID_PARAMS', 'A chunk requires both data and index');
        if (value.chunk_data !== undefined) value.bytes = base64(value.chunk_data, MAX_CHUNK);
        if ([value.reset === true, value.verify_only === true, value.is_complete === true].filter(Boolean).length > 1 || (value.reset || value.verify_only) && value.bytes) fail('INVALID_PARAMS', 'Conflicting stream operation flags');
    } else if (action === 'test_download_stream') { if (value.error !== undefined && typeof value.error !== 'boolean') fail('INVALID_PARAMS', 'error must be boolean'); }
    else if (action === 'download_file') {
        if ((value.url === undefined || value.url === '') === (value.base64 === undefined || value.base64 === '')) fail('INVALID_PARAMS', 'Exactly one URL or base64 source is required');
        if (value.url !== undefined && value.url !== '') network.parseUrl(value.url);
        if (value.base64 !== undefined && value.base64 !== '') value.bytes = base64(value.base64, MAX_FILE);
        if (value.name !== undefined) value.name = filename(value.name);
        value.headers = network.headers(value.headers);
    } else if (action !== 'clean_stream_temp_file') {
        if (value.file !== undefined && value.file_id !== undefined && value.file !== value.file_id) fail('INVALID_PARAMS', 'Conflicting file selectors');
        value.target = text(value.file === undefined ? value.file_id : value.file, 16384);
        if (value.chunk_size !== undefined) value.chunk_size = integer(value.chunk_size, MAX_CHUNK, false);
    }
    return value;
}
function storeFor(service) {
    let store = stores.get(service); if (store) return store;
    const accountRoot = media.privateRoot(service.mediaDirectory), root = path.join(accountRoot, 'fwd-streams');
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) fail('INVALID_CONFIG', 'Stream storage must be an ordinary account directory');
    store = { root, manifest: path.join(root, 'manifest.json'), files: new Map(), uploads: new Map(), pending: new Set(), bytes: 0 };
    if (fs.existsSync(store.manifest)) {
        const stat = fs.lstatSync(store.manifest);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('INVALID_CONFIG', 'Invalid stream storage manifest');
        let data; try { data = JSON.parse(fs.readFileSync(store.manifest, 'utf8')); } catch { fail('INVALID_CONFIG', 'Invalid stream storage manifest'); }
        if (data?.version !== 1 || !Array.isArray(data.files) || data.files.length > 8192) fail('INVALID_CONFIG', 'Invalid stream storage manifest');
        for (const row of data.files) {
            if (!object(row) || typeof row.id !== 'string' || !/^fwd-file-[a-f0-9]{48}$/.test(row.id) || !['chunk', 'file', 'partial'].includes(row.kind) || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > MAX_FILE || typeof row.scope !== 'string' || typeof row.name !== 'string' || !Number.isSafeInteger(row.expires)) fail('INVALID_CONFIG', 'Invalid stream storage record');
            const filename = path.join(root, row.id); if (!fs.existsSync(filename)) continue;
            const info = fs.lstatSync(filename);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== row.size) fail('INVALID_CONFIG', 'Stream storage record changed');
            store.files.set(row.id, { ...row, path: filename, active: 0 }); store.bytes += row.size;
        }
    }
    if (store.bytes > MAX_DISK) fail('BUSY', 'Stream disk budget exceeded'); stores.set(service, store); return store;
}
function save(store) {
    const value = { version: 1, files: [...store.files.values()].map(({ path, active, ...row }) => row) };
    const temp = path.join(store.root, 'manifest-new.json');
    for (const filename of [store.manifest, temp]) if (fs.existsSync(filename) && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink() || fs.lstatSync(filename).nlink !== 1)) fail('INVALID_CONFIG', 'Stream manifest path changed');
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'w' }); fs.renameSync(temp, store.manifest);
}
function reserve(store, bytes) { if (bytes < 0 || store.bytes + bytes > MAX_DISK || store.files.size >= 8192) fail('BUSY', 'Account stream disk or file budget reached'); store.bytes += bytes; }
function allocate(store, scope, name, kind = 'partial', retention = 300000) {
    const id = 'fwd-file-' + crypto.randomBytes(24).toString('hex');
    const row = { id, path: path.join(store.root, id), name, kind, size: 0, scope, expires: Date.now() + retention, active: 1 };
    const fd = fs.openSync(row.path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); fs.closeSync(fd);
    store.files.set(id, row);
    try { save(store); return row; }
    catch (error) { store.files.delete(id); const stat = fs.lstatSync(row.path); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === 0) fs.unlinkSync(row.path); throw error; }
}
function verify(row) {
    const stat = fs.lstatSync(row.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== row.size) fail('INVALID_RESPONSE', 'Account stream file changed'); return stat;
}
function remove(store, row) {
    if (row.active) return false; verify(row); fs.unlinkSync(row.path); store.files.delete(row.id); store.bytes -= row.size; return true;
}
function metadata(row) { return { file: row.path, file_id: row.id, file_name: row.name, file_size: row.size, ...(row.sha256 ? { sha256: row.sha256 } : {}) }; }
async function runStreamActions(service, state, action, params, suppliedOptions) {
    if (!ACTIONS.has(action)) fail('UNSUPPORTED', 'Unknown stream/file action');
    const input = paramsFor(action, params), options = suppliedOptions || service.streamOptions?.getStore?.() || {};
    if (state.capabilities?.streamFiles !== true || !service.mediaDirectory) fail('UNSUPPORTED', 'Account file streaming is unavailable');
    if (STREAMED_ACTIONS.has(action) && typeof options.streamSink?.send !== 'function') fail('UNSUPPORTED', 'A streaming transport sink is required');
    const store = storeFor(service), scope = JSON.stringify([String(state.self.uin), state.epoch, state.self.uid]);
    if (store.pending.size >= 4) fail('BUSY', 'Too many file operations still await completion');
    const control = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
    const total = Math.min(60000, typeof service.remaining === 'function' ? service.remaining() : 60000);
    const timer = setTimeout(() => control.abort(), total); timer.unref?.();
    const guard = async () => { if (signal.aborted) fail('EXPIRED', 'File transfer cancelled'); await service.assertSession(state); if (signal.aborted) fail('EXPIRED', 'File transfer cancelled'); };
    const send = async data => { await guard(); await options.streamSink.send(data); await guard(); };
    const task = Promise.resolve().then(async () => {
        await guard();
        // Expired files are collected lazily as well as by explicit cleanup.
        for (const [key, upload] of store.uploads) if (!upload.busy && (upload.at + 600000 <= Date.now() || !key.startsWith(scope + ':'))) {
            for (const row of upload.parts.values()) { row.active = 0; remove(store, row); }
            store.uploads.delete(key);
        }
        for (const row of store.files.values()) if (!row.active && row.expires <= Date.now()) remove(store, row);
        save(store);
        if (action === 'test_download_stream') {
            for (let i = 0; i < 10; i++) await send({ type: 'stream', data_type: 'data_chunk', data: 'Index-> ' + (i + 1) });
            if (input.error) fail('QUERY_FAILED', 'This is a test error');
            return { type: 'response', data_type: 'data_complete', data: 'Stream transmission complete' };
        }
        if (action === 'clean_stream_temp_file') {
            let removed = 0, freed = 0, skipped = 0;
            for (const row of store.files.values()) { if (row.active) { skipped++; continue; } const size = row.size; if (remove(store, row)) { removed++; freed += size; } }
            save(store); return { message: 'success', removed, freed_bytes: freed, skipped_active: skipped };
        }
        if (action === 'upload_file_stream') {
            const key = scope + ':' + input.stream_id;
            let upload = store.uploads.get(key);
            const discard = () => {
                if (!upload) return;
                for (const row of upload.parts.values()) { row.active = 0; remove(store, row); }
                store.uploads.delete(key); save(store);
            };
            if (input.reset) { if (upload?.busy) fail('BUSY', 'Upload is still writing'); discard(); return { type: 'reset', stream_id: input.stream_id, status: 'reset_complete' }; }
            if (input.verify_only) { if (!upload) fail('NOT_FOUND', 'Upload stream not found'); return { type: 'stream', stream_id: input.stream_id, status: 'file_created', received_chunks: upload.parts.size, total_chunks: upload.total }; }
            if (!upload) {
                if (store.uploads.size >= 8) fail('BUSY', 'Account upload stream limit reached');
                if (!input.total_chunks) fail('INVALID_PARAMS', 'New upload requires total_chunks');
                upload = { total: input.total_chunks, name: input.filename || 'upload.bin', size: input.file_size, sha256: input.expected_sha256,
                    retention: input.file_retention === undefined ? 300000 : input.file_retention, parts: new Map(), bytes: 0, busy: false, at: Date.now() };
                store.uploads.set(key, upload);
            }
            if (upload.busy) fail('BUSY', 'Upload is still writing');
            for (const [key, field] of [['total_chunks', 'total'], ['filename', 'name'], ['file_size', 'size'], ['expected_sha256', 'sha256'], ['file_retention', 'retention']]) if (input[key] !== undefined) {
                if (upload[field] !== undefined && upload[field] !== input[key]) fail('INVALID_PARAMS', 'Upload metadata changed'); upload[field] = input[key];
            }
            upload.busy = true;
            try {
                if (input.bytes) {
                    if (input.chunk_index >= upload.total) fail('INVALID_PARAMS', 'Chunk index exceeds total_chunks');
                    const previous = upload.parts.get(input.chunk_index), sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');
                    if (previous) {
                        if (previous.sha256 !== sha256 || previous.size !== input.bytes.length) fail('INVALID_PARAMS', 'A duplicate chunk contains different bytes');
                    } else {
                        if (upload.bytes + input.bytes.length > MAX_FILE || upload.size !== undefined && upload.bytes + input.bytes.length > upload.size) fail('INVALID_PARAMS', 'Upload exceeds its file size budget');
                        reserve(store, input.bytes.length);
                        let part;
                        try {
                            part = allocate(store, scope, upload.name, 'chunk', 600000);
                            await fsp.writeFile(part.path, input.bytes, { flag: 'r+' }); part.size = input.bytes.length; part.sha256 = sha256;
                            upload.parts.set(input.chunk_index, part); upload.bytes += part.size; save(store); await guard();
                        } catch (error) { if (!part) store.bytes -= input.bytes.length; else if (!upload.parts.has(input.chunk_index)) { part.size = fs.statSync(part.path).size; part.active = 0; store.bytes -= input.bytes.length - part.size; remove(store, part); save(store); } throw error; }
                    }
                }
                upload.at = Date.now();
                if (!input.is_complete) return { type: 'stream', stream_id: input.stream_id, status: input.bytes ? 'chunk_received' : 'file_created', received_chunks: upload.parts.size, total_chunks: upload.total };
                if (upload.parts.size !== upload.total || upload.size !== undefined && upload.bytes !== upload.size) fail('INVALID_PARAMS', 'Upload is incomplete or file_size differs');
                reserve(store, upload.bytes); let final;
                try {
                    final = allocate(store, scope, upload.name, 'partial', upload.retention);
                    const handle = await fsp.open(final.path, 'r+'), hash = crypto.createHash('sha256');
                    try {
                        for (let i = 0; i < upload.total; i++) {
                            await guard(); const part = upload.parts.get(i); if (!part) fail('INVALID_PARAMS', 'Upload has a missing chunk'); verify(part);
                            const bytes = await fsp.readFile(part.path); if (crypto.createHash('sha256').update(bytes).digest('hex') !== part.sha256) fail('INVALID_RESPONSE', 'Upload chunk content changed');
                            hash.update(bytes); let offset = 0;
                            while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) fail('QUERY_FAILED', 'Upload assembly did not advance'); offset += result.bytesWritten; }
                        }
                        await handle.sync(); final.size = upload.bytes; final.sha256 = hash.digest('hex');
                    } finally { await handle.close(); }
                    if (upload.sha256 && upload.sha256 !== final.sha256) fail('INVALID_PARAMS', 'Upload SHA256 differs');
                    await guard(); final.kind = 'file'; final.active = 0; discard(); save(store);
                    return { type: 'response', stream_id: input.stream_id, status: 'file_complete', received_chunks: upload.total, total_chunks: upload.total,
                        file_path: final.path, ...metadata(final) };
                } catch (error) {
                    if (!final) store.bytes -= upload.bytes;
                    else { final.size = fs.statSync(final.path).size; final.active = 0; store.bytes -= upload.bytes - final.size; remove(store, final); save(store); }
                    throw error;
                }
            } finally { upload.busy = false; }
        }
        async function localSource(target, prefer = 'auto') {
            let row = store.files.get(target) || [...store.files.values()].find(row => row.path === target);
            if (row) {
                if (row.kind !== 'file' || row.scope !== scope || row.expires <= Date.now()) fail('NOT_FOUND', 'Account stream file is unavailable in this session');
                verify(row); row.active++;
                return { info: metadata(row), size: row.size, name: row.name, row, expectedSha256: row.sha256, iterable: fs.createReadStream(row.path, { highWaterMark: input.chunk_size || 65536, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }), release: () => { row.active--; } };
            }
            if (!media.RESOURCE.test(target)) fail('NOT_FOUND', 'File must be an issued account file handle or cached media ID');
            const type = media.RESOURCE.exec(target)[1];
            if (prefer !== 'auto' && type !== prefer) fail('INVALID_PARAMS', 'Cached media has another type');
            const info = media.resourceInfo(service.mediaDirectory, target), stat = fs.lstatSync(info.path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || info.size > MAX_FILE) fail('INVALID_RESPONSE', 'Invalid cached account media');
            return { info: { file: info.path, file_id: target, file_name: info.filename, file_size: info.size, size: info.size, filename: info.filename,
                ...(info.width ? { width: info.width, height: info.height } : {}) }, size: info.size, name: info.filename,
                iterable: fs.createReadStream(info.path, { highWaterMark: input.chunk_size || 65536, flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }), release() {} };
        }
        if (action === 'get_file') {
            const source = await localSource(input.target);
            try {
                if (source.expectedSha256) {
                    const hash = crypto.createHash('sha256'); let bytes = 0;
                    for await (const chunk of source.iterable) { await guard(); bytes += chunk.length; if (bytes > MAX_FILE) fail('INVALID_RESPONSE', 'Account file exceeds its byte budget'); hash.update(chunk); }
                    if (bytes !== source.size || hash.digest('hex') !== source.expectedSha256) fail('INVALID_RESPONSE', 'Account stream file content changed'); verify(source.row);
                }
                await guard(); return source.info;
            } finally { source.iterable.destroy(); source.release(); }
        }
        if (action === 'download_file') {
            const source = input.bytes ? { iterable: [input.bytes], size: input.bytes.length, filename: input.name || 'download.bin', abort() {} } :
                await network.openDownload(input.url, { signal, maximum: MAX_FILE, requestHeaders: input.headers });
            let row, reserved = 0;
            try {
                row = allocate(store, scope, input.name || 'download.bin'); const handle = await fsp.open(row.path, 'r+'), hash = crypto.createHash('sha256');
                try {
                    for await (const chunk of source.iterable) {
                        await guard(); const bytes = Buffer.from(chunk);
                        if (reserved + bytes.length > MAX_FILE) fail('INVALID_RESPONSE', 'Download exceeds the 32 MiB file limit'); reserve(store, bytes.length); reserved += bytes.length;
                        hash.update(bytes); let offset = 0;
                        while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) fail('QUERY_FAILED', 'Download write did not advance'); offset += result.bytesWritten; }
                        row.size = reserved;
                    }
                    await handle.sync();
                } finally { await handle.close(); }
                if (source.size !== null && source.size !== reserved) fail('INVALID_RESPONSE', 'Download content length differs');
                await guard(); row.sha256 = hash.digest('hex'); row.kind = 'file'; row.active = 0; save(store); return { file: row.path, file_id: row.id };
            } catch (error) {
                if (row) { row.size = fs.statSync(row.path).size; store.bytes -= reserved - row.size; row.active = 0; remove(store, row); save(store); } throw error;
            } finally { source.abort?.(); }
        }
        const prefer = action === 'download_file_image_stream' ? 'image' : action === 'download_file_record_stream' ? 'record' : 'auto';
        const external = /^https?:\/\//i.test(input.target);
        const source = external ? await network.openDownload(input.target, { signal, maximum: MAX_FILE }) : await localSource(input.target, prefer);
        let bytesRead = 0, chunks = 0, buffered = Buffer.alloc(0); const chunkSize = input.chunk_size || 65536, hash = source.expectedSha256 ? crypto.createHash('sha256') : null;
        try {
            await send({ type: 'stream', data_type: 'file_info', file_name: source.name || 'download.bin', file_size: source.size, chunk_size: chunkSize });
            async function emit(bytes) {
                await send({ type: 'stream', data_type: 'file_chunk', index: chunks++, data: bytes.toString('base64'), size: bytes.length,
                    base64_size: 4 * Math.ceil(bytes.length / 3), progress: source.size > 0 ? Math.min(100, Math.round(bytesRead / source.size * 100)) : 0 });
            }
            for await (const part of source.iterable) {
                await guard(); const bytes = Buffer.from(part); bytesRead += bytes.length; hash?.update(bytes);
                if (bytesRead > MAX_FILE) fail('INVALID_RESPONSE', 'Stream exceeds the 32 MiB download limit');
                let offset = 0;
                while (offset < bytes.length) {
                    const take = Math.min(chunkSize - buffered.length, bytes.length - offset); buffered = Buffer.concat([buffered, bytes.subarray(offset, offset + take)]); offset += take;
                    if (buffered.length === chunkSize) { await emit(buffered); buffered = Buffer.alloc(0); }
                }
            }
            if (source.size !== null && source.size !== bytesRead) fail('INVALID_RESPONSE', 'Stream content length differs');
            if (hash && hash.digest('hex') !== source.expectedSha256) fail('INVALID_RESPONSE', 'Account stream file content changed');
            if (source.row) verify(source.row);
            if (buffered.length) await emit(buffered);
            await guard(); return { type: 'response', data_type: 'file_complete', file_name: source.name || 'download.bin', total_chunks: chunks, total_bytes: bytesRead, message: 'Download completed' };
        } finally { source.iterable.destroy?.(); source.abort?.(); source.release?.(); }
    });
    store.pending.add(task);
    task.finally(() => { store.pending.delete(task); clearTimeout(timer); }).catch(() => {});
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(Object.assign(new Error('File operation cancelled'), { code: 'EXPIRED' })); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    try { return await Promise.race([task, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
}
module.exports = { ACTIONS, REQUIREMENTS, STREAMED_ACTIONS, runStreamActions, paramsFor, MAX_FILE, MAX_DISK, MAX_CHUNK, MAX_CHUNKS };
