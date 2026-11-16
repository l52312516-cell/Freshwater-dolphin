'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RpcClient } = require('./ipc/client.cjs');
const { writeJson } = require('./ipc/common.cjs');
const { TransportHub } = require('./onebot/transports.cjs');
const { MessageStore } = require('./onebot/store.cjs');
const { OneBotService } = require('./onebot/service.cjs');
const { acquireLock } = require('./lock.cjs');
const { GlobalServices } = require('./global-services.cjs');
const { StatusCommand } = require('./status-command.cjs');

async function run(config, log) {
    let stopped = false;
    const backend = new RpcClient({ directory: config.rpcDirectory, timeoutMs: config.actionTimeoutMs });
    const store = new MessageStore({ directory: config.dataDirectory });
    const release = acquireLock(config.dataDirectory);
    const globalServices = new GlobalServices({ root: config.root,
        nativeRkey: (kind, options) => backend.call('nativeRkey', { kind, ...options }, { timeoutMs: options.timeoutMs }) });
    const service = new OneBotService({ backend, store, logger: log, actionTimeoutMs: config.actionTimeoutMs,
        mediaActionTimeoutMs: config.mediaActionTimeoutMs,
        mediaDirectory: config.mediaDirectory,
        globalServices,
        profileId: config.profileId, mediaBaseUrl: config.mediaBaseUrl, mediaSigningKeyFile: config.mediaSigningKeyFile,
        authorizeSession: state => !stopped && authorized({ uin: String(state.self?.uin || ''), epoch: state.epoch }) });
    let lastStatus = { ready: false, online: null, self: null }, connectedSelf = null, sessionEpoch = null;
    function authorized(session) {
        if (!session || !/^[1-9]\d*$/.test(session.uin) || typeof session.epoch !== 'string' || !session.epoch ||
            (config.expectedUin && config.expectedUin !== session.uin)) return false;
        if (!config.authorizationFile) return true;
        try {
            const value = JSON.parse(fs.readFileSync(config.authorizationFile, 'utf8'));
            return value.profileId === config.profileId && String(value.uin) === session.uin && value.epoch === session.epoch;
        } catch (_) { return false; }
    }
    const network = new TransportHub({ config, action: (request, session) => service.action(request,
        { epoch: session.epoch, selfUin: session.uin }),
        status: () => lastStatus, logger: log, authorization: authorized,
        capabilities: () => typeof service.capabilities === 'function' ? service.capabilities() : {},
        managementToken: session => {
            if (!config.authorizationFile || !authorized(session)) return null;
            try {
                const value = JSON.parse(fs.readFileSync(config.authorizationFile, 'utf8'));
                return value.profileId === config.profileId && String(value.uin) === session.uin && value.epoch === session.epoch &&
                    typeof value.managementToken === 'string' && value.managementToken.length >= 32 ? value.managementToken : null;
            } catch (_) { return null; }
        } });
    const statusCommand = new StatusCommand({ root: config.root, service, status: () => lastStatus,
        authorizeSession: session => !stopped && authorized({ uin: session.selfUin, epoch: session.epoch }), logger: log });
    let polling = false, instance, cursor = 0, bridge = false, pollPromise = null;
    const incoming = [];
    const processing = new Set(), lanes = new Set(), running = { ordinary: 0, media: 0 };
    let incomingBytes = 0;
    function health() {
        writeJson(config.healthFile, { at: Date.now(), bridge, connected: network.connected,
            profileId: config.profileId || 'default', selfId: lastStatus.self?.uin ? String(lastStatus.self.uin) : null,
            selfUid: lastStatus.self?.uid || null, nickname: typeof lastStatus.self?.nickname === 'string' ? lastStatus.self.nickname : null, pid: process.pid,
            sessionEpoch: lastStatus.epoch || null,
            authorized: authorized({ uin: String(lastStatus.self?.uin || ''), epoch: lastStatus.epoch }),
            gatewayPort: network.port, nodes: network.describe(), activeActions: network.pendingActions + (statusCommand.pending ? 1 : 0) + processing.size,
            eventQueue: { waiting: incoming.length, processing: processing.size, bytes: incomingBytes },
            ready: lastStatus.ready === true, online: lastStatus.online === true ? true : lastStatus.online === false ? false : null });
    }
    function clearIncoming() { incoming.length = 0; incomingBytes = 0; }
    function sourceTime(event) {
        const record = event.record;
        const rawTime = Number(event.kind === 'request' ? event.time : event.kind === 'notice' && event.notice === 'recall' ? record?.recallTime : record?.msgTime);
        const seconds = event.kind === 'notice' && rawTime > 1000000000000 ? Math.floor(rawTime / 1000) : rawTime;
        const readyAt = lastStatus.readyAt;
        if (Number(record?.sourceType) === 3) {
            log('incoming_history_skipped', { gap: true, reason: 'history_source' }); return null;
        }
        if (!Number.isSafeInteger(seconds) || seconds <= 0) {
            log('incoming_time_invalid', { gap: true }); return null;
        }
        if (!Number.isSafeInteger(readyAt) || readyAt <= 0) {
            log('incoming_ready_time_unknown', { gap: true }); return null;
        }
        if (seconds < Math.floor(readyAt / 1000)) {
            log('incoming_history_skipped', { gap: true, reason: 'before_session_ready' }); return null;
        }
        const at = seconds * 1000;
        const age = Date.now() - at;
        if (age < -30000) { log('incoming_time_in_future', { gap: true }); return null; }
        if (age > config.eventMaxAgeMs) { log('incoming_event_expired', { gap: true }); return null; }
        return at;
    }
    async function convertEvent(item) {
        if (Date.now() - item.at > config.eventMaxAgeMs || item.event.epoch !== sessionEpoch ||
            String(item.event.selfUin) !== connectedSelf) {
            log('incoming_event_expired', { gap: true }); return;
        }
        try {
            const event = await service.event(item.event);
            if (Date.now() - item.at > config.eventMaxAgeMs) { log('incoming_event_expired', { gap: true }); return; }
            if (!stopped && event && connectedSelf && String(event.self_id) === connectedSelf &&
                item.event.epoch === sessionEpoch && !statusCommand.handle(event,
                    { epoch: item.event.epoch, selfUin: item.event.selfUin })) network.event(event);
        } catch (error) { log('event_rejected', { code: error.code || 'INVALID_EVENT' }); }
    }
    function processEvents() {
        // Reserve independent bounded capacity for ordinary events. A slow media
        // download must not consume every slot or block text from the same chat.
        // Arrival order is preserved within each chat and class; ordinary events
        // can overtake media, retaining their original QQ identities and times.
        while (!stopped && incoming.length) {
            const index = incoming.findIndex(item => !lanes.has(item.lane) && running[item.kind] < 2);
            if (index < 0) break;
            const [item] = incoming.splice(index, 1);
            incomingBytes -= item.bytes;
            lanes.add(item.lane); running[item.kind]++;
            const task = convertEvent(item).finally(() => {
                processing.delete(task); lanes.delete(item.lane); running[item.kind]--;
                processEvents();
            });
            processing.add(task);
        }
    }
    function enqueue(event) {
        if (!['message', 'notice', 'request'].includes(event.kind) || event.epoch !== sessionEpoch || String(event.selfUin) !== connectedSelf) return;
        const at = sourceTime(event);
        if (at === null) return;
        const bytes = Buffer.byteLength(JSON.stringify(event));
        const kind = event.kind === 'message' && Array.isArray(event.record?.elements) &&
            event.record.elements.some(element => [2, 3, 4, 5].includes(element?.elementType)) ? 'media' : 'ordinary';
        const lane = JSON.stringify([event.epoch, event.selfUin, event.record?.chatType || event.request?.type,
            event.record?.peerUid || event.request?.groupId || event.request?.uid || '', kind]);
        incoming.push({ at, event, bytes, kind, lane });
        incomingBytes += bytes;
        let gap = false;
        while (incoming.length > config.eventBufferSize || incomingBytes > 8 * 1024 * 1024) {
            incomingBytes -= incoming.shift().bytes; gap = true;
        }
        if (gap) log('incoming_event_gap', { gap: true });
        processEvents();
    }
    async function poll() {
        if (stopped || polling) return;
        polling = true;
        try {
            const status = await backend.call('status', {}, { timeoutMs: 2000 });
            if (stopped) return;
            lastStatus = status;
            bridge = true;
            const uin = status.self?.uin;
            if (typeof status.epoch === 'string' && status.epoch && /^[1-9]\d{0,15}$/.test(String(uin || ''))) {
                globalServices.resetSession(status.epoch, String(uin));
            }
            const changed = sessionEpoch !== null && status.epoch !== sessionEpoch;
            if (changed || (connectedSelf && String(uin) !== connectedSelf)) {
                statusCommand.invalidate(); network.stop(); clearIncoming(); connectedSelf = null; log('qq_session_changed');
            }
            sessionEpoch = status.epoch;
            const allowed = authorized({ uin: String(uin), epoch: sessionEpoch });
            if (status.ready && status.capabilities?.messages === true && /^[1-9]\d*$/.test(String(uin)) &&
                typeof sessionEpoch === 'string' && sessionEpoch && allowed && !connectedSelf) {
                network.start(String(uin), sessionEpoch); connectedSelf = String(uin);
            }
            if ((!status.ready || !allowed) && connectedSelf) { statusCommand.invalidate(); network.stop(); clearIncoming(); connectedSelf = null; }
            const batch = await backend.call('events', { ...(instance ? { instance } : {}), cursor }, { timeoutMs: 2000 });
            if (stopped) return;
            if (batch.gap) log('bridge_event_gap', { gap: true });
            instance = batch.instance;
            for (const item of batch.events) {
                if (stopped) break;
                enqueue(item.event);
                cursor = item.seq;
            }
            cursor = batch.cursor;
        } catch (error) {
            if (stopped || error.code === 'BUSY') return;
            if (bridge) log('bridge_unavailable', { code: error.code });
            bridge = false;
            lastStatus = { ...lastStatus, ready: false, online: null };
            statusCommand.invalidate(); network.stop(); clearIncoming(); connectedSelf = null;
        } finally {
            polling = false;
            if (!stopped) try { health(); } catch (_) { log('health_write_failed'); }
        }
    }
    function startPoll() {
        if (!stopped && !pollPromise) pollPromise = poll().finally(() => { pollPromise = null; });
    }
    let timer;
    try {
        fs.mkdirSync(path.dirname(config.healthFile), { recursive: true, mode: 0o700 });
        await network.open();
        health();
        timer = setInterval(startPoll, 250);
        startPoll();
    } catch (error) {
        stopped = true; backend.close();
        try { await Promise.allSettled([Promise.resolve().then(() => statusCommand.close()), Promise.resolve().then(() => network.close())]); }
        finally { release(); }
        throw error;
    }
    log('adapter_started', { version: require('../package.json').version });
    let closingPromise;
    return { close() {
        if (closingPromise) return closingPromise;
        stopped = true;
        closingPromise = (async () => {
            const errors = [];
            const attempt = operation => {
                try { return Promise.resolve(operation()).catch(error => { errors.push(error); }); }
                catch (error) { errors.push(error); return Promise.resolve(); }
            };
            const commandClosing = attempt(() => statusCommand.close());
            clearInterval(timer); clearIncoming();
            await Promise.all([attempt(() => network.stop()), attempt(() => backend.close())]);
            await attempt(() => pollPromise);
            await Promise.allSettled([...processing]);
            await commandClosing;
            await attempt(() => network.close());
            await attempt(() => store.close());
            await attempt(() => release());
            bridge = false; lastStatus = { ready: false, online: null };
            await attempt(() => health());
            if (errors.length) throw new AggregateError(errors, 'Adapter shutdown encountered errors');
        })();
        return closingPromise;
    } };
}

module.exports = { run };
