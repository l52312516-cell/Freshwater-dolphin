'use strict';

const { setTimeout: pause } = require('node:timers/promises');
const media = require('./media.cjs');
const { createGroupWeb } = require('./group-web.cjs');
const fixed = require('./fixed-oidb.cjs');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
    if (!plain(value) || Object.keys(value).some(key => !['operation', 'expectedEpoch'].includes(key) && !allowed.includes(key))) fail('INVALID_PARAMS', 'Unexpected extended QQ parameters');
}
function number(value, positive = false, max = 0xffffffffn) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^(0|[1-9]\d{0,19})$/.test(String(value)) || BigInt(value) > max || positive && BigInt(value) === 0n) fail('INVALID_PARAMS', 'Invalid exact QQ integer');
    return String(value);
}
function uid(value) { if (typeof value !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value)) fail('INVALID_PARAMS', 'Expected a real QQ UID'); return value; }
function text(value, max, empty = false) {
    if (typeof value !== 'string' || !empty && !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max || Buffer.from(value).toString('utf8') !== value) fail('INVALID_PARAMS', 'Invalid bounded QQ text'); return value;
}
function bool(value, fallback) { if (value === undefined && fallback !== undefined) return fallback; if (typeof value !== 'boolean') fail('INVALID_PARAMS', 'Expected an explicit boolean'); return value; }
function peer(value) {
    if (!plain(value) || Object.keys(value).some(key => !['chatType', 'peerUid'].includes(key)) || ![1, 2].includes(value.chatType)) fail('INVALID_PARAMS', 'Invalid extended peer');
    return { chatType: value.chatType, peerUid: value.chatType === 1 ? uid(value.peerUid) : number(value.peerUid, true) };
}
function acceptance(value, optional = false) {
    if (value === undefined && optional) return;
    if (!plain(value)) fail('INVALID_RESPONSE', 'QQ supplied no explicit operation completion');
    const codes = ['result', 'errCode', 'errorCode'].filter(key => Object.hasOwn(value, key));
    if (!codes.length) fail('INVALID_RESPONSE', 'QQ completion has no recognized business status');
    if (codes.some(key => value[key] !== 0 && value[key] !== '0')) fail('KERNEL_ERROR', 'QQ rejected the operation; no retry was attempted');
}
function reactionState(record, emojiId) {
    const items = record.emojiLikesList, expectedType = emojiId.length > 3 ? '2' : '1', identities = new Set();
    if (!Array.isArray(items) || items.length > 1000) fail('INVALID_RESPONSE', 'QQ omitted a complete bounded reaction state');
    let clicked = false;
    for (const item of items) {
        if (!plain(item) || typeof item.emojiId !== 'string' || !/^(0|[1-9]\d{0,6})$/.test(item.emojiId) ||
            !['1', '2'].includes(item.emojiType) || typeof item.likesCnt !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(item.likesCnt) ||
            BigInt(item.likesCnt) > 0xffffffffn || typeof item.isClicked !== 'boolean' || item.isClicked && item.likesCnt === '0') {
            fail('INVALID_RESPONSE', 'QQ supplied an invalid reaction state');
        }
        const identity = item.emojiType + ':' + item.emojiId;
        if (identities.has(identity)) fail('INVALID_RESPONSE', 'QQ returned duplicate reaction identities');
        identities.add(identity);
        if (item.emojiId === emojiId && item.emojiType === expectedType) clicked = item.isClicked;
    }
    return clicked;
}
const ACTIONS = {
    'message.poke': ['peer', 'targetUid', 'targetUin'], 'message.emoji': ['peer', 'groupId', 'nativeId', 'sequence', 'emojiId', 'set'],
    'group.essence': ['groupId', 'nativeId', 'sequence', 'random', 'set'], 'group.memberTitle': ['groupId', 'uid', 'title'],
    'friend.category': ['uid', 'categoryId'], 'friend.delete': ['uid', 'block', 'both'], 'self.status': ['status', 'extStatus', 'batteryStatus'],
    'self.avatar': ['file'], 'group.avatar': ['groupId', 'file'],
    'group.noticePublish': ['groupId', 'content'], 'group.noticeDelete': ['groupId', 'noticeId']
};
const QUERIES = { 'group.noticeList': ['groupId', 'page', 'count'], 'group.essenceList': ['groupId', 'start', 'count'], 'group.honor': ['groupId', 'type'],
    'image.ocr': ['imageUrl'], 'voice.characters': ['groupId', 'chatType'], 'face.list': [], 'face.get': ['faceId'] };
function createExtended(capture, options = {}) {
    const native = options.native || require('./msf-native.cjs');
    const web = createGroupWeb(capture, options);
    const writes = new Map(); let epoch;
    function capabilities() {
        const sso = native.available();
        const groupWeb = web.supported();
        return { messagePoke: sso, messageEmoji: sso, groupEssence: sso, groupSpecialTitle: sso,
            friendCategorySet: sso && capture.hasMethods('profile', ['getCoreAndBaseInfo']) && capture.hasMethods('buddy', ['isBuddy']),
            groupNoticeList: groupWeb, groupNoticePublish: groupWeb, groupNoticeDelete: groupWeb, groupEssenceList: groupWeb, groupHonor: groupWeb,
            friendDelete: capture.hasMethods('buddy', ['isBuddy', 'delBuddy']), selfStatus: capture.hasMethods('msg', ['setStatus']),
            selfAvatar: typeof capture.mediaDirectory === 'string' && capture.hasMethods('profile', ['setHeader']),
            groupAvatar: typeof capture.mediaDirectory === 'string' && capture.hasMethods('group', ['setHeader']),
            imageOcr: sso, aiVoiceCharacters: sso, systemFaceList: sso, systemFaceGet: sso };
    }
    function state(params, context) {
        capture.ensureReady();
        if (params.expectedEpoch !== capture.epoch) fail('SESSION_CHANGED', 'Extended operation must bind the current QQ session');
        if (epoch !== capture.epoch) { epoch = capture.epoch; writes.clear(); }
        const value = { epoch: capture.epoch, session: capture.session, ...capture.self };
        const active = () => {
            capture.ensureReady();
            if (capture.epoch !== value.epoch || capture.session !== value.session || capture.self?.uin !== value.uin || capture.self?.uid !== value.uid) fail('SESSION_CHANGED', 'QQ changed during the extended operation');
            if (context.signal?.aborted || Date.now() >= (context.expiresAt ?? Infinity)) fail('EXPIRED', 'Extended operation expired; its result may be unknown');
        };
        active(); return { value, active };
    }
    async function fixedCall(operation, request, context, saved) {
        saved.active(); fixed.prepare(operation, request); // Validate all fields before priming or submitting QQ.
        const result = await native.run(capture, { op: 'fixedExtended', operation, request, expectedEpoch: saved.value.epoch,
            expectedUin: saved.value.uin, signal: context.signal,
            timeoutMs: Math.max(1, Math.min(10000, (context.expiresAt ?? Date.now() + 10000) - Date.now())) });
        saved.active(); return result;
    }
    async function locate(data, saved) {
        const target = data.peer ? peer(data.peer) : { chatType: 2, peerUid: number(data.groupId, true) };
        if (target.chatType !== 2 || data.groupId !== undefined && number(data.groupId, true) !== target.peerUid) fail('INVALID_PARAMS', 'This operation requires its exact group conversation');
        const nativeId = number(data.nativeId, true, 0xffffffffffffffffn), sequence = number(data.sequence, true);
        saved.active(); const record = await capture.getMessage({ peer: target, nativeId }); saved.active();
        if (String(record.msgSeq) !== sequence || record.msgId !== nativeId || String(record.peerUid) !== target.peerUid || record.chatType !== 2) fail('INVALID_RESPONSE', 'QQ returned another message locator');
        return { record, groupId: target.peerUid, sequence };
    }
    async function perform(data, context, saved) {
        const operation = data.operation;
        if (operation.startsWith('group.notice')) {
            const groupId = number(data.groupId, true), request = operation === 'group.noticePublish' ?
                { groupId, content: text(data.content, 20000) } : { groupId, noticeId: text(data.noticeId, 1024) };
            return web.execute(operation, request, context, saved.value);
        }
        if (operation === 'message.poke') {
            const target = peer(data.peer), targetUid = uid(data.targetUid);
            if (target.chatType === 1 && target.peerUid !== targetUid) fail('INVALID_PARAMS', 'Poke target differs from the private peer');
            const identity = await capture.resolve({ uid: targetUid }); saved.active();
            if (identity.uid !== targetUid || data.targetUin !== undefined && number(data.targetUin, true) !== String(identity.uin)) fail('INVALID_RESPONSE', 'Poke UID and account do not match');
            const result = await fixedCall(operation, { chatType: target.chatType, peerUin: target.chatType === 2 ? target.peerUid : number(identity.uin, true), targetUin: number(identity.uin, true) }, context, saved);
            return { ...result, peer: target, targetUid, ...(data.targetUin !== undefined ? { targetUin: data.targetUin } : {}) };
        }
        if (operation === 'message.emoji' || operation === 'group.essence') {
            const where = await locate(data, saved);
            const request = { groupId: where.groupId, sequence: where.sequence, set: bool(data.set) };
            if (operation === 'message.emoji') request.emojiId = text(data.emojiId, 7);
            else {
                request.random = number(data.random);
                const observed = [where.record.msgRandom, where.record.msg_random].filter(value => value !== undefined && value !== null);
                if (!observed.length || observed.some(value => number(value) !== request.random)) fail('INVALID_RESPONSE', 'Message has no matching explicitly observed random value');
            }
            const result = await fixedCall(operation, request, context, saved);
            if (operation === 'message.emoji') {
                const until = Math.min(Date.now() + 10000, context.expiresAt ?? Infinity);
                for (;;) {
                    const observed = await locate(data, saved);
                    if (reactionState(observed.record, request.emojiId) === request.set) {
                        return { ...result, confirmed: true, confirmation: 'message_readback', nativeId: data.nativeId,
                            ...(data.peer ? { peer: peer(data.peer) } : {}) };
                    }
                    if (Date.now() >= until) fail('TIMEOUT', 'QQ did not confirm the requested reaction state; it was not retried');
                    await pause(Math.max(1, Math.min(150, until - Date.now()))); saved.active();
                }
            }
            return { ...result, nativeId: data.nativeId, ...(data.peer ? { peer: peer(data.peer) } : {}) };
        }
        if (operation === 'group.memberTitle') return fixedCall('group.title', { groupId: number(data.groupId, true), uid: uid(data.uid), title: text(data.title, 256, true) }, context, saved);
        if (operation === 'friend.category') {
            const target = uid(data.uid), categoryId = Number(number(data.categoryId));
            if (capture.invoke('buddy', 'isBuddy', [target]) !== true) fail('NOT_FOUND', 'The category target is not a confirmed friend');
            const result = await fixedCall(operation, { uid: target, categoryId }, context, saved);
            for (;;) {
                const observed = await capture.user({ uid: target }, context); saved.active();
                if (observed.uid !== target) fail('INVALID_RESPONSE', 'Friend category readback belongs to another account');
                if (observed.category_id === categoryId) return { ...result, confirmation: 'profile_readback' };
                await pause(150); saved.active();
            }
        }
        if (operation === 'friend.delete') {
            const target = uid(data.uid), block = bool(data.block, false), both = bool(data.both, false);
            if (capture.invoke('buddy', 'isBuddy', [target]) !== true) fail('NOT_FOUND', 'The target is not a confirmed friend');
            saved.active(); acceptance(await capture.invoke('buddy', 'delBuddy', [{ friendUid: target, tempBlock: block, tempBothDel: both }]), !block && !both); saved.active();
            for (;;) {
                const exists = capture.invoke('buddy', 'isBuddy', [target]);
                if (exists === false) return { uid: target, block, both, confirmed: true, confirmation: 'friend_absence' };
                if (exists !== true) fail('INVALID_RESPONSE', 'QQ returned no definite friendship state');
                await pause(150); saved.active();
            }
        }
        if (operation === 'self.status') {
            const request = Object.fromEntries(['status', 'extStatus', 'batteryStatus'].map(key => [key, Number(number(data[key]))]));
            saved.active(); acceptance(await capture.invoke('msg', 'setStatus', [request])); saved.active();
            return { ...request, confirmed: true, confirmation: 'kernel_ack' };
        }
        if (operation === 'self.avatar' || operation === 'group.avatar') {
            if (typeof data.file !== 'string' || !/^fwd-image-[a-f0-9]{32}$/.test(data.file)) fail('INVALID_PARAMS', 'Avatar requires an owned opaque image resource');
            const image = media.resourceInfo(capture.mediaDirectory, data.file);
            const groupId = operation === 'group.avatar' ? number(data.groupId, true) : undefined;
            saved.active(); acceptance(await capture.invoke(groupId ? 'group' : 'profile', 'setHeader', groupId ? [groupId, image.path] : [image.path])); saved.active();
            return { file: data.file, ...(groupId ? { groupId } : {}), confirmed: true, confirmation: 'kernel_ack' };
        }
        fail('UNSUPPORTED', 'No fixed implementation for this extended action');
    }
    async function action(data, context = {}) {
        if (!Object.hasOwn(ACTIONS, data?.operation)) fail('UNSUPPORTED', 'Unknown extended QQ action');
        fields(data, ACTIONS[data.operation]); const saved = state(data, context);
        const key = [data.operation, data.groupId || '', data.uid || data.targetUid || '', data.nativeId || ''].join(':');
        if (writes.has(key) || writes.size >= 256) fail('BUSY', 'An extended operation is already awaiting its result');
        const token = {}, pending = Promise.resolve().then(() => { saved.active(); return perform(data, context, saved); });
        writes.set(key, token);
        pending.finally(() => { if (writes.get(key) === token) writes.delete(key); }).catch(() => {});
        const result = await capture.deadline(() => pending, context);
        saved.active(); return { ...result, operation: data.operation };
    }
    async function query(data, context = {}) {
        if (!Object.hasOwn(QUERIES, data?.operation)) fail('UNSUPPORTED', 'Unknown extended QQ query');
        fields(data, QUERIES[data.operation]); const saved = state(data, context), request = {};
        for (const key of QUERIES[data.operation]) if (data[key] !== undefined) request[key] = data[key];
        if (data.operation.startsWith('group.')) {
            request.groupId = number(data.groupId, true);
            for (const key of ['page', 'start']) if (request[key] !== undefined) request[key] = Number(number(request[key], false, 0x7fffffffn));
            if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > 100)) fail('INVALID_PARAMS', 'Invalid extended query page size');
            if (data.operation === 'group.honor' && !['talkative', 'performer', 'legend', 'emotion'].includes(request.type)) fail('UNSUPPORTED', 'Unknown QQ honor collection');
            const result = await web.execute(data.operation, request, context, saved.value); saved.active(); return result;
        }
        const result = await fixedCall(data.operation, request, context, saved);
        if (data.operation === 'image.ocr') return { ...result, imageUrl: request.imageUrl };
        if (data.operation === 'voice.characters') return { ...result, groupId: number(request.groupId, true), chatType: request.chatType ?? 1, characters: result.categories };
        if (data.operation === 'face.list') return { ...result, faces: result.packs.flatMap(pack => pack.emojis.map(face => ({ ...face, source: pack.source, ...(pack.packName !== undefined ? { packName: pack.packName } : {}) }))) };
        if (data.operation === 'face.get') return { ...result, faceId: String(request.faceId) };
        return result;
    }
    return { capabilities, action, query };
}
module.exports = { createExtended, ACTIONS, QUERIES };
