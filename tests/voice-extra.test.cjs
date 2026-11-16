'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { createVoiceExtra } = require('../src/qq/voice-extra.cjs'), { runVoiceExtra, ACTIONS } = require('../src/onebot/voice-extra-actions.cjs');
const protocol = require('../src/qq/voice-extra-protocol.cjs'), media = require('../src/qq/media.cjs');
const SILK = Buffer.concat([Buffer.from('#!SILK_V3'), Buffer.from([3, 0, 1, 2, 3])]), md5 = crypto.createHash('md5').update(SILK).digest('hex');
const next = () => new Promise(resolve => setImmediate(resolve));
const node = () => ({ fileUuid: 'exact_media_uuid', info: { fileHash: md5, fileSize: SILK.length, type: { type: 3, voiceFormat: 1 } } });
const record = (overrides = {}) => ({ chatType: 2, peerUid: '33333', senderUin: '12345', senderUid: 'u_self', msgId: '18446744073709551000', msgSeq: '444', sendStatus: 2,
    elements: [{ elementType: 4, elementId: 'voice_element', pttElement: { fileUuid: 'exact_media_uuid', md5HexStr: md5, fileSize: String(SILK.length), duration: 1.5, formatType: 1, text: '' } }], ...overrides });
function fixture(t) {
    const temp = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temp, { recursive: true }); const directory = fs.mkdtempSync(path.join(temp, 'voice-extra-')); if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const capture = new EventEmitter(); Object.assign(capture, { epoch: 'e1', session: {}, self: { uin: '12345', uid: 'u_self' }, bus: new EventEmitter(), mediaDirectory: directory,
        ensureReady() {}, hasMethods: () => true, deadline: operation => operation() });
    const calls = [], reads = [], translations = [], downloads = [], remembered = [], queued = []; let current = record();
    let read = async () => current, receive = async () => media.exportMedia(directory, 'record', SILK);
    let invoke = async (_service, _method, args) => { translations.push(args); current.elements[0].pttElement.text = ' 已识别原始语音 '; return { result: 0 }; };
    let respond = async params => {
        if (params.operation === 'voice.synthesize') { capture.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [current] }); return { ...params.request, pending: false, node: node() }; }
        return { groupId: params.request.groupId, fileUuid: params.request.node.fileUuid, url: 'https://multimedia.nt.qq.com/voice?key=official' };
    };
    let fetcher = async () => new Response(SILK, { headers: { 'content-length': String(SILK.length) } });
    capture.getMessage = async data => { reads.push(data); return read(data); }; capture.receiveMedia = (...args) => receive(...args); capture.invoke = (...args) => invoke(...args);
    const native = { available: () => true, run: async (_capture, params) => { protocol.prepare(params.operation, params.request); assert.equal(params.op, 'fixedVoiceExtra'); assert.equal(params.expectedEpoch, capture.epoch); assert.equal(params.expectedUin, capture.self.uin); calls.push(params); return respond(params); } };
    const api = createVoiceExtra(capture, { native, fetchImpl: (...args) => { downloads.push(args); return fetcher(...args); } });
    const state = { self: capture.self, capabilities: api.capabilities() }, service = { record: async (_state, id, _unused, options) => { assert.equal(id, 7); assert.deepEqual(options, { refresh: true }); return current; },
        sessionCall: (_state, method, data) => { assert.equal(method, 'voiceExtra'); return api.execute({ ...data, expectedEpoch: capture.epoch }); },
        store: { remember: (uin, value) => { remembered.push({ uin, value }); return { id: 73 }; } }, queueSentMessage: value => queued.push(value) };
    return { capture, api, state, service, calls, reads, translations, downloads, remembered, queued, directory,
        get current() { return current; }, set current(value) { current = value; }, reply(fn) { respond = fn; }, read(fn) { read = fn; }, receive(fn) { receive = fn; }, invoke(fn) { invoke = fn; }, fetch(fn) { fetcher = fn; },
        execute: (data, context) => api.execute({ ...data, expectedEpoch: capture.epoch }, context), action: (action, data = {}) => runVoiceExtra(service, state, action, data) };
}
const ai = { group_id: 33333, character: 'real-character', text: ' exact voice \n' };

test('AI send correlates early native receipt by exact self/group/media UUID and stores real native ID', async t => {
    const f = fixture(t); assert.equal(ACTIONS.size, 3);
    assert.deepEqual(await f.action('send_group_ai_record', ai), { message_id: 73 });
    assert.equal(f.calls.length, 1); assert.equal(f.remembered[0].value.msgId, f.current.msgId); assert.equal(f.remembered[0].uin, '12345'); assert.equal(f.queued[0].messageId, 73);
    assert.deepEqual(f.reads[0], { peer: { chatType: 2, peerUid: '33333' }, nativeId: f.current.msgId });
    assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0); assert.equal(f.capture.listenerCount('event'), 0);
});

test('AI generate returns source URL only after actual self-message and exact downloaded SILK/digest proof', async t => {
    const f = fixture(t); assert.equal(await f.action('get_ai_record', ai), 'https://multimedia.nt.qq.com/voice?key=official');
    assert.deepEqual(f.calls.map(value => value.operation), ['voice.synthesize', 'voice.url']); assert.equal(f.downloads[0][1].redirect, 'manual'); assert.equal(f.downloads[0][1].credentials, 'omit'); assert.equal(f.remembered.length, 0);
    const g = fixture(t); g.fetch(() => new Response(Buffer.alloc(SILK.length), { headers: { 'content-length': String(SILK.length) } }));
    await assert.rejects(g.action('get_ai_record', ai), { code: 'INVALID_RESPONSE' }); assert.equal(g.calls.length, 2);
    const h = fixture(t); h.fetch(() => new Response(SILK, { status: 302, headers: { location: 'https://evil.example' } })); await assert.rejects(h.action('get_ai_record', ai), { code: 'QUERY_FAILED' });
});

test('AI known pending polls retain one deduplication session and transport failures are never retried', async t => {
    const f = fixture(t); f.reply(async params => {
        if (f.calls.length === 1) return { ...params.request, pending: true };
        f.capture.bus.emit('sent', [f.current]); return { ...params.request, pending: false, node: node() };
    });
    await f.action('send_group_ai_record', ai); assert.equal(f.calls.length, 2); assert.equal(f.calls[0].request.sessionId, f.calls[1].request.sessionId);
    const g = fixture(t); g.reply(() => { throw Object.assign(new Error('transport lost'), { code: 'QUERY_FAILED' }); });
    await assert.rejects(g.action('send_group_ai_record', ai), { code: 'QUERY_FAILED' }); assert.equal(g.calls.length, 1); assert.equal(g.remembered.length, 0);
});

test('AI unrelated group, self UID or byte-identical different media UUID cannot manufacture a receipt', async t => {
    for (const mutate of [value => { value.peerUid = '99999'; }, value => { value.senderUid = 'u_other'; }, value => { value.elements[0].pttElement.fileUuid = 'other_uuid_same_hash'; }]) {
        const f = fixture(t); mutate(f.current);
        await assert.rejects(f.execute({ operation: 'voice.send', groupId: '33333', character: 'real-character', text: 'x' }, { expiresAt: Date.now() + 20 }), { code: 'EXPIRED' });
        assert.equal(f.remembered.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.reads.length, 0); assert.equal(f.capture.listenerCount('event'), 0);
    }
});

test('AI waits for pending exact self-message readback, rejects duplicate matching messages and stale source data', async t => {
    const f = fixture(t); let reads = 0; f.read(() => ({ ...f.current, sendStatus: ++reads === 1 ? 1 : 2 })); await f.action('send_group_ai_record', ai); assert.equal(reads, 2);
    const g = fixture(t); g.reply(params => { g.capture.bus.emit('sent', [g.current, { ...g.current, msgId: '18446744073709551001' }]); return { ...params.request, pending: false, node: node() }; });
    await assert.rejects(g.action('send_group_ai_record', ai), { code: 'INVALID_RESPONSE' }); assert.equal(g.remembered.length, 0);
    const h = fixture(t); h.read(() => ({ ...h.current, senderUid: 'u_forged' })); await assert.rejects(h.action('send_group_ai_record', ai), { code: 'INVALID_RESPONSE' });
});

test('AI physical write lock survives caller timeout, account invalidation stops result and listeners release', async t => {
    const f = fixture(t); let release; f.reply(params => new Promise(resolve => { release = () => { f.capture.bus.emit('sent', [f.current]); resolve({ ...params.request, pending: false, node: node() }); }; }));
    f.capture.deadline = operation => Promise.race([operation(), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 5))]);
    const data = { operation: 'voice.send', groupId: '33333', character: 'v', text: 'x' };
    await assert.rejects(f.execute(data), { code: 'TIMEOUT' }); await assert.rejects(f.execute(data), { code: 'BUSY' }); assert.equal(f.calls.length, 1);
    f.api.clear(); release(); await next(); assert.equal(f.capture.listenerCount('event'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    const g = fixture(t); g.reply(params => { g.capture.session = {}; return { ...params.request, pending: false, node: node() }; });
    await assert.rejects(g.action('send_group_ai_record', ai), { code: 'SESSION_CHANGED' }); assert.equal(g.remembered.length, 0);
});

test('PTT transcription downloads exact original bytes before returning existing text or triggering native once', async t => {
    const f = fixture(t); assert.deepEqual(await f.action('fetch_ptt_text', { message_id: 7 }), { text: ' 已识别原始语音 ' });
    assert.equal(f.translations.length, 1); assert.equal(f.translations[0][0], f.current.msgId); assert.deepEqual(f.translations[0][1], { chatType: 2, peerUid: '33333', guildId: '' }); assert.equal(f.translations[0][2].elementId, 'voice_element');
    const g = fixture(t); g.current.elements[0].pttElement.text = 'already complete'; assert.deepEqual(await g.action('fetch_ptt_text', { message_id: 7 }), { text: 'already complete' }); assert.equal(g.translations.length, 0);
    assert.equal(fs.readdirSync(g.directory).filter(value => value.startsWith('fwd-record-')).length, 1);
});

test('PTT hash/size, exact element, original UUID and native ACK must all remain real', async t => {
    const f = fixture(t); f.current.elements[0].pttElement.md5HexStr = 'a'.repeat(32);
    await assert.rejects(f.action('fetch_ptt_text', { message_id: 7 }), { code: 'INVALID_RESPONSE' }); assert.equal(f.translations.length, 0);
    const g = fixture(t); g.invoke(async () => { g.current.elements[0].pttElement.fileUuid = 'changed_original'; g.current.elements[0].pttElement.text = 'forged'; return { result: 0 }; });
    await assert.rejects(g.action('fetch_ptt_text', { message_id: 7 }), { code: 'INVALID_RESPONSE' });
    const h = fixture(t); h.invoke(async () => ({ result: 5 })); await assert.rejects(h.action('fetch_ptt_text', { message_id: 7 }), { code: 'KERNEL_ERROR' });
    const j = fixture(t); j.current.elements.push(structuredClone(j.current.elements[0])); await assert.rejects(j.action('fetch_ptt_text', { message_id: 7 }), { code: 'UNSUPPORTED' });
    assert.equal(j.reads.length, 0);
});

test('PTT pending result expires without retriggering and same-source lock remains until the actual native call ends', async t => {
    const f = fixture(t); let release, entered;
    const nativeEntered = new Promise(resolve => { entered = resolve; });
    f.invoke(() => new Promise(resolve => { release = () => resolve({ result: 0 }); entered(); }));
    f.capture.deadline = operation => Promise.race([operation(), nativeEntered.then(() => { throw Object.assign(new Error('timeout after native dispatch'), { code: 'TIMEOUT' }); })]);
    const data = { operation: 'voice.text', peer: { chatType: 2, peerUid: '33333' }, nativeId: f.current.msgId, elementId: 'voice_element' };
    await assert.rejects(f.execute(data), { code: 'TIMEOUT' }); await assert.rejects(f.execute(data), { code: 'BUSY' });
    f.api.clear(); release(); await next();
    const g = fixture(t), controller = new AbortController(); let invoked = 0, reads = 0, polling, continueRead;
    const pollEntered = new Promise(resolve => { polling = resolve; }), readReleased = new Promise(resolve => { continueRead = resolve; });
    g.invoke(async () => { invoked++; return { result: 0 }; });
    g.read(async () => { if (++reads === 2) { polling(); await readReleased; } return g.current; });
    const pending = g.execute(data, { signal: controller.signal });
    await pollEntered; controller.abort(); continueRead();
    await assert.rejects(pending, { code: 'EXPIRED' }); assert.equal(invoked, 1); assert.equal(reads, 2);
});

test('Voice closed parameters, session proof and OneBot response identities reject backdoors before success', async t => {
    const f = fixture(t);
    for (const params of [{ ...ai, url: 'https://evil.example' }, { ...ai, self_id: 99999 }, { ...ai, expectedEpoch: 'e1' }, { ...ai, character: '' }, { ...ai, chat_type: 4 }]) await assert.rejects(f.action('send_group_ai_record', params), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.api.execute({ operation: 'voice.send', groupId: '33333', character: 'v', text: 'x', expectedEpoch: 'old' }), { code: 'SESSION_CHANGED' }); assert.equal(f.calls.length, 0);
    const real = f.service.sessionCall; f.service.sessionCall = async (...args) => ({ ...(await real(...args)), groupId: '99999' });
    await assert.rejects(f.action('send_group_ai_record', ai), { code: 'INVALID_RESPONSE' }); assert.equal(f.remembered.length, 0);
});

test('QQ 3.2.35-54395 rejects both public and direct synthesis before dispatch while original PTT transcription remains independent', async t => {
    const f = fixture(t); f.capture.qqVersion = '3.2.35-54395';
    const flags = f.api.capabilities(); assert.equal(flags.aiVoiceGenerate, false); assert.equal(flags.aiVoiceSend, false); assert.equal(flags.pttText, true);
    Object.assign(f.state.capabilities, flags);
    for (const action of ['get_ai_record', 'send_group_ai_record']) await assert.rejects(f.action(action, ai), { code: 'UNSUPPORTED' });
    for (const operation of ['voice.generate', 'voice.send']) await assert.rejects(f.execute({ operation, groupId: '33333', character: ai.character, text: ai.text, chatType: 1 }), { code: 'UNSUPPORTED' });
    assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.remembered.length, 0);
    assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.listenerCount('event'), 0);
    assert.deepEqual(await f.action('fetch_ptt_text', { message_id: 7 }), { text: ' 已识别原始语音 ' });
    assert.equal(f.translations.length, 1); assert.equal(f.calls.length, 0);
});
