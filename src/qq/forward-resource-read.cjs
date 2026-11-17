'use strict';

// Read-only resource reader preserves custom metadata even when getMultiMsg
// succeeds, and supports the existing failed-expansion fallback. A resource is
// usable only through its exact native root; display nodes never acquire IDs.
const protocol = require('./forward-upload-protocol.cjs');
const nativeBody = require('./native-forward-body.cjs');
const { finalResource, rootDescriptor } = require('./forward.cjs');
const probe = require('./forward-resource-probe.cjs');
const { uint } = require('./admin-oidb.cjs');
const { annotate, errorDiagnostics } = require('../diagnostics.cjs');
const TTL = 60000;
const PROBE_TTL = 1500;
const PROBE_UNAVAILABLE = new Set(['BUSY', 'QUERY_FAILED', 'UNSUPPORTED', 'INVALID_CONFIG', 'KERNEL_ERROR',
    'TIMEOUT', 'EXPIRED', 'INVALID_RESPONSE']);
const ERROR_CODES = new Set(['INVALID_PARAMS', 'INVALID_RESPONSE', 'INVALID_CONFIG', 'SESSION_CHANGED',
    'NOT_READY', 'UNSUPPORTED', 'NOT_FOUND', 'KERNEL_ERROR', 'QUERY_FAILED', 'BUSY', 'EXPIRED', 'TIMEOUT']);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function uid(value) { return typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value); }
function fullId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
        fail('INVALID_PARAMS', 'Forward resource reading requires an exact uint64 message ID string');
    }
    return value;
}
function peer(value) {
    protocol.fields(value, ['chatType', 'peerUid']);
    if (value.chatType === 1 ? !uid(value.peerUid) : value.chatType !== 2 || typeof value.peerUid !== 'string' ||
        uint(value.peerUid, 'forward resource group', 0xffffffffn, 1n) !== value.peerUid) {
        fail('INVALID_PARAMS', 'Forward resource reading requires a real private UID or group UIN');
    }
    return { chatType: value.chatType, peerUid: value.peerUid };
}
function decodeNodes(raw) {
    // The two independently observed schemas are intentionally disjoint. Do
    // not loosen either schema or reinterpret native wire sequences as IDs.
    try { return protocol.decodePayload(raw).nodes; }
    catch { return nativeBody.decodePayload(raw).nodes; }
}
function createForwardResourceRead(capture, { native = require('./msf-native.cjs') } = {}) {
    async function readResource(params, context = {}, customOnly = false, mode = 'strict') {
        protocol.fields(params, ['peer', 'rootMsgId', 'parentMsgId', 'resId', 'expectedEpoch']);
        const target = peer(params.peer), rootMsgId = fullId(params.rootMsgId), parentMsgId = fullId(params.parentMsgId);
        const resId = protocol.resource(params.resId);
        if (parentMsgId !== rootMsgId) fail('UNSUPPORTED', 'Forward resource fallback currently requires the native root itself');
        capture.ensureReady();
        const saved = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        if (params.expectedEpoch !== saved.epoch) fail('SESSION_CHANGED', 'Forward resource reading must bind the current QQ session');
        const selfUin = uint(saved.uin, 'authenticated forward reader', 0xffffffffn, 1n);
        if (!uid(saved.uid)) fail('NOT_READY', 'Forward resource reading needs an authenticated QQ UID');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid forward resource deadline');
        const controller = new AbortController();
        context = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + TTL),
            signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
        const probeExpiresAt = Math.min(context.expiresAt, Date.now() + PROBE_TTL);
        function active() {
            capture.ensureReady();
            if (capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) {
                fail('SESSION_CHANGED', 'QQ changed during forward resource reading');
            }
            if (context.signal.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Forward resource reading expired');
        }
        const remaining = () => { active(); return Math.max(1, Math.min(TTL, Math.ceil(context.expiresAt - Date.now()))); };
        async function bounded(operation) {
            active();
            const value = await capture.deadline(() => { active(); return operation(); }, context, remaining());
            active();
            return value;
        }
        async function optionalProbe(operation) {
            // Root revalidation and the packet share one short allowance. A
            // stalled second lookup must not consume the native read's budget.
            active();
            const probeController = new AbortController();
            const probeContext = { ...context, expiresAt: probeExpiresAt,
                signal: AbortSignal.any([context.signal, probeController.signal]) };
            const timeoutMs = Math.max(1, Math.ceil(probeExpiresAt - Date.now()));
            try {
                const value = await capture.deadline(() => {
                    active();
                    return operation({ signal: probeContext.signal, timeoutMs });
                }, probeContext, timeoutMs);
                active();
                return { available: true, value };
            } catch (error) {
                // Only preclassification transport failure is optional. The
                // original deadline/session still owns the whole operation.
                active();
                if (PROBE_UNAVAILABLE.has(error?.code)) return { available: false };
                throw error;
            } finally { probeController.abort(); }
        }
        let phase = 'root';
        try {
            active();
            if (!capture.hasMethods('msg', ['getMsgsByMsgId'])) fail('UNSUPPORTED', 'QQ fixed forward resource reading is unavailable');
            if (!native.available()) {
                if (customOnly) return null;
                fail('UNSUPPORTED', 'QQ fixed forward resource reading is unavailable');
            }
            return await capture.deadline(async () => {
                const lookup = () => capture.invoke('msg', 'getMsgsByMsgId', [{ ...target, guildId: '' }, [rootMsgId]]);
                let root;
                if (customOnly) {
                    const observed = await optionalProbe(lookup);
                    if (!observed.available) return null;
                    root = observed.value;
                } else root = await bounded(lookup);
                if (!root || typeof root !== 'object' || !Object.hasOwn(root, 'result')) fail('INVALID_RESPONSE', 'QQ supplied no explicit root lookup result');
                if (root.result !== 0 && root.result !== '0') fail('KERNEL_ERROR', 'QQ rejected the forward resource root lookup');
                if (!Array.isArray(root.msgList) || root.msgList.length !== 1) fail('NOT_FOUND', 'QQ supplied no exact single forward resource root');
                const record = root.msgList[0];
                if (!record || record.msgId !== rootMsgId || record.chatType !== target.chatType || record.peerUid !== target.peerUid ||
                    (customOnly ? rootDescriptor(record).resId : finalResource(record)) !== resId) fail('INVALID_RESPONSE', 'QQ returned a different forward resource root');
                phase = 'resource';
                const prepared = protocol.prepare('forward.readUploaded', { selfUid: saved.uid, resId });
                const request = { op: 'rawPacket', cmd: prepared.name, data: prepared.body.toString('hex'), rsp: true,
                    expectedEpoch: saved.epoch, expectedUin: saved.uin };
                let response;
                if (customOnly) {
                    const observed = await optionalProbe(options => native.run(capture, { ...request, ...options }));
                    if (!observed.available) return null;
                    response = observed.value;
                } else response = await bounded(() => native.run(capture, { ...request,
                    signal: context.signal, timeoutMs: remaining() }));
                const encoded = response?.responseHex;
                if (typeof encoded !== 'string' || !encoded.length || encoded.length > (customOnly ? probe.MAX_BYTES : protocol.MAX_BYTES) * 2 ||
                    encoded.length % 2 || !/^[0-9a-f]+$/i.test(encoded)) {
                    if (customOnly) return null;
                    fail('INVALID_RESPONSE', 'QQ forward resource response has no exact bounded bytes');
                }
                const raw = Buffer.from(encoded, 'hex');
                let payload = customOnly ? probe.extractCustomPayload(raw, prepared) :
                    Buffer.from(protocol.decode(raw, prepared).payloadBase64, 'base64');
                if (customOnly && payload === null) { active(); return null; }
                phase = 'decode';
                // The wider probe grants no wider custom response contract.
                // Reapply the original strict response/compression byte caps.
                if (customOnly) payload = Buffer.from(protocol.decode(raw, prepared).payloadBase64, 'base64');
                const nodes = customOnly ? protocol.decodePayload(payload).nodes : decodeNodes(payload);
                const { decodeRichBody, MAX_ELEMENTS, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } = require('./forward-rich-body.cjs');
                const elements = nodes.map(node => decodeRichBody(node.body, { mode }));
                let elementCount = 0, textBytes = 0, imageBytes = 0;
                for (const list of elements) for (const element of list) {
                    elementCount++;
                    if (element.elementType === 1) textBytes += Buffer.byteLength(element.textElement.content);
                    else if (element.elementType === 2) imageBytes += Number(element.picElement.fileSize);
                }
                if (elementCount > MAX_ELEMENTS || textBytes > MAX_TEXT_BYTES || imageBytes > MAX_IMAGE_BYTES) {
                    fail('INVALID_RESPONSE', 'QQ forward resource exceeds its aggregate content budget');
                }
                active();
                phase = 'authors';
                const authors = new Map([[selfUin, saved.uid]]), owners = new Map([[saved.uid, selfUin]]);
                for (const node of nodes) {
                    if (!authors.has(node.authorUin)) {
                        if (typeof capture.resolve !== 'function') fail('UNSUPPORTED', 'QQ cannot resolve forward resource authors');
                        const resolved = await bounded(() => capture.resolve({ uin: node.authorUin }));
                        if (!['string', 'number'].includes(typeof resolved?.uin) || String(resolved.uin) !== node.authorUin ||
                            !uid(resolved?.uid) || owners.has(resolved.uid) && owners.get(resolved.uid) !== node.authorUin) {
                            fail('INVALID_RESPONSE', 'QQ did not resolve the exact forward resource author');
                        }
                        authors.set(node.authorUin, resolved.uid); owners.set(resolved.uid, node.authorUin);
                    }
                    if (node.authorUid !== undefined && node.authorUid !== authors.get(node.authorUin)) {
                        fail('INVALID_RESPONSE', 'QQ forward resource author UID conflicts with its resolved account');
                    }
                }
                const resourceNodes = nodes.map((node, index) => ({ authorUin: node.authorUin, authorUid: authors.get(node.authorUin),
                    nickname: node.nickname, time: node.time, elements: elements[index] }));
                if (Buffer.byteLength(JSON.stringify(resourceNodes)) > protocol.MAX_BYTES) fail('INVALID_RESPONSE', 'QQ decoded forward resource exceeds its bound');
                active();
                return { peer: target, rootMsgId, parentMsgId, resId, resourceNodes };
            }, context, remaining());
        } catch (error) {
            // Raw native errors can contain private identifiers or packet data.
            throw annotate(Object.assign(new Error('QQ forward resource reading failed; phase=' + phase),
                { code: ERROR_CODES.has(error?.code) ? error.code : 'INVALID_RESPONSE' }),
            errorDiagnostics(error, { phase: phase === 'decode' ? 'forward_decode' : 'forward_read' }));
        } finally {
            // Closing every read also closes late native continuations, even
            // when Capture rejected it after an account/session transition.
            controller.abort();
        }
    }
    return { read: (params, context) => readResource(params, context),
        readCustom: (params, context) => readResource(params, context, true),
        readCompatible: (params, context) => readResource(params, context, false, 'compatible'),
        readCustomCompatible: (params, context) => readResource(params, context, true, 'compatible') };
}
module.exports = { createForwardResourceRead };
