'use strict';

const crypto = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');
const p = require('./qzone-protocol.cjs');
const protocol = require('./voice-extra-protocol.cjs');
const media = require('./media.cjs');
const OPERATIONS = Object.freeze({ 'voice.generate': ['groupId', 'character', 'text', 'chatType'], 'voice.send': ['groupId', 'character', 'text', 'chatType'], 'voice.text': ['peer', 'nativeId', 'elementId'] });
function nativeId(value, code = 'INVALID_PARAMS') { if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 0xffffffffffffffffn) p.fail(code, 'A voice operation needs an exact native message ID'); return value; }
function peer(value) { if (!p.object(value) || Object.keys(value).some(key => !['chatType', 'peerUid'].includes(key)) || ![1, 2].includes(value.chatType) || typeof value.peerUid !== 'string' || (value.chatType === 2 ? p.uin(value.peerUid) !== value.peerUid : !/^u_[A-Za-z0-9_-]{1,126}$/.test(value.peerUid))) p.fail('INVALID_PARAMS', 'A voice requires an exact private or group peer'); return { chatType: value.chatType, peerUid: value.peerUid }; }
function sourceElement(record, data) {
    if (!p.object(record) || record.msgId !== data.nativeId || record.chatType !== data.peer.chatType || record.peerUid !== data.peer.peerUid || !Array.isArray(record.elements)) p.fail('INVALID_RESPONSE', 'QQ returned another voice message');
    const matches = record.elements.filter(element => element?.elementType === 4 && element.elementId === data.elementId);
    if (matches.length !== 1 || !p.object(matches[0].pttElement)) p.fail('NOT_FOUND', 'QQ did not return the exact original PTT element');
    const element = matches[0], voice = element.pttElement;
    protocol.uuid(voice.fileUuid, 'INVALID_RESPONSE'); protocol.digest(voice.md5HexStr, 'INVALID_RESPONSE'); p.integer(voice.fileSize, media.MAX_RECORD_BYTES, 1, 'INVALID_RESPONSE');
    if (typeof voice.duration !== 'number' || !Number.isFinite(voice.duration) || voice.duration < 0 || voice.duration > 600) p.fail('INVALID_RESPONSE', 'Original PTT duration is invalid');
    p.integer(voice.formatType, 255, 0, 'INVALID_RESPONSE');
    return element;
}
function fingerprint(element) { const voice = element.pttElement; return JSON.stringify([voice.fileUuid, voice.md5HexStr.toLowerCase(), String(voice.fileSize), voice.duration, voice.formatType]); }
function createVoiceExtra(capture, { native = require('./msf-native.cjs'), fetchImpl = globalThis.fetch } = {}) {
    const pending = new Set(), textLocks = new Set(), claims = new Set(); let aiWriting = false, generation = 0;
    function capabilities() {
        // The target Linux build rejects synthesis in both mode 0 and mode 1.
        // Keep independent original-PTT transcription available; never reissue
        // a synthesis merely because its prior publication outcome is unknown.
        const ai = capture.qqVersion !== '3.2.35-54395' && native.available() && typeof capture.on === 'function' && typeof capture.off === 'function' && capture.bus && capture.hasMethods('msg', ['getMsgsByMsgId']);
        return { aiVoiceGenerate: !!ai && typeof fetchImpl === 'function', aiVoiceSend: !!ai,
            pttText: typeof capture.mediaDirectory === 'string' && capture.hasMethods('msg', ['getMsgsByMsgId', 'translatePtt2Text']) };
    }
    function state(data, context) {
        capture.ensureReady(); if (data.expectedEpoch !== capture.epoch) p.fail('SESSION_CHANGED', 'Voice operation must bind the current QQ session');
        const saved = { epoch: capture.epoch, session: capture.session, uin: p.uin(capture.self?.uin), uid: capture.self?.uid, generation };
        const bounded = { ...context, expiresAt: Math.min(Date.now() + (data.operation === 'voice.text' ? 20000 : 60000), context.expiresAt ?? Infinity) };
        const active = () => { capture.ensureReady(); if (generation !== saved.generation || capture.epoch !== saved.epoch || capture.session !== saved.session || capture.self?.uin !== saved.uin || capture.self?.uid !== saved.uid) p.fail('SESSION_CHANGED', 'QQ changed during the voice operation');
            if (bounded.signal?.aborted || Date.now() >= bounded.expiresAt) p.fail('EXPIRED', 'Voice operation expired; any synthesis publication outcome may be unknown'); };
        active(); return { saved, context: bounded, active };
    }
    async function fixed(operation, request, scope) {
        scope.active(); protocol.prepare(operation, request);
        const result = await native.run(capture, { op: 'fixedVoiceExtra', operation, request, expectedEpoch: scope.saved.epoch, expectedUin: scope.saved.uin, signal: scope.context.signal,
            timeoutMs: Math.max(1, Math.min(10000, scope.context.expiresAt - Date.now())) });
        scope.active(); return result;
    }
    async function getMessage(data, scope) { scope.active(); const record = await capture.getMessage({ peer: data.peer, nativeId: data.nativeId }); scope.active(); return record; }
    async function transcription(data, scope) {
        const record = await getMessage(data, scope), element = sourceElement(record, data), before = fingerprint(element), voice = element.pttElement;
        // Actual receipt/download path verifies account ownership and original
        // exact message/element. Require both its bytes and the source digest.
        const received = await capture.receiveMedia({ peer: data.peer, nativeId: data.nativeId, elementId: data.elementId, expectedEpoch: scope.saved.epoch }, scope.context); scope.active();
        if (!p.object(received) || received.type !== 'record' || typeof received.file !== 'string' || !/^fwd-record-[a-f0-9]{32}$/.test(received.file)) p.fail('INVALID_RESPONSE', 'QQ supplied no actual original voice resource');
        const resource = media.resourceInfo(capture.mediaDirectory, received.file);
        if (resource.type !== 'record' || resource.md5 !== voice.md5HexStr.toLowerCase() || resource.size !== Number(voice.fileSize) || received.md5 !== resource.md5 || Number(received.size) !== resource.size) p.fail('INVALID_RESPONSE', 'Original PTT bytes do not match the message digest and size');
        const result = text => ({ operation: data.operation, uin: scope.saved.uin, peer: data.peer, nativeId: data.nativeId, elementId: data.elementId, fileUuid: voice.fileUuid, md5: resource.md5, size: resource.size, text: p.string(text, 131072, false, 'INVALID_RESPONSE') });
        if (typeof voice.text === 'string' && voice.text.trim()) return result(voice.text);
        scope.active(); const ack = await capture.invoke('msg', 'translatePtt2Text', [data.nativeId, { ...data.peer, guildId: '' }, element]); scope.active();
        if (!p.object(ack) || ack.result !== 0) p.fail('KERNEL_ERROR', 'QQ rejected native PTT transcription');
        for (let count = 0; count < 60; count++) {
            const updated = sourceElement(await getMessage(data, scope), data);
            if (fingerprint(updated) !== before) p.fail('INVALID_RESPONSE', 'QQ changed the source PTT during transcription');
            if (typeof updated.pttElement.text === 'string' && updated.pttElement.text.trim()) return result(updated.pttElement.text);
            await pause(250, undefined, { signal: scope.context.signal }); scope.active();
        }
        p.fail('QUERY_FAILED', 'QQ returned no completed text for the exact original PTT; transcription was not retriggered');
    }
    async function download(url, node, scope) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || !/^[a-z0-9.-]+\.qq\.com(?:\.cn)?$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.hash) p.fail('INVALID_RESPONSE', 'AI voice URL is outside the fixed official source');
        scope.active(); const timeout = AbortSignal.timeout(Math.max(1, Math.min(10000, scope.context.expiresAt - Date.now()))), signal = scope.context.signal ? AbortSignal.any([scope.context.signal, timeout]) : timeout;
        let response, reader;
        try {
            response = await fetchImpl(parsed.href, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: 'audio/*,application/octet-stream' } }); scope.active();
            if (response.status !== 200 || response.redirected || response.url && response.url !== parsed.href || !response.body) p.fail('QUERY_FAILED', 'AI voice download did not reach its fixed source');
            const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) !== node.info.fileSize)) p.fail('INVALID_RESPONSE', 'AI voice download length differs from its source index');
            const chunks = []; let size = 0; reader = response.body.getReader();
            for (;;) { const chunk = await reader.read(); scope.active(); if (chunk.done) break; size += chunk.value.byteLength; if (size > node.info.fileSize || size > media.MAX_RECORD_BYTES) p.fail('INVALID_RESPONSE', 'AI voice download exceeded its exact byte budget'); chunks.push(Buffer.from(chunk.value)); }
            const bytes = Buffer.concat(chunks); if (bytes.length !== node.info.fileSize || crypto.createHash('md5').update(bytes).digest('hex') !== node.info.fileHash) p.fail('INVALID_RESPONSE', 'AI voice download differs from its exact media digest');
            media.recordInfo(bytes); scope.active();
        } catch (error) { Promise.resolve(reader?.cancel()).catch(() => {}); if (!reader) Promise.resolve(response?.body?.cancel?.()).catch(() => {}); scope.active(); if (['INVALID_RESPONSE', 'QUERY_FAILED', 'UNSUPPORTED', 'EXPIRED', 'SESSION_CHANGED'].includes(error.code)) throw error; p.fail(signal.aborted ? 'TIMEOUT' : 'QUERY_FAILED', 'AI voice download failed without retry'); }
        finally { reader?.releaseLock(); }
    }
    async function synthesis(data, scope) {
        const groupId = data.groupId, candidates = new Map(); let overflow = false, expected, done = false;
        const eligible = record => p.object(record) && record.chatType === 2 && record.peerUid === groupId && String(record.senderUin) === scope.saved.uin && record.senderUid === scope.saved.uid && Array.isArray(record.elements);
        const matches = record => {
            if (!eligible(record)) return false;
            const voices = record.elements.filter(element => element?.elementType === 4);
            return voices.length === 1 && voices[0].pttElement?.fileUuid === expected.fileUuid && typeof voices[0].pttElement.md5HexStr === 'string' &&
                voices[0].pttElement.md5HexStr.toLowerCase() === expected.info.fileHash && String(voices[0].pttElement.fileSize) === String(expected.info.fileSize);
        };
        const collect = records => { if (done || scope.saved.generation !== generation || scope.saved.epoch !== capture.epoch || scope.saved.session !== capture.session) return;
            for (const record of records) {
                if (!eligible(record) || !record.elements.some(element => element?.elementType === 4) || record.sendStatus === 0) continue;
                try { nativeId(record.msgId, 'INVALID_RESPONSE'); } catch { continue; }
                const key = groupId + ':' + record.msgId; if (claims.has(key)) continue;
                if (candidates.size >= 64 && !candidates.has(key)) { overflow = true; continue; }
                candidates.set(key, record);
            }
        };
        const observation = value => { if (['onAddSendMsg', 'onMsgInfoListUpdate'].includes(value?.callback) && Array.isArray(value.records)) collect(value.records); };
        const sent = records => { if (Array.isArray(records)) collect(records); };
        const event = value => { if (value?.kind === 'message' && value.epoch === scope.saved.epoch && value.selfUin === scope.saved.uin) collect([value.record]); };
        capture.bus.on('sendObservation', observation); capture.bus.on('sent', sent); capture.on('event', event);
        try {
            const request = { groupId, character: data.character, text: data.text, chatType: data.chatType, sessionId: crypto.randomInt(1, 0x100000000) };
            for (let poll = 0; poll < 30; poll++) {
                const value = await fixed('voice.synthesize', request, scope);
                if (!p.object(value) || value.groupId !== groupId || value.sessionId !== request.sessionId || value.character !== request.character || value.text !== request.text || value.chatType !== request.chatType || typeof value.pending !== 'boolean') p.fail('INVALID_RESPONSE', 'QQ returned an unrelated synthesis poll');
                if (!value.pending) { expected = protocol.node(value.node, 'INVALID_RESPONSE'); break; }
                await pause(200, undefined, { signal: scope.context.signal }); scope.active();
            }
            if (!expected) p.fail('QUERY_FAILED', 'AI voice synthesis did not return a complete media index within the bounded poll budget');
            let receipt;
            for (let poll = 0; poll < 40; poll++) {
                scope.active();
                const matching = [...candidates.values()].filter(matches);
                if (matching.length > 1) p.fail('INVALID_RESPONSE', 'AI voice UUID matched multiple group messages');
                if (matching.length) {
                    const record = await getMessage({ peer: { chatType: 2, peerUid: groupId }, nativeId: matching[0].msgId }, scope);
                    if (!matches(record) || record.msgId !== matching[0].msgId) p.fail('INVALID_RESPONSE', 'QQ did not confirm the exact AI voice self-message receipt');
                    if (record.sendStatus === 2) { p.integer(record.msgSeq, 0xffffffff, 1, 'INVALID_RESPONSE'); receipt = record; break; }
                    if (![0, 1].includes(record.sendStatus)) p.fail('KERNEL_ERROR', 'QQ rejected the exact AI voice self-message');
                }
                if (overflow) p.fail('INVALID_RESPONSE', 'AI voice candidate buffer overflowed before exact receipt correlation');
                await pause(125, undefined, { signal: scope.context.signal }); scope.active();
            }
            if (!receipt) p.fail('QUERY_FAILED', 'AI voice may have been published but no exact self/group/media UUID receipt arrived; no retry was attempted');
            const claim = groupId + ':' + receipt.msgId; if (claims.has(claim)) p.fail('INVALID_RESPONSE', 'AI voice receipt was already claimed'); claims.add(claim);
            if (claims.size > 256) claims.delete(claims.values().next().value);
            const base = { operation: data.operation, uin: scope.saved.uin, groupId, character: data.character, text: data.text, chatType: data.chatType, fileUuid: expected.fileUuid, md5: expected.info.fileHash, size: expected.info.fileSize, confirmed: true, confirmation: 'exact_self_message_readback' };
            if (data.operation === 'voice.send') return { ...base, record: receipt };
            const target = await fixed('voice.url', { groupId, node: expected }, scope);
            if (!p.object(target) || target.groupId !== groupId || target.fileUuid !== expected.fileUuid || typeof target.url !== 'string') p.fail('INVALID_RESPONSE', 'QQ supplied another generated voice URL');
            await download(target.url, expected, scope);
            return { ...base, url: target.url };
        } finally { done = true; capture.bus.off('sendObservation', observation); capture.bus.off('sent', sent); capture.off('event', event); }
    }
    async function execute(input, context = {}) {
        const allowed = OPERATIONS[input?.operation]; if (!allowed) p.fail('UNSUPPORTED', 'Unknown fixed voice operation');
        if (!p.object(input) || Object.keys(input).some(key => !['operation', 'expectedEpoch', ...allowed].includes(key))) p.fail('INVALID_PARAMS', 'Unexpected voice operation parameters');
        const data = { ...input };
        if (input.operation === 'voice.text') { data.peer = peer(input.peer); data.nativeId = nativeId(input.nativeId); data.elementId = p.string(input.elementId, 200, false); }
        else { data.groupId = p.uin(input.groupId); data.character = p.string(input.character, 128, false); data.text = p.string(input.text, 4096, false); data.chatType = p.integer(input.chatType ?? 1, 2, 0); }
        const scope = state(data, context), capability = { 'voice.generate': 'aiVoiceGenerate', 'voice.send': 'aiVoiceSend', 'voice.text': 'pttText' }[data.operation];
        if (!capabilities()[capability]) p.fail('UNSUPPORTED', 'This QQ session lacks the required exact voice capability');
        const textKey = data.operation === 'voice.text' ? JSON.stringify([data.peer, data.nativeId, data.elementId]) : null;
        if (pending.size >= 4 || (textKey !== null ? textLocks.has(textKey) : aiWriting)) p.fail('BUSY', 'A voice operation still awaits its actual outcome');
        const token = {}; pending.add(token); if (textKey) textLocks.add(textKey); else aiWriting = true;
        const task = Promise.resolve().then(() => { scope.active(); return textKey ? transcription(data, scope) : synthesis(data, scope); });
        const release = () => { pending.delete(token); if (textKey) textLocks.delete(textKey); else aiWriting = false; }; task.then(release, release);
        const result = await capture.deadline(() => task, scope.context, data.operation === 'voice.text' ? 20000 : 60000); scope.active();
        if (Buffer.byteLength(JSON.stringify(result)) > 1500000) p.fail('INVALID_RESPONSE', 'Voice result exceeded its IPC byte budget'); return result;
    }
    return { capabilities, execute, clear() { generation++; claims.clear(); } };
}
module.exports = { createVoiceExtra, OPERATIONS, nativeId, sourceElement, fingerprint };
