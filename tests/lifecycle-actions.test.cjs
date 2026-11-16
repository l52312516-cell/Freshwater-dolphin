'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { runLifecycleActions } = require('../src/onebot/lifecycle-actions.cjs');
const { runStreamActions } = require('../src/onebot/file-stream-actions.cjs');
const state = { self: { uin: '12345', uid: 'u_self' }, epoch: 'e1', capabilities: {} };

test('direct lifecycle calls and nonreference parameters are rejected before preparation', async () => {
    let prepared = 0;
    const service = { streamOptions: new AsyncLocalStorage(), lifecycleClient: { available: () => true, prepare: async () => { prepared++; } }, assertSession: async () => {} };
    for (const action of ['bot_exit', 'set_restart']) {
        await assert.rejects(runLifecycleActions(service, state, action, {}), { code: 'UNSUPPORTED' });
        await assert.rejects(runLifecycleActions(service, state, action, { delay: 1 }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(prepared, 0);
});

test('a managed action registers account-bound commit only after its last session check', async () => {
    const completed = [], events = []; let callback;
    const service = { streamOptions: new AsyncLocalStorage(), assertSession: async () => events.push('session'),
        lifecycleClient: { available: () => true, prepare: async (current, operation) => {
            assert.equal(current, state); assert.equal(operation, 'restart'); events.push('prepare'); return { complete: async sent => completed.push(sent) };
        } } };
    const result = await service.streamOptions.run({ afterResponse: fn => { events.push('register'); callback = fn; } }, () => runLifecycleActions(service, state, 'set_restart', {}));
    assert.equal(result, null); assert.deepEqual(events, ['session', 'prepare', 'session', 'register']); assert.deepEqual(completed, []);
    await callback(true); assert.deepEqual(completed, [true]);
});

test('session revocation after reservation cancels before the action can report success', async () => {
    const completed = []; let checks = 0;
    const service = { streamOptions: new AsyncLocalStorage(), assertSession: async () => { if (++checks === 2) throw Object.assign(new Error('changed'), { code: 'SESSION_CHANGED' }); },
        lifecycleClient: { available: () => true, prepare: async () => ({ complete: async sent => completed.push(sent) }) } };
    await assert.rejects(service.streamOptions.run({ afterResponse: () => assert.fail('must not register') }, () => runLifecycleActions(service, state, 'bot_exit', {})), { code: 'SESSION_CHANGED' });
    assert.deepEqual(completed, [false]);
});

test('clean_cache removes only inactive registered stream cache while preserving active and recovery data', async t => {
    const scratch = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, 'cache-action-')); if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const service = { mediaDirectory: root, assertSession: async () => {}, remaining: () => 10000 };
    const current = { ...state, capabilities: { streamFiles: true } };
    const saved = await runStreamActions(service, current, 'download_file', { base64: 'YWJj' });
    const options = { streamSink: { send: async () => {} } };
    await runStreamActions(service, current, 'upload_file_stream', { stream_id: 'still-active', total_chunks: 2, chunk_index: 0, chunk_data: 'YWJj' }, options);
    const retained = ['flash-recovery.json', 'message-mapping.json', 'unregistered-cache.tmp'];
    for (const name of retained) fs.writeFileSync(path.join(root, name), 'keep');
    assert.equal(await runLifecycleActions(service, state, 'clean_cache', {}), null);
    assert.equal(fs.existsSync(saved.file), false);
    for (const name of retained) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'keep');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fwd-streams/manifest.json'))); assert.equal(manifest.files.length, 1); assert.equal(manifest.files[0].kind, 'chunk');
    const upload = await runStreamActions(service, current, 'upload_file_stream', { stream_id: 'still-active', verify_only: true }, options); assert.equal(upload.received_chunks, 1);
});
