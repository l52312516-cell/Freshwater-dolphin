'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Accounts } = require('../src/manager/accounts.cjs');
const { Backups, encode, validateArchive } = require('../src/manager/backups.cjs');
const { LogReader } = require('../src/manager/logs.cjs');
const { atomic, read } = require('../src/manager/files.cjs');

function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'manager-transactions-'));
    const children = [];
    const accounts = new Accounts(root, { memory: () => ({ free: 2 ** 31, total: 2 ** 32 }), displayBusy: () => false,
        spawnAccount: () => { const child = new EventEmitter(); child.pid = 800 + children.length;
            child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true; }; children.push(child); return child; } });
    accounts.customPlatform = true;
    t.after(async () => { await accounts.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, accounts, children };
}
function failWrite(accounts, afterCommit = false) {
    const persist = accounts.persist.bind(accounts); let once = true;
    accounts.persist = () => {
        if (!once) return persist(); once = false;
        if (afterCommit) persist();
        throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
    };
}
test('pre-commit create and update failures restore the exact registry and do not poison later saves', async t => {
    const { accounts } = fixture(t); accounts.create({ id: 'a', nodes: [] });
    const before = fs.readFileSync(accounts.file, 'utf8');
    failWrite(accounts); assert.throws(() => accounts.create({ id: 'b' }), { code: 'EIO' });
    assert.equal(accounts.document.profiles.length, 1);
    failWrite(accounts); await assert.rejects(accounts.update('a', { label: 'unsaved' }), { code: 'EIO' });
    assert.equal(accounts.get('a').label, 'a'); assert.equal(fs.readFileSync(accounts.file, 'utf8'), before);
    accounts.create({ id: 'b' }); assert.equal(read(accounts.file).profiles[0].label, 'a');
});
test('a failed pre-commit start never spawns a worker or grants authorization during later polls', async t => {
    const { accounts, children } = fixture(t); accounts.create({ id: 'a', expectedUin: '123' });
    failWrite(accounts); await assert.rejects(accounts.start('a'), { code: 'EIO' });
    assert.equal(children.length, 0); assert.equal(accounts.get('a').desired, 'stopped');
    atomic(path.join(accounts.location('a'), 'state/health.json'), { at: Date.now(), ready: true, online: true, selfId: '123', sessionEpoch: 'late' });
    accounts.poll();
    assert.equal(fs.existsSync(path.join(accounts.location('a'), 'state/authorization.json')), false);
    assert.equal(read(accounts.file).profiles[0].desired, 'stopped');
});
test('failed update of a running account restores its previous configuration without stopping a peer', async t => {
    const { accounts, children } = fixture(t); accounts.create({ id: 'a' }); accounts.create({ id: 'b' });
    await accounts.start('a'); await accounts.start('b'); const peer = accounts.processes.get('b');
    failWrite(accounts); await assert.rejects(accounts.update('a', { label: 'not-saved' }), { code: 'EIO' });
    assert.equal(accounts.get('a').label, 'a'); assert.equal(accounts.processes.get('a'), children[2]);
    assert.equal(accounts.processes.get('b'), peer); assert.equal(read(accounts.file).profiles[0].label, 'a');
});
test('post-commit errors retain durable create/update/start state and report a warning without duplicate processes', async t => {
    const { accounts, children } = fixture(t);
    failWrite(accounts, true); assert.equal(accounts.create({ id: 'a' }).persistenceWarning, 'EIO');
    failWrite(accounts, true); assert.equal((await accounts.update('a', { label: 'saved' })).persistenceWarning, 'EIO');
    failWrite(accounts, true); assert.equal((await accounts.start('a')).persistenceWarning, 'EIO');
    await accounts.start('a'); assert.equal(children.length, 1);
    assert.equal(read(accounts.file).profiles[0].label, 'saved'); assert.equal(read(accounts.file).profiles[0].desired, 'running');
});
test('spawn failure rolls back persisted running intent and cannot cause automatic restart', async t => {
    const { accounts } = fixture(t); accounts.create({ id: 'a' });
    accounts.spawnAccount = () => { throw Object.assign(new Error('spawn failed'), { code: 'SPAWN_FAILED' }); };
    await assert.rejects(accounts.start('a'), { code: 'SPAWN_FAILED' });
    assert.equal(read(accounts.file).profiles[0].desired, 'stopped'); assert.equal(accounts.processes.size, 0);
});
test('an indeterminate registry write blocks future health authorization and startup', async t => {
    const { accounts } = fixture(t); accounts.create({ id: 'a' });
    accounts.persist = () => { fs.writeFileSync(accounts.file, '{broken'); throw Object.assign(new Error('partial disk fault'), { code: 'EIO' }); };
    await assert.rejects(accounts.start('a'), { code: 'EIO' });
    accounts.processes.set('a', new EventEmitter());
    atomic(path.join(accounts.location('a'), 'state/health.json'), { at: Date.now(), selfId: '123', sessionEpoch: 'x', ready: true, online: true });
    accounts.poll(); assert.equal(accounts.states.get('a'), 'persistence_failed');
    assert.equal(fs.existsSync(path.join(accounts.location('a'), 'state/authorization.json')), false);
    await assert.rejects(accounts.start('a'), { code: 'PERSISTENCE_UNAVAILABLE' }); accounts.processes.clear();
});
function archive(config = {}) { return { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind: 'ordinary', profiles: [{ config: { id: 'a', nodes: [], ...config }, entries: [] }] }; }
test('backup previews name their archive, and applying a different archive consumes no account data', async t => {
    const { root, accounts } = fixture(t); const backups = new Backups(root, accounts); t.after(() => backups.close());
    const first = backups.upload(await encode(archive())); const second = backups.upload(await encode(archive({ label: 'second' })));
    const preview = await backups.preview({ backupId: first.id }); assert.equal(preview.backupId, first.id);
    await assert.rejects(backups.apply(preview.previewId, second.id), { code: 'PREVIEW_MISMATCH' });
    assert.equal(accounts.document.profiles.length, 0); assert.equal(fs.existsSync(backups.journalFile), false);
    await assert.rejects(backups.apply(preview.previewId, first.id), { code: 'PREVIEW_EXPIRED' });
});
test('a failed new validation invalidates the previous preview', async t => {
    const { root, accounts } = fixture(t); const backups = new Backups(root, accounts); t.after(() => backups.close());
    const ordinary = backups.upload(await encode(archive()));
    const preview = await backups.preview({ backupId: ordinary.id });
    const encrypted = backups.upload(await encode({ ...archive(), kind: 'full' }, 'long-test-password'));
    await assert.rejects(backups.preview({ backupId: encrypted.id, password: 'wrong' }), { code: 'INVALID_PASSWORD' });
    await assert.rejects(backups.apply(preview.previewId, ordinary.id), { code: 'PREVIEW_EXPIRED' });
});
test('low memory rejects backup before stopping accounts, and restore discards unknown configuration fields', async t => {
    const { root, accounts } = fixture(t); accounts.create({ id: 'a' });
    const backups = new Backups(root, accounts, { memory: () => ({ free: 32 * 1024 ** 2 }) }); t.after(() => backups.close());
    await assert.rejects(backups.create({ profileIds: ['a'] }), { code: 'LOW_MEMORY' });
    assert.deepEqual(accounts.document.maintenance, {});
    const normalized = validateArchive(archive({ arbitrary: 'not-restored', boundUin: 123, desired: 'running', revision: 7 })).profiles[0].config;
    assert.equal(normalized.boundUin, '123'); assert.equal(normalized.revision, 7); assert.equal(Object.hasOwn(normalized, 'arbitrary'), false);
    assert.throws(() => validateArchive(archive({ revision: -1 })), { code: 'INVALID_BACKUP' });
});
test('log reads bound total candidates and rotate limited scans across accounts', t => {
    const { root, accounts } = fixture(t);
    for (const id of ['a', 'b']) {
        accounts.create({ id }); const directory = path.join(accounts.location(id), 'logs'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'adapter.jsonl'), Array.from({ length: 20 }, (_, n) => JSON.stringify({ time: new Date(1000 + n).toISOString(), event: 'ready', count: n })).join('\n') + '\n');
    }
    const reader = new LogReader(root, accounts, { maxScanBytes: 2000, maxScanRows: 25, maxScanMs: 10000 });
    const seen = new Set();
    for (let n = 0; n < 4; n++) { for (const row of reader.read({ limit: 3 })) seen.add(row.profileId); assert.ok(reader.lastRead.bytes <= 2000); assert.ok(reader.lastRead.rows <= 26); }
    assert.deepEqual([...seen].sort(), ['a', 'b']); reader.close();
});

test('slow missing log files cannot consume a read before its first nonempty source', t => {
    const { root, accounts } = fixture(t); accounts.create({ id: 'a' });
    const directory = path.join(accounts.location('a'), 'logs'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'messages.jsonl'), JSON.stringify({ time: new Date().toISOString(), event: 'ready' }) + '\n');
    let clock = 0;
    const reader = new LogReader(root, accounts, { now: () => { clock += 150; return clock; } });
    assert.equal(reader.read().length, 1); assert.equal(reader.lastRead.partial, true); reader.close();
});

test('scoped log reads rotate their cursor so a busy adapter file cannot starve message logs', t => {
    const { root, accounts } = fixture(t); accounts.create({ id: 'a' });
    const directory = path.join(accounts.location('a'), 'logs'); fs.mkdirSync(directory, { recursive: true });
    for (const name of ['adapter', 'messages']) fs.writeFileSync(path.join(directory, name + '.jsonl'),
        JSON.stringify({ time: new Date().toISOString(), event: name === 'adapter' ? 'first' : 'second' }) + '\n');
    const reader = new LogReader(root, accounts, { maxScanRows: 1 });
    assert.equal(reader.read({ profileId: 'a' })[0].event, 'first');
    assert.equal(reader.read({ profileId: 'a' })[0].event, 'second'); reader.close();
});

test('ordinary backup checkpoints stopped incremental journals before stripping private message bodies', async t => {
    const { root, accounts } = fixture(t); accounts.create({ id: 'a' });
    const { MessageStore } = require('../src/onebot/store.cjs');
    const data = path.join(accounts.location('a'), 'data'), store = new MessageStore({ directory: data });
    const record = { chatType: 2, peerUid: '2000000001', msgId: '9007199254740993123', msgSeq: '99', clientSeq: '', senderUin: '123', msgTime: '1000', elements: [{ elementType: 1, textElement: { content: 'private body' } }] };
    store.remember('123', { ...record, msgId: '9007199254740993122' });
    const entry = store.remember('123', record);
    assert.equal(fs.existsSync(path.join(data, '123.json.wal')), true);
    const backups = new Backups(root, accounts); t.after(() => backups.close());
    const saved = await backups.create({ profileIds: ['a'] });
    const { decode } = require('../src/manager/backups.cjs');
    const document = await decode(fs.readFileSync(backups.file(saved.id)));
    const mapping = JSON.parse(Buffer.from(document.profiles[0].entries[0].data, 'base64'));
    assert.equal(mapping.entries[1].id, entry.id); assert.equal(mapping.entries[1].locator.nativeId, record.msgId);
    assert.equal(JSON.stringify(mapping).includes('private body'), false);
    assert.equal(fs.existsSync(path.join(data, '123.json.wal')), false);
});
