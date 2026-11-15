'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OneBotService } = require('../src/onebot/service.cjs');
const { MessageStore } = require('../src/onebot/store.cjs');
const codec = require('../src/onebot/codec.cjs');

const SELF = '2068886823', SELF_UID = 'u_yOIJFv8EazZyn60AgZ9JAg';
const PEER = '2441760163', PEER_UID = 'u_tuFT9TXJhn7b5BsDkkm3lg';
const peer = { chatType: 1, peerUid: PEER_UID };
const text = content => ({ elementType: 1, textElement: { content, atType: 0 } });
function original(overrides = {}) {
    return { ...peer, peerUin: PEER, msgId: '7707841464180459071', msgSeq: '14', clientSeq: '428',
        msgTime: '1794621690', senderUin: SELF, senderUid: SELF_UID,
        elements: [text('original\n')], ...overrides };
}
function reference(overrides = {}) {
    return { replayMsgId: original().msgId, replayMsgSeq: original().msgSeq,
        sourceMsgIdInRecords: '7707841468150374127', senderUid: '0', senderUidStr: SELF_UID,
        replyMsgClientSeq: '428', replyMsgTime: '1794621690', ...overrides };
}
function quoting(ref = reference(), overrides = {}) {
    return original({ msgId: '7707841468150374123', msgSeq: '15', clientSeq: '429',
        elements: [{ elementType: 7, replyElement: ref }, text(' quoted\n')], ...overrides });
}
function fixture(t, { maxMessages = 10000 } = {}) {
    const temporary = path.resolve(__dirname, '../work/temp'); fs.mkdirSync(temporary, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporary, 'private-reply-'));
    const store = new MessageStore({ directory, maxMessages });
    const state = { epoch: 'current-private-session', ready: true, online: true,
        self: { uin: SELF, uid: SELF_UID }, capabilities: { text: true, reply: true } };
    const calls = [], records = new Map();
    const f = { directory, store, state, calls, records, lookup: null, normalizeSend: null };
    let sent = 0;
    const backend = { async call(method, params = {}) {
        calls.push({ method, params });
        if (method === 'status') return structuredClone(state);
        if (method === 'resolve') return { uin: PEER, uid: PEER_UID };
        if (method === 'getMessage') {
            if (f.lookup) return f.lookup(params);
            const matches = [...records.values()].filter(record =>
                record.chatType === params.peer.chatType && record.peerUid === params.peer.peerUid &&
                (!params.nativeId || record.msgId === params.nativeId) && (!params.seq || record.msgSeq === params.seq) &&
                (!params.clientSeq || record.clientSeq === params.clientSeq) &&
                (!params.senderUid || record.senderUid === params.senderUid) && (!params.time || record.msgTime === params.time));
            if (matches.length !== 1) throw Object.assign(new Error('Exact QQ message was not found'), { code: 'NOT_FOUND' });
            return structuredClone(matches[0]);
        }
        if (method === 'sendMessage') {
            const record = original({ msgId: String(900000000000n + BigInt(++sent)), msgSeq: String(20 + sent),
                clientSeq: String(500 + sent), elements: structuredClone(params.elements) });
            if (f.normalizeSend) f.normalizeSend(record);
            records.set(record.msgId, record);
            return structuredClone(record);
        }
        throw new Error('Unexpected backend method ' + method);
    } };
    f.service = new OneBotService({ backend, store });
    f.backend = backend;
    f.remember = record => { records.set(record.msgId, record); return store.remember(SELF, record); };
    f.query = async record => {
        const entry = f.remember(record);
        return f.service.action({ action: 'get_msg', params: { message_id: entry.id } });
    };
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return f;
}

test('real QQ private quote uses replayMsgId rather than the separate preview record', async t => {
    const f = fixture(t), first = f.remember(original());
    // The preview even exists locally: it still cannot replace the original ID.
    f.remember(original({ msgId: reference().sourceMsgIdInRecords }));
    const reply = await f.query(quoting());
    assert.equal(reply.retcode, 0);
    assert.deepEqual(reply.data.message, [{ type: 'reply', data: { id: String(first.id) } },
        { type: 'text', data: { text: ' quoted\n' } }]);
    assert.equal(f.calls.some(call => call.method === 'getMessage'), false);
});

test('confirmed private send and subsequent get_msg preserve quote identity and real timestamp', async t => {
    const f = fixture(t), first = f.remember(original());
    f.normalizeSend = record => {
        for (const element of record.elements) if (element.elementType === 7) {
            element.replyElement.sourceMsgIdInRecords = reference().sourceMsgIdInRecords;
            element.replyElement.senderUid = '0';
            delete element.replyElement.senderUin;
        }
    };
    const sent = await f.service.action({ action: 'send_private_msg', params: { user_id: PEER,
        message: [{ type: 'reply', data: { id: first.id } }, { type: 'text', data: { text: ' reply\n' } }] }, echo: ['private', 1] });
    assert.equal(sent.retcode, 0); assert.deepEqual(sent.echo, ['private', 1]);
    const request = f.calls.find(call => call.method === 'sendMessage');
    assert.deepEqual(request.params.elements[0].replyElement, { replayMsgId: original().msgId,
        replayMsgSeq: '14', replyMsgClientSeq: '428', senderUin: SELF, senderUidStr: SELF_UID, replyMsgTime: '1794621690' });
    const queried = await f.service.action({ action: 'get_msg', params: { message_id: sent.data.message_id } });
    assert.equal(queried.retcode, 0);
    assert.equal(queried.data.message[0].data.id, String(first.id));
    assert.equal(f.calls.filter(call => call.method === 'sendMessage').length, 1);
});

test('client sequence cache lookup separates opposite authors and timestamps without guessing an NT sequence', async t => {
    const f = fixture(t);
    const first = f.remember(original());
    f.remember(original({ msgId: '7707841464180459072', msgSeq: '91', senderUid: PEER_UID, senderUin: PEER }));
    f.remember(original({ msgId: '7707841464180459073', msgSeq: '92', msgTime: '1794621689' }));
    const reply = await f.query(quoting(reference({ replayMsgId: '0', replayMsgSeq: '0' })));
    assert.equal(reply.retcode, 0); assert.equal(reply.data.message[0].data.id, String(first.id));
    assert.equal(f.calls.some(call => call.method === 'getMessage'), false);
});

test('client sequence cache miss queries the exact private tuple and verifies all returned fields', async t => {
    const f = fixture(t);
    f.records.set(original().msgId, original());
    const reply = await f.query(quoting(reference({ replayMsgId: '0', replayMsgSeq: '0' })));
    assert.equal(reply.retcode, 0);
    const request = f.calls.find(call => call.method === 'getMessage');
    assert.equal(request.params.nativeId, undefined); assert.equal(request.params.seq, undefined);
    assert.equal(request.params.clientSeq, '428'); assert.equal(request.params.time, '1794621690');
    assert.equal(request.params.senderUid, SELF_UID); assert.equal(request.params.expectedEpoch, f.state.epoch);
    const remembered = f.store.get(SELF, reply.data.message[0].data.id);
    assert.equal(remembered.locator.seq, '14'); assert.equal(remembered.locator.clientSeq, '428');
});

test('cached original identity survives eviction and store reload without changing OneBot IDs', async t => {
    const f = fixture(t, { maxMessages: 1 });
    const first = f.remember(original());
    f.remember(original({ msgId: '7707841464180459072', clientSeq: '9', msgTime: '1794621689' }));
    assert.equal(f.store.get(SELF, first.id).record, undefined);
    const reopened = new MessageStore({ directory: f.directory, maxMessages: 1 });
    const service = new OneBotService({ backend: f.backend, store: reopened });
    const quoted = quoting(reference({ replayMsgId: '0', replayMsgSeq: '0' }));
    const entry = reopened.remember(SELF, quoted);
    const reply = await service.action({ action: 'get_msg', params: { message_id: entry.id } });
    assert.equal(reply.retcode, 0); assert.equal(reply.data.message[0].data.id, String(first.id));
    assert.equal(f.calls.some(call => call.method === 'getMessage'), false);
});

test('older persisted locators use their complete record metadata without resetting IDs', async t => {
    const f = fixture(t), first = f.remember(original());
    const file = path.join(f.directory, SELF + '.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete saved.entries[0].locator.senderUid; delete saved.entries[0].locator.time;
    fs.writeFileSync(file, JSON.stringify(saved));
    const reopened = new MessageStore({ directory: f.directory });
    const entry = reopened.find(SELF, { peer, clientSeq: '428', senderUid: SELF_UID, time: '1794621690' });
    assert.equal(entry.id, first.id); assert.equal(reopened.state(SELF).nextId, 2);
});

test('ambiguous private tuples remain errors rather than choosing the most recent message', async t => {
    const f = fixture(t);
    f.remember(original()); f.remember(original({ msgId: '7707841464180459072', msgSeq: '30' }));
    const reply = await f.query(quoting(reference({ replayMsgId: '0', replayMsgSeq: '0' })));
    assert.equal(reply.retcode, 1404); assert.equal(reply.data, null);
});

test('private tuple results from another author, time, sequence or peer are rejected before storing', async t => {
    for (const changes of [{ senderUid: PEER_UID, senderUin: PEER }, { msgTime: '1794621691' },
        { clientSeq: '14' }, { peerUid: 'u_other' }, { chatType: 2 }]) {
        const f = fixture(t); f.lookup = () => original(changes);
        const reply = await f.query(quoting(reference({ replayMsgId: '0', replayMsgSeq: '0' })));
        assert.equal(reply.retcode, 1500, JSON.stringify(changes));
        assert.equal(f.store.get(SELF, 2), null);
    }
});

test('missing private author/time, unknown originals, and preview-only identities do not guess', async t => {
    for (const changes of [
        { replayMsgId: '0', replayMsgSeq: '0', replyMsgTime: '0' },
        { replayMsgId: '0', replayMsgSeq: '0', senderUidStr: undefined },
        { replayMsgId: '0', replayMsgSeq: '0', replyMsgClientSeq: '0' },
        { replayMsgId: '0', replayMsgSeq: '0', replyMsgClientSeq: '0', replyMsgTime: '0', senderUidStr: undefined }
    ]) {
        const f = fixture(t); f.remember(original());
        const reply = await f.query(quoting(reference(changes)));
        assert.equal(reply.retcode, 1404); assert.equal(f.calls.some(call => call.method === 'getMessage'), false);
    }
    const unknown = fixture(t);
    assert.equal((await unknown.query(quoting())).retcode, 1404);
    assert.equal(unknown.calls.find(call => call.method === 'getMessage').params.nativeId, original().msgId);
});

test('conflicting and rounded author or quote metadata cannot select a cached message', async t => {
    for (const changes of [{ senderUidStr: 'u_other' }, { senderUidStr: PEER_UID, senderUin: SELF },
        { senderUid: PEER_UID }, { replyMsgTime: 9007199254740992 }, { replayMsgSeq: 9007199254740992 },
        { replyMsgClientSeq: 9007199254740992 }, { replayMsgId: 9007199254740992 }]) {
        const f = fixture(t); f.remember(original());
        const record = quoting(reference(changes));
        if (Object.values(changes).some(value => typeof value === 'number' && !Number.isSafeInteger(value))) {
            assert.throws(() => f.remember(record), { code: 'INVALID_RESPONSE' });
            // Conversion also refuses the raw malformed quote if it reaches
            // this layer through a backend instead of the persisted cache.
            await assert.rejects(f.service.convert(f.state, record, 2), { code: 'INVALID_RESPONSE' });
        } else {
            const reply = await f.query(record);
            assert.equal(reply.retcode, 1500, JSON.stringify(changes));
        }
        assert.equal(f.calls.some(call => call.method === 'getMessage'), false);
    }
});

test('current-session refresh must preserve the original author UID and timestamp before sending', async t => {
    for (const changes of [{ senderUid: PEER_UID }, { msgTime: '1794621689' }]) {
        const f = fixture(t), first = f.remember(original()); f.lookup = () => original(changes);
        const result = await f.service.action({ action: 'send_private_msg', params: { user_id: PEER,
            message: [{ type: 'reply', data: { id: first.id } }, { type: 'text', data: { text: 'must not send' } }] } });
        assert.equal(result.retcode, 1500);
        assert.equal(f.calls.some(call => call.method === 'sendMessage'), false);
    }
});

test('private quote preparation rejects absent authors, times and client sequences without fabricating fields', async () => {
    for (const changes of [{ senderUid: undefined }, { msgTime: undefined }, { clientSeq: '0' },
        { msgTime: 9007199254740992 }]) {
        await assert.rejects(codec.toKernel([{ type: 'reply', data: { id: '1' } }], {
            peer, reply: async () => original(changes)
        }), { code: 'NOT_FOUND' });
    }
    const elements = await codec.toKernel([{ type: 'reply', data: { id: '1' } }], {
        peer, reply: async () => original({ msgSeq: '0' })
    });
    assert.equal(elements[0].replyElement.replayMsgSeq, '0');
    assert.equal(elements[0].replyElement.replyMsgClientSeq, '428');
});
