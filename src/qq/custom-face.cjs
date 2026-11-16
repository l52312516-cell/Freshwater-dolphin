'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { setTimeout: pause } = require('node:timers/promises');
const protocol = require('./custom-face-protocol.cjs');
const media = require('./media.cjs');
const QUERIES = Object.freeze({ 'face.list': ['count', 'detail'], 'face.prepare': ['emojiId'] });
const ACTIONS = Object.freeze({ 'face.add': ['file'], 'face.delete': ['emojiId'], 'face.modify': ['emojiId', 'desc'], 'face.moveFront': ['emojiId'] });
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function count(value, fallback = 48) {
    if (value === undefined) return fallback;
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,3})$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) > 1000) fail('INVALID_PARAMS', 'Custom face count must be an integer in 0..1000');
    return Number(value);
}
function description(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid bounded custom face description');
    return value;
}
function createCustomFace(capture, options = {}) {
    const native = options.native || require('./msf-native.cjs'), fetchImpl = options.fetchImpl || globalThis.fetch;
    const pending = new Set(); let writing = false;
    function capabilities() {
        const sso = native.available();
        return { customFaceRead: sso, customFaceWrite: sso, customFaceAdd: sso && typeof fetchImpl === 'function' && typeof capture.mediaDirectory === 'string',
            customFaceSend: sso && typeof fetchImpl === 'function' && typeof capture.mediaDirectory === 'string' && capture.hasMethods('msg', ['getRichMediaFilePathForGuild', 'sendMsg', 'generateMsgUniqueId']) };
    }
    function state(data, callerContext) {
        capture.ensureReady();
        if (data.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Custom face operations must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        protocol.prepare('face.list', { uin: saved.uin });
        const context = { ...callerContext, expiresAt: Math.min(Date.now() + 60000, callerContext.expiresAt ?? Infinity) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) fail('SESSION_CHANGED', 'QQ changed during the custom face operation');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Custom face operation expired; its write outcome may be unknown');
        };
        active(); return { saved, context, active };
    }
    async function fixed(operation, request, scope) {
        scope.active(); protocol.prepare(operation, request);
        const result = await native.run(capture, { op: 'fixedCustomFace', operation, request, expectedEpoch: scope.saved.epoch, expectedUin: scope.saved.uin,
            signal: scope.context.signal, timeoutMs: Math.max(1, Math.min(10000, scope.context.expiresAt - Date.now())) });
        scope.active(); return result;
    }
    async function catalog(scope) {
        const value = await fixed('face.list', { uin: scope.saved.uin }, scope);
        if (!object(value) || value.uin !== scope.saved.uin || value.complete !== true || !Array.isArray(value.ids) || value.ids.length > 1000 || new Set(value.ids).size !== value.ids.length) fail('INVALID_RESPONSE', 'QQ supplied no complete custom face account catalog');
        for (const id of value.ids) protocol.emoji(id, scope.saved.uin, 'INVALID_RESPONSE');
        return value.ids;
    }
    function url(uin, emojiId) { return 'https://p.qpic.cn/qq_expression/' + uin + '/' + emojiId + '/0'; }
    async function details(ids, scope) {
        if (!ids.length) return [];
        const value = await fixed('face.detail', { uin: scope.saved.uin, ids }, scope);
        if (!object(value) || value.uin !== scope.saved.uin || !Array.isArray(value.entries) || value.entries.length > ids.length) fail('INVALID_RESPONSE', 'QQ supplied no bounded custom face description result');
        const descriptions = new Map();
        for (const entry of value.entries) {
            if (!object(entry) || !ids.includes(entry.emojiId) || descriptions.has(entry.emojiId)) fail('INVALID_RESPONSE', 'QQ custom face description belongs to another catalog entry');
            descriptions.set(entry.emojiId, description(entry.desc));
        }
        // The confirmed detail protocol omits entries with no saved remark.
        return ids.map(emojiId => ({ ...protocol.emoji(emojiId, scope.saved.uin), url: url(scope.saved.uin, emojiId), desc: descriptions.get(emojiId) ?? '' }));
    }
    async function bodyRequest(target, request, scope, maximum) {
        scope.active();
        const timeout = AbortSignal.timeout(Math.max(1, scope.context.expiresAt - Date.now()));
        const signal = scope.context.signal ? AbortSignal.any([scope.context.signal, timeout]) : timeout;
        let response;
        try {
            response = await fetchImpl(target, { ...request, redirect: 'manual', credentials: 'omit', signal });
            scope.active();
            if (!response || response.status !== 200 || response.redirected || response.url && response.url !== target || !response.body) fail('QUERY_FAILED', 'QQ custom face server did not return a complete fixed-destination response');
            const parts = []; let size = 0;
            for await (const chunk of response.body) {
                scope.active(); size += chunk.length;
                if (size > maximum) fail('INVALID_RESPONSE', 'QQ custom face response exceeded its byte budget');
                parts.push(Buffer.from(chunk));
            }
            scope.active(); return Buffer.concat(parts);
        } catch (error) {
            Promise.resolve(response?.body?.cancel?.()).catch(() => {});
            scope.active();
            if (error.code) throw error;
            fail(signal.aborted ? 'TIMEOUT' : 'QUERY_FAILED', 'QQ custom face network request failed; no retry was attempted');
        }
    }
    async function prepareImage(identifier, scope) {
        const ids = await catalog(scope), byMd5 = /^[A-Fa-f0-9]{32}$/.test(identifier);
        const matches = ids.filter(id => byMd5 ? protocol.emoji(id, scope.saved.uin).md5 === identifier.toUpperCase() : id === identifier);
        if (matches.length !== 1) fail('NOT_FOUND', 'Custom face is not uniquely present in this account catalog');
        const item = protocol.emoji(matches[0], scope.saved.uin);
        const bytes = await bodyRequest(url(scope.saved.uin, item.emojiId), { headers: { Accept: 'image/*' } }, scope, media.MAX_IMAGE_BYTES);
        const image = media.imageInfo(bytes), md5 = crypto.createHash('md5').update(bytes).digest('hex');
        if (md5.toUpperCase() !== item.md5) fail('INVALID_RESPONSE', 'Custom face image does not match its catalog digest');
        const resource = media.exportImage(capture.mediaDirectory, { bytes, ...image });
        try {
            const element = await capture.prepareMedia({ expectedEpoch: scope.saved.epoch, type: 'image', file: resource.path, summary: '[动画表情]' }, scope.context);
            scope.active();
            if (element?.elementType !== 2 || element.picElement?.md5HexStr !== md5) fail('INVALID_RESPONSE', 'QQ prepared a different custom face image');
            element.picElement.picSubType = 1;
            element.picElement.summary = '[动画表情]';
            return { uin: scope.saved.uin, emojiId: item.emojiId, md5, element };
        } finally { try { fs.unlinkSync(resource.path); } catch (error) { if (error.code !== 'ENOENT') capture.diagnostic?.(Object.assign(new Error('Temporary custom face import cleanup failed'), { code: 'MEDIA_CLEANUP' })); } }
    }
    async function execute(data, scope) {
        const uin = scope.saved.uin;
        if (data.operation === 'face.list') {
            const all = await catalog(scope), selected = all.slice(0, count(data.count));
            return { uin, complete: selected.length === all.length, total: all.length, faces: data.detail === true ? await details(selected, scope) : selected.map(emojiId => ({ ...protocol.emoji(emojiId, uin), url: url(uin, emojiId) })) };
        }
        if (data.operation === 'face.prepare') return prepareImage(data.emojiId, scope);
        const before = await catalog(scope);
        if (data.operation === 'face.add') {
            let image;
            if (typeof data.file === 'string' && media.IMAGE_RESOURCE.test(data.file)) {
                const resource = media.resourceInfo(capture.mediaDirectory, data.file);
                image = media.readImage(capture.mediaDirectory, resource.path);
            } else if (typeof data.file === 'string' && data.file.startsWith('base64://')) image = media.readImage(capture.mediaDirectory, data.file);
            else fail('INVALID_PARAMS', 'Custom face upload requires an account image handle or canonical base64 image');
            const emojiId = uin + '_0_0_0_' + image.md5.toUpperCase() + '_0_0';
            if (before.includes(emojiId)) return { uin, emojiId, confirmed: true, confirmation: 'catalog_readback', alreadyPresent: true };
            const session = await fixed('face.uploadSession', {}, scope);
            if (!Array.isArray(session?.servers) || !session.servers.length) fail('INVALID_RESPONSE', 'QQ supplied no custom face upload destination');
            const ticket = await fixed('face.uploadTicket', { uin, md5: image.md5, size: image.bytes.length }, scope);
            const frame = protocol.uploadFrame({ uin, emojiId, md5: image.md5, bytes: image.bytes, token: ticket.token });
            const server = session.servers[0];
            const target = 'http://' + server.host + ':' + server.port + '/cgi-bin/httpconn?htcmd=0x6FF0087&uin=' + uin;
            const ack = await bodyRequest(target, { method: 'POST', body: frame, headers: { Accept: '*/*', 'Content-Type': 'application/octet-stream' } }, scope, 65536);
            protocol.uploadAck(ack, image.bytes.length);
            for (;;) {
                if ((await catalog(scope)).includes(emojiId)) return { uin, emojiId, confirmed: true, confirmation: 'catalog_readback' };
                await pause(150); scope.active();
            }
        }
        const item = protocol.emoji(data.emojiId, uin);
        if (!before.includes(item.emojiId)) fail('NOT_FOUND', 'Custom face is not in this account catalog');
        if (data.operation === 'face.delete') {
            await fixed('face.delete', { uin, emojiId: item.emojiId }, scope);
            for (;;) {
                if (!(await catalog(scope)).includes(item.emojiId)) return { uin, emojiId: item.emojiId, confirmed: true, confirmation: 'catalog_absence' };
                await pause(150); scope.active();
            }
        }
        if (data.operation === 'face.modify') {
            const desc = description(data.desc ?? '');
            await fixed('face.modify', { uin, emojiId: item.emojiId, desc }, scope);
            for (;;) {
                const entry = (await details([item.emojiId], scope))[0];
                if (entry.desc === desc) return { uin, emojiId: item.emojiId, desc, confirmed: true, confirmation: 'description_readback' };
                await pause(150); scope.active();
            }
        }
        const ordered = [item.emojiId, ...before.filter(id => id !== item.emojiId)];
        await fixed('face.order', { uin, emojiId: item.emojiId }, scope);
        await fixed('face.reorder', { uin, ids: ordered }, scope);
        for (;;) {
            const observed = await catalog(scope);
            if (observed.length === ordered.length && observed.every((id, index) => id === ordered[index])) return { uin, emojiId: item.emojiId, confirmed: true, confirmation: 'order_readback' };
            await pause(150); scope.active();
        }
    }
    async function run(data, context, mutation) {
        const allowed = (mutation ? ACTIONS : QUERIES)[data?.operation];
        if (!allowed) fail('UNSUPPORTED', 'Unknown fixed custom face operation');
        if (!object(data) || Object.keys(data).some(key => !['operation', 'expectedEpoch', ...allowed].includes(key))) fail('INVALID_PARAMS', 'Unexpected custom face parameters');
        if (data.operation === 'face.list') { count(data.count); if (data.detail !== undefined && typeof data.detail !== 'boolean') fail('INVALID_PARAMS', 'Custom face detail flag must be boolean'); }
        if (data.emojiId !== undefined && (typeof data.emojiId !== 'string' || !data.emojiId.length || Buffer.byteLength(data.emojiId) > 128)) fail('INVALID_PARAMS', 'Invalid custom face identifier');
        if (data.operation === 'face.prepare' && typeof data.emojiId !== 'string') fail('INVALID_PARAMS', 'A saved custom face identifier is required');
        const scope = state(data, context), flags = capabilities();
        if (!(data.operation === 'face.add' ? flags.customFaceAdd : data.operation === 'face.prepare' ? flags.customFaceSend : mutation ? flags.customFaceWrite : flags.customFaceRead)) fail('UNSUPPORTED', 'This QQ session lacks the required custom face capability');
        if (mutation && writing) fail('BUSY', 'A custom face mutation still awaits its actual outcome');
        if (pending.size >= 4) fail('BUSY', 'Too many custom face operations still await their actual completion');
        const token = {}; pending.add(token); if (mutation) writing = true;
        const task = Promise.resolve().then(() => { scope.active(); return execute(data, scope); });
        const release = () => { pending.delete(token); if (mutation) writing = false; };
        task.then(release, release);
        const value = await capture.deadline(() => task, scope.context, 60000); scope.active();
        return { ...value, operation: data.operation };
    }
    return { capabilities, query: (data, context = {}) => run(data, context, false), action: (data, context = {}) => run(data, context, true) };
}
module.exports = { createCustomFace, QUERIES, ACTIONS };
