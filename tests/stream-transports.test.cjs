'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { TransportHub } = require('../src/onebot/transports.cjs'), { nodeConfig } = require('../src/config.cjs');
const { runStreamActions } = require('../src/onebot/file-stream-actions.cjs');
const { sendSocket, writeHttp } = require('../src/onebot/streaming.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const scratch = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(scratch, { recursive: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, nodes, customize) {
    const root = fs.mkdtempSync(path.join(scratch, 'stream-net-')); if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    const calls = [], service = { mediaDirectory: root, remaining: () => 60000, assertSession: async state => {
        if (!hub.current({ uin: String(state.self.uin), epoch: state.epoch })) throw Object.assign(new Error('Session changed'), { code: 'SESSION_CHANGED' });
    } };
    const hub = new TransportHub({ config: { profileId: 'stream', gatewayPort: 0, nodes: nodes.map((node, index) => nodeConfig({ role: 'Api', heartbeatMs: 5000, ...node }, index)) },
        status: async () => ({ ready: true, online: true }), action: async (request, session, options) => {
            calls.push({ request, session, options });
            try {
                const chosen = customize ? customize(options, request) : options;
                const data = await runStreamActions(service, { self: { uin: session.uin, uid: 'u_self' }, epoch: session.epoch, capabilities: { streamFiles: true } }, request.action, request.params || {}, chosen);
                return { status: 'ok', retcode: 0, data, ...(Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
            } catch (error) { return { status: 'failed', retcode: error.code === 'EXPIRED' || error.code === 'SESSION_CHANGED' ? 1503 : 1500, data: null, message: error.message }; }
        } });
    await hub.open(); hub.start('12345', 'e1');
    t.after(async () => { await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { hub, service, calls, base: 'http://127.0.0.1:' + hub.port + '/onebot/stream/', ws: 'ws://127.0.0.1:' + hub.port + '/onebot/stream/' };
}
function collector(socket) { const frames = []; socket.on('message', raw => frames.push(JSON.parse(raw.toString()))); return frames; }
async function until(predicate) { for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(predicate(), 'Expected stream condition'); }

test('HTTP emits real NDJSON before completion, preserves exact echo on all 11 frames and sends one terminal error', async t => {
    let release, first = true;
    const f = await fixture(t, [{ id: 'http', type: 'httpApi' }], options => ({ ...options, streamSink: { send: async data => {
        await options.streamSink.send(data); if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    } } }));
    const response = await fetch(f.base + 'http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test_download_stream', echo: { id: 0, flag: false } }) });
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const reader = response.body.getReader(), firstRead = await reader.read(); assert.equal(firstRead.done, false);
    const initial = Buffer.from(firstRead.value).toString(); assert.match(initial, /Index-> 1/); assert.doesNotMatch(initial, /data_complete/); assert.equal(typeof release, 'function');
    release(); let rest = ''; while (true) { const next = await reader.read(); if (next.done) break; rest += Buffer.from(next.value).toString(); }
    const frames = (initial + rest).trim().split('\n').map(JSON.parse); assert.equal(frames.length, 11);
    for (const frame of frames) { assert.deepEqual(frame.echo, { id: 0, flag: false }); assert.equal(frame.stream, 'stream-action'); }
    assert.equal(frames[10].data.type, 'response'); assert.equal(frames[0].data.type, 'stream');
    const error = await fetch(f.base + 'http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test_download_stream', params: { error: true }, echo: null }) });
    const errors = (await error.text()).trim().split('\n').map(JSON.parse); assert.equal(errors.length, 11); assert.equal(errors[10].status, 'failed'); assert.equal(errors[10].data.type, 'error'); assert.equal(errors[10].echo, null);
});

test('forward WebSocket sends repeated frames with distinct concurrent echoes and performs a complete file upload/download', async t => {
    const f = await fixture(t, [{ id: 'ws', type: 'wsServer' }]);
    const socket = new WebSocket(f.ws + 'ws'); const frames = collector(socket); await once(socket, 'open'); t.after(() => socket.terminate());
    socket.send(JSON.stringify({ action: 'test_download_stream', echo: false })); socket.send(JSON.stringify({ action: 'test_download_stream', echo: { transfer: 2 } }));
    await until(() => frames.filter(frame => frame.data?.type === 'response').length === 2);
    assert.equal(frames.filter(frame => frame.echo === false).length, 11); assert.equal(frames.filter(frame => frame.echo?.transfer === 2).length, 11);
    for (const frame of frames) assert.equal(frame.stream, 'stream-action');
    socket.send(JSON.stringify({ action: 'upload_file_stream', params: { stream_id: 'net-upload', total_chunks: 1, filename: 'net.txt', file_size: 3, chunk_index: 0, chunk_data: 'YWJj' }, echo: 'chunk' }));
    await until(() => frames.some(frame => frame.echo === 'chunk')); assert.equal(frames.find(frame => frame.echo === 'chunk').data.status, 'chunk_received');
    socket.send(JSON.stringify({ action: 'upload_file_stream', params: { stream_id: 'net-upload', is_complete: true }, echo: 'complete' }));
    await until(() => frames.some(frame => frame.echo === 'complete')); const info = frames.find(frame => frame.echo === 'complete').data; assert.equal(info.type, 'response');
    socket.send(JSON.stringify({ action: 'download_file_stream', params: { file: info.file_id, chunk_size: 2 }, echo: 'download' }));
    await until(() => frames.some(frame => frame.echo === 'download' && frame.data?.type === 'response'));
    const chunks = frames.filter(frame => frame.echo === 'download' && frame.data?.data_type === 'file_chunk'); assert.equal(chunks.length, 2); assert.equal(Buffer.concat(chunks.map(frame => Buffer.from(frame.data.data, 'base64'))).toString(), 'abc');
});

test('reverse WebSocket sends real repeated stream frames on the original requesting connection', async t => {
    const remote = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(remote, 'listening');
    const connected = once(remote, 'connection');
    const f = await fixture(t, [{ id: 'reverse', type: 'wsClient', url: 'ws://127.0.0.1:' + remote.address().port, reconnectMinMs: 1000, reconnectMaxMs: 1000 }]);
    const [socket] = await connected; const frames = collector(socket);
    t.after(async () => { await f.hub.close(); for (const socket of remote.clients) socket.terminate(); await new Promise(resolve => remote.close(resolve)); });
    socket.send(JSON.stringify({ action: 'test_download_stream', echo: { reverse: true } }));
    await until(() => frames.some(frame => frame.data?.type === 'response')); assert.equal(frames.length, 11);
    for (const frame of frames) { assert.equal(frame.stream, 'stream-action'); assert.deepEqual(frame.echo, { reverse: true }); }
});

test('HTTP disconnect and session revocation abort the stream and prevent subsequent business frames', async t => {
    let release, count = 0, signal;
    const f = await fixture(t, [{ id: 'http', type: 'httpApi' }], options => {
        signal = options.signal;
        return { ...options, streamSink: { send: async data => { count++; await options.streamSink.send(data); if (count === 1) await new Promise(resolve => { release = resolve; }); } } };
    });
    const response = await fetch(f.base + 'http/test_download_stream'); const reader = response.body.getReader(); await reader.read(); await reader.cancel(); await until(() => signal.aborted);
    release(); await tick(); assert.equal(count, 1);
    let secondRelease, secondCount = 0;
    const g = await fixture(t, [{ id: 'ws', type: 'wsServer' }], options => ({ ...options, streamSink: { send: async data => { secondCount++; await options.streamSink.send(data); await new Promise(resolve => { secondRelease = resolve; }); } } }));
    const socket = new WebSocket(g.ws + 'ws'); const frames = collector(socket); await once(socket, 'open'); socket.send(JSON.stringify({ action: 'test_download_stream', echo: 'old' }));
    await until(() => frames.length === 1); g.hub.start('12345', 'e2'); secondRelease(); await tick(); assert.equal(secondCount, 1); assert.equal(frames.length, 1);
});

test('transport send promises obey writable callbacks and reject closed or excessive buffers', async () => {
    let callback;
    const socket = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (_value, cb) => { callback = cb; } });
    let resolved = false; const waiting = sendSocket(socket, { data: 'frame' }).then(() => { resolved = true; }); await tick(); assert.equal(resolved, false); callback(); await waiting;
    socket.bufferedAmount = 2 * 1024 * 1024 + 1; await assert.rejects(sendSocket(socket, {}), { code: 'BUSY' });
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, write: (_value, cb) => { callback = cb; return false; } });
    resolved = false; const httpWaiting = writeHttp(response, { data: 'frame' }).then(() => { resolved = true; }); await tick(); assert.equal(resolved, false); callback(); await httpWaiting;
    const control = new AbortController(), blocked = writeHttp(response, {}, { signal: control.signal }); control.abort(); await assert.rejects(blocked, { code: 'EXPIRED' });
});

test('actual OneBotService receives the transport sink through AsyncLocalStorage and scopes completed file handles', async t => {
    const f = await fixture(t, [{ id: 'http', type: 'httpApi' }]);
    const current = { ready: true, online: true, epoch: 'e1', self: { uin: '12345', uid: 'u_self' }, capabilities: {} }, calls = [];
    const service = new OneBotService({ mediaDirectory: f.service.mediaDirectory, store: {}, backend: { call: async method => {
        calls.push(method); if (method === 'status') return structuredClone(current); throw new Error('Unexpected file backend method');
    } } });
    f.hub.action = (request, session, options) => service.action(request, { epoch: session.epoch, selfUin: session.uin }, options);
    const direct = await service.action({ action: 'test_download_stream' }); assert.equal(direct.retcode, 1404);
    const transfer = await fetch(f.base + 'http/test_download_stream?echo=false');
    const frames = (await transfer.text()).trim().split('\n').map(JSON.parse); assert.equal(frames.length, 11); assert.equal(frames[10].data.type, 'response'); assert.equal(frames[10].echo, false);
    const post = async request => (await fetch(f.base + 'http', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).json();
    const saved = await post({ action: 'download_file', params: { base64: 'YWJj', name: 'actual.txt' }, echo: 0 }); assert.equal(saved.status, 'ok'); assert.equal(saved.echo, 0);
    const info = await post({ action: 'get_file', params: { file_id: saved.data.file_id } }); assert.equal(info.status, 'ok'); assert.equal(info.data.file_size, 3);
    const download = await fetch(f.base + 'http/download_file_stream?file_id=' + saved.data.file_id + '&chunk_size=2&echo=null');
    const received = (await download.text()).trim().split('\n').map(JSON.parse); assert.equal(received.length, 4); assert.equal(received.at(-1).data.total_bytes, 3); assert.equal(received[0].echo, null);
    assert.equal(calls.every(method => method === 'status'), true, 'account filesystem actions never invent a worker QQ protocol');
    current.epoch = 'e2'; f.hub.start('12345', 'e2');
    const old = await post({ action: 'get_file', params: { file_id: saved.data.file_id } }); assert.equal(old.status, 'failed'); assert.equal(old.retcode, 1404);
});
