'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createManager } = require('../src/manager/server.cjs');
const { runtimeInstance } = require('../src/manager/runtime-instance.cjs');

test('local runtime identity is optional and rejects incomplete credentials', () => {
    assert.equal(runtimeInstance({}), null);
    assert.throws(() => runtimeInstance({ FWD_INSTANCE_ID: 'a'.repeat(32) }), { code: 'INVALID_CONFIG' });
});
test('launcher identity handshake does not grant administrator or cross-origin access', async t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'runtime-identity-'));
    const previous = [process.env.FWD_INSTANCE_ID, process.env.FWD_INSTANCE_TOKEN];
    process.env.FWD_INSTANCE_ID = 'a'.repeat(32); process.env.FWD_INSTANCE_TOKEN = 'b'.repeat(64);
    let manager;
    try { manager = await createManager({ root, startAccounts: false }); }
    finally {
        for (const [index, key] of ['FWD_INSTANCE_ID', 'FWD_INSTANCE_TOKEN'].entries()) {
            if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
        }
    }
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true }); });
    const headers = { authorization: 'Bearer ' + 'b'.repeat(64) };
    assert.equal((await manager.app.inject('/api/runtime/instance')).statusCode, 401);
    assert.equal((await manager.app.inject({ url: '/api/runtime/instance', headers: { ...headers, origin: 'http://127.0.0.1:4090' } })).statusCode, 401);
    const response = await manager.app.inject({ url: '/api/runtime/instance', headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { instanceId: 'a'.repeat(32), releaseVersion: require('../package.json').version });
    assert.equal((await manager.app.inject({ url: '/api/accounts', headers })).statusCode, 401);
    assert.equal((await manager.app.inject({ url: '/api/qq-runtimes', headers })).statusCode, 401);
    assert.equal(response.body.includes('b'.repeat(64)), false);
});

test('deferred runtime blocks management until authenticated, idempotent account activation', async t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'runtime-deferred-'));
    const keys = ['FWD_INSTANCE_ID', 'FWD_INSTANCE_TOKEN', 'FWD_RUNTIME_DEFER_ACCOUNTS'];
    const previous = keys.map(key => process.env[key]);
    Object.assign(process.env, { FWD_INSTANCE_ID: 'a'.repeat(32), FWD_INSTANCE_TOKEN: 'b'.repeat(64), FWD_RUNTIME_DEFER_ACCOUNTS: '1' });
    let manager;
    try { manager = await createManager({ root }); }
    finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true }); });
    let initialized = 0; manager.accounts.initialize = async () => { initialized++; };
    const headers = { authorization: 'Bearer ' + 'b'.repeat(64) };
    assert.equal((await manager.app.inject('/api/auth/state')).statusCode, 503);
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/runtime/activate' })).statusCode, 401);
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/runtime/activate', headers: { ...headers, origin: 'http://localhost' } })).statusCode, 401);
    assert.equal(initialized, 0);
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/runtime/activate', headers })).json().activated, true);
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/runtime/activate', headers })).statusCode, 200);
    assert.equal(initialized, 1);
    assert.equal((await manager.app.inject('/api/auth/state')).statusCode, 200);
    assert.equal((await manager.app.inject({ url: '/api/accounts', headers })).statusCode, 401);
});
