'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');

async function fixture(t, call, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-ipc-'));
    const backend = new EventEmitter();
    backend.call = call || (async (_method, params) => params);
    const server = await startServer({ dir, backend, pollMs: 5, ...options });
    const client = new RpcClient({ directory: dir, timeoutMs: 2000 });
    t.after(async () => { client.close(); await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, backend, server, client };
}

test('RPC correlates concurrent requests and exposes only fixed methods', async t => {
    const { client } = await fixture(t, async (_method, params) => { await new Promise(r => setTimeout(r, params.wait)); return params.value; });
    assert.deepEqual(await Promise.all([client.call('status', { wait: 40, value: 1 }), client.call('status', { wait: 1, value: 2 })]), [1, 2]);
    await assert.rejects(client.call('exec', { code: 'throw 1' }), { code: 'UNSUPPORTED' });
});

test('RPC reports real backend errors without converting to success', async t => {
    const { client } = await fixture(t, async () => { throw Object.assign(new Error('not ready'), { code: 'NOT_READY' }); });
    await assert.rejects(client.call('status'), { code: 'NOT_READY' });
});

test('a backend ENOENT is delivered once instead of being mistaken for a missing response file', async t => {
    let calls = 0;
    const { client } = await fixture(t, async () => {
        calls++; throw Object.assign(new Error('Account resource does not exist'), { code: 'ENOENT' });
    });
    await assert.rejects(client.call('recordExport', {}), { code: 'ENOENT', message: 'Account resource does not exist' });
    assert.equal(calls, 1);
    assert.equal(client.pending, 0);
});

test('client cancellation reaches a claimed read-only operation even when all server slots are occupied', async t => {
    let entered, cancelled;
    const entry = new Promise(resolve => { entered = resolve; });
    const cancellation = new Promise(resolve => { cancelled = resolve; });
    const { client } = await fixture(t, (_method, _params, context) => {
        entered(); context.signal.addEventListener('abort', cancelled, { once: true });
        return new Promise(() => {});
    }, { maxPending: 1 });
    const controller = new AbortController();
    const pending = client.call('nativeRkey', {}, { signal: controller.signal });
    await entry; controller.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    await Promise.race([cancellation, new Promise((_, reject) => setTimeout(() => reject(new Error('claimed query was not cancelled')), 1000))]);
});

test('cancelling a caller never claims that a dispatched write was cancelled in QQ', async t => {
    let entered, signal;
    const entry = new Promise(resolve => { entered = resolve; });
    const { client } = await fixture(t, (method, _params, context) => {
        if (method === 'status') return true;
        signal = context.signal; entered(); return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = client.call('sendMessage', {}, { signal: controller.signal });
    await entry; controller.abort(); await assert.rejects(pending, { code: 'ABORTED' });
    assert.equal(await client.call('status'), true);
    assert.equal(signal.aborted, false);
});

test('RPC times out once and never retries a side effect', async t => {
    let sends = 0, entered, release, completed;
    const entry = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const completion = new Promise(resolve => { completed = resolve; });
    t.after(() => release());
    const { client } = await fixture(t, async (method, _params, context) => {
        if (method !== 'sendMessage') return true;
        sends++; entered(context.expiresAt);
        await gate; completed(); return true;
    });
    const pending = client.call('sendMessage', {}, { timeoutMs: 30000 });
    const expiresAt = await Promise.race([entry, pending.then(() => { throw new Error('Side effect completed before its gate was released'); })]);
    // Advance only the deadline clock, after actual backend dispatch. A loaded
    // machine need not discover and submit the request within a 60 ms window.
    const clock = t.mock.method(Date, 'now', () => expiresAt + 1);
    try { await assert.rejects(pending, { code: 'TIMEOUT' }); }
    finally { clock.mock.restore(); release(); }
    await completion;
    // Round-trip another action after the late result, rather than sleeping for
    // an assumed server schedule before checking whether a retry was issued.
    assert.equal(await client.call('status'), true);
    assert.equal(sends, 1);
});

test('event cursors detect overflow and instance replacement', async t => {
    const { client, backend } = await fixture(t, undefined, { queueSize: 2 });
    backend.emit('event', { kind: 'message', record: { msgId: '1' } });
    backend.emit('event', { kind: 'message', record: { msgId: '2' } });
    backend.emit('event', { kind: 'message', record: { msgId: '3' } });
    const batch = await client.call('events');
    assert.equal(batch.gap, true);
    assert.deepEqual(batch.events.map(item => item.event.record.msgId), ['2', '3']);
    const next = await client.call('events', { instance: batch.instance, cursor: batch.cursor });
    assert.deepEqual(next.events, []);
    assert.equal(next.gap, false);
    assert.equal((await client.call('events', { instance: 'previous', cursor: 500 })).gap, true);
});

test('a second server cannot consume the same requests', async t => {
    const { dir, backend } = await fixture(t);
    await assert.rejects(startServer({ dir, backend }), { code: 'BUSY' });
});

test('client close cancels a pending wait and server close detaches listeners', async t => {
    const { client, server, backend } = await fixture(t, () => new Promise(() => {}));
    const pending = client.call('status');
    client.close();
    await assert.rejects(pending, { code: 'ABORTED' });
    await server.close();
    assert.equal(backend.listenerCount('event'), 0);
});
