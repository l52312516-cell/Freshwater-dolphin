'use strict';

const { randomBytes } = require('node:crypto');
const codec = require('./codec.cjs');
const { descriptor, rootDescriptor } = require('../qq/forward.cjs');
const ACTIONS = new Set(['get_forward_msg', 'qqapi_get_forward_messages', 'qqapi_message_forward']);
const IMAGE_HOSTS = new Set(['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);
const NT_IMAGE_HOSTS = new Set(['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com']);
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
        throw problem('INVALID_PARAMS', 'Unexpected forward action parameters');
    }
}
function exactId(value, label = 'message ID') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw problem('INVALID_RESPONSE', 'Invalid full '+label);
    return value;
}
function account(value) {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,9}$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) {
        throw problem('INVALID_PARAMS', 'Invalid QQ account or group');
    }
    return String(value);
}
function shortId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) || !Number.isInteger(Number(value)) ||
        Number(value) < -0x80000000 || Number(value) > 0x7fffffff) throw problem('INVALID_PARAMS', 'Invalid OneBot message_id');
    return Number(value);
}
function target(record) {
    const peer = { chatType: record?.chatType, peerUid: record?.peerUid };
    if (peer.chatType === 1 ? typeof peer.peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(peer.peerUid) :
        peer.chatType !== 2 || typeof peer.peerUid !== 'string' || account(peer.peerUid) !== peer.peerUid) {
        throw problem('INVALID_RESPONSE', 'Merged root has no real native conversation');
    }
    return peer;
}
function bindingState(state) {
    if (!state?.ready || typeof state.epoch !== 'string' || !state.epoch || typeof state.self?.uid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(state.self.uid)) {
        throw problem('NOT_READY', 'A real authenticated session is required for forward handles');
    }
    return JSON.stringify([account(state.self.uin), state.self.uid, state.epoch]);
}

function createForwardRegistry({ now = Date.now, ttlMs = 60000, maxHandles = 2048 } = {}) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000 || !Number.isInteger(maxHandles) || maxHandles < 1 || maxHandles > 10000) throw new TypeError('Invalid forward registry bounds');
    const handles = new Map(), identities = new Map();
    let current;
    function sync(state) {
        const identity = bindingState(state);
        if (current !== identity) { handles.clear(); identities.clear(); current = identity; }
        for (const [handle, binding] of handles) if (binding.expiresAt <= now()) { handles.delete(handle); identities.delete(binding.key); }
    }
    function put(state, binding) {
        sync(state);
        const key = JSON.stringify([binding.peer, binding.rootMsgId, binding.parentMsgId, binding.resId, binding.nodeResId]);
        const existing = identities.get(key);
        if (existing && handles.has(existing)) return existing;
        while (handles.size >= maxHandles) {
            const first = handles.keys().next().value;
            identities.delete(handles.get(first).key); handles.delete(first);
        }
        const handle = 'fwd_' + randomBytes(24).toString('base64url');
        handles.set(handle, { ...binding, peer: { ...binding.peer }, key, scope: current, expiresAt: now() + ttlMs });
        identities.set(key, handle);
        return handle;
    }
    function get(state, handle) {
        sync(state);
        if (typeof handle !== 'string' || !/^fwd_[A-Za-z0-9_-]{32}$/.test(handle)) throw problem('INVALID_PARAMS', 'get_forward_msg requires an observed opaque forward handle');
        const entry = handles.get(handle);
        if (!entry || entry.scope !== current) throw problem('NOT_FOUND', 'Forward handle is expired or belongs to another account session');
        const { key, scope, ...binding } = entry;
        return { ...binding, peer: { ...binding.peer } };
    }
    function register(state, record, element) {
        const root = rootDescriptor(record), selected = descriptor(element);
        if (!selected || !record.elements.includes(element) || root.resId !== selected.resId) throw problem('INVALID_RESPONSE', 'Forward element does not belong to this observed root');
        const nativeId = exactId(record.msgId);
        return put(state, { peer: target(record), rootMsgId: nativeId, parentMsgId: nativeId, resId: root.resId, nodeResId: root.resId });
    }
    function registerChild(state, parent, record, element) {
        sync(state);
        const root = get(state, parent), selected = descriptor(element);
        if (!selected || !record.elements?.includes(element)) throw problem('INVALID_RESPONSE', 'Invalid observed nested forward');
        const nested = record.elements.map(descriptor).filter(Boolean);
        if (nested.length !== 1) throw problem('INVALID_RESPONSE', 'Nested merged message has multiple resource identities');
        const nativeId = exactId(record.msgId);
        if (nativeId === root.rootMsgId) throw problem('INVALID_RESPONSE', 'Merged-forward nesting contains a root cycle');
        return put(state, { peer: root.peer, rootMsgId: root.rootMsgId, parentMsgId: nativeId, resId: root.resId, nodeResId: selected.resId });
    }
    return { register, registerChild, get, clear() { handles.clear(); identities.clear(); current = undefined; } };
}

function officialImageUrl(value, relative = false) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 16384 || /[\\\x00-\x20\x7f]/.test(value)) {
        throw problem('UNSUPPORTED', 'Merged image has no complete official resource URL');
    }
    let url;
    try {
        if (relative && value.startsWith('/download?')) url = new URL(value, 'https://multimedia.nt.qq.com.cn');
        else url = new URL(value);
    } catch { throw problem('UNSUPPORTED', 'Merged image has no complete official resource URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !IMAGE_HOSTS.has(url.hostname)) {
        throw problem('UNSUPPORTED', 'Merged image is not an official HTTPS resource');
    }
    return url;
}

async function mergedImage(service, state, element) {
    // getMultiMsg children are not normal messages in the outer conversation.
    // Use only their actual QQ resource locator; never call receiveMedia or
    // getMessage with a child ID and the root peer to manufacture a download.
    const picture = element.picElement;
    if (!picture || picture.isFlashPic === true) throw problem('UNSUPPORTED', 'Merged flash image is not supported');
    const url = officialImageUrl(picture.originImageUrl, true);
    let needsKey = false, isGroup;
    if (NT_IMAGE_HOSTS.has(url.hostname) && url.pathname === '/download') {
        if ([...url.searchParams.keys()].some(key => !['appid', 'fileid', 'spec', 'rkey'].includes(key)) ||
            [...new Set(url.searchParams.keys())].some(key => url.searchParams.getAll(key).length !== 1)) {
            throw problem('UNSUPPORTED', 'Merged image has an unverified or ambiguous download locator');
        }
        const appid = url.searchParams.get('appid'), fileId = url.searchParams.get('fileid');
        if (!['1406', '1407'].includes(appid) || typeof fileId !== 'string' || !fileId || fileId.length > 4096 || /[\x00-\x20\x7f]/.test(fileId)) {
            throw problem('UNSUPPORTED', 'Merged image requires an actual QQ appid and file identity');
        }
        // A forwarded private image can be inside a group merged message.
        // Its own QQ appid, rather than the outer peer, determines the rkey.
        isGroup = appid === '1407';
        const existingKey = url.searchParams.get('rkey');
        if (existingKey && /[\x00-\x20\x7f]/.test(existingKey)) throw problem('INVALID_RESPONSE', 'Merged image has an invalid native rkey');
        needsKey = !url.searchParams.get('rkey');
    }
    let resolved = url;
    if (needsKey || NT_IMAGE_HOSTS.has(url.hostname) && url.pathname === '/download' &&
        typeof service.globalServices?.resolveImageUrl === 'function') {
        if (typeof service.globalServices?.resolveImageUrl !== 'function') throw problem('UNSUPPORTED', 'Merged image needs a configured rkey service');
        await service.assertSession(state);
        const operation = service.operation?.getStore();
        if (operation) operation.stage = 'resolveForwardImage';
        resolved = officialImageUrl(await service.globalServices.resolveImageUrl(url.href, isGroup, { timeoutMs: service.remaining() }));
        await service.assertSession(state);
        if (resolved.origin !== url.origin || resolved.pathname !== url.pathname ||
            [...url.searchParams.keys()].filter(key => key !== 'rkey').some(key => !isDeepEqualQuery(url, resolved, key)) ||
            [...resolved.searchParams.keys()].some(key => key !== 'rkey' && !url.searchParams.has(key)) ||
            resolved.searchParams.getAll('rkey').length !== 1 || !resolved.searchParams.get('rkey') ||
            /[\x00-\x20\x7f]/.test(resolved.searchParams.get('rkey'))) {
            throw problem('INVALID_RESPONSE', 'The rkey service changed the observed merged image identity');
        }
        if (operation) operation.stage = 'convertForward';
    }
    const identifiers = [picture.md5HexStr, picture.fileName, picture.fileUuid, element.elementId];
    const file = identifiers.find(value => typeof value === 'string' && value && Buffer.byteLength(value) <= 1024 && !/[\\/\x00-\x1f\x7f]/.test(value));
    if (!file) throw problem('INVALID_RESPONSE', 'Merged image has no native resource identity');
    return { file, url: resolved.href };
}
function isDeepEqualQuery(first, second, key) {
    const a = first.searchParams.getAll(key), b = second.searchParams.getAll(key);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function forwardMessages(service, state, registry, handle) {
    const binding = registry.get(state, handle);
    const result = await service.sessionCall(state, 'forwardOperation', { kind: 'read', peer: binding.peer,
        rootMsgId: binding.rootMsgId, parentMsgId: binding.parentMsgId, resId: binding.resId });
    if (!result || result.rootMsgId !== binding.rootMsgId || result.parentMsgId !== binding.parentMsgId || result.resId !== binding.resId ||
        result.peer?.chatType !== binding.peer.chatType || result.peer.peerUid !== binding.peer.peerUid || !Array.isArray(result.records) || result.records.length > 1000) {
        throw problem('INVALID_RESPONSE', 'QQ returned a different merged-forward root or parent');
    }
    const operation = service.operation?.getStore();
    if (operation) operation.stage = 'convertForward';
    const messages = [];
    for (const record of result.records) {
        exactId(record?.msgId);
        let sender = record.senderUin;
        if (sender === undefined || sender === null || sender === '' || sender === 0 || sender === '0') {
            if (typeof record.senderUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(record.senderUid)) throw problem('INVALID_RESPONSE', 'Merged node has no real author');
            const resolved = await service.sessionCall(state, 'resolve', { uid: record.senderUid });
            if (resolved?.uid !== record.senderUid) throw problem('INVALID_RESPONSE', 'Merged-node author resolution is inconsistent');
            sender = resolved.uin;
        }
        const userId = Number(account(sender)), timestamp = Number(record.msgTime);
        if (!['string', 'number'].includes(typeof record.msgTime) || !/^[1-9]\d*$/.test(String(record.msgTime)) || !Number.isSafeInteger(timestamp)) throw problem('INVALID_RESPONSE', 'Merged node has no reliable timestamp');
        const content = await codec.fromKernel(record, {
            selfUin: String(state.self.uin), selfUid: state.self.uid,
            queryFiles: true,
            resolveUid: uid => service.sessionCall(state, 'resolve', { uid }),
            forward: element => ({ id: registry.registerChild(state, handle, record, element) }),
            image: element => mergedImage(service, state, element),
            record: () => { throw problem('UNSUPPORTED', 'Merged-forward voice download context is not verified'); },
            video: () => { throw problem('UNSUPPORTED', 'Merged-forward video download context is not verified'); },
            reply: () => { throw problem('UNSUPPORTED', 'Merged-forward quoted-message identity is not verified'); }
        });
        const nickname = record.sendNickName ?? record.senderNickname;
        if (nickname !== undefined && typeof nickname !== 'string') throw problem('INVALID_RESPONSE', 'Merged node has an invalid nickname');
        messages.push({ time: timestamp, sender: { user_id: userId, nickname: nickname ?? '' }, content,
            ...(typeof record.sendMemberName === 'string' ? { sender_card: record.sendMemberName } : {}) });
    }
    await service.assertSession(state);
    // OneBot v11 names the node-segment array `message`. Common QQ clients
    // additionally consume `messages` with per-node sender/time/content.
    const message = messages.map(node => ({ type: 'node', data: {
        user_id: String(node.sender.user_id), nickname: node.sender.nickname, content: node.content
    } }));
    return { message, messages };
}

async function runForward(service, state, action, params) {
    if (!ACTIONS.has(action)) throw problem('UNSUPPORTED', 'Unknown forward action');
    const registry = service.forwardRegistry;
    if (!registry) throw problem('UNSUPPORTED', 'Observed forward registry is unavailable');
    if (action !== 'qqapi_message_forward') {
        if (state.capabilities?.forwardRead !== true) throw problem('UNSUPPORTED', 'QQ merged-forward reading is unavailable');
        if (action === 'get_forward_msg') {
            fields(params, ['id', 'self_id']);
            return forwardMessages(service, state, registry, params.id);
        }
        fields(params, ['message_id', 'parent', 'self_id']);
        const record = await service.record(state, shortId(params.message_id), undefined, { refresh: true });
        const element = record.elements?.find(item => descriptor(item));
        const rootHandle = registry.register(state, record, element);
        let handle = rootHandle;
        if (params.parent !== undefined) {
            const root = registry.get(state, rootHandle), nested = registry.get(state, params.parent);
            if (root.rootMsgId !== nested.rootMsgId || root.resId !== nested.resId || root.peer.chatType !== nested.peer.chatType || root.peer.peerUid !== nested.peer.peerUid) {
                throw problem('INVALID_PARAMS', 'Nested forward belongs to a different merged root');
            }
            handle = params.parent;
        }
        return { id: handle, ...await forwardMessages(service, state, registry, handle) };
    }
    fields(params, ['message_ids', 'group_id', 'user_id', 'self_id']);
    if (state.capabilities?.forwardExisting !== true) throw problem('UNSUPPORTED', 'QQ existing-message forwarding is unavailable');
    if (!Array.isArray(params.message_ids) || !params.message_ids.length || params.message_ids.length > 50) throw problem('INVALID_PARAMS', 'message_ids must contain 1 to 50 OneBot IDs');
    const ids = params.message_ids.map(shortId);
    if (new Set(ids).size !== ids.length) throw problem('INVALID_PARAMS', 'Duplicate source message IDs');
    if ((params.group_id !== undefined) === (params.user_id !== undefined)) throw problem('INVALID_PARAMS', 'Specify exactly one destination group_id or user_id');
    const targetUin = account(params.group_id ?? params.user_id), privateTarget = params.user_id !== undefined;
    let destination;
    if (privateTarget) {
        const resolved = await service.sessionCall(state, 'resolve', { uin: targetUin });
        if (String(resolved?.uin) !== targetUin || typeof resolved.uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(resolved.uid)) throw problem('NOT_FOUND', 'Private destination has no verified UID');
        destination = { chatType: 1, peerUid: resolved.uid };
    } else destination = { chatType: 2, peerUid: targetUin };
    let source;
    const nativeIds = [];
    for (const id of ids) {
        const record = await service.record(state, id, source, { refresh: true });
        const actual = target(record);
        if (source && (actual.chatType !== source.chatType || actual.peerUid !== source.peerUid)) throw problem('INVALID_PARAMS', 'Forward source messages must belong to one exact conversation');
        source = actual;
        nativeIds.push(exactId(record.msgId));
    }
    if (new Set(nativeIds).size !== nativeIds.length) throw problem('INVALID_PARAMS', 'Duplicate native source identities');
    const result = await service.sessionCall(state, 'forwardOperation', { kind: 'forward', source, destination, msgIds: nativeIds });
    if (result?.confirmed !== true || result.confirmation !== 'kernel_ack' || result.source?.chatType !== source.chatType || result.source.peerUid !== source.peerUid ||
        result.destination?.chatType !== destination.chatType || result.destination.peerUid !== destination.peerUid || !Array.isArray(result.sourceMsgIds) ||
        result.sourceMsgIds.length !== nativeIds.length || result.sourceMsgIds.some((id, index) => id !== nativeIds[index])) throw problem('INVALID_RESPONSE', 'QQ supplied no exact forward acknowledgement');
    return { confirmed: true, confirmation: 'kernel_ack', source_message_ids: ids,
        destination: { message_type: privateTarget ? 'private' : 'group', [privateTarget ? 'user_id' : 'group_id']: Number(targetUin) } };
}

module.exports = { ACTIONS, createForwardRegistry, runForward, forwardMessages, descriptor };
