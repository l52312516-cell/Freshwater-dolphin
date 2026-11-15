'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Auth } = require('../src/manager/auth.cjs');
const { ManagementEvents } = require('../src/manager/events.cjs');
const { memoryAvailable } = require('../src/manager/resources.cjs');
const { Accounts } = require('../src/manager/accounts.cjs');
const { LogReader } = require('../src/manager/logs.cjs');
const { Backups, encode } = require('../src/manager/backups.cjs');
const { createManager } = require('../src/manager/server.cjs');
const { atomic } = require('../src/manager/files.cjs');

function temporary(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, 'audit-manager-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}

test('memory admission and dashboard use process/container limits instead of host RAM', () => {
    const gib = 1024 ** 3;
    const memory = memoryAvailable({ platform: 'linux', host: { total: 32 * gib, free: gib },
        readFile: () => 'MemAvailable: 16777216 kB\n', constrained: () => 2 * gib, available: () => 128 * 1024 ** 2 });
    assert.deepEqual(memory, { total: 2 * gib, free: 128 * 1024 ** 2 });
    assert.deepEqual(memoryAvailable({ platform: 'linux', host: { total: 32 * gib, free: gib },
        readFile: () => { throw new Error('no proc'); }, constrained: () => 0, available: () => undefined }), { total: 32 * gib, free: gib });
    assert.equal(memoryAvailable({ platform: 'win32', host: { total: gib, free: 2 * gib }, constrained: () => 0, available: () => 0 }).free, 0);
});

test('stale or unreadable account health becomes unknown without blocking another account', async t => {
    const root = temporary(t), accounts = new Accounts(root);
    for (const [id, uin] of [['a', '123'], ['b', '456']]) {
        accounts.create({ id, expectedUin: uin }); accounts.get(id).desired = 'running';
        accounts.processes.set(id, new EventEmitter());
        atomic(path.join(accounts.location(id), 'state/health.json'), {
            at: Date.now(), selfId: uin, sessionEpoch: 'session-' + id, ready: true, online: true, gatewayPort: 12345
        });
    }
    accounts.poll(); assert.equal(accounts.states.get('a'), 'online'); assert.equal(accounts.states.get('b'), 'online');
    const healthA = path.join(accounts.location('a'), 'state/health.json');
    const health = JSON.parse(fs.readFileSync(healthA)); health.at -= 60000; atomic(healthA, health);
    accounts.poll(); assert.equal(accounts.states.get('a'), 'bridge_unavailable');
    assert.equal(accounts.healths.has('a'), false); assert.equal(accounts.states.get('b'), 'online');
    assert.throws(() => accounts.gateway('a'), { code: 'NOT_READY' });
    const clear = accounts.clearGrant.bind(accounts);
    accounts.clearGrant = id => { if (id === 'a') throw new Error('unreadable private filesystem'); return clear(id); };
    assert.doesNotThrow(() => accounts.poll()); assert.equal(accounts.states.get('b'), 'online');
    accounts.processes.clear(); await accounts.close();
});

test('password KDF concurrency is globally bounded across login addresses and releases zeroed keys', async t => {
    const root = temporary(t), waits = [], keys = [];
    atomic(path.join(root, 'admin.json'), { version: 1, salt: 'ab'.repeat(16), hash: 'ab'.repeat(32) });
    const auth = new Auth(root, { deriveKey: () => new Promise(resolve => waits.push(() => {
        const key = Buffer.alloc(32, 0xab); keys.push(key); resolve(key);
    })) });
    const first = auth.login('long-test-password', 'one'), second = auth.login('long-test-password', 'two');
    second.catch(() => {});
    await assert.rejects(auth.login('long-test-password', 'three'), { code: 'RATE_LIMITED' });
    assert.equal(waits.length, 2); assert.equal(auth.activeHashes, 2);
    waits[0](); const session = await first;
    assert.ok(session.id); assert.equal(auth.activeHashes, 1); assert.equal(keys[0].every(byte => byte === 0), true);
    auth.close(); waits[1](); await assert.rejects(second, { code: 'CLOSING' });
    assert.equal(auth.sessions.size, 0); assert.equal(auth.activeHashes, 0);
});

test('revocation invalidates authentication even when one transport throws while closing', t => {
    const auth = new Auth(temporary(t)), session = auth.issue(); let destroyed = 0, ended = 0;
    session.streams.add({ end() { throw new Error('broken SSE'); }, destroy() { destroyed++; } });
    session.streams.add({ end() { ended++; } });
    auth.revoke(session.id);
    assert.equal(auth.session(auth.cookie(session.id, false)), null);
    assert.equal(session.streams.size, 0); assert.equal(destroyed, 1); assert.equal(ended, 1);
    auth.close(); assert.throws(() => auth.issue(), { code: 'CLOSING' });
});

test('closing between password hashing and its caller continuation never commits new credentials', async t => {
    const root = temporary(t), auth = new Auth(root);
    auth.hash = async () => {
        queueMicrotask(() => auth.close());
        return 'ab'.repeat(32);
    };
    await assert.rejects(auth.bootstrap(fs.readFileSync(auth.setup, 'utf8').trim(), 'long-test-password', 'one'), { code: 'CLOSING' });
    assert.equal(fs.existsSync(auth.file), false); assert.equal(fs.existsSync(auth.initialized), false);
});

function eventFixture(t) {
    let now = 100, snapshots = 0, logReads = 0, failRead = false;
    const auth = { sessions: new Map() }, sessions = ['one', 'two'].map(id => ({ id, expires: 1000, streams: new Set() }));
    for (const session of sessions) auth.sessions.set(session.id, session);
    const events = new ManagementEvents({ auth, now: () => now, intervalMs: 60000,
        overview: () => { snapshots++; return { ready: true }; },
        readLogs: () => { logReads++; if (failRead) throw new Error('read failed'); return [{ id: 'one', content: 'exact\nmessage' }]; } });
    t.after(() => events.close());
    const stream = () => {
        const value = new EventEmitter(); value.frames = []; value.writableLength = 0;
        value.writeHead = () => {}; value.write = bytes => { value.frames.push(bytes); return !value.blockWrite; };
        value.end = () => { value.writableEnded = true; value.emit('close'); };
        return value;
    };
    return { events, auth, sessions, stream, set now(value) { now = value; }, set failRead(value) { failRead = value; },
        get snapshots() { return snapshots; }, get logReads() { return logReads; } };
}

test('management SSE reads logs once per tick for multiple tabs and stops polling without clients', t => {
    const f = eventFixture(t), a = f.stream(), b = f.stream();
    f.events.open(a, f.sessions[0]); f.events.open(b, f.sessions[1]);
    assert.equal(f.events.clients.size, 2); assert.equal(f.logReads, 0);
    f.events.tick(); assert.equal(f.logReads, 1); assert.equal(f.snapshots, 3);
    assert.equal(a.frames[2], b.frames[2]); assert.match(a.frames[2], /exact\\nmessage/);
    f.events.tick(); assert.equal(f.logReads, 2); assert.equal(a.frames.filter(row => row.startsWith('event: logs')).length, 1);
    a.end(); assert.ok(f.events.timer); b.end(); assert.equal(f.events.timer, null);
    assert.equal(f.sessions[0].streams.size, 0); assert.equal(f.events.clients.size, 0);
});

test('a backpressured SSE tab cannot block other tabs and per-session limits remain enforced', t => {
    const f = eventFixture(t), slow = f.stream(), good = f.stream(); slow.blockWrite = true;
    f.events.open(slow, f.sessions[0]); f.events.open(good, f.sessions[1]);
    f.events.tick(); assert.equal(slow.writableEnded, true); assert.equal(good.writableEnded, undefined);
    assert.equal(good.frames.filter(row => row.startsWith('event: logs')).length, 1);
    for (let index = 0; index < 3; index++) f.events.open(f.stream(), f.sessions[1]);
    assert.throws(() => f.events.open(f.stream(), f.sessions[1]), { code: 'STREAM_LIMIT' });
    f.now = 1000; f.events.tick(); assert.equal(f.events.clients.size, 0); assert.equal(f.events.timer, null);
});

test('revoked SSE sessions and failed snapshot/log reads cannot remain connected or crash a timer', t => {
    const f = eventFixture(t), a = f.stream(), b = f.stream();
    f.events.open(a, f.sessions[0]); f.events.open(b, f.sessions[1]); f.auth.sessions.delete('one');
    f.events.tick(); assert.equal(a.writableEnded, true); assert.equal(b.writableEnded, undefined);
    f.failRead = true; assert.doesNotThrow(() => f.events.tick());
    assert.equal(b.writableEnded, true); assert.equal(f.events.timer, null);
});

test('SSE bounds each complete frame plus already buffered bytes before writing', t => {
    const f = eventFixture(t), stream = f.stream();
    f.events.open(stream, f.sessions[0]);
    const count = stream.frames.length;
    stream.writableLength = f.events.maxBufferedBytes - 10;
    f.events.tick(); assert.equal(stream.frames.length, count); assert.equal(stream.writableEnded, true);
    f.events.overview = () => ({ data: 'x'.repeat(f.events.maxBufferedBytes) });
    const oversized = f.stream(); f.events.open(oversized, f.sessions[1]);
    assert.equal(oversized.frames.length, 0); assert.equal(oversized.writableEnded, true); assert.equal(f.events.timer, null);
});

test('log rotation with identical length and mtime invalidates the cached file identity', t => {
    const root = temporary(t), file = path.join(root, 'log.jsonl'), timestamp = new Date('2025-01-01T00:00:00Z');
    fs.writeFileSync(file, '{"event":"first"}\n'); fs.utimesSync(file, timestamp, timestamp);
    const reader = new LogReader(root, {});
    assert.equal(reader.file(file)[0].event, 'first');
    fs.renameSync(file, file + '.old');
    fs.writeFileSync(file, '{"event":"other"}\n'); fs.utimesSync(file, timestamp, timestamp);
    assert.equal(reader.file(file)[0].event, 'other'); reader.close();
});

test('decrypted backup preview is evicted on expiry without requiring another request', async t => {
    const root = temporary(t), accounts = { document: { profiles: [], maintenance: {} }, processes: new Map() };
    const backups = new Backups(root, accounts, { previewMs: 25 }); t.after(() => backups.close());
    const document = { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind: 'full',
        profiles: [{ config: { id: 'one', nodes: [] }, entries: [] }] };
    const saved = backups.upload(await encode(document, 'long-backup-password'));
    const preview = await backups.preview({ backupId: saved.id, password: 'long-backup-password' });
    assert.equal(backups.previews.size, 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(backups.previews.size, 0); assert.equal(backups.previewTimer, null);
    await assert.rejects(backups.apply(preview.previewId), { code: 'PREVIEW_EXPIRED' });
});

test('backup shutdown waits for decoding and prevents late decrypted preview retention', async t => {
    const root = temporary(t), accounts = { document: { profiles: [], maintenance: {} }, processes: new Map() };
    const backups = new Backups(root, accounts);
    const document = { version: 2, architecture: 'x64', qqVersion: '3.2.35-54395', kind: 'full',
        profiles: [{ config: { id: 'one', nodes: [] }, entries: [] }] };
    const saved = backups.upload(await encode(document, 'long-backup-password'));
    const preview = backups.preview({ backupId: saved.id, password: 'long-backup-password' }); preview.catch(() => {});
    assert.equal(backups.locked, true); assert.equal(backups.pending.size, 1);
    const closing = backups.close(); assert.equal(backups.close(), closing);
    await assert.rejects(preview, { code: 'CLOSING' }); await closing;
    assert.equal(backups.previews.size, 0); assert.equal(backups.pending.size, 0); assert.equal(backups.previewTimer, null);
    await assert.rejects(backups.create({ profileIds: ['one'] }), { code: 'CLOSING' });
});

test('closing during backup acquisition waits for the writer and leaves stopped maintenance instead of resuming QQ', async t => {
    const root = temporary(t); let release, finished;
    const config = { id: 'one', nodes: [], desired: 'running' };
    const accounts = { document: { profiles: [config], maintenance: {} }, processes: new Map(), get: () => config,
        maintain: async () => {
            accounts.document.maintenance.one = { operation: 'backup', phase: 'stopping' };
            await new Promise(resolve => { release = resolve; });
        }, finishMaintenance: async (ids, result) => { finished = result; } };
    const backups = new Backups(root, accounts), create = backups.create({ profileIds: ['one'] }); create.catch(() => {});
    let closed = false; const closing = backups.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    release(); await assert.rejects(create, { code: 'CLOSING' }); await closing;
    assert.deepEqual(finished, { success: false }); assert.equal(backups.list().length, 0);
});

test('all manager resources and ownership are released even when notification cleanup fails', async t => {
    const root = temporary(t), manager = await createManager({ root, startAccounts: false });
    manager.notifications.close = () => { throw new Error('notification cleanup failed'); };
    const first = manager.close(), second = manager.close(); assert.equal(first, second);
    await assert.rejects(first, AggregateError);
    const next = await createManager({ root, startAccounts: false }); await next.close();
});
