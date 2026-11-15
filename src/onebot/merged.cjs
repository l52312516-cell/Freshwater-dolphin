'use strict';

const fs = require('node:fs');
const codec = require('./codec.cjs');
const media = require('../qq/media.cjs');
const { locator } = require('./store.cjs');
const { normalizeMergedNodes } = require('./merged-nodes.cjs');
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
    // Validate the complete batch before media preparation or any QQ write.
    const nodes = normalizeMergedNodes(params.messages, { selfId: String(state.self.uin) });
    if (state.capabilities?.mergeCustom !== true) throw problem('UNSUPPORTED', 'QQ custom merged sending is unavailable');
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
            prepared.push({ nickname: node.nickname, elements });
        }
        await service.assertSession(state);
        if (operation) operation.stage = 'sendForward';
        const result = await service.sessionCall(state, 'forwardOperation', {
            kind: 'customMerge', destination, nodes: prepared, timeoutMs: service.remaining()
        });
        await service.assertSession(state);
        if (result?.confirmed !== true || result.confirmation !== 'fresh-source-tuple-and-resource-readback' ||
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

module.exports = { ACTIONS, runMerged };
