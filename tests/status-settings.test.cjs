'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManager } = require('../src/manager/server.cjs');

test('status command settings have public defaults, hot partial updates and atomic validation', async t => {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'status-settings-'));
    const manager = await createManager({ root, startAccounts: false });
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const boot = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'status-settings-password'
    } });
    const headers = { cookie: boot.headers['set-cookie'].split(';')[0], 'x-csrf-token': boot.json().data.csrf };
    assert.deepEqual((await manager.app.inject({ url: '/api/settings', headers })).json().data.statusCommand, { enabled: true, trigger: '#fd' });
    const patch = payload => manager.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload });
    const disabled = await patch({ statusCommand: { enabled: false, trigger: '  #FW-测试  ' } });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().data.needsRestart, false);
    assert.deepEqual(disabled.json().data.statusCommand, { enabled: false, trigger: '#fw-测试' });
    const file = path.join(root, 'work/control/settings.json'), before = fs.readFileSync(file, 'utf8');
    for (const value of [null, true, { enabled: 'false', trigger: '#fw' }, { enabled: true, trigger: '' },
        { enabled: true, trigger: '#f w' }, { enabled: true, trigger: '#fw\nnext' },
        { enabled: true, trigger: '🐬'.repeat(33) }, { enabled: false, trigger: '#fw', unknown: true }]) {
        const result = await patch({ maxAccounts: 3, statusCommand: value });
        assert.equal(result.statusCode, 400);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    const other = await patch({ rkey: { fallbackServers: [] }, musicSignUrl: 'https://sign.example/card', musicSignKey: 'test-private-key' });
    assert.equal(other.statusCode, 200);
    assert.deepEqual(other.json().data.statusCommand, { enabled: false, trigger: '#fw-测试' });
    assert.equal(Object.hasOwn(other.json().data, 'musicSignKey'), false);
    assert.equal((await manager.app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie: headers.cookie }, payload: { statusCommand: { enabled: true, trigger: '#fw' } } })).statusCode, 403);
    const reopened = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(reopened.statusCommand, { enabled: false, trigger: '#fw-测试' });
});
