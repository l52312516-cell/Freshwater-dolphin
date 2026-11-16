'use strict';

const { MAX_ACTION_BYTES } = require('./limits.cjs');

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const streaming = require('./streaming.cjs');

class ReverseWebSocket extends EventEmitter {
    constructor({ config, action, status, logger = () => {}, maxEvents = 1000, maxAgeMs = 60000, isAuthorized = () => true }) {
        super();
        this.config = config;
        this.action = action;
        this.status = status;
        this.log = logger;
        this.maxEvents = maxEvents;
        this.maxAgeMs = maxAgeMs;
        this.queue = [];
        this.queueBytes = 0;
        this.socket = null;
        this.selfId = null;
        this.generation = 0;
        this.stopped = true;
        this.retry = null;
        this.heartbeat = null;
        this.pongTimeout = null;
        this.delay = config.reconnectMinMs;
        this.inflight = new Set();
        this.role = config.role || 'Universal';
        this.isAuthorized = isAuthorized;
    }

    get connected() { return this.socket?.readyState === WebSocket.OPEN; }

    start(selfId) {
        if (!/^[1-9]\d*$/.test(String(selfId))) throw new Error('A confirmed self UIN is required');
        if (!this.stopped && String(selfId) === this.selfId) return;
        this.stop();
        this.selfId = String(selfId);
        this.stopped = false;
        this.delay = this.config.reconnectMinMs;
        this.connect();
    }

    connect() {
        if (this.stopped || this.socket) return;
        if (!this.isAuthorized()) { this.schedule(); return; }
        const generation = ++this.generation;
        const headers = { 'X-Self-ID': this.selfId, 'X-Client-Role': this.role, 'User-Agent': 'OneBot/11 Freshwater-dolphin' };
        if (this.config.token) headers.Authorization = 'Bearer ' + this.config.token;
        const socket = new WebSocket(this.config.url, { headers, maxPayload: MAX_ACTION_BYTES,
            perMessageDeflate: false, handshakeTimeout: 10000, followRedirects: false });
        this.socket = socket;
        const owned = () => this.socket === socket && generation === this.generation;
        const current = () => owned() && !this.stopped && this.isAuthorized();
        const controller = new AbortController();
        socket.once('close', () => controller.abort());
        socket.on('open', () => {
            if (!current()) { socket.terminate(); return; }
            this.delay = this.config.reconnectMinMs;
            this.log('websocket_connected');
            this.emit('connection', true);
            if (this.role !== 'Api') this.send({ time: Math.floor(Date.now() / 1000), self_id: Number(this.selfId),
                post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
            this.flush();
            this.heartbeat = setInterval(() => this.beat(socket).catch(() => this.log('heartbeat_failed')), this.config.heartbeatMs);
            this.heartbeat.unref();
        });
        socket.on('pong', () => { if (current()) { clearTimeout(this.pongTimeout); this.pongTimeout = null; } });
        socket.on('message', (data, binary) => {
            if (!current()) return;
            if (binary) { socket.close(1003, 'JSON text required'); return; }
            if (this.role === 'Event') { socket.close(1008, 'Event connection does not accept actions'); return; }
            let request;
            try { request = JSON.parse(data.toString('utf8')); }
            catch (_) { this.send({ status: 'failed', retcode: 1400, data: null, message: 'Invalid JSON' }); return; }
            if (this.inflight.size >= (this.config.maxPending || 16)) {
                const error = { status: 'failed', retcode: 1503, data: null, message: 'Too many pending actions',
                    ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
                this.send(streaming.STREAMED_ACTIONS.has(request?.action) ? streaming.terminal(error, request) : error); return;
            }
            const streamed = streaming.STREAMED_ACTIONS.has(request?.action);
            const options = { signal: controller.signal, ...(streamed ? { streamSink: { send: value => streaming.sendSocket(socket, value, { signal: controller.signal, current }) } } : {}) };
            const task = Promise.resolve().then(() => current() ? this.action(request, options) : undefined).then(async response => {
                // Results belong to the requesting connection; never send on a replacement socket.
                if (current() && response !== undefined) {
                    if (streamed) await streaming.sendSocket(socket, response.stream === 'stream-action' ? response : streaming.terminal(response, request), { signal: controller.signal, current });
                    else this.send(response);
                }
            }).catch(() => {
                if (current()) { const error = { status: 'failed', retcode: 1500, data: null, message: 'Action failed',
                    ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
                    this.send(streamed ? streaming.terminal(error, request) : error);
                }
            });
            this.inflight.add(task);
            task.finally(() => this.inflight.delete(task));
        });
        socket.on('error', () => { if (current()) this.log('websocket_error'); });
        socket.on('unexpected-response', (_request, response) => {
            response.resume(); socket.terminate();
        });
        socket.on('close', () => {
            // Revoking authorization must stop business traffic, but must not
            // prevent ownership cleanup or leave a dead socket blocking retry.
            if (!owned()) return;
            this.socket = null;
            this.clearTimers();
            this.emit('connection', false);
            this.schedule();
        });
    }

    schedule() {
        if (this.stopped || this.retry) return;
        this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.delay);
        this.retry.unref();
        this.delay = Math.min(this.config.reconnectMaxMs, this.delay * 2);
    }

    async beat(socket) {
        if (this.socket !== socket || !this.connected) return;
        if (this.pongTimeout) return;
        socket.ping();
        this.pongTimeout = setTimeout(() => {
            this.pongTimeout = null;
            if (this.socket === socket) socket.terminate();
        }, this.config.pingTimeoutMs);
        this.pongTimeout.unref();
        const status = await this.status();
        if (this.socket === socket && this.connected && this.role !== 'Api') this.send({ time: Math.floor(Date.now() / 1000), self_id: Number(this.selfId),
            post_type: 'meta_event', meta_event_type: 'heartbeat', interval: this.config.heartbeatMs,
            status: { online: status.online === true,
                qq_online_state: status.online === true ? 'online' : status.online === false ? 'offline' : 'unknown',
                good: Boolean(status.ready && status.online === true) } });
    }

    send(value) {
        if (!this.connected || !this.isAuthorized()) return false;
        if (this.socket.bufferedAmount > 2 * 1024 * 1024) { this.log('websocket_backpressure'); this.socket.terminate(); return false; }
        try { this.socket.send(JSON.stringify(value), error => { if (error) this.log('websocket_send_failed'); }); return true; }
        catch (_) { this.socket.terminate(); return false; }
    }

    event(value) {
        if (this.role === 'Api') return;
        this.prune();
        const seconds = value.time === undefined ? null : Number(value.time);
        if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds <= 0)) {
            this.log('outbound_event_invalid_time', { gap: true }); return;
        }
        // Real OneBot messages keep their QQ timestamp throughout both queues.
        // Events without a timestamp are supported for local synthetic callers.
        const at = seconds === null ? Date.now() : seconds * 1000;
        const age = Date.now() - at;
        if (age < -30000) { this.log('outbound_event_future_time', { gap: true }); return; }
        if (age > this.maxAgeMs) { this.log('outbound_event_expired', { count: 1 }); return; }
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > 1024 * 1024) { this.log('outbound_event_too_large', { gap: true }); return; }
        if (this.connected && this.send(value)) return;
        this.queue.push({ at, value, bytes });
        this.queueBytes += bytes;
        if (this.queue.length > this.maxEvents || this.queueBytes > 8 * 1024 * 1024) {
            while (this.queue.length > this.maxEvents || this.queueBytes > 8 * 1024 * 1024) this.queueBytes -= this.queue.shift().bytes;
            this.log('outbound_event_gap', { gap: true });
        }
    }

    prune() {
        const now = Date.now();
        let expired = 0;
        this.queue = this.queue.filter(item => {
            if (now - item.at <= this.maxAgeMs) return true;
            this.queueBytes -= item.bytes;
            expired++;
            return false;
        });
        if (expired) {
            this.log('outbound_event_expired', { count: expired });
        }
    }

    flush() {
        this.prune();
        while (this.queue.length && this.connected) {
            if (!this.send(this.queue[0].value)) break;
            this.queueBytes -= this.queue.shift().bytes;
        }
    }

    clearTimers() {
        clearInterval(this.heartbeat); this.heartbeat = null;
        clearTimeout(this.pongTimeout); this.pongTimeout = null;
    }

    stop() {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.retry); this.retry = null;
        this.clearTimers();
        const socket = this.socket;
        this.socket = null;
        if (socket) socket.terminate();
        this.queue.length = 0;
        this.queueBytes = 0;
    }

    async close() { this.stop(); await Promise.allSettled([...this.inflight]); }
}

module.exports = { ReverseWebSocket };
