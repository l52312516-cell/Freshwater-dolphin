'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { RemoteDesktop } = require('../src/manager/remote.cjs');

function child(pid) {
    const value = new EventEmitter(); value.pid = pid; value.signals = [];
    value.kill = signal => { value.signals.push(signal); queueMicrotask(() => value.emit('exit', 0, signal)); return true; };
    return value;
}
function fixture(t, options = {}) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'remote-test-'));
    const profiles = [{ id: 'alpha', desired: 'running' }, { id: 'beta', desired: 'running' }];
    const accounts = { document: { profiles, maintenance: {} }, processes: new Map([['alpha', child(101)], ['beta', child(102)]]),
        healths: new Map(), stopping: new Set(),
        get(id) { const value = profiles.find(row => row.id === id); if (!value) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); return value; },
        location(id) { return path.join(root, 'work/accounts', id); } };
    let nextPid = 200, nextPort = 30000, probes = 0;
    const spawns = [], displays = new Map([['alpha', ':120'], ['beta', ':121']]);
    const spawn = (command, args, config) => {
        const value = child(nextPid++);
        spawns.push({ command, args, config, child: value });
        if (args[0] === '-storepasswd') {
            value.stdin = new EventEmitter();
            value.stdin.end = input => {
                value.input = input;
                if (options.storeNeverExits) return;
                fs.writeFileSync(args[1], Buffer.from('12345678'));
                queueMicrotask(() => value.emit('exit', options.storeFailure ? 1 : 0));
            };
        }
        return value;
    };
    const remote = new RemoteDesktop(root, accounts, { spawn, allocatePort: async () => nextPort++,
        displayFor: (_child, _base, id) => displays.get(id), probe: async () => { probes++; return options.listens !== false; },
        pollMs: 10, startTimeoutMs: 90, termTimeoutMs: 10, killTimeoutMs: 10, ...options.remote });
    t.after(async () => { await remote.closeAll().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, accounts, remote, spawns, displays, get probes() { return probes; } };
}
function vnc(f, index = 0) { return f.spawns.filter(row => row.args[0] !== '-storepasswd')[index]; }
async function until(check, timeout = 1000) {
    const end = Date.now() + timeout;
    while (!check()) { if (Date.now() >= end) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('opens only a verified loopback VNC and keeps credentials out of argv and status', async t => {
    const f = fixture(t);
    const opened = await f.remote.open('alpha');
    assert.equal(opened.profileId, 'alpha'); assert.equal(opened.password.length, 8);
    assert.equal(opened.path, `/api/accounts/alpha/remote/socket?session=${opened.sessionId}`);
    const store = f.spawns[0], server = vnc(f);
    assert.deepEqual(store.args.slice(0, 1), ['-storepasswd']);
    assert.equal(store.child.input, `${opened.password}\n${opened.password}\ny\n`);
    assert.equal(store.args.includes(opened.password), false); assert.equal(server.args.includes(opened.password), false);
    assert.equal(server.config.stdio.every(item => item === 'ignore'), true);
    assert.equal(server.args[server.args.indexOf('-listen') + 1], '127.0.0.1');
    for (const flag of ['-localhost', '-no6', '-rfbauth', '-nosel', '-notightfilexfer', '-noremote', '-safer', '-nocmds', '-noshm']) assert.equal(server.args.includes(flag), true);
    for (const flag of ['-nopw', '-tightfilexfer', '-ultrafilexfer', '-permitfiletransfer', '-nosharedmem']) assert.equal(server.args.includes(flag), false);
    assert.equal(server.config.env.DISPLAY, ':120');
    for (const key of ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) assert.equal(server.config.env[key].startsWith(f.root + path.sep), true);
    const record = f.remote.get('alpha', opened.sessionId);
    assert.equal(record.secret, opened.password); assert.equal(record.accountPid, 101); assert.equal(record.port, 30000);
    assert.equal(fs.statSync(record.passwordFile).size, 8);
    if (process.platform !== 'win32') assert.equal(fs.statSync(record.passwordFile).mode & 0o777, 0o600);
    const status = JSON.stringify(f.remote.status('alpha'));
    assert.equal(status.includes(opened.password), false); assert.equal(status.includes('30000'), false);
    assert.equal(f.probes, 1);
});

test('same-account concurrent opens serialize and reuse a live session', async t => {
    const f = fixture(t);
    const [a, b] = await Promise.all([f.remote.open('alpha'), f.remote.open('alpha')]);
    assert.equal(a.sessionId, b.sessionId); assert.equal(f.spawns.length, 2);
});

test('accounts isolate ports, passwords, displays and closing connections', async t => {
    const f = fixture(t);
    const [a, b] = await Promise.all([f.remote.open('alpha'), f.remote.open('beta')]);
    const ra = f.remote.get('alpha', a.sessionId), rb = f.remote.get('beta', b.sessionId);
    assert.notEqual(ra.port, rb.port); assert.notEqual(a.password, b.password); assert.notEqual(ra.passwordFile, rb.passwordFile);
    assert.equal(ra.display, ':120'); assert.equal(rb.display, ':121');
    let wsClosed = 0, tcpClosed = 0, betaClosed = 0;
    ra.connections.add({ terminate() { wsClosed++; } }); ra.connections.add({ destroy() { tcpClosed++; } });
    rb.connections.add({ close() { betaClosed++; } });
    await f.remote.close('alpha');
    assert.equal(wsClosed, 1); assert.equal(tcpClosed, 1); assert.equal(betaClosed, 0);
    assert.equal(ra.secret, null); assert.equal(fs.existsSync(ra.passwordFile), false);
    assert.equal(f.remote.status('beta').active, true);
    assert.equal(f.accounts.processes.get('alpha').signals.length, 0); assert.equal(f.accounts.processes.get('beta').signals.length, 0);
});

test('session token and exact owned account generation are required for every get', async t => {
    const f = fixture(t), opened = await f.remote.open('alpha');
    assert.throws(() => f.remote.get('alpha', 'wrong'), { code: 'REMOTE_EXPIRED' });
    assert.throws(() => f.remote.get('beta', opened.sessionId), { code: 'REMOTE_EXPIRED' });
    f.accounts.processes.set('alpha', child(101));
    assert.throws(() => f.remote.get('alpha', opened.sessionId), { code: 'REMOTE_EXPIRED' });
    await until(() => f.remote.sessions.size === 0);
    assert.equal(vnc(f).child.signals.includes('SIGTERM'), true);
});

test('ready, stop and process exit each revoke the account remote desktop', async t => {
    for (const reason of ['ready', 'stop', 'exit']) {
        const f = fixture(t), opened = await f.remote.open('alpha');
        let closed = false; f.remote.get('alpha', opened.sessionId).connections.add({ terminate() { closed = true; } });
        if (reason === 'ready') f.accounts.healths.set('alpha', { ready: true, authorized: true });
        if (reason === 'stop') f.accounts.stopping.add('alpha');
        if (reason === 'exit') f.accounts.processes.get('alpha').emit('exit', 0);
        await until(() => closed);
        assert.equal(f.remote.status('alpha').active, false); assert.equal(vnc(f).child.signals.includes('SIGTERM'), true);
    }
});

test('remote access expires within its fixed lifetime without prolongation by repeated open', async t => {
    // Keep elapsed lifetime independent of startup filesystem/CPU latency.
    // The production clock hook lets us cross the exact expiry boundary after
    // the real open sequence has completed, without shortening its lifetime.
    let now = 1000000;
    const f = fixture(t, { remote: { now: () => now } });
    const opened = await f.remote.open('alpha');
    assert.equal(opened.expiresAt, now + 300000);
    now += 60000;
    const same = await f.remote.open('alpha'); assert.equal(same.expiresAt, opened.expiresAt);
    const record = f.remote.get('alpha', opened.sessionId);
    let closed = false; record.connections.add({ close() { closed = true; } });
    now = opened.expiresAt - 1;
    assert.equal(f.remote.get('alpha', opened.sessionId), record);
    now = opened.expiresAt;
    await until(() => closed);
    assert.throws(() => f.remote.get('alpha', opened.sessionId), { code: 'REMOTE_EXPIRED' });
    await until(() => !fs.existsSync(record.passwordFile));
});

test('remote startup requires a real RFB listener and cleans up on timeout', async t => {
    const f = fixture(t, { listens: false });
    await assert.rejects(f.remote.open('alpha'), { code: 'REMOTE_UNAVAILABLE' });
    assert.equal(f.remote.sessions.size, 0); assert.equal(vnc(f).child.signals.includes('SIGTERM'), true);
    assert.equal(fs.readdirSync(path.join(f.accounts.location('alpha'), 'state')).length, 0);
    assert.ok(f.probes >= 1);
});

test('password helper failure cannot spawn VNC or leave credential artifacts', async t => {
    const f = fixture(t, { storeFailure: true });
    await assert.rejects(f.remote.open('alpha'), { code: 'REMOTE_UNAVAILABLE' });
    assert.equal(f.spawns.length, 1); assert.equal(f.remote.sessions.size, 0);
    assert.equal(fs.readdirSync(path.join(f.accounts.location('alpha'), 'state')).length, 0);
});

test('close during password generation cancels pending startup and both queued opens', async t => {
    const f = fixture(t, { storeNeverExits: true });
    const first = f.remote.open('alpha'), second = f.remote.open('alpha');
    first.catch(() => {}); second.catch(() => {});
    await until(() => f.spawns.length === 1);
    await f.remote.close('alpha');
    await assert.rejects(first); await assert.rejects(second, { code: 'REMOTE_CANCELLED' });
    assert.equal(f.spawns.length, 1); assert.equal(f.remote.sessions.size, 0);
});

test('stubborn helper is killed by its own child handle and never signals QQ', async t => {
    const f = fixture(t), opened = await f.remote.open('alpha');
    const server = vnc(f).child;
    server.kill = signal => { server.signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => server.emit('exit', null, signal)); return true; };
    await f.remote.close('alpha');
    assert.deepEqual(server.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(f.accounts.processes.get('alpha').signals.length, 0);
    assert.throws(() => f.remote.get('alpha', opened.sessionId), { code: 'REMOTE_EXPIRED' });
});

test('display remains bound to running child after saved profile positions change', async t => {
    const f = fixture(t);
    f.accounts.document.profiles.splice(0, 1);
    const opened = await f.remote.open('beta');
    assert.equal(f.remote.get('beta', opened.sessionId).display, ':121');
    assert.equal(vnc(f).config.env.DISPLAY, ':121');
});

test('unverified displays, stopped accounts and already-ready accounts never spawn helpers', async t => {
    const f = fixture(t); f.displays.set('alpha', ':0');
    await assert.rejects(f.remote.open('alpha'), { code: 'REMOTE_UNAVAILABLE' });
    f.accounts.get('alpha').desired = 'stopped';
    await assert.rejects(f.remote.open('alpha'), { code: 'NOT_READY' });
    f.accounts.get('alpha').desired = 'running'; f.accounts.healths.set('alpha', { ready: true, authorized: true });
    await assert.rejects(f.remote.open('alpha'), { code: 'ALREADY_READY' });
    assert.equal(f.spawns.length, 0);
});

test('default readiness probe accepts an RFB banner instead of arbitrary TCP survival', async t => {
    const f = fixture(t, { remote: { probe: undefined, startTimeoutMs: 150 } });
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('RFB 003.008\n'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    f.remote.allocatePort = async () => server.address().port;
    const opened = await f.remote.open('alpha'); assert.equal(f.remote.status('alpha').active, true);
    await f.remote.close('alpha'); assert.throws(() => f.remote.get('alpha', opened.sessionId), { code: 'REMOTE_EXPIRED' });
});

async function delayedRfbServer(t, connected) {
    const sockets = new Set(), timers = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket); socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
        const later = (callback, delay) => {
            const timer = setTimeout(() => { timers.delete(timer); if (!socket.destroyed) callback(); }, delay);
            timers.add(timer); return timer;
        };
        connected(socket, later);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

test('default readiness probe waits for a delayed native RFB banner', async t => {
    const f = fixture(t, { remote: { probe: undefined, startTimeoutMs: 2000 } });
    const port = await delayedRfbServer(t, (socket, later) => later(() => socket.end('RFB 003.008\n'), 650));
    f.remote.allocatePort = async () => port;
    const opened = await f.remote.open('alpha');
    assert.equal(f.remote.get('alpha', opened.sessionId).listening, true);
    await f.remote.close('alpha');
    assert.equal(vnc(f).child.signals.includes('SIGTERM'), true);
});

test('default readiness probe assembles a fragmented RFB banner', async t => {
    const f = fixture(t, { remote: { probe: undefined, startTimeoutMs: 2000 } });
    const port = await delayedRfbServer(t, (socket, later) => {
        later(() => socket.write('RFB '), 40);
        later(() => socket.write('003.'), 180);
        later(() => socket.end('008\n'), 350);
    });
    f.remote.allocatePort = async () => port;
    const opened = await f.remote.open('alpha');
    assert.equal(f.remote.get('alpha', opened.sessionId).listening, true);
});

for (const mode of ['silent', 'trickle']) {
    test(`default readiness probe keeps the startup deadline for a ${mode} non-RFB listener`, async t => {
        const budget = 600;
        const f = fixture(t, { remote: { probe: undefined, startTimeoutMs: budget } });
        const port = await delayedRfbServer(t, (socket, later) => {
            if (mode !== 'trickle') return;
            const send = () => { socket.write('R'); later(send, 100); };
            later(send, 100);
        });
        f.remote.allocatePort = async () => port;
        const started = performance.now();
        await assert.rejects(f.remote.open('alpha'), { code: 'REMOTE_UNAVAILABLE' });
        const elapsed = performance.now() - started;
        assert.ok(elapsed < budget + 400, `startup exceeded its overall deadline: ${Math.round(elapsed)}ms`);
        assert.equal(f.remote.sessions.size, 0);
        assert.equal(f.remote.ports.size, 0);
        assert.equal(vnc(f).child.signals.includes('SIGTERM'), true);
        assert.equal(fs.readdirSync(path.join(f.accounts.location('alpha'), 'state')).length, 0);
    });
}

test('closeAll revokes every connection and disallows subsequent starts', async t => {
    const f = fixture(t); const a = await f.remote.open('alpha'), b = await f.remote.open('beta');
    let closed = 0;
    f.remote.get('alpha', a.sessionId).connections.add({ close() { closed++; } });
    f.remote.get('beta', b.sessionId).connections.add({ close() { closed++; } });
    await f.remote.closeAll();
    assert.equal(closed, 2); assert.equal(f.remote.sessions.size, 0);
    await assert.rejects(f.remote.open('alpha'), { code: 'REMOTE_CANCELLED' });
});

test('even a duplicated ephemeral port allocation cannot expose another account desktop', async t => {
    const f = fixture(t, { remote: { allocatePort: async () => 30000 } });
    const opened = await f.remote.open('alpha');
    await assert.rejects(f.remote.open('beta'), { code: 'REMOTE_UNAVAILABLE' });
    assert.equal(f.remote.get('alpha', opened.sessionId).port, 30000);
    assert.equal(f.remote.status('alpha').active, true); assert.equal(f.remote.status('beta').active, false);
    assert.equal(f.spawns.filter(row => row.args[0] !== '-storepasswd').length, 1);
});
