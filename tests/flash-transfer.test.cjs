'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Capture } = require('../src/qq/capture.cjs');
const { createFlashTransfer, MAX_FILE_BYTES } = require('../src/qq/flash-transfer.cjs');
const { createFlashRecovery } = require('../src/qq/flash-recovery.cjs');
const { runFlashTransferActions, ACTIONS, WRITE_ACTIONS } = require('../src/onebot/flash-transfer-actions.cjs');
const fixed = require('../src/qq/flash-transfer-protocol.cjs'), p = require('../src/qq/proto.cjs');
const ID = '11111111-2222-3333-4444-555555555555', FILE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const value = (map, tag) => p.one(map, tag)?.value;
const tick = () => new Promise(resolve => setImmediate(resolve));
const directory = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(directory, { recursive: true });
const row = name => ({ filesetId: ID, name: name || 'A.txt', size: '3', shareUrl: 'https://qfile.qq.com/q/OfflineCode' });
const meta = () => ({ filesetId: ID, fileUuid: FILE, name: 'A.txt', size: '3', fileIndex: 1, fileId: 'real_main' });
const serverGrant = data => ({ token: 'server-grant:/+=' + data.fileUuid + ':' + (data.thumbType || 'main'), time: 1700000000, ttl: 3600 });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(directory, 'flash-test-')); if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.writeFileSync(path.join(root, 'A.txt'), 'abc');
    const calls = [], httpCalls = [], registered = [], committed = [], events = [];
    const capture = { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self', nickname: 'Self' }, mediaDirectory: root,
        pending: new Set(), ensureReady() {}, deadline: Capture.prototype.deadline,
        resolve: async who => ({ ...who, uid: 'u_person' }) };
    let name = 'A.txt', historyRemoved = false;
    let respond = async params => {
        const op = params.operation, data = params.request;
        if (op === 'list') return { items: historyRemoved ? [] : [row(name)], complete: false };
        if (op === 'detail') return { filesetId: data.filesetId, items: [row(name)], complete: false };
        if (op === 'metadata') return { filesetId: data.filesetId, complete: false, items: committed.length ? committed.map(item => ({ filesetId: ID, ...item, size: String(item.size), fileId: registered.find(reg => reg.fileUuid === item.fileUuid).fileId })) : [meta()] };
        if (op === 'download') return { filesetId: ID, fileUuid: FILE, url: 'https://multimedia.qfile.qq.com/download?appid=14901&fileid=real_main&rkey=offline_key' };
        if (op === 'send') return { confirmed: true, confirmation: 'target_ack', ...data };
        if (op === 'rename') { name = data.name; return { confirmed: true, filesetId: ID }; }
        if (op === 'create') return { filesetId: ID };
        if (op === 'commit') { committed.push(...data.entries); return { confirmed: true, filesetId: ID }; }
        if (op === 'prepare') return { filesetId: ID, fileUuid: data.fileUuid, uploadKey: 'offline_key', ...serverGrant(data) };
        if (op === 'apply') { registered.push(data); return { confirmed: true, filesetId: ID, fileUuid: data.fileUuid }; }
        return { filesetId: ID, confirmed: true, confirmation: 'server_ack' };
    };
    let fetcher = async (url, init) => {
        httpCalls.push({ url, init });
        if (url === 'https://multimedia.qfile.qq.com/sliceupload') return new Response(p.bytesField(5, Buffer.from('success')));
        return new Response('<script>window.DATA={"fileset_id":"' + ID + '"}</script>');
    };
    const native = { available: () => true, run: async (_capture, params) => {
        assert.notEqual(params.operation, 'delete', 'raw OIDB deletion is never dispatched');
        assert.equal(params.op, 'fixedFlashTransfer'); assert.equal(params.expectedEpoch, capture.epoch); assert.equal(params.expectedUin, capture.self.uin);
        fixed.prepare(params.operation, params.request); calls.push(params); events.push({ operation: params.operation }); return respond(params);
    } };
    const historyService = { batchRemoveUserFileSetHistory: async request => {
        assert.deepEqual(Object.keys(request), ['seq', 'fileSetIdList', 'cancelOnDeleteUserRecords', 'cancelFileSetIdList']);
        assert.equal(request.cancelOnDeleteUserRecords, false); assert.deepEqual(request.cancelFileSetIdList, []);
        assert.equal(request.fileSetIdList.length, 1); assert.ok(Number.isInteger(request.seq) && request.seq > 0);
        const params = { operation: 'delete', request: { filesetId: request.fileSetIdList[0] } };
        calls.push(params); const result = await respond(params);
        if (result.confirmed === true && result.filesetId === request.fileSetIdList[0]) historyRemoved = true;
        return { rsp: { seq: request.seq, result: result.confirmed === true ? 0 : 1, errMs: '' } };
    } };
    const session = () => ({ getFlashTransferService: () => historyService }); capture.session = session();
    const api = createFlashTransfer(capture, { native, fetch: (...args) => { events.push({ operation: 'http', url: args[0] }); return fetcher(...args); } });
    const state = { self: capture.self, capabilities: api.capabilities() };
    const service = { sessionCall: async (_state, method, params) => { assert.equal(method, 'flashTransfer'); return api.execute({ ...params, expectedEpoch: capture.epoch }); } };
    return { capture, api, state, service, root, native, calls, httpCalls, committed, registered, historyService, session, events,
        reply(fn) { respond = fn; }, fetch(fn) { fetcher = fn; },
        execute: (params, context = {}) => api.execute({ ...params, expectedEpoch: capture.epoch }, context),
        action: (action, params = {}) => runFlashTransferActions(service, state, action, params) };
}

test('all 11 public actions use real bounded paths and never fabricate a normal message ID', async t => {
    const f = fixture(t); assert.equal(ACTIONS.size, 11); assert.equal(WRITE_ACTIONS.size, 4);
    assert.equal((await f.action('list_filesets')).complete, false);
    assert.equal((await f.action('get_fileset_info', { fileset_id: ID })).file_list[0].file_name, 'A.txt');
    assert.equal((await f.action('get_flash_file_list', { fileset_id: ID }))[0].fileset_id, ID);
    assert.equal(await f.action('get_share_link', { fileset_id: ID }), 'https://qfile.qq.com/q/OfflineCode');
    assert.deepEqual(await f.action('get_fileset_id', { share_code: 'OfflineCode' }), { fileset_id: ID });
    const download = await f.action('download_fileset', { fileset_id: ID, file_index: 1, file_name: 'A.txt' });
    assert.equal(download.file_name, 'A.txt'); assert.equal(download.file_size, 3);
    assert.equal((await f.action('get_flash_file_url', { fileset_id: ID })).url, download.url);
    assert.deepEqual(await f.action('send_flash_msg', { fileset_id: ID, user_id: 54321 }), { sent: true, message_id: null, confirmation: 'target_ack' });
    assert.deepEqual(await f.action('send_flash_msg', { fileset_id: ID, group_id: 33333 }), { sent: true, message_id: null, confirmation: 'target_ack' });
    assert.equal(await f.action('rename_flash_file', { fileset_id: ID, new_name: 'New Name' }), null);
    assert.equal(await f.action('delete_flash_file', { fileset_id: ID }), null);
    const g = fixture(t); assert.deepEqual(await g.action('create_flash_task', { files: ['A.txt'] }), { fileset_id: ID, task_id: ID });
});

test('create stages immutable media and commits each exact server grant only after its slice ACK', async t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'B.txt'), 'defgh');
    const output = await f.action('create_flash_task', { files: [{ file: 'A.txt', name: 'First.txt' }, 'B.txt'], name: 'Bundle' });
    assert.equal(output.fileset_id, ID); assert.equal(f.committed.length, 2); assert.equal(f.registered.length, 4);
    assert.deepEqual(f.calls.map(item => item.operation), ['create', 'commit', 'complete', 'prepare', 'apply', 'prepare', 'apply', 'prepare', 'apply', 'prepare', 'apply', 'ready', 'metadata']);
    assert.deepEqual(f.events.map(item=>item.operation),['create','commit','complete',...Array.from({length:4},()=>['prepare','http','apply']).flat(),'ready','metadata']);
    assert.equal(f.calls[0].request.size, 8); assert.equal(f.calls[0].request.name, 'Bundle');
    assert.equal(f.calls.filter(item => item.operation === 'commit').length, 1);
    assert.deepEqual(f.committed.map(row => row.fileIndex), [1, 2]);
    assert.equal(f.httpCalls.length, 4);
    const bodies = f.httpCalls.map(call => p.fields(value(p.fields(call.init.body), 107)));
    assert.deepEqual(value(bodies[0], 7), Buffer.from('abc')); assert.deepEqual(value(bodies[1], 7), Buffer.from('defgh'));
    assert.equal(f.registered[2].thumbType, 'png'); assert.equal(f.registered[3].thumbType, 'jpg'); assert.equal(f.registered[3].fileUuid, f.committed[0].fileUuid);
    for(const data of f.registered){const expected=serverGrant(data);assert.equal(data.fileId,expected.token);assert.equal(data.time,expected.time);assert.equal(data.ttl,expected.ttl);}
    assert.deepEqual(f.httpCalls.map(call => Number(value(p.fields(call.init.body), 2))), [14901, 14901, 14903, 14902]);
    for (const request of f.httpCalls) { assert.equal(request.init.redirect, 'manual'); assert.equal(request.url, 'https://multimedia.qfile.qq.com/sliceupload'); assert.ok(request.init.signal instanceof AbortSignal); }
    for(const secret of ['offline_key','server-grant:']){assert.equal(JSON.stringify(output).includes(secret),false);assert.equal(fs.readFileSync(path.join(f.root,'fwd-flash-recovery.json'),'utf8').includes(secret),false);}
    assert.equal(fs.readFileSync(path.join(f.root, 'A.txt'), 'utf8'), 'abc');
});

test('single file size, count, media path scope, symlinks, malformed fields and unsupported capabilities fail before dispatch', async t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'large.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    for (const [action, params] of [['create_flash_task', { files: [] }], ['create_flash_task', { files: Array(9).fill('A.txt') }],
        ['create_flash_task', { files: 'large.bin' }], ['create_flash_task', { files: '../outside.txt' }], ['create_flash_task', { files: 'https://evil.invalid/file' }],
        ['create_flash_task', { files: 'base64://YWJj' }], ['create_flash_task', { files: 'A.txt', name: null }], ['create_flash_task', { files: 'A.txt', thumb_path: 'A.txt' }],
        ['get_flash_file_url', { fileset_id: ID, file_index: 0 }], ['get_flash_file_url', { fileset_id: ID, file_index: null }], ['download_fileset', { fileset_id: ID, file_name: null }],
        ['send_flash_msg', { fileset_id: ID }], ['send_flash_msg', { fileset_id: ID, user_id: 123, group_id: 456 }], ['rename_flash_file', { fileset_id: ID, new_name: '../escape' }],
        ['list_filesets', { endpoint: 'arbitrary' }], ['get_fileset_id', { share_code: 'https://127.0.0.1/q/x' }]]) await assert.rejects(f.action(action, params));
    f.state.capabilities.flashRead = false; await assert.rejects(f.action('list_filesets'), { code: 'UNSUPPORTED' });
    await assert.rejects(f.api.execute({ operation: 'list', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.execute({ operation: 'detail', filesetId: ID, command: 'arbitrary' }), { code: 'INVALID_PARAMS' });
    assert.equal(f.calls.length, 0); assert.equal(f.httpCalls.length, 0);
    try { fs.symlinkSync(path.join(f.root, 'A.txt'), path.join(f.root, 'link.txt')); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
    await assert.rejects(f.action('create_flash_task', { files: 'link.txt' }), { code: 'INVALID_PARAMS' }); assert.equal(f.calls.length, 0);
});

test('shared detail alone never authorizes writes and uncertain writes are never automatically replayed', async t => {
    const f = fixture(t); f.reply(async params => params.operation === 'list' ? { items: [], complete: false } : { filesetId: ID, items: [row()], complete: false });
    for (const operation of ['delete', 'rename', 'send']) await assert.rejects(f.execute({ operation, filesetId: ID, ...(operation === 'rename' ? { name: 'Other' } : operation === 'send' ? { groupId: 33333 } : {}) }), { code: 'FORBIDDEN' });
    assert.equal(f.calls.every(item => item.operation === 'list'), true);
    const g = fixture(t); g.reply(async params => {
        if (params.operation === 'list') return { items: [row()], complete: false };
        if (params.operation === 'detail') return { filesetId: ID, items: [row()], complete: false };
        throw Object.assign(new Error('Uncertain offline dispatch'), { code: 'TIMEOUT' });
    });
    await assert.rejects(g.action('delete_flash_file', { fileset_id: ID }), { code: 'TIMEOUT' });
    await assert.rejects(g.action('delete_flash_file', { fileset_id: ID }), { code: 'BUSY' });
    assert.equal(g.calls.filter(item => item.operation === 'delete').length, 1);
});

test('main download uses exact one-based index and name and rejects thumbnail-only metadata', async t => {
    const f = fixture(t);
    await assert.rejects(f.action('download_fileset', { fileset_id: ID, file_index: 2 }), { code: 'NOT_FOUND' });
    await assert.rejects(f.action('download_fileset', { fileset_id: ID, file_name: 'Wrong.txt' }), { code: 'NOT_FOUND' });
    f.reply(async () => ({ filesetId: ID, complete: false, items: [{ ...meta(), fileId: undefined, thumbnail: 'not-main' }] }));
    await assert.rejects(f.action('get_flash_file_url', { fileset_id: ID }), { code: 'NOT_FOUND' });
    assert.equal(f.calls.some(item => item.operation === 'download'), false);
});

test('share resolution rejects redirects, oversized/ambiguous HTML and validates account access after extraction', async t => {
    const f = fixture(t);
    f.fetch(async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }));
    await assert.rejects(f.action('get_fileset_id', { share_code: 'Code' }), { code: 'QUERY_FAILED' });
    f.fetch(async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }));
    await assert.rejects(f.action('get_fileset_id', { share_code: 'Code' }), { code: 'INVALID_RESPONSE' });
    f.fetch(async () => new Response('{"fileset_id":"' + ID + '","other":{"fileset_id":"' + FILE + '"}}'));
    await assert.rejects(f.action('get_fileset_id', { share_code: 'Code' }), { code: 'INVALID_RESPONSE' });
    f.fetch(async () => new Response('{\\"fileset_id\\":\\"' + ID + '\\"}'));
    assert.deepEqual(await f.action('get_fileset_id', { share_code: 'Code' }), { fileset_id: ID });
    f.reply(async () => ({ filesetId: ID, items: [], complete: false }));
    await assert.rejects(f.action('get_fileset_id', { share_code: 'Code' }), { code: 'NOT_FOUND' });
});

test('create rejects slice failures, instant-transfer mistakes, metadata mismatches and never reports task acceptance as completed', async t => {
    const f = fixture(t); f.fetch(async () => new Response(p.bytesField(5, Buffer.from('failure'))));
    await assert.rejects(f.action('create_flash_task', { files: 'A.txt' }), { code: 'QUERY_FAILED' });
    assert.equal(f.calls.some(call => call.operation === 'ready'), false);
    assert.equal(f.calls.some(call => call.operation === 'apply'),false,'a failed slice cannot be committed');
    const g = fixture(t); g.reply(async params => {
        if (params.operation === 'create') return { filesetId: ID };
        if (params.operation === 'prepare') return { filesetId: ID, fileUuid: params.request.fileUuid, uploadKey: null, ...serverGrant(params.request) };
        if (params.operation === 'metadata') return { filesetId: ID, complete: false, items: [meta()] };
        return { confirmed: true, filesetId: ID, ...(params.operation === 'apply' ? { fileUuid: params.request.fileUuid } : {}) };
    });
    await assert.rejects(g.action('create_flash_task', { files: 'A.txt' }), { code: 'INVALID_RESPONSE' });
    assert.equal(g.httpCalls.length, 0, 'confirmed instant transfer still registers every file but skips bytes');
    assert.equal(g.calls.filter(call => call.operation === 'apply').length, 3);
    const h = fixture(t); h.reply(async params => params.operation === 'create' ? { result: 0, taskAccepted: true } : {});
    await assert.rejects(h.action('create_flash_task', { files: 'A.txt' }));
});

test('create uploads immutable snapshots even if the source changes after registration', async t => {
    const f = fixture(t); const oldNative = f.native.run;
    f.native.run = async (...args) => { const result = await oldNative(...args); if (args[1].operation === 'create') fs.writeFileSync(path.join(f.root, 'A.txt'), 'changed later'); return result; };
    await f.action('create_flash_task', { files: 'A.txt' });
    const body = p.fields(value(p.fields(f.httpCalls[0].init.body), 107)); assert.deepEqual(value(body, 7), Buffer.from('abc'));
    assert.equal(f.committed[0].size, 3);
});

test('missing or malformed server grants stop before upload/apply and retain only owned cleanup recovery', async t => {
    for(const change of [value=>{delete value.token;},value=>{value.token='';},value=>{value.token='private-grant\n';},value=>{value.token='x'.repeat(4097);},
        value=>{delete value.time;},value=>{delete value.ttl;},value=>{value.time='1700000000';},value=>{value.ttl=-1;},value=>{value.time=0x100000000;}]){
        const f=fixture(t),original=f.native.run;
        f.native.run=async(...args)=>{const result=await original(...args);if(args[1].operation==='prepare')change(result);return result;};
        await assert.rejects(f.action('create_flash_task',{files:'A.txt'}),error=>{
            assert.equal(error.code,'INVALID_RESPONSE');assert.match(error.message,/cleanup_pending/);assert.equal(error.message.includes('private-grant'),false);return true;
        });
        assert.deepEqual(f.calls.map(row=>row.operation),['create','commit','complete','prepare']);assert.equal(f.httpCalls.length,0);
        const records=createFlashRecovery(f.root,'12345','u_self').list();assert.equal(records.length,1);assert.equal(records[0].stage,'cleanup_pending');assert.equal(records[0].lastStage,'complete');
        const journal=fs.readFileSync(path.join(f.root,'fwd-flash-recovery.json'),'utf8');assert.equal(journal.includes('server-grant:'),false);assert.equal(journal.includes('private-grant'),false);
    }
});

test('instant transfer still needs server grants and preserves explicitly zero time/ttl without HTTP uploads', async t => {
    const f=fixture(t),original=f.native.run;
    f.native.run=async(...args)=>{const result=await original(...args);if(args[1].operation==='prepare')Object.assign(result,{uploadKey:null,time:0,ttl:0});return result;};
    assert.equal((await f.action('create_flash_task',{files:'A.txt'})).fileset_id,ID);assert.equal(f.httpCalls.length,0);assert.equal(f.registered.length,3);
    assert(f.registered.every(row=>row.fileId===serverGrant(row).token&&row.time===0&&row.ttl===0));
});

test('session change, cancellation and uncertain commit after a slice never dispatch the next stage or replay writes', async t => {
    for(const reason of ['session','cancel','commit-timeout']){
        const f=fixture(t),control=new AbortController(),original=f.native.run;
        if(reason==='commit-timeout')f.native.run=async(...args)=>{const result=await original(...args);if(args[1].operation==='apply')throw Object.assign(Error('Unconfirmed commit ACK'),{code:'TIMEOUT'});return result;};
        else f.fetch(async()=>{if(reason==='session'){f.capture.epoch='changed';f.capture.session={};}else control.abort();return new Response(p.bytesField(5,Buffer.from('success')));});
        await assert.rejects(f.execute({operation:'create',files:'A.txt'},{signal:control.signal}),{code:reason==='session'?'SESSION_CHANGED':reason==='cancel'?'EXPIRED':'TIMEOUT'});
        await tick(); await tick(); // The caller deadline may settle before the physical task's catch journals cleanup.
        assert.equal(f.calls.filter(row=>row.operation==='prepare').length,1);assert.equal(f.calls.filter(row=>row.operation==='apply').length,reason==='commit-timeout'?1:0);
        assert.equal(f.calls.some(row=>['ready','delete','metadata'].includes(row.operation)),false);
        const record=createFlashRecovery(f.root,'12345','u_self').list()[0];assert.equal(record.stage,'cleanup_pending');assert.equal(record.lastStage,'complete');
    }
});

test('create reads delayed main metadata at most three times without replaying any writes', async t => {
    const f = fixture(t), original = f.native.run; let reads = 0;
    f.native.run = async (...args) => {
        const result = await original(...args);
        if (args[1].operation !== 'metadata') return result;
        reads++;
        if (reads === 1) return { ...result, items: [] };
        if (reads === 2) return { ...result, items: result.items.map(({ fileId, ...item }) => item) };
        return result;
    };
    assert.equal((await f.action('create_flash_task', { files: 'A.txt' })).fileset_id, ID);
    assert.equal(reads, 3);
    for (const op of ['create', 'commit', 'complete', 'ready']) assert.equal(f.calls.filter(call => call.operation === op).length, 1);
    for (const op of ['prepare', 'apply']) assert.equal(f.calls.filter(call => call.operation === op).length, 3);
    assert.equal(f.httpCalls.length, 3);
});

test('create fails on conflicting final metadata immediately despite successful stage ACKs', async t => {
    for (const change of [row => ({ ...row, fileUuid: ID }), row => ({ ...row, fileIndex: 2 }), row => ({ ...row, name: 'Other.txt' }),
        row => ({ ...row, size: '4' }), row => ({ ...row, fileId: 'other_main' }), row => ({ ...row, filesetId: FILE })]) {
        const f = fixture(t), original = f.native.run;
        f.native.run = async (...args) => {
            const result = await original(...args), op = args[1].operation;
            if (op === 'complete' || op === 'ready') {
                const prepared = fixed.prepare(op, args[1].request);
                return fixed.decode(Buffer.concat([p.varintField(1, prepared.command), p.varintField(2, prepared.sub), p.bytesField(4, Buffer.from([0xff]))]), prepared);
            }
            return op === 'metadata' ? { ...result, items: result.items.map(change) } : result;
        };
        await assert.rejects(f.action('create_flash_task', { files: 'A.txt' }), { code: 'INVALID_RESPONSE' });
        assert.equal(f.calls.filter(call => call.operation === 'metadata').length, 1);
        assert.equal(createFlashRecovery(f.root, '12345', 'u_self').list()[0].stage, 'cleanup_pending');
    }
});

test('create never upgrades perpetually incomplete metadata to success', async t => {
    const f = fixture(t), original = f.native.run;
    f.native.run = async (...args) => {
        const result = await original(...args);
        return args[1].operation === 'metadata' ? { ...result, items: [] } : result;
    };
    await assert.rejects(f.action('create_flash_task', { files: 'A.txt' }), { code: 'INVALID_RESPONSE' });
    assert.equal(f.calls.filter(call => call.operation === 'metadata').length, 3);
    assert.equal(f.calls.filter(call => call.operation === 'create').length, 1);
    assert.equal(f.calls.filter(call => call.operation === 'ready').length, 1);
});

test('cancellation stops pending metadata backoff without dispatching another read or write', async t => {
    const f = fixture(t), original = f.native.run, control = new AbortController(); let observed;
    const firstRead = new Promise(resolve => { observed = resolve; });
    f.native.run = async (...args) => {
        const result = await original(...args);
        if (args[1].operation !== 'metadata') return result;
        observed(); return { ...result, items: [] };
    };
    const running = f.execute({ operation: 'create', files: 'A.txt' }, { signal: control.signal });
    await firstRead; await tick(); control.abort();
    await assert.rejects(running, { code: 'EXPIRED' }); await tick();
    assert.equal(f.calls.filter(call => call.operation === 'metadata').length, 1);
    assert.equal(f.calls.filter(call => call.operation === 'ready').length, 1);
    assert.equal(createFlashRecovery(f.root, '12345', 'u_self').list()[0].stage, 'cleanup_pending');
});

test('session rotation aborts pending metadata backoff and metadata errors are never retried', async t => {
    const f = fixture(t), original = f.native.run; let observed;
    const firstRead = new Promise(resolve => { observed = resolve; });
    f.native.run = async (...args) => {
        const result = await original(...args);
        if (args[1].operation !== 'metadata') return result;
        observed(); return { ...result, items: [] };
    };
    const running = f.execute({ operation: 'create', files: 'A.txt' });
    await firstRead; await tick(); f.capture.epoch = 'e2';
    Capture.prototype.rejectPending.call(f.capture, Object.assign(new Error('Offline session changed'), { code: 'SESSION_CHANGED' }));
    await assert.rejects(running, { code: 'SESSION_CHANGED' }); await tick();
    assert.equal(f.calls.filter(call => call.operation === 'metadata').length, 1);
    const g = fixture(t), run = g.native.run;
    g.native.run = async (...args) => {
        const result = await run(...args);
        if (args[1].operation === 'metadata') throw Object.assign(new Error('Offline server error'), { code: 'KERNEL_ERROR' });
        return result;
    };
    await assert.rejects(g.action('create_flash_task', { files: 'A.txt' }), { code: 'KERNEL_ERROR' });
    assert.equal(g.calls.filter(call => call.operation === 'metadata').length, 1);
});

test('physical pending slots remain occupied after caller cancellation and across session changes', async t => {
    const f = fixture(t); const completions = [];
    f.reply(() => new Promise(resolve => completions.push(resolve)));
    const waiting = [];
    for (let index = 0; index < 4; index++) {
        const control = new AbortController(), promise = f.execute({ operation: 'list' }, { signal: control.signal });
        waiting.push(promise.catch(error => error.code)); await tick(); control.abort(); await promise.catch(() => {});
    }
    assert.equal(completions.length, 4); await assert.rejects(f.execute({ operation: 'list' }), { code: 'BUSY' });
    f.capture.epoch = 'e2'; f.capture.session = {}; f.api.clear();
    await assert.rejects(f.execute({ operation: 'list' }), { code: 'BUSY' });
    for (const complete of completions) complete({ items: [], complete: false }); await tick(); await tick();
    f.reply(async () => ({ items: [], complete: false })); assert.equal((await f.execute({ operation: 'list' })).selfUin, '12345'); await Promise.all(waiting);
});

test('session rotation between steps prevents any later mutation and per-fileset concurrent writes dispatch once', async t => {
    const f = fixture(t); let finish;
    const oldNative = f.native.run;
    f.native.run = async (...args) => { if (args[1].operation === 'list') { f.calls.push(args[1]); return new Promise(resolve => { finish = resolve; }); } return oldNative(...args); };
    const first = f.action('delete_flash_file', { fileset_id: ID }); await tick();
    await assert.rejects(f.action('rename_flash_file', { fileset_id: ID, new_name: 'Other' }), { code: 'BUSY' });
    f.capture.epoch = 'e2'; f.capture.session = {}; finish({ items: [row()], complete: false });
    await assert.rejects(first, { code: 'SESSION_CHANGED' }); assert.equal(f.calls.some(call => call.operation === 'delete'), false);
});

test('public seam validates account/result identity, exact recipient confirmation and byte limits', async t => {
    const f = fixture(t);
    const reply = (operation, result, selfUin = '12345') => { f.service.sessionCall = async () => ({ operation, result, selfUin }); };
    reply('list', { items: [row()], complete: false }, '99999'); await assert.rejects(f.action('list_filesets'), { code: 'INVALID_RESPONSE' });
    reply('send', { filesetId: ID, confirmed: true, confirmation: 'server_ack', groupId: '33333' });
    await assert.rejects(f.action('send_flash_msg', { fileset_id: ID, group_id: 33333 }), { code: 'INVALID_RESPONSE' });
    reply('rename', { filesetId: ID, confirmed: true, confirmation: 'name_readback', name: 'Different' });
    await assert.rejects(f.action('rename_flash_file', { fileset_id: ID, new_name: 'Expected' }), { code: 'INVALID_RESPONSE' });
    reply('detail', { filesetId: ID, complete: false, items: [{ ...row(), size: '18446744073709551614' }] });
    assert.equal((await f.action('get_fileset_info', { fileset_id: ID })).file_list[0].size, '18446744073709551614');
});

test('allocation is durable before commit and partial recovery survives a service restart', async t => {
    const f = fixture(t), original = f.native.run;
    const journal = () => createFlashRecovery(f.root, '12345', 'u_self');
    f.native.run = async (...args) => {
        const op = args[1].operation;
        if (op === 'commit') assert.equal(journal().list()[0].stage, 'allocated', 'allocation must reach disk before next network mutation');
        if (op === 'complete') throw Object.assign(new Error('Unrecognized offline acknowledgement'), { code: 'INVALID_RESPONSE' });
        return original(...args);
    };
    await assert.rejects(f.action('create_flash_task', { files: 'A.txt' }), error => {
        assert.equal(error.code, 'INVALID_RESPONSE'); assert.match(error.message, /flash_stage=committed;cleanup_pending/);
        assert.equal(error.message.includes(ID), false); return true;
    });
    const record = journal().list()[0]; assert.equal(record.filesetId, ID); assert.equal(record.stage, 'cleanup_pending'); assert.equal(record.lastStage, 'committed');
    assert.equal(f.calls.some(row => row.operation === 'delete'), false, 'failure never auto-deletes the remote allocation');
    const deleted = [];
    f.reply(async params => {
        if (params.operation === 'list') return { items: [], complete: false };
        assert.equal(params.operation, 'delete', 'partial cleanup cannot require a completed detail row'); deleted.push(params.request.filesetId);
        return { filesetId: ID, confirmed: true, confirmation: 'server_ack' };
    });
    const restarted = createFlashTransfer(f.capture, { native: f.native });
    assert.equal((await restarted.execute({ operation: 'delete', filesetId: ID, expectedEpoch: f.capture.epoch })).result.confirmed, true);
    assert.deepEqual(deleted, [ID]); assert.deepEqual(journal().list(), []);
});

test('partial journal authorizes only explicit deletion for the exact account', async t => {
    const f = fixture(t), recovery = createFlashRecovery(f.root, '12345', 'u_self');
    const release = recovery.prepare(); recovery.allocated(ID); release();
    f.reply(async params => {
        assert.equal(params.operation, 'list'); return { items: [], complete: false };
    });
    await assert.rejects(f.execute({ operation: 'rename', filesetId: ID, name: 'Other' }), { code: 'FORBIDDEN' });
    await assert.rejects(f.execute({ operation: 'send', filesetId: ID, groupId: '33333' }), { code: 'FORBIDDEN' });
    await assert.rejects(f.execute({ operation: 'delete', filesetId: FILE }), { code: 'FORBIDDEN' });
    const calls = f.calls.length;
    f.capture.self = { ...f.capture.self, uin: '54321' }; f.capture.epoch = 'other'; f.capture.session = f.session();
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'INVALID_CONFIG' });
    assert.equal(f.calls.length, calls); assert.equal(recovery.has(ID), true);
});

test('failed delete retains recovery and session rotation permits one later explicit cleanup', async t => {
    const f = fixture(t), recovery = createFlashRecovery(f.root, '12345', 'u_self');
    const release = recovery.prepare(); recovery.allocated(ID); recovery.stage(ID, 'cleanup_pending'); release();
    f.reply(async () => ({ filesetId: ID, confirmed: false }));
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'KERNEL_ERROR' });
    assert.equal(recovery.has(ID), true);
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'BUSY' });
    assert.equal(f.calls.length, 1);
    f.capture.epoch = 'e2'; f.capture.session = f.session(); f.api.clear();
    f.reply(async params => params.operation === 'list' ? { items: [], complete: false } : { filesetId: ID, confirmed: true, confirmation: 'server_ack' });
    await f.execute({ operation: 'delete', filesetId: ID }); assert.equal(recovery.has(ID), false); assert.equal(f.calls.filter(row => row.operation === 'delete').length, 2);
});

test('late allocation after cancellation or session rotation is journaled without dispatching commit', async t => {
    for (const changed of ['cancel', 'session']) {
        const f = fixture(t), control = new AbortController(); let complete;
        f.reply(params => {
            assert.equal(params.operation, 'create'); return new Promise(resolve => { complete = resolve; });
        });
        const waiting = f.execute({ operation: 'create', files: 'A.txt' }, { signal: control.signal });
        await tick(); assert.equal(typeof complete, 'function');
        if (changed === 'cancel') { control.abort(); await assert.rejects(waiting, { code: 'EXPIRED' }); }
        else { f.capture.epoch = 'e2'; f.capture.session = {}; }
        complete({ filesetId: ID });
        if (changed === 'session') await assert.rejects(waiting, { code: 'SESSION_CHANGED' });
        await tick(); await tick();
        const record = createFlashRecovery(f.root, '12345', 'u_self').list()[0];
        assert.equal(record.filesetId, ID); assert.equal(record.stage, 'cleanup_pending'); assert.equal(record.lastStage, 'allocated');
        assert.deepEqual(f.calls.map(row => row.operation), ['create']);
    }
});

test('unusable recovery journal blocks allocation before the first network write', async t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.root, 'fwd-flash-recovery.json'), '{invalid', { mode: 0o600 });
    await assert.rejects(f.action('create_flash_task', { files: 'A.txt' }), { code: 'INVALID_CONFIG' });
    assert.equal(f.calls.length, 0); assert.equal(f.httpCalls.length, 0);
});

test('QQ 3.2.35-54395 creation uses the full confirmation chain while native delete stays independent', async t => {
    const f = fixture(t); f.capture.qqVersion = '3.2.35-54395';
    const capabilities = f.api.capabilities();
    assert.equal(capabilities.flashCreate, true); assert.equal(capabilities.flashDelete, true); assert.equal(capabilities.flashRead, true);
    assert.equal(capabilities.flashWrite, true, 'other fixed writes keep independent capability evidence');
    assert.equal((await f.action('create_flash_task', { files: 'A.txt' })).fileset_id, ID);
    assert.equal(f.calls.at(-1).operation, 'metadata'); const calls = f.calls.length;
    f.capture.session = {};
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'UNSUPPORTED' });
    capabilities.flashDelete = false;
    f.state.capabilities = capabilities;
    await assert.rejects(f.action('delete_flash_file', { fileset_id: ID }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, calls);
    assert.equal((await f.execute({ operation: 'list' })).result.items.length, 1);
});

test('native delete requires inventory absence after ACK and retains recovery on uncertain readback', async t => {
    const f = fixture(t), recovery = createFlashRecovery(f.root, '12345', 'u_self');
    const release = recovery.prepare(); recovery.allocated(ID); release();
    f.reply(async params => params.operation === 'list' ? { items: [row()], complete: false } : { filesetId: ID, confirmed: true });
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'INVALID_RESPONSE' });
    assert.equal(recovery.has(ID), true); assert.equal(f.calls.filter(call => call.operation === 'delete').length, 1);
    await assert.rejects(f.execute({ operation: 'delete', filesetId: ID }), { code: 'BUSY' });
    const g = fixture(t);
    const output = await g.execute({ operation: 'delete', filesetId: ID });
    assert.equal(output.result.confirmation, 'account_history_removed');
    assert.deepEqual(g.calls.map(call => call.operation), ['list', 'detail', 'delete', 'list']);
});
