'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createHmac } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { TransportHub, parameters } = require('../src/onebot/transports.cjs');
const { MAX_ACTION_BYTES } = require('../src/onebot/limits.cjs');
const { executeQuickOperation } = require('../src/onebot/quick-operation.cjs');
const { loadConfig, nodeConfig } = require('../src/config.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { EventEmitter } = require('node:events');
const { run } = require('../src/runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
    for (let attempt = 0; attempt < 400; attempt++) { if (predicate()) return; await pause(5); }
    assert.ok(predicate(), 'Expected asynchronous condition');
}

async function fixture(t, nodes, options = {}) {
    const calls = [];
    const action = options.action || (async (request, session) => {
        calls.push({ request, session });
        return { status: 'ok', retcode: 0, data: request.params, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
    });
    const diagnostics = [];
    const hub = new TransportHub({ config: { profileId: 'first', gatewayPort: 0, eventBufferSize: 1000,
        eventMaxAgeMs: 60000, nodes: nodes.map((item, index) => nodeConfig({ ...item, heartbeatMs: 5000 }, index)) },
        action, status: async () => ({ ready: true, online: null }), logger: (event, data) => diagnostics.push({ event, data }),
        authorization: options.authorization || (() => true), managementToken: options.managementToken,
        capabilities: options.capabilities });
    await hub.open();
    hub.start('11111', 'epoch-one');
    t.after(() => hub.close());
    return { hub, calls, diagnostics, base: 'http://127.0.0.1:' + hub.port + '/onebot/first/',
        websocket: 'ws://127.0.0.1:' + hub.port + '/onebot/first/' };
}

test('HTTP nodes parse GET, JSON and form booleans, preserve false echo and use independent tokens', async t => {
    const { base, calls } = await fixture(t, [
        { id: 'a', type: 'httpApi', token: 'alpha' }, { id: 'b', type: 'httpApi', token: 'beta' }
    ]);
    const get = await fetch(base + 'a/get_stranger_info?user_id=12345&no_cache=false&echo=false', { headers: { Authorization: 'Bearer alpha' } });
    assert.deepEqual(await get.json(), { status: 'ok', retcode: 0, data: { user_id: 12345, no_cache: false }, echo: false });
    const form = await fetch(base + 'b/send_group_msg', { method: 'POST', headers: { Authorization: 'Bearer beta', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ group_id: '12345', message: '空 格\n', auto_escape: 'true', echo: '0' }) });
    assert.equal((await form.json()).echo, 0);
    assert.deepEqual(calls[1].request.params, { group_id: 12345, message: '空 格\n', auto_escape: true });
    const json = await fetch(base + 'a', { method: 'POST', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send_msg', params: { message: [{ type: 'text', data: { text: '原样' } }] }, echo: null }) });
    assert.equal((await json.json()).echo, null);
    assert.deepEqual(calls[0].session, { uin: '11111', epoch: 'epoch-one' });
    assert.equal((await fetch(base + 'b/get_status', { headers: { Authorization: 'Bearer alpha' } })).status, 401);
    assert.equal((await fetch(base + 'a/get_status?access_token=alpha', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(base.replace('/first/', '/other/') + 'a/get_status')).status, 404);
    assert.equal((await fetch(base + 'a/get_status?user_id=1&user_id=2', { headers: { Authorization: 'Bearer alpha' } })).status, 400);
    assert.equal(calls.length, 3);
});

test('HTTP query parsing preserves numeric message text and long opaque request handles', () => {
    const parsed = parameters(new URLSearchParams({ message: '12345', flag: '12345678901234567890', user_id: '12345', no_cache: 'false', echo: 'null' }));
    assert.equal(parsed.message, '12345');
    assert.equal(parsed.flag, '12345678901234567890');
    assert.equal(parsed.user_id, 12345);
    assert.equal(parsed.no_cache, false);
    assert.equal(parsed.echo, null);
});

test('HTTP and forward WS actions accept media-sized frames while HTTP enforces the action limit', { timeout: 15000 }, async t => {
    const received = [];
    const managementToken = 'independent-management-secret-with-32-bytes';
    const { base, websocket } = await fixture(t, [{ id: 'api', type: 'httpApi' }, { id: 'socket', type: 'wsServer' }], {
        managementToken: () => managementToken,
        action: async request => {
            const length = request.params.message[0].data.file.length;
            received.push({ action: request.action, length, echo: request.echo });
            return { status: 'ok', retcode: 0, data: { length }, echo: request.echo };
        }
    });
    const file = 'base64://' + 'A'.repeat(1024 * 1024 + 64);
    const request = echo => ({ action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'image', data: { file } }] }, echo });
    const echo = { transport: 'http', sequence: 0 };
    const body = JSON.stringify(request(echo));
    assert.ok(Buffer.byteLength(body) > 1024 * 1024);
    const response = await fetch(base + 'api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', retcode: 0, data: { length: file.length }, echo });
    const internal = await fetch(new URL('/internal/action', base), { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + managementToken }, body: JSON.stringify(request(false)) });
    assert.equal(internal.status, 200);
    assert.deepEqual((await internal.json()).echo, false);

    const socket = new WebSocket(websocket + 'socket');
    const records = [];
    socket.on('message', bytes => records.push(JSON.parse(bytes)));
    await once(socket, 'open');
    t.after(() => socket.terminate());
    socket.send(JSON.stringify(request({ transport: 'forward-ws', sequence: null })));
    await until(() => records.some(item => item.status === 'ok'));
    const result = records.find(item => item.status === 'ok');
    assert.deepEqual(result.echo, { transport: 'forward-ws', sequence: null });
    assert.equal(result.data.length, file.length);
    assert.deepEqual(received.map(item => item.length), [file.length, file.length, file.length]);

    const tooLarge = request('too-large');
    tooLarge.params.message[0].data.file = 'base64://' + 'A'.repeat(MAX_ACTION_BYTES);
    const rejected = await fetch(base + 'api', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tooLarge) });
    assert.equal(rejected.status, 413);
    assert.equal((await rejected.json()).status, 'failed');
    assert.equal(received.length, 3);
});

test('pending action health aggregates public, internal and quick operations until they actually settle', async t => {
    const releases = [];
    const { hub } = await fixture(t, [{ id: 'api', type: 'httpApi', quickOperations: true }], {
        action: () => new Promise(resolve => releases.push(resolve))
    });
    assert.equal(hub.pendingActions, 0);
    const node = hub.nodes.get('api'), session = { ...hub.session };
    const publicAction = hub.dispatch(node, { action: 'get_login_info' }, session);
    const internalAction = hub.dispatch(hub.internalNode, { action: 'get_login_info' }, session);
    const quickAction = hub.quick(node, { post_type: 'request', request_type: 'friend', flag: 'opaque' }, { approve: true }, session);
    await until(() => releases.length === 3);
    assert.equal(hub.pendingActions, 3);
    hub.stop();
    assert.equal(hub.pendingActions, 3);
    for (const release of releases) release({ status: 'ok', retcode: 0, data: null });
    await Promise.all([publicAction, internalAction, quickAction]);
    assert.equal(hub.pendingActions, 0);
});

test('forward WS separates Universal, API and Event roles and never cross-routes account sessions', async t => {
    const { hub, calls, websocket } = await fixture(t, [{ id: 'socket', type: 'wsServer', token: 'socket-token' }]);
    const open = async suffix => {
        const socket = new WebSocket(websocket + 'socket' + suffix + '?access_token=socket-token');
        const records = [];
        socket.on('message', data => records.push(JSON.parse(data)));
        await once(socket, 'open');
        t.after(() => socket.terminate());
        return { socket, records };
    };
    const universal = await open('');
    const api = await open('/api');
    const events = await open('/event');
    await until(() => universal.records.length && events.records.length);
    assert.equal(api.records.length, 0);
    api.socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: false }));
    await until(() => api.records.some(item => item.echo === false));
    hub.event({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'hello' } }] });
    await until(() => events.records.some(item => item.post_type === 'message'));
    assert.equal(universal.records.filter(item => item.post_type === 'message').length, 1);
    assert.equal(api.records.filter(item => item.post_type === 'message').length, 0);
    const closed = once(events.socket, 'close');
    events.socket.send(JSON.stringify({ action: 'send_msg', params: {} }));
    assert.equal((await closed)[0], 1008);
    assert.equal(calls.length, 1);
    const universalClosed = once(universal.socket, 'close');
    hub.start('22222', 'epoch-two');
    await universalClosed;
    assert.equal(hub.session.uin, '22222');
});

test('forward WS rejects a wrong token before accepting the connection', async t => {
    const { websocket, calls } = await fixture(t, [{ id: 'socket', type: 'wsServer', token: 'correct' }]);
    const socket = new WebSocket(websocket + 'socket?access_token=incorrect');
    socket.on('error', () => {});
    const [request, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, 401);
    response.resume();
    request.destroy();
    socket.terminate();
    assert.equal(calls.length, 0);
});

test('HTTP node concurrency limits are independent and revoke immediately before the next request', async t => {
    let finish, allowed = true;
    const { base } = await fixture(t, [{ id: 'slow', type: 'httpApi', maxPending: 1 }, { id: 'other', type: 'httpApi' }], {
        authorization: () => allowed,
        action: request => request.action === 'slow' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ status: 'ok', retcode: 0, data: null })
    });
    const pending = fetch(base + 'slow/slow');
    await until(() => finish);
    assert.equal((await (await fetch(base + 'slow/get_status')).json()).retcode, 1503);
    assert.equal((await (await fetch(base + 'other/get_status')).json()).status, 'ok');
    allowed = false;
    assert.equal((await (await fetch(base + 'other/get_status')).json()).retcode, 1503);
    finish({ status: 'ok', retcode: 0, data: null });
    await pending;
});

test('node token bucket rate limits a burst without blocking another node', async t => {
    const { base, calls } = await fixture(t, [{ id: 'limited', type: 'httpApi', burst: 1, ratePerSecond: 1 }, { id: 'other', type: 'httpApi' }]);
    assert.equal((await (await fetch(base + 'limited/get_status')).json()).status, 'ok');
    assert.equal((await (await fetch(base + 'limited/get_status')).json()).retcode, 1503);
    assert.equal((await (await fetch(base + 'other/get_status')).json()).status, 'ok');
    assert.equal(calls.length, 2);
});

test('internal management endpoints require the live independent header credential', async t => {
    let token = 'management-secret-with-at-least-32-bytes';
    const { base, calls } = await fixture(t, [{ id: 'public', type: 'httpApi', token: 'public-token' }], {
        managementToken: () => token, capabilities: async () => ({ actions: ['get_status'] })
    });
    const internal = new URL('/internal/action', base).href;
    const request = (key, suffix = '') => fetch(internal + suffix, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_status', params: {}, echo: false }) });
    assert.equal((await request('public-token')).status, 401);
    assert.equal((await request(token, '?access_token=' + token)).status, 401);
    assert.equal((await (await request(token)).json()).echo, false);
    const capabilities = await fetch(new URL('/internal/capabilities', base), { headers: { Authorization: 'Bearer ' + token } });
    assert.deepEqual((await capabilities.json()).data, { actions: ['get_status'] });
    const old = token;
    token = 'new-management-secret-with-32-bytes';
    assert.equal((await request(old)).status, 401);
    assert.equal(calls.length, 1);
});

test('HTTP event reports sign exact bytes and preserve CQ parsing when adding at_sender', async t => {
    const reports = [];
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        reports.push({ body, headers: request.headers });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.parse(body).post_type === 'message' ? JSON.stringify({ reply: '[CQ:reply,id=42] 保留\n', at_sender: true }) : '{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const { hub, calls } = await fixture(t, [{ id: 'post', type: 'httpPost', url: 'http://127.0.0.1:' + server.address().port, token: 'hmac-secret', quickOperations: true }]);
    hub.event({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message_type: 'group',
        group_id: 12345, user_id: 22222, message_id: 42, message: [] });
    await until(() => calls.length);
    const report = reports.find(item => JSON.parse(item.body).post_type === 'message');
    assert.equal(report.headers['x-self-id'], '11111');
    assert.equal(report.headers['x-signature'], 'sha1=' + createHmac('sha1', 'hmac-secret').update(report.body).digest('hex'));
    assert.deepEqual(calls[0].request.params.message, [
        { type: 'at', data: { qq: '22222' } }, { type: 'reply', data: { id: '42' } }, { type: 'text', data: { text: ' 保留\n' } }
    ]);
});

test('HTTP reporting keeps events and quick-operation responses at one MiB', async t => {
    let messages = 0;
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        response.setHeader('Content-Type', 'application/json');
        if (JSON.parse(body).post_type === 'message') {
            messages++;
            response.end(JSON.stringify({ reply: 'x'.repeat(1024 * 1024) }));
        } else response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const { hub, calls, diagnostics } = await fixture(t, [{ id: 'post', type: 'httpPost',
        url: 'http://127.0.0.1:' + server.address().port, quickOperations: true }]);
    const event = { post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000),
        message_type: 'private', user_id: 22222, message: [] };
    hub.event(event);
    await until(() => diagnostics.some(item => item.event === 'node_http_post_failed'));
    assert.equal(messages, 1);
    assert.equal(calls.length, 0);
    hub.event({ ...event, message: [{ type: 'text', data: { text: 'x'.repeat(1024 * 1024) } }] });
    assert.ok(diagnostics.some(item => item.event === 'node_outbound_event_too_large'));
    await pause(20);
    assert.equal(messages, 1);
    assert.equal(hub.nodes.get('post').queueBytes, 0);
});

test('forward WS keeps its two MiB backpressure threshold', async t => {
    const { hub } = await fixture(t, [{ id: 'socket', type: 'wsServer' }]);
    let sent = 0, terminated = 0;
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 2 * 1024 * 1024,
        send: () => { sent++; }, terminate: () => { terminated++; } };
    hub.sendClient(socket, { post_type: 'message' });
    assert.equal(sent, 1);
    assert.equal(terminated, 0);
    socket.bufferedAmount++;
    hub.sendClient(socket, { post_type: 'message' });
    assert.equal(sent, 1);
    assert.equal(terminated, 1);
});

test('HTTP post timeout is terminal and never retries the same event', async t => {
    let messages = 0;
    const sockets = new Set();
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (JSON.parse(body).post_type === 'message') { messages++; return; }
        response.end('{}');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    const { hub, diagnostics } = await fixture(t, [{ id: 'post', type: 'httpPost', url: 'http://127.0.0.1:' + server.address().port, timeoutMs: 100 }]);
    hub.event({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message_type: 'private', user_id: 22222, message: [] });
    await until(() => diagnostics.some(item => item.event === 'node_http_post_failed'));
    await pause(200);
    assert.equal(messages, 1);
});

test('each HTTP reporting node has an independent bounded queue and switching account discards it', async t => {
    let held;
    const sockets = new Set();
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (JSON.parse(body).post_type === 'message') held = response;
        else response.end('{}');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    const { hub, diagnostics } = await fixture(t, [{ id: 'post', type: 'httpPost', eventBufferSize: 2, url: 'http://127.0.0.1:' + server.address().port }]);
    const event = index => ({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message_type: 'private', user_id: 22222, message_id: index });
    hub.event(event(0));
    await until(() => held);
    for (let index = 1; index <= 5; index++) hub.event(event(index));
    const node = hub.nodes.get('post');
    assert.deepEqual(node.queue.map(item => item.event.message_id), [4, 5]);
    assert.ok(diagnostics.some(item => item.event === 'node_outbound_event_gap'));
    hub.start('33333', 'epoch-new');
    assert.ok(node.queue.every(item => item.session.uin === '33333'));
    assert.ok(!node.queue.some(item => item.event.post_type === 'message'));
});

test('delayed HTTP quick response cannot send after authorization is revoked', async t => {
    let waiting, allowed = true;
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (JSON.parse(body).post_type === 'message') waiting = response;
        else response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const { hub, calls } = await fixture(t, [{ id: 'post', type: 'httpPost', url: 'http://127.0.0.1:' + server.address().port, quickOperations: true }], { authorization: () => allowed });
    hub.event({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message_type: 'private', user_id: 22222, message: [] });
    await until(() => waiting);
    allowed = false;
    waiting.end(JSON.stringify({ reply: 'must not send' }));
    await pause(60);
    assert.equal(calls.length, 0);
});

test('HTTP signing secret survives config normalization and a disabled quick-operation policy has no effects', async t => {
    let signature, body;
    const server = http.createServer(async (request, response) => {
        let bytes = ''; for await (const chunk of request) bytes += chunk;
        if (JSON.parse(bytes).post_type === 'message') { signature = request.headers['x-signature']; body = bytes; }
        response.setHeader('Content-Type', 'application/json'); response.end('{"reply":"must not send"}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const { hub, calls } = await fixture(t, [{ id: 'post', type: 'httpPost', url: 'http://127.0.0.1:' + server.address().port,
        token: 'api-token', secret: 'different-hmac-secret', quickOperations: false }]);
    hub.event({ post_type: 'message', self_id: 11111, time: Math.floor(Date.now() / 1000), message_type: 'private', user_id: 22222, message: [] });
    await until(() => signature);
    assert.equal(signature, 'sha1=' + createHmac('sha1', 'different-hmac-secret').update(body).digest('hex'));
    await pause(20); assert.equal(calls.length, 0);
});

test('quick operation has standard defaults, validates all flags before sending, and propagates failure', async () => {
    const calls = [];
    const invoke = async request => { calls.push(request); return { status: 'ok', retcode: 0 }; };
    const group = { post_type: 'message', message_type: 'group', user_id: 22222, group_id: 12345, message_id: -42 };
    await executeQuickOperation(group, { reply: '[CQ:at,qq=33333]', auto_escape: true }, invoke);
    assert.deepEqual(calls[0].params.message, [{ type: 'at', data: { qq: '22222' } }, { type: 'text', data: { text: '[CQ:at,qq=33333]' } }]);
    await assert.rejects(executeQuickOperation(group, { reply: 'hello', ban: 'true' }, invoke), { code: 'INVALID_REQUEST' });
    assert.equal(calls.length, 1);
    await executeQuickOperation(group, { delete: true, ban: true }, invoke);
    assert.equal(calls[1].action, 'delete_msg');
    assert.equal(calls[2].params.duration, 1800);
    await executeQuickOperation({ post_type: 'request', request_type: 'group', flag: 'opaque', sub_type: 'invite' }, { approve: false, reason: 'reason' }, invoke);
    assert.equal(calls[3].params.approve, false);
    await assert.rejects(executeQuickOperation(group, { reply: 'fails' }, async () => ({ status: 'failed', retcode: 1504 })), { code: 'ACTION_FAILED' });
});

test('hidden quick API rejects invented message targets before executing effects', async t => {
    const effects = [];
    const { base } = await fixture(t, [{ id: 'api', type: 'httpApi', quickOperations: true }], { action: async request => {
        if (request.action === 'get_msg') return { status: 'ok', retcode: 0, data: { message_type: 'group', group_id: 12345, sender: { user_id: 22222 } } };
        effects.push(request); return { status: 'ok', retcode: 0, data: null };
    } });
    const params = { context: { self_id: 11111, post_type: 'message', message_type: 'group', group_id: 99999, user_id: 22222, message_id: 1 }, operation: { reply: 'do not send' } };
    const response = await fetch(base + 'api/.handle_quick_operation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    assert.equal((await response.json()).retcode, 1400);
    assert.equal(effects.length, 0);
});

test('reverse WS API role sends its role header and suppresses business and lifecycle events', async t => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
    const connected = once(server, 'connection');
    const { hub, calls } = await fixture(t, [{ id: 'reverse', type: 'wsClient', role: 'Api', url: 'ws://127.0.0.1:' + server.address().port }]);
    const [socket, request] = await connected;
    assert.equal(request.headers['x-client-role'], 'Api');
    const records = [];
    socket.on('message', bytes => records.push(JSON.parse(bytes)));
    hub.event({ time: Math.floor(Date.now() / 1000), self_id: 11111, post_type: 'message', message: [] });
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 0 }));
    await until(() => records.length);
    assert.equal(records.length, 1);
    assert.equal(records[0].echo, 0);
    assert.equal(calls.length, 1);
});

function workspace(t, cleanup = true) {
    const root = fs.mkdtempSync(path.join(path.resolve(__dirname, '../work/temp'), 'transports-'));
    if (cleanup) t.after(() => fs.rmSync(root, { force: true, recursive: true }));
    return root;
}

test('config keeps the legacy reverse node and validates profile/node boundaries', t => {
    const root = workspace(t);
    const save = value => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(value));
    save({ reverseWs: { url: 'ws://127.0.0.1:6199/ws' } });
    const legacy = loadConfig({ root, env: {} });
    assert.equal(legacy.nodes[0].type, 'wsClient');
    assert.equal(legacy.reverseWs.id, 'legacy');
    assert.equal(legacy.actionTimeoutMs, 10000);
    assert.equal(legacy.mediaActionTimeoutMs, 60000);
    save({ nodes: [], mediaActionTimeoutMs: 5000 });
    assert.equal(loadConfig({ root, env: {} }).mediaActionTimeoutMs, 5000);
    for (const mediaActionTimeoutMs of [0, 60001, '60000']) {
        save({ nodes: [], mediaActionTimeoutMs });
        assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
    }
    save({ profileId: '../bad', nodes: [] });
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
    save({ profileId: 'first', nodes: [{ id: 'same', type: 'httpApi' }, { id: 'same', type: 'httpApi' }] });
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
    save({ nodes: [{ type: 'httpPost', url: 'http://name:secret@127.0.0.1/' }] });
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
    save({ profileId: 'first', expectedUin: '11111', nodes: [], healthFile: 'work/profiles/first/health.json', authorizationFile: '../outside.json' });
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
});

test('runtime reports real identity before authorization, enables on exact grant and revokes stale epochs', async t => {
    const root = workspace(t, false), healthFile = path.join(root, 'health.json'), authorizationFile = path.join(root, 'authorization.json');
    const backend = new EventEmitter();
    const state = { ready: true, online: true, epoch: 'epoch-one', readyAt: Date.now(),
        self: { uin: '11111', uid: 'u_self' }, capabilities: { messages: true } };
    backend.call = async method => {
        if (method === 'status') return structuredClone(state);
        throw new Error('Unexpected method');
    };
    const rpc = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    let app;
    t.after(async () => { if (app) await app.close(); await rpc.close(); fs.rmSync(root, { force: true, recursive: true }); });
    app = await run({ root, profileId: 'first', rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'), healthFile, authorizationFile,
        actionTimeoutMs: 1000, eventBufferSize: 1000, eventMaxAgeMs: 60000, gatewayPort: 0,
        nodes: [nodeConfig({ id: 'api', type: 'httpApi' }, 0)] }, () => {});
    const health = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    await until(() => health().selfId === '11111');
    assert.equal(health().activeActions, 0);
    assert.equal(health().selfUid, 'u_self');
    assert.equal(health().authorized, false);
    const url = 'http://127.0.0.1:' + health().gatewayPort + '/onebot/first/api/get_login_info';
    assert.equal((await (await fetch(url)).json()).retcode, 1503);
    fs.writeFileSync(authorizationFile, JSON.stringify({ profileId: 'first', uin: '11111', epoch: 'epoch-one' }));
    await until(() => health().connected);
    assert.equal((await (await fetch(url)).json()).data.user_id, 11111);
    state.epoch = 'epoch-two';
    await until(() => health().sessionEpoch === 'epoch-two');
    assert.equal(health().authorized, false);
    assert.equal((await (await fetch(url)).json()).retcode, 1503);
});
