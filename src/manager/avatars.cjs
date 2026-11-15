'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, privateDirectory } = require('./files.cjs');
const { workspacePath } = require('../paths.cjs');
const MAX_BYTES = 512 * 1024;
const TTL = 15 * 60 * 1000;
const MAX_ACTIVE = 4;
const MAX_QUEUED = 64;
const TIMEOUT = 5000;

function numeric(value) {
    const text = String(value ?? '');
    return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}
function target(kind, input) {
    const id = numeric(input);
    if (!id || !['user', 'group'].includes(kind)) throw fail('INVALID_AVATAR', 'Avatar kind or QQ number is invalid', 400);
    return kind === 'user' ? { key: id, url: 'https://q1.qlogo.cn/g?b=qq&nk=' + id + '&s=100' } :
        { key: 'group-' + id, url: 'https://p.qlogo.cn/gh/' + id + '/' + id + '/100' };
}
function imageType(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return null;
}

class AvatarCache {
    constructor(root, accounts, { fetchImpl = fetch, now = Date.now } = {}) {
        this.root = root; this.accounts = accounts; this.fetch = fetchImpl; this.now = now;
        this.directory = privateDirectory(root, 'work/cache/avatars');
        if (fs.lstatSync(this.directory).isSymbolicLink() || fs.realpathSync(this.directory) !== this.directory) throw fail('AVATAR_CACHE', 'Avatar cache must be a private ordinary directory', 503);
        this.pending = new Map(); this.memory = new Map(); this.memoryBytes = 0; this.active = 0; this.closed = false; this.controllers = new Set(); this.queue = [];
    }
    identity(id) {
        const profile = this.accounts.get(id), health = this.accounts.healths.get(id);
        const uin = health?.authorized === true ? numeric(health.selfId) : numeric(profile.boundUin);
        if (!uin) throw fail('AVATAR_UNAVAILABLE', 'Account identity has not been confirmed', 404);
        return { uin, profile, child: this.accounts.processes?.get(id), epoch: health?.sessionEpoch || null };
    }
    verify(id, snapshot) {
        const current = this.identity(id);
        if (current.uin !== snapshot.uin || current.profile !== snapshot.profile || current.child !== snapshot.child || current.epoch !== snapshot.epoch) {
            throw fail('AVATAR_STALE', 'Account identity changed while loading its avatar', 409);
        }
    }
    filename(uin) {
        if (!/^(?:group-)?[1-9]\d{0,15}$/.test(uin)) throw fail('INVALID_AVATAR', 'Invalid avatar cache key');
        return workspacePath(this.root, path.join(this.directory, uin + '.img'));
    }
    remember(uin, value) {
        const old = this.memory.get(uin); if (old) this.memoryBytes -= old.bytes.length;
        this.memory.delete(uin); this.memory.set(uin, value); this.memoryBytes += value.bytes.length;
        while (this.memory.size > 64 || this.memoryBytes > 8 * 1024 * 1024) {
            const first = this.memory.keys().next().value; this.memoryBytes -= this.memory.get(first).bytes.length; this.memory.delete(first);
        }
        return value;
    }
    cached(uin) {
        const memory = this.memory.get(uin);
        if (memory && memory.expiresAt > this.now()) return this.remember(uin, memory);
        const file = this.filename(uin);
        try {
            const info = fs.lstatSync(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || info.size < 3 || this.now() - info.mtimeMs >= TTL || info.mtimeMs > this.now() + 5000) return null;
            const bytes = fs.readFileSync(file), type = imageType(bytes);
            return type ? this.remember(uin, { bytes, type, expiresAt: info.mtimeMs + TTL }) : null;
        } catch { return null; }
    }
    trimDisk() {
        const files = [];
        for (const name of fs.readdirSync(this.directory)) {
            if (!/^(?:group-)?[1-9]\d{0,15}\.img$/.test(name)) continue;
            const file = this.filename(name.slice(0, -4)), stat = fs.lstatSync(file);
            if (stat.isFile() && !stat.isSymbolicLink()) files.push({ file, at: stat.mtimeMs });
        }
        files.sort((a, b) => b.at - a.at);
        for (const item of files.slice(64)) fs.unlinkSync(item.file);
    }
    async acquire() {
        if (this.closed) throw fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503);
        if (this.active < MAX_ACTIVE) { this.active++; return; }
        if (this.queue.length >= MAX_QUEUED) throw fail('AVATAR_BUSY', 'Avatar download queue is full', 429);
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.queue.indexOf(waiter);
                if (index !== -1) this.queue.splice(index, 1);
                reject(fail('AVATAR_TIMEOUT', 'Avatar download queue timed out', 504));
            }, TIMEOUT);
            this.queue.push(waiter);
        });
    }
    release() {
        this.active--;
        if (this.closed) return;
        const waiter = this.queue.shift();
        if (waiter) { clearTimeout(waiter.timer); this.active++; waiter.resolve(); }
    }
    async download(uin, url) {
        await this.acquire();
        if (this.closed) { this.release(); throw fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503); }
        const controller = new AbortController(); this.controllers.add(controller);
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); });
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        const timer = setTimeout(() => controller.abort(fail('AVATAR_TIMEOUT', 'Avatar download timed out', 504)), TIMEOUT);
        try {
            return await Promise.race([(async () => {
                const response = await this.fetch(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' } });
                controller.signal.throwIfAborted();
                if (!response.ok || response.redirected || response.url && response.url !== url) throw fail('AVATAR_UNAVAILABLE', 'Official avatar source is unavailable', 502);
                const length = Number(response.headers.get('content-length'));
                if (length > MAX_BYTES) throw fail('AVATAR_TOO_LARGE', 'Avatar exceeds the size limit', 502);
                const chunks = []; let size = 0;
                if (!response.body) throw fail('AVATAR_INVALID', 'Avatar source returned no image', 502);
                for await (const chunk of response.body) {
                    controller.signal.throwIfAborted();
                    size += chunk.length;
                    if (size > MAX_BYTES) { controller.abort(fail('AVATAR_TOO_LARGE', 'Avatar exceeds the size limit', 502)); controller.signal.throwIfAborted(); }
                    chunks.push(Buffer.from(chunk));
                }
                const bytes = Buffer.concat(chunks), type = imageType(bytes);
                if (!type) throw fail('AVATAR_INVALID', 'Avatar source did not return a supported image', 502);
                if (this.closed) throw fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503);
                controller.signal.throwIfAborted();
                const filename = this.filename(uin), temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
                try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); this.trimDisk(); }
                finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
                return this.remember(uin, { bytes, type, expiresAt: this.now() + TTL });
            })(), aborted]);
        } catch (error) {
            if (error.statusCode) throw error;
            throw fail('AVATAR_UNAVAILABLE', 'Official avatar download failed', 502);
        } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort); this.controllers.delete(controller); this.release(); }
    }
    async getTarget(id, avatar) {
        if (this.closed) throw fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503);
        const snapshot = this.identity(id);
        let value = this.cached(avatar.key);
        if (!value) {
            let pending = this.pending.get(avatar.key);
            if (!pending) {
                pending = this.download(avatar.key, avatar.url); this.pending.set(avatar.key, pending);
                pending.finally(() => { if (this.pending.get(avatar.key) === pending) this.pending.delete(avatar.key); }).catch(() => {});
            }
            value = await pending;
        }
        this.verify(id, snapshot);
        return { bytes: value.bytes, type: value.type };
    }
    async get(id) {
        if (this.closed) throw fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503);
        return this.getTarget(id, target('user', this.identity(id).uin));
    }
    async getContact(profileId, kind, id) { return this.getTarget(profileId, target(kind, id)); }
    close() {
        this.closed = true;
        const error = fail('AVATAR_UNAVAILABLE', 'Avatar cache is closed', 503);
        for (const waiter of this.queue.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
        for (const controller of this.controllers) controller.abort(error);
        this.memory.clear(); this.memoryBytes = 0;
    }
}
module.exports = { AvatarCache, imageType };
