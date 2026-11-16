'use strict';

const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { atomic, privateDirectory, identifier, equalSecret, fail } = require('./files.cjs');
const { workspacePath } = require('../paths.cjs');
const MAX_BODY = 2048;
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function ordinaryJson(root, file, maximum = 4096) {
    const target = workspacePath(root, file), relative = path.relative(path.resolve(root), path.dirname(target));
    let directory = path.resolve(root);
    for (const component of relative.split(path.sep).filter(Boolean)) {
        directory = path.join(directory, component);
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('INVALID_CONFIG', 'Lifecycle paths must be ordinary private directories');
    }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw fail('INVALID_CONFIG', 'Invalid lifecycle control file');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const current = fs.fstatSync(fd);
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.nlink !== 1) throw fail('INVALID_CONFIG', 'Lifecycle control file changed');
        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
}
function inputFor(value) {
    if (!object(value) || !['prepare', 'commit', 'cancel'].includes(value.phase) ||
        Object.keys(value).some(key => !['phase', 'instance', 'profileId', 'uin', 'epoch', 'operation', 'receipt'].includes(key)) ||
        typeof value.instance !== 'string' || !/^[a-f0-9]{48}$/.test(value.instance) ||
        !['stop', 'restart'].includes(value.operation) || typeof value.uin !== 'string' || !/^[1-9]\d{0,15}$/.test(value.uin) ||
        !Number.isSafeInteger(Number(value.uin)) || typeof value.epoch !== 'string' || !value.epoch || value.epoch.length > 256 || /[\x00-\x1f\x7f]/.test(value.epoch) ||
        (value.phase === 'prepare' ? value.receipt !== undefined : typeof value.receipt !== 'string' || !/^[a-f0-9]{48}$/.test(value.receipt))) {
        throw fail('INVALID_PARAMS', 'Invalid lifecycle request');
    }
    identifier(value.profileId); return value;
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Delayed commit/cancel can outlive the HTTP request which created it.
    promise.catch(() => {});
    return { promise, resolve, reject };
}

class ManagerLifecycle {
    constructor(root, accounts, { reservationMs = 15000, onError = () => {} } = {}) {
        this.root = root; this.accounts = accounts; this.reservationMs = reservationMs; this.onError = onError;
        this.file = path.join(privateDirectory(root, 'work/control'), 'lifecycle-endpoint.json');
        this.instance = crypto.randomBytes(24).toString('hex'); this.pending = new Map(); this.closed = false;
    }
    current(input, token, expectedChild) {
        const accounts = this.accounts, id = input.profileId, child = accounts.processes.get(id), profile = accounts.get(id);
        if (this.closed || accounts.closing || accounts.persistenceBlocked.has(id) || accounts.document.maintenance[id] ||
            profile.desired !== 'running' || accounts.stopping.has(id) || !child || child.freshwaterExited || expectedChild && child !== expectedChild) {
            throw fail('NOT_READY', 'Account lifecycle is unavailable', 503);
        }
        const grant = ordinaryJson(this.root, path.join(accounts.location(id), 'state/authorization.json'));
        const health = ordinaryJson(this.root, path.join(accounts.location(id), 'state/health.json'), 256 * 1024);
        if (grant.profileId !== id || String(grant.uin) !== input.uin || grant.epoch !== input.epoch ||
            typeof grant.managementToken !== 'string' || !equalSecret(grant.managementToken, token) ||
            health.ready !== true || String(health.selfId) !== input.uin || health.sessionEpoch !== input.epoch ||
            !Number.isFinite(health.at) || Date.now() - health.at > 15000 || health.at > Date.now() + 5000) {
            throw fail('SESSION_CHANGED', 'Account lifecycle authorization changed', 403);
        }
        return child;
    }
    async request(value, token) {
        const input = inputFor(value);
        if (input.instance !== this.instance || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw fail('AUTH_REQUIRED', 'Lifecycle authorization required', 401);
        if (input.phase === 'prepare') return this.prepare(input, token);
        const row = this.pending.get(input.profileId);
        if (!row || row.receipt !== input.receipt || row.input.operation !== input.operation || row.input.epoch !== input.epoch ||
            row.input.uin !== input.uin || !equalSecret(row.token, token)) throw fail('NOT_FOUND', 'Lifecycle reservation is unavailable', 404);
        if (row.committed) throw fail('CONFLICT', 'Lifecycle reservation was already committed', 409);
        if (input.phase === 'cancel') { row.gate.resolve(false); return { accepted: false }; }
        try { this.current(input, token, row.child); }
        catch (error) { row.gate.resolve(false); throw error; }
        row.committed = true; clearTimeout(row.timer); row.gate.resolve(true);
        await row.accepted.promise;
        return { accepted: true };
    }
    async prepare(input, token) {
        const child = this.current(input, token), id = input.profileId;
        const row = { input, token, child, receipt: crypto.randomBytes(24).toString('hex'), gate: deferred(), ready: deferred(), accepted: deferred(), committed: false };
        if (this.pending.has(id)) throw fail('BUSY', 'Account lifecycle is already reserved', 409);
        this.pending.set(id, row);
        row.operation = this.accounts.operate(id, async () => {
            this.current(input, token, child); row.ready.resolve();
            if (!await row.gate.promise) return;
            this.current(input, token, child);
            // Persist the account-only target intent before executing. Restart
            // deliberately never persists a stopped state between stop/start.
            this.accounts.commitProfile(id, { desired: input.operation === 'stop' ? 'stopped' : 'running' });
            row.accepted.resolve();
            await new Promise(resolve => setImmediate(resolve));
            await this.accounts.stopAccount(id, { preserveIntent: true });
            if (input.operation === 'restart' && !this.closed) await this.accounts.startAccount(id, { automatic: true });
        }).catch(error => {
            row.ready.reject(error); row.accepted.reject(error);
            if (row.committed) {
                this.accounts.states.set(id, 'lifecycle_failed'); this.accounts.onChange();
                try { this.onError(error); } catch { /* Diagnostics cannot change lifecycle ownership. */ }
            }
        }).finally(() => { clearTimeout(row.timer); if (this.pending.get(id) === row) this.pending.delete(id); });
        await row.ready.promise;
        row.timer = setTimeout(() => row.gate.resolve(false), this.reservationMs); row.timer.unref?.();
        return { receipt: row.receipt, accepted: true };
    }
    async open() {
        this.server = http.createServer((request, response) => {
            this.handle(request, response).catch(error => {
                if (response.writableEnded || response.destroyed) return;
                response.writeHead(error.statusCode || 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                response.end(JSON.stringify({ error: { code: error.code || 'LIFECYCLE_FAILED', message: 'Lifecycle request rejected' } }));
            });
        });
        this.server.requestTimeout = 5000; this.server.headersTimeout = 5000; this.server.keepAliveTimeout = 1000;
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
        try { atomic(this.file, { version: 1, port: this.server.address().port, instance: this.instance }); }
        catch (error) { await new Promise(resolve => this.server.close(resolve)); throw error; }
        return this;
    }
    async handle(request, response) {
        if (this.closed) throw fail('CLOSING', 'Lifecycle service is stopping', 503);
        if (request.method !== 'POST' || request.url !== '/lifecycle' || request.headers.origin ||
            request.headers['content-type'] !== 'application/json' || !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(request.headers.authorization || '')) throw fail('AUTH_REQUIRED', 'Lifecycle authorization required', 401);
        let size = 0; const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw fail('TOO_LARGE', 'Lifecycle request is too large', 413); chunks.push(chunk); }
        const result = await this.request(JSON.parse(Buffer.concat(chunks).toString('utf8')), request.headers.authorization.slice(7));
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(result));
    }
    async close() {
        if (this.closed) return; this.closed = true;
        for (const row of this.pending.values()) if (!row.committed) row.gate.resolve(false);
        if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
        await Promise.allSettled([...this.pending.values()].map(row => row.operation));
        try { if (ordinaryJson(this.root, this.file).instance === this.instance) fs.unlinkSync(this.file); }
        catch (error) { if (error.code !== 'ENOENT') try { this.onError(error); } catch { /* Keep conservative ownership evidence. */ } }
    }
}

class LifecycleClient {
    constructor({ root, profileId, authorizationFile, endpointFile, logger = () => {}, timeoutMs = 3000 }) {
        this.root = root; this.profileId = profileId; this.authorizationFile = authorizationFile; this.endpointFile = endpointFile;
        this.logger = logger; this.timeoutMs = timeoutMs;
    }
    available() { return Boolean(this.endpointFile && this.authorizationFile); }
    async prepare(state, operation) {
        if (!this.available()) throw fail('UNSUPPORTED', 'Managed account lifecycle is unavailable');
        const endpoint = ordinaryJson(this.root, this.endpointFile), grant = ordinaryJson(this.root, this.authorizationFile);
        if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
            typeof endpoint.instance !== 'string' || !/^[a-f0-9]{48}$/.test(endpoint.instance)) throw fail('INVALID_CONFIG', 'Invalid lifecycle endpoint');
        if (grant.profileId !== this.profileId || String(grant.uin) !== String(state.self.uin) || grant.epoch !== state.epoch ||
            typeof grant.managementToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(grant.managementToken)) throw fail('SESSION_CHANGED', 'Lifecycle account authorization changed');
        const input = { instance: endpoint.instance, profileId: this.profileId, uin: String(state.self.uin), epoch: state.epoch, operation };
        const result = await this.send(endpoint.port, grant.managementToken, { ...input, phase: 'prepare' });
        if (result.accepted !== true || typeof result.receipt !== 'string' || !/^[a-f0-9]{48}$/.test(result.receipt)) throw fail('INVALID_RESPONSE', 'Invalid lifecycle reservation response');
        let settled = false;
        return { complete: async success => {
            if (settled) return; settled = true;
            await this.send(endpoint.port, grant.managementToken, { ...input, receipt: result.receipt, phase: success === true ? 'commit' : 'cancel' });
        } };
    }
    async send(port, token, input) {
        const response = await fetch('http://127.0.0.1:' + port + '/lifecycle', { method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(input), signal: AbortSignal.timeout(this.timeoutMs) });
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BODY) throw fail('INVALID_RESPONSE', 'Invalid lifecycle response'); chunks.push(chunk); }
        const text = Buffer.concat(chunks).toString('utf8');
        let result; try { result = JSON.parse(text); } catch { throw fail('INVALID_RESPONSE', 'Invalid lifecycle response'); }
        if (!response.ok) throw fail(result.error?.code || 'LIFECYCLE_FAILED', 'Lifecycle request rejected');
        return result;
    }
}

module.exports = { ManagerLifecycle, LifecycleClient };
