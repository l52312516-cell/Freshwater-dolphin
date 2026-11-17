'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { setTimeout: delay } = require('node:timers/promises');
const protocol = require('./flash-transfer-protocol.cjs');
const media = require('./media.cjs');
const { createFlashRecovery } = require('./flash-recovery.cjs');
const { createFlashDelete } = require('./flash-delete.cjs');
const MAX_FILE_BYTES = 1024 * 1024, MAX_FILES = 8;
const OPERATIONS = Object.freeze({ list: [], detail: ['filesetId'], metadata: ['filesetId'], share: ['filesetId'],
    download: ['filesetId', 'fileIndex', 'fileName'], resolve: ['shareCode'], delete: ['filesetId'], rename: ['filesetId', 'name'],
    send: ['filesetId', 'userId', 'groupId'], create: ['files', 'name', 'thumbnail'] });
const WRITE_OPERATIONS = new Set(['create', 'delete', 'rename', 'send']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function inputFiles(value) {
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.length || rows.length > MAX_FILES) fail('INVALID_PARAMS', 'Flash upload requires 1..8 local files');
    return rows.map(row => {
        if (typeof row === 'string') row = { file: row };
        if (!protocol.object(row) || Object.keys(row).some(key => !['file', 'name'].includes(key)) || typeof row.file !== 'string' || !row.file || row.file.length > 4096 || /[\x00-\x1f]/.test(row.file)) fail('INVALID_PARAMS', 'Flash files must be local filenames or {file,name} objects');
        if (row.name !== undefined) protocol.name(row.name);
        return { file: row.file, ...(row.name === undefined ? {} : { name: row.name }) };
    });
}
function request(params) {
    if (!protocol.object(params) || !Object.hasOwn(OPERATIONS, params.operation)) fail('INVALID_PARAMS', 'Unknown flash operation');
    const op = params.operation;
    if (Object.keys(params).some(key => !['operation', 'expectedEpoch', ...OPERATIONS[op]].includes(key))) fail('INVALID_PARAMS', 'Unexpected flash fields');
    const result = { operation: op };
    if (OPERATIONS[op].includes('filesetId')) result.filesetId = protocol.uuid(params.filesetId);
    if (op === 'resolve') result.url = protocol.shareUrl(params.shareCode);
    if (op === 'rename') result.name = protocol.name(params.name);
    if (op === 'download') {
        result.fileIndex = Number(protocol.integer(params.fileIndex === undefined ? 1 : params.fileIndex, 1000n, true));
        if (params.fileName !== undefined) result.fileName = protocol.name(params.fileName);
    }
    if (op === 'send') {
        if ((params.userId === undefined) === (params.groupId === undefined)) fail('INVALID_PARAMS', 'Exactly one flash recipient is required');
        if (params.userId !== undefined) result.userId = String(protocol.integer(params.userId, 0xffffffffn, true));
        else result.groupId = String(protocol.integer(params.groupId, 0xffffffffn, true));
    }
    if (op === 'create') {
        result.files = inputFiles(params.files);
        if (params.name !== undefined) result.name = protocol.name(params.name);
        if (params.thumbnail !== undefined) {
            if (typeof params.thumbnail !== 'string' || !params.thumbnail || params.thumbnail.length > 4096) fail('INVALID_PARAMS', 'Invalid local flash thumbnail');
            result.thumbnail = params.thumbnail;
        }
    }
    return result;
}
function fileType(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const groups = { 26: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], 1: ['mp3', 'aac', 'flac', 'wav', 'ogg', 'm4a'],
        2: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv'], 3: ['doc', 'docx'], 4: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
        5: ['apk'], 6: ['xls', 'xlsx'], 7: ['ppt', 'pptx'], 8: ['html', 'htm'], 9: ['pdf'], 10: ['txt'], 12: ['psd'],
        15: ['obj', 'fbx', 'blend', 'stl'], 16: ['ttf', 'otf', 'woff', 'woff2'], 17: ['ipa'], 18: ['key'], 19: ['note'], 20: ['numbers'], 21: ['pages'], 22: ['sketch'], 23: ['dmg'], 24: ['pkg'], 27: ['exe'] };
    return { typeCode: ext === 'zip' ? 6 : groups[4].includes(ext) ? 2 : 7,
        formatCode: Number(Object.entries(groups).find(([, extensions]) => extensions.includes(ext))?.[0] ?? 11) };
}
const CRC = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
});
function pngChunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]), out = Buffer.alloc(data.length + 8); out.writeUInt32BE(bytes.length); data.copy(out, 4);
    let crc = 0xffffffff; for (const byte of data) crc = CRC[(crc ^ byte) & 255] ^ crc >>> 8;
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function thumbnail() {
    const width = 526, height = 360, color = crypto.randomBytes(3), raw = Buffer.alloc((1 + width * 3) * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) color.copy(raw, y * (1 + width * 3) + 1 + x * 3);
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
async function readBounded(response, maximum) {
    const rawLength = response.headers?.get?.('content-length');
    if (rawLength !== null && rawLength !== undefined && (!/^\d+$/.test(rawLength) || BigInt(rawLength) > BigInt(maximum))) {
        try { await response.body?.cancel(); } catch {} fail('INVALID_RESPONSE', 'Flash HTTP response exceeds its byte limit');
    }
    if (!response.body?.getReader) fail('INVALID_RESPONSE', 'Flash HTTP response has no bounded stream');
    const reader = response.body.getReader(); let length = 0; const parts = [];
    try {
        while (true) {
            const row = await reader.read(); if (row.done) break;
            if (!(row.value instanceof Uint8Array)) fail('INVALID_RESPONSE', 'Invalid flash HTTP stream');
            length += row.value.length; if (length > maximum) fail('INVALID_RESPONSE', 'Flash HTTP response exceeds its byte limit');
            parts.push(Buffer.from(row.value));
        }
        return Buffer.concat(parts);
    } catch (error) { try { await reader.cancel(); } catch {} throw error; }
    finally { reader.releaseLock(); }
}
function createFlashTransfer(capture, options = {}) {
    const native = options.native || require('./msf-native.cjs'), fetchImpl = options.fetch || globalThis.fetch;
    const nativeDelete = createFlashDelete(capture);
    const pending = new Set(), locks = new Set(), spent = new Map(), created = new Set(); let scope;
    function synchronize() {
        const value = JSON.stringify([capture.epoch, capture.self?.uin, capture.self?.uid]);
        if (scope !== value) { scope = value; locks.clear(); spent.clear(); created.clear(); }
    }
    function clear() { scope = undefined; locks.clear(); spent.clear(); created.clear(); }
    function capabilities() {
        const msf = native.available(), http = typeof fetchImpl === 'function';
        return { flashRead: msf, flashDownload: msf, flashResolve: msf && http, flashWrite: msf,
            flashDelete: msf && nativeDelete.available(),
            flashCreate: msf && http && typeof capture.mediaDirectory === 'string' };
    }
    async function execute(params, callerContext = {}) {
        const input = request(params); capture.ensureReady(); synchronize();
        if (params.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Flash operation must bind the current QQ session');
        if (input.operation === 'delete' && !nativeDelete.available()) fail('UNSUPPORTED', 'QQ lacks verified flash history deletion');
        if (!native.available() || ['create', 'resolve'].includes(input.operation) && typeof fetchImpl !== 'function') fail('UNSUPPORTED', 'This session lacks the fixed flash transfer channel');
        if (input.operation === 'create' && typeof capture.mediaDirectory !== 'string') fail('UNSUPPORTED', 'Flash upload needs an account media directory');
        const saved = { epoch: capture.epoch, session: capture.session, uin: String(capture.self?.uin), uid: capture.self?.uid, scope };
        const controller = new AbortController(), total = input.operation === 'create' ? 60000 : 10000;
        const context = { ...callerContext, expiresAt: Math.min(callerContext.expiresAt ?? Infinity, Date.now() + total),
            signal: callerContext.signal ? AbortSignal.any([callerContext.signal, controller.signal]) : controller.signal };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || String(capture.self?.uin) !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the flash operation');
            if (context.signal.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Flash operation expired; a dispatched write may be uncertain');
        };
        active();
        if (pending.size >= 4) fail('BUSY', 'Too many flash operations still await completion');
        const lockKey = input.filesetId, writable = WRITE_OPERATIONS.has(input.operation), savedLocks = locks;
        if (writable && lockKey && locks.has(lockKey)) fail('BUSY', 'Another write to this fileset still awaits completion');
        const spendKey = writable && lockKey ? JSON.stringify([input.operation, lockKey, input.name, input.userId, input.groupId]) : undefined;
        if (spendKey && spent.has(spendKey)) fail('BUSY', 'This flash write was already dispatched in this session; refresh or change the intended operation before retrying');
        if (writable && spent.size >= 1000) fail('BUSY', 'Flash write tracking limit reached');
        if (writable && lockKey) savedLocks.add(lockKey);
        const token = {}; pending.add(token);
        const timer = setTimeout(() => controller.abort(), Math.max(1, context.expiresAt - Date.now())); timer.unref?.();
        const call = async (operation, data, observed) => {
            active(); protocol.prepare(operation, data);
            const result = await native.run(capture, { op: 'fixedFlashTransfer', operation, request: data,
                expectedEpoch: saved.epoch, expectedUin: saved.uin, signal: context.signal,
                timeoutMs: Math.max(1, Math.min(10000, context.expiresAt - Date.now())) });
            if (!protocol.object(result)) fail('INVALID_RESPONSE', 'QQ supplied no flash result');
            if (observed) observed(result);
            active(); return result;
        };
        const http = async (url, init, maximum) => {
            active(); const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: context.signal }); active();
            if (!response.ok || response.status < 200 || response.status >= 300) { try { await response.body?.cancel(); } catch {} fail('QUERY_FAILED', 'QQ flash HTTP operation was not accepted'); }
            const bytes = await readBounded(response, maximum); active(); return bytes;
        };
        const inventory = async () => {
            const result = await call('list', {});
            if (!Array.isArray(result.items) || result.items.length > 1000 || result.complete !== false) fail('INVALID_RESPONSE', 'QQ supplied no bounded flash inventory');
            return result;
        };
        const detail = async id => {
            const result = await call('detail', { filesetId: id });
            if (result.filesetId !== id || !Array.isArray(result.items) || result.items.length > 1000 || result.items.some(item => item.filesetId !== id)) fail('INVALID_RESPONSE', 'QQ returned another fileset detail');
            return result;
        };
        const metadata = async id => {
            const result = await call('metadata', { filesetId: id });
            if (result.filesetId !== id || !Array.isArray(result.items) || result.items.length > 18 || result.items.some(item => item.filesetId !== id)) fail('INVALID_RESPONSE', 'QQ returned another main file metadata');
            return result;
        };
        function acknowledged(result, id) { if (result.confirmed !== true || result.filesetId !== id) fail('INVALID_RESPONSE', 'QQ did not confirm this fileset write'); }
        const task = Promise.resolve().then(async () => {
            active(); let result;
            if (input.operation === 'list') result = await inventory();
            else if (input.operation === 'detail') result = await detail(input.filesetId);
            else if (input.operation === 'metadata') result = await metadata(input.filesetId);
            else if (input.operation === 'share') {
                const found = (await detail(input.filesetId)).items.map(item => item.shareUrl).filter(Boolean);
                if (found.length !== 1) fail('NOT_FOUND', 'QQ supplied no unambiguous official fileset share link');
                result = { filesetId: input.filesetId, shareUrl: protocol.shareUrl(found[0]) };
            } else if (input.operation === 'resolve') {
                const bytes = await http(input.url, { method: 'GET' }, 2 * 1024 * 1024); let html;
                try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_RESPONSE', 'QQ share page contains invalid UTF-8'); }
                const matches = Array.from(html.matchAll(/fileset_id\\?"\s*:\s*\\?"([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\?"/g), row => row[1]);
                const ids = [...new Set(matches)]; if (ids.length !== 1) fail('INVALID_RESPONSE', 'Official QQ share page omitted an unambiguous fileset identity');
                const id = protocol.uuid(ids[0]); if (!(await detail(id)).items.length) fail('NOT_FOUND', 'The linked fileset is not accessible to this account');
                result = { filesetId: id };
            } else if (input.operation === 'download') {
                const all = await metadata(input.filesetId), chosen = all.items.find(item => item.fileIndex === input.fileIndex);
                if (!chosen) fail('NOT_FOUND', 'The requested file index is not present in the known 18-file page');
                if (input.fileName !== undefined && input.fileName !== chosen.name) fail('NOT_FOUND', 'The requested file name does not match its exact index');
                if (!chosen.fileId) fail('NOT_FOUND', 'The main file is not ready for download');
                result = await call('download', { filesetId: input.filesetId, fileUuid: chosen.fileUuid, fileId: chosen.fileId, name: chosen.name });
                if (result.filesetId !== input.filesetId || result.fileUuid !== chosen.fileUuid) fail('INVALID_RESPONSE', 'QQ returned another main file URL');
                protocol.officialDownload(result.url, chosen.fileId);
                result = { filesetId: input.filesetId, fileIndex: chosen.fileIndex, name: chosen.name, size: chosen.size, url: result.url };
            } else if (input.operation === 'create') {
                // Immutable in-memory snapshots make the hashes and uploaded bytes
                // identical even if the caller changes the original files later.
                const items = input.files.map((row, index) => {
                    const snapshot = media.readLocal(capture.mediaDirectory, row.file, MAX_FILE_BYTES);
                    const name = protocol.name(row.name === undefined ? snapshot.filename : row.name), bytes = Buffer.from(snapshot.bytes);
                    return { bytes, name, size: bytes.length, fileUuid: crypto.randomUUID(), fileIndex: index + 1, ...fileType(name) };
                });
                const covers = [];
                for (let i = 0; i < 2; i++) {
                    let bytes;
                    if (input.thumbnail) { const file = media.readLocal(capture.mediaDirectory, input.thumbnail, MAX_FILE_BYTES); const info = media.imageInfo(file.bytes);
                        if (info.extension !== 'png' || info.width !== 526 || info.height !== 360) fail('INVALID_PARAMS', 'Flash thumbnail must be a 526 by 360 PNG'); bytes = file.bytes;
                    } else bytes = thumbnail();
                    covers.push({ bytes, thumbType: i === 0 ? 'png' : 'jpg', name: crypto.randomUUID() + (i === 0 ? '.png' : '.jpg'),
                        fileUuid: i === 0 ? crypto.randomUUID() : items[0].fileUuid, fileIndex: items.length + i + 1, size: bytes.length, formatCode: i === 0 ? 26 : 2 });
                }
                const name = input.name ?? (items.length === 1 ? items[0].name : protocol.name(items[0].name + '等' + items.length + '个文件'));
                const nickname = typeof capture.self?.nickname === 'string' ? capture.self.nickname : '';
                protocol.uid(saved.uid); active();
                const recovery = createFlashRecovery(capture.mediaDirectory, saved.uin, saved.uid), releaseReservation = recovery.prepare();
                let id, stage = 'allocated';
                try {
                await call('create', { name, size: items.reduce((sum, item) => sum + item.size, 0), typeCode: items[0].typeCode,
                    selfUin: saved.uin, selfUid: saved.uid, nickname }, applied => { id = protocol.uuid(applied.filesetId); recovery.allocated(id); });
                const advance = next => { recovery.stage(id, next); stage = next; };
                const committed = await call('commit', { filesetId: id, entries: items.map(item => ({ fileUuid: item.fileUuid, name: item.name, size: item.size, formatCode: item.formatCode, fileIndex: item.fileIndex })) }); acknowledged(committed, id);
                advance('committed');
                acknowledged(await call('complete', { filesetId: id }), id);
                advance('complete');
                async function register(item) {
                    const sha1 = crypto.createHash('sha1').update(item.bytes).digest();
                    const data = { filesetId: id, fileUuid: item.fileUuid, name: item.name, size: item.size, sha1: sha1.toString('hex'), fileIndex: item.fileIndex, formatCode: item.formatCode,
                        ...(item.thumbType ? { thumbType: item.thumbType } : {}) };
                    const prepared = await call('prepare', data);
                    if (prepared.filesetId !== id || prepared.fileUuid !== item.fileUuid || prepared.uploadKey !== null && !/^[A-Za-z0-9_-]{1,8192}$/.test(prepared.uploadKey)) fail('INVALID_RESPONSE', 'QQ returned another flash upload credential');
                    const grant = protocol.uploadGrant(prepared);
                    // Preserve the server grant. A slice ACK must precede commit;
                    // no missing token may be replaced with a local file ID.
                    await upload({ item, uploadKey: prepared.uploadKey });
                    const confirmed = await call('apply', { ...data, fileId: grant.token, time: grant.time, ttl: grant.ttl, md5: crypto.createHash('md5').update(item.bytes).digest('hex') });
                    acknowledged(confirmed, id); if (confirmed.fileUuid !== item.fileUuid) fail('INVALID_RESPONSE', 'QQ registered another flash file');
                    return { item, fileId: grant.token };
                }
                async function upload(registered) {
                    if (registered.uploadKey === null) return;
                    const appid = registered.item.thumbType === 'png' ? 14903 : registered.item.thumbType === 'jpg' ? 14902 : 14901;
                    const body = protocol.sliceBody(registered.item.bytes, registered.uploadKey, appid);
                    const bytes = await http('https://multimedia.qfile.qq.com/sliceupload', { method: 'POST', body,
                        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'X-Retried-Times': '1' } }, 65536);
                    protocol.decodeSlice(bytes);
                }
                const registered = []; for (const item of items) registered.push(await register(item));
                advance('registered');
                for (const item of covers) await register(item);
                advance('uploaded');
                acknowledged(await call('ready', { filesetId: id }), id);
                advance('ready');
                // Confirm main file IDs and exact metadata, not just task acceptance.
                let confirmed = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const observed = await metadata(id), seen = new Set();
                    for (const actual of observed.items) {
                        const index = items.findIndex(item => item.fileIndex === actual.fileIndex), item = items[index];
                        if (!item || seen.has(actual.fileIndex) || actual.fileUuid !== item.fileUuid || actual.name !== item.name ||
                            String(actual.size) !== String(item.size) || actual.fileId !== undefined && actual.fileId !== registered[index].fileId)
                            fail('INVALID_RESPONSE', 'QQ returned conflicting uploaded main file metadata');
                        seen.add(actual.fileIndex);
                    }
                    confirmed = observed.items.length === items.length && observed.items.every(actual => actual.fileId !== undefined);
                    if (confirmed) break;
                    if (attempt < 2) {
                        // Only metadata may lag. Never replay a dispatched write.
                        try { await delay(1000, undefined, { signal: context.signal }); }
                        catch (error) { active(); throw error; }
                        active();
                    }
                }
                if (!confirmed) fail('INVALID_RESPONSE', 'QQ did not read back every uploaded main file');
                advance('confirmed'); created.add(id);
                result = { filesetId: id, confirmed: true, confirmation: 'upload_ack_and_metadata_readback', fileCount: items.length };
                } catch (error) {
                    if (id) {
                        try { if (recovery.has(id)) recovery.stage(id, 'cleanup_pending'); }
                        catch { /* Keep the last durable allocation record; never hide the original failure. */ }
                        const code = typeof error.code === 'string' ? error.code : 'QUERY_FAILED';
                        throw Object.assign(new Error(error.message + ' [flash_stage=' + stage + ';cleanup_pending]'), { code });
                    }
                    throw error;
                } finally { releaseReservation(); }
            } else {
                // Mutations require membership in this account's actual inventory,
                // or an upload completed in this exact session. Shared links alone
                // never authorize delete/rename/send.
                const recovery = input.operation === 'delete' && typeof capture.mediaDirectory === 'string' ? createFlashRecovery(capture.mediaDirectory, saved.uin, saved.uid) : null;
                const allocated = recovery?.has(input.filesetId) === true;
                const own = allocated || created.has(input.filesetId) || (await inventory()).items.some(row => row.filesetId === input.filesetId);
                if (!own) fail('FORBIDDEN', 'The fileset is not present in this account flash inventory');
                if (!allocated && !(await detail(input.filesetId)).items.length) fail('NOT_FOUND', 'This account cannot access the fileset');
                let data = { filesetId: input.filesetId };
                if (input.operation === 'rename') data.name = input.name;
                if (input.operation === 'send') {
                    if (input.userId) { const who = await capture.resolve({ uin: input.userId }); active();
                        if (String(who?.uin) !== input.userId) fail('INVALID_RESPONSE', 'QQ resolved another flash recipient'); data.targetUid = protocol.uid(who.uid);
                    } else data.groupId = input.groupId;
                }
                active(); spent.set(spendKey, true);
                result = input.operation === 'delete' ? await nativeDelete.remove(input.filesetId, active) : await call(input.operation, data);
                acknowledged(result, input.filesetId);
                if (input.operation === 'send') {
                    if (result.confirmation !== 'target_ack' || (data.targetUid ? result.targetUid !== data.targetUid : result.groupId !== data.groupId)) fail('INVALID_RESPONSE', 'QQ did not confirm the exact flash recipient');
                } else if (input.operation === 'rename') {
                    const observed = await detail(input.filesetId);
                    if (observed.items.length !== 1 || observed.items[0].name !== input.name) fail('INVALID_RESPONSE', 'QQ did not read back the new fileset name');
                    result = { ...result, confirmation: 'name_readback', name: input.name };
                } else {
                    if ((await inventory()).items.some(row => row.filesetId === input.filesetId)) fail('INVALID_RESPONSE', 'QQ still lists the deleted flash history entry');
                    if (allocated) recovery.deleted(input.filesetId); created.delete(input.filesetId);
                    result = { ...result, confirmation: 'account_history_removed' };
                }
            }
            active(); const output = { operation: input.operation, selfUin: saved.uin, result };
            if (Buffer.byteLength(JSON.stringify(output)) > MAX_FILE_BYTES) fail('INVALID_RESPONSE', 'Flash result exceeds the 1 MiB RPC budget');
            return output;
        });
        task.finally(() => { clearTimeout(timer); pending.delete(token); if (writable && lockKey && scope === saved.scope) savedLocks.delete(lockKey); }).catch(() => {});
        try { const output = await capture.deadline(() => task, context, total); active(); return output; }
        catch (error) { controller.abort(); throw error; }
    }
    return { execute, capabilities, clear };
}
module.exports = { createFlashTransfer, OPERATIONS, WRITE_OPERATIONS, request, inputFiles, MAX_FILE_BYTES, MAX_FILES, readBounded, thumbnail, fileType };
