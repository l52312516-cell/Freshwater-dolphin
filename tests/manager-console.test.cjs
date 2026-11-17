'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManager } = require('../src/manager/server.cjs');
const { createLogger } = require('../src/log.cjs');
const { LogReader } = require('../src/manager/logs.cjs');

async function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-console-'));
    const manager = await createManager({ root, startAccounts: false });
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    manager.accounts.create({ id: 'one' }); manager.accounts.create({ id: 'two' });
    const result = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'administrator-password' } });
    const headers = { cookie: result.headers['set-cookie'].split(';')[0], 'x-csrf-token': result.json().data.csrf };
    const api = (url, method = 'GET', payload) => manager.app.inject({ url: '/api/' + url, method, headers, ...(payload === undefined ? {} : { payload }) });
    return { manager, root, api, headers };
}
test('old QR routes are absent and bridge operations require administrator CSRF', async t => {
    const { manager, api, headers } = await fixture(t);
    for (const [route, method] of [['login', 'GET'], ['qr/capture', 'POST'], ['qr/refresh', 'POST'], ['qr/image', 'GET']])
        assert.equal((await api('accounts/one/' + route, method)).statusCode, 404);
    assert.equal((await manager.app.inject({ url: '/api/accounts/one/uninstall', method: 'POST' })).statusCode, 401);
    assert.equal((await manager.app.inject('/api/accounts/one/avatar')).statusCode, 401);
    assert.equal((await manager.app.inject('/api/accounts/one/avatars/user/123')).statusCode, 401);
    assert.equal((await manager.app.inject('/api/accounts/one/avatars/group/123')).statusCode, 401);
    assert.equal((await api('accounts/one/avatar')).statusCode, 404);
    assert.equal((await manager.app.inject({ url: '/api/accounts/one/uninstall', method: 'POST', headers: { cookie: headers.cookie } })).statusCode, 403);
    assert.equal((await api('accounts/one/uninstall', 'POST', {})).json().data.bridgeInstalled, false);
    assert.equal((await api('accounts/one/install', 'POST', {})).json().data.bridgeInstalled, true);
    assert.equal((await api('accounts/one', 'DELETE', { confirmId: 'two' })).statusCode, 409);
    assert.equal((await api('accounts/one', 'DELETE', { confirmId: 'one' })).json().data.deleted, true);
    assert.equal(manager.accounts.get('two').id, 'two');
});

test('contact avatar routes authenticate and keep user and group cache entries separate', async t => {
    const { manager, root, api } = await fixture(t);
    manager.accounts.get('one').boundUin = '1000000001';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCU0AAAAASUVORK5CYII=', 'base64');
    const group = Buffer.concat([png, Buffer.from('group')]);
    const directory = path.join(root, 'work/cache/avatars');
    fs.writeFileSync(path.join(directory, '1000000003.img'), png);
    fs.writeFileSync(path.join(directory, 'group-1000000003.img'), group);
    for (const [kind, bytes] of [['user', png], ['group', group]]) {
        const result = await api('accounts/one/avatars/' + kind + '/1000000003');
        assert.equal(result.statusCode, 200); assert.match(result.headers['content-type'], /^image\/png/);
        assert.deepEqual(result.rawPayload, bytes);
    }
    assert.equal((await api('accounts/one/avatars/url/1000000003')).statusCode, 400);
    assert.equal((await api('accounts/one/avatars/user/not-a-number')).statusCode, 400);
    assert.equal((await api('accounts/missing/avatars/user/1000000003')).statusCode, 404);
    assert.equal((await api('accounts/two/avatars/user/1000000003')).statusCode, 404);
});
test('authenticated logs preserve original text and filters while exported logs strip content', async t => {
    const { manager, root, api } = await fixture(t);
    const directory = path.join(manager.accounts.location('one'), 'logs');
    const log = createLogger(directory);
    log.message({ kind: 'message', event: 'message_received', profileId: 'one', selfId: '123', messageId: 41,
        messageType: 'group', userId: '456', groupId: '789', senderName: '测试昵称', content: '  <script>hello</script>\n第二行  ' });
    log.message({ kind: 'message', event: 'message_received', profileId: 'two', selfId: '123', messageId: 42,
        messageType: 'private', userId: '456', content: 'wrong-profile-never-return' });
    fs.appendFileSync(path.join(directory, 'adapter.jsonl'), JSON.stringify({ time: new Date().toISOString(), event: 'node_failed', code: 'TOKEN_BAD', token: 'never-return-credential' }) + '\n');
    assert.equal((await manager.app.inject('/api/logs')).statusCode, 401);
    const rows = (await api('logs?profileId=one&component=message&level=SUCCESS&query=hello')).json().data;
    assert.equal(rows.length, 1); assert.equal(rows[0].content, '  <script>hello</script>\n第二行  ');
    const exported = await api('logs/export?profileId=one');
    assert.equal(exported.statusCode, 200);
    for (const text of ['hello', '测试昵称', 'never-return-credential', 'wrong-profile-never-return']) assert.equal(exported.body.includes(text), false);
    assert.equal((await api('logs?profileId=missing')).statusCode, 404);
    const reader = new LogReader(root, manager.accounts);
    fs.copyFileSync(path.join(directory, 'messages.jsonl'), path.join(directory, 'messages.jsonl.1'));
    assert.equal(reader.read({ profileId: 'one', component: 'message' }).length, 1);
    reader.close();
});
test('long escaped original content stays visible within a bounded reader response', async t => {
    const { manager, root } = await fixture(t);
    const log = createLogger(path.join(manager.accounts.location('one'), 'logs'));
    const content = '\u0001'.repeat(65536);
    log.message({ kind: 'message', event: 'message_received', profileId: 'one', selfId: '123', messageId: 43,
        messageType: 'private', userId: '456', content });
    const reader = new LogReader(root, manager.accounts);
    const rows = reader.read(); assert.equal(rows.length, 1); assert.equal(rows[0].content, content);
    assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 512 * 1024);
    reader.close(); assert.equal(reader.cacheBytes, 0);
});

test('message filtering reaches chat logs when adapter I/O would exhaust the time budget', async t => {
    const { manager, root } = await fixture(t);
    const log = createLogger(path.join(manager.accounts.location('one'), 'logs'));
    log('node_failed', { code: 'UNSUPPORTED' });
    log.message({ kind: 'message', event: 'message_received', profileId: 'one', selfId: '123', messageId: 44,
        messageType: 'private', userId: '456', content: 'filter-budget-regression' });
    let time = 0;
    const reader = new LogReader(root, manager.accounts, { maxScanMs: 1, now: () => time += 10 });
    const rows = reader.read({ profileId: 'one', component: 'message', level: 'SUCCESS', query: 'filter-budget-regression' });
    assert.equal(rows.length, 1); assert.equal(rows[0].messageId, 44);
    reader.close();
});
test('management SSE limits open streams for one authenticated session', async t => {
    const { manager, api, headers } = await fixture(t);
    const origin = await manager.app.listen({ host: '127.0.0.1', port: 0 });
    const controllers = [];
    try {
        for (let index = 0; index < 4; index++) {
            const controller = new AbortController(); controllers.push(controller);
            const response = await fetch(origin + '/api/events', { headers: { cookie: headers.cookie }, signal: controller.signal });
            assert.equal(response.status, 200);
        }
        const rejected = await api('events'); assert.equal(rejected.statusCode, 429);
        assert.equal(rejected.json().error.code, 'STREAM_LIMIT');
    } finally { for (const controller of controllers) controller.abort(); }
});
