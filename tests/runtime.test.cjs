'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { startServer } = require('../src/ipc/server.cjs');
const { run } = require('../src/runtime.cjs');
const { loadConfig } = require('../src/config.cjs');
const { acquireLock } = require('../src/lock.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function directory(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshwater-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('runtime shuts down an in-flight poll without reopening a network connection', async t => {
    const root = directory(t);
    const web = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(web, 'listening');
    let fulfill, calls = 0;
    const backend = new EventEmitter();
    backend.call = async () => { calls++; return new Promise(resolve => { fulfill = resolve; }); };
    const server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    const app = await run({ root, rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'), healthFile: path.join(root, 'health.json'),
        actionTimeoutMs: 500, eventBufferSize: 1000, eventMaxAgeMs: 60000,
        reverseWs: { url: 'ws://127.0.0.1:' + web.address().port, token: '', heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 20, reconnectMaxMs: 100 } }, () => {});
    for (let attempt = 0; !calls && attempt < 100; attempt++) await pause(5);
    assert.equal(calls, 1);
    await app.close();
    fulfill({ epoch: 'old', ready: true, self: { uin: '12345', uid: 'u_self' }, capabilities: { messages: true } });
    await pause(40);
    assert.equal(web.clients.size, 0);
    assert.equal(fs.existsSync(path.join(root, 'data/.adapter-owner.json')), false);
    await server.close();
    await new Promise(resolve => web.close(resolve));
});

test('data directory allows only one active writer and releases its lock', t => {
    const root = directory(t);
    const release = acquireLock(root);
    assert.throws(() => acquireLock(root), { code: 'BUSY' });
    release();
    const releaseAgain = acquireLock(root);
    releaseAgain();
});

test('configuration rejects an escaping health directory and invalid WS credentials', t => {
    const root = directory(t);
    const outside = directory(t);
    const value = { reverseWs: { url: 'ws://127.0.0.1:1234/ws' } };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(value));
    fs.mkdirSync(path.join(root, 'work'));
    fs.symlinkSync(outside, path.join(root, 'work/state'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
    fs.unlinkSync(path.join(root, 'work/state'));
    value.reverseWs.url = 'ws://name:secret@127.0.0.1:1234/ws';
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(value));
    assert.throws(() => loadConfig({ root, env: {} }), { code: 'INVALID_CONFIG' });
});

test('runtime reports fresh messages but never turns login history into automatic events', { timeout: 15000 }, async t => {
    const temporary = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'runtime-history-'));
    const web = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let app, server;
    t.after(async () => {
        if (app) await app.close();
        if (server) await server.close();
        for (const socket of web.clients) socket.terminate();
        await new Promise(resolve => web.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    await once(web, 'listening');
    const records = [], diagnostics = [];
    web.on('connection', socket => socket.on('message', data => records.push(JSON.parse(data))));
    const state = { epoch: 'history-test-session', ready: true, readyAt: Date.now() - 10000, online: true,
        self: { uin: '11111', uid: 'u_self', nickname: '海豚' }, capabilities: { messages: true } };
    const backend = new EventEmitter();
    backend.call = async (method, params) => {
        if (method === 'resolve') return { uid: params.uid, uin: params.uid === 'u_self' ? '11111' : '22222' };
        assert.equal(method, 'status');
        return structuredClone(state);
    };
    server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    const now = Math.floor(Date.now() / 1000);
    function message(id, time, sourceType) {
        backend.emit('event', { kind: 'message', epoch: state.epoch, selfUin: '11111', record: {
            chatType: 2, peerUid: '12345', peerUin: '12345', senderUid: 'u_sender', senderUin: '22222',
            msgId: id, msgSeq: '1', clientSeq: '2', msgTime: String(time), sourceType,
            sendNickName: '测试发送者', elements: [{ elementType: 1, textElement: { content: id, atType: 0 } }]
        } });
    }
    message('hours-old', now - 3 * 3600, 1);
    message('historical-source', now, 3);
    message('before-ready', Math.floor(state.readyAt / 1000) - 1, 1);
    message('too-old-in-current-session', now - 7, 1);
    message('future-clock', now + 32, 1);
    message('invalid-time', 'not-a-time', 1);
    message('fresh-message', now, 1);
    const poke = { kind: 'notice', notice: 'gray_tip', epoch: state.epoch, selfUin: '11111', record: {
        chatType: 2, peerUid: '12345', peerUin: '12345', senderUid: '', senderUin: '0',
        msgType: 5, subMsgType: 12, msgId: '18446744073709551612', msgSeq: '0', msgTime: String(now),
        elements: [{ elementType: 8, grayTipElement: { subElementType: 17, jsonGrayTipElement: {
            busiId: '1061', jsonStr: JSON.stringify({ items: [{ type: 'qq', uid: 'u_sender' }, { type: 'qq', uid: 'u_self' }] }) } } }] } };
    backend.emit('event', poke); backend.emit('event', poke);
    backend.emit('event', { ...poke, record: { ...poke.record, sourceType: 3, msgId: '900' } });
    app = await run({ root, rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'), healthFile: path.join(root, 'health.json'),
        actionTimeoutMs: 2000, eventBufferSize: 1000, eventMaxAgeMs: 5000,
        reverseWs: { url: 'ws://127.0.0.1:' + web.address().port, token: '', heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 20, reconnectMaxMs: 100 }
    }, (event, data) => diagnostics.push({ event, data }));
    for (let attempt = 0; attempt < 500 && (!records.some(item => item.post_type === 'message') ||
        !records.some(item => item.post_type === 'notice')); attempt++) await pause(10);
    await pause(300);
    const messages = records.filter(item => item.post_type === 'message');
    assert.equal(messages.length, 1, JSON.stringify(records));
    assert.equal(messages[0].message[0].data.text, 'fresh-message');
    const pokes = records.filter(item => item.post_type === 'notice');
    assert.equal(pokes.length, 1, JSON.stringify(records));
    assert.equal(pokes[0].sub_type, 'poke');
    assert.equal(pokes[0].target_id, 11111);
    assert.equal(pokes[0].user_id, 22222);
    assert.equal(pokes[0].group_id, 12345);
    assert.ok(diagnostics.some(item => item.event === 'incoming_history_skipped' && item.data.reason === 'history_source'));
    assert.ok(diagnostics.some(item => item.event === 'incoming_history_skipped' && item.data.reason === 'before_session_ready'));
    assert.ok(diagnostics.some(item => item.event === 'incoming_event_expired'));
    assert.ok(diagnostics.some(item => item.event === 'incoming_time_in_future'));
    assert.ok(diagnostics.some(item => item.event === 'incoming_time_invalid'));
    assert.ok(!diagnostics.some(item => JSON.stringify(item).includes('测试发送者')));
    state.readyAt = null;
    state.online = false;
    // Health is written after the runtime has consumed its status response.
    // Await this explicit state transition before enqueueing the next event.
    const observedUnknownReady = () => {
        try { return JSON.parse(fs.readFileSync(path.join(root, 'health.json'), 'utf8')).online === false; } catch { return false; }
    };
    for (let attempt = 0; attempt < 500 && !observedUnknownReady(); attempt++) await pause(10);
    assert.ok(observedUnknownReady(), 'runtime did not consume the changed backend state');
    message('unknown-ready-anchor', Math.floor(Date.now() / 1000), 1);
    for (let attempt = 0; attempt < 200 && !diagnostics.some(item => item.event === 'incoming_ready_time_unknown'); attempt++) await pause(10);
    assert.ok(diagnostics.some(item => item.event === 'incoming_ready_time_unknown'));
    assert.equal(records.filter(item => item.post_type === 'message').length, 1);
});

test('runtime carries current request timestamps through RPC and reverse WS without requiring a message record', { timeout: 25000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshwater-request-'));
    const web = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let app, server;
    t.after(async () => {
        if (app) await app.close();
        if (server) await server.close();
        for (const socket of web.clients) socket.terminate();
        await new Promise(resolve => web.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    await once(web, 'listening');
    const records = [], diagnostics = [], observed = new EventEmitter();
    web.on('connection', socket => socket.on('message', data => {
        records.push(JSON.parse(data)); observed.emit('frame');
    }));
    const waitForFrame = async predicate => {
        const signal = AbortSignal.timeout(10000);
        for (;;) {
            const frame = records.find(predicate);
            if (frame) return frame;
            try { await once(observed, 'frame', { signal }); }
            catch { assert.fail(JSON.stringify({ records, diagnostics })); }
        }
    };
    const state = { epoch: 'request-session', ready: true, readyAt: Date.now() - 1000, online: true,
        self: { uin: '2068886823', uid: 'u_self' }, capabilities: { messages: true, friendRequests: true } };
    const backend = new EventEmitter();
    backend.call = async (method, params) => {
        if (method === 'status') return structuredClone(state);
        if (method === 'resolve') { assert.equal(params.uid, 'u_friend'); return { uid: 'u_friend', uin: '1515564167' }; }
        throw new Error('Unexpected method ' + method);
    };
    server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    app = await run({ root, rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'), healthFile: path.join(root, 'health.json'),
        actionTimeoutMs: 10000, eventBufferSize: 1000, eventMaxAgeMs: 60000,
        reverseWs: { url: 'ws://127.0.0.1:' + web.address().port, token: '', heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 20, reconnectMaxMs: 100 }
    }, (event, data) => diagnostics.push({ event, data }));
    // Observe the real Universal connection before creating a current request.
    // This checks request delivery rather than racing initial RPC/filesystem and
    // socket startup against an artificially short one-second action budget.
    await waitForFrame(item => item.meta_event_type === 'lifecycle' && item.sub_type === 'connect');
    const now = Math.floor(Date.now() / 1000);
    backend.emit('event', { kind: 'request', time: now, epoch: state.epoch, selfUin: state.self.uin,
        request: { type: 'friend', uid: 'u_friend', flag: 'fwd_req_' + 'a'.repeat(48), comment: 'hello\nfriend' } });
    const request = await waitForFrame(item => item.post_type === 'request');
    assert.equal(request.time, now);
    assert.equal(request.user_id, 1515564167); assert.equal(request.comment, 'hello\nfriend');
});

test('built-in status commands consume only new authenticated messages while duplicates, self echoes and disabled commands remain safe', { timeout: 12000 }, async t => {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'runtime-status-command-'));
    const web = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let app, server;
    t.after(async () => {
        if (app) await app.close(); if (server) await server.close();
        for (const socket of web.clients) socket.terminate();
        await new Promise(resolve => web.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    });
    await once(web, 'listening');
    const received = [], sends = [], diagnostics = [];
    web.on('connection', socket => socket.on('message', data => received.push(JSON.parse(data))));
    const state = { epoch: 'command-runtime-session', ready: true, readyAt: Date.now() - 5000, online: true,
        self: { uin: '11111', uid: 'u_self', nickname: '海豚' }, capabilities: { messages: true } };
    const backend = new EventEmitter();
    backend.call = async (method, params) => {
        if (method === 'status') return structuredClone(state);
        if (method === 'sendMessage') {
            assert.equal(params.expectedEpoch, state.epoch); sends.push(params);
            return { chatType: params.peer.chatType, peerUid: params.peer.peerUid, peerUin: params.peer.peerUid,
                msgId: 'native-status-reply-' + sends.length, msgSeq: '10', clientSeq: '20', msgTime: String(Math.floor(Date.now() / 1000)),
                senderUin: state.self.uin, senderUid: state.self.uid, elements: params.elements, sendStatus: 2 };
        }
        throw new Error('Unexpected method ' + method);
    };
    server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    const event = (id, text, extra = {}) => ({ kind: 'message', epoch: state.epoch, selfUin: state.self.uin,
        record: { chatType: 2, peerUid: '98765', peerUin: '98765', senderUid: 'u_sender', senderUin: '22222',
            msgId: id, msgSeq: '1', clientSeq: '2', msgTime: String(Math.floor(Date.now() / 1000)), sourceType: 1,
            elements: [{ elementType: 1, textElement: { content: text, atType: 0 } }], ...extra } });
    const command = event('command-one', '  #FD  ');
    backend.emit('event', command); backend.emit('event', command);
    backend.emit('event', event('self-echo', '#fd', { senderUid: 'u_self', senderUin: '11111' }));
    backend.emit('event', event('normal-one', 'ordinary group text'));
    app = await run({ root, rpcDirectory: path.join(root, 'rpc'), dataDirectory: path.join(root, 'data'), healthFile: path.join(root, 'health.json'),
        actionTimeoutMs: 2000, eventBufferSize: 1000, eventMaxAgeMs: 60000,
        reverseWs: { url: 'ws://127.0.0.1:' + web.address().port, token: '', heartbeatMs: 5000, pingTimeoutMs: 1000, reconnectMinMs: 20, reconnectMaxMs: 100 }
    }, (name, data) => diagnostics.push({ name, data }));
    const waitFor = async predicate => { for (let i = 0; i < 500 && !predicate(); i++) await pause(10); assert.ok(predicate(), JSON.stringify(diagnostics)); };
    await waitFor(() => sends.length === 1 && received.some(item => item.post_type === 'message'));
    await pause(100);
    assert.equal(sends.length, 1); assert.equal(sends[0].peer.peerUid, '98765');
    assert.match(sends[0].elements[0].textElement.content, /^Freshwater-dolphin 状态\n版本：/);
    assert.deepEqual(received.filter(item => item.post_type === 'message').map(item => item.message[0].data.text), ['ordinary group text']);
    // Identical text with a distinct QQ identity is processed again and then
    // consumed by the bounded command cooldown, rather than text deduplication.
    backend.emit('event', event('command-two', '#fd'));
    await waitFor(() => diagnostics.some(item => item.name === 'status_command_rate_limited'));
    fs.mkdirSync(path.join(root, 'work/control'), { recursive: true });
    fs.writeFileSync(path.join(root, 'work/control/settings.json'), JSON.stringify({ statusCommand: { enabled: false, trigger: '#fd' } }));
    backend.emit('event', event('command-disabled', '#fd'));
    await waitFor(() => received.some(item => item.post_type === 'message' && item.message[0].data.text === '#fd'));
    assert.equal(sends.length, 1);
    assert.equal(received.filter(item => item.post_type === 'message').length, 2);
});

test('status replies count as active actions and revoked manager authorization prevents a native send after pending validation', { timeout: 10000 }, async t => {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'runtime-status-stop-'));
    let app, server, releaseAction;
    t.after(async () => {
        releaseAction?.(); if (app) await app.close(); if (server) await server.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const state = { epoch: 'command-stop-session', ready: true, readyAt: Date.now() - 1000, online: true,
        self: { uin: '11111', uid: 'u_self' }, capabilities: { messages: true } };
    const authorizationFile = path.join(root, 'authorization.json');
    fs.writeFileSync(authorizationFile, JSON.stringify({ profileId: 'first', uin: '11111', epoch: state.epoch }));
    const backend = new EventEmitter(), diagnostics = [];
    let sends = 0, enteredAction;
    const actionEntered = new Promise(resolve => { enteredAction = resolve; });
    const actionGate = new Promise(resolve => { releaseAction = resolve; });
    const originalRun = OneBotService.prototype.run;
    t.mock.method(OneBotService.prototype, 'run', async function (action, params, expectedSession) {
        if (this.profileId === 'first' && action === 'send_group_msg') {
            enteredAction();
            await actionGate;
        }
        return originalRun.call(this, action, params, expectedSession);
    });
    backend.call = async method => {
        if (method === 'status') return structuredClone(state);
        if (method === 'sendMessage') { sends++; throw new Error('Revoked status action must not reach a send request'); }
        throw new Error('Unexpected method ' + method);
    };
    server = await startServer({ dir: path.join(root, 'rpc'), backend, pollMs: 5 });
    const healthFile = path.join(root, 'health.json');
    const log = (name, data) => { diagnostics.push({ name, data }); };
    app = await run({ root, profileId: 'first', authorizationFile, rpcDirectory: path.join(root, 'rpc'),
        dataDirectory: path.join(root, 'data'), healthFile,
        actionTimeoutMs: 2500, eventBufferSize: 1000, eventMaxAgeMs: 60000, nodes: []
    }, log);
    const waitFor = async predicate => { for (let i = 0; i < 500 && !predicate(); i++) await pause(10); assert.ok(predicate(), JSON.stringify(diagnostics)); };
    const readHealth = () => { try { return JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch { return {}; } };
    await waitFor(() => readHealth().authorized === true && readHealth().ready === true);
    // Gate only the built-in send action before its identity validation. A
    // shared "next status" gate can instead capture the background poll and
    // leave the action unblocked, so it cannot establish the intended order.
    // QQ events and the poll still use the actual file RPC implementation.
    backend.emit('event', { kind: 'message', epoch: state.epoch, selfUin: state.self.uin, record: {
        chatType: 2, peerUid: '98765', peerUin: '98765', senderUid: 'u_sender', senderUin: '22222',
        msgId: 'pending-status-stop', msgSeq: '1', clientSeq: '2', msgTime: String(Math.floor(Date.now() / 1000)), sourceType: 1,
        elements: [{ elementType: 1, textElement: { content: '#fd', atType: 0 } }]
    } });
    await actionEntered;
    await waitFor(() => readHealth().activeActions === 1);
    fs.unlinkSync(authorizationFile);
    const revokedAt = Date.now();
    await waitFor(() => readHealth().at >= revokedAt && readHealth().authorized === false);
    assert.equal(readHealth().activeActions, 1, 'manager must see the in-flight built-in action while authorization is revoked');
    releaseAction(); releaseAction = null;
    await waitFor(() => readHealth().activeActions === 0);
    assert.equal(sends, 0);
    await app.close(); app = null;
    assert.equal(sends, 0);
    assert.equal(diagnostics.some(item => item.name === 'status_command_sent'), false);
});
