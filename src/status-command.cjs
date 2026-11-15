'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { workspacePath } = require('./paths.cjs');
const { version: appVersion } = require('../package.json');

const DEFAULT_STATUS_COMMAND = Object.freeze({ enabled: true, trigger: '#fd' });
const ACCOUNT_COOLDOWN_MS = 5000;
const SENDER_COOLDOWN_MS = 30000;
const MAX_SENDERS = 256;
function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_CONFIG', statusCode: 400 }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function normalizeStatusCommand(value = DEFAULT_STATUS_COMMAND) {
    if (!record(value) || Object.keys(value).some(key => !['enabled', 'trigger'].includes(key))) throw invalid('Invalid statusCommand settings');
    const enabled = Object.hasOwn(value, 'enabled') ? value.enabled : DEFAULT_STATUS_COMMAND.enabled;
    const input = Object.hasOwn(value, 'trigger') ? value.trigger : DEFAULT_STATUS_COMMAND.trigger;
    if (typeof enabled !== 'boolean' || typeof input !== 'string' || input.length > 128) throw invalid('Invalid status command enabled flag or trigger');
    const trigger = input.trim().toLowerCase();
    if ([...trigger].length < 1 || [...trigger].length > 32 || /[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(trigger)) {
        throw invalid('Status command must contain 1 to 32 characters without spaces or control characters');
    }
    return { enabled, trigger };
}
function accountId(value) {
    return ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : null;
}
function uptime(milliseconds) {
    let seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(seconds / 86400); seconds %= 86400;
    const hours = Math.floor(seconds / 3600); seconds %= 3600;
    const minutes = Math.floor(seconds / 60); seconds %= 60;
    return (days ? days + '天 ' : '') + hours + '小时 ' + minutes + '分钟 ' + seconds + '秒';
}

class StatusCommand {
    constructor({ root, service, status, authorizeSession, logger = () => {}, now = () => performance.now(),
        version = appVersion, platform = process.platform + '-' + process.arch } = {}) {
        if (!root || !service || typeof service.action !== 'function' || typeof status !== 'function' ||
            typeof authorizeSession !== 'function' || typeof now !== 'function') throw new TypeError('Invalid status command runtime');
        this.root = path.resolve(root); this.service = service; this.status = status; this.authorizeSession = authorizeSession;
        this.logger = logger; this.now = now; this.version = version; this.platform = platform;
        this.startedAt = now(); this.closed = false; this.generation = 0; this.session = null; this.pending = null;
        this.lastSentAt = -Infinity; this.senders = new Map(); this.settingsError = null;
    }
    log(event, data) { try { this.logger(event, data); } catch {} }
    settings() {
        try {
            const file = workspacePath(this.root, 'work/control/settings.json');
            let value;
            try {
                const info = fs.lstatSync(file);
                if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw invalid('Invalid status command settings file');
                value = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!record(value)) throw invalid('Invalid global settings file');
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const result = normalizeStatusCommand(value?.statusCommand);
            this.settingsError = null;
            return result;
        } catch (error) {
            const code = error.code || 'INVALID_CONFIG';
            if (this.settingsError !== code) this.log('status_command_config_invalid', { code });
            this.settingsError = code;
            return { enabled: false, trigger: '' };
        }
    }
    identity(state, expected) {
        if (this.closed || !state?.ready || !accountId(state.self?.uin) || typeof state.self?.uid !== 'string' || !/^u_/.test(state.self.uid) ||
            typeof state.epoch !== 'string' || !state.epoch || state.epoch !== expected?.epoch ||
            String(state.self.uin) !== String(expected.selfUin)) return null;
        const session = { epoch: state.epoch, selfUin: String(state.self.uin) };
        if (this.authorizeSession(session) !== true) return null;
        return JSON.stringify([session.selfUin, state.self.uid, session.epoch]);
    }
    invalidate() {
        this.generation++; this.session = null; this.senders.clear(); this.lastSentAt = -Infinity;
    }
    handle(event, expected) {
        if (this.closed || event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type) ||
            !Array.isArray(event.message) || !event.message.length ||
            !event.message.every(segment => segment?.type === 'text' && typeof segment.data?.text === 'string')) return false;
        const config = this.settings();
        if (!config.enabled || event.message.map(segment => segment.data.text).join('').trim().toLowerCase() !== config.trigger) return false;
        const state = this.status(), identity = this.identity(state, expected);
        if (!identity || String(event.self_id) !== String(expected.selfUin) || !accountId(event.user_id) ||
            String(event.user_id) === String(event.self_id) || event.message_type === 'group' && !accountId(event.group_id)) return true;
        if (this.session !== identity) { this.invalidate(); this.session = identity; }
        const now = this.now(), sender = String(event.user_id);
        if (this.pending || now - this.lastSentAt < ACCOUNT_COOLDOWN_MS || now - (this.senders.get(sender) ?? -Infinity) < SENDER_COOLDOWN_MS) {
            this.log('status_command_rate_limited', {}); return true;
        }
        this.lastSentAt = now;
        if (this.senders.has(sender)) this.senders.delete(sender);
        while (this.senders.size >= MAX_SENDERS) this.senders.delete(this.senders.keys().next().value);
        this.senders.set(sender, now);
        const generation = this.generation;
        const session = { epoch: expected.epoch, selfUin: String(expected.selfUin) };
        const target = event.message_type === 'group' ? { group_id: event.group_id } : { user_id: event.user_id };
        const action = event.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
        // The microtask provides a cancellation point before creating any QQ
        // action. A generation is never queued again after stop/session change.
        const pending = Promise.resolve().then(async () => {
            if (this.closed || generation !== this.generation || this.identity(this.status(), session) !== identity) return;
            const current = this.settings();
            if (!current.enabled || current.trigger !== config.trigger) return;
            const online = state.online === true ? '在线' : state.online === false ? '离线' : '未知';
            const text = 'Freshwater-dolphin 状态\n版本：' + this.version + '\n平台：' + this.platform +
                '\n运行时长：' + uptime(this.now() - this.startedAt) + '\nQQ 状态：' + online;
            const response = await this.service.action({ action, params: { ...target, message: [{ type: 'text', data: { text } }] } }, session);
            this.log(response?.status === 'ok' && response.retcode === 0 ? 'status_command_sent' : 'status_command_failed',
                { ...(typeof response?.retcode === 'number' ? { retcode: response.retcode } : {}) });
        }).catch(error => this.log('status_command_failed', { code: error.code || 'INTERNAL_ERROR' }));
        this.pending = pending;
        pending.finally(() => { if (this.pending === pending) this.pending = null; });
        return true;
    }
    async close() {
        if (this.closed) return;
        this.closed = true; this.invalidate();
        await this.pending;
    }
}

module.exports = { StatusCommand, normalizeStatusCommand, DEFAULT_STATUS_COMMAND };
