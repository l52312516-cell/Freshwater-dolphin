'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

const peer = { chatType: 2, peerUid: '200' };
const encoded = Buffer.from('\x02#!SILK_V3\x03\x00abc');
function preparedAudio() {
    return { bytes: Buffer.from(encoded), md5: crypto.createHash('md5').update(encoded).digest('hex'),
        size: encoded.length, durationMs: 1250, durationSeconds: 1.25,
        waveAmplitudes: Array.from({ length: 32 }, (_value, index) => index), sampleRate: 24000 };
}
function fixture(t, audioProcessor) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporary, 'qq-record-'));
    const root = path.join(directory, 'media'), cache = path.join(directory, 'native');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(cache, { mode: 0o700 });
    const source = path.join(root, 'input.mp3'); fs.writeFileSync(source, 'ID3test source', { mode: 0o600 });
    let listener;
    const sends = [], pathRequests = [], audioCalls = [];
    const audio = audioProcessor || { available: () => true, async prepare(file, context) {
        audioCalls.push({ file, context }); return preparedAudio();
    } };
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getRichMediaFilePathForGuild(value) { pathRequests.push(value); return path.join(cache, value.fileName); },
        generateMsgUniqueId() { return '999'; },
        async sendMsg(_zero, target, elements) {
            sends.push({ peer: target, elements });
            listener.onMsgInfoListUpdate([{ ...target, elements, msgId: '900719925474099312345', senderUin: '123', sendStatus: 2 }]);
            return { result: 0 };
        }
    };
    const msf = { getServerTime: () => '1000' };
    const session = { getMsgService: () => msg, getMSFService: () => msf };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: root, mediaTargetRoots: [cache], audioProcessor: audio });
    function initialize(uin = '123') {
        capture.resetSession(session, { selfUin: uin, selfUid: 'u_' + uin, clientVer: TARGET_VERSION });
        capture.ready = true; capture.attach();
    }
    initialize();
    t.after(() => { capture.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const prepare = () => capture.call('prepareMedia', { type: 'record', file: source, expectedEpoch: capture.epoch });
    const send = element => capture.call('sendMessage', { peer, elements: [element], expectedEpoch: capture.epoch });
    return { capture, directory, root, cache, source, msg, msf, audio, sends, audioCalls, pathRequests, initialize, prepare, send };
}
const clone = value => JSON.parse(JSON.stringify(value));

test('record preparation binds the current epoch, rounds real duration upward and preserves actual waveform', async t => {
    const f = fixture(t), before = f.capture.epoch;
    assert.equal(f.capture.state().capabilities.record, true);
    const element = await f.prepare();
    assert.equal(element.elementType, 4); assert.equal(element.pttElement.duration, 2);
    assert.deepEqual(element.pttElement.waveAmplitudes, preparedAudio().waveAmplitudes);
    assert.equal(f.audioCalls[0].file, f.source); assert.ok(f.audioCalls[0].context.signal);
    assert.equal(f.pathRequests[0].elementType, 4); assert.equal(f.pathRequests[0].needCreate, true);
    assert.equal(f.capture.preparedMedia.get(element.pttElement.filePath).epoch, before);
    assert.deepEqual(fs.readFileSync(element.pttElement.filePath), encoded);
    assert.equal(f.sends.length, 0);
    const record = await f.send(element);
    assert.equal(record.sendStatus, 2); assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].elements[0].pttElement.duration, 2);
});

test('changing a prepared PTT identity, duration, format or waveform cannot reach native sending', async t => {
    const f = fixture(t), original = await f.prepare();
    const mutations = [
        value => { value.pttElement.md5HexStr = 'a'.repeat(32); },
        value => { value.pttElement.fileSize = '10000'; },
        value => { value.pttElement.duration = 1; },
        value => { value.pttElement.formatType = 2; },
        value => { value.pttElement.voiceType = 2; },
        value => { value.pttElement.voiceChangeType = 1; },
        value => { value.pttElement.canConvert2Text = true; },
        value => { value.pttElement.waveAmplitudes[0] = 99; },
        value => { value.pttElement.fileSubId = 'foreign'; },
        value => { value.pttElement.fileName = 'other.silk'; },
        value => { value.pttElement.playState = 2; },
        value => { value.pttElement.autoConvertText = 1; },
        value => { value.pttElement.storeID = 1; },
        value => { value.pttElement.otherBusinessInfo.aiVoiceType = 1; },
        value => { value.pttElement.filePath = path.join(f.cache, 'not-prepared.silk'); }
    ];
    for (const mutate of mutations) {
        const value = clone(original); mutate(value);
        await assert.rejects(f.send(value), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.sends.length, 0);
});

test('the returned waveform and extra PTT fields cannot mutate the trusted native preparation', async t => {
    const f = fixture(t), original = await f.prepare();
    original.pttElement.waveAmplitudes[0] = 99;
    await assert.rejects(f.send(original), { code: 'INVALID_PARAMS' });
    const fresh = await f.prepare();
    const extra = clone(fresh); extra.pttElement.fileUuid = 'unexpected-native-parameter';
    await assert.rejects(f.send(extra), { code: 'INVALID_PARAMS' });
    const business = clone(fresh); business.pttElement.otherBusinessInfo.unvalidated = true;
    await assert.rejects(f.send(business), { code: 'INVALID_PARAMS' });
    assert.equal(f.sends.length, 0);
});

test('changed native audio bytes and unprepared PTT references are rejected before send', async t => {
    const f = fixture(t), original = await f.prepare();
    const data = fs.readFileSync(original.pttElement.filePath); data[data.length - 1] ^= 1;
    fs.writeFileSync(original.pttElement.filePath, data);
    await assert.rejects(f.send(original), { code: 'INVALID_PARAMS' });
    const unknown = clone(original); unknown.pttElement.filePath = f.source;
    await assert.rejects(f.send(unknown), { code: 'INVALID_PARAMS' });
    assert.equal(f.sends.length, 0);
});

test('audio bytes changed during asynchronous send correlation cannot bypass final native validation', async t => {
    const f = fixture(t), original = await f.prepare();
    let release, invoked;
    const started = new Promise(resolve => { invoked = resolve; });
    f.msf.getServerTime = () => { invoked(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.send(original);
    const rejected = assert.rejects(pending, { code: 'INVALID_PARAMS' });
    await started;
    const file = original.pttElement.filePath, bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(file, bytes);
    release('1000'); await rejected;
    assert.equal(f.sends.length, 0);
});

test('prepared record files cannot cross QQ session epochs', async t => {
    const f = fixture(t), original = await f.prepare(), oldEpoch = f.capture.epoch;
    f.initialize('456');
    assert.equal(f.capture.preparedMedia.size, 0);
    await assert.rejects(f.capture.call('prepareMedia', { type: 'record', file: f.source, expectedEpoch: oldEpoch }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.capture.call('sendMessage', { peer, elements: [original], expectedEpoch: oldEpoch }), { code: 'SESSION_CHANGED' });
    await assert.rejects(f.send(original), { code: 'INVALID_PARAMS' });
    assert.equal(f.sends.length, 0);
});

test('cancelled or switched preparation never copies late audio into the native cache', async t => {
    for (const mode of ['cancel', 'session']) {
        let release, started;
        const invoked = new Promise(resolve => { started = resolve; });
        const f = fixture(t, { available: () => true, prepare() { started(); return new Promise(resolve => { release = resolve; }); } });
        const controller = new AbortController();
        const pending = f.capture.call('prepareMedia', { type: 'record', file: f.source, expectedEpoch: f.capture.epoch }, { signal: controller.signal });
        const rejected = assert.rejects(pending, error => ['EXPIRED', 'SESSION_CHANGED'].includes(error.code));
        await invoked;
        if (mode === 'cancel') controller.abort(); else f.initialize('456');
        release(preparedAudio()); await rejected;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.pathRequests.length, 0); assert.equal(f.capture.preparedMedia.size, 0);
        assert.deepEqual(fs.readdirSync(f.cache), []); assert.equal(f.sends.length, 0);
    }
});

test('record capability depends on the actual audio processor and supported native preparation methods', t => {
    const f = fixture(t);
    f.audio.available = () => false;
    assert.equal(f.capture.state().capabilities.record, false);
    f.audio.available = () => true;
    delete f.msg.getRichMediaFilePathForGuild;
    assert.equal(f.capture.state().capabilities.record, false);
});
