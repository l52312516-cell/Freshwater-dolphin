'use strict';

const codec = require('./codec.cjs');
const { locator } = require('./store.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const { IMPLEMENTED_ACTIONS, KNOWN_ACTIONS, capabilities } = require('./capabilities.cjs');
const media = require('../qq/media.cjs');
const { version: appVersion } = require('../../package.json');
const { ACTIONS: SOCIAL_ACTIONS, runSocial, convertSocialEvent } = require('./social-actions.cjs');
const { messageDetails } = require('../message-log.cjs');
const { runHistory } = require('./history.cjs');
const { ACTIONS: QUERY_ACTIONS, runQueryExtension } = require('./query-extensions.cjs');
const { isGrayTip, parseGrayTip } = require('../qq/gray-tip.cjs');
const { ACTIONS: INTERACTION_ACTIONS, runInteraction } = require('./interactions.cjs');
const { ACTIONS: GROUP_FILE_ACTIONS, runGroupFiles } = require('./group-files.cjs');
const { ACTIONS: FORWARD_ACTIONS, runForward, createForwardRegistry } = require('./forward.cjs');
const { ACTIONS: MERGED_ACTIONS, runMerged } = require('./merged.cjs');
const { ACTIONS: EXTENDED_ACTIONS, runExtended } = require('./extended-actions.cjs');
const { ACTIONS: GROUP_QUERIES, runGroupQueries } = require('./group-queries.cjs');
const { ACTIONS: COLLECTION_QUERIES, runCollectionQueries } = require('./collection-queries.cjs');
const { ACTIONS: ACCOUNT_QUERY_ACTIONS, runAccountQuery } = require('./account-queries.cjs');
const { decodeInlineMedia, stageInlineMedia } = require('./media-input.cjs');

function problem(code, message) { return Object.assign(new Error(message), { code }); }
function numberId(value, label = 'QQ number') {
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
        throw problem('INVALID_REQUEST', 'Invalid ' + label);
    }
    return Number(value);
}
function shortId(value) {
    if (!['string', 'number'].includes(typeof value) || !/^-?[1-9]\d*$/.test(String(value)) ||
        !Number.isInteger(Number(value)) || Number(value) < -0x80000000 || Number(value) > 0x7fffffff) {
        throw problem('INVALID_REQUEST', 'Invalid message_id');
    }
    return Number(value);
}
function quoteInteger(value, label) {
    if (value === undefined || value === null || value === '' || value === 0 || value === '0') return undefined;
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) ||
        (typeof value === 'number' && !Number.isSafeInteger(value))) {
        throw problem('INVALID_RESPONSE', 'Invalid QQ quoted ' + label);
    }
    return String(value);
}
const actions = IMPLEMENTED_ACTIONS;
const returnCodes = { INVALID_REQUEST: 1400, UNSUPPORTED: 1404, NOT_FOUND: 1404,
    INVALID_PARAMS: 1400, NOT_READY: 1503, SESSION_CHANGED: 1503, BUSY: 1503, EXPIRED: 1504, TIMEOUT: 1504 };

class OneBotService {
    constructor({ backend, store, logger = () => {}, actionTimeoutMs = 10000, mediaActionTimeoutMs = 60000, authorizeSession = () => true, mediaDirectory = null,
        mediaBaseUrl = null, mediaSigningKeyFile = null, profileId = 'default', globalServices = null } = {}) {
        if (!backend || typeof backend.call !== 'function' || !store) throw new TypeError('OneBotService needs backend and store');
        this.backend = backend;
        this.store = store;
        this.logger = logger;
        this.actionTimeoutMs = actionTimeoutMs;
        this.mediaActionTimeoutMs = mediaActionTimeoutMs;
        this.processing = new Set();
        this.noticeSession = null;
        this.noticeSeen = new Map();
        if (typeof authorizeSession !== 'function') throw new TypeError('authorizeSession must be a function');
        this.authorizeSession = authorizeSession;
        this.mediaDirectory = mediaDirectory;
        this.mediaBaseUrl = mediaBaseUrl;
        this.mediaSigningKeyFile = mediaSigningKeyFile;
        this.profileId = profileId;
        this.globalServices = globalServices;
        this.deadlines = new AsyncLocalStorage();
        this.messageLogs = new AsyncLocalStorage();
        this.operation = new AsyncLocalStorage();
        this.forwardRegistry = createForwardRegistry();
    }

    call(method, params = {}) {
        const remaining = (this.deadlines.getStore() || Date.now() + this.actionTimeoutMs) - Date.now();
        if (remaining <= 0) throw problem('EXPIRED', 'Action deadline expired; delivery may be unknown');
        return this.backend.call(method, params, { timeoutMs: remaining });
    }
    remaining() {
        const remaining = (this.deadlines.getStore() || Date.now() + this.actionTimeoutMs) - Date.now();
        if (remaining <= 0) throw problem('EXPIRED', 'Action deadline expired; delivery may be unknown');
        return remaining;
    }
    async status() { return this.call('status'); }
    async capabilities(current) {
        const status = current || await this.status();
        return capabilities({ ...status, capabilities: { ...status.capabilities,
            music: status.capabilities?.music === true && this.globalServices?.musicEnabled() === true,
            image: status.capabilities?.image === true && Boolean(this.mediaDirectory),
            file: status.capabilities?.file === true && Boolean(this.mediaDirectory),
            record: status.capabilities?.record === true && Boolean(this.mediaDirectory),
            recordExport: status.capabilities?.recordExport === true && Boolean(this.mediaDirectory),
            recordReceive: status.capabilities?.recordReceive === true && Boolean(this.mediaDirectory && this.mediaBaseUrl && this.mediaSigningKeyFile),
            video: status.capabilities?.video === true && Boolean(this.mediaDirectory),
            videoReceive: status.capabilities?.videoReceive === true && Boolean(this.mediaDirectory && this.mediaBaseUrl && this.mediaSigningKeyFile),
            imageReceive: status.capabilities?.imageReceive === true && Boolean(this.mediaDirectory && this.mediaBaseUrl && this.mediaSigningKeyFile) } });
    }

    async identity() {
        const state = await this.status();
        if (!state || typeof state.epoch !== 'string' || !state.epoch || !state.ready || !state.self || !state.self.uin || !state.self.uid) {
            throw problem('NOT_READY', 'QQ authenticated session identity is not available');
        }
        numberId(state.self.uin, 'self account');
        return state;
    }

    checkContext(state, params, expectedSession) {
        const account = state?.self?.uin;
        if (expectedSession && (!state?.ready || expectedSession.epoch !== state.epoch ||
            String(expectedSession.selfUin ?? expectedSession.uin) !== String(account))) {
            throw problem('NOT_READY', 'OneBot connection belongs to a different QQ session');
        }
        if (params.self_id !== undefined && (account === undefined || numberId(params.self_id, 'self_id') !== Number(account))) {
            throw problem('INVALID_REQUEST', 'self_id belongs to a different account');
        }
    }

    async assertSession(state) {
        if (await this.authorizeSession(state) !== true) throw problem('NOT_READY', 'This QQ session is no longer authorized');
        const current = await this.status();
        if (!current || !current.ready || current.epoch !== state.epoch || !current.self ||
            String(current.self.uin) !== String(state.self.uin) || current.self.uid !== state.self.uid) {
            throw problem('NOT_READY', 'QQ account session changed during the operation');
        }
        if (await this.authorizeSession(state) !== true) throw problem('NOT_READY', 'This QQ session is no longer authorized');
        this.remaining();
    }

    async sessionCall(state, method, params = {}) {
        const operation = this.operation.getStore();
        if (operation) operation.stage = method;
        await this.assertSession(state);
        const result = await this.call(method, { ...params, expectedEpoch: state.epoch });
        await this.assertSession(state);
        return result;
    }

    async action(request, expectedSession) {
        let response;
        const started = Date.now(), operation = { stage: 'validate' };
        try {
            if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') {
                throw problem('INVALID_REQUEST', 'Expected an action request');
            }
            if (!actions.has(request.action)) throw problem('UNSUPPORTED', 'Unsupported action');
            const params = request.params === undefined ? {} : request.params;
            if (!params || typeof params !== 'object' || Array.isArray(params)) throw problem('INVALID_REQUEST', 'params must be an object');
            let timeoutMs = ['upload_group_file', 'upload_private_file', 'get_image', 'get_record', 'get_group_file_url', 'get_group_file_system_info', ...MERGED_ACTIONS].includes(request.action) ? this.mediaActionTimeoutMs : this.actionTimeoutMs;
            if (['send_private_msg', 'send_group_msg', 'send_msg'].includes(request.action)) {
                if (params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') throw problem('INVALID_REQUEST', 'auto_escape must be boolean');
                const validated = codec.parse(params.message, params.auto_escape === true);
                if (validated.some(segment => ['image', 'music', 'record', 'video', 'file'].includes(segment.type))) timeoutMs = this.mediaActionTimeoutMs;
            }
            const expiresAt = Date.now() + timeoutMs;
            const messages = [];
            const data = await this.operation.run(operation, () => this.messageLogs.run(messages,
                () => this.deadlines.run(expiresAt, () => this.run(request.action, params, expectedSession))));
            if (Date.now() >= expiresAt) throw problem('EXPIRED', 'Action completed after its deadline; delivery may be unknown');
            response = { status: 'ok', retcode: 0, data: data === undefined ? null : data };
            for (const message of messages) this.logMessage(message);
        } catch (error) {
            response = { status: 'failed', retcode: returnCodes[error.code] || 1500,
                data: null, message: error.message || 'Action failed', wording: error.message || 'Action failed' };
            this.log('action_failed', { action: KNOWN_ACTIONS.has(request?.action) ? request.action : 'unsupported',
                stage: operation.stage, durationMs: Date.now() - started, code: error.code || 'INTERNAL_ERROR' });
        }
        if (request && Object.hasOwn(request, 'echo')) response.echo = request.echo;
        return response;
    }

    log(event, data) {
        try {
            if (typeof this.logger === 'function') this.logger(event, data);
            else if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(event, data);
        } catch {}
    }

    logMessage(details) {
        try { if (typeof this.logger?.message === 'function') this.logger.message(messageDetails({ profileId: this.profileId, ...details })); }
        catch { /* Diagnostics must not turn a confirmed delivery into a failed action. */ }
    }

    queueSentMessage(details) {
        // Commit send logs only after the outer action's final deadline check.
        // A confirmed native send followed by an expired action is ambiguous to
        // its caller and must not be reported as an ordinary successful send.
        this.messageLogs.getStore()?.push({ direction: 'sent', ...details });
    }

    async run(action, params, expectedSession) {
        if (['get_stranger_info', 'get_group_list', 'get_group_info', 'get_group_member_info', 'get_group_member_list'].includes(action) &&
            params.no_cache !== undefined && typeof params.no_cache !== 'boolean') throw problem('INVALID_REQUEST', 'no_cache must be boolean');
        if (['get_capabilities', 'can_send_record', 'can_send_image', 'get_version_info', 'get_status'].includes(action)) {
            const current = await this.status();
            this.checkContext(current, params, expectedSession);
            if (action === 'get_capabilities') return this.capabilities(current);
            if (action === 'can_send_record') return { yes: Boolean(current.ready && current.capabilities?.record === true && this.mediaDirectory) };
            if (action === 'can_send_image') return { yes: Boolean(current.ready && current.capabilities?.image === true && this.mediaDirectory) };
            if (action === 'get_version_info') return { app_name: 'Freshwater-dolphin', app_version: appVersion, protocol_version: 'v11' };
            return { online: current.online === true, qq_online_state: current.online === true ? 'online' : current.online === false ? 'offline' : 'unknown',
                good: Boolean(current.ready && current.online === true) };
        }
        const state = await this.identity();
        const account = String(state.self.uin);
        this.checkContext(state, params, expectedSession);
        if (SOCIAL_ACTIONS.has(action)) return runSocial(this, state, action, params);
        if (QUERY_ACTIONS.has(action)) return runQueryExtension(this, state, action, params);
        if (INTERACTION_ACTIONS.has(action)) return runInteraction(this, state, action, params);
        if (GROUP_FILE_ACTIONS.has(action)) return runGroupFiles(this, state, action, params);
        if (MERGED_ACTIONS.has(action)) return runMerged(this, state, action, params);
        if (FORWARD_ACTIONS.has(action)) return runForward(this, state, action, params);
        if (EXTENDED_ACTIONS.has(action)) return runExtended(this, state, action, params);
        if (GROUP_QUERIES.has(action)) return runGroupQueries(this, state, action, params);
        if (COLLECTION_QUERIES.has(action)) return runCollectionQueries(this, state, action, params);
        if (ACCOUNT_QUERY_ACTIONS.has(action)) return runAccountQuery(this, state, action, params);
        switch (action) {
        case 'get_login_info': {
            let nickname = typeof state.self.nickname === 'string' ? state.self.nickname : '';
            if (!nickname) {
                try {
                    const profile = await this.sessionCall(state, 'user', { uid: state.self.uid });
                    if (!profile || numberId(profile.user_id, 'profile account') !== Number(account) || typeof profile.nickname !== 'string') {
                        throw problem('INVALID_RESPONSE', 'Self profile does not match the authenticated account');
                    }
                    nickname = profile.nickname;
                } catch (error) {
                    this.log('self_profile_unavailable', { code: error.code || 'INVALID_RESPONSE' });
                }
            }
            await this.assertSession(state);
            return { user_id: Number(account), nickname };
        }
        case 'get_friend_list': return this.sessionCall(state, 'friends');
        case 'get_stranger_info': return this.sessionCall(state, 'user', { uin: String(numberId(params.user_id)), refresh: Boolean(params.no_cache) });
        case 'get_group_list': return this.sessionCall(state, 'groups', { refresh: Boolean(params.no_cache) });
        case 'get_group_info': return this.sessionCall(state, 'groupInfo', { groupId: String(numberId(params.group_id, 'group_id')), refresh: Boolean(params.no_cache) });
        case 'get_group_member_info': return this.sessionCall(state, 'groupMember', { groupId: String(numberId(params.group_id, 'group_id')),
            uin: String(numberId(params.user_id)), refresh: Boolean(params.no_cache) });
        case 'get_group_member_list': return this.sessionCall(state, 'groupMembers', { groupId: String(numberId(params.group_id, 'group_id')),
            refresh: Boolean(params.no_cache) });
        case 'get_private_file_url': {
            if (state.capabilities?.privateFileUrl !== true) throw problem('UNSUPPORTED', 'Private file URL queries are unavailable on this QQ instance');
            const record = await this.record(state, shortId(params.message_id));
            const where = locator(record);
            if (where.peer.chatType !== 1) throw problem('INVALID_REQUEST', 'Private file lookup requires a private message');
            if (params.file_id !== undefined && (typeof params.file_id !== 'string' || !params.file_id || params.file_id.length > 1024)) throw problem('INVALID_REQUEST', 'Invalid private file_id');
            const files = (record.elements || []).filter(item => item?.elementType === 3 && item.fileElement &&
                (params.file_id === undefined || item.fileElement.fileUuid === params.file_id));
            if (files.length !== 1 || typeof files[0].elementId !== 'string' || !files[0].elementId) throw problem('NOT_FOUND', 'Private message has no unique matching file');
            const result = await this.sessionCall(state, 'nativePrivateFileUrl', { peer: where.peer, nativeId: where.nativeId,
                elementId: files[0].elementId, expectedUin: account, timeoutMs: Math.min(10000, this.remaining()) });
            if (result?.fileId !== files[0].fileElement.fileUuid || typeof result.url !== 'string') throw problem('INVALID_RESPONSE', 'QQ returned another private file');
            return { url: require('../qq/private-file-url.cjs').validateDownloadUrl(result.url) };
        }
        case 'get_group_msg_history': case 'get_friend_msg_history': return this.history(state, params, action);
        case 'upload_group_file': case 'upload_private_file': return this.uploadFile(state, params, action);
        case 'get_image': {
            if (!media.IMAGE_RESOURCE.test(String(params.file || ''))) throw problem('INVALID_REQUEST', 'get_image requires an opaque account image ID');
            const info = await this.sessionCall(state, 'imageInfo', { file: params.file });
            if (info?.file !== params.file) throw problem('INVALID_RESPONSE', 'QQ returned a different image resource');
            return { file: info.path, size: info.size, filename: info.filename, width: info.width, height: info.height,
                url: media.signedImageUrl(this, info.file) };
        }
        case 'get_record': {
            if (state.capabilities?.recordExport !== true || !this.mediaDirectory) throw problem('UNSUPPORTED', 'Voice format export is unavailable on this QQ instance');
            if (Object.keys(params).some(key => !['file', 'out_format', 'self_id'].includes(key)) ||
                typeof params.file !== 'string' || !/^fwd-record-[a-f0-9]{32}$/.test(params.file) || typeof params.out_format !== 'string') {
                throw problem('INVALID_REQUEST', 'get_record needs an account voice resource and out_format');
            }
            if (!['silk', 'wav', 'mp3', 'flac', 'ogg'].includes(params.out_format)) throw problem('UNSUPPORTED', 'The requested voice output format is unavailable');
            const result = await this.sessionCall(state, 'recordExport', { file: params.file, outFormat: params.out_format });
            if (result?.file !== params.file || result.outFormat !== params.out_format || result.format !== params.out_format ||
                typeof result.path !== 'string' || !require('node:path').isAbsolute(result.path) || !this.mediaDirectory || !media.inside(this.mediaDirectory, result.path) ||
                !Number.isSafeInteger(result.size) || result.size < 1 || result.size > 32 * 1024 * 1024) throw problem('INVALID_RESPONSE', 'QQ returned no matching account voice export');
            return { file: result.path };
        }
        case 'set_group_name': case 'set_group_whole_ban': case 'set_group_ban': case 'set_group_leave': case 'set_group_card': case 'set_group_admin': case 'set_group_kick':
            return this.groupAction(state, params, action);
        case 'delete_msg': {
            const id = shortId(params.message_id);
            const record = await this.record(state, id, undefined, { refresh: true });
            const where = locator(record);
            const result = await this.sessionCall(state, 'recall', { peer: where.peer, nativeId: where.nativeId });
            if (result?.recalled !== true) throw problem('INVALID_RESPONSE', 'QQ did not confirm message recall');
            this.store.setRecalled(account, id);
            return null;
        }
        case 'get_msg': {
            const record = await this.record(state, shortId(params.message_id));
            const entry = this.store.remember(account, record);
            const converted = await this.convert(state, record, entry.id, { queryFiles: true });
            this.store.setEvent(account, entry.id, converted, false);
            return this.queryResult(converted, record);
        }
        case 'send_private_msg': case 'send_group_msg': case 'send_msg': return this.send(state, params, action);
        default: throw problem('UNSUPPORTED', 'Unsupported action');
        }
    }

    async record(state, id, expectedPeer, { refresh = false } = {}) {
        await this.assertSession(state);
        const account = String(state.self.uin);
        const entry = this.store.get(account, id);
        if (!entry) throw problem('NOT_FOUND', 'Message is outside the known account history');
        if (refresh && entry.recalled) throw problem('NOT_FOUND', 'Message is already known to be recalled');
        if (expectedPeer && (entry.locator.peer.chatType !== expectedPeer.chatType || entry.locator.peer.peerUid !== expectedPeer.peerUid)) {
            throw problem('INVALID_REQUEST', 'Quoted message belongs to another conversation');
        }
        if (entry.record && !refresh) return entry.record;
        if (refresh && !entry.locator.senderUin) throw problem('NOT_FOUND', 'Quoted message has no verified original sender');
        const record = await this.sessionCall(state, 'getMessage', entry.locator);
        const actual = locator(record);
        if (actual.peer.chatType !== entry.locator.peer.chatType || actual.peer.peerUid !== entry.locator.peer.peerUid ||
            actual.nativeId !== entry.locator.nativeId) throw problem('INVALID_RESPONSE', 'QQ returned a different message');
        if (refresh && (actual.senderUin !== entry.locator.senderUin ||
            (entry.locator.seq && entry.locator.seq !== '0' && actual.seq !== entry.locator.seq) ||
            (entry.locator.clientSeq && entry.locator.clientSeq !== '0' && actual.clientSeq !== entry.locator.clientSeq) ||
            ((entry.locator.senderUid || entry.record?.senderUid) && actual.senderUid !== (entry.locator.senderUid || entry.record.senderUid)) ||
            ((entry.locator.time || entry.record?.msgTime) && actual.time !== String(entry.locator.time || entry.record.msgTime)))) {
            throw problem('INVALID_RESPONSE', 'QQ quoted message does not match its known sender and sequence');
        }
        this.store.remember(account, record);
        return record;
    }

    queryResult(converted, record) {
        const result = { time: converted.time, message_type: converted.message_type,
            message_id: converted.message_id, real_id: converted.message_id,
            sender: converted.sender, message: converted.message, raw_message: converted.raw_message };
        if (converted.group_id) result.group_id = converted.group_id;
        if (record.msgSeq && /^\d+$/.test(String(record.msgSeq)) && Number.isSafeInteger(Number(record.msgSeq))) result.message_seq = Number(record.msgSeq);
        return result;
    }

    async quotedMessage(state, peer, reference) {
        // sourceMsgIdInRecords can identify QQ's separate quote-preview record.
        // It must never override the original message's replayMsgId or become a
        // substitute for a missing original identity.
        quoteInteger(reference.sourceMsgIdInRecords, 'preview identity');
        const nativeId = quoteInteger(reference.replayMsgId, 'message identity');
        const seq = quoteInteger(reference.replayMsgSeq, 'message sequence');
        const clientSeq = quoteInteger(reference.replyMsgClientSeq, 'client sequence');
        const time = quoteInteger(reference.replyMsgTime, 'message time');
        if (time && !Number.isSafeInteger(Number(time))) throw problem('INVALID_RESPONSE', 'Invalid QQ quoted message time');
        const senderUin = quoteInteger(reference.senderUin, 'sender account');
        if (senderUin) numberId(senderUin, 'quoted sender account');
        const senderUid = reference.senderUidStr || (/^u_/.test(reference.senderUid || '') ? reference.senderUid : undefined);
        if (senderUid !== undefined && (typeof senderUid !== 'string' || !/^u_[A-Za-z0-9_-]+$/.test(senderUid))) {
            throw problem('INVALID_RESPONSE', 'Invalid QQ quoted sender UID');
        }
        if (senderUid && /^u_/.test(reference.senderUid || '') && reference.senderUid !== senderUid) {
            throw problem('INVALID_RESPONSE', 'QQ quoted sender UIDs disagree');
        }
        if (senderUid && senderUin && ((senderUid === state.self.uid) !== (senderUin === String(state.self.uin)))) {
            throw problem('INVALID_RESPONSE', 'QQ quoted sender UID and account disagree');
        }
        if (peer.chatType === 1 && senderUid && senderUid !== peer.peerUid && senderUid !== state.self.uid) {
            throw problem('INVALID_RESPONSE', 'QQ quoted author is outside this private conversation');
        }
        const privateTuple = peer.chatType === 1 && clientSeq && senderUid && time;
        if (!nativeId && !seq && !privateTuple) throw problem('NOT_FOUND', 'Quoted message has no reliable original identity');
        const match = { peer, nativeId, seq, clientSeq, senderUin, senderUid, time };
        const account = String(state.self.uin);
        let entry = this.store.find(account, match);
        if (!entry) {
            const quoted = await this.sessionCall(state, 'getMessage', match);
            const actual = locator(quoted);
            if (actual.peer.chatType !== peer.chatType || actual.peer.peerUid !== peer.peerUid ||
                (nativeId && actual.nativeId !== nativeId) || (seq && actual.seq !== seq) ||
                (clientSeq && actual.clientSeq !== clientSeq) || (senderUin && actual.senderUin !== senderUin) ||
                (senderUid && actual.senderUid !== senderUid) || (time && actual.time !== time)) {
                throw problem('INVALID_RESPONSE', 'QQ returned a different quoted message');
            }
            entry = this.store.remember(account, quoted);
        }
        return entry.id;
    }

    async history(state, params, action) {
        return runHistory(this, state, params, action, { numberId, shortId });
    }

    async send(state, params, action) {
        if (params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') throw problem('INVALID_REQUEST', 'auto_escape must be boolean');
        const segments = codec.parse(params.message, params.auto_escape === true);
        if (segments.some(item => item.type === 'share')) throw problem('UNSUPPORTED', 'Share sending is disabled because target QQ clients could not render the card');
        if (segments.some(item => item.type === 'face') && state.capabilities?.face !== true) {
            throw problem('UNSUPPORTED', 'QQ built-in face sending is unavailable in the current session');
        }
        const images = segments.filter(item => item.type === 'image');
        if (segments.some(item => item.type === 'music') && (state.capabilities?.music !== true || !this.globalServices)) {
            throw problem('UNSUPPORTED', 'QQ music card sending is unavailable in this session');
        }
        if (images.length && (state.capabilities?.image !== true || !this.mediaDirectory)) throw problem('UNSUPPORTED', 'Local native image sending is unavailable');
        for (const image of images) media.readImage(this.mediaDirectory, image.data.file);
        const records = segments.filter(item => item.type === 'record');
        if (records.length && (state.capabilities?.record !== true || !this.mediaDirectory)) throw problem('UNSUPPORTED', 'Native voice sending is unavailable');
        for (const record of records) {
            if (record.data.file.startsWith('base64://')) decodeInlineMedia(record.data.file, 'record');
            else media.readLocal(this.mediaDirectory, record.data.file);
        }
        const files = segments.filter(item => item.type === 'file'), videos = segments.filter(item => item.type === 'video');
        if (files.length && (state.capabilities?.file !== true || !this.mediaDirectory)) throw problem('UNSUPPORTED', 'Native local file sending is unavailable');
        if (videos.length && (state.capabilities?.video !== true || !this.mediaDirectory)) throw problem('UNSUPPORTED', 'Native local MP4 video sending is unavailable');
        for (const segment of [...files, ...videos]) {
            if (segment.data.file.startsWith('base64://')) decodeInlineMedia(segment.data.file, segment.type);
            else media.readLocal(this.mediaDirectory, segment.data.file);
        }
        let chatType;
        if (action === 'send_private_msg') chatType = 1;
        else if (action === 'send_group_msg') chatType = 2;
        else if (params.message_type === 'private') chatType = 1;
        else if (params.message_type === 'group') chatType = 2;
        else if (params.message_type !== undefined) throw problem('INVALID_REQUEST', 'message_type must be private or group');
        else if (params.group_id !== undefined) chatType = 2;
        else if (params.user_id !== undefined) chatType = 1;
        else throw problem('INVALID_REQUEST', 'Message target is missing');
        const target = String(numberId(chatType === 2 ? params.group_id : params.user_id, chatType === 2 ? 'group_id' : 'user_id'));
        if (chatType === 1 && segments.some(item => item.type === 'at')) throw problem('UNSUPPORTED', 'Mentions require a group conversation');
        const resolved = chatType === 1 ? await this.sessionCall(state, 'resolve', { uin: target }) : null;
        if (chatType === 1 && (!resolved || !/^u_/.test(resolved.uid || '') || String(resolved.uin) !== target)) {
            throw problem('NOT_FOUND', 'Private target has no verified kernel UID');
        }
        const peer = { chatType, peerUid: chatType === 2 ? target : resolved.uid };
        const account = String(state.self.uin);
        const temporaryImages = [];
        try {
            // Import only after every segment and input has passed validation. The
            // kernel RPC receives an account-local filename, never a base64 body.
            for (const image of images) if (image.data.file.startsWith('base64://')) {
                const resource = media.exportImage(this.mediaDirectory, media.readImage(this.mediaDirectory, image.data.file));
                temporaryImages.push(resource.path);
                image.data.file = resource.path;
            }
            for (const segment of [...records, ...files, ...videos]) if (segment.data.file.startsWith('base64://')) {
                const imported = stageInlineMedia(this.mediaDirectory, segment.type, segment.data.file);
                temporaryImages.push(imported); segment.data.file = imported;
            }
            const elements = await codec.toKernel(segments, {
                peer,
                prepareMedia: data => this.sessionCall(state, 'prepareMedia', { type: 'image', ...data }),
                prepareRecord: data => this.sessionCall(state, 'prepareMedia', { type: 'record', ...data }),
                prepareFile: data => this.sessionCall(state, 'prepareMedia', { type: 'file', ...data }),
                prepareVideo: data => this.sessionCall(state, 'prepareMedia', { type: 'video', ...data }),
                prepareShare: data => this.sessionCall(state, 'prepareShare', { peer, data }),
                prepareMusic: async data => {
                    const operation = this.operation.getStore();
                    if (operation) operation.stage = 'signMusic';
                    await this.assertSession(state);
                    const signed = await this.globalServices.signMusic(data, { timeoutMs: this.remaining() });
                    await this.assertSession(state);
                    return this.sessionCall(state, 'prepareMusic', { peer, card: signed.text });
                },
                resolve: uin => this.sessionCall(state, 'resolve', { uin }),
                member: uin => this.sessionCall(state, 'groupMember', { groupId: target, uin }),
                reply: id => this.record(state, id, peer, { refresh: true })
            });
            const record = await this.sessionCall(state, 'sendMessage', { peer, elements, timeoutMs: this.remaining() });
            const actual = locator(record);
            if (actual.peer.chatType !== peer.chatType || actual.peer.peerUid !== peer.peerUid || String(record.senderUin) !== account) {
                throw problem('INVALID_RESPONSE', 'QQ confirmation belongs to a different message target');
            }
            const entry = this.store.remember(account, record);
            this.queueSentMessage({ selfId: account, messageId: entry.id, messageType: chatType === 2 ? 'group' : 'private',
                userId: account, ...(chatType === 2 ? { groupId: target } : { peerId: target }),
                senderName: state.self.nickname || record.sendNickName, groupName: record.groupName, segments });
            return { message_id: entry.id };
        } finally {
            for (const file of temporaryImages) {
                try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') this.log('image_import_cleanup_failed', { code: 'MEDIA_CLEANUP' }); }
            }
        }
    }

    async uploadFile(state, params, action) {
        if (state.capabilities?.file !== true || !this.mediaDirectory) throw problem('UNSUPPORTED', 'Native local file uploads are unavailable');
        if (params.folder !== undefined && params.folder !== '' || params.folder_id !== undefined && params.folder_id !== '' ||
            params.upload_file !== undefined && params.upload_file !== true) throw problem('UNSUPPORTED', 'Only actual uploads to the conversation root are available');
        const file = media.readLocal(this.mediaDirectory, params.file);
        const name = params.name ?? file.filename;
        if (typeof name !== 'string' || !name.trim() || ['.', '..'].includes(name) || /[\\/\x00-\x1f\x7f-\x9f]/.test(name) || Buffer.byteLength(name) > 255) throw problem('INVALID_REQUEST', 'Invalid upload filename');
        const chatType = action === 'upload_group_file' ? 2 : 1;
        const target = String(numberId(chatType === 2 ? params.group_id : params.user_id));
        const resolved = chatType === 1 ? await this.sessionCall(state, 'resolve', { uin: target }) : null;
        if (chatType === 1 && (!resolved || !/^u_/.test(resolved.uid || '') || String(resolved.uin) !== target)) {
            throw problem('NOT_FOUND', 'Private upload target has no verified kernel UID');
        }
        const peer = { chatType, peerUid: chatType === 2 ? target : resolved.uid };
        const element = await this.sessionCall(state, 'prepareMedia', { type: 'file', file: params.file, name });
        if (element?.elementType !== 3 || !element.fileElement) throw problem('INVALID_RESPONSE', 'QQ returned no prepared file');
        const record = await this.sessionCall(state, 'sendMessage', { peer, elements: [element], timeoutMs: this.remaining() });
        const actual = locator(record);
        if (actual.peer.chatType !== peer.chatType || actual.peer.peerUid !== peer.peerUid || String(record.senderUin) !== String(state.self.uin)) {
            throw problem('INVALID_RESPONSE', 'QQ file confirmation belongs to a different target');
        }
        const entry = this.store.remember(state.self.uin, record);
        const uploaded = record.elements?.find(item => item.elementType === 3)?.fileElement;
        this.queueSentMessage({ selfId: state.self.uin, messageId: entry.id, messageType: chatType === 2 ? 'group' : 'private',
            userId: state.self.uin, ...(chatType === 2 ? { groupId: target } : { peerId: target }),
            senderName: state.self.nickname || record.sendNickName, groupName: record.groupName, segments: [{ type: 'file', data: {} }] });
        return { file_id: typeof uploaded?.fileUuid === 'string' && uploaded.fileUuid ? uploaded.fileUuid : null, message_id: entry.id };
    }

    async groupAction(state, params, action) {
        const groupId = String(numberId(params.group_id, 'group_id'));
        let operation, extra = {};
        if (action === 'set_group_name') {
            if (typeof params.group_name !== 'string' || !params.group_name.trim() || Buffer.byteLength(params.group_name) > 255) throw problem('INVALID_REQUEST', 'Invalid group_name');
            operation = 'name'; extra.name = params.group_name;
        } else if (action === 'set_group_whole_ban') {
            if (params.enable !== undefined && typeof params.enable !== 'boolean') throw problem('INVALID_REQUEST', 'enable must be boolean');
            operation = 'wholeBan'; extra.enable = params.enable ?? true;
        } else if (action === 'set_group_kick') {
            if (state.capabilities?.groupKick !== true) throw problem('UNSUPPORTED', 'QQ member removal confirmation is unavailable');
            const uin = String(numberId(params.user_id));
            if (params.reject_add_request !== undefined && typeof params.reject_add_request !== 'boolean') throw problem('INVALID_REQUEST', 'reject_add_request must be boolean');
            const reason = params.reason ?? '';
            if (typeof reason !== 'string' || Buffer.byteLength(reason) > 1024 || reason.includes('\0')) throw problem('INVALID_REQUEST', 'Invalid removal reason');
            operation = 'kick'; extra = { uin, rejectAddRequest: params.reject_add_request ?? false, reason };
        } else if (action === 'set_group_ban') {
            const duration = params.duration ?? 1800;
            if (!Number.isInteger(duration) || duration < 0 || duration > 2592000) throw problem('INVALID_REQUEST', 'duration must be seconds in 0..2592000');
            const uin = String(numberId(params.user_id));
            const [target, self] = await Promise.all([
                this.sessionCall(state, 'groupMember', { groupId, uin, refresh: true }),
                this.sessionCall(state, 'groupMember', { groupId, uin: String(state.self.uin), refresh: true })
            ]);
            if (target.role === 'owner' || !['admin', 'owner'].includes(self.role) ||
                (target.role === 'admin' && self.role !== 'owner')) throw problem('UNSUPPORTED', 'This account cannot moderate that group member');
            operation = 'memberBan'; extra = { uin, duration };
        } else if (action === 'set_group_card' || action === 'set_group_admin') {
            const uin = String(numberId(params.user_id));
            const target = await this.sessionCall(state, 'groupMember', { groupId, uin, refresh: true });
            if (action === 'set_group_card') {
                const card = params.card ?? '';
                if (typeof card !== 'string' || Buffer.byteLength(card) > 255) throw problem('INVALID_REQUEST', 'Invalid member card');
                operation = 'card'; extra = { uin, card };
            } else {
                if (params.enable !== undefined && typeof params.enable !== 'boolean') throw problem('INVALID_REQUEST', 'enable must be boolean');
                const self = await this.sessionCall(state, 'groupMember', { groupId, uin: String(state.self.uin), refresh: true });
                if (self.role !== 'owner' || target.role === 'owner') throw problem('UNSUPPORTED', 'Only the group owner can change this member role');
                operation = 'admin'; extra = { uin, enable: params.enable ?? true };
            }
        } else {
            if (params.is_dismiss !== undefined && params.is_dismiss !== false) throw problem('UNSUPPORTED', 'Dismissing groups is unavailable');
            operation = 'leave';
        }
        const result = await this.sessionCall(state, 'groupAction', { groupId, operation, ...extra });
        if (result?.confirmed !== true) throw problem('INVALID_RESPONSE', 'QQ did not confirm the group mutation');
        return null;
    }

    async receivedResource(state, record, element, type) {
        if (state.capabilities?.[type + 'Receive'] !== true || !this.mediaDirectory || !this.mediaBaseUrl || !this.mediaSigningKeyFile) {
            throw problem('UNSUPPORTED', 'Signed native ' + type + ' receipt is unavailable');
        }
        if (typeof element.elementId !== 'string' || !element.elementId) throw problem('UNSUPPORTED', 'QQ media has no exact element identity');
        const info = await this.sessionCall(state, 'receiveMedia', { peer: { chatType: Number(record.chatType), peerUid: String(record.peerUid) },
            nativeId: String(record.msgId), elementId: element.elementId });
        if (info?.type !== type || !media.RESOURCE.test(info.file)) throw problem('INVALID_RESPONSE', 'QQ returned another media resource type');
        // The signed endpoint serves this account's actual resource bytes.
        // Re-read video metadata there instead of trusting mutable native
        // element fields or retaining a previous upload's prepared metadata.
        const resource = type === 'video' ? media.resourceInfo(this.mediaDirectory, info.file) : info;
        if (resource.type !== type || resource.size !== info.size) throw problem('INVALID_RESPONSE', 'QQ media resource does not match this account file');
        return { file: info.file, url: media.signedMediaUrl(this, info.file), file_size: String(resource.size),
            ...(Number.isSafeInteger(resource.width) && resource.width > 0 ? { width: resource.width } : {}),
            ...(Number.isSafeInteger(resource.height) && resource.height > 0 ? { height: resource.height } : {}),
            ...(typeof resource.duration === 'number' && Number.isFinite(resource.duration) && resource.duration >= 0
                ? { duration: resource.duration } : {}) };
    }

    async receivedFile(state, record, element, base) {
        const source = element.fileElement;
        try {
            if (Number(record.chatType) === 1) {
                const result = await this.sessionCall(state, 'nativePrivateFileUrl', {
                    peer: { chatType: 1, peerUid: String(record.peerUid) }, nativeId: String(record.msgId), elementId: element.elementId,
                    expectedUin: state.self.uin, timeoutMs: Math.min(10000, this.remaining()) });
                if (result?.fileId !== source.fileUuid || typeof result.url !== 'string') throw problem('INVALID_RESPONSE', 'QQ returned another private file');
                return { ...base, url: require('../qq/private-file-url.cjs').validateDownloadUrl(result.url) };
            }
            const result = await this.sessionCall(state, 'nativeGroupFileUrl', {
                groupId: String(record.peerUid), fileId: source.fileUuid,
                busId: Number.isSafeInteger(source.fileBizId) ? source.fileBizId : undefined,
                fileName: source.fileName, expectedUin: state.self.uin });
            if (typeof result?.url === 'string' && /^https:\/\/[a-z0-9.-]+\.qq\.com\/ftn_handler\//i.test(result.url)) {
                return { ...base, url: result.url };
            }
        } catch {
            // A temporarily unavailable URL still leaves valid file metadata.
        }
        return base;
    }

    async convert(state, record, id, { queryFiles = false } = {}) {
        const account = String(state.self.uin);
        const peer = { chatType: Number(record.chatType), peerUid: String(record.peerUid) };
        const senderId = record.senderUin ? numberId(record.senderUin, 'sender account') :
            numberId((await this.sessionCall(state, 'resolve', { uid: record.senderUid })).uin, 'sender account');
        const message = await codec.fromKernel(record, {
            queryFiles,
            file: (Number(record.chatType) === 2 && state.capabilities?.groupFileUrl === true || Number(record.chatType) === 1 && state.capabilities?.privateFileUrl === true)
                ? (element, base) => this.receivedFile(state, record, element, base) : undefined,
            forward: element => ({ id: this.forwardRegistry.register(state, record, element) }),
            selfUin: account, selfUid: state.self.uid,
            resolveUid: uid => this.sessionCall(state, 'resolve', { uid }),
            record: element => this.receivedResource(state, record, element, 'record'),
            video: element => this.receivedResource(state, record, element, 'video'),
            image: async element => {
                const pic = element.picElement;
                if (!pic || typeof element.elementId !== 'string' || !element.elementId) throw problem('UNSUPPORTED', 'QQ image has no exact retrievable element identity');
                let info;
                if (state.capabilities?.imageReceive === true && this.mediaDirectory) {
                    try { info = await this.sessionCall(state, 'receiveMedia', { peer, nativeId: String(record.msgId), elementId: element.elementId }); }
                    catch (error) { if (!['NOT_FOUND', 'UNSUPPORTED', 'ENOENT'].includes(error.code)) throw error; }
                }
                if (info && this.mediaBaseUrl && this.mediaSigningKeyFile) {
                    return { file: info.file, url: media.signedImageUrl(this, info.file), file_size: String(info.size),
                        ...(typeof pic.summary === 'string' ? { summary: pic.summary } : {}) };
                }
                const raw = pic.originImageUrl;
                let url;
                try { url = typeof raw === 'string' ? new URL(raw) : null; } catch { url = null; }
                if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
                    !['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn'].includes(url.hostname)) {
                    throw problem('UNSUPPORTED', 'QQ image has neither an accessible signed local resource nor a complete official HTTPS URL');
                }
                const resolvedUrl = this.globalServices ? await this.globalServices.resolveImageUrl(url.href, peer.chatType === 2,
                    { timeoutMs: this.remaining() }) : url.href;
                await this.assertSession(state);
                return { file: info?.file || String(pic.fileName || pic.fileUuid || pic.md5HexStr || element.elementId), url: resolvedUrl,
                    ...(typeof pic.summary === 'string' ? { summary: pic.summary } : {}) };
            },
            reply: reference => this.quotedMessage(state, peer, reference)
        });
        await this.assertSession(state);
        const time = Number(record.msgTime);
        if (!Number.isSafeInteger(time) || time <= 0) throw problem('INVALID_RESPONSE', 'QQ message has no valid timestamp');
        const result = { time, self_id: Number(account), post_type: 'message',
            message_type: peer.chatType === 2 ? 'group' : 'private',
            sub_type: peer.chatType === 2 ? 'normal' : 'friend', message_id: id,
            user_id: senderId, message, raw_message: codec.stringify(message), font: 0,
            sender: { user_id: senderId, nickname: String(record.sendNickName || record.senderNickname || '') } };
        if (peer.chatType === 2) {
            result.group_id = numberId(record.peerUin || peer.peerUid, 'group_id');
            result.sender.card = String(record.sendMemberName || '');
            const roles = { 2: 'member', 3: 'admin', 4: 'owner' };
            const role = roles[record.senderRole] || (['member', 'admin', 'owner'].includes(record.senderRole) ? record.senderRole : null);
            if (role) result.sender.role = role;
        }
        return result;
    }

    async event(event) {
        const containsMedia = event?.kind === 'message' && Array.isArray(event.record?.elements) &&
            event.record.elements.some(element => [2, 3, 4, 5].includes(element?.elementType));
        return this.deadlines.run(Date.now() + (containsMedia ? this.mediaActionTimeoutMs : this.actionTimeoutMs), () => this.eventInto(event));
    }

    async eventInto(event) {
        if (event?.kind === 'request') {
            try { return await convertSocialEvent(this, await this.identity(), event); }
            catch (error) { this.log('request_skipped', { code: error.code || 'INTERNAL_ERROR' }); return null; }
        }
        if (event?.kind === 'notice') return this.notice(event);
        if (!event || event.kind !== 'message' || !event.record) return null;
        // Older queue snapshots can still label a system tip as a message.
        // Route before sender validation, echo filtering or allocating an ID.
        if (isGrayTip(event.record)) return this.notice({ ...event, kind: 'notice', notice: 'gray_tip' });
        let processingKey, ownsProcessing = false;
        try {
            const state = await this.identity();
            if (event.epoch !== state.epoch || String(event.selfUin || '') !== String(state.self.uin)) {
                throw problem('NOT_READY', 'Incoming message belongs to a different QQ account session');
            }
            const record = event.record;
            if (![1, 2].includes(Number(record.chatType))) return null;
            if (String(record.senderUin || '') === String(state.self.uin) || record.senderUid === state.self.uid) return null;
            const where = locator(record);
            processingKey = JSON.stringify([state.self.uin, where.peer.chatType, where.peer.peerUid, where.nativeId]);
            if (this.processing.has(processingKey)) return null;
            this.processing.add(processingKey);
            ownsProcessing = true;
            const entry = this.store.remember(state.self.uin, record);
            if (entry.emitted) return null;
            const converted = await this.convert(state, record, entry.id);
            await this.assertSession(state);
            this.store.setEvent(state.self.uin, entry.id, converted, true);
            this.logMessage({ direction: 'received', selfId: state.self.uin, messageId: entry.id,
                messageType: converted.message_type, userId: converted.user_id,
                ...(converted.message_type === 'group' ? { groupId: converted.group_id } : { peerId: converted.user_id }),
                senderName: converted.sender?.nickname, card: converted.sender?.card, groupName: record.groupName,
                segments: converted.message });
            return converted;
        } catch (error) {
            this.log('message_skipped', { code: error.code || 'INTERNAL_ERROR' });
            return null;
        } finally {
            if (ownsProcessing) this.processing.delete(processingKey);
        }
    }

    async pokeNotice(event) {
        let key, ownsProcessing = false, stage = 'parse';
        try {
            const state = await this.identity();
            stage = 'event_session';
            if (event.epoch !== state.epoch || String(event.selfUin) !== String(state.self.uin)) {
                throw problem('SESSION_CHANGED', 'Notice belongs to another QQ session');
            }
            stage = 'parse';
            const parsed = parseGrayTip(event.record);
            if (!parsed || parsed.kind !== 'poke') {
                this.log('notice_skipped', { code: 'UNSUPPORTED', stage: 'gray_tip', reason: 'unsupported_gray_tip' });
                return null;
            }
            const record = event.record, where = locator(record);
            if (!/^[1-9]\d{0,19}$/.test(where.nativeId) || BigInt(where.nativeId) > 0xffffffffffffffffn) {
                throw problem('INVALID_RESPONSE', 'Poke has no exact native event identity');
            }
            stage = 'stale_event';
            const time = Number(record.msgTime), now = Date.now();
            if (!Number.isSafeInteger(time) || time <= 0 || time * 1000 > now + 30000 || now - time * 1000 > 60000 ||
                Number(record.sourceType) === 3 || (state.readyAt && time < Math.floor(state.readyAt / 1000))) {
                throw problem('INVALID_RESPONSE', 'Poke is not a current event');
            }
            stage = 'event_session';
            let groupId;
            if (where.peer.chatType === 2) {
                groupId = numberId(where.peer.peerUid, 'group_id');
                if (record.peerUin && numberId(record.peerUin, 'group_id') !== groupId) {
                    throw problem('INVALID_RESPONSE', 'Poke group identity conflicts');
                }
            } else {
                const participants = [parsed.actorUid, parsed.targetUid];
                const otherUid = participants.find(uid => uid !== state.self.uid) || state.self.uid;
                if (!participants.includes(state.self.uid) || where.peer.peerUid !== otherUid) {
                    throw problem('INVALID_RESPONSE', 'Private poke does not match this conversation');
                }
            }
            const session = JSON.stringify([String(state.self.uin), state.epoch]);
            if (this.noticeSession !== session) { this.noticeSeen.clear(); this.noticeSession = session; }
            for (const [id, at] of this.noticeSeen) if (now - at > 60000) this.noticeSeen.delete(id);
            key = JSON.stringify(['poke', session, where.peer, where.nativeId]);
            if (this.processing.has(key) || this.noticeSeen.has(key)) return null;
            this.processing.add(key); ownsProcessing = true;
            stage = 'identity_mapping';
            const resolve = async uid => {
                const who = await this.sessionCall(state, 'resolve', { uid });
                if (!who || who.uid !== uid || (uid === state.self.uid) !== (String(who.uin) === String(state.self.uin))) {
                    throw problem('INVALID_RESPONSE', 'Poke participant mapping is inconsistent');
                }
                return numberId(who.uin, 'poke participant');
            };
            const userId = await resolve(parsed.actorUid);
            const targetId = parsed.actorUid === parsed.targetUid ? userId : await resolve(parsed.targetUid);
            if (parsed.actorUid !== parsed.targetUid && userId === targetId) throw problem('INVALID_RESPONSE', 'Different poke identities share an account');
            if (where.peer.chatType === 1 && record.peerUin) {
                const peerId = where.peer.peerUid === parsed.actorUid ? userId : targetId;
                if (numberId(record.peerUin, 'private peer') !== peerId) throw problem('INVALID_RESPONSE', 'Private poke peer mapping conflicts');
            }
            await this.assertSession(state);
            const converted = { time, self_id: Number(state.self.uin), post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
                user_id: userId, target_id: targetId, ...(groupId !== undefined ? { group_id: groupId } : {}) };
            this.noticeSeen.set(key, now);
            while (this.noticeSeen.size > 1024) this.noticeSeen.delete(this.noticeSeen.keys().next().value);
            this.log('notice_received', { stage: 'poke', selfId: converted.self_id, userId, targetId,
                ...(groupId !== undefined ? { groupId } : {}) });
            return converted;
        } catch (error) {
            this.log('notice_skipped', { code: error.code || 'INVALID_EVENT', stage, reason: stage === 'parse' ? 'invalid_poke' : stage });
            return null;
        } finally { if (ownsProcessing) this.processing.delete(key); }
    }

    async notice(event) {
        if (event.notice === 'gray_tip' && event.record) return this.pokeNotice(event);
        if (event.notice !== 'recall' || !event.record) return null;
        let processingKey, ownsProcessing = false;
        try {
            const state = await this.identity();
            if (event.epoch !== state.epoch || String(event.selfUin) !== String(state.self.uin)) throw problem('SESSION_CHANGED', 'Notice belongs to another QQ session');
            const record = event.record;
            const where = locator(record);
            const revoke = record.elements?.find(element => element?.grayTipElement?.revokeElement)?.grayTipElement.revokeElement;
            if (!revoke || typeof revoke.operatorUid !== 'string' || !/^u_/.test(revoke.operatorUid)) throw problem('INVALID_RESPONSE', 'Recall has no verified operator');
            const rawTime = Number(record.recallTime);
            const time = Math.floor(rawTime > 10000000000 ? rawTime / 1000 : rawTime);
            if (!Number.isSafeInteger(time) || time <= 0 || time * 1000 > Date.now() + 30000 ||
                (state.readyAt && time * 1000 + 1000 < state.readyAt)) throw problem('INVALID_RESPONSE', 'Recall is not a current event');
            processingKey = JSON.stringify(['recall', state.self.uin, where.peer, where.nativeId]);
            if (this.processing.has(processingKey)) return null;
            this.processing.add(processingKey);
            ownsProcessing = true;
            let entry = this.store.find(state.self.uin, { peer: where.peer, nativeId: where.nativeId });
            if (entry && ((entry.locator.senderUin && where.senderUin !== entry.locator.senderUin) ||
                (entry.locator.seq && where.seq && entry.locator.seq !== where.seq))) {
                throw problem('INVALID_RESPONSE', 'Recall update conflicts with the known original message');
            }
            if (entry?.recallEmitted) return null;
            if (!entry) entry = this.store.remember(state.self.uin, record);
            const operator = await this.sessionCall(state, 'resolve', { uid: revoke.operatorUid });
            if (operator?.uid !== revoke.operatorUid) throw problem('INVALID_RESPONSE', 'Recall operator mapping is inconsistent');
            const userId = numberId(where.senderUin, 'recalled sender');
            const converted = { time, self_id: Number(state.self.uin), post_type: 'notice',
                notice_type: where.peer.chatType === 2 ? 'group_recall' : 'friend_recall',
                user_id: userId, message_id: entry.id };
            if (where.peer.chatType === 2) {
                converted.group_id = numberId(record.peerUin || where.peer.peerUid, 'group_id');
                converted.operator_id = numberId(operator.uin, 'recall operator');
            }
            await this.assertSession(state);
            this.store.setRecalled(state.self.uin, entry.id, converted, true);
            return converted;
        } catch (error) { this.log('notice_skipped', { code: error.code || 'INVALID_EVENT' }); return null; }
        finally { if (ownsProcessing) this.processing.delete(processingKey); }
    }
}

module.exports = { OneBotService, numberId, shortId };
