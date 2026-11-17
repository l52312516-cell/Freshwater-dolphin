'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Capture } = require('../src/qq/capture.cjs');
const fs = require('node:fs');
const path = require('node:path');
const SOURCE = { chatType: 2, peerUid: '2000000001' };
const IDS = ['18446744073709551610', '18446744073709551609'], SENT = '18446744073709551608';
const SELF = { uin: '1000000001', uid: 'u_self' }, EPOCH = 'native-merge-session';
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
const merged = resId => ({ elementType: 16, multiForwardMsgElement: { resId } });
const fails = code => error => { assert.equal(error.code, code, error.stack); return true; };
function fixture(t) {
    const calls = [], handlers = {}, originals = IDS.map((msgId, index) => ({ ...SOURCE, msgId,
        senderUin: String(1000000003 + index), senderUid: 'u_author' + index, msgTime: '1794614400',
        sendNickName: 'Original author ' + index, sendMemberName: index === 0 ? 'Real group card' : '', elements: [text(' node ' + index + '\n ')] }));
    const root = { ...SOURCE, msgId: SENT, senderUin: SELF.uin, senderUid: SELF.uid, sendStatus: 2, elements: [merged('native-completed-resource')] };
    let capture;
    const native = {
        async getMsgsByMsgId(peer, ids) {
            calls.push({ method: 'getMsgsByMsgId', peer, ids });
            return handlers.get ? handlers.get(peer, ids) : { result: 0, msgList: ids.map(id => id === SENT ? root : originals.find(record => record.msgId === id)) };
        },
        generateMsgUniqueId(...args) { calls.push({ method: 'generateMsgUniqueId', args }); return handlers.correlation ? handlers.correlation(...args) : '18446744073709551000'; },
        multiForwardMsgWithComment(...args) {
            calls.push({ method: 'multiForwardMsgWithComment', args });
            if (handlers.submit) return handlers.submit(...args);
            capture.bus.emit('sent', [{ ...root, guildId: args[2].guildId }]); return { result: 0 };
        },
        async getMultiMsg(...args) { calls.push({ method: 'getMultiMsg', args }); return handlers.read ? handlers.read(...args) : { result: 0, msgList: structuredClone(originals) }; },
        buildMultiForwardMsg() { calls.push({ method: 'buildMultiForwardMsg' }); return { result: 0, rspInfo: { elements: [merged('built-only-resource')] } }; }
    };
    capture = new Capture({ install: false, runtimeIdentity: { platform: 'linux', architecture: 'x64' }, qqVersion: '3.2.35-54395', audioProcessor: {}, videoProcessor: {} });
    capture.epoch = EPOCH; capture.self = { ...SELF }; capture.ready = true;
    capture.session = { getMsgService: () => native, getMSFService: () => ({ getServerTime() { calls.push({ method: 'getServerTime' }); return 1794614400; } }) };
    t.after(() => capture.close());
    const probe = (extra = {}, context) => capture.forwardApi.run({ kind: 'nativeMergeProbe', source: SOURCE, msgIds: IDS,
        expectedEpoch: EPOCH, ...extra }, context);
    return { capture, native, calls, handlers, originals, root, probe };
}
function diagnostics(t, f) {
    const temporaryRoot = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporaryRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(temporaryRoot, 'forward-native-evidence-'));
    const account = path.join(root, 'work/accounts/legacy'); fs.mkdirSync(account, { recursive: true, mode: 0o700 });
    f.capture.processObject = { env: { FWD_MANAGER_ROOT: root, FWD_ACCOUNT_ROOT: account,
        FWD_RPC_DIR: path.join(account, 'rpc'), FWD_EXPECTED_UIN: SELF.uin } };
    t.after(() => { assert.ok(root.startsWith(temporaryRoot + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
    const base = path.join(account, 'state/native-forward-diagnostics');
    return { base, run: () => path.join(base, fs.readdirSync(base)[0]),
        rows: () => fs.readFileSync(path.join(base, fs.readdirSync(base)[0], 'records.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('private native merge derives real author display names and proves correlated delivery plus complete resource contents', async t => {
    const f = fixture(t), result = await f.probe();
    assert.equal(result.confirmation, 'correlated-native-merge-and-resource-readback'); assert.equal(result.nativeAcceptance, 'numeric-zero');
    assert.equal(result.messageId, SENT); assert.equal(result.resId, 'native-completed-resource');
    assert.deepEqual(result.sourceMsgIds, IDS); assert.deepEqual(result.records, f.originals);
    assert.deepEqual(f.calls.map(row => row.method), ['getMsgsByMsgId', 'getServerTime', 'generateMsgUniqueId', 'multiForwardMsgWithComment', 'getMsgsByMsgId', 'getMultiMsg']);
    const args = f.calls.find(row => row.method === 'multiForwardMsgWithComment').args;
    assert.deepEqual(args[0], [{ msgId: IDS[0], senderShowName: 'Real group card' }, { msgId: IDS[1], senderShowName: 'Original author 1' }]);
    assert.deepEqual(args[1], { ...SOURCE, guildId: '' }); assert.deepEqual(args[2], { ...SOURCE, guildId: '18446744073709551000' });
    assert.deepEqual(args[3], []); assert.ok(args[4] instanceof Map);
    assert.equal(f.capture.bus.listenerCount('sent'), 0);
    await assert.rejects(f.probe(), fails('BUSY'));
    await assert.rejects(f.capture.forwardApi.run({ kind: 'build', source: SOURCE, msgIds: IDS, expectedEpoch: EPOCH }), fails('BUSY'));
});

test('the target QQ build disables formal existingMerge before lookup or native submission without disabling private probes', async t => {
    const f = fixture(t);
    assert.equal(f.capture.forwardApi.capabilities().mergeExistingNative, false);
    const request = { kind: 'existingMerge', source: SOURCE, msgIds: IDS, expectedEpoch: EPOCH };
    await assert.rejects(f.capture.forwardApi.run({ ...request, diagnostic: true }), fails('INVALID_PARAMS'));
    await assert.rejects(f.capture.forwardApi.run(request), fails('UNSUPPORTED'));
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.capture.forwardApi.diagnostics(), []);
    const result = await f.probe();
    assert.equal(result.confirmation, 'correlated-native-merge-and-resource-readback');
    assert.equal(result.messageId, SENT);
});

test('direct formal RPC cannot bypass the disabled native variant with a valid media deadline', async t => {
    const f = fixture(t);
    await assert.rejects(f.capture.call('forwardOperation', { kind: 'existingMerge', source: SOURCE, msgIds: IDS,
        expectedEpoch: EPOCH, timeoutMs: 60000 }, { expiresAt: Date.now() + 60000 }), fails('UNSUPPORTED'));
    assert.equal(f.calls.length, 0);
    assert.equal(f.capture.bus.listenerCount('sent'), 0); assert.equal(f.capture.bus.listenerCount('sendObservation'), 0);
    assert.deepEqual(f.capture.forwardApi.diagnostics(), []);
});

test('disabled formal requests never reserve a tuple or invoke a later native retry', async t => {
    const f = fixture(t), request = { kind: 'existingMerge', source: SOURCE, msgIds: IDS, expectedEpoch: EPOCH, timeoutMs: 60000 };
    for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(f.capture.call('forwardOperation', request, { expiresAt: Date.now() + 12000 }), fails('UNSUPPORTED'));
    }
    assert.equal(f.calls.length, 0);
    // The explicit private probe still exercises the strict reservation and
    // complete confirmation implementation without advertising it as public.
    await f.probe(); await assert.rejects(f.probe(), fails('BUSY'));
    assert.equal(f.calls.filter(call => call.method === 'multiForwardMsgWithComment').length, 1);
});

test('formal existingMerge media timeout remains an integer bounded by sixty seconds', async t => {
    for (const timeoutMs of [0, -1, 60001, '60000', NaN]) {
        const f = fixture(t);
        await assert.rejects(f.capture.forwardApi.run({ kind: 'existingMerge', source: SOURCE, msgIds: IDS,
            expectedEpoch: EPOCH, timeoutMs }), fails('INVALID_PARAMS'));
        assert.equal(f.calls.length, 0);
    }
});

test('bounded merge status distinguishes an accepted native call from missing callback correlation without recording private data', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const f = fixture(t); let submitted;
        const dispatched = new Promise(resolve => { submitted = resolve; });
        f.handlers.submit = () => {
            const record = { ...f.root, guildId: '', buildMultiMsgReqInfo: { srcMsgIds: [...IDS] } };
            f.capture.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [record] });
            f.capture.bus.emit('sent', [record]); submitted(); return { result: 0 };
        };
        const pending = f.probe({}, { expiresAt: Date.now() + 100 });
        const rejected = assert.rejects(pending, error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        await dispatched; await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(100); await rejected;
        const [status] = f.capture.forwardApi.diagnostics();
        assert.equal(status.nativeInvoked, true); assert.equal(status.nativeSettled, true); assert.equal(status.nativeAccepted, true);
        assert.equal(status.failedAt, 'native-and-delivery'); assert.equal(status.closed, true);
        assert.equal(status.callbacks.missingGuild, 1); assert.equal(status.callbacks.success, 1); assert.equal(status.callbacks.correlationMatches, 0);
        assert.equal(status.observations.exactSourceTuple, 1);
        const encoded = JSON.stringify(status);
        for (const value of [...IDS, SENT, SELF.uid, SELF.uin, SOURCE.peerUid, 'native-completed-resource', 'Original author']) assert.equal(encoded.includes(value), false, value);
        status.callbacks.success = 999; assert.equal(f.capture.forwardApi.diagnostics()[0].callbacks.success, 1);
        await assert.rejects(f.probe(), fails('BUSY')); assert.equal(f.calls.filter(call => call.method === 'multiForwardMsgWithComment').length, 1);
        f.capture.forwardApi.clear(); assert.deepEqual(f.capture.forwardApi.diagnostics(), []);
    } finally { t.mock.timers.reset(); }
});

test('merge status shows an unresolved native promise separately from an already matched delivery and records late settlement only as evidence', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const f = fixture(t); let submitted, settle;
        const dispatched = new Promise(resolve => { submitted = resolve; });
        f.handlers.submit = (...args) => {
            f.capture.bus.emit('sent', [{ ...f.root, guildId: args[2].guildId }]); submitted();
            return new Promise(resolve => { settle = resolve; });
        };
        const pending = f.probe({}, { expiresAt: Date.now() + 100 });
        const rejected = assert.rejects(pending, error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        await dispatched; t.mock.timers.tick(100); await rejected;
        let [status] = f.capture.forwardApi.diagnostics();
        assert.equal(status.nativePromise, true); assert.equal(status.nativeSettled, false); assert.equal(status.callbacks.correlationMatches, 1);
        assert.equal(status.phase, 'expired'); assert.equal(status.closed, true);
        settle({ result: 0 }); await new Promise(resolve => setImmediate(resolve));
        [status] = f.capture.forwardApi.diagnostics(); assert.equal(status.lateNativeResult, true); assert.equal(status.phase, 'expired');
        assert.equal(f.calls.some(call => call.method === 'getMultiMsg'), false); assert.equal(f.capture.bus.listenerCount('sent'), 0);
        assert.equal(f.capture.bus.listenerCount('sendObservation'), 0);
    } finally { t.mock.timers.reset(); }
});

test('merge diagnostics retain early correlated callback evidence without treating a later uncorrelated delivery as success', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
        const f = fixture(t); let submitted;
        const dispatched = new Promise(resolve => { submitted = resolve; });
        f.handlers.submit = (...args) => {
            f.capture.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [{ ...f.root, sendStatus: 1, guildId: args[2].guildId }] });
            f.capture.bus.emit('sent', [{ ...f.root, guildId: '' }]); submitted(); return { result: 0 };
        };
        const operation = f.probe({}, { expiresAt: Date.now() + 100 });
        const rejected = assert.rejects(operation, error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        await dispatched; await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(100); await rejected;
        const [status] = f.capture.forwardApi.diagnostics();
        assert.equal(status.observations.correlatedAdded, 1); assert.equal(status.observations.correlatedUpdated, 0);
        assert.equal(status.observations.correlatedNativeId, true); assert.equal(status.callbacks.correlationMatches, 0);
        assert.equal(status.phase, 'expired'); assert.equal(status.callbacks.missingGuild, 1);
        assert.equal(f.calls.some(call => call.method === 'getMultiMsg'), false);
        assert.equal(f.capture.bus.listenerCount('sendObservation'), 0);
        await assert.rejects(f.probe(), fails('BUSY'));
    } finally { t.mock.timers.reset(); }
});

test('undefined native acknowledgement requires the same complete delivery and real resource proof', async t => {
    const f = fixture(t);
    f.handlers.submit = (...args) => { f.capture.bus.emit('sent', [{ ...f.root, guildId: args[2].guildId }]); };
    const result = await f.probe(); assert.equal(result.nativeAcceptance, 'void-with-delivery-proof'); assert.equal(result.confirmed, true);
});

test('native merged root can be a real completed multimsg Ark and never an empty resource', async t => {
    const f = fixture(t); f.root.elements = [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg',
        meta: { detail: { resid: 'real-ark-resource' } } }) } }];
    assert.equal((await f.probe()).resId, 'real-ark-resource');
});

test('native probe rejects arbitrary nodes, cards, destinations, unsafe IDs and stale epochs before native calls', async t => {
    const cases = [[{ elements: [text('fake')] }, 'INVALID_PARAMS'], [{ content: 'fake' }, 'INVALID_PARAMS'], [{ destination: SOURCE }, 'INVALID_PARAMS'],
        [{ senderShowName: 'fake' }, 'INVALID_PARAMS'], [{ msgIds: [] }, 'INVALID_PARAMS'], [{ msgIds: [IDS[0], IDS[0]] }, 'INVALID_PARAMS'],
        [{ msgIds: [Number(IDS[0])] }, 'INVALID_PARAMS'], [{ msgIds: ['18446744073709551616'] }, 'INVALID_PARAMS'],
        [{ msgIds: Array.from({ length: 21 }, (_, i) => String(i + 1)) }, 'INVALID_PARAMS'],
        [{ source: { chatType: 1, peerUid: 'u_private' } }, 'UNSUPPORTED'], [{ expectedEpoch: undefined }, 'SESSION_CHANGED']];
    for (const [extra, code] of cases) {
        const f = fixture(t); await assert.rejects(f.probe(extra), fails(code)); assert.equal(f.calls.length, 0);
    }
});

test('native merge stays unavailable on unknown QQ versions or missing real native methods', async t => {
    for (const change of [f => { f.capture.qqVersion = 'unknown'; }, f => { delete f.native.multiForwardMsgWithComment; },
        f => { delete f.native.generateMsgUniqueId; }, f => { delete f.native.getMultiMsg; },
        f => { f.capture.session.getMSFService = () => ({}); }]) {
        const f = fixture(t); change(f); await assert.rejects(f.probe(), fails('UNSUPPORTED')); assert.equal(f.calls.length, 0);
    }
});

test('media, mentions, incomplete sources and missing real author names cannot initiate native merging', async t => {
    for (const change of [f => { f.originals[0].elements = [{ elementType: 2, picElement: {} }]; },
        f => { f.originals[0].elements[0].textElement.atType = 2; },
        f => { f.handlers.get = () => ({ result: 0, msgList: [] }); },
        f => { f.originals[0].peerUid = '999'; },
        f => { f.originals[0].senderUin = SELF.uin; f.originals[0].sendStatus = 3; },
        f => { delete f.originals[0].sendNickName; delete f.originals[0].sendMemberName; },
        f => { f.originals[0].sendMemberName = 'x'.repeat(513); }]) {
        const f = fixture(t); change(f); await assert.rejects(f.probe());
        assert.equal(f.calls.some(row => row.method === 'multiForwardMsgWithComment'), false);
    }
});

test('old build tuples remain reserved against the new native operation', async t => {
    const f = fixture(t);
    await f.capture.forwardApi.run({ kind: 'build', source: SOURCE, msgIds: IDS, expectedEpoch: EPOCH });
    await assert.rejects(f.probe(), fails('BUSY'));
    assert.equal(f.calls.some(row => row.method === 'multiForwardMsgWithComment'), false);
});

test('disabled pending-carrier kind and ordinary message RPC cannot send arbitrary merged Ark data', async t => {
    const f = fixture(t);
    await assert.rejects(f.capture.call('forwardOperation', { kind: 'mergeProbe', source: SOURCE, msgIds: IDS, expectedEpoch: EPOCH }), fails('UNSUPPORTED'));
    await assert.rejects(f.capture.call('sendMessage', { peer: SOURCE, expectedEpoch: EPOCH, elements: [{ elementType: 10,
        arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: '' } } }),
            subElementType: 251, buildMultiMsgReqInfo: { srcMsgIds: IDS, srcContact: SOURCE } } }] }), fails('INVALID_PARAMS'));
    assert.equal(f.calls.length, 0);
});

test('callback correlation never degrades to peer and self identity when native ignores the requested guild ID', async t => {
    for (const mode of ['no-event', 'wrong-guild', 'missing-guild', 'wrong-peer', 'wrong-uin', 'wrong-uid', 'missing-uid', 'pending']) {
        const f = fixture(t);
        f.handlers.submit = (...args) => {
            const record = { ...f.root, guildId: args[2].guildId };
            if (mode === 'wrong-guild') record.guildId = '123'; if (mode === 'missing-guild') delete record.guildId;
            if (mode === 'wrong-peer') record.peerUid = '999'; if (mode === 'wrong-uin') record.senderUin = '999';
            if (mode === 'wrong-uid') record.senderUid = 'u_wrong'; if (mode === 'missing-uid') delete record.senderUid;
            if (mode === 'pending') record.sendStatus = 3;
            if (mode !== 'no-event') f.capture.bus.emit('sent', [record]);
        };
        await assert.rejects(f.probe({}, { expiresAt: Date.now() + 30 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
        assert.equal(f.capture.bus.listenerCount('sent'), 0); await assert.rejects(f.probe(), fails('BUSY'));
        assert.equal(f.calls.filter(row => row.method === 'multiForwardMsgWithComment').length, 1);
        assert.equal(f.calls.some(row => row.method === 'getMultiMsg'), false);
    }
});

test('explicit native failure or unknown acknowledgements cannot become success despite a matching delivery event', async t => {
    for (const response of [null, true, {}, { result: '0' }, { result: 7 }]) {
        const f = fixture(t); f.handlers.submit = (...args) => { f.capture.bus.emit('sent', [{ ...f.root, guildId: args[2].guildId }]); return response; };
        await assert.rejects(f.probe(), error => ['INVALID_RESPONSE', 'KERNEL_ERROR'].includes(error.code));
        await assert.rejects(f.probe(), fails('BUSY')); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    }
});

test('delivered empty resources, changed roots and altered resource node identities or text are failures without retry', async t => {
    for (const change of [f => { f.root.elements = [{ elementType: 10, arkElement: { bytesData: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: '' } } }) } }]; },
        f => { f.root.elements = [{ ...merged('real'), textElement: { content: 'extra payload' } }]; },
        f => { f.handlers.get = (_peer, ids) => ({ result: 0, msgList: ids.map(id => id === SENT ? { ...f.root, senderUid: 'u_wrong' } : f.originals.find(row => row.msgId === id)) }); },
        f => { f.handlers.read = () => ({ result: 0, msgList: [] }); },
        f => { f.handlers.read = () => ({ result: 0, msgList: [...f.originals].reverse() }); },
        ...['senderUin', 'senderUid', 'msgTime', 'text', 'msgId'].map(key => f => { f.handlers.read = () => {
            const records = structuredClone(f.originals);
            if (key === 'text') records[0].elements[0].textElement.content += 'changed';
            else if (key === 'msgId') records[1].msgId = records[0].msgId;
            else records[0][key] = key === 'senderUid' ? 'u_wrong' : '999';
            return { result: 0, msgList: records };
        }; })]) {
        const f = fixture(t); change(f); await assert.rejects(f.probe(), fails('INVALID_RESPONSE'));
        await assert.rejects(f.probe(), fails('BUSY')); assert.equal(f.calls.filter(row => row.method === 'multiForwardMsgWithComment').length, 1);
    }
});

test('cancelled or changed sessions before native submission never dispatch a merged message', async t => {
    for (const mode of ['abort', 'session']) {
        const f = fixture(t), controller = new AbortController();
        f.handlers.correlation = () => { if (mode === 'abort') controller.abort(); else f.capture.epoch = 'different'; return '123'; };
        await assert.rejects(f.probe({}, { signal: controller.signal }), error => ['EXPIRED', 'SESSION_CHANGED'].includes(error.code));
        assert.equal(f.calls.some(row => row.method === 'multiForwardMsgWithComment'), false); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    }
});

test('native private core accepts 1 through 20 existing source IDs without enabling any public merge action', async t => {
    for (const count of [1, 20]) {
        const f = fixture(t);
        f.originals.splice(0, f.originals.length, ...Array.from({ length: count }, (_, index) => ({ ...SOURCE, msgId: String(index + 1), senderUin: '1000000003',
            senderUid: 'u_author', msgTime: '1794614400', sendNickName: 'Real author', elements: [text(' ' + index + '\n')] })));
        const result = await f.probe({ msgIds: f.originals.map(record => record.msgId) }); assert.equal(result.records.length, count);
    }
});

test('private native diagnostics are opt-in and cannot accept caller-selected paths or nonboolean flags', async t => {
    for (const extra of [{ diagnostic: 'true' }, { diagnostic: {} }, { diagnostic: true, diagnosticPath: 'elsewhere' }]) {
        const f = fixture(t); await assert.rejects(f.probe(extra), fails('INVALID_PARAMS')); assert.equal(f.calls.length, 0);
    }
    for (const extra of [{}, { diagnostic: false }]) {
        const f = fixture(t), d = diagnostics(t, f); await f.probe(extra);
        assert.equal(fs.existsSync(d.base), false); assert.equal(f.capture.bus.listenerCount('sendObservation'), 0);
    }
    const f = fixture(t); f.capture.processObject = { env: {} };
    await assert.rejects(f.probe({ diagnostic: true }), fails('INVALID_CONFIG'));
    assert.equal(f.calls.some(call => call.method === 'multiForwardMsgWithComment'), false);
    assert.equal(f.capture.bus.listenerCount('sent'), 0); assert.equal(f.capture.bus.listenerCount('sendObservation'), 0);
});

test('early callback snapshots preserve build metadata independently of delivery and native results', async t => {
    const f = fixture(t), d = diagnostics(t, f), logs = []; f.capture.log = item => logs.push(item);
    f.handlers.submit = (...args) => {
        const record = { ...f.root, sendStatus: 3, guildId: '', msgType: 11,
            buildMultiMsgReqInfo: { srcMsgIds: [...IDS], srcContact: { ...SOURCE } } };
        f.capture.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [record] });
        record.buildMultiMsgReqInfo.srcMsgIds.length = 0; record.buildMultiMsgReqInfo = null;
        f.capture.bus.emit('sent', [{ ...f.root, guildId: args[2].guildId }]); return { result: 0 };
    };
    const result = await f.probe({ diagnostic: true }), rows = d.rows();
    assert.equal(typeof result.diagnosticId, 'string');
    assert.deepEqual(rows.find(row => row.phase === 'observation').data.record.buildMultiMsgReqInfo.srcMsgIds, IDS);
    assert.equal(rows.find(row => row.phase === 'native-result').data.result, 0);
    assert.equal(rows.find(row => row.phase === 'prepared').data.correlation, '18446744073709551000');
    assert.deepEqual(logs, []); assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
});

test('diagnostic candidates never weaken guild correlation or permit a second native dispatch', async t => {
    const f = fixture(t), d = diagnostics(t, f);
    f.handlers.submit = () => {
        const record = { ...f.root, guildId: '', msgType: 11 };
        f.capture.bus.emit('sendObservation', { callback: 'onAddSendMsg', records: [record] });
        f.capture.bus.emit('sent', [record]); return { result: 0 };
    };
    await assert.rejects(f.probe({ diagnostic: true }, { expiresAt: Date.now() + 1500 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    assert.equal(d.rows().filter(row => row.phase === 'observation').length, 1);
    assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    await assert.rejects(f.probe({ diagnostic: true }), fails('BUSY'));
    assert.equal(f.calls.filter(row => row.method === 'multiForwardMsgWithComment').length, 1);
});

test('late native promise evidence never changes a timeout or leaves callback observers installed', async t => {
    const f = fixture(t), d = diagnostics(t, f); let settle;
    f.handlers.submit = () => new Promise(resolve => { settle = resolve; });
    await assert.rejects(f.probe({ diagnostic: true }, { expiresAt: Date.now() + 1500 }), error => ['TIMEOUT', 'EXPIRED'].includes(error.code));
    assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
    settle({ result: 0 }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.parse(fs.readFileSync(path.join(d.run(), 'native-late-result.json'), 'utf8')).data.result, 0);
    const summary = JSON.parse(fs.readFileSync(path.join(d.run(), 'summary.json'), 'utf8')).data;
    assert.equal(summary.confirmed, false); assert.equal(summary.dispatched, true);
    assert.equal(f.calls.filter(row => row.method === 'multiForwardMsgWithComment').length, 1);
});

test('native failure, cancellation, session retirement and capture close clean every diagnostic observer', async t => {
    for (const mode of ['rejected', 'abort', 'session', 'close']) {
        const f = fixture(t), d = diagnostics(t, f), controller = new AbortController();
        f.handlers.submit = () => {
            if (mode === 'rejected') return Promise.reject(Object.assign(new Error('native failed privately'), { code: 'NATIVE_FAILED' }));
            setImmediate(() => {
                if (mode === 'abort') controller.abort();
                else if (mode === 'session') { f.capture.epoch = 'retired'; f.capture.rejectPending(Object.assign(new Error('retired'), { code: 'SESSION_CHANGED' })); }
                else f.capture.close();
            });
            return undefined;
        };
        await assert.rejects(f.probe({ diagnostic: true }, { signal: controller.signal, expiresAt: Date.now() + 1000 }));
        assert.equal(f.capture.bus.listenerCount('sendObservation'), 0); assert.equal(f.capture.bus.listenerCount('sent'), 0);
        assert.equal(JSON.parse(fs.readFileSync(path.join(d.run(), 'summary.json'), 'utf8')).data.confirmed, false);
        assert.equal(f.calls.filter(row => row.method === 'multiForwardMsgWithComment').length, 1);
    }
});
