'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { atomic, read, fail, equalSecret } = require('./files.cjs');
const derive = promisify(crypto.scrypt);
const COOKIE = 'fwd_session';

class Auth {
    constructor(directory, { sessionMs = 8 * 60 * 60 * 1000, clock = Date.now, deriveKey = derive } = {}) {
        this.directory = directory;
        this.clock = clock;
        this.sessionMs = sessionMs;
        this.sessions = new Map();
        this.attempts = new Map();
        this.deriveKey = deriveKey; this.activeHashes = 0; this.closed = false;
        this.file = path.join(directory, 'admin.json');
        this.initialized = path.join(directory, 'initialized.json');
        this.setup = path.join(directory, 'setup-token.txt');
        this.record = read(this.file, null);
        if (this.record && (this.record.version !== 1 || !/^[a-f0-9]{32}$/.test(this.record.salt) || !/^[a-f0-9]{64}$/.test(this.record.hash))) {
            throw fail('AUTH_CORRUPT', 'Administrator authentication requires local repair', 503);
        }
        if (!this.record) {
            if (fs.existsSync(this.initialized)) throw fail('AUTH_CORRUPT', 'Initialized administrator state is missing; local repair is required', 503);
            if (!fs.existsSync(this.setup)) atomic(this.setup, crypto.randomBytes(32).toString('base64url') + '\n');
            if (!/^[A-Za-z0-9_-]{43}$/.test(fs.readFileSync(this.setup, 'utf8').trim())) throw fail('AUTH_CORRUPT', 'Invalid initialization credential', 503);
        } else {
            // Migrate existing installations before deleting the one-time setup credential.
            if (!fs.existsSync(this.initialized)) atomic(this.initialized, { version: 1, initialized: true });
            if (fs.existsSync(this.setup)) fs.unlinkSync(this.setup);
        }
    }
    password(value) {
        if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw fail('INVALID_PASSWORD', 'Use a password of 12 to 1024 characters');
    }
    async hash(password, salt) {
        if (this.closed) throw fail('CLOSING', 'Authentication service is stopping', 503);
        if (this.activeHashes >= 2) throw fail('RATE_LIMITED', 'Password verification is busy; retry later', 429);
        this.activeHashes++;
        try {
            const key = await this.deriveKey(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            try {
                if (this.closed) throw fail('CLOSING', 'Authentication service is stopping', 503);
                return key.toString('hex');
            } finally { key.fill(0); }
        } finally { this.activeHashes--; }
    }
    limit(address) {
        const now = this.clock();
        for (const [key, item] of this.attempts) if (item.until <= now) this.attempts.delete(key);
        const item = this.attempts.get(address) || { count: 0, until: now + 15 * 60 * 1000 };
        if (item.count >= 10 || this.attempts.size > 10000) throw fail('RATE_LIMITED', 'Too many login attempts; retry later', 429);
        item.count++; this.attempts.set(address, item);
    }
    async bootstrap(setupToken, password, address) {
        this.limit(address);
        if (this.record || fs.existsSync(this.initialized)) throw fail('ALREADY_INITIALIZED', 'Administrator is already configured', 409);
        if (!equalSecret(setupToken || '', fs.readFileSync(this.setup, 'utf8').trim())) throw fail('AUTH_FAILED', 'Invalid initialization credential', 401);
        this.password(password);
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await this.hash(password, salt);
        if (this.closed) throw fail('CLOSING', 'Authentication service is stopping', 503);
        // Recheck after asynchronous password hashing to prevent two initializers racing.
        if (this.record || fs.existsSync(this.file) || fs.existsSync(this.initialized)) throw fail('ALREADY_INITIALIZED', 'Administrator is already configured', 409);
        // The marker is durable first: interruption must fail closed, never reopen registration.
        atomic(this.initialized, { version: 1, initialized: true });
        const record = { version: 1, salt, hash };
        atomic(this.file, record);
        this.record = record;
        fs.unlinkSync(this.setup);
        this.attempts.delete(address);
        return this.issue();
    }
    async login(password, address) {
        this.limit(address);
        if (!this.record || typeof password !== 'string' || password.length > 1024 ||
            !equalSecret(await this.hash(password, this.record.salt), this.record.hash)) throw fail('AUTH_FAILED', 'Invalid administrator password', 401);
        this.attempts.delete(address);
        return this.issue();
    }
    issue() {
        if (this.closed) throw fail('CLOSING', 'Authentication service is stopping', 503);
        for (const [id, item] of this.sessions) if (item.expires <= this.clock()) this.revoke(id);
        while (this.sessions.size >= 20) this.revoke(this.sessions.keys().next().value);
        const id = crypto.randomBytes(32).toString('base64url');
        const session = { id, csrf: crypto.randomBytes(24).toString('base64url'), expires: this.clock() + this.sessionMs, streams: new Set() };
        this.sessions.set(id, session);
        return session;
    }
    cookie(id, secure, clear = false) {
        return COOKIE + '=' + (clear ? '' : id) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
            (clear ? 0 : Math.floor(this.sessionMs / 1000)) + (secure ? '; Secure' : '');
    }
    session(cookie = '') {
        const match = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE + '='));
        const id = match && match.slice(COOKIE.length + 1);
        const session = this.sessions.get(id);
        if (!session) return null;
        if (session.expires <= this.clock()) { this.revoke(id); return null; }
        return session;
    }
    require(request, write = false) {
        const session = this.session(request.headers.cookie);
        if (!session) throw fail('AUTH_REQUIRED', 'Administrator login required', 401);
        if (write) {
            const origin = request.headers.origin;
            if (origin) {
                let parsed;
                try { parsed = new URL(origin); } catch { throw fail('ORIGIN_REJECTED', 'Invalid origin', 403); }
                if (parsed.host !== request.headers.host || parsed.protocol !== (request.protocol + ':')) throw fail('ORIGIN_REJECTED', 'Cross-origin request rejected', 403);
            }
            if (!equalSecret(request.headers['x-csrf-token'] || '', session.csrf)) throw fail('CSRF_REJECTED', 'Invalid CSRF token', 403);
        }
        return session;
    }
    revoke(id) {
        const session = this.sessions.get(id);
        this.sessions.delete(id);
        if (session) {
            const streams = [...session.streams]; session.streams.clear();
            for (const stream of streams) {
                try { stream.end(); } catch { try { stream.destroy?.(); } catch {} }
            }
        }
    }
    async change(currentPassword, newPassword) {
        const previous = this.record;
        this.password(newPassword);
        if (typeof currentPassword !== 'string' || currentPassword.length > 1024 || !equalSecret(await this.hash(currentPassword, this.record.salt), this.record.hash)) {
            throw fail('AUTH_FAILED', 'Invalid current password', 401);
        }
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = await this.hash(newPassword, salt);
        if (this.closed) throw fail('CLOSING', 'Authentication service is stopping', 503);
        if (this.record !== previous) throw fail('AUTH_CHANGED', 'Administrator credentials changed during this operation', 409);
        const record = { version: 1, salt, hash }; atomic(this.file, record); this.record = record;
        for (const id of [...this.sessions.keys()]) this.revoke(id);
    }
    close() { this.closed = true; for (const id of [...this.sessions.keys()]) this.revoke(id); }
}
module.exports = { Auth };
