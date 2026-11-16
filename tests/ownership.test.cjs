'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { processIdentity, ownerIsAlive, claimOwner, readJson } = require('../src/ipc/common.cjs');

const root = path.resolve(__dirname, '..');
const temporary = path.join(root, 'work/temp');
fs.mkdirSync(temporary, { recursive: true });

// The ready/go barrier ensures every contender is running before it attempts
// recovery. A winner holds the ownership for at least 200 ms AND until every
// contender has attempted acquisition, so slow process scheduling is harmless.
const contender = String.raw`
'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const [root, mode, directory] = process.argv.slice(1);
const { claimOwner, readJson, remove } = require(path.join(root, 'src/ipc/common.cjs'));
const { acquireLock } = require(path.join(root, 'src/lock.cjs'));
const { startServer } = require(path.join(root, 'src/ipc/server.cjs'));
const instance = randomUUID();
let finishHolding;
const releaseSignal = new Promise(resolve => { finishHolding = resolve; });
async function attempt() {
    let release;
    try {
        if (mode === 'claim') {
            const file = path.join(directory, 'owner.json');
            claimOwner(file, { instance });
            release = () => { if (readJson(file).instance === instance) remove(file); };
        } else if (mode === 'adapter') release = acquireLock(directory);
        else {
            const backend = new EventEmitter();
            backend.call = async () => ({ ready: true });
            const server = await startServer({ dir: directory, backend, pollMs: 5 });
            release = () => server.close();
        }
    } catch (error) {
        process.send({ phase: 'attempted', acquired: false, code: error.code });
        process.disconnect();
        return;
    }
    const acquiredAt = Date.now();
    process.send({ phase: 'attempted', acquired: true, pid: process.pid });
    await Promise.all([new Promise(resolve => setTimeout(resolve, 200)), releaseSignal]);
    await release();
    process.send({ phase: 'released', heldMs: Date.now() - acquiredAt });
    process.disconnect();
}
process.on('message', message => {
    if (message.go) attempt().catch(error => {
        process.send({ phase: 'error', code: error.code || 'CHILD_ERROR', message: error.message });
        process.exitCode = 1;
        process.disconnect();
    });
    if (message.release) finishHolding();
});
process.send({ phase: 'ready' });
`;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Keep cleanup of a rejected child from producing an unhandled rejection
    // before the parent reaches that child's barrier.
    promise.catch(() => {});
    return { promise, resolve, reject };
}

function child(mode, directory) {
    const processObject = spawn(process.execPath, ['-e', contender, root, mode, directory], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
            npm_config_cache: path.join(root, 'work/cache/npm') }
    });
    const ready = deferred(), attempted = deferred(), released = deferred();
    let stdout = '', stderr = '';
    processObject.stdout.on('data', data => { stdout += data; });
    processObject.stderr.on('data', data => { stderr += data; });
    processObject.on('message', message => {
        if (message.phase === 'ready') ready.resolve(message);
        if (message.phase === 'attempted') attempted.resolve(message);
        if (message.phase === 'released') released.resolve(message);
        if (message.phase === 'error') {
            const error = new Error('Child ownership error: ' + JSON.stringify(message));
            ready.reject(error); attempted.reject(error); released.reject(error);
        }
    });
    const exited = once(processObject, 'exit').then(([code, signal]) => {
        if (code !== 0) {
            const error = new Error('Ownership child exited ' + code + '/' + signal + ': ' + stdout + stderr);
            ready.reject(error); attempted.reject(error); released.reject(error);
        }
        return { code, signal };
    });
    processObject.on('error', error => { ready.reject(error); attempted.reject(error); released.reject(error); });
    return { process: processObject, ready, attempted, released, exited };
}

function staleOwner() {
    if (process.platform === 'linux') return {
        pid: process.pid, processIdentity: processIdentity() + ':previous-start-time', instance: 'stale-test-owner'
    };
    return { pid: 2147483647, processIdentity: null, instance: 'stale-test-owner' };
}

for (const mode of ['claim', 'adapter', 'server']) {
    test(mode + ' permits only one process to recover and hold stale ownership', { timeout: 20000 }, async t => {
        const directory = fs.mkdtempSync(path.join(temporary, 'ownership-'));
        const file = path.join(directory, mode === 'adapter' ? '.adapter-owner.json' : 'owner.json');
        fs.writeFileSync(file, JSON.stringify(staleOwner()), { mode: 0o600 });
        const contenders = Array.from({ length: 6 }, () => child(mode, directory));
        t.after(async () => {
            for (const item of contenders) if (item.process.exitCode === null && item.process.signalCode === null) item.process.kill();
            await Promise.allSettled(contenders.map(item => item.exited));
            fs.rmSync(directory, { recursive: true, force: true });
        });
        await Promise.all(contenders.map(item => item.ready.promise));
        for (const item of contenders) item.process.send({ go: true });
        const results = await Promise.all(contenders.map(item => item.attempted.promise));
        const winners = results.map((value, index) => ({ ...value, index })).filter(item => item.acquired);
        assert.equal(winners.length, 1, JSON.stringify(results));
        for (const item of results.filter(value => !value.acquired)) assert.equal(item.code, 'BUSY');
        const winner = winners[0];
        const owner = readJson(file);
        assert.equal(owner.pid, winner.pid, 'losing contenders must not remove the live winner');
        assert.equal(ownerIsAlive(owner), true);
        contenders[winner.index].process.send({ release: true });
        const released = await contenders[winner.index].released.promise;
        assert.ok(released.heldMs >= 190, 'winner must actually hold ownership for at least 200 ms');
        const exits = await Promise.all(contenders.map(item => item.exited));
        assert.ok(exits.every(item => item.code === 0));
        assert.equal(fs.existsSync(file), false);
        assert.equal(fs.existsSync(file + '.recovery'), false);
    });
}

test('Linux PID reuse is distinguished from a live matching process', { skip: process.platform !== 'linux' }, () => {
    const identity = processIdentity(process.pid);
    assert.ok(identity);
    assert.equal(ownerIsAlive({ pid: process.pid, processIdentity: identity }), true);
    assert.equal(ownerIsAlive({ pid: process.pid, processIdentity: identity + ':old' }), false);
});

test('an existing recovery mutex prevents deleting another recovery owner', t => {
    const directory = fs.mkdtempSync(path.join(temporary, 'ownership-mutex-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'owner.json');
    const previous = staleOwner();
    fs.writeFileSync(file, JSON.stringify(previous), { mode: 0o600 });
    fs.mkdirSync(file + '.recovery', { mode: 0o700 });
    assert.throws(() => claimOwner(file, { instance: 'new-owner' }), { code: 'BUSY' });
    assert.deepEqual(readJson(file), previous);
});

test('an incomplete concurrently published ownership claim stays occupied and unchanged', t => {
    const directory = fs.mkdtempSync(path.join(temporary, 'ownership-partial-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'owner.json');
    for (const bytes of ['', '{', '{"pid":']) {
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        assert.throws(() => claimOwner(file, { instance: 'contender' }), { code: 'BUSY' });
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
        assert.equal(fs.existsSync(file + '.recovery'), false);
    }
});
