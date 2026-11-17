'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Capture, TARGET_VERSION } = require('../src/qq/capture.cjs');

const MSG_ID = '18446744073709551001', ELEMENT_ID = '18446744073709551501';
const PEER = { chatType: 1, peerUid: 'u_peer' };
const callback = (changes = {}) => ({ msgId: MSG_ID, msgElementId: ELEMENT_ID, fileErrCode: '-5',
    fileSrvErrCode: '120', transferStatus: 5, fileErrMsg: 'SECRET_NATIVE_ERROR', fileName: 'SECRET_NAME',
    filePath: 'SECRET_PATH', SECRET_KEY: 'SECRET_VALUE', ...changes });
function fixture(t) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporary, 'private-file-observation-'));
    const input = path.join(root, 'input'), cache = path.join(root, 'cache');
    fs.mkdirSync(input, { mode: 0o700 }); fs.mkdirSync(cache, { mode: 0o700 });
    if (process.platform !== 'win32') for (const directory of [input, cache]) {
        assert.equal(fs.statSync(directory).mode & 0o077, 0, 'Fixture directories must remain private on POSIX');
    }
    fs.writeFileSync(path.join(input, 'fixture.txt'), 'private file fixture\n');
    let listener, serial = 0, send = () => ({ result: 0 }), query = () => ({ result: 0, msgList: [] });
    const calls = [], events = [], diagnostics = [];
    const msg = {
        addKernelMsgListener(value) { listener = value; return 1; }, removeKernelMsgListener() {},
        getRichMediaFilePathForGuild: params => path.join(cache, params.fileName),
        generateMsgUniqueId: () => String(++serial),
        sendMsg(...args) { calls.push(args); return send(...args); },
        getMsgsByMsgId(...args) { return query(...args); }
    };
    const session = { getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
    const capture = new Capture({ install: false, processObject: { env: {} }, mediaDirectory: input,
        mediaTargetRoots: [cache], log: value => diagnostics.push(value) });
    capture.resetSession(session, { selfUin: '12345', selfUid: 'u_self', clientVer: TARGET_VERSION });
    capture.ready = true; capture.attach(); capture.publish = value => events.push(value);
    t.after(() => { capture.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { capture, calls, events, diagnostics, session, get listener() { return listener; },
        set send(value) { send = value; }, set query(value) { query = value; },
        prepare: () => capture.call('prepareMedia', { type: 'file', file: 'fixture.txt', expectedEpoch: capture.epoch }),
        submit: (elements, peer = PEER, context = {}, timeoutMs = 1000) => capture.call('sendMessage',
            { peer, elements, expectedEpoch: capture.epoch, timeoutMs }, context),
        record: (peer, elements, changes = {}) => ({ ...peer, msgId: MSG_ID, senderUin: '12345', senderUid: 'u_self',
            sendStatus: 1, elements: elements.map(element => ({ ...element, elementId: ELEMENT_ID })), ...changes }) };
}
const snapshot = f => f.capture.state().sendDiagnostics.at(-1).privateFileUpload;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('upload listener forwards original argument arrays internally and retired listeners stay passive', t => {
    const f = fixture(t), seen = [], original = callback(), errorArgs = [MSG_ID, PEER, 120, 'SECRET_NATIVE_ERROR'];
    f.capture.bus.on('fileUploadObservation', value => seen.push(value));
    const retired = f.listener;
    retired.onRichMediaProgerssUpdate(original); retired.onRichMediaUploadComplete(original); retired.onSendMsgError(...errorArgs);
    assert.deepEqual(seen.map(value => value.callback), ['onRichMediaProgerssUpdate', 'onRichMediaUploadComplete', 'onSendMsgError']);
    assert.equal(seen[0].args[0], original); assert.equal(seen[1].args[0], original); assert.deepEqual(seen[2].args, errorArgs);
    assert.deepEqual(f.events, []); assert.deepEqual(f.capture.state().sendDiagnostics, []);
    f.capture.detach(); f.capture.attach(); retired.onRichMediaUploadComplete(original); assert.equal(seen.length, 3);
});

test('private file failure preserves pre-bind native evidence without interpreting errors or retrying', async t => {
    const f = fixture(t), element = await f.prepare();
    f.send = (_zero, peer, elements) => {
        f.listener.onRichMediaUploadComplete(callback());
        f.listener.onRichMediaUploadComplete(callback({ msgId: '18446744073709551002' }));
        f.listener.onRichMediaUploadComplete(callback({ msgElementId: '18446744073709551502' }));
        f.listener.onRichMediaUploadComplete(callback({ peerUid: 'u_other' }));
        f.listener.onSendMsgError(MSG_ID, PEER, 120, 'SECRET_NATIVE_ERROR');
        f.listener.onAddSendMsg(f.record(peer, elements));
        f.listener.onRichMediaProgerssUpdate(callback({ fileProgress: '50' }));
        f.listener.onMsgInfoListUpdate([f.record(peer, elements, { sendStatus: 0 })]);
        return { result: 0 };
    };
    await assert.rejects(f.submit([element]), { code: 'SEND_FAILED' });
    const state = f.capture.state(), row = state.sendDiagnostics.at(-1), value = row.privateFileUpload;
    assert.equal(row.outcome, 'failed'); assert.equal(row.lastStatus, 0); assert.equal(row.pinned, true);
    assert.equal(value.bound, true); assert.equal(value.closed, true); assert.equal(value.stale, false);
    assert.equal(value.correlatedUploadComplete, 1); assert.equal(value.correlatedProgress, 1);
    assert.deepEqual(value.events[0].numericFields, { fileErrCode: -5, fileSrvErrCode: 120, transferStatus: 5 });
    assert.equal(value.events.slice(1, 5).every(event => !event.correlated && event.numericFields === undefined), true);
    assert.equal(value.sendErrorArgumentsInterpreted, false); assert.equal(value.nativeErrorSemanticsKnown, false);
    assert.equal(f.calls.length, 1); assert.equal(f.capture.bus.listenerCount('fileUploadObservation'), 0);
    assert.deepEqual(f.events, []);
    assert.doesNotMatch(JSON.stringify(value), /SECRET_|1844674407370955|u_self|u_peer|u_other|12345/);
    value.events[0].numericFields.fileErrCode = 999; value.events.push({ injected: true }); value.callbacks.onSendMsgError = 999;
    assert.equal(snapshot(f).events[0].numericFields.fileErrCode, -5); assert.equal(snapshot(f).events.length, 6);
    assert.equal(snapshot(f).callbacks.onSendMsgError, 1);
});

test('only an independently pinned message can bind the file element returned by an exact native readback', async t => {
    const f = fixture(t), element = await f.prepare(); let early, queries = 0;
    f.send = (_zero, peer, elements) => {
        early = f.record(peer, elements, { elements: [{ ...elements[0], elementId: '' }] });
        f.listener.onAddSendMsg(early); f.listener.onRichMediaUploadComplete(callback()); return { result: 0 };
    };
    f.query = (peer, ids) => {
        queries++; assert.deepEqual(ids, [MSG_ID]); assert.deepEqual(peer, { ...PEER, guildId: '' });
        return { result: 0, msgList: [{ ...early, guildId: '', sendStatus: 0,
            elements: [{ ...element, elementId: ELEMENT_ID }] }] };
    };
    await assert.rejects(f.submit([element]), { code: 'SEND_FAILED' });
    assert.equal(queries, 1); assert.equal(snapshot(f).bound, true); assert.equal(snapshot(f).correlatedUploadComplete, 1);
    assert.equal(f.calls.length, 1);
});

test('callback identities cannot bind an uncorrelated send or ambiguous file record', async t => {
    for (const change of [{ guildId: '' }, { senderUid: 'u_other' }, { peerUid: 'u_other' },
        { elements: [{ elementType: 3, elementId: ELEMENT_ID }, { elementType: 3, elementId: ELEMENT_ID }] }]) {
        const f = fixture(t), element = await f.prepare(), controller = new AbortController();
        f.send = (_zero, peer, elements) => {
            f.listener.onAddSendMsg(f.record(peer, elements, change)); f.listener.onRichMediaUploadComplete(callback());
            controller.abort(); return { result: 0 };
        };
        f.query = () => assert.fail('Cancelled observations must not issue native readback');
        await assert.rejects(f.submit([element], PEER, { signal: controller.signal }), { code: 'EXPIRED' });
        assert.equal(snapshot(f).bound, false); assert.equal(snapshot(f).correlatedUploadComplete, 0);
        assert.equal(snapshot(f).closed, true); assert.equal(f.calls.length, 1);
        assert.equal(f.capture.bus.listenerCount('fileUploadObservation'), 0);
    }
});

test('bounded private diagnostics never promote an upload callback into delivered status', async t => {
    const f = fixture(t), element = await f.prepare(); let dispatched;
    const entered = new Promise(resolve => { dispatched = resolve; });
    f.send = (_zero, peer, elements) => {
        f.listener.onAddSendMsg(f.record(peer, elements));
        for (let index = 0; index < 65; index++) f.listener.onRichMediaUploadComplete(callback({ fileErrCode: 0, fileSrvErrCode: 0 }));
        dispatched(); return { result: 0 };
    };
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const pending = f.submit([element], PEER, {}, 30), rejected = assert.rejects(pending, { code: 'TIMEOUT' });
        await entered; assert.equal(snapshot(f).correlatedUploadComplete, 64); assert.equal(snapshot(f).overflow, true);
        t.mock.timers.tick(31); await rejected; await flush();
        const before = f.capture.state().sendDiagnostics;
        assert.equal(before.at(-1).outcome, 'timeout'); assert.equal(snapshot(f).closed, true); assert.equal(snapshot(f).stale, true);
        assert.equal(snapshot(f).events.length, 64); assert.equal(snapshot(f).correlatedUploadComplete, 0);
        f.listener.onRichMediaUploadComplete(callback()); f.listener.onMsgInfoListUpdate([f.record(PEER, [element], { sendStatus: 2 })]);
        await flush(); assert.deepEqual(f.capture.state().sendDiagnostics, before); assert.equal(f.calls.length, 1);
        assert.equal(f.capture.bus.listenerCount('fileUploadObservation'), 0);
    } finally { t.mock.timers.reset(); }
});

test('session or account changes invalidate correlation before observer cleanup', async t => {
    for (const change of [f => { f.capture.epoch = 'another-epoch'; }, f => { f.capture.session = {}; },
        f => { f.capture.self = { uin: '54321', uid: 'u_other' }; }]) {
        const f = fixture(t), element = await f.prepare(), controller = new AbortController();
        f.send = (_zero, peer, elements) => {
            f.listener.onAddSendMsg(f.record(peer, elements)); f.listener.onRichMediaUploadComplete(callback());
            assert.equal(snapshot(f).correlatedUploadComplete, 1); change(f);
            f.listener.onRichMediaUploadComplete(callback()); controller.abort(); return { result: 0 };
        };
        await assert.rejects(f.submit([element], PEER, { signal: controller.signal }));
        assert.equal(snapshot(f).stale, true); assert.equal(snapshot(f).closed, true);
        assert.equal(snapshot(f).correlatedUploadComplete, 0); assert.equal(f.capture.bus.listenerCount('fileUploadObservation'), 0);
        assert.equal(f.calls.length, 1);
    }
});

test('group files, mixed messages, text and other native send callers do not enable file observation', async t => {
    const f = fixture(t), element = await f.prepare(), text = { elementType: 1, textElement: { content: 'fixture' } };
    f.send = (_zero, peer, elements) => {
        assert.equal(f.capture.bus.listenerCount('fileUploadObservation'), 0);
        f.listener.onRichMediaUploadComplete(callback()); f.listener.onMsgInfoListUpdate([f.record(peer, elements, { sendStatus: 2 })]);
        return { result: 0 };
    };
    for (const [elements, peer] of [[[element], { chatType: 2, peerUid: '200' }], [[element, text], PEER], [[text], PEER]]) {
        assert.equal((await f.submit(elements, peer)).sendStatus, 2);
        assert.equal(snapshot(f), undefined);
    }
    await f.capture.sendNativeElements(PEER, [element], {}, { expectedEpoch: f.capture.epoch });
    assert.equal(snapshot(f), undefined); assert.equal(f.calls.length, 4);
});
