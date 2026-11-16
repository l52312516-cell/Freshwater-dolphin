'use strict';

const p = require('../qq/qzone-protocol.cjs');
const protocol = require('../qq/voice-extra-protocol.cjs');
const { nativeId, sourceElement, fingerprint } = require('../qq/voice-extra.cjs');
const { locator } = require('./store.cjs');
const EXTENSION_REQUIREMENTS = Object.freeze({ get_ai_record: 'aiVoiceGenerate', send_group_ai_record: 'aiVoiceSend', fetch_ptt_text: 'pttText' });
const ACTIONS = new Set(Object.keys(EXTENSION_REQUIREMENTS));
function fields(params, allowed, self) { if (!p.object(params) || Object.keys(params).some(key => !['self_id', ...allowed].includes(key)) || params.self_id !== undefined && p.uin(params.self_id) !== String(self)) p.fail('INVALID_PARAMS', 'Unexpected voice action parameters'); }
function messageId(value) { if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d{0,9}$/.test(String(value)) || !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) p.fail('INVALID_PARAMS', 'A transcription requires a real nonzero OneBot message ID'); return Number(value); }
async function runVoiceExtra(service, state, action, params) {
    if (!ACTIONS.has(action)) p.fail('UNSUPPORTED', 'Unknown extra voice action');
    if (state.capabilities?.[EXTENSION_REQUIREMENTS[action]] !== true) p.fail('UNSUPPORTED', 'This QQ session lacks the required exact voice capability');
    const self = String(state.self.uin);
    if (action === 'fetch_ptt_text') {
        fields(params, ['message_id'], self);
        const id = messageId(params.message_id), record = await service.record(state, id, undefined, { refresh: true }), where = locator(record);
        nativeId(where.nativeId, 'INVALID_RESPONSE');
        const voices = record.elements?.filter(element => element?.elementType === 4);
        if (!Array.isArray(voices) || voices.length !== 1 || typeof voices[0].elementId !== 'string') p.fail('UNSUPPORTED', 'The message must contain one unambiguous real PTT element');
        const request = { operation: 'voice.text', peer: where.peer, nativeId: where.nativeId, elementId: voices[0].elementId };
        const original = sourceElement(record, request), signature = fingerprint(original), result = await service.sessionCall(state, 'voiceExtra', request);
        if (!p.object(result) || result.operation !== request.operation || result.uin !== self || result.nativeId !== request.nativeId || result.elementId !== request.elementId ||
            result.peer?.chatType !== request.peer.chatType || result.peer?.peerUid !== request.peer.peerUid || result.fileUuid !== original.pttElement.fileUuid || result.md5 !== original.pttElement.md5HexStr.toLowerCase() || result.size !== Number(original.pttElement.fileSize) || fingerprint(original) !== signature) p.fail('INVALID_RESPONSE', 'QQ transcription belongs to another original voice message');
        return { text: p.string(result.text, 131072, false, 'INVALID_RESPONSE') };
    }
    fields(params, ['group_id', 'character', 'text', 'chat_type'], self);
    const request = { operation: action === 'get_ai_record' ? 'voice.generate' : 'voice.send', groupId: p.uin(params.group_id), character: p.string(params.character, 128, false), text: p.string(params.text, 4096, false), chatType: p.integer(params.chat_type ?? 1, 2, 0) };
    const result = await service.sessionCall(state, 'voiceExtra', request);
    if (!p.object(result) || result.operation !== request.operation || result.uin !== self || result.groupId !== request.groupId || result.character !== request.character || result.text !== request.text || result.chatType !== request.chatType || result.confirmed !== true || result.confirmation !== 'exact_self_message_readback') p.fail('INVALID_RESPONSE', 'QQ did not confirm the requested AI voice account, group and media receipt');
    protocol.uuid(result.fileUuid, 'INVALID_RESPONSE'); protocol.digest(result.md5, 'INVALID_RESPONSE'); p.integer(result.size, 10485760, 1, 'INVALID_RESPONSE');
    if (action === 'get_ai_record') {
        p.string(result.url, 8192, false, 'INVALID_RESPONSE'); let url; try { url = new URL(result.url); } catch { p.fail('INVALID_RESPONSE', 'QQ supplied no generated voice URL'); }
        if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.qq\.com(?:\.cn)?$/i.test(url.hostname) || url.username || url.password || url.port || url.hash) p.fail('INVALID_RESPONSE', 'QQ supplied an invalid generated voice URL');
        return result.url;
    }
    const record = result.record;
    if (!p.object(record) || record.chatType !== 2 || record.peerUid !== request.groupId || String(record.senderUin) !== self || record.senderUid !== state.self.uid || record.sendStatus !== 2 || !Array.isArray(record.elements)) p.fail('INVALID_RESPONSE', 'QQ supplied no exact AI voice self-message receipt');
    nativeId(record.msgId, 'INVALID_RESPONSE'); p.integer(record.msgSeq, 0xffffffff, 1, 'INVALID_RESPONSE');
    const voices = record.elements.filter(element => element?.elementType === 4);
    if (voices.length !== 1 || voices[0].pttElement?.fileUuid !== result.fileUuid || voices[0].pttElement.md5HexStr?.toLowerCase() !== result.md5 || String(voices[0].pttElement.fileSize) !== String(result.size)) p.fail('INVALID_RESPONSE', 'QQ AI voice receipt contains another media UUID or digest');
    const entry = service.store.remember(state.self.uin, record);
    service.queueSentMessage?.({ selfId: state.self.uin, messageId: entry.id, messageType: 'group', userId: state.self.uin, groupId: request.groupId,
        senderName: state.self.nickname || record.sendNickName, groupName: record.groupName, segments: [{ type: 'record', data: {} }] });
    return { message_id: entry.id };
}
module.exports = { ACTIONS, EXTENSION_REQUIREMENTS, REQUIREMENTS: EXTENSION_REQUIREMENTS, runVoiceExtra };
