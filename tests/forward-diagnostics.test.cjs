'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { beginForwardDiagnostic } = require('../src/qq/forward-diagnostics.cjs');
const temporaryRoot = path.resolve(__dirname, '../work/temp');
const STATE = { epoch: 'diagnostic-session', uin: '2068886823', uid: 'u_self' };
function fixture(t) {
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'forward-diagnostic-'));
    const account = path.join(root, 'work/accounts/legacy');
    fs.mkdirSync(account, { recursive: true, mode: 0o700 });
    const environment = { FWD_MANAGER_ROOT: root, FWD_ACCOUNT_ROOT: account,
        FWD_RPC_DIR: path.join(account, 'rpc'), FWD_EXPECTED_UIN: STATE.uin };
    const base = path.join(account, 'state/native-forward-diagnostics');
    t.after(() => {
        assert.ok(root.startsWith(temporaryRoot + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const begin = extra => beginForwardDiagnostic({ environment, state: STATE, source: { chatType: 2, peerUid: '1103828635' },
        sourceMsgIds: ['18446744073709551610'], correlation: '18446744073709551000', ...extra });
    const rows = id => fs.readFileSync(path.join(base, id, 'records.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const summary = id => JSON.parse(fs.readFileSync(path.join(base, id, 'summary.json'), 'utf8')).data;
    return { root, account, environment, base, begin, rows, summary };
}

test('private evidence snapshots exact native data before mutation and closes with bounded private metadata', t => {
    const f = fixture(t), sink = f.begin(), value = { ids: ['18446744073709551610'], map: new Map([['long', 18446744073709551610n]]) };
    assert.equal(sink.record('observation', value), true);
    value.ids[0] = 'changed'; value.map.clear();
    sink.nativeResult({ result: 0 }); sink.close({ dispatched: true, confirmed: true });
    const rows = f.rows(sink.id);
    assert.equal(rows[0].phase, 'prepared');
    assert.equal(rows[0].data.correlation, '18446744073709551000');
    assert.deepEqual(rows[0].data.sourceMsgIds, ['18446744073709551610']);
    assert.deepEqual(rows[1].data, { ids: ['18446744073709551610'], map: { $type: 'map',
        entries: [['long', { $type: 'bigint', value: '18446744073709551610' }]] } });
    assert.equal(rows[2].phase, 'native-result');
    assert.equal(f.summary(sink.id).confirmed, true);
    assert.equal(sink.record('after-close', {}), false);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(f.base, sink.id)).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(f.base, sink.id, 'records.jsonl')).mode & 0o777, 0o600);
    }
});

test('unmanaged, mismatched or linked account paths fail before a run is opened', t => {
    const f = fixture(t);
    for (const environment of [{}, { ...f.environment, FWD_ACCOUNT_ROOT: path.join(f.root, 'outside') },
        { ...f.environment, FWD_RPC_DIR: path.join(f.account, 'other') },
        { ...f.environment, FWD_EXPECTED_UIN: '2441760163' },
        { ...f.environment, FWD_MANAGER_ROOT: '.' }]) {
        assert.throws(() => f.begin({ environment }), { code: 'INVALID_CONFIG' });
    }
    const elsewhere = path.join(f.root, 'linked-account'); fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.renameSync(f.account, path.join(f.root, 'original-account'));
    fs.symlinkSync(elsewhere, f.account, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.begin(), { code: 'INVALID_CONFIG' });
    assert.equal(fs.existsSync(path.join(elsewhere, 'state')), false);
});

test('non-private existing account directories are rejected on Linux', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t); fs.chmodSync(f.account, 0o755);
    assert.throws(() => f.begin(), { code: 'INVALID_CONFIG' });
});

test('malformed or excessive snapshots are dropped without invoking accessors or expanding huge sparse arrays', t => {
    const f = fixture(t), sink = f.begin(); let getterCalls = 0;
    const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { getterCalls++; return 'private'; } });
    const cyclic = {}; cyclic.self = cyclic;
    const sparse = []; sparse[4294967294] = 'huge';
    for (const value of [accessor, cyclic, sparse, Number.MAX_SAFE_INTEGER + 1, { text: 'x'.repeat(262145) }]) {
        assert.equal(sink.record('bad', value), false);
    }
    assert.equal(getterCalls, 0);
    for (let index = 0; index < 100; index++) sink.record('bounded', { index });
    sink.close({ dispatched: false });
    assert.ok(f.rows(sink.id).length <= 64); assert.ok(f.summary(sink.id).dropped >= 5);
    assert.ok(fs.statSync(path.join(f.base, sink.id, 'records.jsonl')).size <= 2 * 1024 * 1024);
});

test('native promises settling after timeout retain one result without reopening callback evidence', t => {
    const f = fixture(t), sink = f.begin(); sink.close({ confirmed: false, code: 'TIMEOUT', dispatched: true });
    const before = fs.readFileSync(path.join(f.base, sink.id, 'records.jsonl'), 'utf8');
    sink.nativeResult(undefined); sink.nativeResult({ result: 0 }); sink.close({ confirmed: true });
    assert.equal(fs.readFileSync(path.join(f.base, sink.id, 'records.jsonl'), 'utf8'), before);
    const late = JSON.parse(fs.readFileSync(path.join(f.base, sink.id, 'native-late-result.json'), 'utf8'));
    assert.equal(late.phase, 'native-result-after-close'); assert.deepEqual(late.data, { $type: 'undefined' });
    assert.equal(f.summary(sink.id).code, 'TIMEOUT');
});

test('native rejection evidence records own error strings in the private run', t => {
    const f = fixture(t), sink = f.begin();
    sink.nativeResult(Object.assign(new Error('native private failure'), { code: 'NATIVE_FAILED' }), true);
    sink.close({ confirmed: false });
    const row = f.rows(sink.id).find(item => item.phase === 'native-rejected');
    assert.equal(row.data.message, 'native private failure'); assert.equal(row.data.code, 'NATIVE_FAILED');
});

test('run quota never deletes earlier evidence or silently rotates it', t => {
    const f = fixture(t), ids = [];
    for (let count = 0; count < 8; count++) { const sink = f.begin(); ids.push(sink.id); sink.close({ dispatched: false }); }
    assert.throws(() => f.begin(), { code: 'BUSY' });
    assert.deepEqual(fs.readdirSync(f.base).sort(), ids.sort());
});

test('short writes are completed and zero-byte prepared writes block native submission', t => {
    const f = fixture(t), original = fs.writeSync;
    try {
        fs.writeSync = (fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(length, 17));
        const sink = f.begin(); sink.close({ dispatched: false });
        assert.equal(f.rows(sink.id)[0].phase, 'prepared');
        fs.writeSync = () => 0;
        assert.throws(() => f.begin(), { code: 'DIAGNOSTIC_FAILED' });
    } finally { fs.writeSync = original; }
});

test('Map overrides and hostile rejection descriptors cannot run inside native callback evidence', t => {
    const f = fixture(t), sink = f.begin();
    class NativeMap extends Map { get size() { throw new Error('overridden size'); } [Symbol.iterator]() { throw new Error('overridden iterator'); } }
    assert.equal(sink.record('map', new NativeMap([['real', 'value']])), true);
    const error = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('hostile'); } });
    assert.doesNotThrow(() => sink.nativeResult(error, true)); sink.close({ dispatched: false });
    assert.equal(f.summary(sink.id).dropped, 1);
});

test('a replaced run directory cannot receive a late native result', t => {
    const f = fixture(t), sink = f.begin(); sink.close({ dispatched: true, confirmed: false });
    const run = path.join(f.base, sink.id); fs.renameSync(run, path.join(f.root, 'preserved-run'));
    fs.mkdirSync(run, { mode: 0o700 }); sink.nativeResult({ result: 0 });
    assert.deepEqual(fs.readdirSync(run), []);
});
