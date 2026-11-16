'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Accounts } = require('../src/manager/accounts.cjs');
const { Storage } = require('../src/manager/storage.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { createLogger } = require('../src/log.cjs');
const { atomic, read } = require('../src/manager/files.cjs');
const { createManager } = require('../src/manager/server.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const MIB = 1024 * 1024;

function fixture(t, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'storage-test-'));
    const children = [];
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 31, total: 2 ** 32 }), displayBusy: () => false,
        spawnAccount: () => {
            const child = new EventEmitter(); child.pid = 800 + children.length;
            child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; };
            children.push(child); return child;
        } });
    accounts.customPlatform = true;
    const settings = { version: 1, maxAccounts: 2, port: 4090, host: '0.0.0.0', publicBaseUrl: 'https://example.test' };
    const settingsFile = path.join(root, 'work/control/settings.json'); atomic(settingsFile, settings);
    const backups = { locked: false };
    const storage = new Storage(root, accounts, { settings, settingsFile, backups, ...options });
    t.after(async () => { storage.close(); await accounts.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const account = id => {
        accounts.create({ id, label: 'Account ' + id }); const base = accounts.location(id);
        for (const name of ['logs', 'data', 'media', 'state', 'home', 'config', 'qq-root', 'rpc', 'temp']) fs.mkdirSync(path.join(base, name), { recursive: true });
        return base;
    };
    return { root, accounts, settings, settingsFile, backups, storage, account, children };
}
function file(base, name, contents, ageDays = 0) {
    const target = path.join(base, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents); const at = new Date(Date.now() - ageDays * 86400000); fs.utimesSync(target, at, at);
    return target;
}
function record(nativeId) { return { chatType: 2, peerUid: '2000000001', msgId: nativeId, msgSeq: nativeId,
    senderUin: '1000000003', elements: [{ elementType: 1, textElement: { content: 'private chat content' } }] }; }

test('storage reports per-account and global categories without counting login, program, RPC or temp files', t => {
    const f = fixture(t), a = f.account('alpha'), b = f.account('beta');
    file(a, 'logs/adapter.jsonl', 'a'.repeat(10)); file(a, 'data/1000000001.json', 'a'.repeat(20));
    file(a, 'media/picture.png', 'a'.repeat(30)); file(b, 'media/picture.png', 'b'.repeat(40));
    file(f.root, 'work/logs/manager.log', 'm'.repeat(5));
    for (const name of ['home/login.dat', 'config/qq.json', 'qq-root/QQ', 'rpc/request.json', 'temp/old.tmp', 'data/1000000001.json.dead.tmp']) file(a, name, Buffer.alloc(1000), 30);
    const value = f.storage.snapshot();
    assert.deepEqual(value.policy, { logMaxMiB: 1024, logRetentionDays: 7, enabled: false });
    assert.deepEqual(value.totals, { logsBytes: 15, historyBytes: 20, mediaBytes: 70, totalBytes: 105, files: 5 });
    assert.equal(value.accounts[0].totalBytes, 60); assert.equal(value.accounts[1].media.bytes, 40);
    assert.equal(value.accounts.every(item => item.canClean), true);
    assert.equal(value.accounts[0].history.scanned, true); assert.equal(value.partial, false);
    assert.equal(value.scanned.accounts, 2); assert.equal(value.scanned.files, 5);
    assert.equal(Object.hasOwn(value.totals, 'emojiBytes'), false);
    assert.equal(f.settings.storage, undefined);
});

test('storage policy persists on the shared settings object and rejects invalid or unknown input', t => {
    const f = fixture(t);
    for (const input of [{ logMaxMiB: 0 }, { logMaxMiB: 102401 }, { logMaxMiB: '10' }, { logRetentionDays: -1 },
        { logRetentionDays: 3651 }, { logRetentionDays: 1.5 }, { enabled: false }, { maxAccounts: 16 }, null]) {
        assert.throws(() => f.storage.updatePolicy(input), { code: 'INVALID_STORAGE_POLICY' });
    }
    assert.deepEqual(f.storage.updatePolicy({ logMaxMiB: 8, logRetentionDays: 14 }), {
        policy: { logMaxMiB: 8, logRetentionDays: 14, enabled: true } });
    assert.equal(f.settings.storage.logMaxMiB, 8); assert.equal(read(f.settingsFile).publicBaseUrl, 'https://example.test');
    const reopened = new Storage(f.root, f.accounts, { settings: read(f.settingsFile), settingsFile: f.settingsFile });
    t.after(() => reopened.close());
    assert.deepEqual(reopened.snapshot().policy, f.storage.snapshot().policy);
});

test('zero-day retention preserves old logs under quota and still enforces the size limit', async t => {
    const f = fixture(t), a = f.account('alpha');
    const old = file(a, 'logs/old.log.1', Buffer.alloc(256 * 1024), 90);
    f.storage.updatePolicy({ logMaxMiB: 1, logRetentionDays: 0 });
    const under = await f.storage.cleanup({ scope: 'logs' });
    assert.equal(under.reclaimedBytes, 0);
    assert.equal(fs.existsSync(old), true);
    file(a, 'logs/new.log', Buffer.alloc(900 * 1024), 1);
    const over = await f.storage.cleanup({ scope: 'logs' });
    assert.equal(over.deletedFiles, 1);
    assert.equal(fs.existsSync(old), false);
    assert.equal(over.reclaimedBytes, 256 * 1024);
});

test('log cleanup applies retention and a shared quota while append writers keep working', async t => {
    const f = fixture(t), a = f.account('alpha'), b = f.account('beta');
    const active = file(a, 'logs/adapter.jsonl', Buffer.alloc(700 * 1024), 1);
    const rotated = file(b, 'logs/qq.log.1', Buffer.alloc(700 * 1024), 2);
    const expired = file(f.root, 'work/logs/manager.log', 'old manager log', 8);
    const login = file(a, 'home/login.dat', 'keep login', 30);
    const fd = fs.openSync(expired, 'a'); t.after(() => fs.closeSync(fd));
    f.storage.updatePolicy({ logMaxMiB: 1, logRetentionDays: 7 });
    const result = await f.storage.cleanup({ scope: 'logs' });
    assert.equal(result.deletedFiles, 1); assert.equal(result.changedFiles, 1); assert.equal(result.partial, false);
    assert.equal(result.reclaimedBytes, 700 * 1024 + Buffer.byteLength('old manager log'));
    assert.equal(fs.existsSync(rotated), false); assert.equal(fs.statSync(active).size, 700 * 1024);
    assert.equal(fs.statSync(expired).size, 0); fs.writeSync(fd, 'new manager log');
    assert.equal(fs.readFileSync(expired, 'utf8'), 'new manager log');
    const logger = createLogger(path.join(a, 'logs'));
    logger.message({ profileId: 'alpha', selfId: '1000000001', messageType: 'private', peerId: '1000000003',
        userId: '1000000003', messageId: 1, event: 'message_received', content: 'after storage cleanup' });
    assert.equal(fs.readFileSync(login, 'utf8'), 'keep login');
    assert.ok(f.storage.snapshot().totals.logsBytes < MIB);
});

test('periodic cleanup stays disabled on first deployment and stops when the service closes', async t => {
    const f = fixture(t, { intervalMs: 15 }), a = f.account('alpha');
    const target = file(a, 'logs/adapter.jsonl', 'old text', 8);
    f.storage.start(); await pause(50); assert.equal(fs.readFileSync(target, 'utf8'), 'old text');
    f.storage.updatePolicy({ logMaxMiB: 1, logRetentionDays: 7 });
    for (let attempt = 0; attempt < 80 && fs.statSync(target).size; attempt++) await pause(10);
    assert.equal(fs.statSync(target).size, 0); assert.equal(f.storage.lastCleanup.scope, 'logs');
    f.storage.close(); file(a, 'logs/adapter.jsonl', 'retain after close', 8); await pause(40);
    assert.equal(fs.readFileSync(target, 'utf8'), 'retain after close'); assert.equal(f.storage.timer, null);
    await assert.rejects(f.storage.cleanup({ scope: 'logs' }), { code: 'CLOSING' });
});

test('clearing history preserves allocated IDs, native locators and emitted flags across reopening', async t => {
    const f = fixture(t), a = f.account('alpha'), directory = path.join(a, 'data');
    const account = '1000000001', store = new MessageStore({ directory });
    const first = store.remember(account, { ...record('90071992547409931234'),
        senderUid: 'u_friend', msgTime: '1794621690', clientSeq: '428' });
    const second = store.remember(account, record('90071992547409931235'));
    store.setEvent(account, first.id, { message: [{ type: 'text', data: { text: 'cached event' } }] }, true);
    store.setRecalled(account, second.id, { message_id: second.id, post_type: 'notice' }, true); store.close();
    const before = read(path.join(directory, account + '.json'));
    const result = await f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'history', confirmId: 'alpha' });
    assert.equal(result.changedFiles, 1); assert.equal(result.deletedFiles, 0); assert.equal(result.clearedMessages, 2);
    assert.ok(result.reclaimedBytes > 0); assert.equal(result.partial, false);
    const after = read(path.join(directory, account + '.json'));
    assert.equal(after.nextId, before.nextId); assert.equal(after.entries.length, 2);
    assert.deepEqual(after.entries.map(item => item.locator), before.entries.map(item => item.locator));
    assert.equal(after.entries[0].emitted, true); assert.equal(after.entries[1].recallEmitted, true);
    assert.ok(after.entries.every(item => !item.record && !item.event && !item.recallEvent));
    const reopened = new MessageStore({ directory });
    assert.equal(reopened.get(account, first.id).locator.nativeId, '90071992547409931234');
    assert.equal(reopened.find(account, { peer: { chatType: 2, peerUid: '2000000001' },
        clientSeq: '428', senderUid: 'u_friend', time: '1794621690' }).id, first.id);
    assert.equal(reopened.remember(account, record('90071992547409931236')).id, 3);
    assert.equal(reopened.remember(account, record('90071992547409931234')).id, first.id); reopened.close();
});

test('history cleanup validates optional author and time metadata before changing any mappings', async t => {
    const f = fixture(t), a = f.account('alpha'), directory = path.join(a, 'data');
    const account = '1000000001', store = new MessageStore({ directory });
    store.remember(account, { ...record('123'), senderUid: 'u_friend', msgTime: '1794621690' }); store.close();
    const target = path.join(directory, account + '.json');
    const source = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const changes of [{ senderUid: '../foreign' }, { senderUid: {} }, { time: '1794621690.1' },
        { time: 1794621690 }, { time: '9007199254740992' }]) {
        const corrupt = structuredClone(source); Object.assign(corrupt.entries[0].locator, changes);
        const bytes = Buffer.from(JSON.stringify(corrupt)); fs.writeFileSync(target, bytes);
        await assert.rejects(f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'history', confirmId: 'alpha' }),
            { code: 'INVALID_MESSAGE_STORE' });
        assert.deepEqual(fs.readFileSync(target), bytes);
    }
});

test('history validates every mapping before any write and leaves unknown temporary files untouched', async t => {
    const f = fixture(t), a = f.account('alpha'), directory = path.join(a, 'data');
    const store = new MessageStore({ directory }); store.remember('1000000001', record('123')); store.close();
    const valid = path.join(directory, '1000000001.json'), bytes = fs.readFileSync(valid);
    file(a, 'data/3000000002.json', '{broken'); const temporary = file(a, 'data/1000000001.json.dead.tmp', 'stale but unproven', 30);
    await assert.rejects(f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'history', confirmId: 'alpha' }), { code: 'INVALID_MESSAGE_STORE' });
    assert.deepEqual(fs.readFileSync(valid), bytes); assert.equal(fs.readFileSync(temporary, 'utf8'), 'stale but unproven');
    assert.equal(f.accounts.busy.size, 0);
});

test('account media cleanup needs exact confirmation and preserves other accounts and all private state', async t => {
    const f = fixture(t), a = f.account('alpha'), b = f.account('beta');
    const media = file(a, 'media/nested/picture.png', 'image'), other = file(b, 'media/picture.png', 'other image');
    const protectedFiles = ['home/login.dat', 'config/qq.json', 'qq-root/QQ', 'rpc/active.json', 'temp/old.tmp', 'data/1000000001.json'];
    for (const name of protectedFiles) file(a, name, 'preserve', 30);
    await assert.rejects(f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'beta' }), { code: 'CONFIRMATION_REQUIRED' });
    await assert.rejects(f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'rpc', confirmId: 'alpha' }), { code: 'INVALID_PARAMS' });
    assert.equal(fs.existsSync(media), true);
    const result = await f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'alpha' });
    assert.equal(result.deletedFiles, 1); assert.equal(result.reclaimedBytes, 5); assert.equal(result.partial, false);
    assert.equal(fs.readFileSync(other, 'utf8'), 'other image');
    for (const name of protectedFiles) assert.equal(fs.readFileSync(path.join(a, name), 'utf8'), 'preserve');
});

test('cleanup rejects live accounts, maintenance, backups and unverified process ownership', async t => {
    const f = fixture(t), a = f.account('alpha'); const media = file(a, 'media/file.upload', 'keep');
    const clean = () => f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'alpha' });
    f.accounts.get('alpha').desired = 'running';
    await assert.rejects(clean(), { code: 'ACCOUNT_RUNNING' }); f.accounts.get('alpha').desired = 'stopped';
    f.accounts.processes.set('alpha', {}); await assert.rejects(clean(), { code: 'ACCOUNT_RUNNING' }); f.accounts.processes.delete('alpha');
    f.accounts.document.maintenance.alpha = { operation: 'backup' };
    await assert.rejects(clean(), { code: 'MAINTENANCE' }); delete f.accounts.document.maintenance.alpha;
    f.backups.locked = true; await assert.rejects(clean(), { code: 'BACKUP_BUSY' }); f.backups.locked = false;
    f.accounts.busy.add('alpha'); await assert.rejects(clean(), { code: 'BUSY' }); f.accounts.busy.delete('alpha');
    file(a, 'state/processes.json', '{unverified'); await assert.rejects(clean(), { code: 'PROCESS_OWNERSHIP' });
    assert.equal(fs.readFileSync(media, 'utf8'), 'keep'); assert.equal(f.storage.snapshot().accounts[0].canClean, false);
});

test('account cleanup owns the lifecycle lock so start and backup cannot race file deletion', async t => {
    const f = fixture(t), a = f.account('alpha'); file(a, 'media/picture.png', 'image');
    const cleanup = f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'alpha' });
    const start = f.accounts.start('alpha'), backup = f.accounts.maintain(['alpha'], 'backup');
    await Promise.all([assert.rejects(start, { code: 'BUSY' }), assert.rejects(backup, { code: 'BUSY' })]);
    assert.equal((await cleanup).deletedFiles, 1); assert.equal(f.children.length, 0); assert.equal(f.accounts.busy.size, 0);
});

test('scans and cleanup do not follow directory junctions or traverse outside work/', async t => {
    const f = fixture(t), a = f.account('alpha');
    const outside = path.join(f.root, 'outside-work'); fs.mkdirSync(outside);
    const protectedFile = file(outside, 'picture.png', 'do not touch');
    fs.symlinkSync(outside, path.join(a, 'media/escape'), 'junction');
    file(a, 'media/owned.png', 'owned');
    const value = f.storage.snapshot();
    assert.equal(value.partial, true); assert.equal(value.accounts[0].media.bytes, 5); assert.equal(value.accounts[0].media.partial, true);
    const result = await f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'alpha' });
    assert.equal(result.partial, true); assert.equal(result.deletedFiles, 1); assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'do not touch');
    fs.rmdirSync(path.join(a, 'data')); fs.symlinkSync(outside, path.join(a, 'data'), 'junction');
    await assert.rejects(f.storage.cleanup({ scope: 'account', profileId: 'alpha', category: 'history', confirmId: 'alpha' }), { code: 'STORAGE_LIMIT' });
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'do not touch');
});

test('bounded scans mark partial results and never pretend to cover omitted accounts', t => {
    const f = fixture(t, { maxEntries: 5 }), a = f.account('alpha');
    for (let index = 0; index < 12; index++) file(a, 'logs/part-' + index + '.log', 'a');
    const value = f.storage.snapshot(); assert.equal(value.partial, true); assert.ok(value.scanned.entries <= 5); assert.ok(value.totals.files < 12);
    const whole = new Storage(f.root, f.accounts, { settings: f.settings, settingsFile: f.settingsFile }); t.after(() => whole.close());
    for (let index = 0; index < 17; index++) f.account('saved-' + index);
    const limited = whole.snapshot(); assert.equal(limited.scanned.accounts, 16); assert.equal(limited.accounts.length, 16); assert.equal(limited.partial, true);
});

test('hard-linked logs cannot truncate files outside the storage scope', async t => {
    const f = fixture(t), a = f.account('alpha');
    const protectedFile = file(f.root, 'outside-work/protected.log', 'keep external contents', 30);
    fs.linkSync(protectedFile, path.join(a, 'logs/linked.log'));
    const before = f.storage.snapshot(); assert.equal(before.partial, true); assert.equal(before.accounts[0].logs.bytes, 0);
    const result = await f.storage.cleanup({ scope: 'logs' });
    assert.equal(result.partial, true); assert.equal(result.reclaimedBytes, 0);
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep external contents');
});

test('unknown log files are counted but never guessed to be safe for automatic deletion', async t => {
    const f = fixture(t), a = f.account('alpha'); const unknown = file(a, 'logs/unrecognized.bin', 'preserve', 30);
    const result = await f.storage.cleanup({ scope: 'logs' });
    assert.equal(result.partial, true); assert.equal(result.skipped, 1); assert.equal(result.reclaimedBytes, 0);
    assert.equal(fs.readFileSync(unknown, 'utf8'), 'preserve'); assert.equal(f.storage.snapshot().totals.logsBytes, 8);
});

test('storage HTTP routes require authentication and CSRF and preserve policy across other settings updates', async t => {
    const f = fixture(t); f.account('alpha');
    const manager = await createManager({ root: f.root, accounts: f.accounts, startAccounts: false });
    t.after(() => manager.close());
    assert.equal((await manager.app.inject({ method: 'GET', url: '/api/storage' })).statusCode, 401);
    const setupToken = fs.readFileSync(manager.auth.setup, 'utf8').trim();
    const initialized = await manager.app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: { setupToken, password: 'storage-test-password' } });
    const cookie = initialized.headers['set-cookie'].split(';')[0], csrf = initialized.json().data.csrf;
    const headers = { cookie, 'x-csrf-token': csrf };
    const denied = await manager.app.inject({ method: 'PATCH', url: '/api/storage/policy', headers: { cookie }, payload: { logMaxMiB: 8, logRetentionDays: 14 } });
    assert.equal(denied.statusCode, 403);
    const expired = file(f.root, 'work/logs/old.log.1', 'old-log', 20);
    const saved = await manager.app.inject({ method: 'PATCH', url: '/api/storage/policy', headers, payload: { logMaxMiB: 8, logRetentionDays: 14 } });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().data.policy.enabled, true);
    assert.equal(saved.json().data.cleanup.deletedFiles, 1);
    assert.equal(saved.json().data.cleanup.partial, false);
    assert.equal(fs.existsSync(expired), false);
    manager.storage.active = true;
    try {
        const busy = await manager.app.inject({ method: 'PATCH', url: '/api/storage/policy', headers, payload: { logMaxMiB: 9, logRetentionDays: 14 } });
        assert.equal(busy.statusCode, 409);
        assert.equal(read(f.settingsFile).storage.logMaxMiB, 8);
    } finally { manager.storage.active = false; }
    const updated = await manager.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { maxAccounts: 3 } });
    assert.equal(updated.statusCode, 200); assert.equal(read(f.settingsFile).storage.logMaxMiB, 8);
    const response = await manager.app.inject({ method: 'GET', url: '/api/storage', headers: { cookie } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().data.accounts[0].profileId, 'alpha');
    const cleaned = await manager.app.inject({ method: 'POST', url: '/api/storage/cleanup', headers, payload: {
        scope: 'account', profileId: 'alpha', category: 'media', confirmId: 'alpha' } });
    assert.equal(cleaned.statusCode, 200); assert.equal(cleaned.json().data.scope, 'account');
    const timer = manager.storage.timer; assert.ok(timer); await manager.close(); assert.equal(manager.storage.timer, null);
});
