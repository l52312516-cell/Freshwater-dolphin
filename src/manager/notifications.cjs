'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { atomic, read, fail, privateDirectory } = require('./files.cjs');

const SUBJECT = '账号{event}：{nickname} ({uin})';
const BODY = '账号状态发生了改变。\n\n昵称：{nickname}\nQQ 号：{uin}\n当前状态：{event}\n进程状态：{status}\n时间：{time}\n错误：{error}';
const HEADER_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_CHANNELS = 32;
const MAX_QUEUE = 32;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function invalid(message) { throw fail('INVALID_NOTIFICATION_CONFIG', message); }
function channelId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value)) invalid('Invalid notification channel identifier');
    return value;
}
function text(value, label, max, { optional = false, multiline = false } = {}) {
    if (value === undefined && optional) return '';
    if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : HEADER_CONTROL).test(value)) invalid('Invalid notification ' + label);
    return value;
}
function endpoint(value) {
    const input = text(value, 'webhook URL', 2048);
    let url;
    try { url = new URL(input); } catch { invalid('Webhook URL must be HTTP(S)'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) invalid('Webhook URL must be HTTP(S) without credentials or fragment');
    return url.href;
}
function mailbox(value, label) {
    const input = text(value, label, 320).trim();
    if (!input || !/^(?:[^<>]*<)?[^\s<>@,;]+@[^\s<>@,;]+>?$/u.test(input) || input.includes('<') !== input.endsWith('>')) invalid('Invalid notification ' + label);
    return input;
}
function secret(input, old, field, clearFlag, max = 4096) {
    if (input[clearFlag] !== undefined && typeof input[clearFlag] !== 'boolean') invalid('Invalid secret clearing flag');
    const replacement = input[field] === undefined ? undefined : text(input[field], field, max);
    if (input[clearFlag] === true) {
        if (replacement) invalid('Cannot replace and clear a notification secret together');
        return '';
    }
    return replacement === undefined ? old[field] || '' : replacement;
}
function channel(value, old = {}) {
    if (!object(value)) invalid('Notification channels must be objects');
    const permitted = ['id', 'name', 'type', 'enabled', 'subjectTemplate', 'bodyTemplate', 'host', 'port', 'secure', 'user',
        'password', 'from', 'to', 'url', 'token', 'clearPassword', 'clearToken', 'passwordPresent', 'tokenPresent', 'urlPresent', 'endpoint'];
    if (Object.keys(value).some(key => !permitted.includes(key))) invalid('Unknown notification channel field');
    channelId(value.id);
    if (!['email', 'webhook'].includes(value.type)) invalid('Unknown notification channel type');
    const previous = old.type === value.type && old.id === value.id ? old : {};
    const name = text(value.name, 'channel name', 100).trim();
    if (!name) invalid('Notification channel name is required');
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid('Invalid channel enabled value');
    const result = { id: value.id, name, type: value.type, enabled: value.enabled !== false,
        subjectTemplate: text(value.subjectTemplate ?? SUBJECT, 'subject template', 256),
        bodyTemplate: text(value.bodyTemplate ?? BODY, 'body template', 32768, { multiline: true }) };
    if (result.type === 'email') {
        const host = text(value.host, 'SMTP host', 253).trim();
        if (!host || /[\s/@?#:]/u.test(host) && !(host.startsWith('[') && host.endsWith(']'))) invalid('Invalid SMTP host');
        if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.secure !== 'boolean') invalid('Invalid SMTP port or TLS setting');
        const user = text(value.user, 'SMTP user', 320, { optional: true });
        const password = secret(value, previous, 'password', 'clearPassword');
        if (password && !user) invalid('SMTP password requires a username');
        const values = Array.isArray(value.to) ? value.to : typeof value.to === 'string' ? value.to.split(/[,;]/u).map(item => item.trim()).filter(Boolean) : null;
        if (!values || values.length < 1 || values.length > 20) invalid('Expected 1 to 20 email recipients');
        Object.assign(result, { host, port: value.port, secure: value.secure, user, password,
            from: mailbox(value.from, 'sender'), to: [...new Set(values.map(item => mailbox(item, 'recipient')))] });
    } else {
        const url = endpoint(value.url === undefined ? previous.url : value.url);
        const token = secret(value, previous, 'token', 'clearToken');
        if (token && /\s/u.test(token)) invalid('Webhook bearer token cannot contain whitespace');
        if (token && previous.token === token && previous.url && new URL(previous.url).origin !== new URL(url).origin && value.token === undefined) {
            invalid('Changing webhook origin requires re-entering or clearing its token');
        }
        Object.assign(result, { url, token });
    }
    return result;
}
function normalize(value, previous = { channels: [] }) {
    if (!object(value) || Object.keys(value).some(key => !['version', 'offlineDelaySeconds', 'channels'].includes(key)) || value.version !== undefined && value.version !== 1) invalid('Invalid notification document');
    const delay = value.offlineDelaySeconds ?? previous.offlineDelaySeconds ?? 30;
    if (!Number.isInteger(delay) || delay < 0 || delay > 86400) invalid('Notification delay must be 0 to 86400 seconds');
    const values = value.channels ?? previous.channels;
    if (!Array.isArray(values) || values.length > MAX_CHANNELS) invalid('At most 32 notification channels are allowed');
    const channels = values.map(item => channel(item, previous.channels.find(old => old.id === item?.id)));
    if (new Set(channels.map(item => item.id)).size !== channels.length) invalid('Duplicate notification channel identifier');
    return { version: 1, offlineDelaySeconds: delay, channels };
}
function redact(value) {
    const { password, token, url, ...safe } = value;
    return value.type === 'email' ? { ...safe, passwordPresent: Boolean(password) } :
        { ...safe, urlPresent: Boolean(url), tokenPresent: Boolean(token), endpoint: new URL(url).origin };
}
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function template(input, variables, html = false) {
    return input.replace(/\{(uin|nickname|event|time|status|pid|error|profileId)\}/gu,
        (_, key) => html ? escapeHtml(variables[key]) : variables[key]);
}
function safeField(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 1024) : '';
}
function errorCode(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,95}$/u.test(value) ? value : ''; }
function snapshot(item) {
    const health = object(item.health) ? item.health : {};
    const uin = health.selfId == null ? '' : String(health.selfId);
    const validUin = /^[1-9]\d{0,15}$/u.test(uin) && Number.isSafeInteger(Number(uin));
    const validEpoch = typeof health.sessionEpoch === 'string' && health.sessionEpoch.length > 0 && health.sessionEpoch.length <= 256;
    const expected = item.expectedUin || item.boundUin;
    const badIdentity = ['account_mismatch', 'duplicate_account'].includes(item.state) || expected && validUin && String(expected) !== uin;
    const suppressed = item.desired !== 'running' || item.maintenance || item.notificationSuppressed === true || item.bridgeInstalled === false ||
        ['stopping', 'maintenance', 'maintenance_failed', 'maintenance_interrupted', 'qq_only'].includes(item.state) || badIdentity;
    const online = !suppressed && item.state === 'online' && validUin && validEpoch && health.authorized === true && health.ready === true && health.online === true;
    const offline = !suppressed && (validUin && validEpoch && health.authorized === true && health.ready === true && health.online === false ||
        ['error', 'retry_exhausted', 'start_failed', 'stop_unconfirmed'].includes(item.state));
    return { suppressed, value: online ? true : offline ? false : null, uin: validUin ? uin : '',
        epoch: validEpoch ? health.sessionEpoch : '',
        processGeneration: typeof item.notificationGeneration === 'string' ? item.notificationGeneration : '',
        nickname: safeField(health.nickname || health.self?.nickname), status: safeField(item.state),
        pid: Number.isInteger(health.pid) && health.pid > 0 ? String(health.pid) : '', error: errorCode(item.error || health.error) };
}

class Notifications {
    constructor(root, { getAccounts, sendMail, fetch: fetchImpl = globalThis.fetch, now = Date.now,
        setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 10000, queueLimit = MAX_QUEUE } = {}) {
        this.file = path.join(privateDirectory(root, 'work/control'), 'notifications.json');
        if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw fail('UNSAFE_NOTIFICATION_CONFIG', 'Notification configuration cannot be a symbolic link', 409);
        this.document = normalize(read(this.file, { version: 1, offlineDelaySeconds: 30, channels: [] }));
        this.getAccounts = getAccounts || (() => this.latest);
        this.sendMail = sendMail; this.fetch = fetchImpl; this.now = now;
        this.setTimer = setTimer; this.clearTimer = clearTimer;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000 || !Number.isInteger(queueLimit) || queueLimit < 1 || queueLimit > MAX_QUEUE) throw new TypeError('Invalid notification worker bounds');
        this.timeoutMs = timeoutMs; this.queueLimit = queueLimit;
        this.latest = []; this.states = new Map(); this.stateSequence = 0; this.queues = new Map(); this.active = new Map(); this.deliveries = []; this.closed = false;
    }
    config() {
        return { version: 1, offlineDelaySeconds: this.document.offlineDelaySeconds, channels: this.document.channels.map(redact),
            deliveries: this.deliveries.map(item => ({ ...item })) };
    }
    update(value) {
        if (this.closed) throw fail('CLOSING', 'Notification service is stopping', 503);
        const next = normalize(value, this.document);
        atomic(this.file, next); this.document = next;
        for (const state of this.states.values()) {
            if (state.timer) this.clearTimer(state.timer);
            state.timer = null;
        }
        // Cancel queued work for removed, disabled or changed destinations. Never send a saved
        // secret to a replacement endpoint merely because it reused a channel identifier.
        for (const [id, queue] of this.queues) {
            const current = this.document.channels.find(item => item.id === id);
            const keep = [];
            for (const job of queue) {
                if (current?.enabled && JSON.stringify(current) === job.fingerprint) keep.push(job);
                else job.resolve(this.record(job, false, 'CONFIG_CHANGED'));
            }
            this.queues.set(id, keep);
        }
        this.observe(this.getAccounts());
        return this.config();
    }
    clearState(id) {
        const state = this.states.get(id);
        if (state?.timer) this.clearTimer(state.timer);
        this.states.delete(id);
    }
    observe(values = this.getAccounts()) {
        if (this.closed) return;
        if (!Array.isArray(values)) return;
        this.latest = values;
        const present = new Set(values.map(item => item.id));
        for (const id of this.states.keys()) if (!present.has(id)) this.clearState(id);
        for (const item of values) {
            const selected = item.notifications;
            if (!selected?.enabled || !Array.isArray(selected.channelIds) || !selected.channelIds.length) { this.clearState(item.id); continue; }
            const current = snapshot(item);
            if (current.suppressed) { this.clearState(item.id); continue; }
            let state = this.states.get(item.id);
            if (!state) {
                state = { initialized: current.value !== null, last: current.value, identity: current.uin, info: current,
                    epoch: current.epoch, processGeneration: current.processGeneration, generation: ++this.stateSequence,
                    since: null, notified: false, timer: null, selection: JSON.stringify(selected.channelIds) };
                this.states.set(item.id, state); continue;
            }
            if (current.uin && state.identity && current.uin !== state.identity || state.selection !== JSON.stringify(selected.channelIds)) {
                this.clearState(item.id);
                this.states.set(item.id, { initialized: current.value !== null, last: current.value, identity: current.uin,
                    epoch: current.epoch, processGeneration: current.processGeneration, generation: ++this.stateSequence,
                    info: current, since: null, notified: false, timer: null, selection: JSON.stringify(selected.channelIds) });
                continue;
            }
            if (current.uin) state.identity = current.uin;
            if (current.epoch && current.epoch !== state.epoch) {
                state.epoch = current.epoch; state.generation = ++this.stateSequence;
            }
            if (current.processGeneration && current.processGeneration !== state.processGeneration) {
                state.processGeneration = current.processGeneration; state.generation = ++this.stateSequence;
            }
            state.info = { ...state.info, ...current, uin: current.uin || state.identity,
                nickname: current.nickname || state.info.nickname };
            if (current.value === null) {
                if (state.timer) this.clearTimer(state.timer);
                state.timer = null;
                if (!state.notified && state.since !== null) { state.since = null; state.last = true; }
                continue;
            }
            if (!state.initialized) { state.initialized = true; state.last = current.value; continue; }
            if (current.value === true) {
                if (state.timer) this.clearTimer(state.timer);
                state.timer = null;
                if (state.notified) this.emit(item, state.info, 'online');
                state.since = null; state.notified = false; state.last = true;
                continue;
            }
            // An initially-offline account has no known-online transition and is a baseline.
            if (state.last !== true && state.since === null) { state.last = false; continue; }
            if (state.since === null) state.since = this.now();
            state.last = false;
            const remaining = state.since + this.document.offlineDelaySeconds * 1000 - this.now();
            if (!state.notified && remaining <= 0) {
                state.notified = true;
                if (state.timer) this.clearTimer(state.timer);
                state.timer = null;
                this.emit(item, state.info, 'offline');
            } else if (!state.notified && !state.timer) {
                state.timer = this.setTimer(() => { state.timer = null; this.observe(this.getAccounts()); }, Math.max(1, remaining));
                state.timer?.unref?.();
            }
        }
    }
    variables(info, profileId, event) {
        return { uin: info.uin || '', nickname: safeField(info.nickname), event,
            time: new Date(this.now()).toISOString(), status: safeField(info.status), pid: safeField(info.pid),
            error: safeField(info.error), profileId: safeField(profileId) };
    }
    emit(account, info, event) {
        const variables = this.variables(info, account.id, event);
        for (const id of [...new Set(account.notifications.channelIds)]) {
            const target = this.document.channels.find(item => item.id === id);
            if (target?.enabled) this.enqueue(target, variables, false, this.states.get(account.id)).catch(() => {});
        }
    }
    test(id) {
        channelId(id);
        if (this.closed) throw fail('CLOSING', 'Notification service is stopping', 503);
        const target = this.document.channels.find(item => item.id === id);
        if (!target) throw fail('NOT_FOUND', 'Notification channel not found', 404);
        if (!target.enabled) throw fail('NOTIFICATION_DISABLED', 'Enable the notification channel before testing it', 409);
        // A test is an explicit administrator action, independent of account assignment.
        return this.enqueue(target, this.variables({ uin: '', nickname: 'Freshwater 通知测试', status: 'test' }, '', 'test'), true);
    }
    enqueue(target, variables, test, session) {
        if (this.closed) return Promise.reject(fail('CLOSING', 'Notification service is stopping', 503));
        const queue = this.queues.get(target.id) || [];
        this.queues.set(target.id, queue);
        const job = { target, variables, test, fingerprint: JSON.stringify(target), generation: session?.generation,
            epoch: session?.epoch, processGeneration: session?.processGeneration };
        if (queue.length >= this.queueLimit) return Promise.resolve(this.record(job, false, 'QUEUE_FULL'));
        const promise = new Promise(resolve => { job.resolve = resolve; queue.push(job); });
        this.drain(target.id);
        return promise;
    }
    record(job, success, code) {
        const result = { channelId: job.target.id, profileId: job.variables.profileId, event: job.variables.event,
            at: this.now(), success, ok: success, code };
        this.deliveries.push(result);
        if (this.deliveries.length > 100) this.deliveries.splice(0, this.deliveries.length - 100);
        return { ...result };
    }
    async drain(id) {
        if (this.active.has(id) || this.closed) return;
        const controller = new AbortController();
        this.active.set(id, controller);
        try {
            while (!this.closed) {
                const job = this.queues.get(id)?.shift();
                if (!job) break;
                const current = this.document.channels.find(item => item.id === id);
                const account = job.test ? null : this.getAccounts().find(item => item.id === job.variables.profileId);
                const currentSnapshot = account ? snapshot(account) : null;
                const session = account ? this.states.get(account.id) : null;
                if (!current || JSON.stringify(current) !== job.fingerprint || !job.test &&
                    (!current.enabled || !account?.notifications?.enabled || !account.notifications.channelIds.includes(id) || currentSnapshot.suppressed ||
                        currentSnapshot.value === null || currentSnapshot.uin && currentSnapshot.uin !== job.variables.uin ||
                        session?.generation !== job.generation || currentSnapshot.epoch && currentSnapshot.epoch !== job.epoch ||
                        currentSnapshot.processGeneration && currentSnapshot.processGeneration !== job.processGeneration ||
                        !currentSnapshot.uin && currentSnapshot.value !== false)) {
                    job.resolve(this.record(job, false, 'CONFIG_CHANGED')); continue;
                }
                const attempt = new AbortController();
                const stop = () => attempt.abort();
                controller.signal.addEventListener('abort', stop, { once: true });
                let timer;
                try {
                    const timeout = new Promise((_, reject) => {
                        timer = setTimeout(() => { attempt.abort(); reject(fail('NOTIFICATION_TIMEOUT', 'Notification delivery timed out', 504)); }, this.timeoutMs);
                    });
                    const aborted = new Promise((_, reject) => {
                        attempt.signal.addEventListener('abort', () => reject(fail('NOTIFICATION_ABORTED', 'Notification delivery stopped', 503)), { once: true });
                    });
                    await Promise.race([this.deliver(job, attempt.signal), timeout, aborted]);
                    job.resolve(this.record(job, true, 'DELIVERED'));
                } catch (error) {
                    const code = controller.signal.aborted ? 'CLOSING' : attempt.signal.aborted ? 'NOTIFICATION_TIMEOUT' :
                        error.code === 'WEBHOOK_REJECTED' ? 'WEBHOOK_REJECTED' : error.code === 'SMTP_REJECTED' ? 'SMTP_REJECTED' : 'DELIVERY_FAILED';
                    job.resolve(this.record(job, false, code));
                } finally {
                    clearTimeout(timer); controller.signal.removeEventListener('abort', stop);
                }
            }
        } finally { this.active.delete(id); if (!this.queues.get(id)?.length) this.queues.delete(id); }
    }
    async deliver(job, signal) {
        const target = job.target, variables = job.variables;
        const subject = template(target.subjectTemplate, variables).replace(/[\r\n]/gu, ' ').slice(0, 998);
        const html = target.bodyTemplate.trimStart().startsWith('<');
        const body = template(target.bodyTemplate, variables, html).slice(0, 262144);
        if (target.type === 'webhook') {
            const headers = { 'Content-Type': 'application/json' };
            if (target.token) headers.Authorization = 'Bearer ' + target.token;
            const response = await this.fetch(target.url, { method: 'POST', headers, redirect: 'error',
                body: JSON.stringify({ ...variables, subject, body }), signal });
            await response.body?.cancel?.();
            if (!response.ok) throw fail('WEBHOOK_REJECTED', 'Webhook rejected notification', 502);
            return;
        }
        const options = { host: target.host, port: target.port, secure: target.secure, requireTLS: !target.secure,
            connectionTimeout: this.timeoutMs, greetingTimeout: this.timeoutMs, socketTimeout: this.timeoutMs,
            tls: { rejectUnauthorized: true }, disableFileAccess: true, disableUrlAccess: true };
        if (target.user) options.auth = { user: target.user, pass: target.password };
        const message = { from: target.from, to: target.to, subject, [html ? 'html' : 'text']: body,
            disableFileAccess: true, disableUrlAccess: true };
        let result;
        if (this.sendMail) result = await this.sendMail(options, message, signal);
        else {
            const transport = require('nodemailer').createTransport(options);
            const abort = () => transport.close();
            signal.addEventListener('abort', abort, { once: true });
            try { result = await transport.sendMail(message); }
            finally { signal.removeEventListener('abort', abort); transport.close(); }
        }
        if (result && Array.isArray(result.rejected) && result.rejected.length) throw fail('SMTP_REJECTED', 'SMTP rejected a notification recipient', 502);
    }
    close() {
        this.closed = true;
        for (const id of this.states.keys()) this.clearState(id);
        for (const controller of this.active.values()) controller.abort();
        for (const queue of this.queues.values()) for (const job of queue.splice(0)) job.resolve(this.record(job, false, 'CLOSING'));
    }
}

module.exports = { Notifications, normalize, snapshot, template };
