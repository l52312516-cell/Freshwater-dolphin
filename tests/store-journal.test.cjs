'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MessageStore, checkpointDirectory } = require('../src/onebot/store.cjs');

function fixture(t, options = {}) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'store-journal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { directory, file: path.join(directory, '11111.json'), store: new MessageStore({ directory, ...options }) };
}
function record(id) { return { chatType: 2, peerUid: '12345', msgId: String(id), msgSeq: String(id), clientSeq: '9',
    senderUid: 'u_sender', senderUin: '22222', msgTime: '1794760000', elements: [{ elementType: 1, textElement: { content: 'synthetic' } }] }; }

test('legacy snapshots migrate to a durable journal without changing published message identities', t => {
    const f = fixture(t);
    const old = f.store.remember('11111', record('18446744073709551610'));
    const saved = JSON.parse(fs.readFileSync(f.file, 'utf8')); delete saved.revision; delete saved.recent;
    fs.writeFileSync(f.file, JSON.stringify(saved));
    const migrated = new MessageStore({ directory: f.directory });
    assert.equal(migrated.remember('11111', record('18446744073709551611')).id, 2);
    migrated.setEvent('11111', 2, { message_id: 2 }, true);
    const reopened = new MessageStore({ directory: f.directory });
    assert.equal(reopened.get('11111', old.id).locator.nativeId, '18446744073709551610');
    assert.equal(reopened.get('11111', 2).event.message_id, 2);
    assert.equal(reopened.remember('11111', record('18446744073709551612')).id, 3);
    checkpointDirectory(f.directory);
    assert.equal(fs.existsSync(f.file + '.wal'), false);
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).nextId, 4);
});

test('a torn final journal record is discarded while all committed IDs survive recovery', t => {
    const f = fixture(t);
    f.store.remember('11111', record(1)); f.store.remember('11111', record(2));
    const complete = fs.statSync(f.file + '.wal').size;
    fs.appendFileSync(f.file + '.wal', '{"version":1,"account":"11111","revision":');
    const reopened = new MessageStore({ directory: f.directory });
    assert.equal(reopened.get('11111', 2).locator.nativeId, '2');
    assert.equal(fs.statSync(f.file + '.wal').size, complete);
    assert.equal(reopened.remember('11111', record(3)).id, 3);
    assert.equal(new MessageStore({ directory: f.directory }).get('11111', 3).locator.nativeId, '3');
});

test('complete journal corruption and missing base snapshots fail closed instead of reusing IDs', t => {
    const f = fixture(t);
    f.store.remember('11111', record(1)); f.store.remember('11111', record(2));
    const journal = fs.readFileSync(f.file + '.wal', 'utf8');
    fs.writeFileSync(f.file + '.wal', journal.replace('synthetic', 'tampered'));
    assert.throws(() => new MessageStore({ directory: f.directory }).get('11111', 1), { code: 'INVALID_STORE' });
    fs.writeFileSync(f.file + '.wal', journal); fs.unlinkSync(f.file);
    assert.throws(() => new MessageStore({ directory: f.directory }).get('11111', 1), { code: 'INVALID_STORE' });
});

test('journal replay preserves cache eviction, recalls, deduplication and refresh order', t => {
    const f = fixture(t, { maxMessages: 2 });
    f.store.remember('11111', record(1)); f.store.remember('11111', record(2));
    f.store.remember('11111', record(1)); f.store.setEvent('11111', 1, { message_id: 1 }, true);
    f.store.setRecalled('11111', 1, { message_id: 1 }, true); f.store.remember('11111', record(3));
    const reopened = new MessageStore({ directory: f.directory, maxMessages: 2 });
    assert.equal(reopened.get('11111', 2).record, undefined);
    assert.equal(reopened.get('11111', 1).recallEmitted, true);
    assert.equal(reopened.get('11111', 1).emitted, true);
    assert.deepEqual(reopened.state('11111').recent, [1, 3]);
    reopened.close();
    assert.deepEqual(new MessageStore({ directory: f.directory, maxMessages: 2 }).state('11111').recent, [1, 3]);
});

test('a failed partial append blocks further writes until recovery and never publishes the failed ID', t => {
    const f = fixture(t); f.store.remember('11111', record(1));
    const original = fs.writeFileSync;
    let injected = false;
    t.mock.method(fs, 'writeFileSync', function (file, data, ...args) {
        if (typeof file === 'number' && !injected) {
            injected = true; original(file, Buffer.from(data).subarray(0, 12));
            throw Object.assign(new Error('Synthetic partial disk write'), { code: 'EIO' });
        }
        return original(file, data, ...args);
    });
    assert.throws(() => f.store.remember('11111', record(2)), { code: 'EIO' });
    t.mock.restoreAll();
    assert.throws(() => f.store.remember('11111', record(3)), { code: 'INVALID_STORE' });
    const reopened = new MessageStore({ directory: f.directory });
    assert.equal(reopened.get('11111', 2), null);
    assert.equal(reopened.remember('11111', record(3)).id, 2);
});

test('snapshot committed before journal cleanup is replayed idempotently after interruption', t => {
    const f = fixture(t); f.store.remember('11111', record(1)); f.store.remember('11111', record(2));
    const original = fs.unlinkSync;
    t.mock.method(fs, 'unlinkSync', file => {
        if (file === f.file + '.wal') throw Object.assign(new Error('Synthetic cleanup interruption'), { code: 'EIO' });
        return original(file);
    });
    assert.throws(() => f.store.close(), { code: 'EIO' });
    t.mock.restoreAll();
    const reopened = new MessageStore({ directory: f.directory });
    assert.equal(reopened.get('11111', 2).locator.nativeId, '2');
    assert.equal(reopened.remember('11111', record(3)).id, 3);
    reopened.close(); assert.equal(fs.existsSync(f.file + '.wal'), false);
});

test('ordinary message updates write a bounded delta without rewriting lifetime locators', t => {
    const f = fixture(t);
    const entries = Array.from({ length: 10000 }, (_, index) => ({ id: index + 1, emitted: true,
        locator: { peer: { chatType: 2, peerUid: '12345' }, nativeId: String(index + 1), seq: String(index + 1) } }));
    fs.writeFileSync(f.file, JSON.stringify({ version: 1, account: '11111', nextId: 10001, entries }));
    const before = fs.readFileSync(f.file);
    assert.equal(f.store.remember('11111', record(10001)).id, 10001);
    f.store.setEvent('11111', 10001, { message_id: 10001 }, true);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.ok(fs.statSync(f.file + '.wal').size < 4096);
    assert.equal(new MessageStore({ directory: f.directory }).get('11111', 10001).event.message_id, 10001);
});

test('read-only inspection neither truncates an in-progress suffix nor checkpoints a live writer', t => {
    const f = fixture(t); f.store.remember('11111', record(1)); f.store.remember('11111', record(2));
    fs.appendFileSync(f.file + '.wal', '{partial');
    const before = fs.readFileSync(f.file + '.wal');
    const reader = new MessageStore({ directory: f.directory, readOnly: true });
    assert.equal(reader.get('11111', 2).locator.nativeId, '2');
    assert.throws(() => reader.remember('11111', record(3)), { code: 'READ_ONLY' });
    reader.close();
    assert.deepEqual(fs.readFileSync(f.file + '.wal'), before);
});

test('shutdown never replaces a complete but unacknowledged WAL transaction with stale memory after fsync fails', t => {
    const f = fixture(t); f.store.remember('11111', record(1));
    const original = fs.fsyncSync; let injected = false;
    t.mock.method(fs, 'fsyncSync', fd => {
        if (!injected) { injected = true; throw Object.assign(new Error('Synthetic post-write fsync failure'), { code: 'EIO' }); }
        return original(fd);
    });
    assert.throws(() => f.store.remember('11111', record(2)), { code: 'EIO' });
    t.mock.restoreAll();
    const bytes = fs.readFileSync(f.file + '.wal');
    assert.equal(bytes[bytes.length - 1], 10);
    assert.throws(() => f.store.close(), { code: 'INVALID_STORE' });
    assert.deepEqual(fs.readFileSync(f.file + '.wal'), bytes);
    const recovered = new MessageStore({ directory: f.directory });
    assert.equal(recovered.get('11111', 2).locator.nativeId, '2');
    assert.equal(recovered.remember('11111', record(3)).id, 3);
    recovered.close();
});

test('a failed snapshot durability acknowledgement cannot be rolled back by close', t => {
    const f = fixture(t); f.store.remember('11111', record(1));
    const transaction = f.store.stage('11111'); transaction.store.remember('11111', record(2));
    const original = fs.renameSync; let injected = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
        original(from, to);
        if (to === f.file && !injected) { injected = true; throw Object.assign(new Error('Synthetic post-rename failure'), { code: 'EIO' }); }
    });
    assert.throws(() => transaction.commit(), { code: 'EIO' });
    t.mock.restoreAll();
    const bytes = fs.readFileSync(f.file);
    assert.throws(() => f.store.close(), { code: 'INVALID_STORE' });
    assert.deepEqual(fs.readFileSync(f.file), bytes);
    const recovered = new MessageStore({ directory: f.directory });
    assert.equal(recovered.get('11111', 2).locator.nativeId, '2');
    assert.equal(recovered.remember('11111', record(3)).id, 3);
});

test('read-only checkpoints are rejected even when invoked directly', t => {
    const f = fixture(t); f.store.remember('11111', record(1));
    const reader = new MessageStore({ directory: f.directory, readOnly: true }), state = reader.state('11111');
    const bytes = fs.readFileSync(f.file);
    assert.throws(() => reader.checkpoint(state), { code: 'READ_ONLY' });
    assert.deepEqual(fs.readFileSync(f.file), bytes);
});
