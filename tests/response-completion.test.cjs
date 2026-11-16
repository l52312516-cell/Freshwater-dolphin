'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { responseCompletion } = require('../src/onebot/response-completion.cjs');
const { TransportHub } = require('../src/onebot/transports.cjs');
const { nodeConfig } = require('../src/config.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate()); }
async function fixture(t, nodes, action) {
    const hub = new TransportHub({ config: { profileId: 'callbacks', gatewayPort: 0, nodes: nodes.map((node, index) => nodeConfig({ role: 'Api', heartbeatMs: 5000, ...node }, index)) },
        status: async () => ({ ready: true, online: true }), managementToken: () => 'a'.repeat(43), action });
    await hub.open(); hub.start('12345', 'e1'); t.after(() => hub.close());
    return hub;
}

test('response callbacks settle once, abort cancels, and late registration cannot execute', async () => {
    const calls = [], controller = new AbortController(), completion = responseCompletion({ signal: controller.signal });
    completion.afterResponse(value => calls.push(value));
    await completion.settle(true); controller.abort(); await completion.settle(false);
    assert.deepEqual(calls, [true]); assert.throws(() => completion.afterResponse(() => {}), { code: 'EXPIRED' });
    const second = responseCompletion(); second.afterResponse(value => calls.push(value)); await second.settle(false); assert.deepEqual(calls, [true, false]);
    const aborted = new AbortController(); aborted.abort(); const third = responseCompletion({ signal: aborted.signal });
    assert.throws(() => third.afterResponse(() => {}), { code: 'EXPIRED' });
});

test('public and internal HTTP settle after finish, with failed actions cancelling their registration', async t => {
    const calls = [], order = [];
    const hub = await fixture(t, [{ id: 'http', type: 'httpApi' }], async (request, _session, options) => {
        options.afterResponse(value => { calls.push(value); order.push('callback'); });
        return { status: request.action === 'fail' ? 'failed' : 'ok', retcode: request.action === 'fail' ? 1500 : 0, data: null };
    });
    hub.server.prependListener('request', (_request, response) => response.once('finish', () => order.push('finish')));
    const base = 'http://127.0.0.1:' + hub.port;
    const success = await fetch(base + '/onebot/callbacks/http/ok'); assert.equal((await success.json()).status, 'ok');
    await until(() => calls.length === 1); assert.deepEqual(calls, [true]); assert.deepEqual(order.slice(0, 2), ['finish', 'callback']);
    const failed = await fetch(base + '/onebot/callbacks/http/fail'); assert.equal((await failed.json()).status, 'failed');
    await until(() => calls.length === 2); assert.deepEqual(calls, [true, false]);
    const internal = await fetch(base + '/internal/action', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + 'a'.repeat(43) }, body: JSON.stringify({ action: 'ok' }) });
    assert.equal((await internal.json()).status, 'ok'); await until(() => calls.length === 3); assert.deepEqual(calls, [true, false, true]);
});

test('HTTP disconnect cancels a reservation even if its action later returns success', async t => {
    const calls = []; let release, entered = false;
    const hub = await fixture(t, [{ id: 'http', type: 'httpApi' }], async (_request, _session, options) => {
        options.afterResponse(value => calls.push(value)); entered = true;
        await new Promise(resolve => { release = resolve; }); return { status: 'ok', retcode: 0, data: null };
    });
    const controller = new AbortController();
    const request = fetch('http://127.0.0.1:' + hub.port + '/onebot/callbacks/http/ok', { signal: controller.signal }).catch(() => {});
    await until(() => entered); controller.abort(); await request; await until(() => calls.length === 1); release(); await tick(); assert.deepEqual(calls, [false]);
});

test('forward WebSocket commits only after its original send callback and cancels a failed send', async t => {
    const calls = [], deferred = [];
    const hub = await fixture(t, [{ id: 'ws', type: 'wsServer' }], async (_request, _session, options) => {
        options.afterResponse(value => calls.push(value)); return { status: 'ok', retcode: 0, data: null };
    });
    const send = hub.sendClient.bind(hub);
    hub.sendClient = (socket, value, completed) => send(socket, value, success => deferred.push(() => completed(success)));
    const socket = new WebSocket('ws://127.0.0.1:' + hub.port + '/onebot/callbacks/ws'); await once(socket, 'open'); t.after(() => socket.terminate());
    const received = once(socket, 'message'); socket.send(JSON.stringify({ action: 'ok' })); await received;
    await until(() => deferred.length === 1); assert.deepEqual(calls, []); deferred.shift()(); await until(() => calls.length === 1); assert.deepEqual(calls, [true]);
    hub.sendClient = (_socket, _value, completed) => completed(false);
    socket.send(JSON.stringify({ action: 'ok' })); await until(() => calls.length === 2); assert.deepEqual(calls, [true, false]);
});

test('reverse WebSocket waits for send completion and cancels when its requesting connection closes', async t => {
    const remote = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(remote, 'listening'); const connected = once(remote, 'connection');
    const calls = [], deferred = [];
    const hub = await fixture(t, [{ id: 'reverse', type: 'wsClient', url: 'ws://127.0.0.1:' + remote.address().port, reconnectMinMs: 1000, reconnectMaxMs: 1000 }], async (_request, _session, options) => {
        options.afterResponse(value => calls.push(value)); return { status: 'ok', retcode: 0, data: null };
    });
    t.after(async () => { await hub.close(); for (const socket of remote.clients) socket.terminate(); await new Promise(resolve => remote.close(resolve)); });
    const [socket] = await connected, reverse = hub.nodes.get('reverse').socket, send = reverse.send.bind(reverse);
    reverse.send = (value, completed) => send(value, success => deferred.push(() => completed(success)));
    let received = once(socket, 'message'); socket.send(JSON.stringify({ action: 'ok' })); await received;
    await until(() => deferred.length === 1); assert.deepEqual(calls, []); deferred.shift()(); await until(() => calls.length === 1); assert.deepEqual(calls, [true]);
    received = once(socket, 'message'); socket.send(JSON.stringify({ action: 'ok' })); await received;
    await until(() => deferred.length === 1); socket.terminate(); await until(() => calls.length === 2); deferred.shift()(); await tick(); assert.deepEqual(calls, [true, false]);
});
