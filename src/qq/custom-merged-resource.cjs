'use strict';

const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const p = require('./proto.cjs');
const protocol = require('./forward-upload-protocol.cjs');
const { serverTimeSeconds } = require('./forward-upload.cjs');
const { elementsSignature } = require('./merged-send.cjs');
const { finalResource } = require('./forward.cjs');
const n = p.varintField, b = p.bytesField, s = (field, value) => b(field, Buffer.from(value, 'utf8'));
const join = (...values) => Buffer.concat(values);
function fail(code, message) { throw Object.assign(Error(message), { code }); }
function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_PARAMS', 'Unexpected custom forward parameters');
}
function uint(value, label, zero = false) {
    if (!['string', 'number'].includes(typeof value) || !/^(0|[1-9]\d{0,9})$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || BigInt(value) > 0xffffffffn || (!zero && BigInt(value) === 0n)) fail('INVALID_PARAMS', 'Invalid custom forward ' + label);
    return String(value);
}
function uid(value) { return typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value); }
function destination(value) {
    fields(value, ['chatType', 'peerUid']);
    if (value.chatType === 1 ? !uid(value.peerUid) : value.chatType !== 2 || uint(value.peerUid, 'group') !== value.peerUid) fail('INVALID_PARAMS', 'Invalid custom forward destination');
    return { ...value };
}
function card(resId, nodes) {
    const uniseq = crypto.randomUUID();
    return JSON.stringify({ app: 'com.tencent.multimsg', config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
        desc: '[聊天记录]', extra: JSON.stringify({ filename: uniseq, tsum: nodes.length }), meta: { detail: { news: nodes.slice(0, 4).map(node => ({ text: node.nickname + ': ' +
            node.elements.map(element => element.elementType === 1 ? element.textElement.content : '[图片]').join('').slice(0, 80) })),
            resid: resId, source: '聊天记录', summary: '查看' + nodes.length + '条转发消息',
            uniseq } }, prompt: '[聊天记录]', ver: '0.0.0.5', view: 'contact' });
}

function createCustomMergedResource(capture, { native = require('./msf-native.cjs') } = {}) {
    let owner, pending;
    const attempted = new Set();
    function capabilities() { return { mergeCustomMetadata: native.available() && capture.hasMethods('msg', ['getMsgsByMsgId', 'getMultiMsg', 'sendMsg']) && capture.hasMethods('msf', ['getServerTime']) }; }
    async function run(params, context = {}) {
        fields(params, ['kind', 'destination', 'nodes', 'expectedEpoch', 'timeoutMs']);
        capture.ensureReady();
        const state = { epoch: capture.epoch, session: capture.session, uin: capture.self?.uin, uid: capture.self?.uid };
        if (params.expectedEpoch !== state.epoch || !uid(state.uid)) fail('SESSION_CHANGED', 'Custom forward must bind its authenticated session');
        uint(state.uin, 'authenticated account');
        if (!capabilities().mergeCustomMetadata) fail('UNSUPPORTED', 'QQ custom forward metadata upload is unavailable');
        const target = destination(params.destination);
        if (!Array.isArray(params.nodes) || !params.nodes.length || params.nodes.length > 100) fail('INVALID_PARAMS', 'Custom forward requires 1 to 100 nodes');
        let textBytes = 0, segmentCount = 0;
        const nodes = params.nodes.map(node => {
            fields(node, ['authorUin', 'nickname', 'time', 'elements']);
            const authorUin = uint(node.authorUin, 'author'), time = node.time === undefined ? '0' : uint(node.time, 'time', true);
            if (typeof node.nickname !== 'string' || !node.nickname.trim() || Buffer.byteLength(node.nickname) > 512 || /[\x00-\x1f\x7f]/.test(node.nickname)) fail('INVALID_PARAMS', 'Custom forward needs a bounded nickname');
            const signature = elementsSignature(node.elements, 'INVALID_PARAMS');
            for (const element of node.elements) { segmentCount++; if (element.elementType === 1) textBytes += Buffer.byteLength(element.textElement.content); }
            return { authorUin, time, nickname: node.nickname, elements: structuredClone(node.elements), signature };
        });
        if (textBytes > 65536 || segmentCount > 1000) fail('INVALID_PARAMS', 'Custom forward exceeds its content budget');
        const scope = JSON.stringify([state.epoch, state.uin, state.uid]);
        if (owner !== scope) { owner = scope; attempted.clear(); }
        if (pending) fail('BUSY', 'Another custom resource forward is pending');
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify([target, nodes.map(node => [node.authorUin, node.nickname, node.time, node.signature])])).digest('hex');
        if (attempted.has(fingerprint) || attempted.size >= 128) fail('BUSY', 'This custom resource was already submitted in the account session');
        const timeoutMs = params.timeoutMs ?? 60000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('INVALID_PARAMS', 'Invalid custom forward deadline');
        if (context.expiresAt !== undefined && !Number.isFinite(context.expiresAt)) fail('INVALID_PARAMS', 'Invalid custom forward deadline');
        context = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, Date.now() + timeoutMs) };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== state.epoch || capture.session !== state.session || capture.self?.uin !== state.uin || capture.self?.uid !== state.uid) fail('SESSION_CHANGED', 'QQ session changed during custom forwarding');
            if (context.signal?.aborted || Date.now() >= context.expiresAt) fail('EXPIRED', 'Custom forwarding expired; submitted work is not retried');
        };
        const remaining = () => { active(); return Math.max(1, Math.min(60000, context.expiresAt - Date.now())); };
        async function raw(prepared) {
            active(); const response = await native.run(capture, { op: 'rawPacket', cmd: prepared.name, data: prepared.body.toString('hex'), rsp: true,
                expectedEpoch: state.epoch, expectedUin: state.uin, signal: context.signal, timeoutMs: remaining() });
            active();
            if (typeof response?.responseHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(response.responseHex)) fail('INVALID_RESPONSE', 'QQ custom resource response is incomplete');
            return protocol.decode(Buffer.from(response.responseHex, 'hex'), prepared);
        }
        const token = {}; pending = token;
        let phase = 'resolve-authors';
        const task = (async () => {
            const authorUids = new Map();
            for (const node of nodes) if (!authorUids.has(node.authorUin)) {
                active();
                if (node.authorUin === state.uin) authorUids.set(node.authorUin, state.uid);
                else { const resolved = await capture.deadline(() => capture.resolve({ uin: node.authorUin }), context, remaining()); active();
                    if (String(resolved?.uin) !== node.authorUin || !uid(resolved?.uid)) fail('NOT_FOUND', 'QQ custom forward author has no verified UID');
                    authorUids.set(node.authorUin, resolved.uid); }
            }
            phase = 'server-time';
            const serverTime = serverTimeSeconds(await capture.deadline(() => capture.invoke('msf', 'getServerTime', []), context, remaining())); active();
            const hasImages = nodes.some(node => node.elements.some(element => element.elementType === 2));
            let bodies;
            if (hasImages) {
                phase = 'native-image-staging';
                attempted.add(fingerprint);
                const staged = await capture.mergedSendApi.run({ kind: 'customMerge', destination: { chatType: 1, peerUid: state.uid },
                    nodes: nodes.map(node => ({ nickname: node.nickname, elements: node.elements })), expectedEpoch: state.epoch, timeoutMs: remaining() }, context);
                active();
                if (staged?.confirmed !== true || staged.confirmation !== 'fresh-source-tuple-and-resource-readback' || staged.nodeCount !== nodes.length ||
                    staged.destination?.chatType !== 1 || staged.destination.peerUid !== state.uid || finalResource(staged.record) !== staged.resId) fail('INVALID_RESPONSE', 'Custom forward image staging was not confirmed');
                phase = 'native-image-resource';
                const request = protocol.prepare('forward.readUploaded', { selfUid: state.uid, resId: staged.resId });
                const response = await raw(request), decoded = require('./native-forward-body.cjs').decodePayload(Buffer.from(response.payloadBase64, 'base64'));
                if (decoded.nodes.length !== nodes.length || decoded.nodes.some((node, index) => node.authorUin !== state.uin ||
                    node.authorUid !== state.uid || node.time !== String(staged.records[index]?.msgTime) ||
                    node.random !== String(staged.records[index]?.msgRandom))) fail('INVALID_RESPONSE', 'Staged native resource differs from its verified sources');
                bodies = decoded.nodes.map(node => node.body);
            } else bodies = nodes.map(node => b(1, join(...node.elements.map(element => b(2, b(1, s(1, element.textElement.content)))))));
            phase = 'prepare-resource';
            const sequences = new Set(), randoms = new Set();
            const unique = seen => { let value; do { value = String(crypto.randomInt(1, 0x7fffffff)); } while (seen.has(value)); seen.add(value); return value; };
            const metadata = nodes.map((node, index) => ({ ...node, time: node.time === '0' ? serverTime : node.time, sequence: unique(sequences), random: unique(randoms), body: bodies[index] }));
            const payload = b(2, join(s(1, 'MultiMsg'), b(2, join(...metadata.map(node => b(1, join(
                b(1, join(n(1, node.authorUin), s(6, state.uid), b(7, s(6, node.nickname)))),
                b(2, join(n(1, 9), n(2, 4), n(3, 0), n(4, node.random), n(5, node.sequence), n(6, node.time))), b(3, node.body))))))));
            if (payload.length > protocol.MAX_BYTES) fail('INVALID_PARAMS', 'Custom forward payload exceeds its bound');
            // This body is built only from validated text or the exact native
            // image resource. Public callers cannot provide arbitrary protobuf.
            const prepared = { operation: 'forward.upload', name: 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg', data: {},
                body: join(b(2, join(n(1, target.chatType === 2 ? 3 : 1), b(2, s(2, target.chatType === 2 ? target.peerUid : state.uid)),
                    ...(target.chatType === 2 ? [n(3, target.peerUid)] : []), b(4, gzipSync(payload)))), b(15, join(n(1, 4), n(2, 1), n(3, 7), n(4, 0)))) };
            if (prepared.body.length > 65536) fail('INVALID_PARAMS', 'Custom forward compressed request exceeds its transport bound');
            active(); attempted.add(fingerprint);
            phase = 'upload-resource';
            const uploaded = await raw(prepared), resource = protocol.resource(uploaded.resId, 'INVALID_RESPONSE');
            phase = 'read-resource';
            const readbackRequest = protocol.prepare('forward.readUploaded', { selfUid: state.uid, resId: resource });
            const readback = await raw(readbackRequest);
            phase = 'verify-resource';
            protocol.verifyPayload(payload, Buffer.from(readback.payloadBase64, 'base64'), { authorUids });
            const bytesData = card(resource, nodes);
            phase = 'send-root';
            const record = await capture.sendNativeElements(target, [{ elementType: 10, elementId: '', arkElement: { bytesData, linkInfo: null, subElementType: null } }], context,
                { expectedEpoch: state.epoch, timeoutMs: remaining(), requireSenderUid: true, verifyBeforeSubmit: active });
            active();
            if (!record || typeof record.msgId !== 'string' || !/^[1-9]\d{0,19}$/.test(record.msgId) || BigInt(record.msgId) > 0xffffffffffffffffn ||
                record.chatType !== target.chatType || record.peerUid !== target.peerUid || record.sendStatus !== 2 ||
                record.senderUid !== state.uid || String(record.senderUin) !== state.uin || finalResource(record) !== resource) fail('INVALID_RESPONSE', 'QQ supplied no exact delivered custom resource root');
            phase = 'read-delivered-resource';
            const result = await capture.forwardResourceReadApi.read({ peer: target, rootMsgId: record.msgId, parentMsgId: record.msgId,
                resId: resource, expectedEpoch: state.epoch }, context);
            active();
            if (result?.peer?.chatType !== target.chatType || result.peer.peerUid !== target.peerUid || result.rootMsgId !== record.msgId ||
                result.parentMsgId !== record.msgId || result.resId !== resource || !Array.isArray(result.resourceNodes) ||
                result.resourceNodes.length !== metadata.length) fail('INVALID_RESPONSE', 'QQ custom resource could not be completely read');
            phase = 'verify-delivery';
            for (const [index, child] of result.resourceNodes.entries()) {
                const node = metadata[index];
                if (child.authorUin !== node.authorUin || child.authorUid !== authorUids.get(node.authorUin) || child.time !== node.time ||
                    child.nickname !== node.nickname || elementsSignature(child.elements) !== node.signature) fail('INVALID_RESPONSE', 'Delivered custom forward changed node metadata or content');
            }
            return { confirmed: true, confirmation: 'custom-resource-metadata-and-delivery-readback', destination: target, nodeCount: nodes.length,
                messageId: record.msgId, resId: resource, record, resourceNodes: result.resourceNodes };
        })().catch(error => {
            const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'INVALID_RESPONSE';
            fail(code, 'QQ custom forward failed; phase=' + phase);
        });
        task.finally(() => { if (pending === token) pending = undefined; }).catch(() => {});
        return capture.deadline(() => task, context, remaining());
    }
    return { run, capabilities };
}

module.exports = { createCustomMergedResource, card };
