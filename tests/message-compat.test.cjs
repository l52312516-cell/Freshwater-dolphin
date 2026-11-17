'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const codec = require('../src/onebot/codec.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { executeQuickOperation } = require('../src/onebot/quick-operation.cjs');
const { runSingleForward } = require('../src/onebot/single-forward-actions.cjs');
const { StatusCommand } = require('../src/status-command.cjs');
const { annotate, safeDiagnostic } = require('../src/diagnostics.cjs');
const { startServer } = require('../src/ipc/server.cjs');
const { RpcClient } = require('../src/ipc/client.cjs');
const { createLogger } = require('../src/log.cjs');
const { normalize } = require('../src/manager/logs.cjs');
const { metadata } = require('../src/onebot/message-compat.cjs');
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
const unknown = () => ({ elementType: 99, unknownElement: { private: 'NATIVE_SECRET' } });
const source = (seq = 42, elements = [text('before'), unknown(), text('after')]) => ({ chatType: 2,
    peerUid: '33333', peerUin: '33333', senderUin: '22222', senderUid: 'u_sender', msgTime: '1800000000',
    msgId: String(18446744073709551000n + BigInt(seq)), msgSeq: String(seq), msgRandom: 7, elements });
function fixture(t) {
    const parent = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(parent, { recursive: true });
    const directory = fs.mkdtempSync(path.join(parent, 'message-compat-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const store = new MessageStore({ directory: path.join(directory, 'store') });
    const state = { ready: true, online: true, epoch: 'compat-session', self: { uin: '11111', uid: 'u_self' },
        capabilities: { reply: true, text: true, history: true, groupTodoList: true, aiVoiceGenerate: true } };
    const calls = [], logs = [], messages = [], records = [source()];
    const logger = (event, details) => logs.push({ event, ...details }); logger.message = value => messages.push(value);
    const backend = { async call(method, params = {}) {
        calls.push({ method, params });
        if (method === 'status') return structuredClone(state);
        if (method === 'resolve') return { uin: '22222', uid: params.uid || 'u_sender' };
        if (method === 'getMessage') return records.find(record => record.msgId === params.nativeId);
        if (method === 'history') return { records: records.slice() };
        if (method === 'extendedQuery2') return { groupId: '33333', todos: [{ sequence: 42, random: 7, sourceId: '42_7', text: 'todo' }] };
        throw new Error('Unexpected backend call: ' + method);
    } };
    const service = new OneBotService({ backend, store, logger, profileId: 'compat' });
    const incoming = record => ({ kind: 'message', epoch: state.epoch, selfUin: state.self.uin, record });
    return { directory, store, state, calls, logs, messages, records, backend, service, incoming };
}

test('compatible decoding preserves ordered standard text placeholders and strict decoding starts no I/O', async () => {
    let media = 0;
    const record = source(42, [text('A[CQ:at,qq=all]'), { elementType: 2, picElement: {} }, unknown(),
        { elementType: 1, textElement: { content: '@role', atType: 8 } },
        { elementType: 6, faceElement: { faceIndex: 222, faceType: 3 } }, text('Z')]);
    const image = async () => { media++; throw Object.assign(new Error('PRIVATE_URL?cookie=secret'), { code: 'UNSUPPORTED' }); };
    await assert.rejects(codec.decodeKernel(record, { image }), { code: 'UNSUPPORTED' }); assert.equal(media, 0);
    const decoded = await codec.decodeKernel(record, { mode: 'compatible', image });
    assert.equal(media, 1); assert.equal(decoded.message.length, 6); assert.equal(decoded.issues.length, 4);
    assert.equal(decoded.message[0].data.text, 'A[CQ:at,qq=all]'); assert.equal(decoded.message.at(-1).data.text, 'Z');
    assert.deepEqual(decoded.issues.map(item => item.element_index), [1, 2, 3, 4]);
    assert.equal(decoded.issues[2].at_type, 8); assert.equal(decoded.issues[3].face_type, 3);
    assert.ok(decoded.message.every(segment => segment.type === 'text'));
    assert.equal(JSON.stringify(decoded).includes('NATIVE_SECRET'), false);
    assert.equal(JSON.stringify(decoded).includes('PRIVATE_URL'), false);
    assert.match(codec.stringify(decoded.message), /A&#91;CQ:at,qq=all&#93;/);
});

test('malformed identity and payloads cannot become placeholders even after otherwise readable content', async t => {
    const f = fixture(t);
    for (const elements of [[{ elementType: 2, picElement: {} }, { elementType: 99 }],
        [text('safe'), { ...unknown(), textElement: { content: 'conflict' } }],
        [text('safe'), { elementType: 1, textElement: { content: 1 } }],
        [{ elementType: 2, picElement: {} }, { elementType: 1, textElement: { content: '@bad', atType: 2, atNtUid: 'not-a-uid' } }],
        [{ elementType: 2, picElement: {} }, { elementType: 7, replyElement: { replayMsgId: '5', senderUidStr: 'invalid UID' } }],
        [text('safe'), { elementType: 8, grayTipElement: {} }]]) {
        let read = false;
        await assert.rejects(codec.decodeKernel(source(42, elements), { mode: 'compatible', image: () => { read = true; } }), { code: 'INVALID_RESPONSE' });
        assert.equal(read, false);
    }
    const event = await f.service.event(f.incoming(source(42, [text('before'), unknown()])));
    assert.equal(event._freshwater.content_status, 'partial');
    const invalid = source(43, [text('private')]); invalid.senderUid = '';
    assert.equal(await f.service.event(f.incoming(invalid)), null);
});

test('runtime/profile/session errors and invalid media responses remain fatal, while a missing resource is partial', async () => {
    const record = source(42, [{ elementType: 4, pttElement: {} }, text('caption')]);
    for (const [code, reason] of [['UNSUPPORTED', 'runtime_profile_denied'], ['NOT_READY', 'event_session'],
        ['INVALID_RESPONSE', 'protocol_response_invalid'], ['TIMEOUT', 'outcome_unknown']]) {
        await assert.rejects(codec.decodeKernel(record, { mode: 'compatible', record: async () => {
            throw annotate(Object.assign(new Error('private native failure'), { code }), { reason });
        } }), { code });
    }
    const decoded = await codec.decodeKernel(record, { mode: 'compatible', record: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
    assert.equal(decoded.issues[0].reason, 'media_unavailable'); assert.equal(decoded.message[1].data.text, 'caption');
});

test('an all-unknown message remains visibly partial with bounded issue detail and an exact total', async () => {
    const decoded = await codec.decodeKernel(source(42, Array.from({ length: 1000 }, unknown)), { mode: 'compatible' });
    const partial = metadata(decoded.issues);
    assert.equal(partial.issue_count, 1000); assert.equal(partial.issues.length, 32);
    assert.equal(decoded.message.length, 1000); assert.ok(decoded.message.every(segment => segment.type === 'text'));
    await assert.rejects(codec.decodeKernel(source(42, Array.from({ length: 1001 }, unknown)), { mode: 'compatible' }), { code: 'INVALID_RESPONSE' });
});

test('live, get_msg, history, todo cache and restart retain partial status and one stable message mapping', async t => {
    const f = fixture(t), event = await f.service.event(f.incoming(f.records[0]));
    assert.equal(event._freshwater.content_status, 'partial'); assert.equal(f.messages[0].partial, true);
    const diagnostic = f.logs.find(item => item.event === 'message_partial');
    assert.equal(diagnostic.traceId, event._freshwater.trace_id); assert.match(diagnostic.traceId, /^[a-f0-9]{32}$/);
    assert.equal(f.store.get('11111', event.message_id).emitted, true);
    assert.equal(await f.service.event(f.incoming(f.records[0])), null);
    const single = await f.service.action({ action: 'get_msg', params: { message_id: event.message_id }, echo: 'original-echo' });
    assert.equal(single.status, 'ok'); assert.equal(single.retcode, 0); assert.equal(single.echo, 'original-echo');
    assert.equal(single.data._freshwater.content_status, 'partial'); assert.equal(single.data.message_id, event.message_id);
    const todo = await f.service.action({ action: 'get_group_todo_list', params: { group_id: 33333 } });
    assert.equal(todo.data[0]._freshwater.content_status, 'partial'); assert.deepEqual(todo.data[0].message, event.message);
    f.records.push(source(43, [text('complete')]));
    const history = await f.service.action({ action: 'get_group_msg_history', params: { group_id: 33333 } });
    assert.equal(history.data._freshwater.partial_message_count, 1); assert.equal(history.data.messages[0].message_id, event.message_id);
    f.store.close();
    const restarted = new OneBotService({ backend: f.backend, store: new MessageStore({ directory: path.join(f.directory, 'store') }) });
    const readback = await restarted.action({ action: 'get_msg', params: { message_id: event.message_id } });
    assert.equal(readback.data._freshwater.content_status, 'partial'); assert.deepEqual(readback.data.message, event.message);
    assert.equal(JSON.stringify(f.logs).includes('NATIVE_SECRET'), false);
});

test('single-message forwarding never re-sends role-mention or media placeholders as original text', async t => {
    const f = fixture(t); f.records[0].elements = [text('before'), { elementType: 1, textElement: { content: '@role', atType: 8 } }];
    const event = await f.service.event(f.incoming(f.records[0]));
    assert.equal(event._freshwater.content_status, 'partial');
    await assert.rejects(runSingleForward(f.service, f.state, 'forward_group_single_msg', { group_id: 33333, message_id: event.message_id }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.some(call => call.method === 'sendMessage'), false);
});

test('a rejected later history record publishes neither staged partial mappings nor accepted-partial diagnostics', async t => {
    const f = fixture(t); f.records.push(source(43, [{ elementType: 99 }]));
    const result = await f.service.action({ action: 'get_group_msg_history', params: { group_id: 33333 } });
    assert.equal(result.status, 'failed'); assert.equal(f.store.state('11111').byId.size, 0);
    assert.equal(f.logs.some(row => row.event === 'message_partial'), false);
    assert.equal(f.logs.filter(row => row.event === 'action_failed').length, 1);
});

test('partial status commands pass through, explicit quick replies work, destructive mixed operations fail before any reply', async t => {
    const f = fixture(t), partial = { post_type: 'message', message_type: 'group', self_id: 11111, user_id: 22222,
        group_id: 33333, message_id: 1, message: [{ type: 'text', data: { text: '#fd' } }],
        _freshwater: { schema: 1, content_status: 'partial' } };
    const command = new StatusCommand({ root: f.directory, service: f.service, status: () => f.state, authorizeSession: () => true });
    assert.equal(command.handle(partial, { epoch: f.state.epoch, selfUin: '11111' }), false); await command.close();
    const invoked = [], invoke = async request => { invoked.push(request); return { status: 'ok', retcode: 0 }; };
    await executeQuickOperation(partial, { reply: '明确信息回复', at_sender: false }, invoke);
    assert.equal(invoked[0].params.message[0].data.text, '明确信息回复'); invoked.length = 0;
    for (const operation of [{ reply: 'must not send', delete: true }, { reply: 'must not send', ban: true }, { kick: true }]) {
        await assert.rejects(executeQuickOperation(partial, operation, invoke), error => error.code === 'UNSUPPORTED' && error.diagnostic.reason === 'partial_quick_operation');
    }
    assert.equal(invoked.length, 0);
});

test('IPC, action diagnostics and log reader retain only bounded reason/phase/correlation fields', async t => {
    const f = fixture(t), backend = new EventEmitter(), traceId = 'a'.repeat(32);
    backend.call = async () => { throw Object.assign(new Error('a fixed error'), { code: 'UNSUPPORTED', diagnostic: {
        reason: 'media_format_invalid', phase: 'media_parse', mediaType: 'record', traceId,
        elementType: 4, elementIndex: 1, businessCode: 2, token: 'NATIVE_SECRET', url: 'PRIVATE_URL' } }); };
    const dir = path.join(f.directory, 'ipc'), server = await startServer({ dir, backend, pollMs: 5 });
    const client = new RpcClient({ directory: dir, timeoutMs: 2000 });
    t.after(async () => { client.close(); await server.close(); });
    await assert.rejects(client.call('status'), error => {
        assert.equal(error.diagnostic.reason, 'media_format_invalid'); assert.equal(error.diagnostic.traceId, traceId);
        assert.equal(JSON.stringify(error.diagnostic).includes('NATIVE_SECRET'), false); return true;
    });
    const original = f.backend.call;
    f.backend.call = (method, params) => method === 'voiceExtra' ? backend.call() : original(method, params);
    const result = await f.service.action({ action: 'get_ai_record', params: { group_id: 33333, character: 'voice', text: 'test' }, echo: 7 });
    assert.equal(result.status, 'failed'); assert.equal(result.echo, 7);
    const failed = f.logs.find(item => item.event === 'action_failed');
    assert.equal(failed.reason, 'media_format_invalid'); assert.equal(failed.phase, 'media_parse'); assert.equal(failed.stage, 'voiceExtra');
    assert.deepEqual(safeDiagnostic({ reason: { toString: null }, elementType: -1, traceId: 'secret', phase: 'PRIVATE_URL', body: 'NATIVE_SECRET' }), {});
    const logDir = path.join(f.directory, 'logs'), logger = createLogger(logDir), stdout = process.stdout.write;
    process.stdout.write = () => true;
    try { logger('message_partial', { ...failed, event: undefined, count: 2, token: 'NATIVE_SECRET' }); }
    finally { process.stdout.write = stdout; }
    const raw = fs.readFileSync(path.join(logDir, 'adapter.jsonl'), 'utf8');
    assert.equal(raw.includes('NATIVE_SECRET'), false); assert.equal(raw.includes('PRIVATE_URL'), false);
    const row = JSON.parse(raw); assert.equal(row.reason, 'media_format_invalid'); assert.equal(row.traceId, failed.traceId);
    const displayed = normalize(row, 'compat', false);
    assert.equal(displayed.level, 'WARN'); assert.equal(displayed.phase, 'media_parse');
    assert.match(displayed.message, /部分内容已用占位表示/);
    assert.match(displayed.message, /媒体格式尚未支持/);
    assert.equal(JSON.stringify(displayed).includes('NATIVE_SECRET'), false);
});
