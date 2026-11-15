'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createManager } = require('../src/manager/server.cjs');

test('management and public action routes accept large image actions without raising other body limits', async t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-action-limits-'));
    const manager = await createManager({ root, startAccounts: false });
    const forwarded = [];
    const server = http.createServer((request, response) => {
        let size = 0;
        request.on('data', bytes => { size += bytes.length; });
        request.on('end', () => {
            forwarded.push({ url: request.url, size });
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { size } }));
        });
    });
    t.after(async () => { await manager.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    manager.accounts.create({ id: 'one', nodes: [{ id: 'api', type: 'httpApi', token: 'onebot-secret' }] });
    manager.accounts.gateway = () => server.address().port;
    const payload = { action: 'send_group_msg', params: { group_id: 200,
        message: [{ type: 'image', data: { file: 'base64://' + 'A'.repeat(3 * 1024 * 1024) } }] } };
    for (const url of ['/onebot/one/api', '/onebot/one/api/send_group_msg']) {
        const result = await manager.app.inject({ method: 'POST', url, payload });
        assert.equal(result.statusCode, 200);
        assert.equal(result.json().data.size, Buffer.byteLength(JSON.stringify(payload)));
    }
    assert.equal(forwarded.length, 2);
    const token = fs.readFileSync(manager.auth.setup, 'utf8').trim();
    const login = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { setupToken: token, password: 'a-strong-panel-password' } });
    const headers = { cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().data.csrf };
    let calls = 0;
    manager.accounts.action = async (_id, action, params) => { calls++; return { status: 'ok', action, size: params.message[0].data.file.length }; };
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/accounts/one/action', headers, payload })).statusCode, 200);
    assert.equal(calls, 1);
    assert.equal((await manager.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload })).statusCode, 413);
    assert.equal((await manager.app.inject({ method: 'POST', url: '/api/accounts/one/action', payload })).statusCode, 401);
});
