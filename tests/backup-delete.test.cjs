'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Accounts } = require('../src/manager/accounts.cjs');
const { Backups, encode } = require('../src/manager/backups.cjs');
const { createManager } = require('../src/manager/server.cjs');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'backup-delete-'));
    const accounts = new Accounts(root), backups = new Backups(root, accounts);
    accounts.create({ id: 'one', expectedUin: '2068886823' });
    const data = path.join(accounts.location('one'), 'data'); fs.mkdirSync(data, { recursive: true });
    const sentinel = path.join(data, '2068886823.json');
    fs.writeFileSync(sentinel, JSON.stringify({ version: 1, account: '2068886823', nextId: 1, entries: [] }));
    t.after(async () => { await accounts.close(); fs.rmSync(root, { recursive: true, force: true }); });
    async function save(kind = 'ordinary') {
        const document = { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind,
            profiles: [{ config: structuredClone(accounts.get('one')), entries: [] }] };
        const bytes = await encode(document, 'independent-backup-password');
        return backups.save(bytes, { kind, profileIds: ['one'] });
    }
    return { root, accounts, backups, save, sentinel };
}

test('deleting ordinary or encrypted backups removes only the selected archive and metadata', async t => {
    const f = fixture(t), ordinary = await f.save(), full = await f.save('full');
    const account = JSON.stringify(f.accounts.document), state = fs.readFileSync(f.sentinel);
    for (const backup of [ordinary, full]) {
        assert.deepEqual(f.backups.remove(backup.id), { id: backup.id, deleted: true });
        assert.equal(fs.existsSync(f.backups.file(backup.id)), false);
        assert.equal(fs.existsSync(path.join(f.backups.directory, backup.id + '.json')), false);
        if (backup === ordinary) assert.equal(fs.existsSync(f.backups.file(full.id)), true);
        assert.equal(JSON.stringify(f.accounts.document), account);
        assert.deepEqual(fs.readFileSync(f.sentinel), state);
        assert.throws(() => f.backups.remove(backup.id), { code: 'NOT_FOUND' });
    }
    assert.deepEqual(f.backups.list(), []);
});

test('deletion invalidates its restore preview and cannot race encrypted preview decoding', async t => {
    const f = fixture(t), backup = await f.save('full');
    const pending = f.backups.preview({ backupId: backup.id, password: 'independent-backup-password' });
    assert.equal(f.backups.locked, true);
    assert.throws(() => f.backups.remove(backup.id), { code: 'BUSY' });
    assert.equal(fs.existsSync(f.backups.file(backup.id)), true);
    const preview = await pending;
    assert.equal(f.backups.previews.get(preview.previewId).backupId, backup.id);
    f.backups.remove(backup.id);
    assert.equal(f.backups.previews.has(preview.previewId), false);
    await assert.rejects(f.backups.apply(preview.previewId), { code: 'PREVIEW_EXPIRED' });
    await assert.rejects(f.backups.preview({ backupId: backup.id, password: 'independent-backup-password' }), { code: 'NOT_FOUND' });
    assert.equal(f.backups.locked, false);
});

test('backup and restore operations exclude deletion until their awaited work finishes', async t => {
    const f = fixture(t), backup = await f.save();
    const maintain = f.accounts.maintain.bind(f.accounts);
    let resume;
    f.accounts.maintain = async (...args) => { await new Promise(resolve => { resume = resolve; }); return maintain(...args); };
    const creating = f.backups.create({ profileIds: ['one'] });
    assert.equal(f.backups.locked, true);
    assert.throws(() => f.backups.remove(backup.id), { code: 'BUSY' });
    resume(); await creating;
    const preview = await f.backups.preview({ backupId: backup.id });
    const restoring = f.backups.apply(preview.previewId);
    assert.equal(f.backups.locked, true);
    assert.throws(() => f.backups.remove(backup.id), { code: 'BUSY' });
    resume(); await restoring;
    assert.deepEqual(f.backups.remove(backup.id), { id: backup.id, deleted: true });
});

test('active downloads block deletion of that backup and release their hold on close', async t => {
    const f = fixture(t), first = await f.save(), second = await f.save();
    const stream = f.backups.download(first.id);
    assert.throws(() => f.backups.remove(first.id), { code: 'BUSY' });
    f.backups.remove(second.id);
    const closed = once(stream, 'close'); stream.destroy(); await closed;
    f.backups.remove(first.id);
    assert.equal(f.backups.downloads.size, 0);
});

test('invalid backup identifiers and special archive entries never remove account state', async t => {
    const f = fixture(t), backup = await f.save(), original = fs.readFileSync(f.sentinel);
    for (const id of ['../one', '..', '/etc/passwd', 'C:\\private', 'a'.repeat(31), 'A'.repeat(32), backup.id + '.fwd']) {
        assert.throws(() => f.backups.remove(id));
        assert.equal(fs.existsSync(f.backups.file(backup.id)), true);
    }
    const metadata = path.join(f.backups.directory, backup.id + '.json');
    fs.unlinkSync(metadata); fs.linkSync(f.sentinel, metadata);
    assert.throws(() => f.backups.remove(backup.id), { code: 'UNSAFE_BACKUP_PATH' });
    assert.equal(fs.existsSync(f.backups.file(backup.id)), true);
    fs.unlinkSync(metadata); fs.mkdirSync(metadata);
    assert.throws(() => f.backups.remove(backup.id), { code: 'UNSAFE_BACKUP_PATH' });
    assert.equal(fs.existsSync(f.backups.file(backup.id)), true);
    assert.deepEqual(fs.readFileSync(f.sentinel), original);
});

test('linked backup directories are rejected without deleting their targets', async t => {
    const f = fixture(t), backup = await f.save();
    const actual = path.join(f.root, 'moved-backups');
    fs.renameSync(f.backups.directory, actual);
    fs.symlinkSync(actual, f.backups.directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.backups.remove(backup.id), { code: 'UNSAFE_BACKUP_PATH' });
    assert.equal(fs.existsSync(path.join(actual, backup.id + '.fwd')), true);
    fs.unlinkSync(f.backups.directory);
    fs.renameSync(actual, f.backups.directory);
});

test('delete API requires authentication and CSRF and makes a deleted backup unavailable', async t => {
    const f = fixture(t), backup = await f.save(), other = await f.save('full');
    const manager = await createManager({ root: f.root, accounts: f.accounts, startAccounts: false });
    t.after(() => manager.close());
    const app = manager.app, url = '/api/backups/' + backup.id;
    assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 401);
    const initialized = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', payload: {
        setupToken: fs.readFileSync(manager.auth.setup, 'utf8').trim(), password: 'administrator-password'
    } });
    const headers = { cookie: initialized.headers['set-cookie'].split(';')[0], 'x-csrf-token': initialized.json().data.csrf };
    assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie: headers.cookie } })).statusCode, 403);
    const preview = await app.inject({ method: 'POST', url: '/api/backups/restore/preview', headers, payload: { backupId: backup.id } });
    assert.equal(preview.statusCode, 200);
    const result = await app.inject({ method: 'DELETE', url, headers });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data, { id: backup.id, deleted: true });
    assert.equal((await app.inject({ url: url + '/download', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/backups/restore/apply', headers,
        payload: { previewId: preview.json().data.previewId } })).json().error.code, 'PREVIEW_EXPIRED');
    assert.deepEqual((await app.inject({ url: '/api/backups', headers })).json().data.map(value => value.id), [other.id]);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/backups/' + other.id, headers })).statusCode, 200);
    assert.equal(f.accounts.get('one').id, 'one');
    assert.equal(fs.existsSync(f.sentinel), true);
});
