'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { MessageStore } = require('../src/onebot/store.cjs');
const { ReverseWebSocket } = require('../src/onebot/ws.cjs');
const { TransportHub } = require('../src/onebot/transports.cjs');
const { executeQuickOperation } = require('../src/onebot/quick-operation.cjs');
const { nodeConfig } = require('../src/config.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail('Expected asynchronous condition');
        await pause(5);
    }
}
function directory(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'audit-onebot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function record(msgId = '18446744073709551610', extra = {}) {
    return { chatType: 2, peerUid: '12345', msgId, msgSeq: '23', clientSeq: '24',
        senderUin: '22222', senderUid: 'u_sender', msgTime: '1794700000',
        elements: [{ elementType: 1, textElement: { content: '完整消息' } }], ...extra };
}
function failWrites(store) {
    const persist = store.persist;
    store.persist = () => { throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' }); };
    return () => { store.persist = persist; };
}

test('failed message persistence publishes no IDs, metadata replacements or cache evictions', t => {
    const root = directory(t), store = new MessageStore({ directory: root, maxMessages: 1 });
    const original = store.remember('11111', record());
    const saved = fs.readFileSync(path.join(root, '11111.json'), 'utf8');
    const restore = failWrites(store);
    assert.throws(() => store.remember('11111', record('new-native')), { code: 'EIO' });
    assert.equal(store.get('11111', original.id).record.elements[0].textElement.content, '完整消息');
    assert.equal(store.find('11111', { peer: original.locator.peer, nativeId: 'new-native' }), null);
    assert.throws(() => store.remember('11111', record(undefined, { msgSeq: '99' })), { code: 'EIO' });
    assert.equal(store.get('11111', original.id).locator.seq, '23');
    assert.equal(fs.readFileSync(path.join(root, '11111.json'), 'utf8'), saved);
    restore();
    assert.equal(store.remember('11111', record('next-native')).id, 2);
    assert.equal(new MessageStore({ directory: root }).get('11111', 2).locator.nativeId, 'next-native');
});

test('failed event and recall writes leave deduplication retryable and snapshots unchanged', t => {
    const root = directory(t), store = new MessageStore({ directory: root });
    const entry = store.remember('11111', record());
    const restore = failWrites(store);
    assert.throws(() => store.setEvent('11111', entry.id, { message_id: entry.id }, true), { code: 'EIO' });
    assert.equal(store.get('11111', entry.id).emitted, false);
    assert.equal(store.get('11111', entry.id).event, undefined);
    assert.throws(() => store.setRecalled('11111', entry.id, { message_id: entry.id }, true), { code: 'EIO' });
    assert.equal(store.get('11111', entry.id).recallEmitted, undefined);
    assert.equal(store.get('11111', entry.id).recalled, undefined);
    restore();
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => store.setRecalled('11111', entry.id, cycle, true), { code: 'INVALID_RESPONSE' });
    assert.equal(store.get('11111', entry.id).recalled, undefined);
    store.setEvent('11111', entry.id, { message_id: entry.id }, true);
    store.setRecalled('11111', entry.id, { message_id: entry.id }, true);
    const reopened = new MessageStore({ directory: root });
    assert.equal(reopened.get('11111', entry.id).emitted, true);
    assert.equal(reopened.get('11111', entry.id).recallEmitted, true);
});

test('message history staging publishes every updated draft only after one successful commit', t => {
    const root = directory(t), store = new MessageStore({ directory: root });
    store.remember('11111', record());
    const transaction = store.stage('11111');
    const entry = transaction.store.remember('11111', record('history-native'));
    transaction.store.setEvent('11111', entry.id, { message_id: entry.id, message: [] });
    assert.equal(store.get('11111', entry.id), null);
    const restore = failWrites(store);
    assert.throws(() => transaction.commit(), { code: 'EIO' });
    assert.equal(store.get('11111', entry.id), null);
    restore(); transaction.commit();
    assert.equal(store.get('11111', entry.id).event.message_id, entry.id);
    assert.equal(new MessageStore({ directory: root }).get('11111', entry.id).locator.nativeId, 'history-native');
    const conflict = store.stage('11111');
    store.setRecalled('11111', 1);
    assert.throws(() => conflict.commit(), { code: 'BUSY' });
});

test('exact native ID lookups preserve conversation boundaries and additional locator checks', t => {
    const root = directory(t), store = new MessageStore({ directory: root });
    const first = store.remember('11111', record());
    const second = store.remember('11111', record(undefined, { peerUid: '54321' }));
    assert.equal(store.find('11111', { peer: first.locator.peer, nativeId: first.locator.nativeId }).id, first.id);
    assert.equal(store.find('11111', { peer: second.locator.peer, nativeId: second.locator.nativeId }).id, second.id);
    assert.equal(store.find('11111', { peer: first.locator.peer, nativeId: first.locator.nativeId, seq: '99' }), null);
    assert.equal(store.find('11111', { peer: { chatType: 1, peerUid: '12345' }, nativeId: first.locator.nativeId }), null);
});

async function websocketFixture(t, options = {}) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: options.autoPong !== false });
    await once(server, 'listening');
    const network = new ReverseWebSocket({ config: { url: 'ws://127.0.0.1:' + server.address().port,
        heartbeatMs: options.heartbeatMs || 5000, pingTimeoutMs: options.pingTimeoutMs || 1000,
        reconnectMinMs: 20, reconnectMaxMs: 50 }, action: async () => ({ status: 'ok', retcode: 0, data: null }),
        status: async () => ({ ready: true, online: true }), isAuthorized: options.isAuthorized });
    t.after(async () => { await network.close(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
    return { server, network };
}

test('reverse WS closes owned resources while authorization is revoked and reconnects when restored', async t => {
    let allowed = true;
    const { server, network } = await websocketFixture(t, { isAuthorized: () => allowed });
    const first = once(server, 'connection'); network.start('11111');
    const [peer] = await first;
    await until(() => network.connected);
    allowed = false; peer.terminate();
    await until(() => network.socket === null);
    assert.equal(network.heartbeat, null);
    assert.equal(network.pongTimeout, null);
    const next = once(server, 'connection'); allowed = true;
    const [replacement] = await next;
    assert.notEqual(replacement, peer);
    await until(() => network.connected);
});

test('reverse WS action traffic cannot replace a missing protocol pong', { timeout: 5000 }, async t => {
    const { server, network } = await websocketFixture(t, { autoPong: false, heartbeatMs: 60, pingTimeoutMs: 100 });
    const first = once(server, 'connection'); network.start('11111');
    const [peer] = await first;
    peer.on('error', () => {});
    const traffic = setInterval(() => { if (peer.readyState === 1) peer.send(JSON.stringify({ action: 'get_status' })); }, 20);
    t.after(() => clearInterval(traffic));
    const closed = once(peer, 'close');
    await Promise.race([closed, pause(1000).then(() => assert.fail('Missing pong did not close the socket'))]);
});

test('worker CLI waits for a media action beyond the ordinary action shutdown deadline', { timeout: 8000 }, async t => {
    const root = directory(t);
    const script = `
        const path = require('node:path');
        const configPath = require.resolve('./src/config.cjs');
        const runtimePath = require.resolve('./src/runtime.cjs');
        require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: {
            loadConfig: () => ({ logDirectory: ${JSON.stringify(root)}, actionTimeoutMs: 10, mediaActionTimeoutMs: 3000 }) } };
        require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: {
            run: async () => ({ close: async () => { await new Promise(resolve => setTimeout(resolve, 2200)); process.stdout.write('MEDIA_DRAINED\\n'); } }) } };
        require('./src/cli.cjs').main([]).then(() => process.emit('SIGTERM'));
    `;
    const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.match(output, /MEDIA_DRAINED/);
});

test('disabled node quick operations reject hidden action aliases before any lookup or effect', async t => {
    const calls = [];
    const hub = new TransportHub({ config: { profileId: 'first', nodes: [nodeConfig({ id: 'api', type: 'httpApi', quickOperations: false })] },
        action: async request => { calls.push(request); return { status: 'ok', retcode: 0, data: null }; }, status: async () => ({}) });
    await hub.open(); hub.start('11111', 'current');
    t.after(() => hub.close());
    for (const action of ['.handle_quick_operation', '.handle_quick_operation_async']) {
        const response = await fetch('http://127.0.0.1:' + hub.port + '/onebot/first/api/' + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: {
                self_id: 11111, post_type: 'message', message_type: 'group', group_id: 12345, user_id: 22222, message_id: 1 },
            operation: { reply: 'must not send' }, echo: false }) });
        const result = await response.json();
        assert.equal(result.retcode, 1404); assert.equal(result.echo, false);
    }
    assert.equal(calls.length, 0);
});

test('invalid moderation duration rejects a combined quick reply before starting effects', async () => {
    const calls = [], context = { post_type: 'message', message_type: 'group', user_id: 22222, group_id: 12345, message_id: 1 };
    for (const duration of [-1, 2592001, 9007199254740992]) {
        await assert.rejects(executeQuickOperation(context, { reply: 'must not send', ban: true, ban_duration: duration },
            async request => { calls.push(request); return { status: 'ok', retcode: 0 }; }), { code: 'INVALID_REQUEST' });
    }
    assert.equal(calls.length, 0);
});

test('node tokens reject invalid HTTP header characters when saving configuration', () => {
    for (const type of ['httpApi', 'httpPost', 'wsServer', 'wsClient']) {
        for (const token of ['unsafe\0token', 'unsafe\x7ftoken', '中文token']) {
            assert.throws(() => nodeConfig({ id: 'node', type, token, url: type === 'httpPost' ? 'https://example.com/' : 'wss://example.com/' }), { code: 'INVALID_CONFIG' });
        }
        assert.equal(nodeConfig({ id: 'node', type, token: 'valid-token_123', url: type === 'httpPost' ? 'https://example.com/' : 'wss://example.com/' }).token, 'valid-token_123');
    }
});
