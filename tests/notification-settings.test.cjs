'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createManager } = require('../src/manager/server.cjs');
const { Accounts, notificationSelection, profile } = require('../src/manager/accounts.cjs');
const { Backups, decode } = require('../src/manager/backups.cjs');

async function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp');
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'notification-settings-'));
    const children = [], deliveries = [];
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 32, total: 2 ** 33 }), spawnAccount: options => {
        const child = new EventEmitter(); child.pid = 20000 + children.length; child.env = options.env;
        child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
        children.push(child); return child;
    }, displayBusy: () => false });
    accounts.customPlatform = true;
    const manager = await createManager({ root, accounts, startAccounts: false, notificationOptions: {
        fetch: async (url, request) => { deliveries.push({ url, request, body: JSON.parse(request.body) }); return { ok: true }; }
    } });
    t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const boot = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'notification-panel-test-password'
    } });
    assert.equal(boot.statusCode, 200);
    const headers = { cookie: boot.headers['set-cookie'].split(';')[0], 'x-csrf-token': boot.json().data.csrf };
    const request = (method, url, payload, supplied = headers) => manager.app.inject({ method, url, headers: supplied, ...(payload === undefined ? {} : { payload }) });
    const configure = () => request('PUT', '/api/notifications', { offlineDelaySeconds: 0, channels: [{
        id: 'ops.webhook', name: 'Operations', type: 'webhook', enabled: true,
        url: 'http://127.0.0.1:12345/notify?key=private-url-key', token: 'private-webhook-token'
    }] });
    return { root, manager, accounts, headers, request, configure, children, deliveries };
}

test('notification management requires authentication and CSRF and never echoes channel secrets', async t => {
    const { root, request, configure } = await fixture(t);
    assert.equal((await request('GET', '/api/notifications', undefined, {})).statusCode, 401);
    assert.equal((await request('PUT', '/api/notifications', {}, {})).statusCode, 401);
    const configured = await configure();
    assert.equal(configured.statusCode, 200);
    const saved = configured.json().data;
    assert.equal(saved.offlineDelaySeconds, 0);
    assert.equal(saved.channels[0].urlPresent, true);
    assert.equal(saved.channels[0].tokenPresent, true);
    assert.equal(saved.channels[0].endpoint, 'http://127.0.0.1:12345');
    for (const response of [configured, await request('GET', '/api/notifications')]) {
        assert.equal(response.body.includes('private-url-key'), false);
        assert.equal(response.body.includes('private-webhook-token'), false);
    }
    const file = path.join(root, 'work/control/notifications.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).channels[0].token, 'private-webhook-token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('notification channel validation fails atomically and omitted credentials survive saves', async t => {
    const { root, request, configure, headers } = await fixture(t);
    const first = (await configure()).json().data;
    const file = path.join(root, 'work/control/notifications.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal((await request('PUT', '/api/notifications', { channels: [{ ...first.channels[0], name: 'Changed' }], offlineDelaySeconds: -1 })).statusCode, 400);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal((await request('PUT', '/api/notifications', { channels: [], offlineDelaySeconds: 1 }, { cookie: headers.cookie })).statusCode, 403);
    assert.equal((await request('PUT', '/api/notifications', { channels: [{ ...first.channels[0], name: 'Changed' }], offlineDelaySeconds: 8 })).statusCode, 200);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.channels[0].token, 'private-webhook-token');
    assert.equal(persisted.channels[0].url, 'http://127.0.0.1:12345/notify?key=private-url-key');
});

test('account notification binding is isolated and hot, preserving QQ process and protocol secrets', async t => {
    const { accounts, request, configure, children, headers } = await fixture(t);
    await configure();
    accounts.create({ id: 'alpha', expectedUin: '2068886823', nodes: [{ id: 'bot', type: 'wsClient', url: 'ws://127.0.0.1:12345', token: 'node-secret' }] });
    accounts.create({ id: 'beta', expectedUin: '2441760163' });
    await accounts.start('alpha');
    const child = accounts.processes.get('alpha');
    const selection = { enabled: true, channelIds: ['ops.webhook'] };
    const saved = await request('PATCH', '/api/accounts/alpha/notifications', selection);
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().data, selection);
    assert.equal(accounts.processes.get('alpha'), child);
    assert.equal(children.length, 1);
    assert.equal(accounts.get('alpha').nodes[0].token, 'node-secret');
    assert.deepEqual((await request('GET', '/api/accounts/beta/notifications')).json().data, { enabled: false, channelIds: [] });
    assert.equal((await request('PATCH', '/api/accounts/alpha/notifications', selection, { cookie: headers.cookie })).statusCode, 403);
    assert.equal((await request('GET', '/api/accounts/missing/notifications')).statusCode, 404);
    assert.equal((await request('PATCH', '/api/accounts/alpha/notifications', { enabled: true, channelIds: ['missing'] })).statusCode, 400);
    assert.deepEqual(accounts.get('alpha').notifications, selection);
    // The node editor omits notification bindings, so an old draft cannot overwrite a hot save.
    const { writableAccountConfig } = await import('../webui/src/account-config.mjs');
    assert.equal(Object.hasOwn(writableAccountConfig({ label: 'old', nodes: [], notifications: { enabled: false, channelIds: [] } }), 'notifications'), false);
    const normalized = profile({ label: 'updated' }, accounts.get('alpha'));
    assert.deepEqual(normalized.notifications, selection);
});

test('notifications reject invalid account bindings without creating arbitrary stored fields', () => {
    for (const value of [null, [], true, {}, { enabled: 'true', channelIds: [] }, { enabled: true, channelIds: ['x', 'x'] },
        { enabled: false, channelIds: ['../other'] }, { enabled: false, channelIds: [], token: 'secret' }]) {
        assert.throws(() => notificationSelection(value), { code: 'INVALID_CONFIG' });
    }
    assert.deepEqual(notificationSelection(), { enabled: false, channelIds: [] });
    assert.deepEqual(profile({}, { id: 'legacy' }).notifications, { enabled: false, channelIds: [] });
});

test('notification test is explicit, bounded and reports the actual transport result', async t => {
    const { request, configure, deliveries } = await fixture(t);
    await configure();
    await request('GET', '/api/notifications');
    assert.equal(deliveries.length, 0);
    const sent = await request('POST', '/api/notifications/channels/ops.webhook/test', {});
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().data.success, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].body.event, 'test');
    assert.equal(deliveries[0].request.headers.Authorization, 'Bearer private-webhook-token');
    assert.equal((await request('POST', '/api/notifications/channels/ops.webhook/test', {})).statusCode, 429);
    assert.equal(deliveries.length, 1);
    assert.equal((await request('POST', '/api/notifications/channels/unknown/test', {})).statusCode, 404);
});

test('failed and disabled notification tests never return a successful management response', async t => {
    const { manager, request, configure } = await fixture(t);
    await configure();
    manager.notifications.fetch = async () => ({ ok: false });
    const failed = await request('POST', '/api/notifications/channels/ops.webhook/test', {});
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error.code, 'NOTIFICATION_DELIVERY_FAILED');
    assert.equal((await request('GET', '/api/notifications')).json().data.deliveries.at(-1).success, false);
    assert.equal((await request('PUT', '/api/notifications', { channels: [{
        id: 'disabled', name: 'Disabled', type: 'webhook', url: 'http://127.0.0.1:12345', enabled: false
    }] })).statusCode, 200);
    const disabled = await request('POST', '/api/notifications/channels/disabled/test', {});
    assert.equal(disabled.statusCode, 409);
});

test('removing a channel permits retaining or disabling its existing account binding without adding unknown channels', async t => {
    const { accounts, request, configure } = await fixture(t);
    await configure();
    accounts.create({ id: 'alpha' });
    assert.equal((await request('PATCH', '/api/accounts/alpha/notifications', { enabled: true, channelIds: ['ops.webhook'] })).statusCode, 200);
    assert.equal((await request('PUT', '/api/notifications', { channels: [] })).statusCode, 200);
    const disabled = await request('PATCH', '/api/accounts/alpha/notifications', { enabled: false, channelIds: ['ops.webhook'] });
    assert.equal(disabled.statusCode, 200);
    assert.deepEqual(disabled.json().data, { enabled: false, channelIds: ['ops.webhook'] });
    assert.equal((await request('PATCH', '/api/accounts/alpha/notifications', { enabled: false, channelIds: ['not-previously-bound'] })).statusCode, 400);
});

test('manager observes only authenticated QQ transitions and suppresses intentional stops', async t => {
    const { accounts, manager, request, configure, deliveries } = await fixture(t);
    await configure();
    accounts.create({ id: 'alpha', expectedUin: '2068886823' });
    await accounts.start('alpha');
    await request('PATCH', '/api/accounts/alpha/notifications', { enabled: true, channelIds: ['ops.webhook'] });
    const health = { selfId: '2068886823', sessionEpoch: 'first', authorized: true, ready: true, online: true, nickname: 'Real QQ nickname' };
    accounts.healths.set('alpha', health); accounts.states.set('alpha', 'online');
    manager.notifications.observe();
    assert.equal(deliveries.length, 0);
    accounts.healths.set('alpha', { ...health, online: false }); accounts.states.set('alpha', 'offline');
    manager.notifications.observe();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].body.event, 'offline');
    assert.equal(deliveries[0].body.uin, '2068886823');
    accounts.healths.set('alpha', health); accounts.states.set('alpha', 'online');
    manager.notifications.observe();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].body.event, 'online');
    await accounts.stop('alpha'); manager.notifications.observe();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deliveries.length, 2);
});

test('ordinary backup and restore disable account notifications and never embed channel credentials', async t => {
    const { accounts, root, configure } = await fixture(t);
    await configure();
    accounts.create({ id: 'alpha', expectedUin: '2068886823', notifications: { enabled: true, channelIds: ['ops.webhook'] } });
    const backups = new Backups(root, accounts);
    const saved = await backups.create({ profileIds: ['alpha'], kind: 'ordinary' });
    const document = await decode(fs.readFileSync(backups.file(saved.id)));
    assert.deepEqual(document.profiles[0].config.notifications, { enabled: false, channelIds: ['ops.webhook'] });
    assert.equal(JSON.stringify(document).includes('private-webhook-token'), false);
    assert.equal(JSON.stringify(document).includes('private-url-key'), false);
    // Even an older ordinary archive with enabled=true cannot enable restored notifications.
    const { encode } = require('../src/manager/backups.cjs');
    document.profiles[0].config.notifications.enabled = true;
    const uploaded = backups.upload(await encode(document));
    const preview = await backups.preview({ backupId: uploaded.id });
    await backups.apply(preview.previewId);
    assert.equal(accounts.get('alpha').notifications.enabled, false);
    assert.equal(accounts.get('alpha').desired, 'stopped');
});
