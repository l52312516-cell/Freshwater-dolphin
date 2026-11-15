'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { ReverseWebSocket } = require('../src/onebot/ws.cjs');
const { MAX_ACTION_BYTES } = require('../src/onebot/limits.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, { action = async r => ({ status: 'ok', retcode: 0, data: r.params, echo: r.echo }), ...options } = {}) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const network = new ReverseWebSocket({ config: { url: 'ws://127.0.0.1:' + server.address().port + '/ws', token: 'test-only',
        heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 10, reconnectMaxMs: 50 },
        action, status: async () => ({ ready: true, online: null }), ...options });
    t.after(async () => { await network.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
    return { server, network };
}

test('Universal handshake, array events and falsy echo share the same connection', async t => {
    const { server, network } = await fixture(t);
    const connected = once(server, 'connection');
    network.start('12345');
    const [socket, request] = await connected;
    assert.equal(request.headers['x-self-id'], '12345');
    assert.equal(request.headers['x-client-role'], 'Universal');
    assert.equal(request.headers.authorization, 'Bearer test-only');
    const messages = [];
    socket.on('message', bytes => messages.push(JSON.parse(bytes)));
    await pause(30);
    assert.equal(messages[0].meta_event_type, 'lifecycle');
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: false }));
    await pause(30);
    assert.equal(messages[1].echo, false);
    network.event({ post_type: 'message', message: [{ type: 'text', data: { text: '保留 空白\n' } }] });
    await pause(30);
    assert.ok(Array.isArray(messages[2].message));
});

test('reverse WS accepts media-sized actions with echo and closes frames above the action limit', { timeout: 15000 }, async t => {
    const calls = [];
    const { server, network } = await fixture(t, { action: async request => {
        const length = request.params.message[0].data.file.length;
        calls.push({ action: request.action, length });
        return { status: 'ok', retcode: 0, data: { length }, echo: request.echo };
    } });
    const connected = once(server, 'connection');
    network.start('12345');
    const [socket] = await connected;
    socket.on('error', () => {});
    const records = [];
    socket.on('message', bytes => records.push(JSON.parse(bytes)));
    const file = 'base64://' + 'A'.repeat(1024 * 1024 + 64);
    const echo = { transport: 'reverse-ws', sequence: false };
    const request = { action: 'send_group_msg', params: { group_id: 12345,
        message: [{ type: 'image', data: { file } }] }, echo };
    const body = JSON.stringify(request);
    assert.ok(Buffer.byteLength(body) > 1024 * 1024);
    socket.send(body);
    for (let attempt = 0; attempt < 400 && !records.some(item => item.status === 'ok'); attempt++) await pause(5);
    const result = records.find(item => item.status === 'ok');
    assert.ok(result, 'Large action must reach the action handler');
    assert.deepEqual(result.echo, echo);
    assert.equal(result.data.length, file.length);
    const closed = once(socket, 'close');
    request.params.message[0].data.file = 'base64://' + 'A'.repeat(MAX_ACTION_BYTES);
    socket.send(JSON.stringify(request));
    assert.equal((await closed)[0], 1009);
    assert.equal(calls.length, 1);
});

test('reverse WS keeps one MiB event and two MiB backpressure bounds', async t => {
    const diagnostics = [];
    const { network } = await fixture(t, { logger: (event, data) => diagnostics.push({ event, data }) });
    const event = { payload: '' };
    event.payload = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(event)));
    network.event(event);
    assert.equal(network.queueBytes, 1024 * 1024);
    network.event({ payload: event.payload + 'x' });
    assert.equal(network.queue.length, 1);
    assert.equal(network.queueBytes, 1024 * 1024);
    assert.ok(diagnostics.some(item => item.event === 'outbound_event_too_large'));

    let sent = 0, terminated = 0;
    network.socket = { readyState: 1, bufferedAmount: 2 * 1024 * 1024,
        send: () => { sent++; }, terminate: () => { terminated++; } };
    assert.equal(network.send({ example: 1 }), true);
    assert.equal(sent, 1);
    network.socket.bufferedAmount++;
    assert.equal(network.send({ example: 2 }), false);
    assert.equal(sent, 1);
    assert.equal(terminated, 1);
    assert.ok(diagnostics.some(item => item.event === 'websocket_backpressure'));
});

test('events buffer while disconnected and flush on reconnect', async t => {
    const { server, network } = await fixture(t);
    network.event({ example: 1 });
    network.start('12345'); // start clears events belonging to any previous account
    network.event({ example: 2 });
    const [socket] = await once(server, 'connection');
    const records = [];
    socket.on('message', value => records.push(JSON.parse(value)));
    await pause(50);
    assert.ok(records.some(item => item.example === 2));
    assert.ok(!records.some(item => item.example === 1));
    const next = once(server, 'connection');
    socket.terminate();
    await pause(5);
    network.event({ example: 3 });
    const [replacement] = await next;
    const restored = [];
    replacement.on('message', value => restored.push(JSON.parse(value)));
    await pause(30);
    assert.ok(restored.some(item => item.example === 3));
});

test('late action result never leaks into the replacement socket', async t => {
    let finish;
    const { server, network } = await fixture(t, { action: () => new Promise(resolve => { finish = resolve; }) });
    const first = once(server, 'connection'); network.start('12345');
    const [socket] = await first;
    socket.send(JSON.stringify({ action: 'send_private_msg', echo: 'old' }));
    for (let tries = 0; !finish && tries < 100; tries++) await pause(5);
    assert.equal(typeof finish, 'function');
    const next = once(server, 'connection'); socket.terminate();
    const [replacement] = await next;
    const records = [];
    replacement.on('message', value => records.push(JSON.parse(value)));
    await pause(30);
    finish({ status: 'ok', retcode: 0, echo: 'old' });
    await pause(30);
    assert.ok(!records.some(item => item.echo === 'old'));
});

test('reconnection expires events by their original message time instead of restarting the age at buffering', { timeout: 10000 }, async t => {
    const diagnostics = [];
    const { server, network } = await fixture(t, { maxAgeMs: 2000, logger: (event, data) => diagnostics.push({ event, data }) });
    network.config.reconnectMinMs = 1300;
    network.config.reconnectMaxMs = 1300;
    const first = once(server, 'connection');
    network.start('12345');
    const [socket] = await first;
    await pause(30);
    const disconnected = once(network, 'connection');
    const replaced = once(server, 'connection');
    socket.terminate();
    assert.deepEqual(await disconnected, [false]);
    network.event({ post_type: 'message', self_id: 12345, time: Math.floor(Date.now() / 1000) - 1,
        message: [{ type: 'text', data: { text: 'already-aged-before-buffering' } }] });
    assert.equal(network.queue.length, 1);
    const [replacement] = await replaced;
    const records = [];
    replacement.on('message', value => records.push(JSON.parse(value)));
    await pause(50);
    assert.equal(network.queue.length, 0);
    assert.equal(network.queueBytes, 0);
    assert.ok(!records.some(item => item.message?.[0]?.data.text === 'already-aged-before-buffering'));
    assert.ok(diagnostics.some(item => item.event === 'outbound_event_expired'));
    network.event({ post_type: 'message', self_id: 12345, time: Math.floor(Date.now() / 1000),
        message: [{ type: 'text', data: { text: 'fresh-after-reconnection' } }] });
    await pause(30);
    assert.ok(records.some(item => item.message?.[0]?.data.text === 'fresh-after-reconnection'));
});

test('WS rejects old or invalid timestamped events and prunes out-of-order original timestamps', async t => {
    const diagnostics = [];
    const { network } = await fixture(t, { maxAgeMs: 2000, logger: (event, data) => diagnostics.push({ event, data }) });
    const now = Math.floor(Date.now() / 1000);
    network.event({ time: now - 10, example: 'expired' });
    network.event({ time: 'not-a-time', example: 'invalid' });
    network.event({ time: now + 32, example: 'future' });
    assert.equal(network.queue.length, 0);
    network.event({ time: now, example: 'newer-first' });
    network.event({ time: now - 1, example: 'older-second' });
    assert.equal(network.queue.length, 2);
    // Simulate the older item expiring after insertion without relying on a
    // global clock patch or delaying the test for a minute.
    network.queue[1].at = Date.now() - 3000;
    network.prune();
    assert.deepEqual(network.queue.map(item => item.value.example), ['newer-first']);
    assert.equal(network.queueBytes, network.queue[0].bytes);
    assert.ok(diagnostics.some(item => item.event === 'outbound_event_invalid_time'));
    assert.ok(diagnostics.some(item => item.event === 'outbound_event_future_time'));
});
