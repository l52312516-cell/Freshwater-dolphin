'use strict';

// Fixed custom-node bridge. All source messages are newly sent by this account
// to its own UID; no caller-supplied authors, native IDs or executable inputs.
const media = require('./media.cjs');
const MAX_UINT64 = 0xffffffffffffffffn;
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw problem('INVALID_PARAMS', 'Unexpected merged-send parameters');
}
function exact(value, code = 'INVALID_RESPONSE') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_UINT64) {
        throw problem(code, 'Merged messages require an exact nonzero native identity string');
    }
    return value;
}
function integer(value, code) {
    if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value) ||
        !/^[1-9]\d{0,19}$/.test(String(value)) || BigInt(value) > MAX_UINT64) throw problem(code, 'Invalid merged image or timestamp identity');
    return String(value);
}
function peer(value) {
    fields(value, ['chatType', 'peerUid']);
    if (value.chatType === 1 ? typeof value.peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(value.peerUid) :
        value.chatType !== 2 || typeof value.peerUid !== 'string' || !/^[1-9]\d{0,9}$/.test(value.peerUid) || BigInt(value.peerUid) > 0xffffffffn) {
        throw problem('INVALID_PARAMS', 'Merged-send destination requires a real private UID or group UIN');
    }
    return { chatType: value.chatType, peerUid: value.peerUid };
}
function elementsSignature(elements, code = 'INVALID_RESPONSE') {
    if (!Array.isArray(elements) || !elements.length || elements.length > 1000) throw problem(code, 'Invalid merged-node elements');
    return JSON.stringify(elements.map(element => {
        if (!object(element) || ![1, 2].includes(element.elementType)) throw problem(code, 'Only text and ordinary images can be merged');
        const payload = element.elementType === 1 ? 'textElement' : 'picElement';
        if (Object.keys(element).some(key => key.endsWith('Element') && key !== payload && element[key] != null)) {
            throw problem(code, 'A merged-node element contains conflicting payloads');
        }
        if (element.elementType === 1) {
            const text = element.textElement;
            if (!object(text) || typeof text.content !== 'string' || !text.content.length || ![undefined, 0].includes(text.atType)) {
                throw problem(code, 'Merged text must be ordinary text without native mentions');
            }
            return [1, text.content];
        }
        const image = element.picElement;
        if (!object(image) || !/^[a-fA-F0-9]{32}$/.test(image.md5HexStr || '') ||
            ![undefined, null, false].includes(image.isFlashPic) || ![undefined, 0].includes(image.picSubType)) {
            throw problem(code, 'Merged images require actual ordinary-image metadata');
        }
        const size = integer(image.fileSize, code), width = integer(image.picWidth, code), height = integer(image.picHeight, code);
        if (BigInt(size) > 10n * 1024n * 1024n || BigInt(width) > 65535n || BigInt(height) > 65535n || BigInt(width) * BigInt(height) > 100000000n) {
            throw problem(code, 'Merged image metadata exceeds ordinary-image bounds');
        }
        return [2, image.md5HexStr.toLowerCase(), size, width, height];
    }));
}
function sourceSignature(record, self) {
    if (!object(record) || record.senderUid !== self.uid || String(record.senderUin) !== self.uin) {
        throw problem('INVALID_RESPONSE', 'Merged source author does not match this account');
    }
    return JSON.stringify([exact(record.msgSeq), exact(record.msgRandom), self.uid, self.uin,
        integer(record.msgTime, 'INVALID_RESPONSE'), elementsSignature(record.elements)]);
}
function resource(record) {
    if (!Array.isArray(record?.elements) || record.elements.length !== 1) throw problem('INVALID_RESPONSE', 'QQ did not return an exact merged root');
    const element = record.elements[0]; let id;
    const payload = element?.elementType === 16 ? 'multiForwardMsgElement' : element?.elementType === 10 ? 'arkElement' : null;
    if (!payload || Object.keys(element).some(key => key.endsWith('Element') && key !== payload && element[key] != null)) {
        throw problem('INVALID_RESPONSE', 'QQ merged root has conflicting active payloads');
    }
    if (element?.elementType === 16 && object(element.multiForwardMsgElement)) id = element.multiForwardMsgElement.resId;
    else if (element?.elementType === 10 && typeof element.arkElement?.bytesData === 'string' && Buffer.byteLength(element.arkElement.bytesData) <= 65536) {
        let card; try { card = JSON.parse(element.arkElement.bytesData); } catch { /* fixed error below */ }
        if (card?.app === 'com.tencent.multimsg') id = card.meta?.detail?.resid;
    }
    if (typeof id !== 'string' || !id || Buffer.byteLength(id) > 1024 || /[\x00-\x20\x7f]/.test(id)) {
        throw problem('INVALID_RESPONSE', 'QQ merged root has no completed native resource');
    }
    return id;
}
function copy(value, limit = 256 * 1024) {
    let text;
    try { text = JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') return String(item);
        if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('inexact');
        return item;
    }); } catch { throw problem('INVALID_RESPONSE', 'QQ merged callback cannot be retained without data loss'); }
    if (Buffer.byteLength(text) > limit) throw problem('INVALID_RESPONSE', 'QQ merged callback exceeds its bound');
    return JSON.parse(text);
}
function accepted(value) {
    if (value === undefined || value === 0 || object(value) && value.result === 0) return;
    throw problem(object(value) && typeof value.result === 'number' && value.result !== 0 ? 'KERNEL_ERROR' : 'INVALID_RESPONSE',
        'QQ did not accept the native merged operation; it was not retried');
}
function createMergedSend(capture) {
    let owner, lock;
    const usedSourceIds = new Set(), usedSourceSignatures = new Set();
    function capabilities() {
        try { capture.ensureReady(); } catch { return { mergeCustom: false, mergedText: false, mergedImage: false }; }
        if (['denied', 'experimental-basic'].includes(capture.runtimeProfile?.().admission)) return { mergeCustom: false, mergedText: false, mergedImage: false };
        const present = capture.hasMethods('msg', ['sendMsg', 'generateMsgUniqueId', 'getMsgsByMsgId', 'multiForwardMsgWithComment', 'getMultiMsg']) &&
            capture.hasMethods('msf', ['getServerTime']);
        return { mergeCustom: present, mergedText: present, mergedImage: present && capture.preparedMedia instanceof Map };
    }
    async function run(params, context = {}) {
        capture.ensureReady();
        const state = { epoch: capture.epoch, session: capture.session, uid: capture.self?.uid, uin: capture.self?.uin };
        if (!owner || owner.epoch !== state.epoch || owner.session !== state.session || owner.uid !== state.uid || owner.uin !== state.uin) {
            owner = state; lock = undefined; usedSourceIds.clear(); usedSourceSignatures.clear();
        }
        fields(params, ['kind', 'destination', 'nodes', 'expectedEpoch', 'timeoutMs']);
        if (params.expectedEpoch !== state.epoch || !/^u_[A-Za-z0-9_-]+$/.test(state.uid || '') || !/^[1-9]\d{0,9}$/.test(state.uin || '')) {
            throw problem('SESSION_CHANGED', 'Merged send must bind this authenticated account session');
        }
        const destination = peer(params.destination), source = { chatType: 1, peerUid: state.uid };
        const timeoutMs = params.timeoutMs ?? 60000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw problem('INVALID_PARAMS', 'Merged-send timeout must be at most 60 seconds');
        const expiresAt = Math.min(context.expiresAt ?? Infinity, Date.now() + timeoutMs);
        const controller = new AbortController();
        context = { ...context, expiresAt, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
        function active() {
            capture.ensureReady();
            if (capture.epoch !== state.epoch || capture.session !== state.session || capture.self?.uid !== state.uid || capture.self?.uin !== state.uin) {
                throw problem('SESSION_CHANGED', 'QQ session changed during merged sending');
            }
            if (context.signal.aborted || Date.now() >= expiresAt) throw problem('EXPIRED', 'Merged-send deadline expired; sends are not retried');
        }
        active();
        if (!capabilities().mergeCustom) throw problem('UNSUPPORTED', 'QQ native custom merging is unavailable');
        if (!Array.isArray(params.nodes) || !params.nodes.length || params.nodes.length > 100) throw problem('INVALID_PARAMS', 'Merged sending requires 1 to 100 nodes');
        let bytes = 0, count = 0;
        // Complete validation, including every prepared image, precedes the
        // first self-chat send. sendMessage repeats validation before each send.
        const nodes = params.nodes.map(node => {
            fields(node, ['nickname', 'elements']);
            if (typeof node.nickname !== 'string' || !node.nickname.trim() || Buffer.byteLength(node.nickname) > 512 || /[\x00-\x1f\x7f]/.test(node.nickname)) {
                throw problem('INVALID_PARAMS', 'Merged nodes require a bounded display nickname');
            }
            const signature = elementsSignature(node.elements, 'INVALID_PARAMS');
            for (const element of node.elements) {
                count++;
                if (element.elementType === 1) bytes += Buffer.byteLength(element.textElement.content);
                else {
                    const image = element.picElement, prepared = capture.preparedMedia?.get(image.sourcePath);
                    if (!prepared || prepared.type !== 'image' || prepared.epoch !== state.epoch ||
                        prepared.md5 !== image.md5HexStr || String(prepared.size) !== String(image.fileSize) || Date.now() - prepared.at > 300000) {
                        throw problem('INVALID_PARAMS', 'Merged image was not prepared for this account session');
                    }
                    media.verifyPrepared(image.sourcePath, capture.mediaTargetRoots, prepared);
                }
            }
            return { nickname: node.nickname, elements: copy(node.elements), signature };
        });
        if (bytes > 65536 || count > 1000) throw problem('INVALID_PARAMS', 'Merged text or element count exceeds its bound');
        active();
        if (lock) throw problem('BUSY', 'Another merged send is pending or its staging result is unknown');
        if (usedSourceIds.size + nodes.length > 10000) throw problem('BUSY', 'The account-session custom-source identity limit was reached');
        const token = { finished: false, stagingPending: false, nativePending: false };
        lock = token;
        const release = () => { if (token.finished && !token.stagingPending && !token.nativePending && lock === token) lock = undefined; };
        let handler, wake;
        async function query(method, args) {
            active();
            const result = await capture.deadline(() => capture.invoke('msg', method, args), context, 60000);
            active();
            if (!object(result) || ![0, '0'].includes(result.result)) throw problem('QUERY_FAILED', 'QQ merged-send query failed');
            return result;
        }
        async function exactRecord(target, id) {
            const result = await query('getMsgsByMsgId', [{ ...target, guildId: '' }, [id]]);
            if (!Array.isArray(result.msgList) || result.msgList.length !== 1) throw problem('INVALID_RESPONSE', 'QQ did not return an exact merged-send message');
            const record = result.msgList[0];
            if (!object(record) || record.msgId !== id || record.chatType !== target.chatType || record.peerUid !== target.peerUid ||
                record.senderUid !== state.uid || String(record.senderUin) !== state.uin || record.sendStatus !== 2) {
                throw problem('INVALID_RESPONSE', 'QQ merged-send message identity or delivery is inconsistent');
            }
            return copy(record);
        }
        const operation = Promise.resolve().then(async () => {
            const sources = [], sourceIds = new Set(), signatures = new Set();
            for (const node of nodes) {
                active(); token.stagingPending = true;
                let staged;
                try {
                    staged = await capture.sendMessage({ peer: source, elements: node.elements, expectedEpoch: state.epoch,
                        timeoutMs: Math.max(1, Math.min(60000, expiresAt - Date.now())) }, context);
                } catch (error) {
                    // These bridge codes mean validation refused submission or
                    // QQ explicitly rejected it. Unknown/timeout outcomes keep
                    // the account reservation until its session is replaced.
                    if (['INVALID_PARAMS', 'SEND_FAILED', 'KERNEL_ERROR', 'UNSUPPORTED'].includes(error?.code)) token.stagingPending = false;
                    throw error;
                }
                token.stagingPending = false; active();
                const id = exact(staged?.msgId);
                if (usedSourceIds.has(id)) throw problem('INVALID_RESPONSE', 'QQ reused a previously staged source identity');
                usedSourceIds.add(id);
                const record = await exactRecord(source, id);
                const signature = sourceSignature(record, state);
                if (sourceIds.has(id) || signatures.has(signature) || usedSourceSignatures.has(signature) || elementsSignature(record.elements) !== node.signature) {
                    throw problem('INVALID_RESPONSE', 'QQ staging did not retain distinct fresh node identities and complete content');
                }
                sourceIds.add(id); signatures.add(signature); usedSourceSignatures.add(signature); sources.push({ id, signature });
            }
            const candidates = [], seen = new Map(); let invalid = false, dispatched = false;
            handler = records => {
                if (!dispatched || !Array.isArray(records)) return;
                try {
                    active();
                    for (const record of records) {
                        if (!object(record) || record.chatType !== destination.chatType || record.peerUid !== destination.peerUid ||
                            record.senderUid !== state.uid || String(record.senderUin) !== state.uin || record.sendStatus !== 2) continue;
                        let resId; try { resId = resource(record); } catch { continue; }
                        const id = exact(record.msgId);
                        if (sourceIds.has(id)) { invalid = true; continue; }
                        if (seen.has(id)) { if (seen.get(id) !== resId) invalid = true; continue; }
                        if (candidates.length >= 32) { invalid = true; continue; }
                        seen.set(id, resId); candidates.push({ id, resId });
                    }
                } catch { invalid = true; }
                wake?.();
            };
            capture.bus.on('sent', handler);
            active(); dispatched = true; token.nativePending = true;
            let native;
            try {
                native = capture.invoke('msg', 'multiForwardMsgWithComment', [sources.map((item, index) => ({ msgId: item.id, senderShowName: nodes[index].nickname })),
                    { ...source, guildId: '' }, { ...destination, guildId: '' }, [], new Map()]);
            } catch (error) { token.nativePending = false; throw error; }
            const raw = Promise.resolve(native);
            raw.then(() => { token.nativePending = false; release(); }, () => { token.nativePending = false; release(); });
            accepted(await capture.deadline(() => raw, context, 60000));
            let index = 0, match;
            while (true) {
                active();
                if (invalid) throw problem('INVALID_RESPONSE', 'QQ merged root observations overflowed or became inconsistent');
                while (index < candidates.length) {
                    const candidate = candidates[index++], root = await exactRecord(destination, candidate.id);
                    if (resource(root) !== candidate.resId) throw problem('INVALID_RESPONSE', 'QQ changed the observed merged resource');
                    const response = await query('getMultiMsg', [{ ...destination, guildId: '' }, candidate.id, candidate.id]);
                    if (!Array.isArray(response.msgList) || response.msgList.length > 1000) throw problem('INVALID_RESPONSE', 'QQ returned an invalid merged resource');
                    const records = response.msgList;
                    if (records.length !== sources.length) continue;
                    let valid = true; const childIds = new Set();
                    for (let position = 0; position < records.length; position++) {
                        const record = records[position];
                        try {
                            const id = exact(record.msgId);
                            if (childIds.has(id) || sourceSignature(record, state) !== sources[position].signature) { valid = false; break; }
                            childIds.add(id);
                        } catch { valid = false; break; }
                    }
                    if (!valid) continue;
                    // QQ resolves the native resource author back to the real
                    // account nickname. senderShowName remains a native display
                    // hint, not an author identity or a delivery credential.
                    // Preserve the real returned names instead of inventing a
                    // requested nickname in the readback response.
                    if (records.some(record => ![record.sendMemberName, record.sendNickName, record.senderNickname]
                        .some(name => typeof name === 'string' && name.trim() && Buffer.byteLength(name) <= 512))) {
                        throw problem('INVALID_RESPONSE', 'QQ returned no real merged-node author display name');
                    }
                    if (match) throw problem('INVALID_RESPONSE', 'More than one merged root matches this fresh source tuple');
                    match = { confirmed: true, confirmation: 'fresh-source-tuple-and-resource-readback', nodeCount: nodes.length, source, destination,
                        sourceMsgIds: sources.map(item => item.id), messageId: candidate.id, resId: candidate.resId, record: root, records: copy(records, 1024 * 1024) };
                }
                active();
                if (invalid) throw problem('INVALID_RESPONSE', 'QQ merged root observation was incomplete');
                if (match) return match;
                await capture.deadline(() => new Promise(resolve => {
                    wake = resolve;
                    // deadline installs this waiter in a microtask. A complete
                    // root may already have arrived between the queue check
                    // above and this installation; do not lose that wakeup.
                    if (invalid || index < candidates.length) resolve();
                }), context, 60000);
                wake = undefined;
            }
        });
        operation.catch(() => {});
        try { return await capture.deadline(() => operation, context, 60000); }
        finally {
            controller.abort();
            if (handler) capture.bus.removeListener('sent', handler);
            wake?.(); wake = undefined;
            token.finished = true; release();
        }
    }
    return { run, capabilities };
}

module.exports = { createMergedSend, elementsSignature };
