'use strict';

const fs = require('node:fs');
const codec = require('./codec.cjs');
const media = require('../qq/media.cjs');
const { locator } = require('./store.cjs');
const { normalizeMergedNodes, existingNodeIds } = require('./merged-nodes.cjs');
const { finalResource } = require('../qq/forward.cjs');

const ACTIONS = new Set(['send_private_forward_msg', 'send_group_forward_msg']);
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function account(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) throw problem('INVALID_PARAMS', 'Invalid merged destination account');
    return String(value);
}

async function runMerged(service, state, action, params) {
    const privateTarget = action === 'send_private_forward_msg';
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown merged send action');
    const key = privateTarget ? 'user_id' : 'group_id';
    if (Object.keys(params).some(name => ![key, 'messages', 'self_id'].includes(name))) {
        throw problem('INVALID_PARAMS', 'Unexpected merged send parameters');
    }
    const target = account(params[key]);
    const ids = existingNodeIds(params.messages);
    if (ids) return existingMerge(service, state, action, target, ids);
    // Validate the complete batch before media preparation or any QQ write.
    const nodes = normalizeMergedNodes(params.messages, { selfId: String(state.self.uin) });
    if (state.capabilities?.mergeCustom !== true) throw problem('UNSUPPORTED', 'QQ custom merged sending is unavailable');
    const metadata = nodes.some(node => node.user_id !== String(state.self.uin) || Object.hasOwn(node, 'time'));
    if (metadata && state.capabilities?.mergeCustomMetadata !== true) throw problem('UNSUPPORTED', 'QQ custom merged author and time support is unavailable');
    const hasImages = nodes.some(node => node.content.some(segment => segment.type === 'image'));
    if (hasImages && (state.capabilities?.image !== true || !service.mediaDirectory)) {
        throw problem('UNSUPPORTED', 'Merged images require native image preparation');
    }
    const resolved = privateTarget ? await service.sessionCall(state, 'resolve', { uin: target }) : null;
    if (privateTarget && (String(resolved?.uin) !== target || typeof resolved?.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(resolved.uid))) {
        throw problem('NOT_FOUND', 'Merged private destination has no verified UID');
    }
    const destination = { chatType: privateTarget ? 1 : 2, peerUid: privateTarget ? resolved.uid : target };
    const source = { chatType: 1, peerUid: state.self.uid };
    const temporary = new Set(), prepared = [];
    const operation = service.operation?.getStore();
    try {
        if (operation) operation.stage = 'prepareForward';
        // Every node is prepared before the bridge is permitted to stage one.
        for (const node of nodes) {
            const segments = node.content.map(segment => ({ type: segment.type, data: { ...segment.data } }));
            for (const segment of segments) if (segment.type === 'image') {
                const exported = media.exportImage(service.mediaDirectory, media.readImage(service.mediaDirectory, segment.data.file));
                temporary.add(exported.path);
                segment.data.file = exported.path;
            }
            const elements = await codec.toKernel(segments, {
                peer: source,
                prepareMedia: data => service.sessionCall(state, 'prepareMedia', { type: 'image', ...data })
            });
            prepared.push({ nickname: node.nickname, elements, ...(metadata ? { authorUin: node.user_id, ...(Object.hasOwn(node, 'time') ? { time: node.time } : {}) } : {}) });
        }
        await service.assertSession(state);
        if (operation) operation.stage = 'sendForward';
        const result = await service.sessionCall(state, 'forwardOperation', {
            kind: metadata ? 'customResourceMerge' : 'customMerge', destination, nodes: prepared, timeoutMs: service.remaining()
        });
        await service.assertSession(state);
        if (result?.confirmed !== true || result.confirmation !== (metadata ? 'custom-resource-metadata-and-delivery-readback' : 'fresh-source-tuple-and-resource-readback') ||
            result.destination?.chatType !== destination.chatType || result.destination.peerUid !== destination.peerUid ||
            result.nodeCount !== nodes.length || typeof result.resId !== 'string' || !result.resId ||
            typeof result.messageId !== 'string' || !/^[1-9]\d{0,19}$/.test(result.messageId) ||
            BigInt(result.messageId) > 0xffffffffffffffffn || result.record?.msgId !== result.messageId ||
            result.record?.sendStatus !== 2 || result.record?.senderUid !== state.self.uid ||
            String(result.record?.senderUin) !== String(state.self.uin)) {
            throw problem('INVALID_RESPONSE', 'QQ supplied no verified completed merged delivery');
        }
        if (finalResource(result.record) !== result.resId) throw problem('INVALID_RESPONSE', 'Merged confirmation resource differs from its actual root');
        const actual = locator(result.record);
        if (actual.peer.chatType !== destination.chatType || actual.peer.peerUid !== destination.peerUid) {
            throw problem('INVALID_RESPONSE', 'Merged confirmation belongs to another conversation');
        }
        const entry = service.store.remember(String(state.self.uin), result.record);
        return { message_id: entry.id };
    } finally {
        for (const file of temporary) {
            try { fs.unlinkSync(file); }
            catch (error) { if (error.code !== 'ENOENT') service.log('forward_import_cleanup_failed', { code: 'MEDIA_CLEANUP' }); }
        }
    }
}

async function existingMerge(service, state, action, target, ids) {
    if (action !== 'send_group_forward_msg') throw problem('UNSUPPORTED', 'Existing merged ID nodes currently require their original group');
    if (state.capabilities?.mergeExistingNative !== true) throw problem('UNSUPPORTED', 'Native existing-message merging is unavailable');
    const source = { chatType: 2, peerUid: target }, msgIds = [];
    for (const id of ids) {
        const record = await service.record(state, id, source, { refresh: true }), where = locator(record);
        if (where.peer.chatType !== 2 || where.peer.peerUid !== target) throw problem('INVALID_PARAMS', 'Existing merged nodes must belong to their destination group');
        if (!/^[1-9]\d{0,19}$/.test(where.nativeId) || BigInt(where.nativeId) > 0xffffffffffffffffn) throw problem('INVALID_RESPONSE', 'Source message has no exact native identity');
        if (!Array.isArray(record.elements) || !record.elements.length || record.elements.some(element => element?.elementType !== 1 ||
            !element.textElement || typeof element.textElement.content !== 'string' ||
            element.textElement.atType !== undefined && element.textElement.atType !== 0)) throw problem('UNSUPPORTED', 'Existing native merges currently require complete ordinary text messages');
        msgIds.push(where.nativeId);
    }
    if (new Set(msgIds).size !== msgIds.length) throw problem('INVALID_PARAMS', 'Existing nodes share a native source identity');
    const result = await service.sessionCall(state, 'forwardOperation', { kind: 'existingMerge', source, msgIds,
        timeoutMs: service.remaining() });
    if (result?.confirmed !== true || result.confirmation !== 'correlated-native-merge-and-resource-readback' ||
        result.source?.chatType !== 2 || result.source.peerUid !== target || result.destination?.chatType !== 2 || result.destination.peerUid !== target ||
        !Array.isArray(result.sourceMsgIds) || result.sourceMsgIds.length !== msgIds.length || result.sourceMsgIds.some((id, index) => id !== msgIds[index]) ||
        !Array.isArray(result.records) || result.records.length !== ids.length || typeof result.messageId !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(result.messageId) || BigInt(result.messageId) > 0xffffffffffffffffn || msgIds.includes(result.messageId) ||
        result.record?.msgId !== result.messageId || result.record?.sendStatus !== 2 || result.record?.senderUid !== state.self.uid ||
        String(result.record?.senderUin) !== String(state.self.uin) || typeof result.resId !== 'string' || !result.resId ||
        finalResource(result.record) !== result.resId) throw problem('INVALID_RESPONSE', 'QQ supplied no complete correlated existing-message merge proof');
    const actual = locator(result.record);
    if (actual.peer.chatType !== 2 || actual.peer.peerUid !== target) throw problem('INVALID_RESPONSE', 'Existing merged delivery belongs to another group');
    const entry = service.store.remember(String(state.self.uin), result.record);
    return { message_id: entry.id };
}

module.exports = { ACTIONS, runMerged };
