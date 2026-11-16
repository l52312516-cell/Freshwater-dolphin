'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { WebSocketServer } = require('ws');
const { startServer } = require('../src/ipc/server.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { run } = require('../src/runtime.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; !predicate() && n < 500; n++) await pause(10); assert.ok(predicate()); }

async function fixture(t, convert, { allowCloseError = false } = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'runtime-fairness-'));
    const web = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(web, 'listening');
    const received = [], diagnostics = [];
    web.on('connection', socket => socket.on('message', data => received.push(JSON.parse(data))));
    const state = { epoch: 'fairness-e1', ready: true, online: true, readyAt: Date.now() - 10000,
        self: { uin: '11111', uid: 'u_self' }, capabilities: { messages: true } };
    const backend = new EventEmitter(); backend.call = async method => { assert.equal(method, 'status'); return structuredClone(state); };
    t.mock.method(OneBotService.prototype, 'event', async event => {
        await convert(event);
        return { time: Number(event.record.msgTime), self_id: 11111, post_type: 'message', message_type: 'group',
            group_id: Number(event.record.peerUid), user_id: 22222, message_id: 1,
            message: [{ type: 'text', data: { text: event.record.msgId } }], raw_message: event.record.msgId };
    });
    const server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    const app = await run({ root, rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'),
        healthFile: path.join(root, 'health.json'), actionTimeoutMs: 500, eventMaxAgeMs: 60000, eventBufferSize: 1000,
        reverseWs: { url: 'ws://127.0.0.1:' + web.address().port, heartbeatMs: 5000, pingTimeoutMs: 1000,
            reconnectMinMs: 20, reconnectMaxMs: 100 } }, (name, data) => diagnostics.push({ name, data }));
    t.after(async () => {
        try { await app.close(); } catch (error) { if (!allowCloseError) throw error; }
        await server.close(); for (const socket of web.clients) socket.terminate();
        await new Promise(resolve => web.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    });
    await until(() => web.clients.size > 0);
    return { received, state, diagnostics, app, root, emit(id, { media = false, peer = '12345' } = {}) {
        backend.emit('event', { kind: 'message', epoch: state.epoch, selfUin: '11111', record: { msgId: id,
            chatType: 2, peerUid: peer, msgTime: String(Math.floor(Date.now() / 1000)),
            elements: [{ elementType: media ? 2 : 1 }] } });
    } };
}

test('slow media cannot block text from its own chat or exhaust ordinary event capacity', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const entered = [];
    const f = await fixture(t, async event => { entered.push(event.record.msgId); if (event.record.msgId.startsWith('media')) await gate; });
    t.after(() => release());
    f.emit('media1', { media: true }); f.emit('media2', { media: true, peer: '12346' });
    f.emit('media3', { media: true, peer: '12347' });
    f.emit('text-after-media'); f.emit('other-text', { peer: '12348' });
    await until(() => f.received.some(item => item.raw_message === 'other-text'));
    assert.ok(f.received.some(item => item.raw_message === 'text-after-media'));
    assert.equal(entered.includes('media3'), false);
    release(); await until(() => f.received.some(item => item.raw_message === 'media3'));
});

test('ordinary events in one chat keep arrival order while another chat progresses', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const entered = [];
    const f = await fixture(t, async event => { entered.push(event.record.msgId); if (event.record.msgId === 'first') await gate; });
    t.after(() => release());
    f.emit('first'); f.emit('second'); f.emit('independent', { peer: '12346' });
    await until(() => f.received.some(item => item.raw_message === 'independent'));
    assert.equal(entered.includes('second'), false);
    release(); await until(() => f.received.some(item => item.raw_message === 'second'));
    const messages = f.received.filter(item => item.group_id === 12345).map(item => item.raw_message);
    assert.deepEqual(messages, ['first', 'second']);
});

test('a session replacement discards pending media results without sending on the new session', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; }); let entered = false;
    const f = await fixture(t, async () => { entered = true; await gate; }); t.after(() => release());
    f.emit('old-media', { media: true }); await until(() => entered);
    f.state.epoch = 'fairness-e2';
    await until(() => f.diagnostics.some(item => item.name === 'qq_session_changed'));
    release(); await pause(150);
    assert.equal(f.received.some(item => item.raw_message === 'old-media'), false);
});

test('all concurrent shutdown callers wait for conversion writers before releasing the data lock', async t => {
    let release; const gate = new Promise(resolve => { release = resolve; }); let entered = false;
    const f = await fixture(t, async () => { entered = true; await gate; }); t.after(() => release());
    f.emit('in-flight-media', { media: true }); f.emit('queued-media', { media: true });
    await until(() => entered);
    const first = f.app.close(), second = f.app.close();
    assert.equal(first, second);
    let completed = false; second.then(() => { completed = true; }); await pause(30);
    assert.equal(completed, false); assert.equal(fs.existsSync(path.join(f.root, 'data/.adapter-owner.json')), true);
    release(); await first;
    assert.equal(fs.existsSync(path.join(f.root, 'data/.adapter-owner.json')), false);
    const health = JSON.parse(fs.readFileSync(path.join(f.root, 'health.json'), 'utf8'));
    assert.equal(health.activeActions, 0); assert.equal(health.eventQueue.waiting, 0); assert.equal(health.bridge, false);
    assert.equal(f.received.some(item => item.raw_message === 'in-flight-media'), false);
});

test('shutdown still checkpoints and releases ownership when transport cleanup reports an error', async t => {
    const { TransportHub } = require('../src/onebot/transports.cjs');
    const f = await fixture(t, async () => {}, { allowCloseError: true });
    const original = TransportHub.prototype.close;
    t.mock.method(TransportHub.prototype, 'close', async function () {
        await original.call(this); throw Object.assign(new Error('Synthetic transport cleanup error'), { code: 'EIO' });
    });
    const first = f.app.close();
    await assert.rejects(first, error => error instanceof AggregateError && error.errors.some(item => item.code === 'EIO'));
    assert.equal(f.app.close(), first);
    assert.equal(fs.existsSync(path.join(f.root, 'data/.adapter-owner.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'health.json'), 'utf8')).bridge, false);
});
