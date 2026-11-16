'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { nodeConfig } = require('../src/config.cjs');
const { Accounts } = require('../src/manager/accounts.cjs');
const { createManager } = require('../src/manager/server.cjs');

const helper = import('../webui/src/account-config.mjs');

test('configuration drafts submit only writable account and node fields', async () => {
    const { writableAccountConfig } = await helper;
    const source = {
        id: 'alpha', label: 'Primary QQ', expectedUin: '1000000001', actionTimeoutMs: 15000,
        boundUin: '1000000001', bridgeInstalled: true, desired: 'running', revision: 3,
        state: 'online', health: { ready: true }, maintenance: null,
        nodes: [{ id: 'listener', label: 'Bot', type: 'httpApi', enabled: false,
            role: 'Universal', heartbeatMs: 30000, maxPending: 16,
            tokenPresent: true, secretPresent: true, state: 'connected', runtime: { connected: true } }]
    };
    assert.deepEqual(writableAccountConfig(source), {
        label: 'Primary QQ', expectedUin: '1000000001', actionTimeoutMs: 15000,
        nodes: [{ id: 'listener', label: 'Bot', type: 'httpApi', enabled: false,
            role: 'Universal', heartbeatMs: 30000, maxPending: 16 }]
    });
    assert.equal(source.bridgeInstalled, true);
    assert.equal(source.nodes[0].tokenPresent, true);
});

test('configuration serialization preserves omitted credentials and explicit changes', async () => {
    const { writableAccountConfig } = await helper;
    const config = { label: 'QQ', nodes: [
        { id: 'retained', type: 'httpApi', enabled: false, tokenPresent: true, secretPresent: true },
        { id: 'changed', type: 'httpPost', enabled: true, token: 'replacement', secret: 'new-signing-secret' },
        { id: 'cleared', type: 'httpPost', enabled: false, token: '', secret: '' }
    ] };
    const result = writableAccountConfig(config);
    assert.equal(Object.hasOwn(result.nodes[0], 'token'), false);
    assert.equal(Object.hasOwn(result.nodes[0], 'secret'), false);
    assert.equal(result.nodes[1].token, 'replacement');
    assert.equal(result.nodes[1].secret, 'new-signing-secret');
    assert.equal(result.nodes[2].token, '');
    assert.equal(result.nodes[2].secret, '');
});

test('node serialization preserves every normalized connection setting', async () => {
    const { writableAccountConfig } = await helper;
    for (const type of ['httpApi', 'httpPost', 'wsServer', 'wsClient']) {
        const normalized = nodeConfig({
            id: type, label: 'Custom node', type, enabled: true,
            token: 'node-token', secret: 'signing-secret', quickOperations: false, role: 'Event',
            url: type === 'wsClient' ? 'wss://bot.example/ws' : 'https://bot.example/events',
            heartbeatMs: 21000, reconnectMinMs: 250, reconnectMaxMs: 12000,
            timeoutMs: 7000, pingTimeoutMs: 3000, maxPending: 8,
            ratePerSecond: 15, burst: 25, eventBufferSize: 800, eventMaxAgeMs: 45000
        }, 0);
        const saved = writableAccountConfig({ label: 'QQ', nodes: [normalized] });
        assert.deepEqual(saved.nodes[0], normalized, type + ' loses an editable connection setting');
    }
});

test('GET config can disable and re-enable nodes without changing bridge installation', async t => {
    const { writableAccountConfig } = await helper;
    const parent = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'config-save-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const accounts = new Accounts(root);
    const manager = await createManager({ root, accounts, startAccounts: false });
    t.after(() => manager.close());
    const app = manager.app;
    const initialized = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'administrator-password'
    } });
    assert.equal(initialized.statusCode, 200);
    const headers = {
        cookie: initialized.headers['set-cookie'].split(';')[0],
        'x-csrf-token': initialized.json().data.csrf
    };
    const created = await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: {
        id: 'alpha', label: 'QQ', expectedUin: '1000000001', nodes: [
            { id: 'listener', type: 'httpApi', enabled: true, token: 'private-token' },
            { id: 'outgoing', type: 'httpPost', enabled: true, url: 'http://127.0.0.1:17700/events',
                token: 'outgoing-token', secret: 'private-signing-secret' }
        ]
    } });
    assert.equal(created.statusCode, 200);
    const response = await app.inject({ url: '/api/accounts/alpha/config', headers });
    assert.equal(response.statusCode, 200);
    const draft = response.json().data;
    assert.equal(draft.bridgeInstalled, true);
    assert.equal(draft.nodes[0].tokenPresent, true);
    assert.equal(Object.hasOwn(draft.nodes[0], 'token'), false);
    assert.equal(draft.nodes[1].secretPresent, true);
    draft.nodes = draft.nodes.map(node => ({ ...node, enabled: false }));
    const saved = await app.inject({ method: 'PATCH', url: '/api/accounts/alpha/config', headers,
        payload: writableAccountConfig(draft) });
    assert.equal(saved.statusCode, 200);
    assert.equal(accounts.get('alpha').bridgeInstalled, true);
    assert.equal(accounts.get('alpha').nodes.every(node => node.enabled === false), true);
    assert.equal(accounts.get('alpha').nodes[0].token, 'private-token');
    assert.equal(accounts.get('alpha').nodes[1].token, 'outgoing-token');
    assert.equal(accounts.get('alpha').nodes[1].secret, 'private-signing-secret');
    const reread = await app.inject({ url: '/api/accounts/alpha/config', headers });
    assert.equal(reread.json().data.bridgeInstalled, true);
    assert.equal(reread.json().data.nodes.every(node => node.enabled === false), true);
    const enableDraft = reread.json().data;
    enableDraft.nodes = enableDraft.nodes.map(node => ({ ...node, enabled: true }));
    const enabled = await app.inject({ method: 'PATCH', url: '/api/accounts/alpha/config', headers,
        payload: writableAccountConfig(enableDraft) });
    assert.equal(enabled.statusCode, 200);
    const enabledConfig = await app.inject({ url: '/api/accounts/alpha/config', headers });
    assert.equal(enabledConfig.statusCode, 200);
    assert.equal(enabledConfig.json().data.nodes.every(node => node.enabled === true), true);
    assert.equal(enabledConfig.json().data.bridgeInstalled, true);
    assert.equal(accounts.get('alpha').nodes[0].token, 'private-token');
    assert.equal(accounts.get('alpha').nodes[1].token, 'outgoing-token');
    assert.equal(accounts.get('alpha').nodes[1].secret, 'private-signing-secret');
    const revision = accounts.get('alpha').revision;
    const forbidden = await app.inject({ method: 'PATCH', url: '/api/accounts/alpha/config', headers,
        payload: { bridgeInstalled: false } });
    assert.equal(forbidden.statusCode, 400);
    assert.equal(forbidden.json().error.code, 'INVALID_CONFIG');
    assert.equal(accounts.get('alpha').bridgeInstalled, true);
    assert.equal(accounts.get('alpha').revision, revision);
});
