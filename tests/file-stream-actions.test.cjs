'use strict';

const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { runStreamActions, ACTIONS, MAX_CHUNK } = require('../src/onebot/file-stream-actions.cjs');
const safe = require('../src/onebot/safe-download.cjs');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const scratch = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(scratch, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(scratch, 'stream-test-')); if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const state = { self: { uin: '12345', uid: 'u_self' }, epoch: 'e1', capabilities: { streamFiles: true } };
    const frames = [], service = { mediaDirectory: root, remaining: () => 60000,
        assertSession: async current => { if (current.epoch !== state.epoch || current.self.uin !== state.self.uin) throw Object.assign(new Error('session changed'), { code: 'SESSION_CHANGED' }); } };
    const call = (action, params = {}, options = {}) => runStreamActions(service, structuredClone(state), action, params, { streamSink: { send: async frame => { frames.push(frame); } }, ...options });
    return { root, service, state, frames, call };
}
test('all eight file actions exist and test_download_stream sends ten real awaited frames', async t => {
    const f = fixture(t); assert.equal(ACTIONS.size, 8);
    const final = await f.call('test_download_stream'); assert.equal(f.frames.length, 10); assert.equal(final.type, 'response');
    f.frames.length = 0; await assert.rejects(f.call('test_download_stream', { error: true }), { code: 'QUERY_FAILED' }); assert.equal(f.frames.length, 10);
    await assert.rejects(f.call('test_download_stream', {}, { streamSink: undefined }), { code: 'UNSUPPORTED' });
    await assert.rejects(f.call('test_download_stream', { error: 'false' }), { code: 'INVALID_PARAMS' });
});
test('out-of-order chunks assemble exact bytes and duplicate content is checked before acknowledgement', async t => {
    const f = fixture(t), data = Buffer.from('hello world');
    const first = await f.call('upload_file_stream', { stream_id: 'test_1', filename: 'hello.txt', total_chunks: 2, file_size: data.length, chunk_index: 1, chunk_data: data.subarray(6).toString('base64') });
    assert.equal(first.status, 'chunk_received'); assert.equal(first.received_chunks, 1);
    const duplicate = await f.call('upload_file_stream', { stream_id: 'test_1', chunk_index: 1, chunk_data: data.subarray(6).toString('base64') }); assert.equal(duplicate.received_chunks, 1);
    await assert.rejects(f.call('upload_file_stream', { stream_id: 'test_1', chunk_index: 1, chunk_data: Buffer.from('different').toString('base64') }), { code: 'INVALID_PARAMS' });
    await f.call('upload_file_stream', { stream_id: 'test_1', chunk_index: 0, chunk_data: data.subarray(0, 6).toString('base64') });
    const complete = await f.call('upload_file_stream', { stream_id: 'test_1', is_complete: true, expected_sha256: crypto.createHash('sha256').update(data).digest('hex') });
    assert.equal(complete.type, 'response'); assert.equal(complete.file_size, data.length); assert.deepEqual(fs.readFileSync(complete.file_path), data);
    const info = await f.call('get_file', { file_id: complete.file_id }); assert.equal(info.sha256, complete.sha256);
    const terminal = await f.call('download_file_stream', { file: complete.file_id, chunk_size: 3 });
    assert.equal(terminal.total_chunks, 4); assert.equal(terminal.total_bytes, data.length);
    assert.deepEqual(Buffer.concat(f.frames.filter(frame => frame.data_type === 'file_chunk').map(frame => Buffer.from(frame.data, 'base64'))), data);
});
test('download_file base64 creates scoped file handles and cleanup only removes manifest-owned inactive files', async t => {
    const f = fixture(t); const ordinary = path.join(f.root, 'unrelated.txt'); fs.writeFileSync(ordinary, 'keep');
    const downloaded = await f.call('download_file', { base64: 'YWJj', name: 'abc.txt' });
    assert.equal((await f.call('get_file', { file_id: downloaded.file_id })).file_size, 3);
    const rogue = path.join(f.root, 'fwd-streams', 'unowned.txt'); fs.writeFileSync(rogue, 'also keep');
    await f.call('upload_file_stream', { stream_id: 'active', total_chunks: 2, chunk_index: 0, chunk_data: 'YWJj' });
    const cleanup = await f.call('clean_stream_temp_file'); assert.equal(cleanup.removed, 1); assert.equal(cleanup.freed_bytes, 3); assert.equal(cleanup.skipped_active, 1);
    assert.equal(fs.existsSync(downloaded.file), false); assert.equal(fs.readFileSync(ordinary, 'utf8'), 'keep'); assert.equal(fs.readFileSync(rogue, 'utf8'), 'also keep');
    await assert.rejects(f.call('get_file', { file: ordinary }), { code: 'NOT_FOUND' });
    const reset = await f.call('upload_file_stream', { stream_id: 'active', reset: true }); assert.equal(reset.type, 'reset');
});
test('metadata changes, missing chunks, hash mismatches, malformed base64 and unbounded inputs are rejected', async t => {
    const f = fixture(t);
    for (const params of [{ stream_id: '../escape', total_chunks: 1 }, { stream_id: 'a', total_chunks: 4097 }, { stream_id: 'a', total_chunks: 1, filename: '../a' },
        { stream_id: 'a', total_chunks: 1, file_retention: 0 }, { stream_id: 'a', total_chunks: 1, chunk_index: 0 },
        { stream_id: 'a', total_chunks: 1, chunk_index: 0, chunk_data: 'YQ==' + ' ' }, { stream_id: 'a', total_chunks: 1, chunk_index: 0, chunk_data: Buffer.alloc(MAX_CHUNK + 1).toString('base64') }]) await assert.rejects(f.call('upload_file_stream', params), { code: 'INVALID_PARAMS' });
    await f.call('upload_file_stream', { stream_id: 'a', total_chunks: 2, file_size: 6, chunk_index: 0, chunk_data: 'YWJj' });
    await assert.rejects(f.call('upload_file_stream', { stream_id: 'a', total_chunks: 3 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.call('upload_file_stream', { stream_id: 'a', is_complete: true }), { code: 'INVALID_PARAMS' });
    await f.call('upload_file_stream', { stream_id: 'a', chunk_index: 1, chunk_data: 'ZGVm' });
    await assert.rejects(f.call('upload_file_stream', { stream_id: 'a', is_complete: true, expected_sha256: '0'.repeat(64) }), { code: 'INVALID_PARAMS' });
    assert.equal((await f.call('clean_stream_temp_file')).removed, 0);
});
test('account session changes invalidate handles and abort subsequent stream frames', async t => {
    const f = fixture(t), downloaded = await f.call('download_file', { base64: 'YWJj', name: 'abc.txt' });
    f.state.epoch = 'e2'; await assert.rejects(f.call('get_file', { file_id: downloaded.file_id }), { code: 'NOT_FOUND' });
    let sent = 0;
    await assert.rejects(f.call('test_download_stream', {}, { streamSink: { send: async () => { sent++; f.state.epoch = 'e3'; } } }), { code: 'SESSION_CHANGED' }); assert.equal(sent, 1);
});
test('sink backpressure is awaited and caller disconnect prevents following frames', async t => {
    const f = fixture(t); let sent = 0, resume;
    const control = new AbortController();
    const task = f.call('test_download_stream', {}, { signal: control.signal, streamSink: { send: async () => { sent++; await new Promise(resolve => { resume = resolve; }); } } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 1);
    control.abort(); await assert.rejects(task, { code: 'EXPIRED' }); resume(); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 1);
});
test('URL guard rejects private, mapped, transition, metadata, documentation and mixed DNS destinations', async () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.2', '100.64.1.2', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::1', 'fe80::1', 'fc00::1']) assert.equal(safe.publicAddress(address), false, address);
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(safe.publicAddress(address), true);
    for (const url of ['http://127.1/a', 'http://2130706433/a', 'file:///a', 'https://user:pass@example.com/a', 'http://localhost/a', 'https://public.example:8443/a']) assert.throws(() => safe.parseUrl(url), { code: 'INVALID_PARAMS' });
    let requests = 0;
    await assert.rejects(safe.openDownload('https://public.example/a', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { requests++; } }), { code: 'INVALID_PARAMS' }); assert.equal(requests, 0);
});
test('download connection pins the checked DNS address and forbids redirects/compression/oversized lengths', async () => {
    let looked = 0, connected, options;
    const request = (url, init, callback) => {
        options = init; const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => init.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); connected = address; const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-length': '3' }; callback(response); response.end('abc'); }); return req;
    };
    const source = await safe.openDownload('https://public.example/a', { lookup: async () => { looked++; return [{ address: '8.8.8.8', family: 4 }]; }, request });
    const chunks = []; for await (const chunk of source.iterable) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'abc'); assert.equal(looked, 1); assert.equal(connected, '8.8.8.8'); assert.equal(options.agent, false); assert.equal(options.servername, 'public.example');
    for (const [statusCode, headers] of [[302, {}], [200, { 'content-encoding': 'gzip' }], [200, { 'content-length': '999999999' }]]) {
        await assert.rejects(safe.openDownload('https://public.example/a', { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: (_url, _init, callback) => {
            const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => { const response = new PassThrough(); response.statusCode = statusCode; response.headers = headers; callback(response); }; return req;
        } }), { code: 'QUERY_FAILED' });
    }
});

test('manifest disk quota is enforced before additional bytes and completed-file content is rechecked', async t => {
    const f = fixture(t), root = path.join(f.root, 'fwd-streams'); fs.mkdirSync(root);
    const files = [];
    for (let i = 0; i < 4; i++) {
        const id = 'fwd-file-' + String(i + 1).repeat(48), filename = path.join(root, id); fs.writeFileSync(filename, ''); fs.truncateSync(filename, 32 * 1024 * 1024);
        files.push({ id, name: 'budget.bin', kind: 'file', scope: JSON.stringify(['12345', 'e1', 'u_self']), expires: Date.now() + 300000, size: 32 * 1024 * 1024 });
    }
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, files }));
    await assert.rejects(f.call('download_file', { base64: 'YWJj' }), { code: 'BUSY' });
    const g = fixture(t), saved = await g.call('download_file', { base64: 'YWJj' }); fs.writeFileSync(saved.file, 'xyz');
    await assert.rejects(g.call('get_file', { file_id: saved.file_id }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(g.call('download_file_stream', { file_id: saved.file_id }), { code: 'INVALID_RESPONSE' });
    assert.equal(g.frames.some(frame => frame.type === 'response'), false);
});

test('physical file slots survive caller aborts until blocked sinks actually finish', async t => {
    const f = fixture(t), finish = [];
    for (let i = 0; i < 4; i++) {
        const controller = new AbortController(), task = f.call('test_download_stream', {}, { signal: controller.signal, streamSink: { send: () => new Promise(resolve => finish.push(resolve)) } });
        await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(task, { code: 'EXPIRED' });
    }
    await assert.rejects(f.call('test_download_stream'), { code: 'BUSY' }); f.state.epoch = 'e2';
    await assert.rejects(f.call('test_download_stream'), { code: 'BUSY' });
    for (const done of finish) done(); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.call('test_download_stream')).type, 'response');
});
