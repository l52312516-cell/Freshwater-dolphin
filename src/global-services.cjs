'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { workspacePath } = require('./paths.cjs');
const { normalizeMusicData, validateMusicCard } = require('./qq/music.cjs');
const { resolveMusic } = require('./music-resolver.cjs');
const { normalizeStatusCommand } = require('./status-command.cjs');

const MAX_URL = 2048;
const MAX_SERVERS = 8;
const MAX_RESPONSE = 128 * 1024;
const DOWNLOAD_HOSTS = new Set(['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'multimedia.qfile.qq.com']);
// NTV2 download-rkey type per chat scope (types requested by QQApi/NapCat: 10/20/2).
const NATIVE_RKEY_TYPE = { private: 10, group: 20 };
const NATIVE_NEGATIVE_MS = 30000;
const NATIVE_QUERY_TIMEOUT_MS = 10000;

function nativeExpiry(entry, now) {
    const integer = (value, maximum) => {
        if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) return null;
        if (typeof value !== 'number' && typeof value !== 'bigint' &&
            !(typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value))) return null;
        const result = BigInt(value);
        return result > 0n && result <= maximum ? result : null;
    };
    const ttl = integer(entry.rkeyTtlSec, 0xffffffffffffffffn);
    const created = integer(entry.rkeyCreateTime, 0xffffffffn);
    if (ttl === null || created === null || !Number.isSafeInteger(now) || now < 0) return null;
    const expires = (created + ttl) * 1000n;
    if (expires <= BigInt(now) + 1000n) return null;
    // Keep uint64 TTL arithmetic exact; the local cache never needs to retain
    // an entry for more than an hour, even if QQ grants a longer lifetime.
    const hour = BigInt(now) + 3600000n, safe = BigInt(Number.MAX_SAFE_INTEGER);
    const maximum = hour < safe ? hour : safe;
    const bounded = expires < maximum ? expires : maximum;
    return bounded > BigInt(now) + 1000n ? Number(bounded) : null;
}
function problem(code, message, statusCode = 502) { return Object.assign(new Error(message), { code, statusCode }); }
function invalid(message) { throw problem('INVALID_CONFIG', message, 400); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function endpoint(value, label, empty = false) {
    if (typeof value !== 'string' || value.length > MAX_URL || /[\x00-\x1f\x7f]/.test(value)) invalid('Invalid ' + label);
    const text = value.trim();
    if (!text && empty) return '';
    let url;
    try { url = new URL(text); } catch { invalid('Invalid ' + label); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || text.includes('#')) invalid('Invalid ' + label);
    return url.href;
}
function signingKey(value = '') {
    if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) invalid('Invalid musicSignKey');
    return value;
}
function externalSettings(value = {}) {
    if (!record(value)) invalid('Settings must be an object');
    const rkey = value.rkey === undefined ? { fallbackServers: [] } : value.rkey;
    if (!record(rkey) || Object.keys(rkey).some(key => key !== 'fallbackServers') || !Array.isArray(rkey.fallbackServers) || rkey.fallbackServers.length > MAX_SERVERS) {
        invalid('rkey.fallbackServers must contain at most 8 HTTP(S) URLs');
    }
    let musicSignUrl = value.musicSignUrl === undefined ? '' : endpoint(value.musicSignUrl, 'musicSignUrl', true);
    let musicSignKey = signingKey(value.musicSignKey);
    if (musicSignUrl) {
        const url = new URL(musicSignUrl);
        if (url.searchParams.has('key')) {
            const keys = url.searchParams.getAll('key');
            if (keys.length !== 1) invalid('Only one music signing key may be supplied');
            const embedded = signingKey(keys[0]);
            if (!musicSignKey) musicSignKey = embedded;
            url.searchParams.delete('key'); musicSignUrl = url.href;
        }
    }
    return { rkey: { fallbackServers: [...new Set(rkey.fallbackServers.map(url => endpoint(url, 'rkey fallback URL')))] }, musicSignUrl, musicSignKey };
}
function publicSettings(value) {
    const normalized = externalSettings(value), { musicSignKey, ...safe } = { ...value, ...normalized };
    return { ...safe, statusCommand: normalizeStatusCommand(value.statusCommand), hasMusicSignKey: Boolean(musicSignKey) };
}
function validateGlobalSettingsPatch(patch, current) {
    if (!record(patch) || Object.keys(patch).some(key => !['maxAccounts', 'publicBaseUrl', 'rkey', 'musicSignUrl', 'musicSignKey', 'clearMusicSignKey', 'statusCommand'].includes(key))) invalid('Unknown or invalid settings field');
    if (patch.clearMusicSignKey !== undefined && typeof patch.clearMusicSignKey !== 'boolean') invalid('clearMusicSignKey must be boolean');
    if (patch.musicSignKey !== undefined) signingKey(patch.musicSignKey);
    let embeddedKey = '';
    if (typeof patch.musicSignUrl === 'string' && patch.musicSignUrl) {
        const url = new URL(endpoint(patch.musicSignUrl, 'musicSignUrl'));
        if (url.searchParams.has('key')) {
            if (url.searchParams.getAll('key').length !== 1) invalid('Only one music signing key may be supplied');
            embeddedKey = signingKey(url.searchParams.get('key'));
        }
    }
    const previous = externalSettings(current);
    const next = { ...current, ...previous, ...patch };
    next.musicSignKey = patch.musicSignKey || embeddedKey || previous.musicSignKey;
    if (patch.clearMusicSignKey === true) {
        if (patch.musicSignKey || embeddedKey) invalid('A replacement music signing key cannot be supplied while clearing it');
        next.musicSignKey = '';
    }
    delete next.clearMusicSignKey;
    if (!Number.isInteger(next.maxAccounts) || next.maxAccounts < 1 || next.maxAccounts > 16) invalid('maxAccounts must be 1 to 16');
    if (next.publicBaseUrl !== undefined) {
        const text = endpoint(next.publicBaseUrl, 'publicBaseUrl', true);
        if (text) {
            const url = new URL(text);
            if (url.search || url.pathname !== '/') invalid('publicBaseUrl must be an HTTP(S) origin');
            next.publicBaseUrl = url.origin;
        } else next.publicBaseUrl = '';
    }
    let statusCommand;
    try { statusCommand = normalizeStatusCommand(next.statusCommand); }
    catch { invalid('Invalid status command settings'); }
    const normalized = { ...next, ...externalSettings(next), statusCommand };
    if (previous.musicSignKey && normalized.musicSignUrl &&
        (!previous.musicSignUrl || new URL(normalized.musicSignUrl).origin !== new URL(previous.musicSignUrl).origin) &&
        !patch.musicSignKey && !embeddedKey && patch.clearMusicSignKey !== true) {
        invalid('Changing music signing origin requires re-entering the API key or explicitly clearing it');
    }
    return normalized;
}

// A client belongs to one account worker. Only the service endpoints are global;
// downloaded keys and in-flight requests are never shared between accounts.
class GlobalServices {
    constructor({ root = path.resolve(__dirname, '..'), fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 5000, nativeRkey = null } = {}) {
        if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError('Invalid global service client options');
        if (nativeRkey !== null && typeof nativeRkey !== 'function') throw new TypeError('nativeRkey must be a function or null');
        this.file = workspacePath(root, 'work/control/settings.json');
        this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs; this.nativeRkey = nativeRkey;
        this.fingerprint = null; this.keys = new Map(); this.pending = new Map();
        this.nativeKeys = new Map(); this.nativeNegative = new Map(); this.nativePending = new Map();
        this.session = null; this.sessionVersion = 0; this.nativeGeneration = 0;
    }
    resetSession(epoch, selfUin) {
        if (typeof epoch !== 'string' || !epoch || typeof selfUin !== 'string' || !/^[1-9]\d{0,15}$/.test(selfUin) || !Number.isSafeInteger(Number(selfUin))) {
            throw problem('INVALID_PARAMS', 'Global services require a confirmed QQ session identity', 400);
        }
        const identity = JSON.stringify([epoch, selfUin]);
        if (identity !== this.session) {
            this.session = identity; this.sessionVersion++; this.keys.clear(); this.pending.clear();
            this.nativeGeneration++;
            this.nativeKeys.clear(); this.nativeNegative.clear(); this.nativePending.clear();
        }
    }
    settings() {
        let value;
        try {
            const stat = fs.lstatSync(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid settings file');
            value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') value = {};
            else throw problem('INVALID_CONFIG', 'Global service settings could not be read', 503);
        }
        const settings = externalSettings(value), fingerprint = JSON.stringify(settings);
        if (fingerprint !== this.fingerprint) {
            this.nativeGeneration++;
            this.keys.clear(); this.pending.clear(); this.nativeKeys.clear();
            this.nativeNegative.clear(); this.nativePending.clear(); this.fingerprint = fingerprint;
        }
        return { ...settings, fingerprint, sessionVersion: this.sessionVersion };
    }
    unchanged(fingerprint, sessionVersion) {
        if (sessionVersion !== undefined && sessionVersion !== this.sessionVersion) throw problem('SESSION_CHANGED', 'QQ session changed during the external service request', 503);
        if (this.settings().fingerprint !== fingerprint) throw problem('GLOBAL_SETTINGS_CHANGED', 'Global service settings changed during the request', 503);
    }
    musicEnabled() {
        const settings = this.settings();
        return Boolean(settings.musicSignUrl);
    }
    budget(deadline) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1) throw problem('TIMEOUT', 'External service request exceeded its total time budget', 504);
        return remaining;
    }
    async within(promise, deadline) {
        let timer;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                timer = setTimeout(() => reject(problem('TIMEOUT', 'External service request exceeded its total time budget', 504)), this.budget(deadline));
            })]);
        } finally { clearTimeout(timer); }
    }
    async json(url, options = {}, timeoutMs = this.timeoutMs, allowString = false) {
        const controller = new AbortController();
        let abort;
        const interrupted = new Promise((_, reject) => {
            abort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', abort, { once: true });
        });
        const timer = setTimeout(() => controller.abort(problem('TIMEOUT', 'External service timed out', 504)), timeoutMs);
        try {
            return await Promise.race([(async () => {
                const response = await this.fetch(url, { ...options, redirect: 'error', signal: controller.signal,
                    headers: { Accept: 'application/json', ...options.headers } });
                controller.signal.throwIfAborted();
                if (!response.ok || response.redirected || response.url && response.url !== url) throw problem('EXTERNAL_SERVICE_FAILED', 'External service returned an unsuccessful response');
                const size = Number(response.headers.get('content-length'));
                if (size > MAX_RESPONSE || !response.body) throw problem('INVALID_RESPONSE', 'External service response is absent or too large');
                const chunks = []; let received = 0;
                for await (const chunk of response.body) {
                    controller.signal.throwIfAborted();
                    received += chunk.length;
                    if (received > MAX_RESPONSE) {
                        controller.abort(problem('INVALID_RESPONSE', 'External service response is too large'));
                        controller.signal.throwIfAborted();
                    }
                    chunks.push(Buffer.from(chunk));
                }
                controller.signal.throwIfAborted();
                let value;
                try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw problem('INVALID_RESPONSE', 'External service did not return JSON'); }
                if (!record(value) && !(allowString && typeof value === 'string')) throw problem('INVALID_RESPONSE', 'External service did not return an object');
                return value;
            })(), interrupted]);
        } catch (error) {
            if (!controller.signal.aborted) controller.abort(error);
            if (error.statusCode) throw error;
            throw problem('EXTERNAL_SERVICE_FAILED', 'External service request failed');
        } finally {
            clearTimeout(timer); controller.signal.removeEventListener('abort', abort);
        }
    }
    keyValue(value) {
        if (typeof value !== 'string') return null;
        const token = value.replace(/^[?&]?rkey=/, '');
        return token.length > 0 && token.length <= 4096 && /^[A-Za-z0-9_~.%+\/=:!-]+$/.test(token) ? token : null;
    }
    async fetchKey(settings, kind, deadline) {
        for (const server of settings.rkey.fallbackServers) {
            this.unchanged(settings.fingerprint, settings.sessionVersion);
            this.budget(deadline);
            try {
                let body = await this.json(server, {}, Math.min(this.timeoutMs, this.budget(deadline)));
                this.unchanged(settings.fingerprint, settings.sessionVersion);
                if (Object.hasOwn(body, 'retcode')) {
                    if (body.retcode !== 0 || !record(body.data)) throw problem('INVALID_RESPONSE', 'rkey service reported an error');
                    body = body.data;
                }
                const key = this.keyValue(body[kind === 'group' ? 'group_rkey' : 'private_rkey']);
                if (!key) throw problem('INVALID_RESPONSE', 'rkey service did not return a valid key for this chat');
                const now = this.now();
                let expiresAt = now + 60000;
                if (body.expired_time !== undefined) {
                    if (!Number.isSafeInteger(body.expired_time) || body.expired_time <= Math.floor(now / 1000)) throw problem('INVALID_RESPONSE', 'rkey service returned an expired key');
                    expiresAt = Math.min(body.expired_time * 1000, now + 3600000);
                }
                this.keys.set(kind, { key, expiresAt });
                return key;
            } catch (error) {
                if (['GLOBAL_SETTINGS_CHANGED', 'SESSION_CHANGED', 'INVALID_CONFIG'].includes(error.code)) throw error;
                // Try the next explicitly configured read-only fallback once.
            }
        }
        this.budget(deadline);
        throw problem('RKEY_UNAVAILABLE', 'No configured rkey service returned a usable key', 503);
    }
    // Primary rkey source: QQ's own kernel SSO query, injected as an adapter so this
    // module stays transport-agnostic. Returns a usable key or null (never fabricates);
    // a short negative cache avoids hammering the kernel for bulk merged-image reads.
    async nativeKey(settings, kind, deadline) {
        if (typeof this.nativeRkey !== 'function') return null;
        const cached = this.nativeKeys.get(kind);
        if (cached && cached.expiresAt > this.now() + 1000) return cached.key;
        const negative = this.nativeNegative.get(kind);
        if (negative && negative > this.now()) return null;
        this.budget(deadline);
        let pending = this.nativePending.get(kind);
        if (!pending) {
            const [expectedEpoch, expectedUin] = this.session ? JSON.parse(this.session) : [null, null];
            const generation = this.nativeGeneration;
            const current = () => {
                this.unchanged(settings.fingerprint, settings.sessionVersion);
                if (generation !== this.nativeGeneration) throw problem('GLOBAL_SETTINGS_CHANGED', 'Global service settings changed during the native query', 503);
            };
            pending = (async () => {
                let timer, result;
                try {
                    // The shared operation has its own bounded budget. A caller
                    // timing out only stops that caller's wait, not other readers.
                    result = await Promise.race([
                        Promise.resolve(this.nativeRkey(kind, { timeoutMs: NATIVE_QUERY_TIMEOUT_MS, expectedEpoch, expectedUin })),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(problem('TIMEOUT', 'Native rkey query timed out', 504)), NATIVE_QUERY_TIMEOUT_MS); })
                    ]);
                } catch (error) {
                    // A late rejection from an old session must not poison the
                    // replacement session's negative cache.
                    current();
                    if (['SESSION_CHANGED', 'GLOBAL_SETTINGS_CHANGED', 'INVALID_CONFIG'].includes(error?.code)) throw error;
                    this.nativeNegative.set(kind, this.now() + NATIVE_NEGATIVE_MS);
                    return null;
                } finally { clearTimeout(timer); }
                current();
                const entries = Array.isArray(result?.rkeys) ? result.rkeys : [];
                for (const entry of entries) {
                    if (!record(entry) || entry.type !== NATIVE_RKEY_TYPE[kind]) continue;
                    const key = this.keyValue(entry.rkey), expiresAt = nativeExpiry(entry, this.now());
                    if (!key || expiresAt === null) continue;
                    this.nativeKeys.set(kind, { key, expiresAt });
                    this.nativeNegative.delete(kind);
                    return key;
                }
                this.nativeNegative.set(kind, this.now() + NATIVE_NEGATIVE_MS);
                return null;
            })();
            this.nativePending.set(kind, pending);
            pending.finally(() => { if (this.nativePending.get(kind) === pending) this.nativePending.delete(kind); }).catch(() => {});
        }
        return this.within(pending, deadline);
    }
    async resolveImageUrl(input, isGroup, options = {}) {
        if (!record(options) || options.forceRefresh !== undefined && typeof options.forceRefresh !== 'boolean' ||
            options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)) {
            throw problem('INVALID_PARAMS', 'Invalid rkey request time budget', 400);
        }
        const deadline = performance.now() + Math.min(options.timeoutMs ?? this.timeoutMs, 60000);
        if (typeof input !== 'string' || input.length > 16384 || /[\x00-\x20\x7f]/.test(input) || typeof isGroup !== 'boolean') throw problem('INVALID_PARAMS', 'Invalid image URL or chat type', 400);
        let url;
        try { url = new URL(input); } catch { throw problem('INVALID_PARAMS', 'Invalid image URL', 400); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw problem('INVALID_PARAMS', 'Invalid image URL', 400);
        if (!DOWNLOAD_HOSTS.has(url.hostname) || url.pathname !== '/download') return input;
        const supplied = url.searchParams.getAll('rkey');
        if (supplied.length > 1) throw problem('INVALID_PARAMS', 'Ambiguous image rkey', 400);
        const previous = supplied[0] || '';
        // Forwarded pictures keep their original upload scope, which may differ
        // from the conversation containing the forward. Never infer that scope
        // from the order of keys in QQ's response.
        const appids = url.searchParams.getAll('appid');
        if (appids.length > 1) throw problem('INVALID_PARAMS', 'Ambiguous image appid', 400);
        const kind = appids[0] === '1406' ? 'private' : appids[0] === '1407' ? 'group' : isGroup ? 'group' : 'private';
        const settings = this.settings();
        if (options.forceRefresh) {
            // Concurrent readers may already have replaced the rejected URL's
            // key. Never discard that newer account-scoped cache entry.
            for (const cache of [this.nativeKeys, this.keys]) {
                const cached = cache.get(kind);
                if (cached && (!previous || cached.key === previous)) cache.delete(kind);
            }
            this.nativeNegative.delete(kind);
        }
        let key = await this.nativeKey(settings, kind, deadline);
        if (!key) {
            if (!settings.rkey.fallbackServers.length) {
                if (previous && !options.forceRefresh) return input;
                throw problem('RKEY_UNAVAILABLE', 'Image needs an rkey and fallback services are disabled', 503);
            }
            const cached = this.keys.get(kind);
            key = cached && cached.expiresAt > this.now() + 1000 ? cached.key : null;
            if (!key) {
                let pending = this.pending.get(kind);
                if (!pending) {
                    pending = this.fetchKey(settings, kind, deadline); this.pending.set(kind, pending);
                    pending.finally(() => { if (this.pending.get(kind) === pending) this.pending.delete(kind); }).catch(() => {});
                }
                try { key = await this.within(pending, deadline); }
                catch (error) {
                    if (previous && !options.forceRefresh && error.code === 'RKEY_UNAVAILABLE') return input;
                    throw error;
                }
            }
        }
        this.budget(deadline);
        this.unchanged(settings.fingerprint, settings.sessionVersion);
        url.searchParams.set('rkey', key);
        return url.href;
    }
    async signMusic(data, context = {}) {
        if (!record(data) || !record(context)) throw problem('INVALID_PARAMS', 'Music data and context must be objects', 400);
        if (context.timeoutMs !== undefined && (!Number.isInteger(context.timeoutMs) || context.timeoutMs < 1 || context.timeoutMs > 120000)) throw problem('INVALID_PARAMS', 'Invalid music signing time budget', 400);
        const settings = this.settings();
        if (!settings.musicSignUrl) throw problem('UNSUPPORTED', 'Third-party music signing is disabled', 400);
        const deadline = performance.now() + Math.min(context.timeoutMs ?? this.timeoutMs, 60000);
        const normalized = normalizeMusicData(data);
        const payload = normalized.type === 'custom' ? { type: normalized.type, url: normalized.url, audio: normalized.audio,
            title: normalized.title, image: normalized.image, singer: normalized.content } : normalized;
        // Peer and self identity remain local. The public signer contract only
        // needs music metadata and does not authorize a kernel send operation.
        const service = new URL(settings.musicSignUrl);
        let result;
        if (settings.musicSignKey) {
            const metadata = normalized.type === 'custom' ? normalized : await resolveMusic(normalized, {
                timeoutMs: this.budget(deadline), requestJson: async (url, options, timeoutMs) => {
                    this.unchanged(settings.fingerprint, settings.sessionVersion);
                    const response = await this.json(url, options, Math.min(timeoutMs, this.budget(deadline), 10000));
                    this.unchanged(settings.fingerprint, settings.sessionVersion);
                    return response;
                }
            });
            this.unchanged(settings.fingerprint, settings.sessionVersion);
            service.searchParams.set('key', settings.musicSignKey);
            service.searchParams.set('url', metadata.audio); service.searchParams.set('song', metadata.title);
            service.searchParams.set('singer', metadata.content); service.searchParams.set('cover', metadata.image);
            service.searchParams.set('jump', metadata.url); service.searchParams.set('format', metadata.platform || 'qq');
            const envelope = await this.json(service.href, {}, Math.min(this.budget(deadline), 15000));
            if (envelope.code !== 200 || !record(envelope.data)) throw problem('INVALID_RESPONSE', 'The configured music signing service did not return a music card');
            result = envelope.data;
        } else result = await this.json(settings.musicSignUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
            Math.min(this.budget(deadline), 15000), true);
        this.budget(deadline);
        this.unchanged(settings.fingerprint, settings.sessionVersion);
        const signed = typeof result === 'string' ? result : JSON.stringify(result);
        try { validateMusicCard(signed); } catch { throw problem('INVALID_RESPONSE', 'Music signer did not return a supported music card'); }
        return { format: 'ark-json', text: signed };
    }
}

module.exports = { GlobalServices, externalSettings, publicSettings, validateGlobalSettingsPatch };
