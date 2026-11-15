'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const codec = require('../src/onebot/codec.cjs');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');

const VOICE = Buffer.from('A bounded local audio input for the service boundary.');
const UNHANDLED = Symbol('unhandled');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, options = {}) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporary, 'record-service-'));
    const mediaDirectory = path.join(directory, 'media'); fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    const file = path.join(mediaDirectory, 'voice.mp3'); fs.writeFileSync(file, VOICE, { mode: 0o600 });
    const state = { ready: true, epoch: 'voice-epoch', self: { uin: '123', uid: 'u_self' }, capabilities: { record: true, image: true } };
    const calls = [], logs = [];
    const store = new MessageStore({ directory: path.join(directory, 'store') });
    t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const backend = { async call(method, params, callOptions) {
        if (method === 'status') return state;
        const call = { method, params, timeoutMs: callOptions.timeoutMs }; calls.push(call);
        const override = options.call ? await options.call(call, state) : UNHANDLED;
        if (override !== UNHANDLED) return override;
        if (method === 'resolve') return { uin: params.uin, uid: 'u_peer_' + params.uin };
        if (method === 'prepareMedia') return { elementType: 4, elementId: '', pttElement: {
            filePath: path.join(directory, 'native-voice.silk'), fileSize: '32', md5HexStr: 'ab'.repeat(16), duration: 1.5
        } };
        if (method === 'sendMessage') return { ...params.peer, msgId: '18446744073709551001', msgSeq: '100', clientSeq: '200',
            senderUin: state.self.uin, senderUid: state.self.uid, sendStatus: 2, elements: params.elements };
        throw new Error('Unexpected backend method ' + method);
    } };
    const service = new OneBotService({ backend, store, mediaDirectory: options.media === false ? null : mediaDirectory,
        ...(options.timeouts || {}), logger: (event, details) => logs.push({ event, ...details }) });
    return { directory, mediaDirectory, file, service, store, calls, logs, state };
}
function request(file = 'voice.mp3', echo = { id: 7 }) {
    return { action: 'send_group_msg', echo, params: { group_id: 200, message: [
        { type: 'text', data: { text: '  before\n' } }, { type: 'record', data: { file } },
        { type: 'text', data: { text: '\nafter  ' } }
    ] } };
}

test('record parsing preserves only an explicit local file and rejects unsupported options or remote inputs', () => {
    assert.deepEqual(codec.parse('[CQ:record,file=voice.mp3]'), [{ type: 'record', data: { file: 'voice.mp3' } }]);
    assert.deepEqual(codec.parse([{ type: 'record', data: { file: 'voice.silk' } }]), [{ type: 'record', data: { file: 'voice.silk' } }]);
    for (const data of [{}, { file: '' }, { file: 7 }, { file: 'voice.mp3\n' },
        { file: 'https://example.invalid/voice.mp3' }, { file: 'http://example.invalid/voice.mp3' },
        { file: 'base64://AAAA' }, { file: 'data:audio/mp3;base64,AAAA' }, { file: 'ftp://example.invalid/voice.mp3' },
        { file: 'voice.mp3', url: 'https://example.invalid/audio' }, { file: 'voice.mp3', duration: 10 },
        { file: 'voice.mp3', magic: true }, { file: 'voice.mp3', cache: 1 }, { file: 'voice.mp3', proxy: 1 },
        { file: 'voice.mp3', timeout: 0 }, { file: 'voice.mp3', pttElement: {} }]) {
        assert.throws(() => codec.parse([{ type: 'record', data }]), 'must reject ' + JSON.stringify(data));
    }
});

test('can_send_record requires the actual ready-session flag and an account media directory', async t => {
    const f = fixture(t);
    const canSend = async () => (await f.service.action({ action: 'can_send_record' })).data.yes;
    assert.equal(await canSend(), true);
    for (const flag of [false, undefined, 1, 'true']) { f.state.capabilities.record = flag; assert.equal(await canSend(), false); }
    f.state.capabilities.record = true; f.state.ready = false; assert.equal(await canSend(), false);
    const missingMedia = fixture(t, { media: false });
    assert.equal((await missingMedia.service.action({ action: 'can_send_record' })).data.yes, false);
    assert.equal(f.calls.length, 0); assert.equal(missingMedia.calls.length, 0);
});

test('record sends preserve the mixed chain, echo, account binding and confirmed persistent message ID', async t => {
    const f = fixture(t), input = request(f.file), before = JSON.stringify(input);
    const result = await f.service.action(input, { epoch: 'voice-epoch', selfUin: '123' });
    assert.equal(result.status, 'ok'); assert.equal(result.retcode, 0); assert.deepEqual(result.echo, { id: 7 });
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia', 'sendMessage']);
    assert.equal(f.calls[0].params.type, 'record'); assert.equal(f.calls[0].params.file, f.file);
    assert.equal(f.calls[0].params.expectedEpoch, 'voice-epoch');
    const sent = f.calls[1].params;
    assert.deepEqual(sent.peer, { chatType: 2, peerUid: '200' }); assert.equal(sent.expectedEpoch, 'voice-epoch');
    assert.deepEqual(sent.elements.map(element => element.elementType), [1, 4, 1]);
    assert.equal(sent.elements[0].textElement.content, '  before\n'); assert.equal(sent.elements[2].textElement.content, '\nafter  ');
    assert.equal(sent.elements[1].pttElement.duration, 1.5);
    const saved = f.store.get('123', result.data.message_id);
    assert.equal(saved.locator.nativeId, '18446744073709551001'); assert.deepEqual(saved.locator.peer, sent.peer);
    assert.deepEqual(fs.readFileSync(f.file), VOICE);
});

test('voice actions use the default 60-second media budget rather than the ordinary 10-second action budget', async t => {
    const f = fixture(t);
    assert.equal((await f.service.action(request())).status, 'ok');
    for (const call of f.calls) {
        assert.ok(call.timeoutMs > 55000 && call.timeoutMs <= 60000, 'media deadline for ' + call.method);
    }
    const sent = f.calls.find(call => call.method === 'sendMessage');
    assert.ok(sent.params.timeoutMs > 55000 && sent.params.timeoutMs <= 60000);
});

test('configured media deadline is shared across preparation and sending without restarting the budget', async t => {
    const f = fixture(t, { timeouts: { actionTimeoutMs: 25, mediaActionTimeoutMs: 1000 }, call: async call => {
        if (call.method === 'prepareMedia') await pause(60);
        return UNHANDLED;
    } });
    assert.equal((await f.service.action(request())).status, 'ok');
    const prepare = f.calls.find(call => call.method === 'prepareMedia'), send = f.calls.find(call => call.method === 'sendMessage');
    assert.ok(prepare.timeoutMs > 25 && prepare.timeoutMs <= 1000);
    assert.ok(send.timeoutMs < prepare.timeoutMs - 30 && send.timeoutMs > 0);
    assert.ok(send.params.timeoutMs <= send.timeoutMs + 2);
});

test('complete mixed voice input is validated before any native preparation or sending', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.directory, 'outside.mp3'), VOICE);
    const inputs = [
        [{ type: 'record', data: { file: 'voice.mp3' } }, { type: 'record', data: { file: '../outside.mp3' } }],
        [{ type: 'record', data: { file: 'voice.mp3' } }, { type: 'record', data: { file: 'missing.mp3' } }],
        [{ type: 'record', data: { file: 'voice.mp3' } }, { type: 'video', data: { file: 'video.mp4' } }],
        [{ type: 'record', data: { file: 'voice.mp3' } }, { type: 'record', data: { file: 'voice.mp3', duration: 99 } }],
        [{ type: 'record', data: { file: 'voice.mp3' } }, { type: 'image', data: { file: 'missing.png' } }]
    ];
    for (const message of inputs) {
        const result = await f.service.action({ action: 'send_group_msg', params: { group_id: 200, message } });
        assert.equal(result.status, 'failed'); assert.deepEqual(f.calls, []);
    }
});

test('voice preparation is refused when the native capability or account directory is unavailable', async t => {
    for (const mode of ['flag', 'directory']) {
        const f = fixture(t, { media: mode !== 'directory' });
        if (mode === 'flag') f.state.capabilities.record = false;
        const result = await f.service.action(request());
        assert.equal(result.retcode, 1404); assert.deepEqual(f.calls, []);
    }
});

test('failed or malformed voice preparation rejects the entire message before sendMessage', async t => {
    for (const prepared of [null, { elementType: 4 }, { elementType: 2, picElement: {} }, { elementType: 3, pttElement: {} }]) {
        const f = fixture(t, { call: async call => call.method === 'prepareMedia' ? prepared : UNHANDLED });
        const result = await f.service.action(request());
        assert.equal(result.status, 'failed'); assert.deepEqual(result.echo, { id: 7 });
        assert.equal(f.calls.filter(call => call.method === 'prepareMedia').length, 1);
        assert.equal(f.calls.some(call => call.method === 'sendMessage'), false);
    }
    const f = fixture(t, { call: async call => {
        if (call.method === 'prepareMedia') throw Object.assign(new Error('Audio codec unavailable'), { code: 'UNSUPPORTED' });
        return UNHANDLED;
    } });
    assert.equal((await f.service.action(request())).retcode, 1404);
    assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia']);
});

test('private voice resolves a real UID and rejects mismatched peer or sender confirmations', async t => {
    const success = fixture(t);
    const input = request(); input.action = 'send_private_msg'; input.params = { user_id: 456, message: input.params.message };
    assert.equal((await success.service.action(input)).status, 'ok');
    assert.deepEqual(success.calls.map(call => call.method), ['resolve', 'prepareMedia', 'sendMessage']);
    assert.deepEqual(success.calls[2].params.peer, { chatType: 1, peerUid: 'u_peer_456' });
    for (const field of ['peerUid', 'chatType', 'senderUin']) {
        const f = fixture(t, { call: async call => call.method !== 'sendMessage' ? UNHANDLED : {
            ...call.params.peer, msgId: '900', senderUin: '123', elements: call.params.elements,
            [field]: field === 'peerUid' ? 'u_other' : field === 'chatType' ? 2 : '999'
        } });
        const result = await f.service.action(input);
        assert.equal(result.status, 'failed'); assert.equal(result.retcode, 1500);
        assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1);
        assert.equal(f.store.get('123', 1), null);
    }
});

test('unknown voice send results return timeout with echo and never retry the native action', async t => {
    const f = fixture(t, { call: async call => {
        if (call.method === 'sendMessage') throw Object.assign(new Error('Delivery may be unknown'), { code: 'TIMEOUT' });
        return UNHANDLED;
    } });
    const echo = { nested: ['voice', 1] }, result = await f.service.action(request('voice.mp3', echo));
    assert.equal(result.status, 'failed'); assert.equal(result.retcode, 1504); assert.deepEqual(result.echo, echo);
    assert.deepEqual(f.calls.map(call => call.method), ['prepareMedia', 'sendMessage']);
    assert.equal(f.logs.filter(log => log.event === 'action_failed').length, 1);
    assert.equal(f.logs[0].stage, 'sendMessage'); assert.equal(f.logs[0].code, 'TIMEOUT');
    assert.equal(f.store.get('123', 1), null);
    await pause(20); assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1);
});
