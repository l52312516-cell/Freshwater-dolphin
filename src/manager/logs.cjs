'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeMessageRecord } = require('../message-log.cjs');
const { workspacePath } = require('../paths.cjs');

const LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'SUCCESS', 'WARN', 'ERROR']);
const FAILURE_REASONS = Object.freeze({
    INVALID_REQUEST: '请求参数不符合接口要求', INVALID_PARAMS: '请求参数不符合接口要求',
    INVALID_RESPONSE: 'QQ 返回结果缺失或不符合已验证的接口约定',
    UNSUPPORTED: '当前 QQ 会话未提供此能力，或请求包含尚未支持的内容',
    NOT_READY: 'QQ 账号尚未就绪', SESSION_CHANGED: '操作所属 QQ 会话已经变更',
    NOT_FOUND: '请求对象或本账号的消息定位不存在',
    TIMEOUT: '操作超时，结果可能不明，请勿自动重试', EXPIRED: '操作已过期或取消，结果可能不明，请勿自动重试',
    BUSY: '目标仍有操作进行中，或已达到并发限制',
    KERNEL_ERROR: 'QQ 拒绝请求，或尚未确认操作结果', PARTIAL_RESULT: 'QQ 只确认部分操作成功，未自动补发',
    QUERY_LIMIT: '查询达到分页或容量限制', INVALID_EVENT: '入站事件的身份、会话或结构未通过校验',
    UNAUTHORIZED: '请求身份验证失败', FORBIDDEN: '当前账号没有执行此操作的权限'
});
const SKIPPED_LABELS = Object.freeze({ message_skipped: '入站消息已跳过',
    request_skipped: '入站申请事件已跳过', notice_skipped: '入站通知已跳过' });
const INBOUND_REASONS = Object.freeze({
    unsupported_gray_tip: '收到尚未支持的群系统提示，未作为普通消息上报',
    invalid_gray_tip: '群系统提示的结构未通过校验',
    invalid_poke: '戳一戳通知的身份或结构未通过校验',
    identity_mapping: '入站事件涉及的 QQ 号与 UID 未能可靠对应',
    event_session: '入站事件与当前 QQ 账号或会话不匹配',
    stale_event: '入站事件已失效，已跳过处理'
});
function diagnosticAccount(value) {
    return ['string', 'number'].includes(typeof value) && /^[1-9]\d{0,15}$/.test(String(value)) &&
        Number.isSafeInteger(Number(value)) ? String(value) : null;
}
function failureExplanation(item) {
    if (Object.hasOwn(SKIPPED_LABELS, item.event)) {
        if (Object.hasOwn(INBOUND_REASONS, item.reason)) return INBOUND_REASONS[item.reason];
        if (['INVALID_REQUEST', 'INVALID_PARAMS'].includes(item.code)) return '入站事件的身份或结构未通过校验';
        if (item.code === 'UNSUPPORTED') return '入站事件包含当前尚未支持的内容，已跳过处理';
        if (item.code === 'SESSION_CHANGED') return '入站事件所属的 QQ 会话已经变更';
    }
    return Object.hasOwn(FAILURE_REASONS, item.code) ? FAILURE_REASONS[item.code] : '请结合接口、处理阶段和错误码检查本次操作';
}
function messageText(item, includeContent) {
    const direction = item.event === 'message_sent' ? '发送' : '收到';
    const sender = includeContent && (item.card || item.senderName);
    const person = sender ? sender + '(' + item.userId + ')' : item.userId || item.selfId;
    const target = item.messageType === 'group' ? '群 [' +
        (includeContent && item.groupName ? item.groupName + '(' + item.groupId + ')' : item.groupId) + ']'
        : '私聊 [' + (item.peerId || item.userId) + ']';
    return direction + ' ' + target + ' · ' + person + ' · ID: ' + item.messageId + ' ' +
        (includeContent ? item.content + (item.truncated ? ' [内容超长，已截断]' : '') : '[原文已隐藏]');
}
function normalize(item, profileId, includeContent) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (item.kind === 'message') {
        if (item.profileId !== profileId) return null;
        const safe = sanitizeMessageRecord(item, { includeContent });
        if (!safe?.time) return null;
        return includeContent ? safe : { ...safe, message: messageText(safe, false) };
    }
    if (typeof item.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.time) ||
        !Number.isFinite(Date.parse(item.time)) || typeof item.event !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(item.event)) return null;
    const result = { profileId, time: item.time, event: item.event };
    for (const key of ['code', 'count', 'online', 'ready', 'connected', 'bridge', 'gap', 'nodeId']) {
        const value = item[key];
        if (typeof value === 'boolean' || value === null || typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value)) result[key] = value;
    }
    // Retain fixed operational context already written by the worker. Never
    // expose arbitrary error messages, request bodies, URLs or stack traces.
    for (const key of ['action', 'stage', 'reason']) {
        if (typeof item[key] === 'string' && /^[A-Za-z][\w.:-]{0,99}$/.test(item[key])) result[key] = item[key];
    }
    for (const key of ['userId', 'targetId', 'groupId', 'selfId']) {
        const value = diagnosticAccount(item[key]);
        if (value !== null) result[key] = value;
    }
    if (Number.isSafeInteger(item.durationMs) && item.durationMs >= 0) result.durationMs = item.durationMs;
    result.level = /(?:failed|error|rejected|unconfirmed)/i.test(item.event) ? 'ERROR' :
        /(?:gap|expired|timeout|skipped|overflow|unknown)/i.test(item.event) ? 'WARN' :
        /(?:connected|started|ready)/i.test(item.event) ? 'SUCCESS' : 'INFO';
    result.component = /(?:ws|http|node|network|reconnect)/i.test(item.event) ? 'network' :
        /(?:backend|bridge|rpc)/i.test(item.event) ? 'bridge' : 'worker';
    result.message = item.event + Object.entries(result).filter(([key]) => !['profileId', 'time', 'event', 'level', 'component'].includes(key))
        .map(([key, value]) => ' ' + key + '=' + value).join('');
    if (item.event === 'action_failed' || Object.hasOwn(SKIPPED_LABELS, item.event)) {
        const label = item.event === 'action_failed' ? '接口调用失败' : SKIPPED_LABELS[item.event];
        const fields = ['action', 'stage', 'code', 'reason', 'durationMs'].filter(key => Object.hasOwn(result, key))
            .map(key => key + '=' + result[key]).join(' · ');
        result.message = label + '（' + item.event + '）' + (fields ? ' · ' + fields : '') + ' · 原因：' + failureExplanation(result);
        if (item.event === 'action_failed') result.component = 'onebot';
    }
    if (item.event === 'notice_received') {
        const label = result.stage === 'poke' ? '收到戳一戳通知' : '收到通知';
        const fields = ['stage', 'userId', 'targetId', 'groupId', 'selfId'].filter(key => Object.hasOwn(result, key))
            .map(key => key + '=' + result[key]).join(' · ');
        result.message = label + '（notice_received）' + (fields ? ' · ' + fields : '');
        result.level = 'SUCCESS'; result.component = 'onebot';
    }
    return result;
}

class LogReader {
    constructor(root, accounts, { maxScanBytes = 8 * 1024 * 1024, maxScanRows = 20000, maxScanMs = 100, now = () => performance.now() } = {}) {
        this.root = root; this.accounts = accounts; this.cache = new Map(); this.cacheBytes = 0;
        this.maxScanBytes = maxScanBytes; this.maxScanRows = maxScanRows; this.maxScanMs = maxScanMs; this.now = now;
        this.cursors = new Map(); this.lastRead = { partial: false, files: 0, bytes: 0, rows: 0 };
    }
    forget(key) { const old = this.cache.get(key); if (old) this.cacheBytes -= old.bytes; this.cache.delete(key); }
    file(filename) {
        try {
            const file = workspacePath(this.root, filename), stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) return [];
            const previous = this.cache.get(file);
            if (previous?.size === stat.size && previous.mtime === stat.mtimeMs && previous.ctime === stat.ctimeMs &&
                previous.ino === stat.ino && previous.dev === stat.dev) {
                this.cache.delete(file); this.cache.set(file, previous); return previous.rows;
            }
            const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            let bytes, opened;
            try {
                opened = fs.fstatSync(descriptor);
                if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return [];
                const size = opened.size;
                bytes = Buffer.alloc(Math.min(size, 512 * 1024));
                fs.readSync(descriptor, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
            } finally { fs.closeSync(descriptor); }
            const rows = [];
            for (const line of bytes.toString('utf8').split('\n').slice(-1001)) {
                if (Buffer.byteLength(line) > 512 * 1024) continue;
                try {
                    const row = JSON.parse(line);
                    if (!row || typeof row !== 'object') continue;
                    row.id = typeof row.id === 'string' && /^[A-Za-z0-9_-]{12,64}$/.test(row.id) ? row.id : crypto.createHash('sha256').update(line).digest('hex');
                    rows.push(row);
                } catch { /* A partial rotation record is never a business event. */ }
            }
            this.forget(file);
            // Retained strings may use two bytes per code unit; include a
            // conservative factor and object overhead in the global LRU bound.
            const retained = bytes.length * 4 + rows.length * 1024;
            this.cache.set(file, { size: opened.size, mtime: opened.mtimeMs, ctime: opened.ctimeMs,
                ino: opened.ino, dev: opened.dev, rows, bytes: retained });
            this.cacheBytes += retained;
            while (this.cacheBytes > 8 * 1024 * 1024 && this.cache.size) this.forget(this.cache.keys().next().value);
            return rows;
        } catch { return []; }
    }
    read({ profileId, limit = 1000, level, component, query, includeContent = true } = {}) {
        const ids = profileId ? [this.accounts.get(profileId).id] : this.accounts.document.profiles.map(item => item.id);
        const validFiles = new Set(this.accounts.document.profiles.flatMap(item => ['adapter', 'messages'].flatMap(name =>
            ['', '.1', '.2', '.3'].map(suffix => path.join(this.accounts.location(item.id), 'logs', name + '.jsonl' + suffix)))));
        for (const key of this.cache.keys()) if (!validFiles.has(key)) this.forget(key);
        let result = []; const seen = new Set();
        const maximum = Math.max(1, Math.min(1000, Number(limit) || 1000));
        const sources = ['', '.1', '.2', '.3'].flatMap(suffix => ids.flatMap(id => ['adapter', 'messages'].map(name =>
            ({ id, file: path.join(this.accounts.location(id), 'logs', name + '.jsonl' + suffix) }))));
        const budget = { partial: false, files: 0, bytes: 0, rows: 0 }, started = this.now();
        const scope = profileId || '*';
        for (const key of this.cursors.keys()) if (key !== '*' && !this.accounts.document.profiles.some(item => item.id === key)) this.cursors.delete(key);
        const offset = (this.cursors.get(scope) || 0) % Math.max(1, sources.length);
        const needle = typeof query === 'string' ? query.slice(0, 200).toLocaleLowerCase() : '';
        const wantedLevel = typeof level === 'string' ? level.toUpperCase() : '';
        let visited = 0;
        for (; visited < sources.length; visited++) {
            // Missing/empty files can consume the wall-clock budget on a busy
            // disk. Make progress through one nonempty source before yielding.
            if (budget.bytes > 0 && this.now() - started >= this.maxScanMs || budget.rows >= this.maxScanRows) { budget.partial = true; break; }
            const { id, file } = sources[(offset + visited) % sources.length];
            let bytes = 0;
            try { bytes = Math.min(fs.lstatSync(file).size, 512 * 1024); } catch { /* absent logs cost no I/O budget */ }
            if (budget.bytes + bytes > this.maxScanBytes) { budget.partial = true; break; }
            budget.files++; budget.bytes += bytes;
            for (const row of this.file(file)) {
                if (budget.rows >= this.maxScanRows) { budget.partial = true; break; }
                budget.rows++;
                const safe = normalize(row, id, includeContent);
                if (!safe) continue;
                safe.id = row.id;
                const key = id + '/' + safe.id;
                if (seen.has(key)) continue;
                seen.add(key);
                if (LEVELS.has(wantedLevel) && safe.level !== wantedLevel || component && safe.component !== component ||
                    needle && ![safe.message, safe.content, safe.event, safe.component, id].some(value => String(value).toLocaleLowerCase().includes(needle))) continue;
                result.push(safe);
            }
            // Bound live candidates as well as cached file bytes. The response
            // needs only the newest maximum entries, not an all-account sort.
            if (result.length > maximum) result = result.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id)).slice(-maximum);
        }
        this.cursors.set(scope, budget.partial ? (offset + Math.max(1, visited)) % Math.max(1, sources.length) : 0);
        this.lastRead = budget;
        const sorted = result.sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
        const selected = []; let size = 0;
        for (const item of sorted.reverse()) {
            const bytes = Buffer.byteLength(JSON.stringify(item));
            if (selected.length >= maximum) break;
            if (size + bytes > 448 * 1024) continue;
            size += bytes; selected.push(item);
        }
        return selected.reverse();
    }
    close() { this.cache.clear(); this.cacheBytes = 0; this.cursors.clear(); }
}
module.exports = { LogReader, normalize, messageText };
