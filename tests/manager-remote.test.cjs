'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');
const { createManager } = require('../src/manager/server.cjs');

async function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-remote-'));
    const tcp = net.createServer(socket => { socket.write('RFB 003.008\n'); socket.on('data', value => socket.write(value)); });
    await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
    const record = { sessionId: 'private-session', profileId: 'one', port: tcp.address().port, password: 'private-password', connections: new Set() };
    let active = false;
    const remote = {
        async open(id) { if (id !== 'one') throw Object.assign(new Error('Unknown account'), { statusCode: 404 }); active = true;
            return { sessionId: record.sessionId, profileId: id, path: '/api/accounts/one/remote/socket?session=' + record.sessionId, password: record.password, expiresAt: Date.now() + 300000 }; },
        get(id, session) { if (!active || id !== record.profileId || session !== record.sessionId) throw Object.assign(new Error('Unknown session'), { statusCode: 404 }); return record; },
        status() { return { active }; },
        async close() { active = false; for (const socket of [...record.connections]) { if (socket.terminate) socket.terminate(); else socket.destroy(); } },
        async closeAll() { await this.close(); }
    };
    const manager = await createManager({ root, remote, startAccounts: false }); manager.accounts.create({ id: 'one' });
    const origin = await manager.app.listen({ port: 0, host: '127.0.0.1' });
    t.after(async () => { await manager.close(); await new Promise(resolve => tcp.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const session = await manager.auth.bootstrap(fs.readFileSync(manager.auth.setup, 'utf8').trim(), 'administrator-password', 'test');
    const cookie = manager.auth.cookie(session.id, false).split(';')[0];
    const headers = { cookie, 'x-csrf-token': session.csrf };
    const api = (url, method = 'GET', extra = headers) => manager.app.inject({ url: '/api/accounts/one/remote' + url, method, headers: extra });
    return { manager, api, origin, headers, session, record };
}

function rejected(url, headers) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); });
        socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected remote connection')); });
        socket.on('error', () => {});
    });
}

test('remote desktop creation needs administrator CSRF and status never reveals credentials', async t => {
    const { api, headers } = await fixture(t);
    assert.equal((await api('/open', 'POST', {})).statusCode, 401);
    assert.equal((await api('/open', 'POST', { cookie: headers.cookie })).statusCode, 403);
    assert.equal((await api('/open', 'POST')).json().data.password, 'private-password');
    assert.equal(JSON.stringify((await api('')).json()).includes('private-password'), false);
    assert.equal((await api('', 'DELETE')).statusCode, 200);
});

test('remote WebSocket requires same origin, current administrator and exact account session', async t => {
    const { api, origin, headers } = await fixture(t); const opened = (await api('/open', 'POST')).json().data;
    const url = origin.replace('http:', 'ws:') + opened.path;
    assert.equal(await rejected(url, { Origin: origin }), 401);
    assert.equal(await rejected(url, { cookie: headers.cookie, Origin: 'https://foreign.invalid' }), 403);
    assert.equal(await rejected(url.replace('private-session', 'wrong-session'), { cookie: headers.cookie, Origin: origin }), 404);
    assert.equal(await rejected(url.replace('/one/', '/two/'), { cookie: headers.cookie, Origin: origin }), 404);
});

test('authenticated RFB binary stream forwards both directions and closes on administrator revocation', async t => {
    const { manager, api, origin, headers, session } = await fixture(t);
    const opened = (await api('/open', 'POST')).json().data;
    const socket = new WebSocket(origin.replace('http:', 'ws:') + opened.path, ['binary'], { headers: { cookie: headers.cookie, Origin: origin } });
    t.after(() => socket.terminate());
    const banner = await new Promise((resolve, reject) => { socket.once('message', (data, binary) => resolve({ data: data.toString(), binary })); socket.once('error', reject); });
    assert.deepEqual(banner, { data: 'RFB 003.008\n', binary: true });
    const echo = new Promise(resolve => socket.once('message', data => resolve(data.toString())));
    socket.send(Buffer.from('RFB-TEST')); assert.equal(await echo, 'RFB-TEST');
    const closed = new Promise(resolve => socket.once('close', resolve)); manager.auth.revoke(session.id); await closed;
});

test('remote cleanup failure still closes accounts and HTTP and releases manager ownership', async t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-remote-close-'));
    const calls = [], failure = new Error('Remote termination was not confirmed');
    const manager = await createManager({ root, startAccounts: false,
        remote: { async closeAll() { calls.push('remote'); throw failure; } } });
    let next;
    t.after(async () => {
        await manager.close().catch(() => {});
        if (next) await next.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const closeAccounts = manager.accounts.close.bind(manager.accounts);
    manager.accounts.close = async () => { calls.push('accounts'); await closeAccounts(); };
    manager.app.addHook('onClose', async () => { calls.push('http'); });
    await manager.app.listen({ port: 0, host: '127.0.0.1' });
    assert.equal(manager.app.server.listening, true);
    const owner = path.join(root, 'work/control/.adapter-owner.json');
    assert.equal(fs.existsSync(owner), true);

    await assert.rejects(manager.close(), error => error instanceof AggregateError && error.errors.includes(failure));

    assert.deepEqual(calls, ['remote', 'accounts', 'http']);
    assert.equal(manager.accounts.closing, true);
    assert.equal(manager.app.server.listening, false);
    assert.equal(fs.existsSync(owner), false);
    next = await createManager({ root, startAccounts: false });
    assert.equal(fs.existsSync(owner), true);
});
