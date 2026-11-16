'use strict';

const http = require('node:http');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { ReverseWebSocket } = require('./ws.cjs');
const { executeQuickOperation } = require('./quick-operation.cjs');
const { MAX_ACTION_BYTES } = require('./limits.cjs');
const { decodeHttpParameter } = require('./parameter-schema.cjs');

const MAX_BODY = 1024 * 1024;
const failure = (retcode, message, request) => ({ status: 'failed', retcode, data: null, message, wording: message,
    ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) });
const sameSession = (a, b) => Boolean(a && b && a.epoch === b.epoch && a.uin === b.uin);
const clone = value => structuredClone(value);

function authorized(request, token, url) {
    if (!token) return true;
    const header = request.headers.authorization;
    const query = url.searchParams.get('access_token');
    if (query !== null && header !== undefined && header !== 'Bearer ' + query) return false;
    const actual = query === null ? typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '' : query;
    const left = Buffer.from(actual || ''), right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(stream, maximum = MAX_ACTION_BYTES) {
    let total = 0;
    const chunks = [];
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maximum) throw Object.assign(new Error('Request body too large'), { code: 'TOO_LARGE' });
        chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function parameters(search) {
    const result = Object.create(null);
    for (const [key, value] of search) {
        if (Object.hasOwn(result, key)) throw new Error('Duplicate parameter');
        if (key === 'access_token') continue;
        result[key] = decodeHttpParameter(key, value);
    }
    return result;
}

function reply(response, code, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}

class TransportHub {
    constructor({ config, action, status, logger = () => {}, authorization = () => true, managementToken = () => null, capabilities = () => ({}) }) {
        this.config = config;
        this.action = action;
        this.status = status;
        this.log = logger;
        this.authorization = authorization;
        this.managementToken = managementToken;
        this.capabilities = capabilities;
        this.profileId = config.profileId || 'default';
        this.session = null;
        this.closed = false;
        this.server = null;
        this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ACTION_BYTES, perMessageDeflate: false });
        this.port = null;
        this.nodes = new Map();
        this.internalNode = { config: { id: 'internal', maxPending: 16 }, pending: new Set(), tokens: 40, tokenAt: Date.now(), active: false };
        const source = config.nodes || [{ id: 'legacy', type: 'wsClient', enabled: true, ...config.reverseWs }];
        for (const item of source) {
            const node = { config: item, pending: new Set(), clients: new Map(), queue: [], queueBytes: 0,
                tokens: item.burst || 40, tokenAt: Date.now(), active: false, lastError: null, lastDeliveryAt: null,
                draining: null, abort: null, socket: null };
            if (item.type === 'wsClient') {
                node.socket = new ReverseWebSocket({ config: item, action: request => this.dispatch(node, request, this.session),
                    status, logger: (event, data) => { this.diagnostic(node, event, data); },
                    isAuthorized: () => node.active && this.current(this.session),
                    maxEvents: item.eventBufferSize || config.eventBufferSize, maxAgeMs: item.eventMaxAgeMs || config.eventMaxAgeMs });
                node.socket.on('connection', connected => { if (connected) node.lastError = null; });
            }
            this.nodes.set(item.id, node);
        }
    }

    diagnostic(node, event, details = {}) {
        if (/failed|error|gap|overflow|backpressure/.test(event)) node.lastError = event;
        this.log('node_' + event, { ...details, nodeId: node.config.id });
    }

    get connected() {
        return Boolean(this.session && [...this.nodes.values()].some(node => node.active &&
            (node.config.type !== 'wsClient' || node.socket.connected)));
    }

    get pendingActions() {
        return this.internalNode.pending.size + [...this.nodes.values()].reduce((total, node) => total + node.pending.size, 0);
    }

    describe() {
        return [...this.nodes.values()].map(node => ({ id: node.config.id, type: node.config.type,
            enabled: node.config.enabled !== false, role: node.config.role || 'Universal',
            status: node.config.enabled === false ? 'disabled' : !node.active ? 'waiting' :
                node.config.type === 'wsClient' ? node.socket.connected ? 'connected' : 'connecting' :
                    node.lastError ? 'degraded' : 'active',
            connected: node.config.type === 'wsClient' ? node.socket.connected : node.clients.size > 0,
            connections: node.clients.size, pending: node.pending.size,
            queueLength: node.socket ? node.socket.queue.length : node.queue.length,
            lastError: node.lastError, lastDeliveryAt: node.lastDeliveryAt }));
    }

    async open() {
        this.server = http.createServer((request, response) => {
            this.httpRequest(request, response).catch(error => reply(response, error.code === 'TOO_LARGE' ? 413 : 400,
                failure(1400, 'Invalid HTTP request')));
        });
        this.server.requestTimeout = 15000;
        this.server.headersTimeout = 10000;
        this.server.keepAliveTimeout = 2000;
        this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head));
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.config.gatewayPort || 0, '127.0.0.1', () => {
                this.server.removeListener('error', reject);
                this.server.on('error', () => this.log('gateway_error'));
                resolve();
            });
        });
        this.port = this.server.address().port;
    }

    start(uin, epoch) {
        const next = { uin: String(uin), epoch };
        if (sameSession(this.session, next)) return;
        this.stop();
        this.session = next;
        this.internalNode.active = true;
        for (const node of this.nodes.values()) {
            if (node.config.enabled === false) continue;
            node.active = true;
            if (node.socket) node.socket.start(next.uin);
            if (node.config.type === 'httpPost') {
                this.enqueuePost(node, this.meta('lifecycle', { sub_type: 'enable' }), next);
            }
            if (node.config.type !== 'httpApi' && node.config.type !== 'wsClient') {
                node.heartbeat = setInterval(() => this.heartbeat(node).catch(() => this.diagnostic(node, 'heartbeat_failed')), node.config.heartbeatMs || 30000);
                node.heartbeat.unref();
            }
        }
    }

    stop() {
        this.session = null;
        this.internalNode.active = false;
        for (const node of this.nodes.values()) {
            node.active = false;
            if (node.socket) node.socket.stop();
            clearInterval(node.heartbeat);
            node.heartbeat = null;
            if (node.abort) node.abort.abort();
            node.queue.length = 0;
            node.queueBytes = 0;
            for (const socket of node.clients.keys()) socket.terminate();
            node.clients.clear();
        }
    }

    current(session) {
        return !this.closed && sameSession(this.session, session) && this.authorization(session);
    }

    rateLimit(node) {
        const now = Date.now(), rate = node.config.ratePerSecond || 20, burst = node.config.burst || 40;
        node.tokens = Math.min(burst, node.tokens + (now - node.tokenAt) * rate / 1000);
        node.tokenAt = now;
        if (node.tokens < 1) return false;
        node.tokens--;
        return true;
    }

    async dispatch(node, request, session) {
        if (!node.active || !this.current(session)) return failure(1503, 'Account is not authorized or ready', request);
        if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') return failure(1400, 'Invalid action request', request);
        if (node.pending.size >= (node.config.maxPending || 16) || !this.rateLimit(node)) return failure(1503, 'Node is busy', request);
        const operation = Promise.resolve().then(async () => {
            if (!this.current(session)) return failure(1503, 'Account session changed', request);
            if (['.handle_quick_operation', '.handle_quick_operation_async'].includes(request.action)) {
                if (node.config.quickOperations !== true) return failure(1404, 'Quick operations are disabled for this node', request);
                try {
                    const context = request.params?.context;
                    if (String(context?.self_id) !== session.uin) return failure(1400, 'Quick operation belongs to another account', request);
                    // Resolve message metadata through the same account service rather than trusting caller-supplied targets.
                    if (context.post_type === 'message') {
                        const original = await this.action({ action: 'get_msg', params: { message_id: context.message_id } }, session);
                        if (original.status !== 'ok' || !original.data || original.data.message_type !== context.message_type ||
                            String(original.data.sender?.user_id) !== String(context.user_id) ||
                            (context.message_type === 'group' && String(original.data.group_id) !== String(context.group_id))) {
                            return failure(1400, 'Quick operation context is not a known message', request);
                        }
                        await this.quick(node, { ...original.data, self_id: Number(session.uin), post_type: 'message',
                            message_id: context.message_id, user_id: original.data.sender.user_id }, request.params.operation, session);
                    } else if (context.post_type === 'request') {
                        await this.quick(node, context, request.params.operation, session);
                    } else return failure(1400, 'Invalid quick operation context', request);
                    return { status: 'ok', retcode: 0, data: null, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
                } catch (error) { return failure(error.code === 'INVALID_REQUEST' ? 1400 : 1500, 'Quick operation failed', request); }
            }
            return this.action(request, session);
        });
        node.pending.add(operation);
        try { return await operation; }
        catch (_) { return failure(1500, 'Action failed', request); }
        finally { node.pending.delete(operation); }
    }

    async quick(node, context, operation, session) {
        if (node.config.quickOperations !== true) throw Object.assign(new Error('Quick operations are disabled for this node'), { code: 'UNSUPPORTED' });
        const task = executeQuickOperation(context, operation, request => {
            if (!node.active || !this.current(session)) return failure(1503, 'Account session changed', request);
            return this.action(request, session);
        });
        node.pending.add(task);
        try { return await task; } finally { node.pending.delete(task); }
    }

    route(request) {
        const url = new URL(request.url, 'http://127.0.0.1');
        const prefix = '/onebot/' + this.profileId + '/';
        if (!url.pathname.startsWith(prefix)) return { url };
        const parts = url.pathname.slice(prefix.length).split('/');
        const node = this.nodes.get(parts.shift());
        return { url, node, path: parts.join('/') };
    }

    async httpRequest(request, response) {
        const internalUrl = new URL(request.url, 'http://127.0.0.1');
        if (internalUrl.pathname.startsWith('/internal/')) return this.internalRequest(request, response, internalUrl);
        const { node, url, path } = this.route(request);
        if (!node || node.config.type !== 'httpApi' || node.config.enabled === false) return reply(response, 404, failure(1404, 'Unknown HTTP node'));
        if (!authorized(request, node.config.token, url)) return reply(response, 401, failure(1401, 'Unauthorized'));
        if (!['GET', 'POST'].includes(request.method)) return reply(response, 405, failure(1400, 'GET or POST required'));
        const session = this.session && { ...this.session };
        let action = path, params, echo;
        if (request.method === 'GET') params = parameters(url.searchParams);
        else {
            const body = await readBody(request);
            const kind = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (kind === 'application/x-www-form-urlencoded') params = parameters(new URLSearchParams(body));
            else if (kind === 'application/json' || !kind) {
                params = body.trim() ? JSON.parse(body) : {};
                if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Object required');
            } else return reply(response, 415, failure(1400, 'Unsupported content type'));
        }
        if (!action && typeof params.action === 'string') {
            action = params.action;
            echo = params.echo;
            if (params.params !== undefined) params = params.params;
            else { params = { ...params }; delete params.action; delete params.echo; }
        } else {
            echo = params.echo;
            params = { ...params };
            delete params.echo;
        }
        if (!action || action.includes('/')) return reply(response, 404, failure(1404, 'Unknown action path'));
        const result = await this.dispatch(node, { action, params, ...(echo !== undefined ? { echo } : {}) }, session);
        reply(response, 200, result);
    }

    async internalRequest(request, response, url) {
        const session = this.session && { ...this.session };
        const token = this.managementToken(session);
        // The management credential is accepted only as a header and is never a public node token.
        if (!token || url.search || !authorized(request, token, url)) return reply(response, 401, failure(1401, 'Unauthorized'));
        if (!this.current(session)) return reply(response, 503, failure(1503, 'Account is not authorized or ready'));
        if (url.pathname === '/internal/capabilities' && request.method === 'GET') {
            const data = await this.capabilities();
            if (!this.current(session)) return reply(response, 503, failure(1503, 'Account session changed'));
            return reply(response, 200, { status: 'ok', retcode: 0, data });
        }
        if (url.pathname !== '/internal/action' || request.method !== 'POST') return reply(response, 404, failure(1404, 'Unknown internal endpoint'));
        const contentType = String(request.headers['content-type'] || '').split(';')[0].trim();
        if (contentType !== 'application/json') return reply(response, 415, failure(1400, 'JSON required'));
        const action = JSON.parse(await readBody(request));
        const result = await this.dispatch(this.internalNode, action, session);
        reply(response, 200, result);
    }

    upgrade(request, socket, head) {
        let route;
        try { route = this.route(request); } catch (_) { socket.destroy(); return; }
        const { node, url, path } = route;
        const reject = code => { socket.end('HTTP/1.1 ' + code + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
        if (!node || node.config.type !== 'wsServer' || node.config.enabled === false) { reject('404 Not Found'); return; }
        if (!authorized(request, node.config.token, url)) { reject('401 Unauthorized'); return; }
        if (!node.active || !this.current(this.session)) { reject('503 Service Unavailable'); return; }
        let role = node.config.role || 'Universal';
        if (path === 'api' && ['Universal', 'Api'].includes(role)) role = 'Api';
        else if (path === 'event' && ['Universal', 'Event'].includes(role)) role = 'Event';
        else if (path !== '') { reject('404 Not Found'); return; }
        const session = { ...this.session };
        this.wss.handleUpgrade(request, socket, head, client => this.connectClient(node, client, role, session));
    }

    connectClient(node, socket, role, session) {
        const context = { role, session, pong: true };
        node.clients.set(socket, context);
        if (role !== 'Api') this.sendClient(socket, this.meta('lifecycle', { sub_type: 'connect' }));
        socket.on('error', () => this.diagnostic(node, 'websocket_error'));
        socket.on('pong', () => { context.pong = true; clearTimeout(context.pongTimer); context.pongTimer = null; });
        socket.on('close', () => { clearTimeout(context.pongTimer); node.clients.delete(socket); });
        socket.on('message', (bytes, binary) => {
            if (role === 'Event') { socket.close(1008, 'Event connection does not accept actions'); return; }
            if (binary) { socket.close(1003, 'JSON text required'); return; }
            let request;
            try { request = JSON.parse(bytes.toString('utf8')); }
            catch (_) { this.sendClient(socket, failure(1400, 'Invalid JSON')); return; }
            this.dispatch(node, request, session).then(result => {
                if (this.current(session)) this.sendClient(socket, result);
            }).catch(() => this.diagnostic(node, 'action_failed'));
        });
    }

    sendClient(socket, value) {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 2 * MAX_BODY) { socket.terminate(); return; }
        socket.send(JSON.stringify(value), error => { if (error) socket.terminate(); });
    }

    meta(type, extra) {
        return { time: Math.floor(Date.now() / 1000), self_id: Number(this.session.uin), post_type: 'meta_event', meta_event_type: type, ...extra };
    }

    async heartbeat(node) {
        const session = this.session;
        if (!node.active || !this.current(session)) return;
        const state = await this.status();
        if (!this.current(session)) return;
        const event = this.meta('heartbeat', { interval: node.config.heartbeatMs || 30000,
            status: { online: state.online === true, good: state.ready === true && state.online === true } });
        if (node.config.type === 'httpPost') this.enqueuePost(node, event, session);
        for (const [socket, context] of node.clients) {
            if (!context.pong) continue;
            context.pong = false;
            socket.ping();
            context.pongTimer = setTimeout(() => socket.terminate(), node.config.pingTimeoutMs || 10000);
            context.pongTimer.unref();
            if (context.role !== 'Api') this.sendClient(socket, event);
        }
    }

    event(event) {
        const session = this.session;
        if (!this.current(session) || String(event.self_id) !== session.uin) return;
        for (const node of this.nodes.values()) {
            if (!node.active) continue;
            if (node.socket) node.socket.event(event);
            if (node.config.type === 'httpPost') this.enqueuePost(node, event, session);
            for (const [socket, context] of node.clients) if (context.role !== 'Api') this.sendClient(socket, event);
        }
    }

    enqueuePost(node, event, session) {
        const at = Number(event.time) * 1000;
        if (!Number.isSafeInteger(at) || Date.now() - at > (node.config.eventMaxAgeMs || 60000) || at > Date.now() + 30000) {
            this.diagnostic(node, 'outbound_event_expired', { gap: true }); return;
        }
        const payload = JSON.stringify(event), bytes = Buffer.byteLength(payload);
        if (bytes > MAX_BODY) { this.diagnostic(node, 'outbound_event_too_large', { gap: true }); return; }
        node.queue.push({ payload, event: clone(event), at, bytes, session });
        node.queueBytes += bytes;
        while (node.queue.length > (node.config.eventBufferSize || 1000) || node.queueBytes > 8 * MAX_BODY) {
            node.queueBytes -= node.queue.shift().bytes;
            this.diagnostic(node, 'outbound_event_gap', { gap: true });
        }
        if (!node.draining) node.draining = this.drainPost(node).finally(() => { node.draining = null; });
    }

    async drainPost(node) {
        while (node.active && node.queue.length) {
            const item = node.queue.shift();
            node.queueBytes -= item.bytes;
            if (!this.current(item.session) || Date.now() - item.at > (node.config.eventMaxAgeMs || 60000)) {
                this.diagnostic(node, 'outbound_event_expired', { gap: true }); continue;
            }
            const headers = { 'Content-Type': 'application/json', 'User-Agent': 'OneBot/11', 'X-Self-ID': item.session.uin };
            const secret = node.config.secret === undefined ? node.config.token : node.config.secret;
            if (secret) headers['X-Signature'] = 'sha1=' + createHmac('sha1', secret).update(item.payload).digest('hex');
            const controller = new AbortController();
            node.abort = controller;
            const timer = setTimeout(() => controller.abort(), node.config.timeoutMs || 10000);
            timer.unref();
            try {
                const response = await fetch(node.config.url, { method: 'POST', body: item.payload, headers,
                    signal: controller.signal, redirect: 'error' });
                if (!response.ok) throw new Error('Rejected');
                const body = await readBody(response.body, MAX_BODY);
                node.lastDeliveryAt = Date.now();
                node.lastError = null;
                if (node.config.quickOperations === true && body.trim() && ((response.headers.get('content-type') || '').includes('application/json') || body.trim().startsWith('{'))) {
                    try {
                        const operation = JSON.parse(body);
                        if (this.current(item.session)) await this.quick(node, item.event, operation, item.session);
                    } catch (_) { this.diagnostic(node, 'quick_operation_failed'); }
                }
            } catch (_) { this.diagnostic(node, 'http_post_failed'); }
            finally { clearTimeout(timer); if (node.abort === controller) node.abort = null; }
        }
    }

    async close() {
        this.closed = true;
        this.stop();
        await Promise.allSettled([...this.nodes.values()].flatMap(node => [...node.pending,
            ...(node.draining ? [node.draining] : []), ...(node.socket ? [node.socket.close()] : [])]));
        await Promise.allSettled([...this.internalNode.pending]);
        if (this.server) {
            const closed = new Promise(resolve => this.server.close(resolve));
            this.server.closeIdleConnections();
            this.server.closeAllConnections();
            await closed;
            this.server = null;
        }
        await new Promise(resolve => this.wss.close(resolve));
    }
}

module.exports = { TransportHub, authorized, parameters, readBody };
