'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { nodeConfig } = require('../src/config.cjs');
const { Accounts } = require('../src/manager/accounts.cjs');
const { TransportHub } = require('../src/onebot/transports.cjs');

function temporary(t) {
    const parent = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'secure-defaults-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

const nodeTypes = ['httpApi', 'httpPost', 'wsServer', 'wsClient'];
const nodeInput = type => ({ id: type, type, enabled: false,
    ...(['httpPost', 'wsClient'].includes(type) ? { url: type === 'httpPost' ? 'https://example.com/events' : 'wss://example.com/ws' } : {}) });

test('node configuration requires explicit boolean opt-in for quick operations for every transport', () => {
    for (const type of nodeTypes) {
        const input = nodeInput(type);
        assert.equal(nodeConfig(input).quickOperations, false);
        assert.equal(nodeConfig({ ...input, quickOperations: false }).quickOperations, false);
        assert.equal(nodeConfig({ ...input, quickOperations: true }).quickOperations, true);
        for (const value of ['true', 1, null]) assert.throws(() => nodeConfig({ ...input, quickOperations: value }), { code: 'INVALID_CONFIG' });
    }
});

test('manager account saves persist disabled defaults and preserve explicit quick-operation opt-in', async t => {
    const accounts = new Accounts(temporary(t));
    t.after(() => accounts.close());
    const created = accounts.create({ id: 'account', nodes: nodeTypes.map(nodeInput) });
    assert.ok(created.nodes.every(node => node.quickOperations === false));
    await accounts.update('account', { nodes: created.nodes.map(node => ({ ...nodeInput(node.type), quickOperations: true })) });
    await accounts.update('account', { label: 'saved again' });
    assert.ok(accounts.list()[0].nodes.every(node => node.quickOperations === true));
    const saved = JSON.parse(fs.readFileSync(accounts.file, 'utf8'));
    assert.ok(saved.profiles[0].nodes.every(node => node.quickOperations === true));
});

test('raw transport policies reject quick-operation aliases and direct effects unless exactly true', async t => {
    const calls = [];
    const source = [undefined, false, 'true', 1, true].map((policy, index) => ({ id: 'api-' + index, type: 'httpApi', quickOperations: policy }));
    const hub = new TransportHub({ config: { nodes: source }, status: () => ({}),
        action: async request => { calls.push(request); return { status: 'ok', retcode: 0 }; } });
    hub.start('11111', 'session');
    t.after(() => hub.close());
    const context = { self_id: 11111, post_type: 'request', request_type: 'friend', flag: 'known-request' };
    for (const node of hub.nodes.values()) {
        for (const action of ['.handle_quick_operation', '.handle_quick_operation_async']) {
            const before = calls.length;
            const result = await hub.dispatch(node, { action, params: { context, operation: { approve: true } }, echo: false }, hub.session);
            assert.equal(result.retcode, node.config.quickOperations === true ? 0 : 1404);
            assert.equal(result.echo, false);
            assert.equal(calls.length - before, node.config.quickOperations === true ? 1 : 0);
        }
        if (node.config.quickOperations !== true) {
            await assert.rejects(hub.quick(node, context, { approve: true }, hub.session), { code: 'UNSUPPORTED' });
        }
    }
    assert.deepEqual(calls.map(request => request.action), ['set_friend_add_request', 'set_friend_add_request']);
});

test('HTTP event responses execute quick operations only for explicitly enabled raw node policies', async t => {
    let messages = 0;
    const calls = [];
    const server = http.createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk;
        const event = JSON.parse(body);
        if (event.post_type === 'message') messages++;
        response.setHeader('Content-Type', 'application/json');
        response.end(event.post_type === 'message' ? JSON.stringify({ reply: 'enabled response' }) : '{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const source = [undefined, false, 'true', 1, true].map((policy, index) => ({ id: 'post-' + index, type: 'httpPost',
        url: 'http://127.0.0.1:' + server.address().port, quickOperations: policy }));
    const hub = new TransportHub({ config: { nodes: source }, status: () => ({}),
        action: async request => { calls.push(request); return { status: 'ok', retcode: 0 }; } });
    t.after(async () => { await hub.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    hub.start('11111', 'session');
    hub.event({ time: Math.floor(Date.now() / 1000), self_id: 11111, post_type: 'message', message_type: 'private', user_id: 22222, message: [] });
    await Promise.all([...hub.nodes.values()].map(node => node.draining));
    assert.equal(messages, source.length);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'send_private_msg');
    assert.equal(calls[0].params.user_id, 22222);
});

test('manager startup rejects either incomplete TLS option before creating the manager and passes complete options through', async t => {
    const root = temporary(t), cert = path.join(root, 'cert.pem'), key = path.join(root, 'key.pem');
    fs.writeFileSync(cert, 'certificate bytes'); fs.writeFileSync(key, 'private key bytes');
    const server = require('../src/manager/server.cjs');
    const reached = Object.assign(new Error('Manager creation reached'), { code: 'MANAGER_REACHED' });
    const options = [];
    t.mock.method(server, 'createManager', async value => { options.push(value); throw reached; });
    const { main } = require('../src/manager/cli.cjs');
    const names = ['FWD_TLS_CERT', 'FWD_TLS_KEY'], previous = names.map(name => process.env[name]);
    try {
        for (const pair of [[cert, undefined], [undefined, key], [cert, ''], ['', key]]) {
            names.forEach((name, index) => { if (pair[index] === undefined) delete process.env[name]; else process.env[name] = pair[index]; });
            await assert.rejects(main([]), { code: 'INVALID_CONFIG' });
            assert.equal(options.length, 0);
        }
        delete process.env.FWD_TLS_CERT; delete process.env.FWD_TLS_KEY;
        await assert.rejects(main([]), reached);
        assert.equal(options[0].https, undefined);
        process.env.FWD_TLS_CERT = cert; process.env.FWD_TLS_KEY = key;
        await assert.rejects(main([]), reached);
        assert.equal(options[1].https.cert.toString(), 'certificate bytes');
        assert.equal(options[1].https.key.toString(), 'private key bytes');
    } finally {
        names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    }
});
