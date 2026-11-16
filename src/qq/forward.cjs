'use strict';

// Public operations use QQ's existing-message APIs. Private native probes are
// separately bounded; destination IDs and resources always come from QQ.
const MAX_ID = 0xffffffffffffffffn;
const ROOT_LIMIT = 32;
const NODE_LIMIT = 1000;
const TTL = 60000;
const BYTE_LIMIT = 8 * 1024 * 1024;
const BUILD_LIMIT = 32;
const BUILD_BYTES = 64 * 1024;
const INSPECT_BUILD_BYTES = 1024 * 1024;
const { beginForwardDiagnostic } = require('./forward-diagnostics.cjs');
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, names) {
    if (!object(value) || Object.keys(value).some(key => key !== 'expectedEpoch' && !names.includes(key))) {
        throw problem('INVALID_PARAMS', 'Unexpected forward parameters');
    }
}
function fullId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_ID) {
        throw problem('INVALID_PARAMS', 'Forwarding requires an exact uint64 message ID string');
    }
    return value;
}
function peer(value) {
    fields(value, ['chatType', 'peerUid']);
    const valid = value.chatType === 1 ? typeof value.peerUid === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value.peerUid) :
        value.chatType === 2 && typeof value.peerUid === 'string' && /^[1-9]\d{0,9}$/.test(value.peerUid) && BigInt(value.peerUid) <= 0xffffffffn;
    if (!valid) throw problem('INVALID_PARAMS', 'Forward peer requires a real private UID or group UIN');
    return { chatType: value.chatType, peerUid: value.peerUid };
}
function resourceId(value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x20\x7f]/.test(value)) {
        throw problem('INVALID_RESPONSE', 'QQ merged-forward resource identity is invalid');
    }
    return value;
}
function descriptor(element) {
    if (element?.elementType === 10 && object(element.arkElement) && typeof element.arkElement.bytesData === 'string' &&
        Buffer.byteLength(element.arkElement.bytesData) <= BUILD_BYTES) {
        let card;
        try { card = JSON.parse(element.arkElement.bytesData); } catch { return null; }
        if (card?.app !== 'com.tencent.multimsg') return null;
        return { resId: resourceId(card.meta?.detail?.resid) };
    }
    if (element?.elementType !== 16) return null;
    if (!object(element.multiForwardMsgElement)) throw problem('INVALID_RESPONSE', 'QQ merged-forward payload is missing');
    return { resId: resourceId(element.multiForwardMsgElement.resId) };
}
function rootDescriptor(record) {
    if (!Array.isArray(record?.elements)) throw problem('INVALID_RESPONSE', 'QQ merged root has no elements');
    const descriptors = record.elements.map(descriptor).filter(Boolean);
    if (descriptors.length !== 1) throw problem(descriptors.length ? 'INVALID_RESPONSE' : 'UNSUPPORTED', 'An exact single native merged-forward root is required');
    return descriptors[0];
}
function copyRecords(records) {
    if (!Array.isArray(records) || records.length > NODE_LIMIT) throw problem('INVALID_RESPONSE', 'Merged-forward message count exceeds its bounds');
    let text;
    try {
        text = JSON.stringify(records, (_key, value) => {
            if (typeof value === 'bigint') return String(value);
            if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('inexact');
            if (value instanceof Map) return Object.fromEntries(value);
            return value;
        });
    } catch { throw problem('INVALID_RESPONSE', 'Merged-forward messages cannot be represented without data loss'); }
    if (Buffer.byteLength(text) > BYTE_LIMIT) throw problem('INVALID_RESPONSE', 'Merged-forward response exceeds 8 MiB');
    return JSON.parse(text);
}
function acceptance(value) {
    if (!object(value) || !Object.hasOwn(value, 'result')) throw problem('INVALID_RESPONSE', 'QQ supplied no explicit forward result');
    if (value.result !== 0 && value.result !== '0') throw problem('KERNEL_ERROR', 'QQ rejected the forward operation; it was not retried');
    return value;
}
function buildShape(value) {
    const elements = value?.rspInfo?.elements;
    const keys = item => object(item) ? Object.keys(item).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 24) : [];
    const shape = { resultType: typeof value?.result, result: Number.isSafeInteger(value?.result) ? value.result : null,
        keys: keys(value), rspInfoKeys: keys(value?.rspInfo), elementsArray: Array.isArray(elements),
        elementCount: Array.isArray(elements) ? elements.length : null,
        elements: Array.isArray(elements) ? elements.slice(0, 4).map(item => {
            let card;
            const bytes = item?.arkElement?.bytesData;
            if (typeof bytes === 'string' && Buffer.byteLength(bytes) <= INSPECT_BUILD_BYTES) {
                try { card = JSON.parse(bytes); } catch { /* shape only */ }
            }
            return { type: Number.isSafeInteger(item?.elementType) ? item.elementType : null, keys: keys(item),
                activePayloadKeys: keys(item).filter(key => key.endsWith('Element') && item[key] != null),
                ark: { keys: keys(item?.arkElement), bytesType: typeof bytes,
                    cardParsed: object(card), appIsMultimsg: card?.app === 'com.tencent.multimsg',
                    cardKeys: keys(card), metaKeys: keys(card?.meta), detailKeys: keys(card?.meta?.detail) } };
        }) : [] };
    return JSON.stringify(shape);
}
function builtCarrier(value) {
    const invalid = () => problem('INVALID_RESPONSE', 'QQ returned an unsupported merged-build shape; shape=' + buildShape(value));
    if (!object(value) || value.result !== 0 || !object(value.rspInfo)) throw invalid();
    const elements = value.rspInfo.elements;
    if (!Array.isArray(elements) || elements.length !== 1 || !object(elements[0])) throw invalid();
    const element = elements[0];
    const payload = element.elementType === 16 ? 'multiForwardMsgElement' : element.elementType === 10 ? 'arkElement' : null;
    if (!payload || !object(element[payload]) || Object.keys(element).some(key => key.endsWith('Element') && key !== payload && element[key] != null)) throw invalid();
    try {
        if (element.elementType === 16) resourceId(element.multiForwardMsgElement.resId);
        else {
            const bytes = element.arkElement.bytesData;
            if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > BUILD_BYTES) throw invalid();
            const card = JSON.parse(bytes);
            if (!object(card) || card.app !== 'com.tencent.multimsg' || !object(card.meta?.detail)) throw invalid();
            resourceId(card.meta.detail.resid);
        }
        const records = copyRecords(elements);
        if (Buffer.byteLength(JSON.stringify(records)) > BUILD_BYTES) throw invalid();
        return records;
    } catch { throw invalid(); }
}

function pureTextSignature(record) {
    if (!object(record) || !Array.isArray(record.elements) || !record.elements.length || record.elements.length > 1000 ||
        !/^[1-9]\d{0,9}$/.test(String(record.senderUin)) || BigInt(record.senderUin) > 0xffffffffn ||
        typeof record.senderUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(record.senderUid) ||
        !/^[1-9]\d{0,9}$/.test(String(record.msgTime)) || Number(record.recallTime) > 0 || record.sendStatus === 0 ||
        record.elements.some(element => element?.elementType !== 1 || !object(element.textElement) ||
            typeof element.textElement.content !== 'string' || !element.textElement.content.length ||
            ![undefined, 0].includes(element.textElement.atType) ||
            Object.keys(element).some(key => key.endsWith('Element') && key !== 'textElement' && element[key] != null))) {
        throw problem('INVALID_RESPONSE', 'Merge probing requires authentic plain-text source messages');
    }
    const text = record.elements.map(element => element.textElement.content).join('');
    if (Buffer.byteLength(text) > BUILD_BYTES) throw problem('INVALID_RESPONSE', 'Merge probe source text exceeds its bound');
    return JSON.stringify([String(record.senderUin), record.senderUid, String(record.msgTime), text]);
}

function finalResource(record) {
    if (!Array.isArray(record?.elements) || record.elements.length !== 1) throw problem('INVALID_RESPONSE', 'QQ returned no exact merged destination root');
    const element = record.elements[0];
    const payload = element?.elementType === 16 ? 'multiForwardMsgElement' : element?.elementType === 10 ? 'arkElement' : null;
    if (!payload || Object.keys(element).some(key => key.endsWith('Element') && key !== payload && element[key] != null)) {
        throw problem('INVALID_RESPONSE', 'QQ returned ambiguous completed merged payloads');
    }
    if (element.elementType === 16) return resourceId(element.multiForwardMsgElement?.resId);
    if (element.elementType === 10 && object(element.arkElement) && typeof element.arkElement.bytesData === 'string' &&
        Buffer.byteLength(element.arkElement.bytesData) <= BUILD_BYTES) {
        try {
            const card = JSON.parse(element.arkElement.bytesData);
            if (card?.app === 'com.tencent.multimsg') return resourceId(card.meta?.detail?.resid);
        } catch { /* report a fixed code below, without private native data */ }
    }
    throw problem('INVALID_RESPONSE', 'QQ merged send has no completed resource identity');
}

function createForward(capture, { now = Date.now } = {}) {
    let owner;
    const trees = new Map(), writes = new Map(), builds = new Map();
    const recentMerges = [];
    function diagnostics() { return structuredClone(recentMerges); }
    function scope() {
        capture.ensureReady();
        const value = { epoch: capture.epoch, session: capture.session, uid: capture.self?.uid, uin: capture.self?.uin };
        if (!owner || owner.epoch !== value.epoch || owner.session !== value.session || owner.uid !== value.uid || owner.uin !== value.uin) {
            trees.clear(); writes.clear(); builds.clear(); recentMerges.length = 0; owner = value;
        }
        return value;
    }
    function active(state, context) {
        capture.ensureReady();
        if (capture.epoch !== state.epoch || capture.session !== state.session || capture.self?.uid !== state.uid || capture.self?.uin !== state.uin) {
            throw problem('SESSION_CHANGED', 'QQ account changed during forwarding');
        }
        if (context.signal?.aborted || context.expiresAt !== undefined && now() >= context.expiresAt) {
            throw problem('EXPIRED', 'Forward request expired; dispatched operations are not retried');
        }
    }
    function supported(methods) { return capture.hasMethods('msg', methods); }
    function capabilities() {
        return { forwardExisting: supported(['getMsgsByMsgId', 'forwardMsg']), forwardRead: supported(['getMsgsByMsgId', 'getMultiMsg']),
            // QQ 3.2.35-54395 accepts and delivers this operation, but its real
            // early and final callbacks expose neither our correlation nor an
            // exact source tuple. Method presence cannot prove which native ID
            // belongs to the request. Keep the formal variant disabled until a
            // verified native identity contract exists; private probes remain.
            mergeExistingNative: false };
    }
    async function exact(state, context, target, ids) {
        active(state, context);
        const value = acceptance(await capture.invoke('msg', 'getMsgsByMsgId', [{ ...target, guildId: '' }, ids]));
        active(state, context);
        if (!Array.isArray(value.msgList) || value.msgList.length !== ids.length) throw problem('NOT_FOUND', 'QQ did not return every requested source message');
        const records = new Map();
        for (const record of value.msgList) {
            if (!object(record) || typeof record.msgId !== 'string' || !ids.includes(record.msgId) || records.has(record.msgId) ||
                record.chatType !== target.chatType || record.peerUid !== target.peerUid) {
                throw problem('INVALID_RESPONSE', 'QQ returned an ambiguous or different source conversation');
            }
            fullId(record.msgId);
            records.set(record.msgId, record);
        }
        return ids.map(id => records.get(id));
    }
    async function send(params, context, state) {
        fields(params, ['kind', 'source', 'destination', 'msgIds']);
        const source = peer(params.source), destination = peer(params.destination);
        if (!Array.isArray(params.msgIds) || params.msgIds.length < 1 || params.msgIds.length > 50) throw problem('INVALID_PARAMS', 'Forward requires 1 to 50 source messages');
        const msgIds = params.msgIds.map(fullId);
        if (new Set(msgIds).size !== msgIds.length) throw problem('INVALID_PARAMS', 'Duplicate forward source IDs');
        if (!supported(['getMsgsByMsgId', 'forwardMsg'])) throw problem('UNSUPPORTED', 'QQ existing-message forwarding is unavailable');
        const key = JSON.stringify([source, destination, msgIds]);
        if (writes.has(key) || writes.size >= 16) throw problem('BUSY', 'This forward operation is already pending or the pending limit is reached');
        const token = {};
        writes.set(key, token);
        const operation = Promise.resolve().then(async () => {
            await exact(state, context, source, msgIds);
            active(state, context);
            acceptance(await capture.invoke('msg', 'forwardMsg', [msgIds, { ...source, guildId: '' }, [{ ...destination, guildId: '' }], new Map()]));
            active(state, context);
            return { confirmed: true, confirmation: 'kernel_ack', source, destination, sourceMsgIds: msgIds };
        });
        operation.finally(() => { if (writes.get(key) === token) writes.delete(key); }).catch(() => {});
        // The lock follows the underlying native promise, including after the
        // caller's deadline. A timed-out native send cannot be cancelled.
        return capture.deadline(() => operation, context);
    }
    async function build(params, context, state) {
        // Internal experiment only. Nothing returned here authorizes sending
        // arbitrary native elements or enables a public OneBot merge action.
        fields(params, ['kind', 'source', 'msgIds']);
        const source = peer(params.source);
        if (source.chatType !== 2) throw problem('UNSUPPORTED', 'Merged-build probing is restricted to an existing group conversation');
        if (params.expectedEpoch !== state.epoch) throw problem('SESSION_CHANGED', 'Merged-build requests must bind the current QQ session');
        if (!Array.isArray(params.msgIds) || !params.msgIds.length || params.msgIds.length > 20) throw problem('INVALID_PARAMS', 'Merged building requires 1 to 20 source messages');
        const msgIds = params.msgIds.map(fullId);
        if (new Set(msgIds).size !== msgIds.length) throw problem('INVALID_PARAMS', 'Duplicate merged-build source IDs');
        if (!supported(['getMsgsByMsgId', 'buildMultiForwardMsg'])) throw problem('UNSUPPORTED', 'QQ has no verified existing-message merged builder');
        const key = JSON.stringify([source, msgIds]);
        if (builds.has(key)) throw problem('BUSY', 'This merged build was already attempted in this QQ session; do not rebuild automatically');
        if (builds.size >= BUILD_LIMIT) throw problem('BUSY', 'The session merged-build attempt limit was reached');
        const token = { dispatched: false };
        builds.set(key, token);
        const operation = Promise.resolve().then(async () => {
            await exact(state, context, source, msgIds);
            active(state, context);
            token.dispatched = true;
            const value = await capture.invoke('msg', 'buildMultiForwardMsg', [{ srcMsgIds: msgIds, srcContact: { ...source, guildId: '' } }]);
            active(state, context);
            if (object(value) && Number.isSafeInteger(value.result) && value.result !== 0) {
                throw problem('KERNEL_ERROR', 'QQ rejected the merged build; shape=' + buildShape(value));
            }
            if (params.kind === 'inspectBuild') {
                if (!object(value) || value.result !== 0) {
                    throw problem('INVALID_RESPONSE', 'QQ returned an unsupported merged-build shape; shape=' + buildShape(value));
                }
                // Inspection never grants a send credential. Preserve the raw
                // JSON-compatible native result only on the private RPC, with
                // exact long integers and a strict total size bound.
                const rawResult = copyRecords([value])[0];
                if (Buffer.byteLength(JSON.stringify(rawResult)) > INSPECT_BUILD_BYTES) {
                    throw problem('INVALID_RESPONSE', 'Private merged-build inspection exceeds 1 MiB');
                }
                let validated = false;
                try { builtCarrier(value); validated = true; } catch { /* remain inspection-only */ }
                return { nativeAccepted: true, validated, sent: false, source, sourceMsgIds: msgIds,
                    shape: JSON.parse(buildShape(value)), rawResult };
            }
            return { built: true, sent: false, source, sourceMsgIds: msgIds, elements: builtCarrier(value) };
        });
        operation.finally(() => {
            // Once native build is entered it may have uploaded a resource,
            // including after a timeout or a malformed result. Keep its bounded
            // reservation for this entire account session, rather than retry.
            if (!token.dispatched && builds.get(key) === token) builds.delete(key);
        }).catch(() => {});
        return capture.deadline(() => operation, context);
    }
    async function nativeMergeProbe(params, context, state, timeoutMs = 10000) {
        // QQ's native existing-message merge remains a private probe while the
        // target build cannot bind requests to confirmed destinations. Callers cannot
        // supply content, authors, cards, native elements or another target.
        fields(params, ['kind', 'source', 'msgIds', 'diagnostic']);
        if (params.diagnostic !== undefined && typeof params.diagnostic !== 'boolean') {
            throw problem('INVALID_PARAMS', 'Native merge diagnostic must be a boolean');
        }
        const source = peer(params.source);
        if (source.chatType !== 2) throw problem('UNSUPPORTED', 'Native merged probing is restricted to the source group');
        if (params.expectedEpoch !== state.epoch) throw problem('SESSION_CHANGED', 'Native merged probe must bind the current QQ session');
        if (!Array.isArray(params.msgIds) || !params.msgIds.length || params.msgIds.length > 20) {
            throw problem('INVALID_PARAMS', 'Native merged probe requires 1 to 20 real source messages');
        }
        const msgIds = params.msgIds.map(fullId);
        if (new Set(msgIds).size !== msgIds.length) throw problem('INVALID_PARAMS', 'Native merged source IDs must be distinct');
        if (!supported(['getMsgsByMsgId', 'multiForwardMsgWithComment', 'generateMsgUniqueId', 'getMultiMsg']) ||
            !capture.hasMethods('msf', ['getServerTime'])) throw problem('UNSUPPORTED', 'QQ correlated native merging is unavailable');
        const key = JSON.stringify([source, msgIds]);
        // All private build/send variants share the same tuple reservation.
        if (builds.has(key) || builds.size >= BUILD_LIMIT) throw problem('BUSY', 'This merged tuple was already attempted or the session bound was reached');
        const token = { dispatched: false }, controller = new AbortController();
        builds.set(key, token);
        context = { ...context, signal: context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal };
        // Fixed counters/booleans only: no account, message IDs, text, resource
        // identities, filesystem paths or native response bodies enter status.
        const evidence = { at: now(), sourceCount: msgIds.length, phase: 'source-query', nativeInvoked: false,
            nativePromise: false, nativeSettled: false, nativeAccepted: false, closed: false,
            callbacks: { records: 0, samePeer: 0, sameSelf: 0, correlationMatches: 0, missingGuild: 0,
                mismatchedGuild: 0, pending: 0, success: 0, failed: 0 },
            observations: { added: 0, updated: 0, exactSourceTuple: 0, correlatedAdded: 0, correlatedUpdated: 0,
                correlatedNativeId: false } };
        recentMerges.push(evidence); while (recentMerges.length > 8) recentMerges.shift();
        const operation = Promise.resolve().then(async () => {
            const sources = await exact(state, context, source, msgIds), signatures = sources.map(pureTextSignature);
            const msgInfos = sources.map(record => {
                if (String(record.senderUin) === state.uin && record.sendStatus !== 2) {
                    throw problem('INVALID_RESPONSE', 'An own source message has no confirmed delivery');
                }
                const senderShowName = [record.sendMemberName, record.sendNickName].find(value => typeof value === 'string' && value.trim().length > 0);
                if (!senderShowName || Buffer.byteLength(senderShowName) > 512 || senderShowName.includes('\0')) {
                    throw problem('INVALID_RESPONSE', 'A native merged source has no verified real display name');
                }
                return { msgId: record.msgId, senderShowName };
            });
            active(state, context);
            evidence.phase = 'server-time';
            const time = await capture.invoke('msf', 'getServerTime', []);
            active(state, context);
            evidence.phase = 'correlation-id';
            const correlation = String(await capture.invoke('msg', 'generateMsgUniqueId', [source.chatType, time]));
            active(state, context);
            if (!/^[1-9]\d{0,19}$/.test(correlation) || BigInt(correlation) > MAX_ID) {
                throw problem('INVALID_RESPONSE', 'QQ returned an invalid native merged correlation ID');
            }
            let diagnostic, observer, handler, statusObserver, outcome = { confirmed: false };
            try {
              statusObserver = observation => {
                if (evidence.closed || !Array.isArray(observation?.records) ||
                    !['onAddSendMsg', 'onMsgInfoListUpdate'].includes(observation.callback)) return;
                for (const record of observation.records) {
                    if (!object(record) || record.chatType !== source.chatType || record.peerUid !== source.peerUid ||
                        String(record.senderUin) !== state.uin || record.senderUid !== state.uid) continue;
                    if (observation.callback === 'onAddSendMsg') evidence.observations.added++;
                    else evidence.observations.updated++;
                    if (String(record.guildId) === correlation) {
                        if (observation.callback === 'onAddSendMsg') evidence.observations.correlatedAdded++;
                        else evidence.observations.correlatedUpdated++;
                        if (typeof record.msgId === 'string' && /^[1-9]\d{0,19}$/.test(record.msgId) &&
                            BigInt(record.msgId) <= MAX_ID && !msgIds.includes(record.msgId)) evidence.observations.correlatedNativeId = true;
                    }
                    const tuple = record.buildMultiMsgReqInfo?.srcMsgIds;
                    if (Array.isArray(tuple) && tuple.length === msgIds.length && tuple.every((id, index) => id === msgIds[index])) evidence.observations.exactSourceTuple++;
                }
              };
              capture.bus.on('sendObservation', statusObserver);
              if (params.diagnostic === true) {
                diagnostic = beginForwardDiagnostic({ environment: capture.processObject?.env, state, source, sourceMsgIds: msgIds, correlation, now });
                observer = observation => {
                    // Broader records are evidence only. They never participate
                    // in the still-strict delivery predicate below.
                    if (capture.epoch !== state.epoch || capture.session !== state.session || context.signal?.aborted ||
                        capture.self?.uid !== state.uid || capture.self?.uin !== state.uin || !Array.isArray(observation?.records) ||
                        !['onAddSendMsg', 'onMsgInfoListUpdate'].includes(observation.callback)) return;
                    for (const record of observation.records) {
                        if (!object(record) || record.chatType !== source.chatType || record.peerUid !== source.peerUid ||
                            !(record.senderUid === state.uid || String(record.senderUin) === state.uin)) continue;
                        const merged = record.msgType === 11 || Array.isArray(record.elements) && record.elements.some(element =>
                            element?.elementType === 16 || element?.elementType === 10 && object(element.arkElement));
                        if (merged) diagnostic.record('observation', { callback: observation.callback, record });
                    }
                };
                capture.bus.on('sendObservation', observer);
              }
              const delivered = new Promise((resolve, reject) => {
                handler = records => { for (const record of records) {
                    evidence.callbacks.records++;
                    if (record.chatType === source.chatType && record.peerUid === source.peerUid) {
                        evidence.callbacks.samePeer++;
                        if (String(record.senderUin) === state.uin && record.senderUid === state.uid) {
                            evidence.callbacks.sameSelf++;
                            if (record.guildId === undefined || record.guildId === null || record.guildId === '') evidence.callbacks.missingGuild++;
                            else if (String(record.guildId) !== correlation) evidence.callbacks.mismatchedGuild++;
                            if (record.sendStatus === 2) evidence.callbacks.success++;
                            else if (record.sendStatus === 0) evidence.callbacks.failed++;
                            else evidence.callbacks.pending++;
                        }
                    }
                    if (String(record.guildId) !== correlation || record.chatType !== source.chatType || record.peerUid !== source.peerUid ||
                        String(record.senderUin) !== state.uin || record.senderUid !== state.uid) continue;
                    evidence.callbacks.correlationMatches++;
                    try {
                        active(state, context);
                        if (record.sendStatus === 0) reject(problem('SEND_FAILED', 'QQ rejected native merged delivery'));
                        else if (record.sendStatus === 2) { fullId(record.msgId); resolve(record); }
                    } catch (error) { reject(error); }
                } };
                capture.bus.on('sent', handler);
              });
              delivered.catch(() => {});
                const [accepted, sent] = await capture.deadline(async () => {
                    active(state, context);
                    if (diagnostic && !diagnostic.record('invoke-start', { msgInfos, source, destination: { ...source, guildId: correlation } })) {
                        throw problem('DIAGNOSTIC_FAILED', 'Native merge diagnostic failed before submission');
                    }
                    token.dispatched = true;
                    evidence.nativeInvoked = true; evidence.phase = 'native-and-delivery';
                    let result;
                    try {
                        result = capture.invoke('msg', 'multiForwardMsgWithComment', [msgInfos, { ...source, guildId: '' },
                            { ...source, guildId: correlation }, [], new Map()]);
                    } catch (error) { diagnostic?.nativeResult(error, true); throw error; }
                    const asynchronous = result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function';
                    evidence.nativePromise = asynchronous;
                    if (!asynchronous) diagnostic?.nativeResult(result);
                    return Promise.all([Promise.resolve(result).then(value => {
                        evidence.nativeSettled = true;
                        if (evidence.closed) evidence.lateNativeResult = true;
                        if (asynchronous) diagnostic?.nativeResult(value);
                        if (value === undefined) { evidence.nativeAccepted = true; evidence.nativeResultShape = 'void'; return 'void-with-delivery-proof'; }
                        if (!object(value) || !Object.hasOwn(value, 'result') || typeof value.result !== 'number') {
                            evidence.nativeResultShape = 'unknown';
                            throw problem('INVALID_RESPONSE', 'QQ native merge returned an unrecognized acceptance result');
                        }
                        evidence.nativeResultShape = value.result === 0 ? 'numeric-zero' : 'numeric-nonzero';
                        if (value.result !== 0) throw problem('KERNEL_ERROR', 'QQ rejected the native merged operation; it was not retried');
                        evidence.nativeAccepted = true;
                        return 'numeric-zero';
                    }, error => { evidence.nativeSettled = true; evidence.nativeResultShape = 'rejected';
                        if (evidence.closed) evidence.lateNativeResult = true; diagnostic?.nativeResult(error, true); throw error; }), delivered]);
                }, context, timeoutMs);
                active(state, context);
                evidence.phase = 'root-readback';
                const nativeId = fullId(sent.msgId);
                if (msgIds.includes(nativeId)) throw problem('INVALID_RESPONSE', 'QQ reused a source identity as the merged destination');
                const [root] = await exact(state, context, source, [nativeId]);
                if (String(root.senderUin) !== state.uin || root.senderUid !== state.uid || root.sendStatus !== 2) {
                    throw problem('INVALID_RESPONSE', 'QQ merged root is not a confirmed own message');
                }
                const resId = finalResource(root);
                evidence.phase = 'resource-readback';
                const response = acceptance(await capture.invoke('msg', 'getMultiMsg', [{ ...source, guildId: '' }, nativeId, nativeId]));
                active(state, context);
                const records = copyRecords(response.msgList);
                if (records.length !== msgIds.length || records.some((record, index) => pureTextSignature(record) !== signatures[index]) ||
                    new Set(records.map(record => fullId(record.msgId))).size !== msgIds.length) {
                    throw problem('INVALID_RESPONSE', 'QQ completed merged resource does not match the original native source nodes');
                }
                outcome = { confirmed: true };
                evidence.phase = 'confirmed';
                return { confirmed: true, confirmation: 'correlated-native-merge-and-resource-readback', nativeAcceptance: accepted,
                    source, destination: source, sourceMsgIds: msgIds, messageId: nativeId, resId, record: copyRecords([root])[0], records,
                    ...(diagnostic ? { diagnosticId: diagnostic.id } : {}) };
            } catch (error) {
                if (!['expired', 'failed'].includes(evidence.phase)) evidence.failedAt = evidence.phase;
                evidence.phase = ['TIMEOUT', 'EXPIRED'].includes(error?.code) ? 'expired' : 'failed';
                outcome = { confirmed: false, code: typeof error?.code === 'string' ? error.code : 'KERNEL_ERROR' };
                throw error;
            } finally {
                if (handler) capture.bus.removeListener('sent', handler);
                if (observer) capture.bus.removeListener('sendObservation', observer);
                if (statusObserver) capture.bus.removeListener('sendObservation', statusObserver);
                evidence.closed = true; evidence.elapsedMs = Math.max(0, now() - evidence.at);
                diagnostic?.close({ ...outcome, dispatched: token.dispatched });
            }
        });
        operation.finally(() => {
            if (!token.dispatched && builds.get(key) === token) builds.delete(key);
        }).catch(() => {});
        try { return await capture.deadline(() => operation, context, timeoutMs); }
        catch (error) {
            if (!evidence.closed) {
                if (!['expired', 'failed'].includes(evidence.phase)) evidence.failedAt = evidence.phase;
                evidence.phase = ['TIMEOUT', 'EXPIRED'].includes(error?.code) ? 'expired' : 'failed';
            }
            throw error;
        } finally {
            controller.abort(); await Promise.resolve();
            evidence.closed = true; evidence.elapsedMs = Math.max(0, now() - evidence.at);
        }
    }
    async function read(params, context, state) {
        fields(params, ['kind', 'peer', 'rootMsgId', 'parentMsgId', 'resId']);
        const target = peer(params.peer), rootMsgId = fullId(params.rootMsgId), parentMsgId = fullId(params.parentMsgId);
        if (!supported(['getMsgsByMsgId', 'getMultiMsg'])) throw problem('UNSUPPORTED', 'QQ merged-forward reading is unavailable');
        const [root] = await exact(state, context, target, [rootMsgId]);
        const { resId } = rootDescriptor(root);
        if (params.resId !== undefined && resourceId(params.resId) !== resId) throw problem('NOT_FOUND', 'The observed merged-forward resource has changed');
        for (const [key, tree] of trees) if (tree.until <= now()) trees.delete(key);
        const key = JSON.stringify([target.chatType, target.peerUid, rootMsgId, resId]);
        const old = trees.get(key);
        if (parentMsgId !== rootMsgId && !old?.nodes.has(parentMsgId)) throw problem('NOT_FOUND', 'Nested parent was not observed below this exact merged root');
        active(state, context);
        const result = acceptance(await capture.invoke('msg', 'getMultiMsg', [{ ...target, guildId: '' }, rootMsgId, parentMsgId]));
        active(state, context);
        const records = copyRecords(result.msgList), nodes = new Map(old?.nodes || []);
        const seen = new Set();
        for (const record of records) {
            if (!object(record) || !Array.isArray(record.elements)) throw problem('INVALID_RESPONSE', 'QQ returned an invalid merged message');
            const nativeId = fullId(record.msgId);
            if (seen.has(nativeId)) throw problem('INVALID_RESPONSE', 'QQ returned duplicate merged-message identities');
            seen.add(nativeId);
            const nested = record.elements.map(descriptor).filter(Boolean);
            if (nested.length > 1) throw problem('INVALID_RESPONSE', 'QQ nested merged message is ambiguous');
            if (nested.length === 1) {
                if (nativeId === rootMsgId || nativeId === parentMsgId || nodes.has(nativeId) && nodes.get(nativeId) !== nested[0].resId) throw problem('INVALID_RESPONSE', 'QQ changed or cycled a merged parent identity');
                nodes.set(nativeId, nested[0].resId);
            }
        }
        if (nodes.size > NODE_LIMIT) throw problem('INVALID_RESPONSE', 'Merged-forward observed-parent limit reached');
        active(state, context);
        trees.set(key, { until: now() + TTL, nodes });
        while (trees.size > ROOT_LIMIT) trees.delete(trees.keys().next().value);
        return { peer: target, rootMsgId, parentMsgId, resId, records };
    }
    async function run(params, context = {}) {
        const state = scope();
        const timeoutMs = params?.kind === 'existingMerge' ? params.timeoutMs ?? 60000 : 10000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
            throw problem('INVALID_PARAMS', 'Existing merged-send timeout must be at most 60 seconds');
        }
        context = { ...context, expiresAt: Math.min(context.expiresAt ?? Infinity, now() + timeoutMs) };
        if (params?.expectedEpoch !== undefined && params.expectedEpoch !== state.epoch) throw problem('SESSION_CHANGED', 'Forward request belongs to another QQ session');
        active(state, context);
        if (params?.kind === 'forward') return send(params, context, state);
        if (params?.kind === 'build' || params?.kind === 'inspectBuild') return build(params, context, state);
        if (params?.kind === 'mergeProbe') throw problem('UNSUPPORTED', 'Pending-carrier merged sending was disabled after real QQ returned an empty resource');
        if (params?.kind === 'existingMerge') {
            fields(params, ['kind', 'source', 'msgIds', 'timeoutMs']);
            if (!capabilities().mergeExistingNative) {
                throw problem('UNSUPPORTED', 'Existing-message merging is disabled: this QQ build does not expose a verified request-to-message identity');
            }
            const { timeoutMs: _timeout, ...request } = params;
            return nativeMergeProbe({ ...request, kind: 'nativeMergeProbe' }, context, state, timeoutMs);
        }
        if (params?.kind === 'nativeMergeProbe') return nativeMergeProbe(params, context, state);
        if (params?.kind === 'read') return capture.deadline(() => read(params, context, state), context);
        throw problem('INVALID_PARAMS', 'Unknown fixed forward operation');
    }
    return { run, capabilities, diagnostics, clear() { trees.clear(); writes.clear(); builds.clear(); recentMerges.length = 0; owner = undefined; } };
}

module.exports = { createForward, descriptor, rootDescriptor, finalResource };
