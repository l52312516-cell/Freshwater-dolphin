'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { fail, privateDirectory, identifier, equalSecret } = require('./files.cjs');

function alive(child) {
    return child && Number.isSafeInteger(child.pid) && child.pid > 0 && child.freshwaterExited !== true &&
        child.remoteExited !== true && child.exitCode == null && child.signalCode == null;
}
function actualDisplay(child, base) {
    // Profile positions can change while QQ keeps running. Read only the two
    // required environment entries from this exact owned account generation.
    const bytes = fs.readFileSync(`/proc/${child.pid}/environ`);
    if (bytes.length > 1024 * 1024) throw fail('REMOTE_UNAVAILABLE', 'Account display environment is too large', 503);
    const entries = bytes.toString('utf8').split('\0');
    const display = entries.find(value => value.startsWith('DISPLAY='))?.slice(8);
    const accountRoot = entries.find(value => value.startsWith('FWD_ACCOUNT_ROOT='))?.slice(17);
    if (!accountRoot || path.resolve(accountRoot) !== path.resolve(base)) throw fail('REMOTE_UNAVAILABLE', 'Account display ownership is unconfirmed', 503);
    return display;
}
async function allocatePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}
function probe(port, _record, timeoutMs = 1500) {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let bytes = Buffer.alloc(0), done = false;
        const finish = result => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(result); };
        // LibVNCServer detects WebSocket/native clients before sending its RFB
        // banner. A 400ms socket timeout can interrupt that normal detection
        // repeatedly. Allow one handshake, bounded by the startup's remaining
        // budget; incoming partial bytes must not extend that absolute deadline.
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.on('error', () => finish(false)); socket.on('end', () => finish(false));
        socket.on('data', data => {
            bytes = Buffer.concat([bytes, data.subarray(0, 12 - bytes.length)]);
            if (bytes.length >= 12) finish(/^RFB 003\.00[378]\n$/.test(bytes.subarray(0, 12).toString('ascii')));
        });
    });
}
function closeConnection(connection) {
    try {
        if (typeof connection.terminate === 'function') connection.terminate();
        else if (typeof connection.destroy === 'function') connection.destroy();
        else if (typeof connection.close === 'function') connection.close();
        else connection.end?.();
    } catch {}
}

class RemoteDesktop {
    constructor(root, accounts, options = {}) {
        this.root = root;
        this.accounts = accounts;
        this.spawn = options.spawn || spawn;
        this.allocatePort = options.allocatePort || allocatePort;
        this.probe = options.probe || probe;
        this.displayFor = options.displayFor || actualDisplay;
        this.now = options.now || Date.now;
        this.ttlMs = Math.min(options.ttlMs || 300000, 300000);
        this.startTimeoutMs = options.startTimeoutMs || 7000;
        this.termTimeoutMs = options.termTimeoutMs || 1500;
        this.killTimeoutMs = options.killTimeoutMs || 500;
        this.pollMs = options.pollMs || 250;
        this.sessions = new Map();
        this.ports = new Set();
        this.queues = new Map();
        this.revisions = new Map();
        this.closed = false;
        this.monitor = setInterval(() => {
            for (const [id, record] of this.sessions) if (!this.valid(id, record)) this.close(id).catch(() => {});
        }, this.pollMs);
        this.monitor.unref?.();
    }
    owner(id) {
        const profile = this.accounts.get(identifier(id));
        const child = this.accounts.processes.get(id);
        if (this.accounts.closing || this.accounts.stopping?.has(id) || profile.desired !== 'running' ||
            this.accounts.document.maintenance?.[id] || !alive(child)) throw fail('NOT_READY', 'QQ account is not running', 409);
        const health = this.accounts.healths.get(id);
        if (health?.ready === true && health.authorized === true && !['account_mismatch', 'duplicate_account'].includes(this.accounts.states?.get(id))) {
            throw fail('ALREADY_READY', 'QQ is already initialized and authorized; remote login is closed', 409);
        }
        return child;
    }
    valid(id, record) {
        if (!record || record.closed || this.closed || this.now() >= record.expiresAt || !alive(record.accountChild)) return false;
        try { return this.owner(id) === record.accountChild && (!record.child || alive(record.child)); }
        catch { return false; }
    }
    public(record) {
        return { sessionId: record.sessionId, profileId: record.profileId,
            path: `/api/accounts/${encodeURIComponent(record.profileId)}/remote/socket?session=${encodeURIComponent(record.sessionId)}`,
            password: record.secret, expiresAt: record.expiresAt };
    }
    status(id) {
        identifier(id); this.accounts.get(id);
        const record = this.sessions.get(id);
        if (!record || !this.valid(id, record)) {
            if (record) this.close(id).catch(() => {});
            return { profileId: id, active: false };
        }
        return { profileId: id, active: record.listening === true, expiresAt: record.expiresAt };
    }
    get(id, sessionId) {
        identifier(id);
        const record = this.sessions.get(id);
        if (!record || !this.valid(id, record) || !record.listening || typeof sessionId !== 'string' || !equalSecret(record.sessionId, sessionId)) {
            if (record && !this.valid(id, record)) this.close(id).catch(() => {});
            throw fail('REMOTE_EXPIRED', 'Remote login session is absent, expired or belongs to another account generation', 410);
        }
        return record;
    }
    open(id) {
        identifier(id); this.accounts.get(id);
        const revision = this.revisions.get(id) || 0;
        const previous = this.queues.get(id) || Promise.resolve();
        const operation = previous.catch(() => {}).then(() => this.openAccount(id, revision));
        this.queues.set(id, operation);
        operation.finally(() => { if (this.queues.get(id) === operation) this.queues.delete(id); }).catch(() => {});
        return operation;
    }
    async openAccount(id, revision) {
        if (this.closed || revision !== (this.revisions.get(id) || 0)) throw fail('REMOTE_CANCELLED', 'Remote login request was cancelled', 409);
        const accountChild = this.owner(id);
        const previous = this.sessions.get(id);
        if (previous && this.valid(id, previous) && previous.listening) return this.public(previous);
        if (previous) await this.closeRecord(id, previous);
        const base = this.accounts.location(id);
        let display;
        try { display = this.displayFor(accountChild, base, id); }
        catch { throw fail('REMOTE_UNAVAILABLE', 'Unable to verify this account display', 503); }
        if (typeof display !== 'string' || !/^:(?:12\d|14\d|13\d|150|151)$/.test(display)) {
            throw fail('REMOTE_UNAVAILABLE', 'Account has no verified isolated login display', 503);
        }
        const state = privateDirectory(this.root, path.join(base, 'state'));
        const temp = privateDirectory(this.root, path.join(base, 'temp'));
        const home = privateDirectory(this.root, path.join(base, 'home'));
        const cache = privateDirectory(this.root, path.join(base, 'cache'));
        const runtime = privateDirectory(this.root, path.join(base, 'runtime'));
        const sessionId = crypto.randomBytes(24).toString('base64url');
        const record = { sessionId, profileId: id, display, accountChild, accountPid: accountChild.pid,
            secret: crypto.randomBytes(6).toString('base64url'), expiresAt: this.now() + this.ttlMs,
            passwordFile: path.join(state, `remote-${sessionId}.passwd`), connections: new Set(),
            child: null, storeChild: null, closed: false, listening: false, revision };
        record.password = record.secret;
        record.env = { ...process.env, HOME: home, XDG_CACHE_HOME: cache, XDG_RUNTIME_DIR: runtime,
            DISPLAY: display, FWD_ACCOUNT_ROOT: base, TEMP: temp, TMP: temp, TMPDIR: temp };
        this.sessions.set(id, record);
        record.accountExit = () => { if (this.sessions.get(id) === record) this.close(id).catch(() => {}); };
        accountChild.once?.('exit', record.accountExit);
        record.timer = setTimeout(() => { if (this.sessions.get(id) === record) this.close(id).catch(() => {}); }, this.ttlMs);
        record.timer.unref?.();
        try {
            fs.writeFileSync(record.passwordFile, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
            // x11vnc's one-argument storepasswd reads password, confirmation
            // and approval from stdin. Neither argv nor logs contain it.
            const store = this.spawn('x11vnc', ['-storepasswd', record.passwordFile], {
                cwd: this.root, env: record.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true
            });
            record.storeChild = store;
            const stored = this.waitExit(store, Math.min(this.startTimeoutMs, 4000));
            store.stdin?.on('error', () => {});
            store.stdin?.end(`${record.secret}\n${record.secret}\ny\n`);
            const result = await stored;
            record.storeChild = null;
            if (result !== 0) throw fail('REMOTE_UNAVAILABLE', 'Unable to prepare temporary remote login credentials', 503);
            const stat = fs.lstatSync(record.passwordFile);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 8) throw fail('REMOTE_UNAVAILABLE', 'Invalid temporary remote login credential file', 503);
            fs.chmodSync(record.passwordFile, 0o600);
            this.assertRecord(id, record);
            record.port = await this.allocatePort();
            if (!Number.isInteger(record.port) || record.port < 1024 || record.port > 65535) throw fail('REMOTE_UNAVAILABLE', 'Invalid local remote login port', 503);
            if (this.ports.has(record.port)) throw fail('REMOTE_UNAVAILABLE', 'Local remote login port is already reserved', 503);
            this.ports.add(record.port); record.portReserved = true;
            this.assertRecord(id, record);
            record.child = this.spawn('x11vnc', ['-display', display, '-rfbauth', record.passwordFile,
                '-rfbport', String(record.port), '-listen', '127.0.0.1', '-localhost', '-no6',
                '-forever', '-shared', '-noshm', '-nosel', '-notightfilexfer', '-noremote', '-safer', '-nocmds', '-quiet'], {
                cwd: this.root, env: record.env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
            });
            const child = record.child;
            child.once('error', () => { child.remoteExited = true; if (this.sessions.get(id) === record) this.close(id).catch(() => {}); });
            child.once('exit', () => { child.remoteExited = true; if (this.sessions.get(id) === record) this.close(id).catch(() => {}); });
            const until = Date.now() + this.startTimeoutMs;
            while (Date.now() < until) {
                this.assertRecord(id, record);
                if (await this.probe(record.port, record, Math.min(1500, Math.max(1, until - Date.now())))) {
                    this.assertRecord(id, record);
                    record.listening = true;
                    return this.public(record);
                }
                const remaining = until - Date.now();
                if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
            }
            throw fail('REMOTE_UNAVAILABLE', 'Remote login did not start listening in time', 503);
        } catch (error) {
            await this.closeRecord(id, record).catch(() => {});
            if (error.statusCode) throw error;
            throw fail('REMOTE_UNAVAILABLE', 'Unable to start isolated remote login', 503);
        }
    }
    assertRecord(id, record) {
        if (this.sessions.get(id) !== record || record.revision !== (this.revisions.get(id) || 0) || !this.valid(id, record)) {
            throw fail('REMOTE_CANCELLED', 'Remote login no longer belongs to a running account generation', 409);
        }
    }
    waitExit(child, timeoutMs) {
        return new Promise((resolve, reject) => {
            let timer;
            const finish = (error, code) => {
                clearTimeout(timer); child.removeListener('exit', exited); child.removeListener('error', failed);
                if (error) reject(error); else resolve(code);
            };
            const exited = code => { child.remoteExited = true; finish(null, code); };
            const failed = () => { child.remoteExited = true; finish(fail('REMOTE_UNAVAILABLE', 'Remote login helper could not start', 503)); };
            child.once('exit', exited); child.once('error', failed);
            timer = setTimeout(() => finish(fail('REMOTE_UNAVAILABLE', 'Remote login helper timed out', 503)), timeoutMs);
        });
    }
    async stopChild(child) {
        if (!alive(child)) return;
        let ended = false, release;
        const finished = new Promise(resolve => { release = resolve; });
        const exited = () => { ended = true; child.remoteExited = true; release(); };
        child.once('exit', exited);
        try {
            try { child.kill('SIGTERM'); } catch {}
            let timer;
            await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, this.termTimeoutMs); })]); clearTimeout(timer);
            if (!ended && alive(child)) {
                try { child.kill('SIGKILL'); } catch {}
                await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, this.killTimeoutMs); })]); clearTimeout(timer);
            }
            if (!ended && alive(child)) throw fail('REMOTE_STOP_UNCONFIRMED', 'Remote login helper did not confirm termination', 503);
        } finally { child.removeListener('exit', exited); }
    }
    closeRecord(id, record) {
        if (record.cleanup) return record.cleanup;
        record.closed = true;
        if (this.sessions.get(id) === record) this.sessions.delete(id);
        clearTimeout(record.timer);
        record.accountChild.removeListener?.('exit', record.accountExit);
        for (const connection of record.connections) closeConnection(connection);
        record.connections.clear(); record.secret = null; record.password = null;
        record.cleanup = Promise.allSettled([this.stopChild(record.child), this.stopChild(record.storeChild)]).then(results => {
            try { fs.unlinkSync(record.passwordFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (record.portReserved) { this.ports.delete(record.port); record.portReserved = false; }
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
        });
        return record.cleanup;
    }
    async close(id) {
        identifier(id);
        this.revisions.set(id, (this.revisions.get(id) || 0) + 1);
        const record = this.sessions.get(id);
        if (record) await this.closeRecord(id, record);
    }
    async closeAll() {
        this.closed = true;
        clearInterval(this.monitor);
        const ids = new Set([...this.sessions.keys(), ...this.queues.keys()]);
        const results = await Promise.allSettled([...ids].map(id => this.close(id)));
        await Promise.allSettled([...this.queues.values()]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
}

module.exports = { RemoteDesktop };
