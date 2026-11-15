'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { stripTypeScriptTypes } = require('node:module');

const scope = import('../webui/src/request-scope.mjs');
let sequence = 0;
async function client(t, fetch) {
    const original = { fetch: global.fetch, window: global.window };
    const window = new EventTarget(); global.window = window; global.fetch = fetch;
    t.after(() => { global.fetch = original.fetch; global.window = original.window; });
    const source = fs.readFileSync(path.join(__dirname, '../webui/src/api.ts'), 'utf8');
    const code = stripTypeScriptTypes(source, { mode: 'transform' }).replace("'./request-scope.mjs'", JSON.stringify(pathToFileURL(path.join(__dirname, '../webui/src/request-scope.mjs')).href));
    const module = await import('data:text/javascript;base64,' + Buffer.from(code + '\n// fixture ' + sequence++).toString('base64'));
    return { ...module, window };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }

test('request generation rejects an earlier account even after switching back to the same ID', async () => {
    const { createRequestScope, isStaleRequest } = await scope;
    const requests = createRequestScope(), old = requests.capture();
    requests.invalidate(); requests.invalidate();
    assert.equal(old.signal.aborted, true); assert.equal(old.isCurrent(), false);
    assert.throws(() => old.assertCurrent(), error => isStaleRequest(error));
    assert.equal(requests.capture().isCurrent(), true);
});

test('changing the authenticated session aborts the previous request and rejects a late successful body', async t => {
    const pending = deferred(); let signal;
    const api = await client(t, (_url, options) => { signal = options.signal; return pending.promise; });
    api.setCsrf('first-session');
    const result = api.api('/accounts');
    api.setCsrf('second-session');
    assert.equal(signal.aborted, true);
    pending.resolve(response({ data: ['private old account'] }));
    await assert.rejects(result, { name: 'StaleRequestError' });
});

test('a late 401 from an earlier session cannot log out a newly authenticated session', async t => {
    const pending = deferred();
    const api = await client(t, () => pending.promise); let unauthorized = 0;
    api.window.addEventListener('freshwater:unauthorized', () => unauthorized++);
    api.setCsrf('first-session'); const result = api.api('/accounts'); api.setCsrf('second-session');
    pending.resolve(response({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401));
    await assert.rejects(result, { name: 'StaleRequestError' }); assert.equal(unauthorized, 0);
});

test('an unauthorized response for the current session still invokes the authentication reset', async t => {
    const api = await client(t, async () => response({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401));
    let unauthorized = 0; api.window.addEventListener('freshwater:unauthorized', () => unauthorized++);
    await assert.rejects(api.api('/accounts'), { code: 'UNAUTHORIZED', status: 401 }); assert.equal(unauthorized, 1);
});

test('logging out while response JSON is being read does not expose the old response', async t => {
    const body = deferred(), reading = deferred();
    const api = await client(t, async () => ({ status: 200, ok: true, json() { reading.resolve(); return body.promise; } }));
    api.setCsrf('session'); const result = api.api('/settings'); await reading.promise;
    api.setCsrf(''); body.resolve({ data: { musicSignKey: 'private value' } });
    await assert.rejects(result, { name: 'StaleRequestError' });
});

test('an account cancellation is enforced even when fetch supplies a late response', async t => {
    const pending = deferred(); let signal;
    const api = await client(t, (_url, options) => { signal = options.signal; return pending.promise; });
    const controller = new AbortController();
    const result = api.api('/accounts/alpha/config', 'GET', undefined, {}, controller.signal);
    controller.abort(); assert.equal(signal.aborted, true);
    pending.resolve(response({ data: { label: 'alpha' } }));
    await assert.rejects(result, { name: 'AbortError' });
});

test('backup download authentication expiry uses the same logout notification', async t => {
    const api = await client(t, async () => response({ error: { code: 'UNAUTHORIZED' } }, 401));
    let unauthorized = 0; api.window.addEventListener('freshwater:unauthorized', () => unauthorized++);
    await assert.rejects(api.download('/backups/example/download', 'example.backup'), /下载失败/);
    assert.equal(unauthorized, 1);
});

test('a malformed current 401 response still resets authentication', async t => {
    let next;
    const api = await client(t, async () => next);
    let unauthorized = 0; api.window.addEventListener('freshwater:unauthorized', () => unauthorized++);
    for (const bad of [new Response('proxy rejected session', { status: 401 }), response(null, 401)]) {
        next = bad; await assert.rejects(api.api('/accounts'), { code: 'INVALID_RESPONSE' });
    }
    assert.equal(unauthorized, 2);
});

test('a null response envelope produces a clear protocol error', async t => {
    const api = await client(t, async () => response(null));
    await assert.rejects(api.api('/overview'), { code: 'INVALID_RESPONSE' });
});

test('log identity includes the account because backend record IDs are account local', async () => {
    const { logRecordKey } = await import('../webui/src/log-key.mjs');
    const first = logRecordKey({ profileId: 'alpha', id: 'same-id' });
    const second = logRecordKey({ profileId: 'beta', id: 'same-id' });
    assert.notEqual(first, second); assert.equal(first, logRecordKey({ profileId: 'alpha', id: 'same-id' }));
});

test('merged log snapshots retain chronological order, profile identity and their bound', async () => {
    const { mergeLogRecords } = await import('../webui/src/log-key.mjs');
    const records = mergeLogRecords([{ profileId: 'alpha', id: 'a', at: 20 }, { profileId: 'alpha', id: 'b', at: 30 }],
        [{ profileId: 'beta', id: 'b', at: 25 }, { profileId: 'alpha', id: 'old', at: 10 }, { profileId: 'alpha', id: 'b', at: 30 }], 3);
    assert.deepEqual(records.map(row => row.profileId + '/' + row.id), ['alpha/a', 'beta/b', 'alpha/b']);
});
